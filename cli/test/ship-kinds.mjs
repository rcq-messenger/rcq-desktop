// The thread's ship gate, offline (#1038, #1039).
//
// A voice note recorded on the web or the desktop was sealed, uploaded (the
// island answered 201 and kept the blob), turned into a row, and then refused
// two lines into `shipEnvelopeToCurrentThread`: the gate's set had never
// learned 'voice', although the composer had been building voice envelopes
// since 2026-08-29. No request, no exception, no console line; the bubble said
// "не доставлено" and the island never heard of the message. Measured on the
// flagship: 22.09 16:18:53 UTC a 79 766-byte upload from the reporter's web
// session and no /messages/sealed after it; 23.09 02:44:11 and 02:44:40 the
// same from the desktop.
//
// What this pins:
//   * every kind the composer builds passes the gate and is mirrored to our
//     own devices (the two sets used to be hand-kept in Chat.tsx and drifted);
//   * Chat.tsx really uses these sets and types its composer against them, so
//     the compile-time link cannot be quietly undone by re-inlining a copy;
//   * the voice envelope exactly as attemptSendRow builds it survives both
//     seals and the carbon with every field.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundles)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { x25519, ed25519 } from '@noble/curves/ed25519'
import { CARBON_KINDS, COMPOSED_KINDS, SHIPPABLE_KINDS } from '../dist/ship-kinds.mjs'
import { WebSignalDevice, bytesToB64, encryptV1, decryptV1 } from '../dist/crypto-v2.mjs'

let n = 0
const check = async (label, fn) => {
  await fn()
  n++
  console.log('  ok  ' + label)
}

await check('the gate lets a voice note out', () => {
  assert.ok(
    SHIPPABLE_KINDS.has('voice'),
    'voice is refused before sealing: the row goes "не доставлено" with the blob already on the island',
  )
})

await check('every kind the composer builds passes the gate', () => {
  assert.ok(COMPOSED_KINDS.length > 0)
  for (const k of COMPOSED_KINDS) assert.ok(SHIPPABLE_KINDS.has(k), `composed kind "${k}" is refused by the gate`)
})

await check('every kind the composer builds is mirrored to our other devices', () => {
  for (const k of COMPOSED_KINDS) assert.ok(CARBON_KINDS.has(k), `composed kind "${k}" never reaches our own phone`)
  // Reactions sync through their own self-echo, never a carbon.
  assert.ok(SHIPPABLE_KINDS.has('reaction'))
  assert.ok(!CARBON_KINDS.has('reaction'))
})

await check('the rest of the gate is what it was', () => {
  for (const k of ['text', 'reaction', 'photo', 'video', 'file', 'edit', 'delete', 'location']) {
    assert.ok(SHIPPABLE_KINDS.has(k), `"${k}" dropped out of the gate`)
  }
  // Polls are receive-only (founder item 14a), and envelopeToObject throws on one.
  assert.ok(!SHIPPABLE_KINDS.has('poll'))
})

await check('Chat.tsx ships through these sets and types its composer against them', () => {
  const src = fs.readFileSync(new URL('../../src/pages/Chat.tsx', import.meta.url), 'utf8')
  assert.match(
    src,
    /import \{[^}]*\bSHIPPABLE_KINDS\b[^}]*\} from '\.\.\/lib\/ship-kinds'/,
    'Chat.tsx must take the gate from lib/ship-kinds, where this test can see it',
  )
  assert.doesNotMatch(src, /const (SHIPPABLE_KINDS|CARBON_KINDS)\s*=/, 'a second hand-kept copy in Chat.tsx is how voice was lost')
  assert.match(
    src,
    /async function attemptSendRow\(row: OutgoingRow\) \{[\s\S]{0,400}?let env: ComposedEnvelope\b/,
    'attemptSendRow must build a ComposedEnvelope, so a new kind there is a compile error until the gate lists it',
  )
})

// ── the voice envelope exactly as attemptSendRow builds it ────────────────────

function mkIdentity(uin) {
  const identityPriv = x25519.utils.randomPrivateKey()
  const signingPriv = ed25519.utils.randomPrivateKey()
  return {
    uin,
    jwt: '',
    apiBase: 'https://api.rcq.app',
    identityPriv,
    identityPub: x25519.getPublicKey(identityPriv),
    signingPriv,
    signingPub: ed25519.getPublicKey(signingPriv),
  }
}
const bundleV1 = (id) => ({ uin: id.uin, identityKey: bytesToB64(id.identityPub), signingKey: bytesToB64(id.signingPub) })

const KEY = 'CxG0iFbYq0kR1e2JmH5vQ8cW3pZ7nT4sA6dL9fU0bXk='
/// finishVoice() row -> attemptSendRow() envelope, including the `dying` pair
/// (ts always, ttl only on a disappearing thread).
function voiceEnvelope(expiresInSec) {
  const sentAt = 1_790_000_000_000
  const row = {
    id: 'AAAAAAAA-1111-4222-8333-444444444444',
    sentAt,
    kind: 'voice',
    mediaId: 'f1f902fc79f4431d8be3acc3c952886d',
    mediaKey: KEY,
    durationSec: 10,
    ...(expiresInSec ? { expiresAt: sentAt + expiresInSec * 1000 } : {}),
  }
  const ts = Math.floor(row.sentAt / 1000)
  const dying = row.expiresAt == null ? { ts } : { ttl: Math.max(1, Math.round((row.expiresAt - row.sentAt) / 1000)), ts }
  return { kind: 'voice', id: row.id, mediaID: row.mediaId, mediaKey: row.mediaKey, durationSec: row.durationSec ?? 0, ...dying }
}

const me = mkIdentity(495)
const peer = mkIdentity(300002)

await check('voice survives the v=1 seal with every field', () => {
  const got = decryptV1(encryptV1(voiceEnvelope(), me, bundleV1(peer)), peer).envelope
  assert.deepEqual(got, {
    kind: 'voice',
    id: 'AAAAAAAA-1111-4222-8333-444444444444',
    mediaID: 'f1f902fc79f4431d8be3acc3c952886d',
    mediaKey: KEY,
    durationSec: 10,
  })
  const dying = decryptV1(encryptV1(voiceEnvelope(3600), me, bundleV1(peer)), peer).envelope
  assert.equal(dying.ttl, 3600)
  assert.equal(dying.ts, 1_790_000_000, 'a disappearing voice note counts from the sender clock')
})

await check('voice survives the v=2 seal (the path a same-island 1:1 takes first)', async () => {
  const bundleOf = (dev, up) => ({
    uin: dev.uin,
    device_id: dev.deviceId,
    sealed_sender_pub: bytesToB64(dev.outerPub),
    registration_id: up.registration_id,
    signal_identity_key: up.signal_identity_key,
    signed_prekey: up.signed_prekey,
    kyber_prekey: up.kyber_prekey,
    one_time_prekey: up.one_time_prekeys[0],
  })
  const a = await WebSignalDevice.create(495, 2)
  const b = await WebSignalDevice.create(300002, 1)
  await a.establishSession(bundleOf(b, await b.buildBundle(2)))
  const got = (await b.decrypt(await a.encryptTo(b.uin, b.deviceId, b.outerPub, voiceEnvelope()))).envelope
  assert.equal(got.kind, 'voice')
  assert.equal(got.mediaID, 'f1f902fc79f4431d8be3acc3c952886d')
  assert.equal(got.mediaKey, KEY)
  assert.equal(got.durationSec, 10)
})

await check('voice survives the self-carbon to our other devices', () => {
  const carbon = { kind: 'carbon', to: peer.uin, gid: null, env: voiceEnvelope() }
  const got = decryptV1(encryptV1(carbon, me, bundleV1(me)), me).envelope
  assert.equal(got.kind, 'carbon')
  assert.equal(got.to, peer.uin)
  assert.equal(got.env.kind, 'voice')
  assert.equal(got.env.mediaID, 'f1f902fc79f4431d8be3acc3c952886d')
  assert.equal(got.env.mediaKey, KEY)
})

console.log(`ship-kinds: ${n} ok`)

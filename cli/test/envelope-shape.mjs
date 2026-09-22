// What actually goes on the wire for every envelope this client SENDS.
//
// The bug this pins cost the app its faces, and it was one missing `else if`.
// `envelopeToObject` starts from `{ kind }` and only a branch ever adds to it,
// so a kind with no branch is not a type error and not a runtime error: it
// seals, sends, decrypts and decodes perfectly as a message whose every field
// is empty. Three kinds had reached production that way.
//
//   pkey   the key IS the message. `{kind:"pkey"}` arrives, is filed as an
//          empty string, stored nowhere and ACKED, so the island drops the row
//          and the contact looks at a flower for ever. Measured on the
//          flagship 22.09: four fan-outs from a web account, four envelopes
//          delivered and acked, zero keys stored on the receiving phone.
//   voice  id, blob, key and duration all dropped: an empty bubble that can
//          never load.
//   poll   deliberately never sent, and now says so out loud instead of
//          shipping a hollow one.
//
// The guard that prevents a fourth is a `never` check at the end of the
// builder, which only works if every union member carries ONE literal kind —
// hence ReceiptEnvelope being a union rather than one interface with two.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'
import { x25519, ed25519 } from '@noble/curves/ed25519'
import { bytesToB64, encryptV1, decryptV1 } from '../dist/crypto-v2.mjs'

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

const sender = mkIdentity(300001)
const recip = mkIdentity(300002)
const bundle = {
  uin: recip.uin,
  identityKey: bytesToB64(recip.identityPub),
  signingKey: bytesToB64(recip.signingPub),
}

/// Seal and open, the same pair the fan-out and the drain use.
const trip = (env) => decryptV1(encryptV1(env, sender, bundle), recip).envelope

// ── the one that took the faces off ──────────────────────────────────────
const KEY = 'CxG0iFbYq0kR1e2JmH5vQ8cW3pZ7nT4sA6dL9fU0bXk='
const pkey = trip({ kind: 'pkey', key: KEY })
assert.equal(pkey.kind, 'pkey')
assert.equal(pkey.key, KEY, 'the profile key must survive the wire — losing it is a face nobody can open')

// A question carries nothing but its kind, and must still arrive as one.
assert.equal(trip({ kind: 'pkeyask' }).kind, 'pkeyask')

// ── the one that would have been the next report ─────────────────────────
const voice = trip({
  kind: 'voice',
  id: 'AAAAAAAA-1111-4222-8333-444444444444',
  mediaID: 'm-1234567890abcdef',
  mediaKey: KEY,
  durationSec: 7.5,
})
assert.equal(voice.kind, 'voice')
assert.equal(voice.mediaID, 'm-1234567890abcdef', 'a voice note without its blob id is an empty bubble')
assert.equal(voice.mediaKey, KEY, 'a voice note without its key can never be played')
assert.equal(voice.durationSec, 7.5)

// ── refused out loud, not shipped hollow ─────────────────────────────────
assert.throws(
  () => encryptV1({ kind: 'poll', id: 'X', poll: 1, q: 'q', opts: ['a'], sc: true, anon: false }, sender, bundle),
  /receive-only/,
  'polls are not composed here, and refusing must be louder than sending an empty one',
)

// ── and the neighbours, so a future edit cannot quietly hollow them ───────
const photo = trip({
  kind: 'photo',
  id: 'BBBBBBBB-1111-4222-8333-444444444444',
  mediaID: 'p-1',
  mediaKey: KEY,
  caption: 'подпись',
})
assert.equal(photo.mediaKey, KEY)
assert.equal(photo.caption, 'подпись')

const gskey = trip({ kind: 'gskey', gid: 21, ver: 3, key: KEY })
assert.equal(gskey.key, KEY, 'the room key rides the same builder as the profile key')

const read = trip({ kind: 'read', targetIDs: ['a', 'b'] })
assert.deepEqual(read.targetIDs, ['a', 'b'], 'receipts stayed covered after the union split')
const delivered = trip({ kind: 'delivered', targetIDs: ['c'] })
assert.deepEqual(delivered.targetIDs, ['c'])

console.log('envelope-shape: ok')

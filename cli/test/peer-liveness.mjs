// Is a contact on another island still there, and which key do we seal to?
// Offline (report 1067).
//
// Why this gets a test of its own:
//   * A burned account on another island sent no signal anywhere, and the web
//     showed a message to it as sent. The probe that replaces the silence must
//     mark "deleted" only on the island's own words, in JSON: a bare 404 is
//     what a decoy site, a parked domain or an old self-host answers too, and
//     reading that as "deleted" would mark every contact of such an island.
//   * A person who moved to another number, or lives on at another home their
//     signed record names, is not deleted.
//   * The web sealed to the island's LIVE card in preference to the pinned
//     key, with no comparison, so a reissued number read the mail. The card is
//     now held against the pin, and a card under another key is "differs".
//   * Chat.tsx dropped `deliverCrossIsland`'s result on the floor; the source
//     checks at the end keep the result read and the pin first.
//   * Step 3 read a failed gossip-record GET (429, 5xx, a dropped connection)
//     as "no record", and marked a person alive at their primary deleted for
//     good. It now needs the island's own "no record", like steps 1 and 2.
//   * The mark's own time is the device's clock and a deposit stamp the
//     island's: compared raw, a device an hour fast kept "deleted" up while
//     the contact wrote.
// Everything here is production code from src/lib/peer-liveness-rules.ts and
// src/lib/federation.ts, imported from the BUILT bundle.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ed25519 } from '@noble/curves/ed25519'
import {
  NO_ACCOUNT_FOR_KEY,
  NO_RECORD,
  NO_SUCH_USER,
  buildHomeIslandRecord,
  cardAgainstPin,
  cardStep,
  depositAfterMark,
  ownerStep,
  recordStep,
  sameIslandHost,
} from '../dist/peer-liveness.mjs'

let n = 0
const check = (label, fn) => {
  fn()
  n++
  console.log('  ok  ' + label)
}

const b64 = (u8) => Buffer.from(u8).toString('base64')
const keyOf = (fill) => b64(new Uint8Array(32).fill(fill))

const PIN = { identityKey: keyOf(1), signingKey: keyOf(2) }
const HOST = 'is2.example'
const UIN = 222659798

const card = (ik, sk) => ({ uin: UIN, identity_key: ik, signing_key: sk, signal_identity_key: null })
const reply = (status, body) => ({ status, body })

console.log('peer liveness')

check('a card under the pinned keys matches, in any base64 spelling', () => {
  assert.equal(cardAgainstPin(card(PIN.identityKey, PIN.signingKey), PIN), 'match')
  const urlSafe = (s) => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const odd = b64(Uint8Array.from({ length: 32 }, (_, i) => (i % 2 ? 0xfb : 0xff)))
  assert.equal(cardAgainstPin(card(urlSafe(odd), PIN.signingKey), { ...PIN, identityKey: odd }), 'match')
})

check('a card under another key is "differs", whichever of the two changed', () => {
  assert.equal(cardAgainstPin(card(keyOf(9), PIN.signingKey), PIN), 'differs')
  assert.equal(cardAgainstPin(card(PIN.identityKey, keyOf(9)), PIN), 'differs')
  assert.equal(cardAgainstPin(card(keyOf(8), keyOf(9)), PIN), 'differs')
})

check('no card, a decoy page or a card missing a key is "no_card", never a match', () => {
  assert.equal(cardAgainstPin(null, PIN), 'no_card')
  assert.equal(cardAgainstPin({}, PIN), 'no_card')
  assert.equal(cardAgainstPin({ identity_key: PIN.identityKey }, PIN), 'no_card')
  assert.equal(cardAgainstPin({ identity_key: '', signing_key: PIN.signingKey }, PIN), 'no_card')
  assert.equal(cardAgainstPin('<html>', PIN), 'no_card')
})

check('a row pinned without a signing key is anchored by its identity key alone', () => {
  const legacy = { identityKey: PIN.identityKey, signingKey: '' }
  assert.equal(cardAgainstPin(card(PIN.identityKey, keyOf(7)), legacy), 'match')
  assert.equal(cardAgainstPin(card(keyOf(7), keyOf(7)), legacy), 'differs')
})

check('step 1: alive, key changed, or absent only on "no such user"', () => {
  assert.equal(cardStep(reply(200, card(PIN.identityKey, PIN.signingKey)), PIN), 'alive')
  assert.equal(cardStep(reply(200, card(keyOf(5), keyOf(6))), PIN), 'key_changed')
  assert.equal(cardStep(reply(404, { detail: NO_SUCH_USER }), PIN), 'absent')
  assert.equal(NO_SUCH_USER, 'no such user')
})

check('step 1: anything else is unknown (refused, decoy, framework 404, down)', () => {
  assert.equal(cardStep(null, PIN), 'unknown')
  assert.equal(cardStep(reply(403, { detail: 'island_closed' }), PIN), 'unknown')
  assert.equal(cardStep(reply(404, { detail: 'Not Found' }), PIN), 'unknown')
  assert.equal(cardStep(reply(404, null), PIN), 'unknown')
  assert.equal(cardStep(reply(200, null), PIN), 'unknown')
  assert.equal(cardStep(reply(500, { detail: 'internal_error' }), PIN), 'unknown')
  assert.equal(cardStep(reply(429, { detail: NO_SUCH_USER }), PIN), 'unknown')
})

check('step 2: another number under the pinned key is a move, not a death', () => {
  assert.equal(ownerStep(reply(200, { uin: 12345 }), UIN), 'moved')
  assert.equal(ownerStep(reply(404, { detail: NO_ACCOUNT_FOR_KEY }), UIN), 'absent')
  assert.equal(NO_ACCOUNT_FOR_KEY, 'no account for key')
})

check('step 2: the same number back, junk, or another 404 proves nothing', () => {
  assert.equal(ownerStep(reply(200, { uin: UIN }), UIN), 'unknown')
  assert.equal(ownerStep(reply(200, { uin: '12345' }), UIN), 'unknown')
  assert.equal(ownerStep(reply(200, null), UIN), 'unknown')
  assert.equal(ownerStep(reply(404, { detail: 'Not Found' }), UIN), 'unknown')
  assert.equal(ownerStep(reply(404, { detail: NO_SUCH_USER }), UIN), 'unknown')
  assert.equal(ownerStep(null, UIN), 'unknown')
})

// A real signed home record, as the person publishes it.
const seed = new Uint8Array(32).fill(3)
const sk = b64(ed25519.getPublicKey(seed))
const record = (homes) => buildHomeIslandRecord({ ik: keyOf(4), sk, signingPriv: seed, homes, ts: 1_759_000_000 })

check('step 3: a signed record naming another home means they live on', () => {
  assert.equal(recordStep(reply(200, record([{ host: HOST, uin: UIN }, { host: 'api.example', uin: UIN }])), sk, HOST, UIN), 'moved')
  assert.equal(recordStep(reply(200, record([{ host: HOST, uin: 777 }])), sk, HOST, UIN), 'moved')
})

check('step 3: absent only on "no record", or a record naming only this address', () => {
  assert.equal(recordStep(reply(404, { detail: NO_RECORD }), sk, HOST, UIN), 'absent')
  assert.equal(NO_RECORD, 'no record')
  assert.equal(recordStep(reply(200, record([{ host: HOST, uin: UIN }])), sk, HOST, UIN), 'absent')
  assert.equal(recordStep(reply(200, record([{ host: 'IS2.example.', uin: UIN }])), sk, HOST, UIN), 'absent')
})

check('step 3: a failed or unclear read of our own mirror is unknown, never "deleted"', () => {
  assert.equal(recordStep(null, sk, HOST, UIN), 'unknown')
  assert.equal(recordStep(reply(429, { detail: 'rate_limited' }), sk, HOST, UIN), 'unknown')
  assert.equal(recordStep(reply(503, null), sk, HOST, UIN), 'unknown')
  assert.equal(recordStep(reply(502, { detail: NO_RECORD }), sk, HOST, UIN), 'unknown')
  assert.equal(recordStep(reply(404, { detail: 'Not Found' }), sk, HOST, UIN), 'unknown')
  assert.equal(recordStep(reply(404, null), sk, HOST, UIN), 'unknown')
  assert.equal(recordStep(reply(200, null), sk, HOST, UIN), 'unknown')
  assert.equal(recordStep(reply(404, { detail: NO_RECORD }), '', HOST, UIN), 'unknown')
})

check('step 3: a record not signed by the PINNED key is not evidence', () => {
  const otherSeed = new Uint8Array(32).fill(6)
  const otherSk = b64(ed25519.getPublicKey(otherSeed))
  const forged = buildHomeIslandRecord({
    ik: keyOf(4),
    sk: otherSk,
    signingPriv: otherSeed,
    homes: [{ host: 'elsewhere.example', uin: UIN }],
    ts: 1_759_000_000,
  })
  assert.equal(recordStep(reply(200, forged), sk, HOST, UIN), 'unknown')
  const tampered = { ...record([{ host: HOST, uin: UIN }]), homes: [{ host: 'elsewhere.example', uin: UIN }] }
  assert.equal(recordStep(reply(200, tampered), sk, HOST, UIN), 'unknown')
})

check('a deposit is news after a mark on the device clock, not the raw island stamp', () => {
  const mark = 1_759_000_000_000
  // No offset known yet: as before.
  assert.equal(depositAfterMark(mark + 1, mark, 0), true)
  assert.equal(depositAfterMark(mark - 1, mark, 0), false)
  // No stamp: a live delivery.
  assert.equal(depositAfterMark(undefined, mark, 3600_000), true)
  // Device an hour fast: a message deposited ten minutes after the mark (by
  // the island) reads 50 minutes before it raw, and is news all the same.
  const hour = 3600_000
  assert.equal(depositAfterMark(mark - hour + 600_000, mark, hour), true)
  // Device an hour slow: mail deposited ten minutes BEFORE the mark reads 50
  // minutes after it raw, and is old mail all the same.
  assert.equal(depositAfterMark(mark + hour - 600_000, mark, -hour), false)
})

check('island addresses compare by one spelling', () => {
  assert.equal(sameIslandHost('IS2.Example:443', 'is2.example'), true)
  assert.equal(sameIslandHost('is2.example.', 'is2.example'), true)
  assert.equal(sameIslandHost('is2.example:8443', 'is2.example'), false)
})

// Source pins: the places that used to prefer the card, and the send that
// used to drop its result. Cheap, and they fail loudly on a re-inlined copy.
const root = new URL('../../', import.meta.url)
const src = (p) => fs.readFileSync(new URL(p, root), 'utf8')
/// The source without its comment lines: the comments quote the old code.
const code = (p) => src(p).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')

check('no sender prefers the live card over the pinned key any more', () => {
  for (const p of ['src/lib/federation-send.ts', 'src/lib/crossisland-call.ts']) {
    assert.doesNotMatch(code(p), /card\?\.identity_key\s*\|\|/, p)
  }
  assert.match(src('src/lib/crossisland-call.ts'), /sealingKeysFor\(/)
})

check('the chat reads the cross-island send result and probes on failure', () => {
  const chat = src('src/pages/Chat.tsx')
  assert.match(chat, /res = await deliverCrossIsland\(/)
  assert.match(chat, /if \(res\.delivered === 0\) \{\s*void probePeerLiveness\(identity, peer\.uin, peer\.host, 'failure'\)/)
  assert.match(chat, /probePeerLiveness\(identity, ciPeerUin, ciPeerHost, 'open'\)/)
})

check('the probe never goes near the mailbox or the per-number record', () => {
  const probe = code('src/lib/peer-liveness.ts')
  assert.doesNotMatch(probe, /messages\/sealed/)
  assert.doesNotMatch(probe, /island-record/)
})

check('step 3 reads its reply through the strict rule, not the null-on-anything fetch', () => {
  const probe = code('src/lib/peer-liveness.ts')
  assert.doesNotMatch(probe, /fetchGossipRecord/)
  assert.match(probe, /recordStep\(\s*await getJson\(`https:\/\/\$\{ownHost\}\/federation\/gossip-record\?sk=/)
  assert.match(probe, /depositAfterMark\(srvAt, m\.gone, clockOffsetMs\(\)\)/)
})

check('a card under the pinned keys lifts "deleted" as well as "key changed"', () => {
  const probe = code('src/lib/peer-liveness.ts')
  const body = probe.slice(probe.indexOf('export function notePinnedCard'), probe.indexOf('export function notePeerHeardFrom'))
  assert.match(body, /delete m\.keyChanged\s*\n\s*delete m\.gone/)
})

check('no card does not lift a standing "key changed": nothing goes to the pin', () => {
  const send = code('src/lib/federation-send.ts')
  assert.match(send, /verdict === 'no_card' && isPeerKeyChanged\(peerUin, peerHost\)\) return \{ keys: null, keyChanged: true \}/)
})

check('the chat banner and its Remove act only on the peer of the open route', () => {
  const chat = code('src/pages/Chat.tsx')
  assert.match(chat, /ciKey\(peer\.uin, peer\.host\) === ciKey\(peerUIN, islandHost\)/)
  assert.match(chat, /const ciPeerHost = peerIsRoute \?/)
  const from = chat.indexOf('function removeCrossIslandPeer')
  const remove = chat.slice(from, chat.indexOf('\n  }\n', from))
  assert.match(remove, /removeCrossIsland\(ciPeerUin, ciPeerHost\)/)
  assert.doesNotMatch(remove, /peer\.uin|peer\.host/)
})

check('the home record offered to a backup island is dated at the epoch', () => {
  const mh = code('src/lib/multihome.ts')
  const offered = mh.slice(mh.indexOf('async function offeredHomeRecord'), mh.indexOf('export async function registerOnIsland'))
  assert.match(offered, /ts: 1,/)
  assert.doesNotMatch(offered, /Date\.now\(\)/)
})

console.log(`peer-liveness: ${n} ok`)

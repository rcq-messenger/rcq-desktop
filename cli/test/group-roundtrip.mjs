// Fully-offline group round trip: Alice posts to a room, Bob reads it.
//
// This is the claim the CLI used to refuse to make ("groups live in the
// apps"), so it is worth proving rather than asserting. Everything below is
// production code from src/lib: the dual-send builder, the SKDM handshake,
// the broadcast decode, driven by two accounts and a two-person roster. No
// island, no socket, no network.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'
import {
  buildGroupDualSend,
  decryptV1,
  handleGmsg,
  handleSkdm,
  heldGmsgCount,
  knowsKid,
  newTestIdentity,
  ownsKid,
} from '../dist/group-v1.mjs'

// sender-key-store and held-gmsg are localStorage-backed, exactly as in the
// browser; the CLI's own shim is a JSON file, this one is a Map.
const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size
  },
}

const alice = newTestIdentity(100001)
const bob = newTestIdentity(100002)
const GID = 21
const roster = [alice, bob].map((p) => ({
  uin: p.uin,
  nickname: `u${p.uin}`,
  role: 'member',
  status: 'online',
  identity_key: p.identityKeyB64,
  signing_key: p.signingKeyB64,
  sender_keys: true, // both accounts advertised, so this is a pure broadcast
}))

const hello = { kind: 'text', id: 'CCCCCCCC-1111-4222-8333-444444444444', text: 'standup at 10' }
const ds = buildGroupDualSend(hello, alice, GID, roster)
assert.ok(ds.broadcastPayload, 'a capable roster must produce one broadcast')
assert.equal(ds.legacyPayloads.length, 0, 'nobody here needs the legacy fan-out')
assert.equal(ds.skdmPayloads.length, 1, 'bob has never held this chain')
assert.equal(ds.skipped.length, 0)
ds.commit()

// The broadcast reaches Bob BEFORE its chain does, which is the ordering the
// live socket produces and the one that used to lose the message outright.
// (handleGmsg fires a recovery request here; with no island it fails quietly.)
const early = await handleGmsg(bob, ds.broadcastPayload, GID)
assert.equal(early, null, 'no chain yet, so nothing opens')
assert.equal(heldGmsgCount(bob.uin), 1, 'the packet is held for replay, not dropped')

// Now the SKDM: sealed per member, so it arrives as an ordinary v=1 envelope.
const opened = decryptV1(ds.skdmPayloads[0].payload, bob)
assert.equal(opened.senderUIN, alice.uin)
assert.equal(opened.envelope.kind, 'skdm')
assert.equal(handleSkdm(bob.uin, opened.senderUIN, opened.senderSigningKey, opened.envelope), true)
assert.equal(knowsKid(bob.uin, opened.envelope.kid), true)

// The same packet, replayed: this is what receive.ts does with the held copy.
const got = await handleGmsg(bob, ds.broadcastPayload, GID)
assert.ok(got, 'the chain is here, so the broadcast opens')
assert.equal(got.senderUIN, alice.uin)
assert.equal(got.envelope.kind, 'text')
assert.equal(got.envelope.text, hello.text)

// A second read of the same packet must not produce a second message: the
// chain has ratcheted past that position.
assert.equal(await handleGmsg(bob, ds.broadcastPayload, GID), null, 'replay does not duplicate')

// An unauthenticated chain is refused whatever it claims: this is what stops a
// stranger handing us a chain in somebody else's name.
assert.equal(handleSkdm(bob.uin, alice.uin, undefined, opened.envelope), false)

// Alice's own broadcast comes back to her from the island (the server fans it
// to every capable member, sender included) and must not print twice.
assert.equal(ownsKid(alice.uin, opened.envelope.kid), true)
assert.equal(await handleGmsg(alice, ds.broadcastPayload, GID), null, 'own echo is dropped')

// A member who never advertised keeps the per-member fan-out, and both halves
// of a mixed room go out from one build.
const carol = newTestIdentity(100003)
const mixed = buildGroupDualSend(hello, alice, GID + 1, [
  ...roster,
  { uin: carol.uin, nickname: 'carol', role: 'member', status: 'online', identity_key: carol.identityKeyB64, signing_key: carol.signingKeyB64 },
])
assert.ok(mixed.broadcastPayload, 'the capable members still get one broadcast')
assert.equal(mixed.legacyPayloads.length, 1, 'carol gets her own copy')
assert.equal(decryptV1(mixed.legacyPayloads[0].payload, carol).envelope.text, hello.text)

console.log('group roundtrip ok: dual-send, skdm handshake, held replay, dedup, own-echo drop, mixed room')

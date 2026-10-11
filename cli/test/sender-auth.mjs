// Who sealed an envelope, and what that sender may touch (sender-auth, 11.10).
//
// Why these get a test of their own:
//   * a v=1 seal signs ek||env only; `from` and `from_host` sit beside it,
//     unsigned, and the deposit is anonymous. Anyone with our open key card
//     could seal `{from: V}` without a host and land as V, a contact on our
//     own island, or as any member (owner included) of a room;
//   * edits, deletes and reactions acted on a bare message id across every
//     thread on the device, a moderator's delete in ANY room reached our 1:1
//     chats, and a group edit rewrote somebody else's message;
//   * a re-sent SKDM rewrote the key of an existing chain, so a member could
//     take over another member's chain; a chain opened broadcasts of any room;
//   * v=2 named its sender in the clear and the identity store trusted the
//     first PreKey message for any address, so anyone could pose as anyone
//     (our own devices included) and displace the session we reply on.
// Everything here is production code: the pure rule and the sender-key store
// from the built bundle, the v=2 codec from crypto-v2.mjs, and the incoming
// store bundled on its own the way queue-time.mjs does it.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// localStorage for the sender-key store and the pins, before anything loads.
const ls = new Map()
globalThis.localStorage = {
  get length() {
    return ls.size
  },
  key: (i) => [...ls.keys()][i] ?? null,
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => void ls.set(k, String(v)),
  removeItem: (k) => void ls.delete(k),
  clear: () => ls.clear(),
}

const T = await import('../dist/sender-trust.mjs')
const V2 = await import('../dist/crypto-v2.mjs')

let n = 0
const check = async (label, fn) => {
  await fn()
  n++
  console.log('  ok  ' + label)
}

const key = (b) => Buffer.alloc(32, b).toString('base64')
const ME = 500
const OWN = key(1)
const V = 42
const V_KEY = key(2)
const V_NEW = key(3)
const EVIL = key(9)
const base = {
  senderUin: V,
  myUin: ME,
  spub: null,
  v2: null,
  ownSigningKey: OWN,
  claimedHost: null,
  roster: null,
  pin: null,
  crossIsland: [],
}

// ── the 1:1 verdict ────────────────────────────────────────────────────────

await check('our own number: SELF only under our own key, FORGED under any other', () => {
  assert.equal(T.directSenderTrust({ ...base, senderUin: ME, spub: OWN }).trust, 'self')
  const f = T.directSenderTrust({ ...base, senderUin: ME, spub: EVIL })
  assert.equal(f.trust, 'forged')
  assert.equal(T.directControlAllowed(f), false)
  // v=2: one of our devices the island publishes, or nobody.
  assert.equal(T.directSenderTrust({ ...base, senderUin: ME, v2: 'verified' }).trust, 'self')
  assert.equal(T.directSenderTrust({ ...base, senderUin: ME, v2: 'mismatch' }).trust, 'forged')
})

await check('our digits on ANOTHER island under their own key are a person there, not a forgery of us', () => {
  const v = T.directSenderTrust({ ...base, senderUin: ME, spub: EVIL, claimedHost: 'b.example' })
  assert.equal(v.trust, 'unpinned')
  assert.equal(v.host, 'b.example')
})

await check('a contact of our island under the roster key: PINNED, host is ours whatever from_host said', () => {
  const v = T.directSenderTrust({ ...base, spub: V_KEY, roster: { key: V_KEY }, pin: V_KEY })
  assert.deepEqual(v, { trust: 'pinned', host: null, keyChanged: false })
  // The same key with a foreign `from_host`: the key decides, the host comes off the row.
  const w = T.directSenderTrust({ ...base, spub: V_KEY, roster: { key: V_KEY }, pin: V_KEY, claimedHost: 'evil.example' })
  assert.equal(w.trust, 'pinned')
  assert.equal(w.host, null)
})

await check('the forgery this exists for: a contact number, no host, another key: one card read, then FORGED', () => {
  const first = T.directSenderTrust({ ...base, spub: EVIL, roster: { key: V_KEY }, pin: V_KEY })
  assert.equal(first.needsCard, true, 'asks the island once before calling it forged')
  const v = T.directSenderTrust({ ...base, spub: EVIL, roster: { key: V_KEY }, pin: V_KEY, card: V_KEY })
  assert.equal(v.trust, 'forged')
  assert.equal(v.keyChanged, true)
  assert.equal(T.directControlAllowed(v), false)
  // The card read failing is not a pass either.
  assert.equal(T.directSenderTrust({ ...base, spub: EVIL, roster: { key: V_KEY }, pin: V_KEY, card: null }).trust, 'forged')
})

await check('a legitimate reissue: the island vouches for the new key; taken, re-pinned, and said out loud', () => {
  // The roster already shows it. Roster and pin disagree, so the card decides.
  assert.equal(T.directSenderTrust({ ...base, spub: V_NEW, roster: { key: V_NEW }, pin: V_KEY }).needsCard, true)
  const r = T.directSenderTrust({ ...base, spub: V_NEW, roster: { key: V_NEW }, pin: V_KEY, card: V_NEW })
  assert.deepEqual(r, { trust: 'pinned', host: null, keyChanged: true, repin: V_NEW })
  // No card to be had (the island said nobody): the roster's word, as before.
  const n = T.directSenderTrust({ ...base, spub: V_NEW, roster: { key: V_NEW }, pin: V_KEY, card: null })
  assert.deepEqual(n, { trust: 'pinned', host: null, keyChanged: true, repin: V_NEW })
  // The roster is behind, a fresh card shows it.
  const c = T.directSenderTrust({ ...base, spub: V_NEW, roster: { key: V_KEY }, pin: V_KEY, card: V_NEW })
  assert.equal(c.trust, 'pinned')
  assert.equal(c.repin, V_NEW)
  assert.equal(c.keyChanged, true)
  // The OLD key after the island moved on is not the contact any more.
  assert.equal(T.directSenderTrust({ ...base, spub: V_KEY, roster: { key: V_NEW }, pin: V_KEY, card: V_NEW }).trust, 'forged')
})

await check('a stale roster never hands a contact back to the key they left behind', () => {
  // The roster still names V_KEY, a card moved the pin on to V_NEW. Whoever
  // still holds V_KEY (a leaked phrase) used to pass on the roster's word and
  // move the pin back to itself.
  const ask = T.directSenderTrust({ ...base, spub: V_KEY, roster: { key: V_KEY }, pin: V_NEW })
  assert.equal(ask.needsCard, true, 'roster and pin disagree: the card decides')
  assert.equal(ask.repin, undefined, 'and nothing is re-pinned before it does')
  const v = T.directSenderTrust({ ...base, spub: V_KEY, roster: { key: V_KEY }, pin: V_NEW, card: V_NEW })
  assert.equal(v.trust, 'forged')
  assert.equal(v.keyChanged, true)
  assert.equal(v.repin, undefined)
  assert.equal(T.directControlAllowed(v), false)
  // The contact under the key the card names: theirs, through the card.
  const ok = T.directSenderTrust({ ...base, spub: V_NEW, roster: { key: V_KEY }, pin: V_NEW, card: V_NEW })
  assert.equal(ok.trust, 'pinned')
  assert.equal(ok.keyChanged, false, 'the pin already holds it')
  // Roster and pin agreeing costs no card read at all.
  assert.deepEqual(T.directSenderTrust({ ...base, spub: V_KEY, roster: { key: V_KEY }, pin: V_KEY }), { trust: 'pinned', host: null, keyChanged: false })
})

await check('a roster row without a key: the pin, else the card, else held as unverified', () => {
  assert.equal(T.directSenderTrust({ ...base, spub: V_KEY, roster: { key: null }, pin: V_KEY }).trust, 'pinned')
  const firstSight = T.directSenderTrust({ ...base, spub: V_KEY, roster: { key: null }, pin: null, card: V_KEY })
  assert.equal(firstSight.trust, 'pinned')
  assert.equal(firstSight.keyChanged, false, 'a first pin is not a change')
  const unknown = T.directSenderTrust({ ...base, spub: V_KEY, roster: { key: null }, pin: null, card: null })
  assert.equal(unknown.unverified, true)
  assert.equal(T.directControlAllowed(unknown), false)
})

await check('a cross-island contact: PINNED by key from any address, the host from the row; a hostless forgery is FORGED', () => {
  const ci = [{ host: 'b.example', signingKey: V_KEY }]
  // Promoted backup: same key, another island.
  const p = T.directSenderTrust({ ...base, spub: V_KEY, crossIsland: ci, claimedHost: 'c.example' })
  assert.equal(p.trust, 'pinned')
  assert.equal(p.host, 'b.example')
  // Leaving `from_host` out used to file a forgery straight into V@b's thread.
  const hostless = T.directSenderTrust({ ...base, spub: EVIL, crossIsland: ci })
  assert.equal(hostless.trust, 'forged')
  // The pinned address under another key.
  const at = T.directSenderTrust({ ...base, spub: EVIL, crossIsland: ci, claimedHost: 'b.example' })
  assert.equal(at.trust, 'forged')
  assert.equal(at.host, 'b.example')
  // Somebody else on another island: a stranger there.
  const s = T.directSenderTrust({ ...base, spub: EVIL, crossIsland: ci, claimedHost: 'd.example' })
  assert.equal(s.trust, 'unpinned')
  assert.equal(s.host, 'd.example')
})

await check('a stranger on our island: UNPINNED, under the stranger rules (controls in their own thread only)', () => {
  const v = T.directSenderTrust({ ...base, spub: EVIL })
  assert.deepEqual(v, { trust: 'unpinned', host: null, keyChanged: false })
  assert.equal(T.directControlAllowed(v), true)
  // A cross-island stranger's controls stay dropped.
  assert.equal(T.directControlAllowed(T.directSenderTrust({ ...base, spub: EVIL, claimedHost: 'b.example' })), false)
})

await check('not a contact, but a key is pinned for the number (room member, accepted request, removed contact): only that key', () => {
  // Under the pinned key: unpinned as before, no new rights (no pkey, no homerec).
  assert.deepEqual(T.directSenderTrust({ ...base, spub: V_KEY, pin: V_KEY }), { trust: 'unpinned', host: null, keyChanged: false })
  // Another key: one card read first, so a reissue is not called a forgery.
  const ask = T.directSenderTrust({ ...base, spub: EVIL, pin: V_KEY })
  assert.equal(ask.trust, 'forged')
  assert.equal(ask.needsCard, true)
  // The island still vouches for the pinned key: whoever sealed this is not them.
  const f = T.directSenderTrust({ ...base, spub: EVIL, pin: V_KEY, card: V_KEY })
  assert.equal(f.trust, 'forged')
  assert.equal(f.keyChanged, true)
  assert.equal(f.needsCard, undefined)
  assert.equal(T.directControlAllowed(f), false)
  // No card to be had: still not the key held for them.
  assert.equal(T.directSenderTrust({ ...base, spub: EVIL, pin: V_KEY, card: null }).trust, 'forged')
  // A reissue (or a number the island reassigned) the island vouches for:
  // taken, re-pinned, said out loud.
  const r = T.directSenderTrust({ ...base, spub: V_NEW, pin: V_KEY, card: V_NEW })
  assert.equal(r.trust, 'unpinned')
  assert.equal(r.repin, V_NEW)
  assert.equal(r.keyChanged, true)
  // Another island's number with the same digits is somebody else, unaffected.
  const away = T.directSenderTrust({ ...base, spub: EVIL, pin: V_KEY, claimedHost: 'b.example' })
  assert.equal(away.trust, 'unpinned')
  assert.equal(away.host, 'b.example')
})

await check('v=2: the identity check is the proof; a number whose thread is a cross-island contact never lands there', () => {
  assert.equal(T.directSenderTrust({ ...base, v2: 'verified', roster: { key: V_KEY } }).trust, 'pinned')
  assert.equal(T.directSenderTrust({ ...base, v2: 'verified' }).trust, 'unpinned')
  const m = T.directSenderTrust({ ...base, v2: 'mismatch', roster: { key: V_KEY } })
  assert.equal(m.trust, 'forged')
  assert.equal(m.keyChanged, true)
  // Not a contact either: still flagged, so the requests list will not
  // release it into that number's thread on an accept (no key to check).
  const s = T.directSenderTrust({ ...base, v2: 'mismatch' })
  assert.equal(s.trust, 'forged')
  assert.equal(s.keyChanged, true)
  assert.equal(T.directSenderTrust({ ...base, v2: 'verified', crossIsland: [{ host: 'b.example', signingKey: V_KEY }] }).trust, 'forged')
})

// ── the room verdict ───────────────────────────────────────────────────────

await check('a room: only a member under the roster key speaks; a non-member or another key is refreshed once, then dropped', () => {
  const room = { senderUin: V, myUin: ME, spub: V_KEY, v2: null, ownSigningKey: OWN }
  assert.deepEqual(T.roomSenderTrust({ ...room, member: { key: V_KEY } }), { trust: 'pinned' })
  assert.deepEqual(T.roomSenderTrust({ ...room, spub: EVIL, member: { key: V_KEY } }), { trust: 'forged', refresh: true })
  assert.deepEqual(T.roomSenderTrust({ ...room, member: null }), { trust: 'unpinned', refresh: true })
  assert.deepEqual(T.roomSenderTrust({ ...room, member: { key: null } }), { trust: 'unpinned' })
  // The owner's number under a stranger's key is not the owner.
  assert.equal(T.roomSenderTrust({ ...room, senderUin: ME, spub: EVIL, member: { key: OWN } }).trust, 'forged')
  assert.equal(T.roomSenderTrust({ ...room, senderUin: ME, spub: OWN, member: null }).trust, 'self')
  assert.equal(T.roomSenderTrust({ ...room, spub: null, v2: 'verified', member: { key: V_KEY } }).trust, 'pinned')
  assert.equal(T.roomSenderTrust({ ...room, spub: null, v2: 'mismatch', member: { key: V_KEY } }).trust, 'forged')
})

await check('room key: a version within reach only, so one envelope cannot wedge the room forever', () => {
  assert.equal(T.roomKeyVersionAllowed(4, 3, null), true)
  assert.equal(T.roomKeyVersionAllowed(2 ** 53 - 1, 3, null), false)
  assert.equal(T.roomKeyVersionAllowed(3 + T.ROOM_KEY_MAX_AHEAD, 3, null), true)
  assert.equal(T.roomKeyVersionAllowed(4 + T.ROOM_KEY_MAX_AHEAD, 3, null), false)
  // The sealed blob's own version lets a member who missed rotations catch up.
  assert.equal(T.roomKeyVersionAllowed(40, 3, 39), true)
  assert.equal(T.roomKeyVersionAllowed(-1, null, null), false)
  assert.equal(T.roomKeyVersionAllowed('7', null, null), false)
})

// ── sender-key chains ──────────────────────────────────────────────────────

await check('SKDM: bound to its room by the frame it rode', () => {
  assert.equal(T.skdmRoomMatches(21, 21), true)
  assert.equal(T.skdmRoomMatches(21, 22), false)
  assert.equal(T.skdmRoomMatches(21, null), false)
  assert.equal(T.skdmRoomMatches('21', 21), false)
})

await check('SKDM: a chain never changes key, sender or room once filed', () => {
  const ck = Buffer.alloc(32, 7).toString('base64')
  assert.equal(T.acceptSkdm(ME, 'kidV', 21, V, V_KEY, 0, 0, ck), true)
  // Member M re-sends V's chain as V under M's own key: refused, V's chain keeps V's key.
  assert.equal(T.acceptSkdm(ME, 'kidV', 21, V, EVIL, 0, 0, ck), false)
  assert.equal(T.peekInbound(ME, 'kidV').spub, V_KEY)
  // Another sender claiming the kid, or the same kid filed for another room.
  assert.equal(T.acceptSkdm(ME, 'kidV', 21, 77, V_KEY, 0, 0, ck), false)
  assert.equal(T.acceptSkdm(ME, 'kidV', 22, V, V_KEY, 0, 0, ck), false)
  assert.equal(T.acceptSkdm(ME, 'kidV', 21, V, V_KEY, 0, 0, ck, 'b.example'), false, 'nor for a room of that number elsewhere')
  // The legitimate re-send (same everything) is still taken.
  assert.equal(T.acceptSkdm(ME, 'kidV', 21, V, V_KEY, 0, 0, ck), true)
  // A chain opens nothing in another room.
  assert.equal(T.deriveInbound(ME, 'kidV', 0, 0, 22), null)
  assert.ok(T.deriveInbound(ME, 'kidV', 0, 0, 21), 'and opens in its own')
})

// ── v=2: who is behind a session ───────────────────────────────────────────

await check('v=2 identity rule: memory first, then what the island publishes, never a silent change', () => {
  const ik = key(5)
  const other = key(6)
  assert.deepEqual(T.v2IdentityDecision(ik, null, ik), { verdict: 'verified', remember: false })
  assert.deepEqual(T.v2IdentityDecision(null, ik, ik), { verdict: 'verified', remember: true })
  assert.deepEqual(T.v2IdentityDecision(other, ik, ik), { verdict: 'verified', remember: true }, 'a reinstall the island took')
  assert.deepEqual(T.v2IdentityDecision(null, other, ik), { verdict: 'mismatch', remember: false })
  // An island that names no identity: the first is taken, a change is not.
  assert.deepEqual(T.v2IdentityDecision(null, undefined, ik), { verdict: 'verified', remember: true })
  assert.deepEqual(T.v2IdentityDecision(other, undefined, ik), { verdict: 'mismatch', remember: false })
  // A device the island does not list at all.
  assert.deepEqual(T.v2IdentityDecision(null, null, ik), { verdict: 'mismatch', remember: false })
})

function bundleOf(dev, upload, opk) {
  return {
    uin: dev.uin,
    device_id: dev.deviceId,
    sealed_sender_pub: V2.bytesToB64(dev.outerPub),
    registration_id: upload.registration_id,
    signal_identity_key: upload.signal_identity_key,
    signed_prekey: upload.signed_prekey,
    kyber_prekey: upload.kyber_prekey,
    one_time_prekey: upload.one_time_prekeys[opk],
  }
}

await check('v=2: the identity inside a real PreKey message and a real session record parses out', async () => {
  const alice = await V2.WebSignalDevice.create(100001, 1)
  const bob = await V2.WebSignalDevice.create(100002, 1)
  const up = await bob.buildBundle(4)
  await alice.establishSession(bundleOf(bob, up, 0))
  const wire = await alice.encryptTo(bob.uin, bob.deviceId, bob.outerPub, { kind: 'text', id: 'id-1', text: 'hi' })
  const inner = V2.outerUnwrapV2(wire, bob.outerPriv, bob.outerPub)
  assert.equal(inner.kind, 'prekey')
  const ik = T.prekeyMessageIdentity(V2.b64ToBytes(inner.msg))
  assert.ok(ik)
  assert.equal(V2.bytesToB64(ik), alice.signalIdentityKeyB64())
  await bob.decrypt(wire)
  const rec = await bob.sessionStore.export_session(bob['addr'](alice.uin, 1))
  const ids = T.sessionRemoteIdentities(rec)
  assert.equal(V2.bytesToB64(ids.current), alice.signalIdentityKeyB64())
  assert.equal(T.prekeyMessageIdentity(new Uint8Array([0x33, 0xff])), null, 'garbage does not parse')
})

await check('v=2: a PreKey message posing as a contact is opened in a sandbox and never displaces their session', async () => {
  const alice = await V2.WebSignalDevice.create(200001, 1)
  const bob = await V2.WebSignalDevice.create(200002, 1)
  const up = await bob.buildBundle(4)
  await alice.establishSession(bundleOf(bob, up, 0))
  const aliceIk = alice.signalIdentityKeyB64()
  // What the island publishes for (alice, 1): alice's identity, nobody else's.
  const verify = async (uin, dev, ikBytes) => (uin === alice.uin && dev === 1 && V2.bytesToB64(ikBytes) === aliceIk ? 'verified' : 'mismatch')

  const w1 = await alice.encryptTo(bob.uin, 1, bob.outerPub, { kind: 'text', id: 'a-1', text: 'from alice' })
  const g1 = await bob.decrypt(w1, undefined, undefined, verify)
  assert.equal(g1.identity, 'verified')

  // A reload: the in-memory identity store starts empty, the session stays.
  const bob2 = await V2.WebSignalDevice.restore(await bob.serialize())
  // Mallory builds a session "as" (alice, 1) from bob's published bundle.
  const mallory = await V2.WebSignalDevice.create(alice.uin, 1)
  await mallory.establishSession(bundleOf(bob, up, 1))
  const forged = await mallory.encryptTo(bob.uin, 1, bob.outerPub, { kind: 'text', id: 'm-1', text: 'send money here' })
  const g2 = await bob2.decrypt(forged, undefined, undefined, verify)
  assert.equal(g2.identity, 'mismatch', 'shown, as what it is')
  assert.equal(g2.envelope.text, 'send money here')

  // Alice's next message still opens on her session, and is still alice.
  const w2 = await alice.encryptTo(bob.uin, 1, bob.outerPub, { kind: 'text', id: 'a-2', text: 'still me' })
  const g3 = await bob2.decrypt(w2, undefined, undefined, verify)
  assert.equal(g3.identity, 'verified')
  assert.equal(g3.envelope.text, 'still me')
  // And bob's reply goes to alice's ratchet, which she can open.
  const reply = await bob2.encryptTo(alice.uin, 1, alice.outerPub, { kind: 'text', id: 'b-1', text: 'reply' })
  assert.equal((await alice.decrypt(reply)).envelope.text, 'reply')

  // Mallory continuing on the session she thinks she has: nothing to open it with.
  const forged2 = await mallory.encryptTo(bob.uin, 1, bob.outerPub, { kind: 'text', id: 'm-2', text: 'again' })
  const g4 = await bob2.decrypt(forged2, undefined, undefined, verify).catch(() => null)
  assert.ok(g4 == null || g4.identity === 'mismatch', 'never verified as alice')
})

await check('v=2: an island that cannot be asked leaves the row untouched (the check throws before the decrypt)', async () => {
  const alice = await V2.WebSignalDevice.create(300001, 1)
  const bob = await V2.WebSignalDevice.create(300002, 1)
  const up = await bob.buildBundle(4)
  await alice.establishSession(bundleOf(bob, up, 0))
  const w = await alice.encryptTo(bob.uin, 1, bob.outerPub, { kind: 'text', id: 'x-1', text: 'later' })
  await assert.rejects(bob.decrypt(w, undefined, undefined, async () => {
    throw new Error('island unreachable')
  }))
  // The same row opens on the next try: no prekey or ratchet was spent.
  const g = await bob.decrypt(w, undefined, undefined, async () => 'verified')
  assert.equal(g.envelope.text, 'later')
})

// ── the incoming store: control traffic stays in its own thread ───────────

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rcq-sender-auth-')), 'stores.mjs')
await build({
  stdin: {
    contents: `
      export * from './src/lib/incoming-store'
      export { savePersisted, storageKey } from './src/lib/outgoing-store'
      export { pinFirstSight, repinSignKey, signPinFor, unseenKeyChange, markKeyChangeSeen, seedSignPins } from './src/lib/sign-pins'
    `,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  define: { 'import.meta.env': '{}' },
  logLevel: 'warning',
  plugins: [
    {
      name: 'memory-idb',
      setup(b) {
        b.onResolve({ filter: /^\.\/signal-persist$/ }, () => ({ path: 'signal-persist', namespace: 'mem' }))
        b.onLoad({ filter: /.*/, namespace: 'mem' }, () => ({
          loader: 'ts',
          contents: `
            const m = new Map<string, unknown>()
            export async function idbGet<T>(k: string): Promise<T | undefined> { return m.get(k) as T | undefined }
            export async function idbGetFlat<T>(k: string): Promise<T | undefined> { return m.get(k) as T | undefined }
            export async function idbSet(k: string, v: unknown): Promise<void> { m.set(k, v) }
            export async function idbDel(k: string): Promise<void> { m.delete(k) }
            export async function idbKeys(): Promise<string[]> { return [...m.keys()] }
            export async function idbClearAll(): Promise<void> { m.clear() }
            export async function idbCarryKey(): Promise<boolean> { return false }
          `,
        }))
      },
    },
  ],
})
const bus = new EventTarget()
globalThis.window = globalThis
globalThis.addEventListener = bus.addEventListener.bind(bus)
globalThis.removeEventListener = bus.removeEventListener.bind(bus)
globalThis.dispatchEvent = bus.dispatchEvent.bind(bus)

const S = await import(out)
await S.hydrateIncoming(ME)
S.beginCatchUp()

const A = 1001
const B = 1002
const G1 = 31
const G2 = 32
const text = (id, t = 'x') => ({ kind: 'text', id, text: t })
const peerRow = (uin, id) => S.incomingSnapshots().peers.get(uin)?.find((r) => r.id === id)
const groupRow = (gid, id) => S.incomingSnapshots().groups.get(gid)?.find((r) => r.id === id)

S.addIncoming(A, text('a-msg'))
S.addIncoming(B, text('b-msg', 'from b'))
S.addGroupIncoming(G1, A, text('g1-a'))
S.addGroupIncoming(G1, B, text('g1-b', 'b in g1'))
S.addGroupIncoming(G2, B, text('g2-b'))
S.savePersisted(S.storageKey(false, A), [{ id: 'mine-to-a', text: 'hi a', sentAt: 1, state: 'sent', kind: 'text' }])
S.savePersisted(S.storageKey(false, B), [{ id: 'mine-to-b', text: 'hi b', sentAt: 1, state: 'sent', kind: 'text' }])
S.savePersisted(S.storageKey(true, G1), [{ id: 'mine-in-g1', text: 'hi g1', sentAt: 1, state: 'sent', kind: 'text' }])

await check('1:1 delete: only the sender\'s own row in their own thread', () => {
  S.addIncoming(A, { kind: 'delete', targetID: 'b-msg' })
  assert.ok(peerRow(B, 'b-msg'), "A cannot delete B's message")
  assert.equal(S.isDeleted('b-msg'), false)
  S.addIncoming(A, { kind: 'delete', targetID: 'g1-a' })
  assert.ok(groupRow(G1, 'g1-a'), 'nor their own message in a room, through 1:1')
  S.addIncoming(A, { kind: 'delete', targetID: 'mine-to-b' })
  assert.equal(S.isDeleted('mine-to-b'), false, 'nor ours to somebody else')
  S.addIncoming(A, { kind: 'delete', targetID: 'a-msg' })
  assert.equal(peerRow(A, 'a-msg'), undefined)
  assert.equal(S.isDeleted('a-msg'), true)
})

await check('a row filed under somebody else\'s id cannot be deleted to hide theirs', () => {
  S.addIncoming(A, text('b-msg', 'copy'))
  S.addIncoming(A, { kind: 'delete', targetID: 'b-msg' })
  assert.equal(S.isDeleted('b-msg'), false, 'no tombstone while the id lives in another thread')
  assert.ok(peerRow(B, 'b-msg'))
})

await check('room edit: only the author\'s own row', () => {
  S.addGroupIncoming(G1, A, { kind: 'edit', targetID: 'g1-b', text: 'rewritten' })
  assert.equal(groupRow(G1, 'g1-b').text, 'b in g1')
  S.addGroupIncoming(G1, B, { kind: 'edit', targetID: 'g1-b', text: 'fixed' })
  assert.equal(groupRow(G1, 'g1-b').text, 'fixed')
})

await check('a moderator acts inside their room only', () => {
  S.addGroupIncoming(G1, A, { kind: 'delete', targetID: 'g2-b' }, undefined, { moderator: true })
  assert.ok(groupRow(G2, 'g2-b'), 'another room is out of reach')
  S.addGroupIncoming(G1, A, { kind: 'delete', targetID: 'mine-to-b' }, undefined, { moderator: true })
  assert.equal(S.isDeleted('mine-to-b'), false, 'so is our 1:1')
  S.addGroupIncoming(G1, A, { kind: 'delete', targetID: 'mine-in-g1' }, undefined, { moderator: true })
  assert.equal(S.isDeleted('mine-in-g1'), true, 'our own message in that room is theirs to retract')
  // Without the role, somebody else's row stays.
  S.addGroupIncoming(G2, A, { kind: 'delete', targetID: 'g2-b' })
  assert.ok(groupRow(G2, 'g2-b'))
})

await check('reactions land only on a message of the thread they came through', () => {
  S.addIncoming(A, { kind: 'reaction', targetID: 'b-msg', asset: 'heart' })
  assert.equal(S.reactionsForTarget('b-msg'), undefined)
  S.addIncoming(A, { kind: 'reaction', targetID: 'g1-b', asset: 'heart' })
  assert.equal(S.reactionsForTarget('g1-b'), undefined, 'not into a room through 1:1')
  S.addIncoming(A, { kind: 'reaction', targetID: 'mine-to-a', asset: 'heart' })
  assert.equal(S.reactionsForTarget('mine-to-a').get(A), 'heart')
  S.addGroupIncoming(G2, B, { kind: 'reaction', targetID: 'g1-b', asset: 'fire' })
  assert.equal(S.reactionsForTarget('g1-b'), undefined, 'nor from one room into another')
  S.addGroupIncoming(G1, B, { kind: 'reaction', targetID: 'g1-a', asset: 'fire' })
  assert.equal(S.reactionsForTarget('g1-a').get(B), 'fire')
})

await check('our own number reaches every thread only when it is really us', () => {
  S.addIncoming(ME, { kind: 'delete', targetID: 'g2-b' })
  assert.ok(groupRow(G2, 'g2-b'), 'our number alone is not us')
  S.addIncoming(ME, { kind: 'delete', targetID: 'g2-b' }, undefined, { self: true })
  assert.equal(groupRow(G2, 'g2-b'), undefined)
  assert.equal(S.isDeleted('g2-b'), true)
})

await check('pins: first sight is kept, an island-vouched change is taken with the banner, once', () => {
  assert.equal(S.pinFirstSight(V, V_KEY), V_KEY)
  assert.equal(S.pinFirstSight(V, V_NEW), V_KEY, 'a second sight never overwrites')
  S.seedSignPins([{ uin: V, signing_key: V_NEW }, { uin: 77, signing_key: EVIL }, { uin: 78, signing_key: EVIL, host: 'b.example' }])
  assert.equal(S.signPinFor(V), V_KEY, 'a roster refresh does not swap a pin')
  assert.equal(S.signPinFor(77), EVIL)
  assert.equal(S.signPinFor(78), null, 'a cross-island row is not ours to pin')
  assert.equal(S.unseenKeyChange(V), null)
  S.repinSignKey(V, V_NEW, true)
  assert.equal(S.signPinFor(V), V_NEW)
  assert.equal(S.unseenKeyChange(V).previous, V_KEY)
  S.markKeyChangeSeen(V)
  assert.equal(S.unseenKeyChange(V), null)
})

console.log(`sender-auth ok: ${n} checks`)
// The history store's sweeper and coalesced write keep timers; nothing here needs them.
process.exit(0)

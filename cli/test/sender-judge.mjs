// The reads a sender verdict waits on (sender-auth follow-ups, 12.10).
//
// sender-auth.mjs proves the pure rule. This one proves the half that gathers
// its inputs off the island, against a fake island (a stand-in fetch), because
// every bug fixed here was in how a read that FAILED, or came back too early,
// was turned into an answer:
//   * a card read that failed (429, 5xx, the network) was kept for ten minutes
//     as "no card": a contact's legitimate key change went to the requests
//     list and their edits and receipts were dropped, for all of them;
//   * our own roster unreadable (a fresh browser) let a forgery under a
//     contact's number pass as a stranger's, straight into their thread;
//   * a room roster read a few seconds before a new member's first row was
//     final for that row: in a room too big for the island to push its
//     roster, the row was refused and acked away;
//   * a closed island answers an anonymous device-list read with the 404 it
//     gives "no such user": every v=2 row from a contact there read as FORGED;
//   * a v=2 identity remembered here passed without a look at the device
//     list, so an install the owner had revoked kept writing as them.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'

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

// A clock the test moves. Real timers still run (the request cutoffs); the
// only wait that is fast-forwarded is the roster window, when asked to.
let clock = Date.parse('2026-10-12T10:00:00Z')
Date.now = () => clock
const realSetTimeout = globalThis.setTimeout
let fastForward = false
globalThis.setTimeout = (fn, ms, ...args) => {
  if (fastForward && typeof ms === 'number' && ms > 0) {
    clock += ms
    return realSetTimeout(fn, 0, ...args)
  }
  return realSetTimeout(fn, ms, ...args)
}

// The fake island: one handler per path, every request counted.
const calls = []
const routes = new Map()
const json = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url))
  const authed = !!(init.headers && (init.headers.Authorization || init.headers.authorization))
  calls.push({ host: u.host, path: u.pathname, authed })
  const h = routes.get(`${u.host}${u.pathname}`)
  if (!h) return json(404, { detail: 'no route' })
  return h({ authed, init })
}
const count = (host, path) => calls.filter((c) => c.host === host && c.path === path).length

const J = await import('../dist/sender-judge.mjs')

let n = 0
const check = async (label, fn) => {
  await fn()
  n++
  console.log('  ok  ' + label)
}

const key = (b) => Buffer.alloc(32, b).toString('base64')
const OWN = Buffer.alloc(32, 1)
const ident = (uin, host) => ({
  uin,
  jwt: 'session-token',
  apiBase: `https://${host}`,
  identityPriv: new Uint8Array(32),
  identityPub: new Uint8Array(32),
  signingPriv: new Uint8Array(32),
  signingPub: OWN,
})
const contact = (uin, signing_key) => ({ uin, nickname: `c${uin}`, signing_key, identity_key: key(77) })
const roster = (uin, contacts) => J.contactsCache.set(uin, { contacts, groups: [], pending: [], me: null })

const OPEN_CAPS = { capabilities: { anon_keys: true, deposit_auth: true } }

// ── 1:1: the card a mismatch waits on ─────────────────────────────────────

await check('a card read that got no answer is "not yet" for a row that can wait, and asked again in 30 s, not 10 min', async () => {
  const H = 'a.example'
  const me = ident(500, H)
  const V = 42
  const V_OLD = key(2)
  const V_NEW = key(3)
  // The roster is behind: it still names the old key, the contact moved on.
  roster(me.uin, [contact(V, V_OLD)])
  let card = () => json(503, { detail: 'busy' })
  routes.set(`${H}/users/${V}/info`, () => card())

  const t1 = await J.resolveDirectTrust(me, V, null, V_NEW, null, true)
  assert.equal(t1.cardUnreachable, true, 'no answer: left for the next drain')
  assert.equal(J.signPinFor(V), V_OLD, 'and nothing was re-pinned on it')
  assert.equal(count(H, `/users/${V}/info`), 1)

  // The same failure is not asked again for 30 s: a flood costs one read.
  clock += 10_000
  const t2 = await J.resolveDirectTrust(me, V, null, V_NEW, null, true)
  assert.equal(t2.cardUnreachable, true)
  assert.equal(count(H, `/users/${V}/info`), 1)

  // A row that cannot wait is judged as it always was: no card, held.
  const t3 = await J.resolveDirectTrust(me, V, null, V_NEW, null, false)
  assert.equal(t3.trust, 'forged')
  assert.equal(t3.cardUnreachable, undefined)

  // 30 s on, the island answers with the new key: taken, re-pinned, said out loud.
  clock += 25_000
  card = () => json(200, { uin: V, signing_key: V_NEW, identity_key: key(77) })
  const t4 = await J.resolveDirectTrust(me, V, null, V_NEW, null, true)
  assert.equal(t4.trust, 'pinned')
  assert.equal(t4.keyChanged, true)
  assert.equal(J.signPinFor(V), V_NEW)
  assert.equal(count(H, `/users/${V}/info`), 2)

  // The old key now, under the stale roster: the card decides, not the roster.
  const t5 = await J.resolveDirectTrust(me, V, null, V_OLD, null, true)
  assert.equal(t5.trust, 'forged')
  assert.equal(J.signPinFor(V), V_NEW, 'the pin is not moved back')
})

await check('"not yet" is bounded: ten minutes of failures and the verdict is taken as it stands', async () => {
  const H = 'b.example'
  const me = ident(501, H)
  const V = 43
  roster(me.uin, [contact(V, key(2))])
  routes.set(`${H}/users/${V}/info`, () => json(502, {}))
  const evil = key(9)
  assert.equal((await J.resolveDirectTrust(me, V, null, evil, null, true)).cardUnreachable, true)
  clock += 9 * 60_000
  assert.equal((await J.resolveDirectTrust(me, V, null, evil, null, true)).cardUnreachable, true)
  clock += 61_000
  const late = await J.resolveDirectTrust(me, V, null, evil, null, true)
  assert.equal(late.cardUnreachable, undefined)
  assert.equal(late.trust, 'forged')
  // A 404 is an answer ("nobody"), never a wait.
  const W = 44
  roster(me.uin, [contact(V, key(2)), contact(W, key(4))])
  routes.set(`${H}/users/${W}/info`, () => json(404, { detail: 'no such user' }))
  const w = await J.resolveDirectTrust(me, W, null, evil, null, true)
  assert.equal(w.cardUnreachable, undefined)
  assert.equal(w.trust, 'forged')
})

await check('our own roster unreadable: a v=1 row waits instead of passing as a stranger\'s', async () => {
  const H = 'c.example'
  const me = ident(502, H)
  let contacts = () => json(503, {})
  routes.set(`${H}/contacts`, () => contacts())
  const t = await J.resolveDirectTrust(me, 45, null, key(9), null, true)
  assert.equal(t.rosterUnread, true)
  assert.equal(t.trust, 'unpinned')
  // Cannot wait: the stranger rules, as before.
  assert.equal((await J.resolveDirectTrust(me, 45, null, key(9), null, false)).rosterUnread, undefined)
  // Once the roster reads, the forgery under a contact's number is called one.
  clock += 31_000
  contacts = () => json(200, [contact(45, key(5))])
  routes.set(`${H}/users/45/info`, () => json(200, { uin: 45, signing_key: key(5), identity_key: key(77) }))
  const f = await J.resolveDirectTrust(me, 45, null, key(9), null, true)
  assert.equal(f.rosterUnread, undefined)
  assert.equal(f.trust, 'forged')
})

// ── rooms: a copy asked for before the row arrived is not final ──────────

await check('a new member\'s first row inside the roster window waits for one read instead of being dropped', async () => {
  const H = 'd.example'
  const me = ident(503, H)
  const G = 7
  const A = 61
  const X = 62
  const KA = key(11)
  const KX = key(12)
  let members = [{ uin: A, role: 'owner', signing_key: KA }]
  routes.set(`${H}/groups/${G}`, () => json(200, { id: G, name: 'r', members }))

  const first = await J.resolveRoomTrust(me, G, A, KA, null, clock)
  assert.equal(first.trust, 'pinned')
  assert.equal(count(H, `/groups/${G}`), 1)

  // X joins a second later and writes; the island pushes no roster (a big room).
  clock += 1_000
  members = [...members, { uin: X, role: 'member', signing_key: KX }]
  const seenAt = clock
  fastForward = true
  const x = await J.resolveRoomTrust(me, G, X, KX, null, seenAt)
  fastForward = false
  assert.equal(x.trust, 'pinned', 'taken, not refused on a copy that could not hold them')
  assert.equal(count(H, `/groups/${G}`), 2, 'one read')
  assert.ok(clock >= seenAt + 9_000, 'and not before the window closed')

  // Every other row that arrived before that read is settled by it: no more reads.
  const outsider = await J.resolveRoomTrust(me, G, 99, key(13), null, seenAt)
  assert.equal(outsider.trust, 'unpinned')
  const underAnotherKey = await J.resolveRoomTrust(me, G, A, key(14), null, seenAt)
  assert.equal(underAnotherKey.trust, 'forged')
  assert.equal(count(H, `/groups/${G}`), 2)
})

await check('a room roster that cannot be read leaves the row unjudged (retry), never accepted', async () => {
  const H = 'e.example'
  const me = ident(504, H)
  routes.set(`${H}/groups/8`, () => json(503, {}))
  assert.equal(await J.resolveRoomTrust(me, 8, 70, key(15), null, clock), 'retry')
})

// ── v=2: the device list ──────────────────────────────────────────────────

const IK = Buffer.alloc(33, 5)
IK[0] = 5
const ikB64 = IK.toString('base64')

await check('a closed island\'s anonymous 404 is asked again with the session token, not read as "nobody"', async () => {
  const H = 'closed.example'
  const me = ident(505, H)
  const P = 80
  routes.set(`${H}/server/info`, () => json(200, OPEN_CAPS))
  routes.set(`${H}/keys/${P}/devices`, ({ authed }) =>
    authed ? json(200, { uin: P, devices: [{ device_id: 1, signal_identity_key: ikB64 }] }) : json(404, { detail: 'no such user' }))
  assert.equal(await J.verifyV2Identity(me, P, 1, new Uint8Array(IK)), 'verified')
  const reads = calls.filter((c) => c.host === H && c.path === `/keys/${P}/devices`)
  assert.deepEqual(reads.map((c) => c.authed), [false, true])

  // An open island answers the anonymous read, and nothing is asked twice.
  const O = 'open.example'
  const me2 = ident(506, O)
  routes.set(`${O}/server/info`, () => json(200, OPEN_CAPS))
  routes.set(`${O}/keys/${P}/devices`, ({ authed }) =>
    json(200, { uin: P, devices: authed ? [] : [{ device_id: 1, signal_identity_key: ikB64 }] }))
  assert.equal(await J.verifyV2Identity(me2, P, 1, new Uint8Array(IK)), 'verified')
  assert.deepEqual(calls.filter((c) => c.host === O && c.path === `/keys/${P}/devices`).map((c) => c.authed), [false])

  // "No such user" under the token is an answer: nobody is published there.
  const N = 81
  routes.set(`${H}/keys/${N}/devices`, () => json(404, { detail: 'no such user' }))
  assert.equal(await J.verifyV2Identity(me, N, 1, new Uint8Array(IK)), 'mismatch')
})

await check('a remembered v=2 identity whose device the island no longer lists (revoked) is not taken', async () => {
  const H = 'f.example'
  const me = ident(507, H)
  const P = 90
  let devices = [
    { device_id: 1, signal_identity_key: key(20) },
    { device_id: 2, signal_identity_key: ikB64 },
  ]
  let down = false
  routes.set(`${H}/server/info`, () => json(200, OPEN_CAPS))
  routes.set(`${H}/keys/${P}/devices`, () => (down ? json(503, {}) : json(200, { uin: P, devices })))
  assert.equal(await J.verifyV2Identity(me, P, 2, new Uint8Array(IK)), 'verified', 'first sight, listed: remembered')
  // Still listed: the memory answers, off the cached list.
  clock += 60_000
  assert.equal(await J.verifyV2Identity(me, P, 2, new Uint8Array(IK)), 'verified')
  // The owner revokes device 2 (a stolen phone).
  devices = [{ device_id: 1, signal_identity_key: key(20) }]
  clock += 11 * 60_000
  assert.equal(await J.verifyV2Identity(me, P, 2, new Uint8Array(IK)), 'mismatch')
  // An island that cannot be asked never flags a remembered peer.
  const Q = 91
  devices = [{ device_id: 1, signal_identity_key: ikB64 }]
  routes.set(`${H}/keys/${Q}/devices`, () => (down ? json(503, {}) : json(200, { uin: Q, devices })))
  assert.equal(await J.verifyV2Identity(me, Q, 1, new Uint8Array(IK)), 'verified')
  clock += 11 * 60_000
  down = true
  assert.equal(await J.verifyV2Identity(me, Q, 1, new Uint8Array(IK)), 'verified')
})

console.log(`sender-judge ok: ${n} checks`)
process.exit(0)

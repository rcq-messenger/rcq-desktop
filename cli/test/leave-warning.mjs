// The console's leave check (spec 2026-09-15, 12.1 Leaving), offline.
//
// D8 says that whoever leaves a room where every OTHER member is a guest copy
// or an unclaimed seat takes the room with them: the island deletes it for
// everyone (8.1). The apps have asked before doing that since the spec landed.
// `rcq leave` and `/leave` used to take themselves off the roster the moment
// they were typed, with no roster read and no question, and a room on another
// island is exactly the case the rule is written for.
//
// The RULE is pure and is proven next door (leaveWarningVerdict /
// leaveWarnAfterFetch, cli/test/guest-path.mjs, "E4"/"F7"). Nothing here
// re-tests it. What this file pins down is the console's WIRING around it in
// cli/src/groups.ts, which is where a second, quietly different rule would
// grow:
//   * a roster that is already the whole room decides with NO request at all;
//   * a list row carries no members (the list is fetched `?members=0`), so an
//     `unknown` verdict spends exactly ONE re-fetch and decides on that;
//   * a room on our OWN island that still cannot be read keeps the plain
//     confirm, and one on ANOTHER island warns rather than walking out in
//     silence;
//   * the uin compared against the roster is our number THERE, never the home
//     one, or every guest mark in a foreign room is misread.
//
// ⚠ No island is touched. The foreign paths here resolve to a dangling alias
// or to a roster already in hand, both of which return before `foreignGroupCtx`
// reaches the trust gate (which would dial a real host).
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// BEFORE the import: cli/src/state.ts memoises its directory on first use, and
// i18n's tr() reads a language file out of it. Pointed at a throwaway dir so a
// test run writes nothing into the real ~/.config/rcq.
process.env.RCQ_CLI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rcq-leave-'))

// The bundle's modules read localStorage lazily (visited islands, the alias
// table); the console has none of its own here.
const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => void mem.set(k, String(v)),
  removeItem: (k) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size
  },
}

const { aliasFor, leaveWarning } = await import('../dist/leave.mjs')

let n = 0
const check = async (label, fn) => {
  await fn()
  n++
  console.log('  ok  ' + label)
}

const HOME = 'home.example'
const AWAY = 'isl.example'
const identity = {
  uin: 4242,
  jwt: 'home-token',
  apiBase: `https://${HOME}`,
  identityPriv: new Uint8Array(32).fill(3),
  identityPub: new Uint8Array(32).fill(9),
  signingPriv: new Uint8Array(32).fill(5),
  signingPub: new Uint8Array(32).fill(7),
}

/// Every request this file's subject could make, recorded and answered here.
/// `handler` returns the roster body, or an Error to refuse like a dead island.
let calls = []
let handler = () => new Error('no island in this test')
globalThis.fetch = async (url) => {
  calls.push(new URL(url).pathname)
  const out = handler()
  if (out instanceof Error) throw out
  return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
const arrange = (h = () => new Error('no island in this test')) => {
  calls = []
  handler = h
}

// A room whose roster is in hand and complete: `member_count` matches the rows.
const room = (id, members) => ({ id, name: `room-${id}`, members, member_count: members.length })

await check('a roster already in hand decides with no request at all', async () => {
  // Every other member is a guest, so leaving deletes the room: the warning.
  arrange()
  const last = await leaveWarning(identity, room(21, [{ uin: 4242 }, { uin: 5, guest: true }]))
  assert.equal(last.warn, true)
  assert.equal(last.host, HOME, 'a local room names our own island')
  assert.deepEqual(calls, [], 'the room was already known: nothing to ask')

  // One other resident stays behind, so the room survives and nothing is said.
  arrange()
  const plain = await leaveWarning(identity, room(21, [{ uin: 4242 }, { uin: 5 }, { uin: 6, guest: true }]))
  assert.equal(plain.warn, false)
  assert.deepEqual(calls, [])
})

await check('a list row carries no members, so it spends exactly one re-fetch', async () => {
  // This is the shape that made the check necessary: `rcq leave 30` reads the
  // room off the warm snapshot, where the list was fetched `?members=0`.
  arrange(() => ({
    id: 30,
    name: 'room-30',
    members: [{ uin: 4242 }, { uin: 5, guest: true }, { uin: 6, invited: true }],
    member_count: 3,
  }))
  const got = await leaveWarning(identity, { id: 30, name: 'room-30', members: [], member_count: 3 })
  assert.equal(got.warn, true, 'the fetched roster says we are the last resident')
  assert.deepEqual(calls, ['/groups/30'], 'one read of the room, and only one')
})

await check('a short page is not the room: it re-reads rather than answer off half of it', async () => {
  // F7: our own row is on the page, but the room has nine people and the rest
  // could be residents. Answering "everyone else is a guest" here would delete
  // the room without a word.
  arrange(() => ({
    id: 31,
    name: 'room-31',
    members: [{ uin: 4242 }, { uin: 5 }, { uin: 6, guest: true }],
    member_count: 3,
  }))
  const got = await leaveWarning(identity, {
    id: 31,
    name: 'room-31',
    members: [{ uin: 4242 }, { uin: 5, guest: true }],
    member_count: 9,
  })
  assert.deepEqual(calls, ['/groups/31'], 'the page was shorter than the room, so it asked')
  assert.equal(got.warn, false, 'the whole roster has another resident in it')
})

await check('our own island, still unreadable: the plain confirm stands', async () => {
  // E4's third answer. On our own island the room's members are ours to lose,
  // and this is how the console behaved before the rule existed.
  arrange(() => new Error('island down'))
  const got = await leaveWarning(identity, { id: 32, name: 'room-32', members: [], member_count: 4 })
  assert.equal(got.warn, false)
  assert.equal(got.host, HOME)
  assert.deepEqual(calls, ['/groups/32'], 'it spent its one fetch before deciding')
})

await check('another island, unreadable: it warns instead of walking out in silence', async () => {
  // A negative id is a room on another island. With no alias stored the lookup
  // throws immediately, BEFORE the trust gate would dial anybody, and an
  // unread foreign room is precisely the case the rule exists for.
  arrange()
  const got = await leaveWarning(identity, { id: -9999, name: 'gone', members: [], member_count: 0 })
  assert.equal(got.warn, true)
  assert.deepEqual(calls, [], 'no island was contacted to find that out')
})

await check('a foreign room reads its guest marks under our number THERE', async () => {
  // The roster of a room on another island, its owner field and its guest
  // marks all speak in that island's uins; ours there is the guest copy's.
  // Comparing the home number against those rows finds no row of ours at all,
  // which reads as "a partial page" and would ask the island on every leave.
  //
  // ⚠ Seeded by hand: the only production writers of this row (ensureGuestOn,
  // refreshGuestAuth) register against a live island. The shape is
  // visited-islands.ts's VisitedIsland, and the key is unscoped because no
  // account scope is set in this process.
  const GUEST_UIN = 777001
  localStorage.setItem(
    'rcq.web.visited.v1',
    JSON.stringify([{ host: AWAY, uin: GUEST_UIN, jwt: '', addedAt: 0 }]),
  )
  const alias = aliasFor(AWAY, 41)
  assert.ok(alias < 0, 'a foreign room is a negative id')

  // Us (the guest copy) plus one member who lives there: the room survives.
  arrange()
  const plain = await leaveWarning(identity, {
    ...room(alias, [{ uin: GUEST_UIN, guest: true }, { uin: 5 }]),
    host: AWAY,
  })
  assert.equal(plain.warn, false, 'a guest leaving strands nobody')
  assert.equal(plain.host, AWAY, 'the sentence names the room\'s island, not ours')
  assert.deepEqual(calls, [], 'the roster was whole, so no island was touched')

  // The other way round: our copy is the only member who lives there and the
  // rest are guests, so leaving deletes the room.
  //
  // ⚠ What makes this case discriminate is the request count, not the verdict.
  // A client comparing the HOME number against these rows finds no row of ours
  // at all, reads that as a half-page, and spends a fetch before giving up at
  // `unknown` (which on a foreign room also warns). Only a client that found
  // us under our number THERE can answer from the roster in hand.
  arrange()
  const resident = await leaveWarning(identity, {
    ...room(alias, [{ uin: GUEST_UIN }, { uin: 5, guest: true }]),
    host: AWAY,
  })
  assert.equal(resident.warn, true, 'as the only member living there, leaving deletes the room')
  assert.equal(resident.host, AWAY)
  assert.deepEqual(calls, [], 'still decided from the roster in hand')
})

fs.rmSync(process.env.RCQ_CLI_HOME, { recursive: true, force: true })
console.log(`leave-warning: ok (${n} checks)`)

// The cross-island consent gate and what a proven UIN move carries, offline.
//
// Why these get a test of their own:
//   * #985(1): the gate held EVERY kind from an unaccepted sender, so control
//     traffic from co-members on a group's island became empty requests. Only
//     content may be held; everything else is dropped, never applied.
//   * v=1 seals do not sign `from`/`from_host`. A sender counts as the pinned
//     contact only when the verified key IS the pinned key, and a mismatch has
//     to come back flagged so it can be shown, never merged.
//   * #986(a): a move copies `rcq.web.<old>.*` to `rcq.web.<new>.*` without
//     overwriting, and re-files sender-key chains, or rooms on other islands
//     go dark after the reload.
// Everything here is production code from src/lib/crossisland-gate.ts and
// src/lib/move-carry.ts.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'
import {
  CONTENT_KINDS,
  FOREIGN_ROOM_DROP,
  carbonIsOwn,
  copyScopedKeys,
  crossIslandGateVerdict,
  foreignRoomBroadcastDropped,
  isContentKind,
  rekeySenderKeyMaps,
  sameSigningKey,
} from '../dist/crossisland-gate.mjs'

let n = 0
const check = (label, fn) => {
  fn()
  n++
  console.log('  ok  ' + label)
}

// Bytes chosen so standard base64 carries '+' and '/', and url-safe differs.
const raw = Buffer.from(Array.from({ length: 32 }, (_, i) => (i % 2 ? 0xfb : 0xff)))
const K = raw.toString('base64')
const K_URL = raw.toString('base64url')
const OTHER = Buffer.alloc(32, 7).toString('base64')

check('same key matches across padding and alphabet', () => {
  assert.ok(K.includes('+') || K.includes('/'))
  assert.equal(sameSigningKey(K, K), true)
  assert.equal(sameSigningKey(K, K.replace(/=+$/, '')), true)
  assert.equal(sameSigningKey(K, K_URL), true)
})

check('anything missing or malformed is NOT the same key', () => {
  assert.equal(sameSigningKey(K, OTHER), false)
  assert.equal(sameSigningKey(K, undefined), false)
  assert.equal(sameSigningKey(undefined, undefined), false)
  assert.equal(sameSigningKey('', ''), false)
  assert.equal(sameSigningKey(K, '!!not base64!!'), false)
  assert.equal(sameSigningKey(K, K.slice(0, 20)), false)
})

check('content kinds are exactly the quarantine set, poll included', () => {
  assert.deepEqual([...CONTENT_KINDS].sort(), ['file', 'location', 'photo', 'poll', 'text', 'video', 'voice'])
  assert.equal(isContentKind('visit'), false)
  assert.equal(isContentKind(undefined), false)
  assert.equal(isContentKind({}), false)
})

check('pinned contact under the pinned key: every kind is delivered', () => {
  for (const kind of ['text', 'visit', 'delete', 'edit', 'secscreen', 'reaction']) {
    assert.deepEqual(crossIslandGateVerdict(kind, K, K_URL), { action: 'deliver', keyMismatch: false })
  }
})

check('unaccepted sender: content is held, control is dropped (#985(1))', () => {
  for (const kind of CONTENT_KINDS) {
    assert.deepEqual(crossIslandGateVerdict(kind, null, K), { action: 'hold', keyMismatch: false })
  }
  for (const kind of ['visit', 'delete', 'edit', 'secscreen', 'reaction', 'read', 'delivered', '', 'future-kind']) {
    assert.deepEqual(crossIslandGateVerdict(kind, null, K), { action: 'drop', keyMismatch: false })
  }
  assert.deepEqual(crossIslandGateVerdict(42, undefined, K), { action: 'drop', keyMismatch: false })
})

check('pinned address under ANOTHER key: a stranger, flagged', () => {
  assert.deepEqual(crossIslandGateVerdict('text', K, OTHER), { action: 'hold', keyMismatch: true })
  assert.deepEqual(crossIslandGateVerdict('delete', K, OTHER), { action: 'drop', keyMismatch: true })
  // No verified key at all is not a match either.
  assert.deepEqual(crossIslandGateVerdict('text', K, undefined), { action: 'hold', keyMismatch: true })
  // An empty pinned key is no pin.
  assert.deepEqual(crossIslandGateVerdict('text', '', K), { action: 'hold', keyMismatch: false })
})

check('a carbon is ours only when nothing in it says otherwise', () => {
  const HOME = 'a.example'
  // v=1 carbon from another of our devices: own number, own island, own key.
  assert.equal(carbonIsOwn(12, 12, HOME, HOME, K_URL, K, false), true)
  // v=2: no host, no key named; libsignal authenticated it.
  assert.equal(carbonIsOwn(12, 12, undefined, HOME, undefined, K, false), true)
  // Somebody else's number is never a carbon of ours.
  assert.equal(carbonIsOwn(13, 12, HOME, HOME, K, K, false), false)
})

check('a forged carbon is dropped: foreign host, foreign key, or out of a broadcast', () => {
  const HOME = 'a.example'
  // `from` = our number, sealed under Mallory's key: the ciack pin forgery.
  assert.equal(carbonIsOwn(12, 12, HOME, HOME, OTHER, K, false), false)
  assert.equal(carbonIsOwn(12, 12, 'b.example', HOME, OTHER, K, false), false)
  // Stamped with another island, even under our own key.
  assert.equal(carbonIsOwn(12, 12, 'b.example', HOME, K, K, false), false)
  // A key that is named but empty is not our key.
  assert.equal(carbonIsOwn(12, 12, HOME, HOME, '', K, false), false)
  // No identity to compare against, and a key was named.
  assert.equal(carbonIsOwn(12, 12, HOME, HOME, K, null, false), false)
  // Re-attributed out of a sender-key broadcast.
  assert.equal(carbonIsOwn(12, 12, undefined, HOME, undefined, K, true), false)
})

check('a broadcast from a room on another island never reaches a home-namespace branch', () => {
  assert.deepEqual(
    [...FOREIGN_ROOM_DROP].sort(),
    ['call', 'carbon', 'contactreq', 'gskey', 'gsknack', 'homerec', 'pkey', 'pkeyask', 'profile', 'skdm', 'sknack'],
  )
  for (const kind of FOREIGN_ROOM_DROP) assert.equal(foreignRoomBroadcastDropped(kind), true)
  assert.equal(foreignRoomBroadcastDropped(undefined), true)
  assert.equal(foreignRoomBroadcastDropped(7), true)
  // Group content and group control still reach the room.
  for (const kind of [...CONTENT_KINDS, 'edit', 'delete', 'reaction']) {
    assert.equal(foreignRoomBroadcastDropped(kind), false)
  }
})

class MemStore {
  constructor(entries) {
    this.m = new Map(Object.entries(entries))
  }
  get length() {
    return this.m.size
  }
  key(i) {
    return [...this.m.keys()][i] ?? null
  }
  getItem(k) {
    return this.m.has(k) ? this.m.get(k) : null
  }
  setItem(k, v) {
    this.m.set(k, String(v))
  }
}

check('move copies scoped keys, never overwrites, leaves the rest alone', () => {
  const s = new MemStore({
    'rcq.web.12.visited.v1': '[{"host":"b.example"}]',
    'rcq.web.12.fgroup-alias.v1': '[{"aliasId":-1000}]',
    'rcq.web.12.crossisland.v1': 'old',
    'rcq.web.99.crossisland.v1': 'already here',
    'rcq.web.123.visited.v1': 'another account',
    'rcq.web.senderkeys.v3': 'shared',
    'rcq.web.unread.12': 'other shape',
  })
  assert.equal(copyScopedKeys(s, 12, 99), 2)
  assert.equal(s.getItem('rcq.web.99.visited.v1'), '[{"host":"b.example"}]')
  assert.equal(s.getItem('rcq.web.99.fgroup-alias.v1'), '[{"aliasId":-1000}]')
  assert.equal(s.getItem('rcq.web.99.crossisland.v1'), 'already here')
  // Copy, not move.
  assert.equal(s.getItem('rcq.web.12.visited.v1'), '[{"host":"b.example"}]')
  // `rcq.web.12.` is not a prefix of `rcq.web.123.`.
  assert.equal(s.getItem('rcq.web.993.visited.v1'), null)
  assert.equal(s.length, 9)
  // Idempotent.
  assert.equal(copyScopedKeys(s, 12, 99), 0)
})

check('move copy refuses a non-move', () => {
  const s = new MemStore({ 'rcq.web.12.visited.v1': 'x' })
  assert.equal(copyScopedKeys(s, 12, 12), 0)
  assert.equal(copyScopedKeys(s, 0, 99), 0)
  assert.equal(copyScopedKeys(s, 12, Number.NaN), 0)
  assert.equal(s.length, 1)
})

check('inbound chains move to the new number, target wins; own outbound chains are dropped', () => {
  const store = {
    out: { '12:5': 'own-old', '123:5': 'someone else', '99:6': 'own-new' },
    in: { '12:kidA': 'a', '12:kidC': 'c-old', '99:kidC': 'c-new', '123:kidB': 'b' },
    owned: ['12:k1', '99:k1', '123:k2', '12:k3'],
  }
  const next = rekeySenderKeyMaps(store, 12, 99)
  // Members bound the old kid to #12: carried, the next post would be shown
  // as written by the number we gave back. Dropped, it rotates as #99.
  assert.deepEqual(next.out, { '123:5': 'someone else', '99:6': 'own-new' })
  assert.equal('99:5' in next.out, false)
  assert.deepEqual(next.in, { '99:kidC': 'c-new', '123:kidB': 'b', '99:kidA': 'a' })
  assert.deepEqual(next.owned, ['99:k1', '123:k2', '99:k3'])
  // Nothing is left under the old number.
  for (const k of [...Object.keys(next.out), ...Object.keys(next.in), ...next.owned]) {
    assert.equal(k.startsWith('12:'), false)
  }
  // A non-move is a no-op.
  assert.equal(rekeySenderKeyMaps(store, 12, 12), store)
})

console.log(`crossisland-gate: ok (${n} checks)`)

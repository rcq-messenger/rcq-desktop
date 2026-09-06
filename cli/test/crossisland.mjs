// The cross-island contact merge, on its own.
//
// Why this one gets a test of its own: `crossisland-store` is the ONLY record
// that a peer on another island exists. There is no server list to re-fetch,
// so a merge that drops a row loses a contact for good, and a merge that
// re-pins a peer's keys is an impersonation path. Everything here is
// production code from src/lib/crossisland-vault.ts.
//
// The properties that matter, and why:
//   * union, not either-side-wins, or the desktop's contacts erase the phone's.
//   * commutative and idempotent, or two devices converge on different lists
//     depending on which one synced first.
//   * keys come from the EARLIER row, always, or a second device can re-pin a
//     peer to a swapped key card.
//   * display fields come from the newer `profileTs`, or a stale device
//     un-renames a peer on every sync.
//   * a tombstone kills a row it is newer than, and loses to one added after
//     it, or removals undo themselves / re-adding is impossible.
//   * tombstones expire, or the slot grows forever.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'
import { mergeCrossIsland, canonState } from '../dist/vault.mjs'

const NOW = 1_757_000_000_000 // fixed: the merge takes `now`, so no clock here
const DAY = 24 * 3600 * 1000

let n = 0
const check = (label, fn) => { fn(); n++; console.log('  ok  ' + label) }

function row(uin, host, extra = {}) {
  return {
    uin, host,
    nickname: 'peer' + uin,
    identityKey: 'ident-' + uin,
    signingKey: 'sign-' + uin,
    signalIdentityKey: null,
    addedAt: NOW - DAY,
    ...extra,
  }
}
const state = (rows = [], graves = {}) => ({
  v: 1,
  c: Object.fromEntries(rows.map((r) => [`${r.uin}@${r.host}`, r])),
  g: graves,
})
const keys = (s) => Object.keys(s.c).sort()
const json = (s) => JSON.stringify(s, Object.keys(s).sort())

console.log('crossisland merge')

check('a row known to one device only survives, from either side', () => {
  const mine = state([row(101, 'is2.rcq.app')])
  const theirs = state([row(202, 'rcqam.mooo.com')])
  assert.deepEqual(keys(mergeCrossIsland(mine, theirs, NOW)), ['101@is2.rcq.app', '202@rcqam.mooo.com'])
  assert.deepEqual(keys(mergeCrossIsland(theirs, mine, NOW)), ['101@is2.rcq.app', '202@rcqam.mooo.com'])
})

check('commutative and idempotent', () => {
  const a = state([row(1, 'a.example', { addedAt: NOW - 5 * DAY }), row(2, 'b.example')])
  const b = state([row(2, 'b.example', { profileTs: Math.floor(NOW / 1000), nickname: 'renamed' }), row(3, 'c.example')])
  const ab = mergeCrossIsland(a, b, NOW)
  const ba = mergeCrossIsland(b, a, NOW)
  assert.equal(json(ab), json(ba))
  assert.equal(json(mergeCrossIsland(ab, ab, NOW)), json(ab))
  assert.equal(json(mergeCrossIsland(ab, a, NOW)), json(ab))
})

check('the pinned keys come from the EARLIER row, never the newer one', () => {
  const first = row(7, 'x.example', { addedAt: NOW - 30 * DAY, identityKey: 'REAL', signingKey: 'REAL-S' })
  const later = row(7, 'x.example', { addedAt: NOW - DAY, identityKey: 'SWAPPED', signingKey: 'SWAPPED-S' })
  for (const out of [mergeCrossIsland(state([first]), state([later]), NOW), mergeCrossIsland(state([later]), state([first]), NOW)]) {
    const r = out.c['7@x.example']
    assert.equal(r.identityKey, 'REAL')
    assert.equal(r.signingKey, 'REAL-S')
    assert.equal(r.addedAt, first.addedAt)
  }
})

check('the newer profile wins the display, without touching the keys', () => {
  const old = row(9, 'x.example', { addedAt: NOW - 30 * DAY, nickname: 'old name', profileTs: 1000 })
  const fresh = row(9, 'x.example', { addedAt: NOW - DAY, nickname: 'new name', profileTs: 2000, identityKey: 'SWAPPED' })
  for (const out of [mergeCrossIsland(state([old]), state([fresh]), NOW), mergeCrossIsland(state([fresh]), state([old]), NOW)]) {
    const r = out.c['9@x.example']
    assert.equal(r.nickname, 'new name')
    assert.equal(r.identityKey, 'ident-9', 'display merge must not carry the key across')
  }
})

check('an avatar id without its key is dropped, both halves or neither', () => {
  const a = row(11, 'x.example', { profileTs: 2000, avatarMediaId: 'blob', avatarMediaKey: null })
  const out = mergeCrossIsland(state([a]), state([]), NOW)
  assert.equal(out.c['11@x.example'].avatarMediaId, null)
  assert.equal(out.c['11@x.example'].avatarMediaKey, null)
})

check('a tombstone removes the row on the other device', () => {
  const kept = state([row(21, 'x.example', { addedAt: NOW - 10 * DAY })])
  const buried = state([], { '21@x.example': NOW - DAY })
  assert.deepEqual(keys(mergeCrossIsland(kept, buried, NOW)), [])
  assert.deepEqual(keys(mergeCrossIsland(buried, kept, NOW)), [])
})

check('re-adding after a removal wins, and clears the tombstone', () => {
  const readded = state([row(22, 'x.example', { addedAt: NOW - 3600_000 })])
  const buried = state([], { '22@x.example': NOW - DAY })
  const out = mergeCrossIsland(readded, buried, NOW)
  assert.deepEqual(keys(out), ['22@x.example'])
  assert.equal(out.g['22@x.example'], undefined, 'a spent tombstone must not linger and re-kill the row')
  assert.deepEqual(keys(mergeCrossIsland(out, out, NOW)), ['22@x.example'])
})

check('tombstones expire after 90 days', () => {
  const buried = state([], { '23@x.example': NOW - 100 * DAY, '24@x.example': NOW - 10 * DAY })
  const out = mergeCrossIsland(buried, state([]), NOW)
  assert.equal(out.g['23@x.example'], undefined)
  assert.equal(out.g['24@x.example'], NOW - 10 * DAY)
})

check('a row missing its keys is dropped, not carried as a half-contact', () => {
  const broken = { uin: 31, host: 'x.example', nickname: 'x', addedAt: NOW }
  const out = mergeCrossIsland(state([broken]), state([]), NOW)
  assert.deepEqual(keys(out), [])
})

check('the same peer on two islands is two contacts', () => {
  const out = mergeCrossIsland(state([row(5, 'a.example')]), state([row(5, 'b.example')]), NOW)
  assert.deepEqual(keys(out), ['5@a.example', '5@b.example'])
})

check('an empty slot never erases the device', () => {
  const mine = state([row(41, 'x.example'), row(42, 'y.example')])
  assert.deepEqual(keys(mergeCrossIsland(mine, state([]), NOW)), ['41@x.example', '42@y.example'])
})

// ── the shape three clients have to agree on ────────────────────────────────

check('the canonical row omits empty optionals and always carries profileTs', () => {
  const c = canonState(state([row(51, 'x.example', { gender: null, statusMessage: '', avatarMediaId: 'b', avatarMediaKey: null })]))
  const r = c.c['51@x.example']
  assert.equal('gender' in r, false, "gson omits nulls; writing them would look like a difference to Android")
  assert.equal('statusMessage' in r, false)
  assert.equal('avatarMediaId' in r, false, 'half a pair is not written at all')
  assert.equal(r.profileTs, 0, 'Android has a primitive Long here and always writes it')
})

check('key order and absent-vs-null do not read as a difference', () => {
  // What an Android write looks like coming back: no null fields, keys in
  // gson's declaration order rather than ours.
  const androidish = {
    v: 1,
    g: {},
    c: {
      '52@x.example': {
        signingKey: 'sign-52', identityKey: 'ident-52', host: 'x.example', uin: 52,
        profileTs: 0, addedAt: NOW - DAY, nickname: 'peer52',
      },
    },
  }
  const mine = state([row(52, 'x.example')])
  assert.equal(
    JSON.stringify(canonState(mine)),
    JSON.stringify(canonState(androidish)),
    'the two clients would rewrite the slot at each other forever',
  )
})

check('the canonical form is stable under merge', () => {
  const a = state([row(61, 'x.example'), row(62, 'y.example')])
  const once = canonState(mergeCrossIsland(a, state([]), NOW))
  const twice = canonState(mergeCrossIsland(mergeCrossIsland(a, state([]), NOW), state([]), NOW))
  assert.equal(JSON.stringify(once), JSON.stringify(twice))
})

console.log(`crossisland: ${n}/${n} ok`)

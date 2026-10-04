// Blocking a sender on another island, offline (reports 1064, 1065).
//
// Why this gets a test of its own:
//   * The gate that decides whether a cross-island message reaches the chat
//     never asked the block list: an accepted contact under the pinned key was
//     delivered blocked or not. A block now holds the address AND the keys it
//     was made against, and a sender is blocked when either matches, so the
//     same person writing from their backup island is still blocked.
//   * Nothing could lift a block made from a request, and a block that came
//     from another device was forever. Every decision now carries its time and
//     travels as a `ciack`; a late carbon (the echo of an older block, drained
//     after the unblock) must lose to the newer decision instead of undoing it.
//   * A request under a contact's address with another key is blocked by that
//     key only: blocking the address would cut off the contact it impersonated.
// Everything here is production code from src/lib/crossisland-block-rules.ts,
// imported from the BUILT bundle.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'
import {
  MAX_TOMBSTONES,
  ackDecisionAt,
  ackKeys,
  activeBlocks,
  addressBlocked,
  blockingEntries,
  crossIslandGateVerdict,
  decideBlock,
  normalizeBlocks,
  senderBlocked,
} from '../dist/crossisland-block.mjs'

let n = 0
const check = (label, fn) => {
  fn()
  n++
  console.log('  ok  ' + label)
}

const b64 = (u8) => Buffer.from(u8).toString('base64')
const keyOf = (fill) => b64(new Uint8Array(32).fill(fill))
const urlSafe = (s) => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const K = keyOf(7) // the contact's key
const IMPOSTOR = keyOf(9)
const OTHER = keyOf(11)
const noPins = () => null

console.log('cross-island blocks')

check('the old shape on disk reads as blocks made before decisions were stamped', () => {
  const m = normalizeBlocks({ '134@is2.example': true, '7@': true, 'garbage': true, '0@x': true, '5@y': 'yes' })
  assert.deepEqual(m, { '134@is2.example': { on: true, at: 0 }, '7@': { on: true, at: 0 } })
  assert.equal(addressBlocked(m, 134, 'is2.example'), true)
  assert.equal(addressBlocked(m, 134, 'IS2.example'), true)
  assert.equal(addressBlocked(m, 134, 'api.example'), false)
  // Anything that is not an object of the right shape is no map at all.
  assert.deepEqual(normalizeBlocks(null), {})
  assert.deepEqual(normalizeBlocks([true]), {})
})

check('a key-only entry with no key blocks nothing, and is not read as an address block', () => {
  const m = normalizeBlocks({ '134@a.example': { on: true, at: 5, keyOnly: true, keys: [] } })
  assert.deepEqual(m, {})
  assert.equal(decideBlock({}, 134, 'a.example', { on: true, at: 5, keyOnly: true, keys: [] }), null)
})

check('a blocked address blocks whatever key it writes under', () => {
  const m = decideBlock({}, 134, 'a.example', { on: true, at: 10, keys: [K] })
  assert.equal(senderBlocked(m, 134, 'a.example', OTHER, noPins), true)
  assert.equal(senderBlocked(m, 134, 'a.example', null, noPins), true)
  assert.equal(senderBlocked(m, 135, 'a.example', OTHER, noPins), false)
})

check('the block follows the key to the same person on another island', () => {
  const m = decideBlock({}, 134, 'a.example', { on: true, at: 10, keys: [K] })
  // Their backup island, under another number, sealed by the same key, in
  // another base64 spelling.
  assert.equal(senderBlocked(m, 9001, 'b.example', urlSafe(K), noPins), true)
  // The same digits on another island, another key: somebody else.
  assert.equal(senderBlocked(m, 134, 'b.example', OTHER, noPins), false)
  // No proven key: only the address can match.
  assert.equal(senderBlocked(m, 9001, 'b.example', undefined, noPins), false)
})

check('a block made before keys were kept follows the key pinned at that address', () => {
  const m = normalizeBlocks({ '134@a.example': true })
  const pins = (uin, host) => (uin === 134 && host === 'a.example' ? K : null)
  assert.equal(senderBlocked(m, 9001, 'b.example', K, pins), true)
  assert.equal(senderBlocked(m, 9001, 'b.example', OTHER, pins), false)
  // A same-island stranger's entry (host '') has no pinned key to follow.
  const s = normalizeBlocks({ '9001@': true })
  assert.equal(senderBlocked(s, 9001, 'b.example', K, () => K), false)
})

check('a key-only block stops the impostor, never the contact whose address it used', () => {
  const m = decideBlock({}, 134, 'a.example', { on: true, at: 10, keys: [IMPOSTOR], keyOnly: true })
  assert.equal(addressBlocked(m, 134, 'a.example'), false)
  assert.equal(senderBlocked(m, 134, 'a.example', K, () => K), false)
  assert.equal(senderBlocked(m, 134, 'a.example', IMPOSTOR, () => K), true)
  assert.equal(senderBlocked(m, 55, 'c.example', IMPOSTOR, noPins), true)
  // ...and the contact's pinned key at that address does not drag the
  // contact in through the pinned-key rule either.
  assert.equal(senderBlocked(m, 9001, 'b.example', K, () => K), false)
})

check('a later address block widens a key-only one; a key-only one never narrows an address block', () => {
  let m = decideBlock({}, 134, 'a.example', { on: true, at: 10, keys: [IMPOSTOR], keyOnly: true })
  m = decideBlock(m, 134, 'a.example', { on: true, at: 20, keys: [K] })
  assert.equal(addressBlocked(m, 134, 'a.example'), true)
  assert.deepEqual(m['134@a.example'].keys, [IMPOSTOR, K])
  const n2 = decideBlock(m, 134, 'a.example', { on: true, at: 30, keys: [OTHER], keyOnly: true })
  assert.equal(addressBlocked(n2, 134, 'a.example'), true)
  assert.equal(n2['134@a.example'].keyOnly, undefined)
})

check('the newer decision wins: a late echo of an older block does not undo an unblock', () => {
  let m = decideBlock({}, 134, 'a.example', { on: true, at: 100, keys: [K] })
  m = decideBlock(m, 134, 'a.example', { on: false, at: 200 })
  assert.equal(senderBlocked(m, 134, 'a.example', K, noPins), false)
  // The carbon of the block, re-served after the unblock.
  assert.equal(decideBlock(m, 134, 'a.example', { on: true, at: 100, keys: [K] }), null)
  // An unblock that arrives BEFORE its own older block still leaves a
  // tombstone the block then loses to.
  const t = decideBlock({}, 134, 'a.example', { on: false, at: 200 })
  assert.deepEqual(t, { '134@a.example': { on: false, at: 200 } })
  assert.equal(decideBlock(t, 134, 'a.example', { on: true, at: 150 }), null)
  // A newer block after the unblock blocks again.
  const again = decideBlock(m, 134, 'a.example', { on: true, at: 300 })
  assert.equal(addressBlocked(again, 134, 'a.example'), true)
  // A lifted block does not hand its old keys to the next one.
  assert.equal(again['134@a.example'].keys, undefined)
})

check('the same decision twice changes nothing, so its echo does nothing', () => {
  const m = decideBlock({}, 134, 'a.example', { on: true, at: 100, keys: [K] })
  assert.equal(decideBlock(m, 134, 'a.example', { on: true, at: 100, keys: [K] }), null)
  // An unblock of nothing with no time is no decision at all.
  assert.equal(decideBlock({}, 134, 'a.example', { on: false, at: 0 }), null)
})

check('a stamped unblock lifts a block from before decisions were stamped', () => {
  const m = normalizeBlocks({ '134@a.example': true })
  const lifted = decideBlock(m, 134, 'a.example', { on: false, at: 1 })
  assert.equal(addressBlocked(lifted, 134, 'a.example'), false)
})

check('tombstones are capped, oldest first, and never take a block with them', () => {
  let m = decideBlock({}, 1, 'keep.example', { on: true, at: 1 })
  for (let i = 0; i < MAX_TOMBSTONES + 5; i++) m = decideBlock(m, 1000 + i, 'x.example', { on: false, at: 10 + i })
  const dead = Object.values(m).filter((e) => !e.on)
  assert.equal(dead.length, MAX_TOMBSTONES)
  assert.equal(m['1000@x.example'], undefined)
  assert.ok(m[`${1000 + MAX_TOMBSTONES + 4}@x.example`])
  assert.equal(addressBlocked(m, 1, 'keep.example'), true)
})

check('keys are cleaned: no duplicates in another spelling, nothing that is not a key', () => {
  const m = decideBlock({}, 134, 'a.example', { on: true, at: 1, keys: [K, urlSafe(K), '', 42, 'x'.repeat(200)] })
  assert.deepEqual(m['134@a.example'].keys, [K])
  assert.deepEqual(ackKeys([K, K, null]), [K])
  assert.deepEqual(ackKeys('not a list'), [])
})

check('which entries block a sender: the list the unblock lifts', () => {
  let m = decideBlock({}, 134, 'a.example', { on: true, at: 1, keys: [K] })
  m = decideBlock(m, 9001, 'b.example', { on: true, at: 2, keys: [K] })
  m = decideBlock(m, 77, 'c.example', { on: true, at: 3, keys: [OTHER] })
  assert.deepEqual(blockingEntries(m, 134, 'a.example', K, noPins).sort(), ['134@a.example', '9001@b.example'])
  assert.deepEqual(blockingEntries(m, 134, 'a.example', null, noPins), ['134@a.example'])
})

check('the list of blocks is the blocks in force, newest first', () => {
  let m = decideBlock({}, 1, 'a.example', { on: true, at: 5 })
  m = decideBlock(m, 2, '', { on: true, at: 9 })
  m = decideBlock(m, 3, 'c.example', { on: false, at: 12 })
  assert.deepEqual(
    activeBlocks(m).map((b) => [b.uin, b.host]),
    [
      [2, ''],
      [1, 'a.example'],
    ],
  )
})

check('a carbon is dated by its own stamp, never later than its deposit or now', () => {
  assert.equal(ackDecisionAt(500, 900, 1000), 500)
  // A device whose clock runs ahead cannot outrank every later unblock.
  assert.equal(ackDecisionAt(5000, 900, 1000), 900)
  assert.equal(ackDecisionAt(5000, undefined, 1000), 1000)
  // An older sender stamps nothing: the deposit stamp, or now for a live frame.
  assert.equal(ackDecisionAt(undefined, 900, 1000), 900)
  assert.equal(ackDecisionAt(undefined, undefined, 1000), 1000)
  assert.equal(ackDecisionAt('500', 900, 1000), 900)
  // An island stamp from our future (a clock behind the island's) is capped by now.
  assert.equal(ackDecisionAt(undefined, 2000, 1000), 1000)
})

check('the gate drops a blocked contact under its pinned key, every kind', () => {
  const m = decideBlock({}, 134, 'a.example', { on: true, at: 1, keys: [K] })
  const blocked = senderBlocked(m, 134, 'a.example', K, noPins)
  for (const kind of ['text', 'photo', 'reaction', 'delete']) {
    assert.equal(crossIslandGateVerdict(kind, K, K, blocked).action, 'drop')
  }
  assert.equal(crossIslandGateVerdict('text', K, K, false).action, 'deliver')
})

console.log(`${n} checks passed`)

// The sections merge, on its own (founder item 1, 23.08;
// docs/sections-design-2026-08-23.md §2). Everything here is production code
// from src/lib/sections.ts, which is why it can be tested without a browser,
// without an island and without a clock: the merge is a pure function of two
// trees and the whole conflict story lives in it.
//
// The properties that matter, and why:
//   * commutative and idempotent, or two devices converge on different lists
//     depending on which one asked first.
//   * per-FIELD last-writer-wins, or a rename on the phone eats a reorder on
//     the desktop.
//   * a tombstone wins a tie, or a chat the user took out of a section comes
//     back and cannot be got rid of.
//   * unknown keys survive, or this build quietly deletes what a newer one
//     wrote.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'
import {
  addMembers,
  clampName,
  createSection,
  decodeSections,
  deleteSection,
  dropExpired,
  emptyTree,
  encodeSections,
  forgetMember,
  groupKey,
  memberIndex,
  membersOf,
  mergeSections,
  newSectionId,
  orderedSections,
  peerKey,
  removeMemberFrom,
  renameSection,
  sameContent,
  SectionsError,
  setOrder,
  setPinned,
  totalMembers,
  userSections,
  MAX_MEMBERS_PER_SECTION,
  MAX_SECTIONS,
} from '../dist/vault.mjs'

const enc = new TextEncoder()
const json = (t) => JSON.parse(JSON.stringify(t))
const bytes = (t) => enc.encode(JSON.stringify(t))
/// Compare by the merge's own normal form: `merge(x, x)` is the identity, so
/// two trees are "the same" when their idempotent forms match.
const same = (a, b) => assert.deepEqual(json(mergeSections(a, a)), json(mergeSections(b, b)))

function section(id, over = {}) {
  return { id, k: 'u', n: id, o: 1024, t: { n: 1, o: 1 }, m: {}, x: {}, ...over }
}
function tree(...s) {
  return { v: 1, s, d: {}, w: 0 }
}

// ── the member key carries the host ─────────────────────────────────────────
{
  assert.equal(peerKey(1234), 'p:1234')
  assert.equal(peerKey(1234, 'is2.rcq.app'), 'p:1234@is2.rcq.app')
  // ★ Two different people. Keying them the same has already cost us a bug.
  assert.notEqual(peerKey(1234), peerKey(1234, 'is2.rcq.app'))
  assert.equal(peerKey(1234, 'IS2.RCQ.App'), 'p:1234@is2.rcq.app', 'the host is lower-cased')
  assert.equal(groupKey(57), 'g:57')
  assert.equal(groupKey(9, 'is2.rcq.app'), 'g:9@is2.rcq.app')
}

// ── the name clamp counts SCALARS ───────────────────────────────────────────
{
  // 32 characters of which every one is a surrogate pair: 32 scalars, 64
  // UTF-16 units, 128 bytes. Clamping by either of the other two would cut it.
  const flags = '🏴'.repeat(40)
  assert.equal(Array.from(clampName(flags)).length, 32)
  assert.equal(clampName('  Work  '), 'Work')
}

// ── commutative, idempotent ─────────────────────────────────────────────────
{
  const a = tree(section('aa', { n: 'Work', o: 1024, t: { n: 10, o: 10 } }))
  const b = tree(section('bb', { n: 'Home', o: 2048, t: { n: 20, o: 20 } }))
  const ab = mergeSections(a, b)
  const ba = mergeSections(b, a)
  assert.deepEqual(json(ab), json(ba), '★ merge(a, b) must equal merge(b, a)')
  same(mergeSections(ab, ab), ab)
  same(mergeSections(ab, a), ab)
  assert.equal(ab.s.length, 2)
}

// ── per-field last-writer-wins ──────────────────────────────────────────────
{
  // One device renamed it, the other moved it. ★ Both must survive: a whole-
  // record LWW would throw one of them away, and the user would see the phone
  // and the desktop disagree about a list they think is one list.
  const renamed = tree(section('aa', { n: 'Work stuff', o: 1024, t: { n: 30, o: 10 } }))
  const moved = tree(section('aa', { n: 'Work', o: 5120, t: { n: 10, o: 40 } }))
  for (const out of [mergeSections(renamed, moved), mergeSections(moved, renamed)]) {
    assert.equal(out.s[0].n, 'Work stuff')
    assert.equal(out.s[0].o, 5120)
    assert.deepEqual(out.s[0].t, { n: 30, o: 40 })
  }
}

// ── the PIN flag is last-writer-wins too, and it is only a flag ─────────────
{
  const on = setPinned(tree(section('aa')), 'aa', true, 100)
  const off = setPinned(tree(section('aa')), 'aa', false, 200)
  assert.equal(mergeSections(on, off).s[0].p, 0)
  assert.equal(mergeSections(off, on).s[0].p, 0)
  // A built-in with no record at all gets one: this is how today's iOS
  // archive gate propagates to the other clients.
  const arch = setPinned(emptyTree(), 'sys.archive', true, 100)
  assert.equal(arch.s.find((r) => r.id === 'sys.archive').p, 1)
  assert.equal(arch.s.find((r) => r.id === 'sys.archive').k, 'd')
}

// ── membership: add vs tombstone, tombstone wins ties ───────────────────────
{
  const base = tree(section('aa'))
  const added = addMembers(base, 'aa', ['p:770'], 100)
  const removed = removeMemberFrom(added, 'aa', 'p:770', 200)
  // Later removal wins.
  assert.deepEqual(membersOf(mergeSections(added, removed), 'aa'), [])
  assert.deepEqual(membersOf(mergeSections(removed, added), 'aa'), [])
  // Later add wins.
  const readded = addMembers(removed, 'aa', ['p:770'], 300)
  assert.deepEqual(membersOf(mergeSections(removed, readded), 'aa'), ['p:770'])

  // ★ The tie. Two devices, the same millisecond, one adding and one removing:
  // the chat stays OUT. Re-adding it is a tap; a chat that keeps coming back
  // into a section the user emptied is not recoverable by hand.
  const addTie = addMembers(base, 'aa', ['p:99'], 500)
  const delTie = removeMemberFrom(addMembers(base, 'aa', ['p:99'], 400), 'aa', 'p:99', 500)
  assert.deepEqual(membersOf(mergeSections(addTie, delTie), 'aa'), [])
  assert.deepEqual(membersOf(mergeSections(delTie, addTie), 'aa'), [])
}

// ── one chat, two sections, two offline devices ─────────────────────────────
{
  const here = addMembers(tree(section('aa'), section('bb', { o: 2048 })), 'aa', ['p:5'], 100)
  const there = addMembers(tree(section('aa'), section('bb', { o: 2048 })), 'bb', ['p:5'], 200)
  for (const out of [mergeSections(here, there), mergeSections(there, here)]) {
    const idx = memberIndex(out)
    assert.equal(idx.get('p:5'), 'bb', '★ the larger add ts wins the chat')
    assert.deepEqual(membersOf(out, 'aa'), [])
    // ...and the loser keeps a tombstone, so the outcome survives the next
    // merge from either side rather than flapping.
    assert.equal(out.s.find((r) => r.id === 'aa').x['p:5'], 100)
  }
  // Same ts: the smaller id wins, so both devices land on the same answer.
  const tieA = addMembers(tree(section('aa'), section('bb', { o: 2048 })), 'aa', ['p:6'], 300)
  const tieB = addMembers(tree(section('aa'), section('bb', { o: 2048 })), 'bb', ['p:6'], 300)
  assert.equal(memberIndex(mergeSections(tieA, tieB)).get('p:6'), 'aa')
  assert.equal(memberIndex(mergeSections(tieB, tieA)).get('p:6'), 'aa')
}

// ── section tombstones ──────────────────────────────────────────────────────
{
  const live = tree(section('aa', { t: { n: 10, o: 10 } }))
  const gone = deleteSection(live, 'aa', 50)
  assert.equal(mergeSections(live, gone).s.length, 0)
  assert.equal(mergeSections(gone, live).s.length, 0)
  // ★ Touched AFTER the delete: the section comes back, named. Somebody was
  // using it on the other device while this one was throwing it away.
  const renamedAfter = renameSection(live, 'aa', 'Still here', 90)
  assert.equal(mergeSections(gone, renamedAfter).s[0].n, 'Still here')
  assert.equal(mergeSections(renamedAfter, gone).s[0].n, 'Still here')

  // ★★★ FILED into after the delete: also a resurrection, and on purpose. The
  // other device was still using the section; losing that filing to a delete
  // it had never heard about is the worse of the two answers.
  const filedAfter = addMembers(live, 'aa', ['p:5'], 90)
  assert.deepEqual(membersOf(mergeSections(gone, filedAfter), 'aa'), ['p:5'])
  assert.deepEqual(membersOf(mergeSections(filedAfter, gone), 'aa'), ['p:5'])

  // ★★★ EMPTIED after the delete: NOT a resurrection. Unticking a chat in the
  // picker on a device that has not heard about the delete stamps `x` and
  // nothing else, and counting that as "the section was touched" brought a
  // deleted section back, stably, carrying whatever was left in it. Emptying
  // a section is not a reason to keep it.
  const twoMembers = addMembers(live, 'aa', ['p:7', 'p:8'], 20)
  const goneAgain = deleteSection(twoMembers, 'aa', 1000)
  const untickedAfter = removeMemberFrom(twoMembers, 'aa', 'p:7', 1200)
  for (const out of [mergeSections(goneAgain, untickedAfter), mergeSections(untickedAfter, goneAgain)]) {
    assert.equal(out.s.length, 0, '★ a removal must never resurrect the section')
  }

  // Both tombstone maps survive a merge, and the older one is dropped by TTL
  // on write rather than on read.
  const old = { ...emptyTree(), d: { zz: 1 } }
  const merged = mergeSections(gone, old)
  assert.deepEqual(Object.keys(merged.d).sort(), ['aa', 'zz'])
  // 90 days after the newer tombstone: it is exactly on the line and stays,
  // the one from 49 ms earlier is past it and goes.
  const swept = dropExpired(merged, 50 + 90 * 24 * 3600 * 1000)
  assert.deepEqual(Object.keys(swept.d), ['aa'])

  // ...and by COUNT as well as by age, because churn inside the 90 days is
  // unbounded and a slot that grows past the write cap stops syncing at all.
  // Newest kept, oldest dropped.
  let many = emptyTree()
  for (let i = 0; i < MAX_SECTIONS + 5; i++) many = { ...many, d: { ...many.d, [`t${i}`]: 1000 + i } }
  const capped = dropExpired(many, 2000)
  assert.equal(Object.keys(capped.d).length, MAX_SECTIONS)
  assert.ok(!('t0' in capped.d), '★ the oldest tombstone is the one that goes')
  assert.ok(`t${MAX_SECTIONS + 4}` in capped.d)
}

// ── patch, do not rebuild ───────────────────────────────────────────────────
{
  // A record from a client that knows a field this build does not, plus a
  // whole section id this build has never heard of. ★ Both must come out the
  // other side: a merge that rebuilt from a typed struct would delete them,
  // and the newer client would watch its own settings evaporate every time an
  // older one wrote.
  const newer = tree(
    { ...section('aa'), zzz: 'from a newer build' },
    { id: 'sys.future', k: 'd', o: 9999 },
  )
  const older = renameSection(tree(section('aa')), 'aa', 'Renamed', 99)
  for (const out of [mergeSections(newer, older), mergeSections(older, newer)]) {
    assert.equal(out.s.find((r) => r.id === 'aa').zzz, 'from a newer build')
    assert.equal(out.s.find((r) => r.id === 'aa').n, 'Renamed')
    assert.ok(out.s.some((r) => r.id === 'sys.future'))
  }
  // The same for the built-in this client does not draw: Saved Messages is a
  // section on Android and a pinned row on the web, and the web still carries
  // the record.
  const saved = setOrder(emptyTree(), new Map([['sys.saved', 7168]]), 5)
  const web = createSection(emptyTree(), 'Work', 6)
  assert.equal(mergeSections(web, saved).s.find((r) => r.id === 'sys.saved').o, 7168)
}

// ── "has the island got what we have?" is about CONTENT, not bytes ─────────
{
  // The same tree, serialised the way another client would: keys in a
  // different order, the built-in record spelled out, no `w`. ★ A byte
  // comparison calls this a difference, and a client that WRITES on that
  // difference gets into a rewrite war with the client that wrote it: each
  // one restores its own key order, forever, against a budget of 240 puts an
  // hour.
  const ours = mergeSections(tree(section('aa')), tree(section('aa')))
  const theirs = JSON.parse(JSON.stringify({
    s: [{ x: {}, m: {}, t: { o: 1, n: 1 }, o: 1024, n: 'aa', k: 'u', id: 'aa' }],
    d: {},
    v: 1,
  }))
  assert.notEqual(JSON.stringify(ours), JSON.stringify(theirs), 'the bytes really do differ')
  assert.equal(sameContent(ours, theirs), true, '★ and the content really is the same')
  // A real difference is still a difference.
  assert.equal(sameContent(ours, addMembers(ours, 'aa', ['p:1'], 5)), false)
}

// ── the codec refuses what it cannot read ───────────────────────────────────
{
  assert.deepEqual(json(decodeSections(null)), json(emptyTree()))
  assert.equal(decodeSections(bytes({ v: 2, s: [] })), null, '★ a newer format reads as null, never as empty')
  assert.equal(decodeSections(enc.encode('not json')), null)
  const round = decodeSections(encodeSections(tree(section('aa'))))
  assert.equal(round.s[0].id, 'aa')
}

// ── caps refuse rather than truncate ────────────────────────────────────────
{
  let t = emptyTree()
  for (let i = 0; i < MAX_SECTIONS; i++) t = createSection(t, `s${i}`, 1000 + i)
  assert.throws(() => createSection(t, 'one too many'), (e) => e instanceof SectionsError && e.code === 'too_many_sections')

  // ★★★ The cap counts the sections that EXIST, not the ones that ever did.
  // Make and delete 64 while trying out names and the account used to be left
  // unable to create a single section, on every device, for 90 days, with the
  // screen showing none at all and nothing the user could do about it.
  let churn = emptyTree()
  for (let i = 0; i < MAX_SECTIONS; i++) {
    churn = createSection(churn, `s${i}`, 1000 + i)
    churn = deleteSection(churn, churn.s[churn.s.length - 1].id, 2000 + i)
  }
  assert.equal(churn.s.length, 0)
  assert.equal(Object.keys(churn.d).length, MAX_SECTIONS)
  assert.equal(createSection(churn, 'after the churn', 9000).s.length, 1)

  const keys = []
  for (let i = 0; i < MAX_MEMBERS_PER_SECTION; i++) keys.push(peerKey(i))
  const one = addMembers(tree(section('aa')), 'aa', keys, 1)
  assert.equal(totalMembers(one), MAX_MEMBERS_PER_SECTION)
  assert.throws(() => addMembers(one, 'aa', [peerKey(99999)], 2), (e) => e.code === 'section_full')
}

// ── ordering is total and identical everywhere ──────────────────────────────
{
  const t = createSection(emptyTree(), 'Work', 10)
  const ids = orderedSections(t).map((r) => r.id)
  // Every built-in is drawn, in the agreed default order, with the new section
  // appended after the last of them.
  assert.deepEqual(ids.slice(0, 7), [
    'sys.saved',
    'sys.fav',
    'sys.ci',
    'sys.groups',
    'sys.online',
    'sys.offline',
    'sys.archive',
  ])
  assert.equal(ids.length, 8)
  assert.equal(userSections(t).length, 1)
  // A reorder is a normal LWW write on `o`.
  const moved = setOrder(t, new Map([[userSections(t)[0].id, 0]]), 20)
  assert.equal(orderedSections(moved)[0].id, userSections(t)[0].id)
}

// ── ids are 8 hex characters and do not repeat ──────────────────────────────
{
  const seen = new Set()
  for (let i = 0; i < 500; i++) {
    const id = newSectionId()
    assert.match(id, /^[0-9a-f]{8}$/)
    seen.add(id)
  }
  assert.equal(seen.size, 500)
}

// ── forgetting a chat is the only pruning there is ──────────────────────────
{
  const t = addMembers(tree(section('aa')), 'aa', ['p:5'], 100)
  assert.equal(forgetMember(t, 'p:404'), null, 'a chat nobody filed is not a write')
  const after = forgetMember(t, 'p:5', 200)
  assert.deepEqual(membersOf(after, 'aa'), [])
  assert.equal(after.s[0].x['p:5'], 200)
}

console.log('sections: ok')

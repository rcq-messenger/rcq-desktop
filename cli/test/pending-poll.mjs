// The pending-request poll of visited islands (spec 2026-09-15, F1), offline.
//
// Why this gets a test of its own:
//   * It is new, timed traffic to somebody else's island. The island caps
//     `GET /contacts/pending` at 120 a minute and the withdraw at 60 an hour;
//     the client stays at one poll per five minutes (±20%), backs off 5, 10,
//     20, 40, 60 minutes, never waits less than five minutes after a 429, and
//     lets a forced refresh through at most once a minute.
//   * A row from the island merges with a §5f request from the same person and
//     never moves up the list by being seen again.
//   * An island without `contact_pending_withdraw` must never be sent a decline
//     in its place, and a plain 404 on a withdraw is not "done".
// Everything here is production code from src/lib/pending-poll-schedule.ts,
// src/lib/crossisland-pending.ts and src/lib/move-carry.ts.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'
import {
  AUTO_WITHDRAW_PER_HOUR,
  BACKOFF_MINUTES,
  FORCE_DEBOUNCE_MS,
  MAX_ACCEPT_TRIES,
  MAX_RAW_SERVER_ROWS,
  MAX_SERVER_ROWS_PER_HOST,
  POLL_INTERVAL_MS,
  RETRY_AFTER_FLOOR_MS,
  ackServerRef,
  answeredKey,
  backoffMs,
  copyScopedKeys,
  createPendingPollSchedule,
  mergeServerRequest,
  planServerRow,
  rateLimitWaitMs,
  reconcileServerRequests,
  validServerRows,
  withdrawOutcome,
} from '../dist/pending-poll.mjs'

let n = 0
const check = (label, fn) => {
  fn()
  n++
  console.log('  ok  ' + label)
}

const MIN = 60_000
const H = 'b.example'

check('the cadence is the designed one', () => {
  assert.equal(POLL_INTERVAL_MS, 5 * MIN)
  assert.deepEqual([...BACKOFF_MINUTES], [5, 10, 20, 40, 60])
  assert.equal(RETRY_AFTER_FLOOR_MS, 5 * MIN)
  assert.equal(FORCE_DEBOUNCE_MS, MIN)
  // Half the island's withdraw cap, the rest kept for answers given by hand.
  assert.equal(AUTO_WITHDRAW_PER_HOUR, 30)
})

check('an island never polled is due at once', () => {
  const s = createPendingPollSchedule(() => 0.5)
  assert.equal(s.due(H, 0), true)
  assert.equal(s.due(H, 123456), true)
})

check('after a good poll: next one inside 4..6 minutes, both ends', () => {
  const low = createPendingPollSchedule(() => 0)
  low.onAttempt(H, 1000)
  low.onResult(H, 1000, { ok: true })
  assert.equal(low.due(H, 1000 + 4 * MIN - 1), false)
  assert.equal(low.due(H, 1000 + 4 * MIN), true)

  const high = createPendingPollSchedule(() => 0.999999)
  high.onAttempt(H, 1000)
  high.onResult(H, 1000, { ok: true })
  assert.equal(high.due(H, 1000 + 6 * MIN - 10), false)
  assert.equal(high.due(H, 1000 + 6 * MIN), true)

  for (let i = 0; i < 200; i++) {
    const s = createPendingPollSchedule(Math.random)
    s.onResult(H, 0, { ok: true })
    assert.equal(s.due(H, 4 * MIN - 1), false)
    assert.equal(s.due(H, 6 * MIN), true)
  }
})

check('failures back off 5, 10, 20, 40, 60, 60 minutes, and a good poll resets', () => {
  const s = createPendingPollSchedule(() => 0.5)
  let t = 0
  for (const m of [5, 10, 20, 40, 60, 60]) {
    s.onResult(H, t, { ok: false })
    assert.equal(s.due(H, t + m * MIN - 1), false, `${m}`)
    assert.equal(s.due(H, t + m * MIN), true, `${m}`)
    t += m * MIN
  }
  s.onResult(H, t, { ok: true })
  assert.equal(s.due(H, t + 5 * MIN), true)
  s.onResult(H, t, { ok: false })
  assert.equal(s.due(H, t + 5 * MIN - 1), false)
  assert.equal(s.due(H, t + 5 * MIN), true)
  assert.equal(backoffMs(0), 5 * MIN)
  assert.equal(backoffMs(99), 60 * MIN)
})

check('a 429 waits what the island asked, never under five minutes', () => {
  assert.equal(rateLimitWaitMs(null), 5 * MIN)
  assert.equal(rateLimitWaitMs(30), 5 * MIN)
  assert.equal(rateLimitWaitMs(-4), 5 * MIN)
  assert.equal(rateLimitWaitMs(900), 15 * MIN)

  const s = createPendingPollSchedule(() => 0.5)
  s.onAttempt(H, 0)
  s.onResult(H, 0, { ok: false, rateLimited: true, retryAfterSec: 2 })
  assert.equal(s.due(H, 5 * MIN - 1), false)
  assert.equal(s.due(H, 5 * MIN), true)
  // A forced refresh does not get through a 429 wait.
  assert.equal(s.force(H, 2 * MIN), false)
  assert.equal(s.due(H, 2 * MIN), false)

  const long = createPendingPollSchedule(() => 0.5)
  long.onResult(H, 0, { ok: false, rateLimited: true, retryAfterSec: 1800 })
  assert.equal(long.due(H, 30 * MIN - 1), false)
  assert.equal(long.force(H, 20 * MIN), false)
  assert.equal(long.due(H, 30 * MIN), true)
})

check('a forced poll is debounced to once a minute per island, and breaks ordinary backoff', () => {
  const s = createPendingPollSchedule(() => 0.5)
  s.onAttempt(H, 0)
  s.onResult(H, 0, { ok: true })
  assert.equal(s.force(H, 30_000), false)
  assert.equal(s.due(H, 30_000), false)
  assert.equal(s.force(H, MIN), true)
  assert.equal(s.due(H, MIN), true)
  s.onAttempt(H, MIN)
  s.onResult(H, MIN, { ok: false })
  assert.equal(s.force(H, MIN + 59_999), false)
  assert.equal(s.force(H, 2 * MIN), true)
  assert.equal(s.due(H, 2 * MIN), true)
  // Hosts are one island whatever their case; another island is its own.
  assert.equal(s.due('B.EXAMPLE', 2 * MIN), true)
  assert.equal(s.due('c.example', 0), true)
})

check('the poll withdraws at most 30 an hour per island; an answer by hand is not counted', () => {
  const s = createPendingPollSchedule(() => 0.5)
  for (let i = 0; i < AUTO_WITHDRAW_PER_HOUR; i++) {
    assert.equal(s.withdrawAllowed(H, i), true)
    s.noteWithdraw(H, i)
  }
  assert.equal(s.withdrawAllowed(H, 100), false)
  assert.equal(s.withdrawAllowed(H, 100, true), true)
  s.noteWithdraw(H, 100, true)
  assert.equal(s.withdrawAllowed('c.example', 100), true)
  assert.equal(s.withdrawAllowed(H, 60 * MIN + 30), true)
  // A 429 on a withdraw stops every withdraw, by hand too, for the wait.
  s.holdWithdraws(H, 0, null)
  assert.equal(s.withdrawAllowed(H, 5 * MIN - 1, true), false)
  assert.equal(s.withdrawAllowed(H, 5 * MIN, true), true)
})

check('island rows: only well formed pending ones, nickname bounded', () => {
  const rows = validServerRows([
    { id: 1, from_uin: 700, nickname: '  Ann  ', state: 'pending' },
    { id: 2, from_uin: 701, nickname: { evil: true } },
    { id: 3, from_uin: 702, nickname: 'x', state: 'declined' },
    { id: 1, from_uin: 700, nickname: 'dup' },
    { id: '4', from_uin: 703 },
    { id: 5, from_uin: -1 },
    { id: 6.5, from_uin: 704 },
    null,
    'row',
    { id: 7, from_uin: 705, nickname: 'y'.repeat(300) },
  ])
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 7])
  assert.equal(rows[0].nickname, 'Ann')
  assert.equal(rows[1].nickname, '')
  assert.equal(rows[2].nickname.length, 64)
  assert.deepEqual(validServerRows({ not: 'a list' }), [])
  assert.deepEqual(validServerRows(null), [])
  // A longer answer is cut before anything walks it.
  const huge = Array.from({ length: MAX_RAW_SERVER_ROWS + 300 }, (_, i) => ({ id: i + 1, from_uin: 10_000 + i }))
  assert.equal(MAX_RAW_SERVER_ROWS, 500)
  assert.equal(validServerRows(huge).length, MAX_RAW_SERVER_ROWS)
})

check('a §5f request and an island row from the same person stay one row, firstAt unchanged', () => {
  const map = {
    '700@b.example': { uin: 700, host: 'b.example', firstAt: 111, msgs: [], contactReq: true, nickname: 'Ann', note: 'hi' },
  }
  assert.equal(mergeServerRequest(map, 'B.example', 42, { id: 9, from_uin: 700, nickname: 'Other' }, 999, 50), true)
  assert.equal(Object.keys(map).length, 1)
  const r = map['700@b.example']
  assert.equal(r.firstAt, 111)
  assert.equal(r.contactReq, true)
  assert.equal(r.nickname, 'Ann')
  assert.deepEqual(r.server, { id: 9, guestUin: 42, seenAt: 999 })
  // Seen again: nothing changes, not even seenAt.
  assert.equal(mergeServerRequest(map, 'b.example', 42, { id: 9, from_uin: 700, nickname: 'Ann' }, 5000, 50), false)
  assert.equal(r.server.seenAt, 999)
  // A new island row: a new row, keyed like the §5f ones.
  assert.equal(mergeServerRequest(map, 'b.example', 42, { id: 10, from_uin: 800, nickname: '' }, 1000, 50), true)
  assert.deepEqual(map['800@b.example'], {
    uin: 800,
    host: 'b.example',
    firstAt: 1000,
    msgs: [],
    nickname: undefined,
    server: { id: 10, guestUin: 42, seenAt: 1000 },
  })
})

check('the list cap holds: on a full list the incoming island row is dropped, nothing is pushed out', () => {
  const map = {}
  for (let i = 0; i < 50; i++) map[`${i}@x.example`] = { uin: i, host: 'x.example', firstAt: 100 + i, msgs: [], contactReq: true }
  assert.equal(mergeServerRequest(map, 'b.example', 1, { id: 1, from_uin: 900, nickname: 'n' }, 5000, 50), false)
  assert.equal(Object.keys(map).length, 50)
  assert.ok(map['0@x.example'])
  assert.equal(map['900@b.example'], undefined)
  // A row already there still takes the island half on a full list.
  assert.equal(mergeServerRequest(map, 'x.example', 1, { id: 2, from_uin: 0, nickname: '' }, 5000, 50), true)
  assert.equal(map['0@x.example'].server.id, 2)
})

check('a hostile island rotating fresh senders never pushes out §5f requests or held messages', () => {
  const map = {}
  for (let i = 0; i < 10; i++) map[`${i}@c.example`] = { uin: i, host: 'c.example', firstAt: 10 + i, msgs: [], contactReq: true }
  for (let i = 10; i < 15; i++) map[`${i}@d.example`] = { uin: i, host: 'd.example', firstAt: 10 + i, msgs: [{ id: `m${i}` }] }
  let next = 1000
  for (let pass = 0; pass < 6; pass++) {
    // Twenty fresh senders at the head of every answer...
    for (let j = 0; j < MAX_SERVER_ROWS_PER_HOST; j++, next++) {
      mergeServerRequest(map, 'b.example', 42, { id: next, from_uin: next, nickname: '' }, 1_000_000 + pass, 50)
    }
    // ...and every earlier row kept live, so the reconcile removes nothing.
    reconcileServerRequests(map, 'b.example', Array.from({ length: next - 1000 }, (_, k) => 1000 + k))
  }
  for (let i = 0; i < 10; i++) assert.ok(map[`${i}@c.example`], `§5f ${i}`)
  for (let i = 10; i < 15; i++) assert.equal(map[`${i}@d.example`]?.msgs.length, 1, `held ${i}`)
  assert.equal(Object.values(map).filter((r) => r.host === 'b.example').length, MAX_SERVER_ROWS_PER_HOST)
  // Another island's request still gets in while the list has room.
  assert.equal(mergeServerRequest(map, 'e.example', 7, { id: 1, from_uin: 5000, nickname: '' }, 2_000_000, 50), true)
  // A row that is also a §5f request does not count against its island's cap.
  map['77@b.example'] = { uin: 77, host: 'b.example', firstAt: 5, msgs: [], contactReq: true }
  assert.equal(mergeServerRequest(map, 'b.example', 42, { id: 77, from_uin: 77, nickname: '' }, 3_000_000, 50), true)
})

check('reconcile strips a vanished island row, keeps what else the row stands for', () => {
  const map = {
    '1@b.example': { uin: 1, host: 'b.example', firstAt: 1, msgs: [], server: { id: 10, guestUin: 4, seenAt: 1 } },
    '2@b.example': { uin: 2, host: 'b.example', firstAt: 2, msgs: [], contactReq: true, server: { id: 11, guestUin: 4, seenAt: 1 }, srvAcceptTries: 2 },
    '3@b.example': { uin: 3, host: 'b.example', firstAt: 3, msgs: [{ id: 'm' }], server: { id: 12, guestUin: 4, seenAt: 1 } },
    '4@b.example': { uin: 4, host: 'b.example', firstAt: 4, msgs: [], server: { id: 13, guestUin: 4, seenAt: 1 } },
    '5@c.example': { uin: 5, host: 'c.example', firstAt: 5, msgs: [], server: { id: 10, guestUin: 4, seenAt: 1 } },
    '6@b.example': { uin: 6, host: 'b.example', firstAt: 6, msgs: [], contactReq: true },
  }
  assert.equal(reconcileServerRequests(map, 'B.example', [13]), true)
  assert.equal(map['1@b.example'], undefined)
  assert.equal(map['2@b.example'].server, undefined)
  assert.equal(map['2@b.example'].srvAcceptTries, undefined)
  assert.equal(map['2@b.example'].contactReq, true)
  assert.equal(map['3@b.example'].server, undefined)
  assert.equal(map['3@b.example'].msgs.length, 1)
  assert.ok(map['4@b.example'].server)
  assert.ok(map['5@c.example'].server)
  assert.ok(map['6@b.example'])
  assert.equal(reconcileServerRequests(map, 'b.example', [13]), false)
})

const facts = (over = {}) => ({ blocked: false, answered: false, hasContact: false, canWithdraw: true, ...over })
const plan = (over = {}) => ({ upsert: false, withdraw: false, markAnswered: false, redeposit: false, retryDecline: false, ...over })

check('a new row is shown and nothing is sent', () => {
  assert.deepEqual(planServerRow(facts()), plan({ upsert: true }))
  assert.deepEqual(planServerRow(facts({ canWithdraw: false })), plan({ upsert: true }))
})

check('blocked: never shown, cleared on the island only where it can withdraw', () => {
  assert.deepEqual(planServerRow(facts({ blocked: true })), plan({ markAnswered: true, withdraw: true }))
  assert.deepEqual(planServerRow(facts({ blocked: true, canWithdraw: false })), plan({ markAnswered: true }))
  assert.deepEqual(planServerRow(facts({ blocked: true, hasContact: true, acceptTries: 1 })), plan({ markAnswered: true, withdraw: true }))
})

check('answered: never shown again; a withdraw that did not land is retried where possible', () => {
  assert.deepEqual(planServerRow(facts({ answered: true })), plan({ withdraw: true }))
  assert.deepEqual(planServerRow(facts({ answered: true, canWithdraw: false })), plan())
})

check('a contact already held at that address: no question, the row is only cleared', () => {
  assert.deepEqual(planServerRow(facts({ hasContact: true })), plan({ markAnswered: true, withdraw: true }))
  assert.deepEqual(planServerRow(facts({ hasContact: true, canWithdraw: false })), plan({ markAnswered: true }))
})

check(`an accept that did not go out is deposited again, ${MAX_ACCEPT_TRIES} tries in all, then left to a person`, () => {
  assert.equal(MAX_ACCEPT_TRIES, 3)
  assert.deepEqual(planServerRow(facts({ hasContact: true, acceptTries: 1 })), plan({ redeposit: true }))
  assert.deepEqual(planServerRow(facts({ hasContact: true, acceptTries: 2 })), plan({ redeposit: true }))
  assert.deepEqual(planServerRow(facts({ hasContact: true, acceptTries: 3 })), plan())
  assert.deepEqual(planServerRow(facts({ acceptTries: 3 })), plan())
  // Never a decline anywhere in these plans: there is no such field.
  assert.equal('decline' in planServerRow(facts()), false)
})

check('an undelivered accept is never withdrawn, even when the row reads as answered', () => {
  // The old failure: our own ack carbon marked the row answered while the
  // accept had not reached the requester, and the next poll withdrew it.
  assert.deepEqual(planServerRow(facts({ answered: true, hasContact: true, acceptTries: 1 })), plan({ redeposit: true }))
  assert.deepEqual(planServerRow(facts({ answered: true, hasContact: true, acceptTries: 3 })), plan())
  assert.deepEqual(planServerRow(facts({ answered: true, acceptTries: 1 })), plan())
  assert.deepEqual(planServerRow(facts({ hasContact: true, acceptTries: 5 })), plan())
  for (const tries of [1, 2, 3, 4]) {
    for (const answered of [true, false]) {
      for (const hasContact of [true, false]) {
        assert.equal(planServerRow(facts({ answered, hasContact, acceptTries: tries })).withdraw, false)
      }
    }
  }
})

check('a decline that did not land is sent again as a decline, never turned into a withdraw', () => {
  assert.deepEqual(planServerRow(facts({ declinePending: true })), plan({ retryDecline: true }))
  assert.deepEqual(planServerRow(facts({ declinePending: true, answered: true })), plan({ retryDecline: true }))
  assert.deepEqual(planServerRow(facts({ declinePending: true, canWithdraw: false })), plan({ retryDecline: true }))
  // A block afterwards is the person's latest word.
  assert.deepEqual(planServerRow(facts({ declinePending: true, blocked: true })), plan({ markAnswered: true, withdraw: true }))
})

check('withdraw: 204 and the endpoint\'s own 404 are done, a plain 404 is not', () => {
  assert.equal(withdrawOutcome(204, null), 'done')
  assert.equal(withdrawOutcome(404, 'no_such_request'), 'done')
  assert.equal(withdrawOutcome(404, null), 'route_lost')
  assert.equal(withdrawOutcome(404, 'Not Found'), 'route_lost')
  assert.equal(withdrawOutcome(429, 'rate_limited'), 'rate_limited')
  assert.equal(withdrawOutcome(401, null), 'unauthorized')
  assert.equal(withdrawOutcome(500, null), 'failed')
})

check('the answered set is keyed by island and row id, whatever the host case', () => {
  assert.equal(answeredKey('B.Example', 9), 'b.example#9')
  assert.notEqual(answeredKey('b.example', 9), answeredKey('c.example', 9))
})

check('a ciack names an island row only on the island it is about', () => {
  assert.deepEqual(ackServerRef({ host: 'B.example', id: 9 }, 'b.example'), { host: 'b.example', id: 9 })
  assert.equal(ackServerRef({ host: 'c.example', id: 9 }, 'b.example'), null)
  assert.equal(ackServerRef({ host: 'b.example', id: '9' }, 'b.example'), null)
  assert.equal(ackServerRef({ host: 'b.example', id: 0 }, 'b.example'), null)
  assert.equal(ackServerRef({ host: '', id: 9 }, ''), null)
  assert.equal(ackServerRef(undefined, 'b.example'), null)
})

check('a UIN move carries the answered set and the waiting declines with the other scoped keys', () => {
  const m = new Map([
    ['rcq.web.12.ci-answered.v1', '["b.example#9"]'],
    ['rcq.web.12.ci-declining.v1', '["b.example#10"]'],
    ['rcq.web.12.ci-blocked.v1', '{}'],
  ])
  const store = {
    get length() {
      return m.size
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  }
  assert.equal(copyScopedKeys(store, 12, 99), 3)
  assert.equal(store.getItem('rcq.web.99.ci-answered.v1'), '["b.example#9"]')
  assert.equal(store.getItem('rcq.web.99.ci-declining.v1'), '["b.example#10"]')
})

console.log(`pending-poll: ok (${n} checks)`)

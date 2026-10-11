// Fully-offline drain of a room log (Stage 5 of the core-metadata plan).
//
// The island half is a few lines of in-memory model written to the server's
// contract (rcq-server-ref, test_stage5_group_log_local.py): rows above this
// device's cursor per room, `more` when the page was cut, an ack that moves a
// cursor forward only, `rooms` naming which rooms to read and `after` reading
// one from a given seq without moving its cursor. It fills a page room by
// room in the order asked, as every island did before the fair page (and a
// third-party island may still): the order that let one stuck room starve
// the rest (report 981). Everything driven against it is production code from
// src/lib/group-log.ts: the page loop, the ack after the persist, the
// contiguous-prefix rule, the strike ledger, the held-room paging, the head
// seeding of a complete drain, and the live-frame ack. No socket, no network.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'
// localStorage for the web's on-disk ledger, before anything loads.
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

const {
  ackLiveGroupRow,
  drainGroupLog,
  forgetVouched,
  localStrikeStore,
  MAX_ANY_STRIKES,
  MAX_STRIKES,
  NotTheRowsFault,
  notTheRowsFault,
  strikeRow,
  vouchedSeq,
} = await import('../dist/group-v1.mjs')

const API = 'https://island.test'
const UIN = 100001

/// One island with a log per room and one device's cursors into them.
function island(logs) {
  const cursors = new Map()
  const calls = []
  const head = (gid) => logs.get(gid)?.length ?? 0
  const fetchPage = (body) => {
    const limit = body.limit ?? 500
    const rows = []
    const heads = {}
    const out = {}
    let more = false
    // Every room in gid order, or the rooms named, in the order named (a room
    // the account is not in is skipped).
    const wanted = body.rooms
      ? body.rooms.filter((r) => logs.has(r.gid)).map((r) => [r.gid, r.after])
      : [...logs.keys()].sort((a, b) => a - b).map((gid) => [gid, undefined])
    for (const [gid, after] of wanted) {
      heads[gid] = head(gid)
      // A device's first read of a room starts at the head: no backlog.
      if (!cursors.has(gid)) cursors.set(gid, head(gid))
      out[gid] = cursors.get(gid)
      const start = after ?? cursors.get(gid)
      const above = logs.get(gid).filter((r) => r.seq > start)
      const room = above.slice(0, Math.max(0, limit - rows.length))
      if (above.length > room.length) more = true
      rows.push(...room)
    }
    return { rows, heads, cursors: out, more }
  }
  const ack = (body) => {
    for (const r of body.rooms) {
      if ((cursors.get(r.gid) ?? -1) < r.upto) cursors.set(r.gid, r.upto)
    }
    return { deleted: body.rooms.length }
  }
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body })
  const request = async (path, body) => {
    calls.push({ path, body })
    if (path === '/messages/group-log/fetch') return json(200, fetchPage(body))
    if (path === '/messages/group-log/ack') return json(200, ack(body))
    return json(404, {})
  }
  return { request, cursors, calls, post: (gid, envelope_type, payload) => {
    const list = logs.get(gid) ?? []
    list.push({ gid, seq: list.length + 1, envelope_type, cls: 1, payload, received_at: '2026-08-23T10:00:00+00:00' })
    logs.set(gid, list)
    return list.length
  } }
}

function rowsOf(isl, gid, n) {
  for (let i = 1; i <= n; i++) isl.post(gid, i % 3 === 0 ? 'skdm' : 'gmsg', `${gid}:${i}`)
}

// --- 1. A first read creates cursors at the head: nothing old is served, and
// the cursors the island reports seed what this process may ack live.
{
  forgetVouched(API, UIN)
  const isl = island(new Map([[21, []], [22, []]]))
  rowsOf(isl, 21, 4)
  rowsOf(isl, 22, 2)
  const seen = []
  const r = await drainGroupLog(API, UIN, isl.request, async (row) => void seen.push(row))
  assert.equal(seen.length, 0, 'a fresh device owes nobody the backlog')
  assert.equal(r.rows, 0)
  assert.equal(isl.calls.length, 1, 'nothing to ack, so no ack call')
  assert.equal(vouchedSeq(API, UIN, 21), 4, 'vouched from the island cursor, not from rows')
  assert.equal(vouchedSeq(API, UIN, 22), 2)

  // New posts land above the cursor and come back in seq order, per room;
  // the ack names the max seq per room in ONE call, after `persisted` ran.
  isl.post(21, 'gmsg', '21:5')
  isl.post(22, 'gmsg', '22:3')
  isl.post(21, 'gmsg', '21:6')
  const order = []
  const r2 = await drainGroupLog(
    API,
    UIN,
    isl.request,
    async (row) => void order.push(`ingest ${row.gid}/${row.seq}`),
    async () => void order.push('persisted'),
  )
  assert.deepEqual(order, ['ingest 21/5', 'ingest 21/6', 'ingest 22/3', 'persisted'])
  const acks = isl.calls.filter((c) => c.path === '/messages/group-log/ack')
  assert.equal(acks.length, 1)
  assert.deepEqual(acks[0].body, { rooms: [{ gid: 21, upto: 6 }, { gid: 22, upto: 3 }] })
  assert.equal(r2.rows, 3)
  assert.deepEqual([...r2.acked], [[21, 6], [22, 3]])
  assert.equal(isl.cursors.get(21), 6)
  assert.equal(vouchedSeq(API, UIN, 21), 6)
}

// --- 2. The loop: a page cut short is acked, then fetched again from the
// moved cursor, never with an explicit `after`.
{
  forgetVouched(API, UIN)
  const isl = island(new Map([[21, []]]))
  await drainGroupLog(API, UIN, isl.request, async () => {})
  for (let i = 0; i < 1203; i++) isl.post(21, 'gmsg', `p${i}`)
  isl.calls.length = 0
  let n = 0
  const r = await drainGroupLog(API, UIN, isl.request, async () => void n++)
  assert.equal(n, 1203, 'every row of every page was ingested')
  assert.equal(r.rows, 1203)
  const fetches = isl.calls.filter((c) => c.path === '/messages/group-log/fetch')
  assert.equal(fetches.length, 3, '500 + 500 + 203')
  assert.ok(fetches.every((c) => c.body.rooms === undefined), 'the normal path never names rooms or after')
  assert.equal(isl.cursors.get(21), 1203)
}

// --- 3. Contiguous prefix. A row that THROWS stays in front of the cursor;
// the rows behind it are still processed now, and the OTHER room is not held
// back by it. The next drain re-serves from the hole.
{
  forgetVouched(API, UIN)
  const isl = island(new Map([[21, []], [22, []]]))
  await drainGroupLog(API, UIN, isl.request, async () => {})
  rowsOf(isl, 21, 4)
  rowsOf(isl, 22, 2)
  let flaky = true
  const got = []
  const r = await drainGroupLog(API, UIN, isl.request, async (row) => {
    if (flaky && row.gid === 21 && row.seq === 2) throw new Error('ratchet store busy')
    got.push(`${row.gid}/${row.seq}`)
  })
  assert.deepEqual(got, ['21/1', '21/3', '21/4', '22/1', '22/2'])
  assert.deepEqual([...r.acked], [[21, 1], [22, 2]], 'room 21 stops at the hole, room 22 is whole')
  assert.equal(isl.cursors.get(21), 1)
  assert.equal(vouchedSeq(API, UIN, 21), 1, 'a stalled room is NOT moved to its head')
  assert.equal(vouchedSeq(API, UIN, 22), 2)
  flaky = false
  got.length = 0
  await drainGroupLog(API, UIN, isl.request, async (row) => void got.push(`${row.gid}/${row.seq}`))
  assert.deepEqual(got, ['21/2', '21/3', '21/4'], 'the hole and everything behind it come back; dedup is downstream')
  assert.equal(isl.cursors.get(21), 4)
}

// --- 4. A room that stalls is held: its tail is read from the last row
// served (`after`, which moves no cursor), nothing is acked in it, and a page
// that moves nothing ends the drain rather than spinning on it (an island
// that ignores `after` serves the same page again).
{
  forgetVouched(API, UIN)
  const isl = island(new Map([[21, []]]))
  await drainGroupLog(API, UIN, isl.request, async () => {})
  for (let i = 0; i < 700; i++) isl.post(21, 'gmsg', `p${i}`)
  isl.calls.length = 0
  let n = 0
  const r = await drainGroupLog(API, UIN, isl.request, async () => {
    n++
    throw new Error('nothing opens')
  })
  assert.equal(n, 700, 'every row was tried, the tail behind the first page too')
  assert.deepEqual(
    isl.calls.map((c) => c.body),
    [{ limit: 500 }, { limit: 500, rooms: [{ gid: 21, after: 500 }] }],
    'the second page reads the tail, and nothing is acked',
  )
  assert.equal(r.acked.size, 0)
  assert.equal(isl.cursors.get(21), 0, 'the cursor did not move')
  // An island that serves from the cursor whatever it is asked: the second
  // page is the first one again, nothing moved, and the drain stops there.
  forgetVouched(API, UIN)
  const deaf = async (path, body) => isl.request(path, path === '/messages/group-log/fetch' ? { limit: body.limit } : body)
  isl.calls.length = 0
  await drainGroupLog(API, UIN, deaf, async () => {
    throw new Error('nothing opens')
  })
  assert.equal(isl.calls.length, 2, 'two fetches, no ack, no third')
  assert.equal(isl.cursors.get(21), 0)
}

// --- 5. An ack that fails ends the loop without throwing: the rows are
// persisted, the island re-serves them once, the dedup absorbs it.
{
  forgetVouched(API, UIN)
  const isl = island(new Map([[21, []]]))
  await drainGroupLog(API, UIN, isl.request, async () => {})
  for (let i = 0; i < 600; i++) isl.post(21, 'gmsg', `p${i}`)
  const broken = async (path, body) => {
    if (path === '/messages/group-log/ack') return { ok: false, status: 503, json: async () => ({}) }
    return isl.request(path, body)
  }
  isl.calls.length = 0
  let n = 0
  const r = await drainGroupLog(API, UIN, broken, async () => void n++)
  assert.equal(n, 500, 'the first page was processed')
  assert.equal(r.acked.size, 0)
  assert.equal(isl.calls.filter((c) => c.path === '/messages/group-log/fetch').length, 1, 'no second page behind a failed ack')
  assert.equal(vouchedSeq(API, UIN, 21), 0, 'nothing vouched past what the island confirmed')
}

// --- 6. A fetch that errors throws (the caller reports it its own way) and
// acks nothing; a malformed row is skipped, not stalled on.
{
  forgetVouched(API, UIN)
  const isl = island(new Map([[21, []]]))
  await assert.rejects(
    drainGroupLog(API, UIN, async () => ({ ok: false, status: 500, json: async () => ({}) }), async () => {}),
    (e) => e.status === 500,
  )
  const odd = async (path, body) =>
    path === '/messages/group-log/fetch'
      ? { ok: true, status: 200, json: async () => ({ rows: [{ gid: 21, seq: 'x' }, { gid: 21, seq: 1, envelope_type: 'gmsg', payload: 'p' }], heads: {}, cursors: {}, more: false }) }
      : isl.request(path, body)
  const seen = []
  const r = await drainGroupLog(API, UIN, odd, async (row) => void seen.push(row.seq))
  assert.deepEqual(seen, [1])
  assert.deepEqual([...r.acked], [[21, 1]])
}

// --- 7. Live frames. Only the very next row after what this process vouched
// for is acked; a frame that skips ahead is left for the drain (acking past
// unfetched rows would bury them under the cursor), and so is a frame for a
// room this run has not fetched yet.
{
  forgetVouched(API, UIN)
  const isl = island(new Map([[21, []]]))
  rowsOf(isl, 21, 3)
  assert.equal(await ackLiveGroupRow(API, UIN, isl.request, 21, 4), false, 'nothing vouched yet, no ack')
  await drainGroupLog(API, UIN, isl.request, async () => {})
  assert.equal(vouchedSeq(API, UIN, 21), 3)
  isl.post(21, 'gmsg', 'live')
  isl.calls.length = 0
  assert.equal(await ackLiveGroupRow(API, UIN, isl.request, 21, 4), true, 'the next row is acked')
  assert.deepEqual(isl.calls, [{ path: '/messages/group-log/ack', body: { rooms: [{ gid: 21, upto: 4 }] }}])
  assert.equal(isl.cursors.get(21), 4)
  assert.equal(await ackLiveGroupRow(API, UIN, isl.request, 21, 4), false, 'the same row twice is not acked twice')
  assert.equal(await ackLiveGroupRow(API, UIN, isl.request, 21, 7), false, 'a frame that skips ahead is not acked')
  assert.equal(isl.cursors.get(21), 4, 'and the cursor stayed where it was')
  assert.equal(await ackLiveGroupRow(API, UIN, isl.request, 22, 1), false, 'a room never fetched is not acked')
  // Another account in the same process keeps its own ledger.
  assert.equal(vouchedSeq(API, UIN + 1, 21), undefined)
  forgetVouched(API, UIN)
  assert.equal(vouchedSeq(API, UIN, 21), undefined, 'a new session starts from the island cursor')
}

// --- 8. The live ack's `persisted` (the web's full-archive history write)
// runs ONLY when the gate passes, and before the ack; a write that fails
// acks nothing and vouches for nothing. Two frames back to back both pass:
// the second waits for the first.
{
  forgetVouched(API, UIN)
  const isl = island(new Map([[21, []]]))
  rowsOf(isl, 21, 3)
  await drainGroupLog(API, UIN, isl.request, async () => {})
  let writes = 0
  const persisted = async () => void writes++
  isl.post(21, 'gmsg', 'a')
  isl.post(21, 'gmsg', 'b')
  isl.post(21, 'gmsg', 'c')
  assert.equal(await ackLiveGroupRow(API, UIN, isl.request, 21, 6, persisted), false, 'refused: a gap')
  assert.equal(writes, 0, 'a refused frame costs no write')
  isl.calls.length = 0
  const order = []
  const noting = async (path, body) => {
    order.push(`ack ${body.rooms[0].upto}`)
    return isl.request(path, body)
  }
  const [a, b] = await Promise.all([
    ackLiveGroupRow(API, UIN, noting, 21, 4, async () => void order.push('write 4')),
    ackLiveGroupRow(API, UIN, noting, 21, 5, async () => void order.push('write 5')),
  ])
  assert.equal(a, true)
  assert.equal(b, true, 'the frame behind saw the first as its predecessor')
  assert.deepEqual(order, ['write 4', 'ack 4', 'write 5', 'ack 5'], 'write, then ack, one frame at a time')
  assert.equal(isl.cursors.get(21), 5)
  assert.equal(await ackLiveGroupRow(API, UIN, isl.request, 21, 6, async () => { throw new Error('idb is full') }), false)
  assert.equal(vouchedSeq(API, UIN, 21), 5, 'a failed write vouches for nothing')
  assert.equal(isl.cursors.get(21), 5)
}

// --- 9. A complete drain (last page) moves the vouched seq to the HEAD the
// island reported, past rows addressed to other members that this device
// never sees, so the next live frame is acked; a page cut short does not.
{
  forgetVouched(API, UIN)
  const isl = island(new Map([[21, []]]))
  await drainGroupLog(API, UIN, isl.request, async () => {})
  // Two rows for us, then three sealed to somebody else: the island skips
  // them for this member but the head moves past them.
  isl.post(21, 'gmsg', 'p1')
  isl.post(21, 'gmsg', 'p2')
  const others = async (path, body) => {
    const res = await isl.request(path, body)
    if (path !== '/messages/group-log/fetch') return res
    const page = await res.json()
    page.heads[21] = 5
    return { ok: true, status: 200, json: async () => page }
  }
  await drainGroupLog(API, UIN, others, async () => {})
  assert.equal(isl.cursors.get(21), 2, 'the island cursor sits at the last row served')
  assert.equal(vouchedSeq(API, UIN, 21), 5, 'vouched moved to the head')
  isl.post(21, 'gmsg', 'x3')
  isl.post(21, 'gmsg', 'x4')
  isl.post(21, 'gmsg', 'x5')
  isl.post(21, 'gmsg', 'live')
  assert.equal(await ackLiveGroupRow(API, UIN, isl.request, 21, 6), true, 'head+1 is acked live')
  assert.equal(isl.cursors.get(21), 6)
  // A drain cut short (more=true) leaves the vouched seq at what was acked.
  forgetVouched(API, UIN)
  const isl2 = island(new Map([[21, []]]))
  await drainGroupLog(API, UIN, isl2.request, async () => {})
  for (let i = 0; i < 510; i++) isl2.post(21, 'gmsg', `p${i}`)
  let pages = 0
  const cut = async (path, body) => {
    if (path === '/messages/group-log/fetch' && pages++ === 1) return { ok: false, status: 503, json: async () => ({}) }
    return isl2.request(path, body)
  }
  await assert.rejects(drainGroupLog(API, UIN, cut, async () => {}))
  assert.equal(vouchedSeq(API, UIN, 21), 500, 'the first page was acked, the head was not vouched for')
}

// --- 10. Strikes. A row that throws the SAME way on MAX_STRIKES consecutive
// drains is unreadable here and acked past; a different failure starts the
// count again; a row re-served within one drain (a later page) is one
// strike, not one per page; a row that opens clears its entry.
{
  forgetVouched(API, UIN)
  const isl = island(new Map([[21, []], [22, []]]))
  await drainGroupLog(API, UIN, isl.request, async () => {})
  isl.post(21, 'gmsg', 'bad')
  isl.post(21, 'gmsg', 'fine')
  for (let i = 0; i < 600; i++) isl.post(22, 'gmsg', `p${i}`)
  class Unopened extends Error {
    constructor() {
      super('v2 session did not open the message')
      this.name = 'V2SessionError'
    }
  }
  let fails = 0
  const ingest = async (row) => {
    if (row.gid === 21 && row.seq === 1) {
      fails++
      throw new Unopened()
    }
  }
  // Drain 1: two pages (room 22 is 600 deep). Room 21 is held from the
  // hole on: the second page reads it from the last row served, so the hole
  // is not served again, and room 22 is read whole.
  await drainGroupLog(API, UIN, isl.request, ingest)
  assert.equal(fails, 1, 'the hole was served once')
  assert.equal(isl.cursors.get(21), 0)
  assert.equal(isl.cursors.get(22), 600)
  // The same row served twice in one drain (an island that ignores `after`)
  // is still one strike.
  {
    forgetVouched(API, UIN + 7)
    const twice = island(new Map([[21, []], [22, []]]))
    await drainGroupLog(API, UIN + 7, twice.request, async () => {})
    twice.post(21, 'gmsg', 'bad')
    for (let i = 0; i < 600; i++) twice.post(22, 'gmsg', `p${i}`)
    const deaf = async (path, body) => twice.request(path, path === '/messages/group-log/fetch' ? { limit: body.limit } : body)
    let stored = {}
    const store = { read: () => ({ ...stored }), write: (s) => void (stored = s) }
    let tries = 0
    await drainGroupLog(API, UIN + 7, deaf, async (row) => {
      if (row.gid === 21) {
        tries++
        throw new Unopened()
      }
    }, undefined, store)
    assert.equal(tries, 2, 'served on both pages')
    assert.deepEqual(stored, { '21/1': { sig: 'V2SessionError', n: 1, any: 1 } }, 'and counted once')
  }
  for (let k = 2; k < MAX_STRIKES; k++) {
    await drainGroupLog(API, UIN, isl.request, ingest)
    assert.equal(isl.cursors.get(21), 0, `still in front of the cursor after drain ${k}`)
  }
  await drainGroupLog(API, UIN, isl.request, ingest)
  assert.equal(isl.cursors.get(21), 2, `acked past on drain ${MAX_STRIKES}, the row behind it too`)
  assert.equal(vouchedSeq(API, UIN, 21), 2)
  // A different failure each time never reaches MAX_STRIKES, and is
  // written off on MAX_ANY_STRIKES consecutive drains instead.
  forgetVouched(API, UIN)
  const isl2 = island(new Map([[21, []]]))
  await drainGroupLog(API, UIN, isl2.request, async () => {})
  isl2.post(21, 'gmsg', 'bad')
  let n = 0
  const varying = async () => {
    throw new Error(`reason ${'ab'[n++ % 2]}`)
  }
  for (let k = 1; k < MAX_ANY_STRIKES; k++) await drainGroupLog(API, UIN, isl2.request, varying)
  assert.ok(MAX_ANY_STRIKES > MAX_STRIKES)
  assert.equal(isl2.cursors.get(21), 0, 'alternating failures stall past MAX_STRIKES')
  await drainGroupLog(API, UIN, isl2.request, varying)
  assert.equal(isl2.cursors.get(21), 1, `and are written off on drain ${MAX_ANY_STRIKES}`)
  // A message that differs only in its numbers is the same failure.
  forgetVouched(API, UIN)
  const isl2b = island(new Map([[21, []]]))
  await drainGroupLog(API, UIN, isl2b.request, async () => {})
  isl2b.post(21, 'gmsg', 'bad')
  let t = 15000
  const timedOut = async () => {
    throw new Error(`gave up after ${t++} ms`)
  }
  for (let k = 0; k < MAX_STRIKES; k++) await drainGroupLog(API, UIN, isl2b.request, timedOut)
  assert.equal(isl2b.cursors.get(21), 1, 'digits do not make a new failure')
  // The same failure, interrupted by a success, starts over.
  forgetVouched(API, UIN)
  const isl3 = island(new Map([[21, []]]))
  await drainGroupLog(API, UIN, isl3.request, async () => {})
  isl3.post(21, 'gmsg', 'bad')
  let open = false
  const sometimes = async () => {
    if (!open) throw new Error('busy')
  }
  for (let k = 1; k < MAX_STRIKES; k++) await drainGroupLog(API, UIN, isl3.request, sometimes)
  assert.equal(isl3.cursors.get(21), 0)
  open = true
  await drainGroupLog(API, UIN, isl3.request, sometimes)
  assert.equal(isl3.cursors.get(21), 1, 'it opened, and was acked as a normal row')
  // A file-backed ledger (the CLI's) is read and written through the hooks.
  forgetVouched(API, UIN)
  const isl4 = island(new Map([[21, []]]))
  await drainGroupLog(API, UIN, isl4.request, async () => {})
  isl4.post(21, 'gmsg', 'bad')
  let stored = {}
  const store = { read: () => ({ ...stored }), write: (s) => void (stored = s) }
  const busy = async () => {
    throw new Error('busy')
  }
  await drainGroupLog(API, UIN, isl4.request, busy, undefined, store)
  assert.deepEqual(stored, { '21/1': { sig: 'Error: busy', n: 1, any: 1 } })
  // An entry written before `any` was kept reads it as `n`.
  stored = { '21/1': { sig: 'Error: busy', n: MAX_STRIKES - 1 } }
  await drainGroupLog(API, UIN, isl4.request, busy, undefined, store)
  assert.equal(isl4.cursors.get(21), 1, 'the count carried over from the file')
  assert.deepEqual(stored, {}, 'and the entry is gone once the cursor passed it')
}

// --- 11. Report 981: one stuck room does not starve the others. Room 21
// (the flagship's gid) has a row that does not open and 1200 rows behind it,
// more than two pages; rooms 22 and 23 have a little each. The island fills
// pages in room order, so before, every page was room 21 from its cursor,
// rooms 22 and 23 got `more` and nothing else, and the drain stopped on a
// page that moved nothing. Now the drain goes on naming the rooms: 22 and 23
// from their cursors, 21 from the last row served. Everything is ingested in
// ONE drain, 22 and 23 are acked, 21 stays in front of its hole.
{
  forgetVouched(API, UIN)
  const isl = island(new Map([[21, []], [22, []], [23, []]]))
  await drainGroupLog(API, UIN, isl.request, async () => {})
  isl.post(21, 'gmsg', 'stuck')
  for (let i = 0; i < 1200; i++) isl.post(21, 'gmsg', `t${i}`)
  rowsOf(isl, 22, 5)
  rowsOf(isl, 23, 2)
  isl.calls.length = 0
  const seen = new Map()
  const ingest = async (row) => {
    seen.set(row.gid, (seen.get(row.gid) ?? 0) + 1)
    if (row.gid === 21 && row.seq === 1) throw new Error('does not open')
  }
  const r = await drainGroupLog(API, UIN, isl.request, ingest)
  assert.equal(seen.get(22), 5, 'room 22 delivered in the same drain')
  assert.equal(seen.get(23), 2, 'room 23 too')
  assert.equal(seen.get(21), 1201, 'and room 21 whole, its tail read past the page')
  assert.deepEqual([...r.acked].sort(), [[22, 5], [23, 2]])
  assert.equal(isl.cursors.get(21), 0, 'the stuck room keeps its cursor in front of the hole')
  assert.equal(vouchedSeq(API, UIN, 21), 0, 'and nothing live is acked past it')
  assert.equal(vouchedSeq(API, UIN, 22), 5)
  const fetches = isl.calls.filter((c) => c.path === '/messages/group-log/fetch')
  assert.deepEqual(fetches[0].body, { limit: 500 }, 'the first page names nothing')
  assert.deepEqual(
    fetches[1].body.rooms,
    [{ gid: 22 }, { gid: 23 }, { gid: 21, after: 500 }],
    'then the other rooms first, the stuck one from its tail',
  )
  assert.ok(fetches.length <= 4)
  // The next drains do the same; on the last strike the hole is written off
  // and room 21 is acked to its end in that drain.
  for (let k = 2; k <= MAX_STRIKES; k++) await drainGroupLog(API, UIN, isl.request, ingest)
  assert.equal(isl.cursors.get(21), 1201, `acked to the end on drain ${MAX_STRIKES}`)
  assert.equal(vouchedSeq(API, UIN, 21), 1201)
}

// --- 12. A failure that is not the row's fault never counts: no libsignal
// device, an island that could not be asked, the network, storage refusing.
// The row waits in front of the cursor, for as many drains as it takes, and
// is acked like any other once it opens.
{
  class NoDevice extends Error {
    notTheRow = true
    constructor() {
      super('no libsignal device: island unreachable')
      this.name = 'DeviceUnavailableError'
    }
  }
  const httpError = (status) => Object.assign(new Error(`${status}: upstream`), { status })
  const domError = (name) => Object.assign(new Error(name), { name })
  const kinds = [
    new NoDevice(),
    new NotTheRowsFault('room roster unavailable'),
    new TypeError('Failed to fetch'),
    new TypeError('NetworkError when attempting to fetch resource.'),
    new TypeError('Load failed'),
    new TypeError('fetch failed'),
    domError('AbortError'),
    domError('TimeoutError'),
    domError('QuotaExceededError'),
    domError('TransactionInactiveError'),
    httpError(503),
    httpError(429),
    httpError(401),
    httpError(0),
  ]
  for (const k of kinds) assert.equal(notTheRowsFault(k), true, `${k.name}: ${k.message}`)
  // And what IS the row's: its own decrypt, a bug it trips, an answer.
  assert.equal(notTheRowsFault(Object.assign(new Error('v2'), { name: 'V2SessionError' })), false)
  assert.equal(notTheRowsFault(new TypeError("Cannot read properties of undefined (reading 'kind')")), false)
  assert.equal(notTheRowsFault(new TypeError('x.fetchCard is not a function')), false, 'a bug that names fetch is still a bug')
  assert.equal(notTheRowsFault(new SyntaxError('Unexpected token')), false)
  assert.equal(notTheRowsFault(httpError(404)), false)
  assert.equal(notTheRowsFault('SignalError: Operation failed'), false)

  forgetVouched(API, UIN)
  const isl = island(new Map([[21, []]]))
  await drainGroupLog(API, UIN, isl.request, async () => {})
  isl.post(21, 'gmsg', 'waits')
  isl.post(21, 'gmsg', 'behind')
  let stored = {}
  let writes = 0
  const store = { read: () => ({ ...stored }), write: (x) => void (writes++, (stored = x)) }
  let i = 0
  for (let k = 0; k < MAX_ANY_STRIKES * 2; k++) {
    forgetVouched(API, UIN) // a reload between drains: only the store remembers
    await drainGroupLog(API, UIN, isl.request, async (row) => {
      if (row.seq === 1) throw kinds[i++ % kinds.length]
    }, undefined, store)
    assert.equal(isl.cursors.get(21), 0, `still waiting after drain ${k + 1}`)
  }
  assert.deepEqual(stored, {}, 'nothing was ever counted')
  assert.equal(writes, 0, 'nor written')
  await drainGroupLog(API, UIN, isl.request, async () => {}, undefined, store)
  assert.equal(isl.cursors.get(21), 2, 'it opened, and was acked with the row behind it')
  // A count already running is neither reset nor advanced by such a drain.
  stored = { '21/3': { sig: 'V2SessionError', n: MAX_STRIKES - 1, any: MAX_STRIKES - 1 } }
  isl.post(21, 'gmsg', 'third')
  await drainGroupLog(API, UIN, isl.request, async () => {
    throw new NoDevice()
  }, undefined, store)
  assert.deepEqual(stored['21/3'], { sig: 'V2SessionError', n: MAX_STRIKES - 1, any: MAX_STRIKES - 1 })
}

// --- 13. The web's ledger on disk (group-log-strikes.ts). It is what makes
// a tab opened for a minute at a time reach the limit: the count survives
// the reload. One ledger per (island, number, lane), all in one per-account
// key that is removed when it empties; storage that will not read or write
// falls back to the copy in memory, i.e. the old behaviour.
{
  ls.clear()
  forgetVouched(API, UIN)
  const isl = island(new Map([[21, []]]))
  await drainGroupLog(API, UIN, isl.request, async () => {}, undefined, localStrikeStore(API, UIN))
  isl.post(21, 'gmsg', 'bad')
  const bad = async (row) => {
    if (row.seq === 1) throw Object.assign(new Error('v2'), { name: 'V2SessionError' })
  }
  for (let k = 1; k < MAX_STRIKES; k++) {
    forgetVouched(API, UIN) // the reload: memory gone, the disk is not
    await drainGroupLog(API, UIN, isl.request, bad, undefined, localStrikeStore(API, UIN))
    assert.equal(isl.cursors.get(21), 0)
  }
  const key = 'rcq.web.glstrikes.v1'
  const disk = JSON.parse(ls.get(key))
  assert.deepEqual(disk, { [`${API}#${UIN}#log`]: { '21/1': { sig: 'V2SessionError', n: MAX_STRIKES - 1, any: MAX_STRIKES - 1 } } })
  // Another lane and another island keep their own counts.
  assert.deepEqual(localStrikeStore(API, UIN, 'queue').read(), {})
  assert.deepEqual(localStrikeStore('https://other.test', UIN).read(), {})
  forgetVouched(API, UIN)
  await drainGroupLog(API, UIN, isl.request, bad, undefined, localStrikeStore(API, UIN))
  assert.equal(isl.cursors.get(21), 1, `written off on the ${MAX_STRIKES}rd boot`)
  assert.equal(ls.has(key), false, 'and the key is gone once the ledger is empty')
  // Garbage on disk reads as an empty ledger and is written over.
  ls.set(key, '{not json')
  const st = localStrikeStore(API, UIN)
  assert.deepEqual(st.read(), {})
  st.write({ '21/9': { sig: 'X', n: 1, any: 1 } })
  assert.deepEqual(JSON.parse(ls.get(key))[`${API}#${UIN}#log`], { '21/9': { sig: 'X', n: 1, any: 1 } })
  // Entries that are not entries are dropped on read.
  ls.set(key, JSON.stringify({ [`${API}#${UIN}#log`]: { a: { sig: 1, n: 'x' }, b: null, '21/9': { sig: 'X', n: 2 } } }))
  assert.deepEqual(st.read(), { '21/9': { sig: 'X', n: 2 } })
  // A store that refuses the write: this page keeps counting in memory.
  const setItem = globalThis.localStorage.setItem
  globalThis.localStorage.setItem = () => {
    throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
  }
  st.write({ '21/9': { sig: 'X', n: 2, any: 2 } })
  assert.deepEqual(st.read(), { '21/9': { sig: 'X', n: 2, any: 2 } }, 'read back from memory')
  globalThis.localStorage.setItem = setItem
  ls.clear()
}

// --- 14. The ledger forgets rooms the account is no longer in: the island
// reports a cursor for every room it is in, and an entry for any other room
// is dead weight that would otherwise sit on disk for ever.
{
  forgetVouched(API, UIN)
  const isl = island(new Map([[21, []]]))
  rowsOf(isl, 21, 6)
  // This device already acked through 2 (on another tab, say): 21/2 is a
  // count the cursor has since passed. Room 99 is a room it has left.
  isl.cursors.set(21, 2)
  let stored = { '99/4': { sig: 'X', n: 1, any: 1 }, '21/2': { sig: 'Y', n: 1, any: 1 } }
  const store = { read: () => ({ ...stored }), write: (x) => void (stored = x) }
  await drainGroupLog(API, UIN, isl.request, async (row) => {
    if (row.seq === 6) throw Object.assign(new Error('v2'), { name: 'V2SessionError' })
  }, undefined, store)
  assert.deepEqual(Object.keys(stored), ['21/6'], 'room 99 dropped, 21/2 passed by the cursor, 21/6 counted')
  assert.equal(isl.cursors.get(21), 5)
}

// --- 15. strikeRow on its own, the way the legacy queue drain uses it (one
// fetch per drain, keyed by queue id).
{
  const struck = {}
  const own = Object.assign(new Error('v2'), { name: 'V2SessionError' })
  assert.equal(strikeRow(struck, 'd7', new NotTheRowsFault('no roster')), 'wait')
  assert.deepEqual(struck, {})
  for (let k = 1; k < MAX_STRIKES; k++) assert.equal(strikeRow(struck, 'd7', own), 'stall')
  assert.equal(strikeRow(struck, 'd7', own, true), 'stall', 'again in the same drain counts nothing')
  assert.deepEqual(struck.d7, { sig: 'V2SessionError', n: MAX_STRIKES - 1, any: MAX_STRIKES - 1 })
  assert.equal(strikeRow(struck, 'd7', own), 'writeOff')
  assert.deepEqual(struck, {}, 'a written-off row leaves the ledger')
}

console.log('group log ok: head start, page loop, contiguous prefix, held rooms, ack failure, malformed rows, live ack, persist gate, head seeding, strikes, no starvation, not the row, ledger on disk, ledger pruning')

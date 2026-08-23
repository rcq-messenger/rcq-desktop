// Fully-offline drain of a room log (Stage 5 of the core-metadata plan).
//
// The island half is a few lines of in-memory model written to the server's
// contract (rcq-server-ref, test_stage5_group_log_local.py): rows above this
// device's cursor per room, `more` when the page was cut, an ack that moves a
// cursor forward only. Everything driven against it is production code from
// src/lib/group-log.ts: the page loop, the ack after the persist, the
// contiguous-prefix rule, the strike ledger, the head seeding of a complete
// drain, and the live-frame ack. No socket, no network.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'
import { ackLiveGroupRow, drainGroupLog, forgetVouched, MAX_STRIKES, vouchedSeq } from '../dist/group-v1.mjs'

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
    for (const gid of [...logs.keys()].sort((a, b) => a - b)) {
      heads[gid] = head(gid)
      // A device's first read of a room starts at the head: no backlog.
      if (!cursors.has(gid)) cursors.set(gid, head(gid))
      out[gid] = cursors.get(gid)
      const above = logs.get(gid).filter((r) => r.seq > cursors.get(gid))
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

// --- 4. A page where nothing could be processed ends the drain rather than
// spinning on it (the fetch reads from the stored cursor, so a re-fetch
// without an ack would serve the same page forever).
{
  forgetVouched(API, UIN)
  const isl = island(new Map([[21, []]]))
  await drainGroupLog(API, UIN, isl.request, async () => {})
  for (let i = 0; i < 700; i++) isl.post(21, 'gmsg', `p${i}`)
  isl.calls.length = 0
  const r = await drainGroupLog(API, UIN, isl.request, async () => {
    throw new Error('nothing opens')
  })
  assert.equal(isl.calls.length, 1, 'one fetch, no ack, no second fetch')
  assert.equal(r.acked.size, 0)
  assert.equal(isl.cursors.get(21), 0, 'the cursor did not move')
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
  class NoDevice extends Error {
    constructor() {
      super('no libsignal device')
      this.name = 'DeviceUnavailableError'
    }
  }
  let fails = 0
  const ingest = async (row) => {
    if (row.gid === 21 && row.seq === 1) {
      fails++
      throw new NoDevice()
    }
  }
  // Drain 1: two pages (room 22 is 600 deep), room 21's hole is served on
  // both, counted once.
  await drainGroupLog(API, UIN, isl.request, ingest)
  assert.equal(fails, 2, 'the hole was re-served on the second page')
  assert.equal(isl.cursors.get(21), 0)
  assert.equal(isl.cursors.get(22), 600)
  for (let k = 2; k < MAX_STRIKES; k++) {
    await drainGroupLog(API, UIN, isl.request, ingest)
    assert.equal(isl.cursors.get(21), 0, `still in front of the cursor after drain ${k}`)
  }
  await drainGroupLog(API, UIN, isl.request, ingest)
  assert.equal(isl.cursors.get(21), 2, `acked past on drain ${MAX_STRIKES}, the row behind it too`)
  assert.equal(vouchedSeq(API, UIN, 21), 2)
  // A different failure each time never reaches the limit.
  forgetVouched(API, UIN)
  const isl2 = island(new Map([[21, []]]))
  await drainGroupLog(API, UIN, isl2.request, async () => {})
  isl2.post(21, 'gmsg', 'bad')
  let n = 0
  const varying = async () => {
    throw new Error(`reason ${n++ % 2}`)
  }
  for (let k = 0; k < MAX_STRIKES + 2; k++) await drainGroupLog(API, UIN, isl2.request, varying)
  assert.equal(isl2.cursors.get(21), 0, 'alternating failures keep stalling')
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
  assert.deepEqual(stored, { '21/1': { sig: 'Error: busy', n: 1 } })
  stored = { '21/1': { sig: 'Error: busy', n: MAX_STRIKES - 1 } }
  await drainGroupLog(API, UIN, isl4.request, busy, undefined, store)
  assert.equal(isl4.cursors.get(21), 1, 'the count carried over from the file')
  assert.deepEqual(stored, {}, 'and the entry is gone once the cursor passed it')
}

console.log('group log ok: head start, page loop, contiguous prefix, no spin, ack failure, malformed rows, live ack, persist gate, head seeding, strikes')

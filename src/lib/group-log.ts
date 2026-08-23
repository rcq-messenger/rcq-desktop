// Stage 5 of the core-metadata plan: rooms are drained from one log per room.
//
// A post into a room used to be written once per member (872 copies of one
// blob in RCQ Beta, 79% of the database). On an island that advertises
// `group_log` it is ONE row in the room's log, read through a per-(room,
// account, device) cursor: `POST /messages/group-log/fetch` hands back every
// row above this device's cursor in every room the account is in, and
// `POST /messages/group-log/ack` moves the cursor forward, never back.
//
// The rows carry exactly the envelope types and payloads the legacy group
// rows of `/messages/queue` carry (a sender-keys `gmsg` broadcast, or a row
// sealed to this one member: `skdm`, `sknack`, a reaction, a legacy
// per-member `message`), so a caller hands them to the SAME ingest path its
// legacy drain uses. This module owns only what is new: the page loop, the
// "ack after persist" order, and the contiguous-prefix rule for the ack.
//
// ⚠ Dual read. The legacy `/messages/queue` drain stays exactly as it is:
// it keeps serving 1:1 rows and whatever legacy group rows were written for
// this account before its first log fetch. That first fetch flips the account
// to "log reader" on the island (implicit, no capability call), so from then
// on new room posts exist only in the log. Both are fetched; the envelope-id
// dedup downstream absorbs any overlap.
//
// ⚠ The ack is per room and advances over the CONTIGUOUS prefix of rows that
// were processed to their end, the rule `/messages/queue/ack` enforces on the
// island for the legacy queue. A row that THREW stays in front of the cursor
// and is re-served next time; the rows behind it are still processed now (a
// re-served copy is absorbed by the chain position and the id dedup), just
// not vouched for yet. A `gmsg` the client cannot open because its `skdm` has
// not arrived is NOT a throw: it is held the way the legacy drain holds it,
// and acked, so a missing chain never pins a room's cursor forever.
//
// React-free and fetch-free: the caller supplies the request function (the
// web's timeout wrapper, a backup island's 401-refreshing closure, the CLI's
// AbortSignal.timeout one), and this module is bundled into the CLI.

import { fetchServerInfo } from './server-info'

/// One row of a room's log, as `/messages/group-log/fetch` serves it.
export interface GroupLogRow {
  gid: number
  seq: number
  envelope_type: string
  /// Stage 2 class (0 signal, 1 message, 2 key material), same meaning as on
  /// the 1:1 queue. Read when present.
  cls?: number | null
  payload: string
  /// When the ISLAND took the post (ISO 8601).
  received_at?: string
}

interface GroupLogPage {
  rows: GroupLogRow[]
  /// Per room (keys are decimal strings on the wire): the head of the log as
  /// of this fetch, and where this device's cursor stands after the call.
  heads: Record<string, number>
  cursors: Record<string, number>
  /// True when `limit` cut the answer short.
  more: boolean
}

/// `path` is one of the two log endpoints, relative to the island's API base;
/// `body` is the JSON to POST. The caller owns auth, timeout and 401 handling.
export type GroupLogRequest = (path: string, body: unknown) => Promise<Response>

export const GROUP_LOG_FETCH = '/messages/group-log/fetch'
export const GROUP_LOG_ACK = '/messages/group-log/ack'

/// Rows per fetch. The island caps a page at 2000; 500 keeps one page's
/// decrypt work short enough that a flapping socket does not pile drains up.
const PAGE_LIMIT = 500

/// How many pages one drain may walk. A backlog deeper than this is picked up
/// by the next drain; the cap exists so a room whose rows keep throwing (and
/// so keep being re-served) cannot spin a drain forever.
const MAX_PAGES = 20

/// A log fetch that came back with an HTTP error. Carries the status so a
/// caller can say so in its own words (the CLI prints it, the web stays quiet).
export class GroupLogHttpError extends Error {
  constructor(public status: number, path: string) {
    super(`POST ${path} -> ${status}`)
  }
}

export interface GroupLogDrainResult {
  /// Rows handed to `ingest` over every page of this drain.
  rows: number
  /// Per room, the highest seq this drain acked.
  acked: Map<number, number>
}

/// Does this island keep a log per room? Reads `capabilities.group_log` off
/// the run-long /server/info cache, the way the key-lookup path reads
/// `anon_keys`. An island that did not answer (down, timed out, older than
/// /server/info) reads FALSE: the legacy queue is then the only drain, which
/// is exactly the old behaviour, and the question is asked again on the next
/// drain because a failed read is not cached.
export async function islandHasGroupLog(apiBase: string): Promise<boolean> {
  const caps = (await fetchServerInfo(apiBase))?.capabilities
  return caps?.group_log === true
}

/// Per (island, account) the last seq this process has vouched for in each
/// room, for the live-frame ack below. Seeded from the cursors a fetch
/// reports, advanced by every ack. Never read for the fetch itself: the
/// island's cursor is authoritative there.
const vouched = new Map<string, Map<number, number>>()

function scopeKey(apiBase: string, uin: number): string {
  return `${apiBase}#${uin}`
}

function noteVouched(apiBase: string, uin: number, gid: number, seq: number): void {
  const key = scopeKey(apiBase, uin)
  let rooms = vouched.get(key)
  if (!rooms) {
    rooms = new Map()
    vouched.set(key, rooms)
  }
  const last = rooms.get(gid)
  if (last === undefined || seq > last) rooms.set(gid, seq)
}

/// What this process has vouched for in `gid`, or undefined before the first
/// fetch of the run (tests and the live-frame ack).
export function vouchedSeq(apiBase: string, uin: number, gid: number): number | undefined {
  return vouched.get(scopeKey(apiBase, uin))?.get(gid)
}

function isRow(r: unknown): r is GroupLogRow {
  if (!r || typeof r !== 'object') return false
  const o = r as Record<string, unknown>
  return (
    typeof o.gid === 'number' &&
    typeof o.seq === 'number' &&
    typeof o.envelope_type === 'string' &&
    typeof o.payload === 'string'
  )
}

function readCursors(raw: unknown): Map<number, number> {
  const out = new Map<number, number>()
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const gid = Number(k)
    if (Number.isInteger(gid) && typeof v === 'number') out.set(gid, v)
  }
  return out
}

async function postAck(request: GroupLogRequest, upto: Map<number, number>): Promise<boolean> {
  const rooms = [...upto].map(([gid, seq]) => ({ gid, upto: seq }))
  const res = await request(GROUP_LOG_ACK, { rooms })
  return res.ok
}

/// Drain every room this account is in on one island: fetch a page, hand each
/// row to `ingest`, wait for `persisted`, ack the contiguous prefix per room,
/// and go again while the island says there is more.
///
/// `ingest` throws on a TRANSIENT failure and returns on anything terminal,
/// "decrypted to nothing" included: the same contract as a legacy queue row.
/// `persisted` runs between the last ingest of a page and its ack (the web's
/// coalesced history write; the CLI appends synchronously and passes nothing).
///
/// Throws on a fetch that did not answer or answered with an error (nothing
/// was acked for that page; the next drain re-serves it). An ack that fails
/// ends the loop without throwing: the rows are on disk, the island re-serves
/// them once, and the dedup absorbs the repeat. Looping on without the ack
/// would re-fetch the same page forever, since the normal fetch reads from
/// the island's stored cursor and never passes an explicit `after`.
export async function drainGroupLog(
  apiBase: string,
  uin: number,
  request: GroupLogRequest,
  ingest: (row: GroupLogRow) => Promise<void>,
  persisted?: () => Promise<void>,
): Promise<GroupLogDrainResult> {
  const result: GroupLogDrainResult = { rows: 0, acked: new Map() }
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await request(GROUP_LOG_FETCH, { limit: PAGE_LIMIT })
    if (!res.ok) throw new GroupLogHttpError(res.status, GROUP_LOG_FETCH)
    const body = (await res.json()) as Partial<GroupLogPage>
    const rows = Array.isArray(body.rows) ? body.rows.filter(isRow) : []
    // Where the island says this device stands, rooms with no rows included:
    // a device's first fetch of a room creates its cursor AT THE HEAD, and a
    // live frame for the next seq can then be acked without a round trip.
    for (const [gid, seq] of readCursors(body.cursors)) noteVouched(apiBase, uin, gid, seq)
    const upto = new Map<number, number>()
    const stalled = new Set<number>()
    for (const r of rows) {
      result.rows++
      try {
        await ingest(r)
      } catch {
        // Left in front of the cursor on purpose: the island re-serves it.
        stalled.add(r.gid)
        continue
      }
      if (!stalled.has(r.gid)) upto.set(r.gid, r.seq)
    }
    if (upto.size === 0) break
    // ⚠ Before the ack, not after. The ack tells the island this device has
    // these rows; promising that while their only copy is a scheduled write
    // is how a crash in between loses messages for good.
    if (persisted) await persisted()
    let ok = false
    try {
      ok = await postAck(request, upto)
    } catch {
      ok = false
    }
    if (!ok) break
    for (const [gid, seq] of upto) {
      noteVouched(apiBase, uin, gid, seq)
      const prev = result.acked.get(gid)
      if (prev === undefined || seq > prev) result.acked.set(gid, seq)
    }
    if (!body.more) break
  }
  return result
}

/// Ack one row that arrived live over the socket (a `gmsg` frame carrying
/// `seq`), AFTER it was ingested and persisted. Only when it is the very next
/// row after what this process has already vouched for in that room: a frame
/// that skips ahead means the log holds rows this device has not fetched, and
/// acking past them would bury them under the cursor for good. The next drain
/// picks those up, and the dedup absorbs this frame's copy. Returns whether
/// an ack went out. Never throws: a lost ack costs a re-served row, not a
/// message.
export async function ackLiveGroupRow(
  apiBase: string,
  uin: number,
  request: GroupLogRequest,
  gid: number,
  seq: number,
): Promise<boolean> {
  if (!Number.isInteger(seq) || seq <= 0) return false
  const last = vouchedSeq(apiBase, uin, gid)
  if (last === undefined || seq !== last + 1) return false
  // Advanced before the request goes out, so a second frame right behind this
  // one sees the right predecessor. A lost ack then leaves the island one row
  // behind, which the next ack (or drain) moves past: the row is on disk here.
  noteVouched(apiBase, uin, gid, seq)
  try {
    return await postAck(request, new Map([[gid, seq]]))
  } catch {
    return false
  }
}

/// Forget what was vouched for on one island for one account (tests, and an
/// account that signed out: a new session starts from the island's cursor).
export function forgetVouched(apiBase: string, uin: number): void {
  vouched.delete(scopeKey(apiBase, uin))
}

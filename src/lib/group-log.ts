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
// "ack after persist" order, the contiguous-prefix rule for the ack, and the
// strike ledger that keeps one unreadable row from silencing a room.
//
// ⚠ Dual read. The legacy `/messages/queue` drain stays exactly as it is:
// it keeps serving 1:1 rows and whatever legacy group rows were written for
// this account before the island stopped producing them. The first fetch
// marks THIS DEVICE a log reader on the island (implicit, no capability
// call); the island stops writing legacy rows for the account only once every
// device that drains its legacy queue is a reader, so a device that has not
// updated yet keeps getting its rows. Both are fetched; the envelope-id dedup
// downstream absorbs any overlap.
//
// ⚠ The ack is per room and advances over the CONTIGUOUS prefix of rows that
// were processed to their end, the rule `/messages/queue/ack` enforces on the
// island for the legacy queue. Every row of the page is still handed to the
// ingest (the id dedup makes a re-served copy idempotent); a row that THREW
// stays in front of the cursor and is re-served next time, the rows behind it
// are processed now, just not vouched for yet. A `gmsg` the client cannot
// open because its `skdm` has not arrived is NOT a throw: it is held the way
// the legacy drain holds it, and acked, so a missing chain never pins a
// room's cursor forever. And a row that keeps throwing the SAME way on
// consecutive drains is, after a few of them, unreadable on this device for
// good (a v=2 row this install's device cannot open, say): it is acked past,
// so one bad row never silences a room either.
//
// ⚠ Report 981, the client half. The count of those drains has to survive the
// process, or a tab opened for two minutes at a time (one or two drains each)
// never reaches the limit and the room waits for the log's 30-day TTL: the web
// hands in a ledger on disk (group-log-strikes.ts), the CLI a file. And on
// disk it may count only what is the ROW's fault. No libsignal device, an
// island that could not be asked, a network that dropped, storage that
// refused: none of that says anything about the row, and counted across
// boots it would write off live messages after three bad starts. Those leave
// the row where it is without a strike (`notTheRowsFault`).
//
// ⚠ One stuck room must not starve the others. An island fills a page in room
// order, so a room with a long tail behind its stuck row was the whole page,
// every page, and every room after it got `more` and nothing else. Once a room
// stalls, the rest of the drain names the rooms: every other room from its
// cursor, the stalled one from the last row already served (`after`, which
// never moves the cursor), so its tail is read too. Its cursor stays in front
// of the hole until the hole opens or is written off.
//
// ⚠ ONE seq axis per room, shared by broadcasts and by rows addressed to
// OTHER members (a reaction, an skdm, a read receipt sealed to somebody
// else). Those rows are invisible to this member: the island never serves
// them here, yet they consume seqs. So a gap between two seqs this device
// has seen proves NOTHING about unfetched rows, and the live-frame ack below
// does not try to reason about it: it acks the very next seq after what this
// device has vouched for and leaves anything else to the next drain, which
// re-serves it (cheaply: the dedup absorbs the copy) and moves the cursor.
// Do not get clever here; rows addressed to others cannot be counted from
// this side.
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

/// How many CONSECUTIVE drains a row may throw the same way before it is
/// treated as unreadable on this device and acked past. Three: a transient
/// failure of the row's own (a session another tab has moved on, say) clears
/// well within that; a row that is still failing identically on the third
/// drain is not going to open on the fourth, and leaving it in front of the
/// cursor would hold every later post in the room hostage to it. Failures that
/// are not the row's fault never count (see notTheRowsFault).
export const MAX_STRIKES = 3

/// The same, whatever the failures were: a row that fails a DIFFERENT way on
/// every drain never repeats one signature MAX_STRIKES times, and was held for
/// ever. Six drains in a row of failures of its own, of any kind, and it goes.
export const MAX_ANY_STRIKES = 6

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

/// The strike ledger: per "gid/seq", how the row last failed and on how many
/// consecutive drains. Kept per (island, account). In memory by default, which
/// is right for `rcq watch` and for tests; the web hands in one on disk
/// (group-log-strikes.ts) and a short-lived CLI run a file, or a row that fails
/// identically on every run or tab would never reach the strike limit there.
export interface StrikeStore {
  read(): Record<string, StrikeEntry>
  write(strikes: Record<string, StrikeEntry>): void
}

export interface StrikeEntry {
  /// Signature of the failure: the error's class, or its message (digits
  /// blanked) for a plain Error. A row that fails DIFFERENTLY starts `n` again.
  sig: string
  n: number
  /// Consecutive drains with a failure of the row's own, whatever the
  /// signature (MAX_ANY_STRIKES). Absent in entries written before it was
  /// kept, which read it as `n`.
  any?: number
}

/// An ingest failure that says nothing about the row: the row is left in front
/// of the cursor and NO strike is counted. Throw this (or any error carrying
/// `notTheRow: true`, as DeviceUnavailableError does) for "could not be judged
/// right now": a roster the island did not hand over, a device not provisioned.
export class NotTheRowsFault extends Error {
  readonly notTheRow = true
  constructor(message: string) {
    super(message)
    this.name = 'NotTheRowsFault'
  }
}

/// DOMException names that are the browser's storage or network refusing, and
/// fetch's abort and timeout: about this device and this moment, never the row.
const NOT_THE_ROW_NAMES = new Set([
  'AbortError',
  'TimeoutError',
  'NetworkError',
  'QuotaExceededError',
  'InvalidStateError',
  'UnknownError',
  'TransactionInactiveError',
  'ReadOnlyError',
  'VersionError',
])

/// fetch's own TypeError when the network failed, as each engine words it
/// (Chrome, Firefox, Safari, Node). Any other TypeError is a bug the row trips.
const FETCH_FAILED = /^(failed to fetch|fetch failed|load failed|networkerror|the network connection|the internet connection)/i

/// Did ingest fail for a reason that is not the row's? See NotTheRowsFault.
/// Also: fetch's own network failure, and an HTTP answer that is the island
/// being unavailable or our token being stale, not a verdict (an error
/// carrying `status`: 0, 401, 408, 425, 429, 5xx).
export function notTheRowsFault(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const o = e as { notTheRow?: unknown; name?: unknown; message?: unknown; status?: unknown }
  if (o.notTheRow === true) return true
  if (typeof o.name === 'string' && NOT_THE_ROW_NAMES.has(o.name)) return true
  if (e instanceof TypeError && FETCH_FAILED.test(String(o.message))) return true
  if (e instanceof Error && typeof o.status === 'number') {
    const st = o.status
    return st === 0 || st === 401 || st === 408 || st === 425 || st === 429 || st >= 500
  }
  return false
}

/// What a drain does with a row whose ingest threw.
///  * 'wait': not the row's fault; left where it is, nothing counted.
///  * 'stall': counted; left in front of the cursor for the next drain.
///  * 'writeOff': failed its own way on enough consecutive drains; unreadable
///    here for good, to be acked past like a row that decrypted to nothing.
export type StrikeVerdict = 'wait' | 'stall' | 'writeOff'

/// Count one failure of the row `key` into `struck` and say what to do with
/// it. `again`: this row already failed earlier in the SAME drain (served on a
/// second page), which is one strike, not two. Exported for the legacy queue
/// drain, which keeps a ledger of its own the same way.
export function strikeRow(struck: Record<string, StrikeEntry>, key: string, e: unknown, again = false): StrikeVerdict {
  if (notTheRowsFault(e)) return 'wait'
  const sig = failureSig(e)
  const prev = struck[key]
  const n = prev && prev.sig === sig ? (again ? prev.n : prev.n + 1) : 1
  const any = prev ? (prev.any ?? prev.n) + (again ? 0 : 1) : 1
  if (n >= MAX_STRIKES || any >= MAX_ANY_STRIKES) {
    delete struck[key]
    console.warn('[group-log] row failed on too many drains in a row; acked past as unreadable here', { key, sig, n, any })
    return 'writeOff'
  }
  struck[key] = { sig, n, any }
  return 'stall'
}

/// Does this island keep a log per room? Reads `capabilities.group_log` off
/// the run-long /server/info cache, the way the key-lookup path reads
/// `anon_keys`. An island that did not answer (down, timed out, older than
/// /server/info) reads FALSE: the legacy queue is then the only drain, which
/// is exactly the old behaviour, and the question is asked again on the next
/// drain because a failed read is not cached (a boot that happened offline
/// therefore re-reads the capabilities the moment a drain gets through).
export async function islandHasGroupLog(apiBase: string): Promise<boolean> {
  const caps = (await fetchServerInfo(apiBase))?.capabilities
  return caps?.group_log === true
}

/// Per (island, account) the last seq this process has vouched for in each
/// room, for the live-frame ack below. Seeded from the cursors a fetch
/// reports, moved to the room's head by a COMPLETE drain (see drainGroupLog),
/// advanced by every ack. Never read for the fetch itself: the island's
/// cursor is authoritative there.
const vouched = new Map<string, Map<number, number>>()

/// Default strike ledgers, one per (island, account), for callers that pass
/// no store of their own.
const strikesInMemory = new Map<string, Record<string, StrikeEntry>>()

/// Live acks in flight, one chain per (island, account): a frame waits for
/// the one before it, so two back-to-back frames both pass the gate (the
/// second sees the first as its predecessor) and their history writes never
/// race each other.
const liveAcks = new Map<string, Promise<unknown>>()

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

function memoryStrikes(apiBase: string, uin: number): StrikeStore {
  const key = scopeKey(apiBase, uin)
  return {
    read: () => strikesInMemory.get(key) ?? {},
    write: (s) => void strikesInMemory.set(key, s),
  }
}

/// How a thrown ingest failed, for the strike ledger. The class when it has a
/// name of its own (V2SessionError, SyntaxError), the message for a plain
/// Error, so "ratchet store busy" and "bad envelope" are two different
/// failures. Digits are blanked: a message that carries a status, a count or
/// an id is the same failure every time, and counting it as a new one each
/// drain kept the row from ever reaching the limit.
function failureSig(e: unknown): string {
  if (e instanceof Error && e.name && e.name !== 'Error') return e.name
  const text = e instanceof Error ? `Error: ${e.message}` : String(e)
  return text.replace(/\d+/g, '#').slice(0, 200)
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

function readSeqs(raw: unknown): Map<number, number> {
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
/// Its second argument is when the page carrying the row arrived (local
/// clock), a moment the row was certainly on the island by.
/// `persisted` runs between the last ingest of a page and its ack (the web's
/// coalesced history write; the CLI appends synchronously and passes nothing).
/// `strikes` is the ledger of rows that threw (see StrikeStore); in memory
/// when not given.
///
/// A drain that reaches the last page (`more` false) has seen every row the
/// island holds for this device in every room it did not stall on, up to the
/// head the island reported; those rooms' vouched seqs move to their heads,
/// so a live frame for head+1 can be acked without a round trip. The cursor
/// on the island stays at the last row processed: rows between it and the
/// head were addressed to other members and were never served here.
///
/// A room that stalls is HELD for the rest of the drain: nothing more is acked
/// in it, and the pages after name the rooms (see the header): the others from
/// their cursors, the held one from the last of its rows served so far. While
/// nothing stalls the fetch names no rooms and no `after`, exactly as before.
///
/// Throws on a fetch that did not answer or answered with an error (nothing
/// was acked for that page; the next drain re-serves it). An ack that fails
/// ends the drain without throwing: the rows are on disk, the island
/// re-serves them once, and the dedup absorbs the repeat. Looping on without
/// the ack would re-fetch the same page forever, since a room's fetch reads
/// from the island's stored cursor unless it is held.
///
/// ⚠ Run this in the same serialised path as the legacy queue drain, never
/// concurrently with it or with itself: two drains racing double-fetch the
/// same page and count one failure as two strikes.
export async function drainGroupLog(
  apiBase: string,
  uin: number,
  request: GroupLogRequest,
  ingest: (row: GroupLogRow, fetchedAt: number) => Promise<void>,
  persisted?: () => Promise<void>,
  strikes?: StrikeStore,
): Promise<GroupLogDrainResult> {
  const result: GroupLogDrainResult = { rows: 0, acked: new Map() }
  const ledger = strikes ?? memoryStrikes(apiBase, uin)
  const struck = ledger.read()
  // A row re-served within ONE drain (a later page, after a stall in another
  // room moved nothing for this one) is one strike, not one per page.
  const struckNow = new Set<string>()
  let ledgerDirty = false
  // Every room the island reported a cursor for: all of the account's rooms,
  // since the first page names none.
  const rooms = new Set<number>()
  // The rooms that stalled in this drain, and the last of each one's rows
  // served so far: where its tail is read from on the next page.
  const held = new Map<number, number>()
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const body =
        held.size === 0
          ? { limit: PAGE_LIMIT }
          : {
              limit: PAGE_LIMIT,
              // The rooms that move first: an island that fills a page in the
              // order it is asked serves them before the held tails.
              rooms: [
                ...[...rooms].filter((gid) => !held.has(gid)).map((gid) => ({ gid })),
                ...[...held].map(([gid, after]) => ({ gid, after })),
              ],
            }
      const res = await request(GROUP_LOG_FETCH, body)
      if (!res.ok) throw new GroupLogHttpError(res.status, GROUP_LOG_FETCH)
      const out = (await res.json()) as Partial<GroupLogPage>
      const fetchedAt = Date.now()
      const rows = Array.isArray(out.rows) ? out.rows.filter(isRow) : []
      // Where the island says this device stands, rooms with no rows included:
      // a device's first fetch of a room creates its cursor AT THE HEAD, and a
      // live frame for the next seq can then be acked without a round trip.
      for (const [gid, seq] of readSeqs(out.cursors)) {
        rooms.add(gid)
        noteVouched(apiBase, uin, gid, seq)
      }
      const upto = new Map<number, number>()
      // Whether the next page would differ from this one: a cursor acked
      // forward, a room newly held, a held room's tail read further.
      let moved = false
      for (const r of rows) {
        result.rows++
        const key = `${r.gid}/${r.seq}`
        try {
          await ingest(r, fetchedAt)
          if (struck[key]) {
            delete struck[key]
            ledgerDirty = true
          }
        } catch (e) {
          const verdict = strikeRow(struck, key, e, struckNow.has(key))
          if (verdict !== 'wait') {
            struckNow.add(key)
            ledgerDirty = true
          }
          // Written off: acked past like a row that decrypted to nothing, so
          // the room moves on. (It stays on the island for its window; the
          // other devices of the account have their own cursors.) Otherwise
          // left in front of the cursor on purpose: the island re-serves it.
          if (verdict !== 'writeOff' && !held.has(r.gid)) {
            held.set(r.gid, r.seq)
            moved = true
          }
        }
        const tail = held.get(r.gid)
        if (tail !== undefined) {
          // Behind a hole in this room: processed now, vouched for never in
          // this drain. Its seq is where the room's next page starts.
          if (r.seq > tail) {
            held.set(r.gid, r.seq)
            moved = true
          }
          continue
        }
        upto.set(r.gid, r.seq)
      }
      if (upto.size > 0) {
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
        moved = true
        for (const [gid, seq] of upto) {
          noteVouched(apiBase, uin, gid, seq)
          const prev = result.acked.get(gid)
          if (prev === undefined || seq > prev) result.acked.set(gid, seq)
        }
      }
      if (!out.more) {
        // The last page: every room not held has been read to the head the
        // island reported (see the note above). A held room keeps its vouched
        // seq at the hole, so no live frame is acked past it.
        for (const [gid, head] of readSeqs(out.heads)) {
          if (!held.has(gid)) noteVouched(apiBase, uin, gid, head)
        }
        break
      }
      // A page that moved nothing, with more behind it: stop rather than spin
      // (the next fetch would serve the same page again).
      if (!moved) break
    }
  } finally {
    // Written whatever ended the drain: a fetch or a history write that threw
    // must not take the counts of the rows already tried with it. Less what
    // the ledger no longer needs: rows the cursor has moved past, and rows of
    // rooms this account is not in any more (the island reports a cursor for
    // every room it is in).
    for (const key of Object.keys(struck)) {
      const [g, s] = key.split('/').map(Number)
      const last = vouchedSeq(apiBase, uin, g)
      if ((last !== undefined && s <= last) || (rooms.size > 0 && !rooms.has(g))) {
        delete struck[key]
        ledgerDirty = true
      }
    }
    if (ledgerDirty) ledger.write(struck)
  }
  return result
}

/// Ack one row that arrived live over the socket (a `gmsg` frame carrying
/// `seq`), once it was ingested. Only when it is the very next row after
/// what this process has already vouched for in that room (the header on the
/// shared seq axis says why nothing smarter is possible): a frame that skips
/// ahead is left to the next drain, and so is a frame for a room this run
/// has not fetched yet. `persisted` (the web's history flush) runs ONLY when
/// the gate passes, and before the ack goes out: a refused frame costs no
/// write, and an ack never vouches for a write that did not land. Returns
/// whether an ack went out. Never throws: a lost ack costs a re-served row,
/// not a message.
export function ackLiveGroupRow(
  apiBase: string,
  uin: number,
  request: GroupLogRequest,
  gid: number,
  seq: number,
  persisted?: () => Promise<void>,
): Promise<boolean> {
  const key = scopeKey(apiBase, uin)
  const run = (liveAcks.get(key) ?? Promise.resolve()).then(async () => {
    if (!Number.isInteger(seq) || seq <= 0) return false
    const last = vouchedSeq(apiBase, uin, gid)
    if (last === undefined || seq !== last + 1) return false
    if (persisted) {
      try {
        await persisted()
      } catch {
        return false
      }
    }
    // Advanced before the request goes out, so the frame right behind this
    // one sees the right predecessor. A lost ack then leaves the island one
    // row behind, which the next ack (or drain) moves past: the row is on
    // disk here.
    noteVouched(apiBase, uin, gid, seq)
    try {
      return await postAck(request, new Map([[gid, seq]]))
    } catch {
      return false
    }
  })
  liveAcks.set(
    key,
    run.catch(() => false),
  )
  return run
}

/// Forget what was vouched for (and struck) on one island for one account:
/// tests, and an account that signed out, whose next session starts from
/// the island's cursor.
export function forgetVouched(apiBase: string, uin: number): void {
  vouched.delete(scopeKey(apiBase, uin))
  strikesInMemory.delete(scopeKey(apiBase, uin))
}

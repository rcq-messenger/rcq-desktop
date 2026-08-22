// Reading back what was already said.
//
// A terminal has no scrollback across restarts, and the CLI's only history
// surface was `rcq export`, which prints a path and a line count. Everything
// is already on disk: `history-<uin>.jsonl` holds every message this account
// has received or sent from here, with its time, its thread and its envelope.
// The data was sitting there; nothing read it.
//
// It matters twice over now that rooms work. A room that is not open keeps a
// count rather than a feed, and this is where the feed went.

import fs from 'node:fs'
import type { WebIdentity } from '../../src/lib/crypto'
import { foreignHost, groupLabel, peerLabel } from './directory'
import { chatLine, stripAnsi } from './format'
import { describeEnvelope, historyPath, type HistoryRecord } from './receive'
import { out } from './style'

/// Which thread to read: one person, one room, or everything.
export type Thread = { kind: 'peer'; uin: number } | { kind: 'group'; gid: number } | null

export interface LogRow extends HistoryRecord {
  /// The thread this row belongs to, as the reader thinks of it: the other
  /// person in a 1:1 (whoever that is, in either direction), or the room.
  thread: Thread
}

function threadOf(myUin: number, rec: HistoryRecord): Thread {
  if (typeof rec.gid === 'number') return { kind: 'group', gid: rec.gid }
  if (rec.from !== myUin) return { kind: 'peer', uin: rec.from }
  if (typeof rec.to === 'number') return { kind: 'peer', uin: rec.to }
  return null
}

function sameThread(a: Thread, b: Thread): boolean {
  if (a === null || b === null) return false
  if (a.kind === 'peer' && b.kind === 'peer') return a.uin === b.uin
  if (a.kind === 'group' && b.kind === 'group') return a.gid === b.gid
  return false
}

/// The last `limit` rows of a thread, oldest first (reading order).
///
/// The whole file is read: it is append-only plain text a person can also
/// `tail` themselves, and the alternative is an index to keep in step with it.
/// A torn tail line is skipped in silence: the row it described was never
/// vouched for (see the durable-before-ack note in receive.ts).
///
/// ⚠ Sorted by time, NOT left in the order the lines were appended, and the
/// reason is that the file honestly holds two clocks. Our own sends and
/// anything opened off the live socket are stamped from this machine; a
/// message pulled out of the offline queue keeps the island's `received_at`,
/// which is right (it is roughly when the sender actually sent it) but is not
/// the same clock. On a box 16 seconds ahead of prod (measured, 2026-08-22)
/// append order and timestamp order disagree, and a recap printed 07:44:39
/// above 07:44:37 with the two lines the wrong way round. `slice(-limit)` made
/// it worse than cosmetic: the "last 8 lines" could drop the newest message
/// and keep an older one. Whatever the clocks do, what prints must agree with
/// the times printed beside it.
export function readLog(myUin: number, thread: Thread, limit: number): LogRow[] {
  let text: string
  try {
    text = fs.readFileSync(historyPath(myUin), 'utf8')
  } catch {
    return []
  }
  const rows: LogRow[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    let rec: HistoryRecord
    try {
      rec = JSON.parse(line) as HistoryRecord
    } catch {
      continue
    }
    const t = threadOf(myUin, rec)
    if (thread && !sameThread(t, thread)) continue
    rows.push({ ...rec, thread: t })
  }
  // Stable, so rows sharing a timestamp (or carrying an unreadable one, which
  // parses to NaN and compares equal to everything) keep the order they were
  // written in rather than being shuffled.
  rows.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))
  return limit > 0 ? rows.slice(-limit) : rows
}

/// `#396` / `g21`: how a thread is written where a script will read it.
export function threadTag(t: Thread): string {
  if (!t) return '-'
  return t.kind === 'peer' ? `#${t.uin}` : `g${t.gid}`
}

/// Parse `396` or `g21` into a thread. Null for anything else, including an
/// empty string, so the caller can say what it wanted.
export function parseThread(token: string): Thread {
  const s = token.trim()
  if (/^g\d+$/i.test(s)) return { kind: 'group', gid: Number(s.slice(1)) }
  const uin = Number(s)
  return Number.isInteger(uin) && uin > 0 ? { kind: 'peer', uin } : null
}

/// One tab-separated row for stdout: time, sender, thread, text. Newlines and
/// tabs inside a message are escaped so a row stays a row, because a multi-line
/// message must not turn into three records nothing can pair up again.
export function logRowData(r: LogRow): string {
  const text = describeEnvelope(r.envelope).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
  return `${r.at}\t${r.from}\t${threadTag(r.thread)}\t${text}`
}

/// Who a row is from, written the way the live stream writes it: `me -> [Room]`
/// for our own, `[Room] Ivan (#396)` for somebody else's.
///
/// ⚠ The host goes through `foreignHost`. Every v=1 envelope carries one, our
/// own island included, so the raw field would label half the file
/// `#500@api.rcq.app`.
function rowWho(identity: WebIdentity, r: LogRow): string {
  const myUin = identity.uin
  const room = r.thread?.kind === 'group' ? `[${groupLabel(myUin, r.thread.gid)}]` : null
  // ⚠ Our own 1:1 rows name the recipient too. A bare `me:` is readable inside
  // one thread and useless in `/log` with no thread picked, where consecutive
  // rows belong to different people.
  const dest = room ?? (typeof r.to === 'number' ? peerLabel(myUin, r.to) : null)
  return r.from === myUin
    ? `me${dest ? ` -> ${dest}` : ''}`
    : `${room ? `${room} ` : ''}${peerLabel(myUin, r.from, foreignHost(identity, r.host))}`
}

/// The same row for a person: the live line's exact shape, dimmed whole so a
/// replay of what was already said cannot be mistaken for something new.
/// ⚠ The line is stripped before it is dimmed: `chatLine` dims its own
/// timestamp, and a nested dim closes the attribute a third of the way in, so
/// the rest of a "this is old" line came back bright.
export function logRowHuman(identity: WebIdentity, r: LogRow): string {
  return out.dim(stripAnsi(chatLine(r.at, rowWho(identity, r), describeEnvelope(r.envelope))))
}

/// The threads with the most recent traffic, newest first: one row each,
/// carrying the last thing said in it.
///
/// A chat client opens on the list of conversations. This one opened on an
/// empty prompt and a `/to <uin>` you had to remember the number for, while
/// every thread it has ever had was sitting in the history file.
export function recentThreads(myUin: number, limit: number): LogRow[] {
  const last = new Map<string, LogRow>()
  for (const r of readLog(myUin, null, 0)) {
    if (r.thread) last.set(threadTag(r.thread), r)
  }
  return [...last.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit)
}

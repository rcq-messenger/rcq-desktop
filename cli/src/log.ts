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

/// The same row for a person: dimmed, with the date only when it is not today.
///
/// ⚠ The host goes through `foreignHost`. Every v=1 envelope carries one, our
/// own island included, so the raw field would label half the file
/// `#500@api.rcq.app`.
export function logRowHuman(identity: WebIdentity, r: LogRow): string {
  const myUin = identity.uin
  const at = new Date(r.at)
  const today = new Date().toDateString() === at.toDateString()
  const when = today ? at.toTimeString().slice(0, 8) : `${at.toISOString().slice(0, 10)} ${at.toTimeString().slice(0, 5)}`
  const room = r.thread?.kind === 'group' ? `[${groupLabel(myUin, r.thread.gid)}]` : null
  const who =
    r.from === myUin
      ? `me${room ? ` -> ${room}` : ''}`
      : `${room ? `${room} ` : ''}${peerLabel(myUin, r.from, foreignHost(identity, r.host))}`
  return out.dim(`[${when}] ${who}: ${describeEnvelope(r.envelope)}`)
}

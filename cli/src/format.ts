// What a printed line looks like, decided in one place.
//
// The stream mixes four kinds of row (somebody's message, one of ours, a note
// about one of ours (delivered, refused), and a line replayed out of the
// history file) and each was built inline where it happened, in three files.
// They drifted: the same conversation printed one shape live and another out
// of `/log`. Everything that reaches a person now comes through here.
//
// The clock is the second half of the same problem. `new Date()` at ingest is
// right for a live message and wrong for a backlog: drain two days of queue and
// the whole thing prints with today's time, in arrival order, with no date
// anywhere. Android carried exactly this as #628. The island stamps every
// queue row with `received_at`, so a line can say when the message actually
// landed, and carry the date when that was not today.

import { out } from './style'

/// The island sends `received_at` as ISO 8601. A tz-aware column answers with
/// an offset and needs nothing; a naive one would be read as LOCAL time by
/// `new Date`, which quietly shifts a whole backlog by the machine's offset, so
/// so a stamp with no zone is read as UTC, which is what every island stores.
function parseAt(at: Date | string | number): Date {
  if (at instanceof Date) return at
  if (typeof at === 'number') return new Date(at)
  const s = at.trim()
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)
  return new Date(zoned || !/^\d{4}-\d{2}-\d{2}T/.test(s) ? s : `${s}Z`)
}

/// A timestamp a person reads: the clock alone for today, the date as well for
/// anything older. Callers pass the moment the message HAPPENED wherever they
/// know it (the island's `received_at`, the history row's own `at`); only live
/// traffic falls back to now.
export function when(at?: Date | string | number): string {
  const d = at === undefined ? new Date() : parseAt(at)
  if (Number.isNaN(d.getTime())) return new Date().toTimeString().slice(0, 8)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toTimeString().slice(0, 8) : `${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 5)}`
}

/// The shape of every message row: `[14:03:22] Ivan (#396): hey`. `who` and
/// `body` arrive already coloured: this decides the layout, not the palette.
export function chatLine(at: Date | string | undefined, who: string, body: string): string {
  return `${out.dim(`[${when(at)}]`)} ${who}: ${body}`
}

/// A note ABOUT a message rather than a message: the delivery tick, a refusal.
/// Same left edge as a chat line, so the column of timestamps never breaks.
export function noteLine(text: string): string {
  return `${out.dim(`[${when()}]`)} ${text}`
}

/// Enough of a message to recognise which one is meant, on one line. The
/// delivery note used to name only the peer, so two messages to the same
/// person produced two identical ticks.
export function snippet(text: string, max = 32): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/// Pad or trim to an exact width, so a list of rows reads as columns. Trimming
/// is part of the job: a 40-character room name must not push the rest of the
/// row onto a second line and turn a list into a paragraph.
export function pad(s: string, width: number): string {
  return s.length <= width ? s.padEnd(width) : `${s.slice(0, width - 1)}…`
}

/// The width of the column that holds the HANDLES (`#396`, `g21`), which is
/// wide enough for the longest one present.
///
/// ⚠ An identifier is never trimmed. A ten-digit uin cut to `#10020030…` is a
/// number nobody can type back, and losing a column of alignment on one row is
/// the cheaper of the two.
export function idColumn(tags: string[], min = 7): number {
  return Math.max(min, ...tags.map((t) => t.length))
}

/// How wide the terminal is, with the width every non-tty gets when it will
/// not say (a pipe reads `columns` as undefined).
export function columns(): number {
  return process.stdout.columns && process.stdout.columns > 20 ? process.stdout.columns : 80
}

const ANSI = /\x1b\[[0-9;]*m/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '')
}

/// How many terminal rows a string occupies at this width.
///
/// Characters, not display columns: a CJK glyph or an emoji is two columns
/// wide and the answer is then one row short. That is deliberate: the
/// alternative is carrying a width table so a prompt can be redrawn, and the
/// cost is a stray row on screen, never a lost message.
export function displayRows(s: string, columns: number): number {
  if (columns <= 0) return 1
  return Math.max(1, Math.ceil(stripAnsi(s).length / columns))
}

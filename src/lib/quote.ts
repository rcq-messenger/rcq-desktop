// Reading a reply quote off the wire. Shared by the received and the carbon
// halves (incoming-store.ts, outgoing-store.ts), which cannot import each other.

import type { ReplyContext } from './crypto'

/// A quote off the wire, only when it has the shape every client writes
/// (`{id, snippet, authorName}`, all strings). The kinds typed as carrying one
/// are trusted as before; this guards the ones that arrive loosely.
export function quoteOf(raw: unknown): { replyTo: ReplyContext } | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  return {
    replyTo: {
      id: r.id,
      snippet: typeof r.snippet === 'string' ? r.snippet : '',
      authorName: typeof r.authorName === 'string' ? r.authorName : '',
    },
  }
}

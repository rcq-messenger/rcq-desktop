// The outgoing (fromMe) message log, per thread. Historically this lived
// entirely inside Chat.tsx component state + localStorage. It moved here so
// the multi-device CARBON receive path can also file fromMe messages into a
// thread's log even when Chat isn't the one mounted on that thread.
//
// A carbon is a message the user sent from ANOTHER device, sealed to their
// own identity and echoed back here (see CarbonEnvelope). When one arrives we
// file its inner envelope as a `sent` outgoing row in the destination thread,
// deduped by the inner message's id (so the origin device — which already has
// the row — no-ops its own carbon).

import type { Envelope, CarbonEnvelope, ReplyContext } from './crypto'

export interface OutgoingRow {
  id: string
  text: string
  sentAt: number
  state: 'sending' | 'sent' | 'failed'
  error?: string
  /// Photo / video / file attachment, or a still-unsupported media kind echoed
  /// from another device via a carbon ('other' — voice/location the web can't
  /// render but should still show as "you sent this elsewhere").
  kind?: 'text' | 'photo' | 'video' | 'file' | 'other'
  mediaId?: string
  mediaKey?: string
  mediaKind?: string // for 'other': the original envelope kind
  thumbnailB64?: string // for 'video': base64 JPEG poster
  durationSec?: number // for 'video': length in seconds
  fileName?: string // for 'file': original name
  fileMime?: string // for 'file': content type
  fileSize?: number // for 'file': plaintext byte length
  /// Snippet of the message we're replying to + author.
  replyTo?: ReplyContext
  /// Original author nickname when this row is a forward.
  fwdName?: string
  /// Deprecated: the old outgoing-only reaction badge. Kept so rows persisted
  /// before the shared reactions store still parse.
  myReaction?: string
  /// Author edited this message after sending.
  edited?: boolean
}

/// Per-thread storage key for the outgoing log. Keys look like
/// `rcq.web.outgoing.peer.123` / `.group.42`.
export function storageKey(isGroup: boolean, idNum: number): string {
  return `rcq.web.outgoing.${isGroup ? 'group' : 'peer'}.${idNum}`
}

/// Cap on persisted rows per thread so localStorage stays bounded.
export const MAX_PERSISTED_ROWS = 200

export function loadPersisted(key: string): OutgoingRow[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const arr = JSON.parse(raw) as OutgoingRow[]
    // 'sending' rows from a previous session were never delivered — surface
    // them as failed on rehydrate so the user retries.
    return arr.map((r) => (r.state === 'sending' ? { ...r, state: 'failed' } : r))
  } catch {
    return []
  }
}

export function savePersisted(key: string, rows: OutgoingRow[]) {
  const trimmed = rows.length > MAX_PERSISTED_ROWS ? rows.slice(rows.length - MAX_PERSISTED_ROWS) : rows
  try {
    localStorage.setItem(key, JSON.stringify(trimmed))
  } catch {
    // QuotaExceeded etc. — skip. The in-memory log still works.
  }
}

/// Append a row to a thread's persisted outgoing log without going through
/// component state. Deduped by id (a carbon for a message this device already
/// logged is a no-op). Used by forwarding and the carbon receive path.
export function appendToThreadLog(key: string, row: OutgoingRow): void {
  const existing = loadPersisted(key)
  if (existing.some((r) => r.id === row.id)) return
  savePersisted(key, [...existing, row])
}

// ── Open-thread sink ────────────────────────────────────────────────
// While Chat is mounted on a thread it OWNS that thread's outgoing rows in
// component state. A carbon for the open thread is handed to the live sink so
// the row appears instantly; carbons for any other thread are written to that
// thread's localStorage log (revealed when the user navigates there). This
// split keeps the open thread's in-flight 'sending' rows safe from a reload.

let _openThreadKey: string | null = null
let _openThreadSink: ((row: OutgoingRow) => void) | null = null

/// Chat registers (threadKey, sink) on mount and clears it (null, null) on
/// unmount. The sink merges a row into Chat state, deduping by id.
export function setOutgoingSink(threadKey: string | null, sink: ((row: OutgoingRow) => void) | null): void {
  _openThreadKey = threadKey
  _openThreadSink = sink
}

/// Build a `sent` outgoing row from a carbon's inner envelope. Returns null
/// for kinds we don't surface (e.g. a nested reaction — reactions sync via
/// their own self-echo, never as a carbon).
function outgoingRowFromInner(inner: Envelope): OutgoingRow | null {
  if (inner.kind === 'text') {
    return {
      id: inner.id,
      text: inner.text,
      sentAt: Date.now(),
      state: 'sent',
      kind: 'text',
      ...(inner.reply ? { replyTo: inner.reply } : {}),
      ...(inner.fwdName ? { fwdName: inner.fwdName } : {}),
    }
  }
  if (inner.kind === 'photo') {
    return {
      id: inner.id,
      text: inner.caption ?? '',
      sentAt: Date.now(),
      state: 'sent',
      kind: 'photo',
      mediaId: inner.mediaID,
      mediaKey: inner.mediaKey,
      ...(inner.reply ? { replyTo: inner.reply } : {}),
      ...(inner.fwdName ? { fwdName: inner.fwdName } : {}),
    }
  }
  // Video sent from another device (#15): keep the media ref + poster so the
  // web renders + plays it as a fromMe row, not a bare placeholder.
  if (inner.kind === 'video') {
    return {
      id: inner.id,
      text: inner.caption ?? '',
      sentAt: Date.now(),
      state: 'sent',
      kind: 'video',
      mediaId: inner.mediaID,
      mediaKey: inner.mediaKey,
      thumbnailB64: inner.thumbnailB64,
      durationSec: inner.durationSec,
      ...(inner.reply ? { replyTo: inner.reply } : {}),
      ...(inner.fwdName ? { fwdName: inner.fwdName } : {}),
    }
  }
  // File / document sent from another device (#16): keep the media ref + name/
  // mime/size for the download chip.
  if (inner.kind === 'file') {
    return {
      id: inner.id,
      text: inner.caption ?? '',
      sentAt: Date.now(),
      state: 'sent',
      kind: 'file',
      mediaId: inner.mediaID,
      mediaKey: inner.mediaKey,
      fileName: inner.fname,
      fileMime: inner.mime,
      fileSize: inner.size,
      ...(inner.reply ? { replyTo: inner.reply } : {}),
      ...(inner.fwdName ? { fwdName: inner.fwdName } : {}),
    }
  }
  // A still-unsupported media kind sent from another device (voice/location).
  // The web can't render these, but show a placeholder so the user sees that
  // they sent something here rather than a silent gap.
  const loose = inner as { kind?: string; id?: string; caption?: string }
  if (loose.id && (loose.kind === 'voice' || loose.kind === 'location')) {
    return { id: loose.id, text: loose.caption ?? '', sentAt: Date.now(), state: 'sent', kind: 'other', mediaKind: loose.kind }
  }
  return null
}

/// Handle a decrypted carbon: file its inner envelope as a fromMe row in the
/// destination thread. Idempotent by inner id (the origin device no-ops its
/// own carbon). Called from the receive dispatch for kind==='carbon'.
export function fileOutgoingCarbon(carbon: CarbonEnvelope): void {
  const threadKey =
    carbon.gid != null ? storageKey(true, carbon.gid) : carbon.to != null ? storageKey(false, carbon.to) : null
  if (!threadKey) return
  const row = outgoingRowFromInner(carbon.env)
  if (!row) return
  if (_openThreadKey === threadKey && _openThreadSink) {
    _openThreadSink(row) // Chat merges into state (dedup by id) + persists
  } else {
    appendToThreadLog(threadKey, row) // dedup + localStorage for a non-open thread
  }
}

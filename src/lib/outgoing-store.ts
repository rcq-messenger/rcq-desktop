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

import { scopedKey } from './account-scope'
import { isSealedText, openText, sealText } from './pin-seal'
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
  /// 'call' is not a message at all: it is the record a finished call leaves
  /// in the conversation, the way both phones write one. It never goes on the
  /// wire — each device logs its own — and it renders as a centred line rather
  /// than a bubble.
  kind?: 'text' | 'photo' | 'video' | 'file' | 'other' | 'call'
  /// For 'call': nobody picked up (or it was declined). Drives the icon.
  callMissed?: boolean
  /// For 'call': the island the other party lives on, when it is not ours
  /// (§5d). A 1:1 thread's log is keyed by the BARE uin here, so the thread for
  /// `1234@is2.rcq.app` and the thread for a local #1234 are the same log —
  /// two different people, one key. A call is the one row that has to be told
  /// apart, because a cross-island call now really happens and filing it under
  /// the bare number puts "you called them for 4 minutes" in a stranger's
  /// conversation. Absent means the peer is on our own island.
  peerHost?: string
  mediaId?: string
  mediaKey?: string
  mediaKind?: string // for 'other': the original envelope kind
  /// Coordinates, for mediaKind === 'location'. No blob is involved: a point is
  /// small enough to ride in the envelope, which the phones have always done.
  lat?: number
  lng?: number
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

/// Per-thread storage key for the outgoing log, inside the ACTIVE account's
/// scope: `rcq.web.<uin>.outgoing.peer.123` / `.group.42`.
///
/// It used to be flat, which was fine while a browser could only ever hold one
/// account — and would have merged two conversations into one the moment it
/// could hold two.
export function storageKey(isGroup: boolean, idNum: number): string {
  return scopedKey(`outgoing.${isGroup ? 'group' : 'peer'}.${idNum}`)
}

/// Cap on persisted rows per thread so localStorage stays bounded.
///
/// Raised from 200: incoming messages live in IndexedDB with no cap at all, so
/// the two halves of a conversation aged out at wildly different rates — in an
/// active thread your own side simply vanished after a reload while the other
/// person's stayed, which reads as lost history rather than as a cap. A text
/// row is a few hundred bytes, so a couple of thousand of them is still small
/// next to the 5 MB localStorage budget.
export const MAX_PERSISTED_ROWS = 2000

// ── the desktop PIN ──────────────────────────────────────────────────────────
//
// Sealing these logs is not optional once the received half is sealed: half a
// conversation in the clear reads back as the whole conversation. But the
// readers are synchronous — Chat.tsx builds its state from `loadPersisted`
// during a render — and AES-GCM is not. So while a PIN is on, the decrypted
// logs live in memory for the life of the window (filled once, behind the lock
// screen, before anything renders) and the disk only ever sees ciphertext.
// Same shape the cross-island request store already uses, for the same reason.
let mem: Map<string, OutgoingRow[]> | null = null

/// Every outgoing log in this browser, whichever account it belongs to — a PIN
/// is set on a computer, not on an account.
function outgoingKeys(): string[] {
  const out: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith('rcq.web.') && k.includes('outgoing.')) out.push(k)
  }
  return out
}

function parseRows(text: string): OutgoingRow[] {
  try {
    const arr = JSON.parse(text) as OutgoingRow[]
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/// Read every log into memory and make sure what stays on disk is sealed.
/// Called once, right after the PIN opens the vault and before the app renders.
export async function adoptSealedOutgoing(): Promise<void> {
  const next = new Map<string, OutgoingRow[]>()
  for (const k of outgoingKeys()) {
    const raw = localStorage.getItem(k)
    if (raw == null) continue
    if (isSealedText(raw)) {
      const text = await openText(raw)
      // A blob that will not open belongs to a key that is gone. Leaving it
      // alone is the only non-destructive answer: the thread shows empty, and
      // nothing overwrites what might still be recoverable.
      if (text != null) next.set(k, parseRows(text))
      continue
    }
    // Plain, from before the PIN: take it into memory and seal it in place.
    const rows = parseRows(raw)
    next.set(k, rows)
    const sealed = await sealText(JSON.stringify(rows))
    if (sealed) localStorage.setItem(k, sealed)
  }
  mem = next
}

/// Put the logs back on the disk in the clear and stop holding them. Called
/// when the PIN is switched off, where the whole point is that the data
/// becomes readable again.
export async function releaseSealedOutgoing(): Promise<void> {
  for (const k of outgoingKeys()) {
    const raw = localStorage.getItem(k)
    if (raw == null || !isSealedText(raw)) continue
    const text = (await openText(raw)) ?? (mem?.has(k) ? JSON.stringify(mem.get(k)) : null)
    if (text != null) localStorage.setItem(k, text)
  }
  mem = null
}

export function loadPersisted(key: string): OutgoingRow[] {
  try {
    const arr = mem ? mem.get(key) : (() => {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as OutgoingRow[]) : null
    })()
    if (!arr) return []
    // 'sending' rows from a previous session were never delivered — surface
    // them as failed on rehydrate so the user retries.
    return arr.map((r) => (r.state === 'sending' ? { ...r, state: 'failed' } : r))
  } catch {
    return []
  }
}

export function savePersisted(key: string, rows: OutgoingRow[]) {
  const trimmed = rows.length > MAX_PERSISTED_ROWS ? rows.slice(rows.length - MAX_PERSISTED_ROWS) : rows
  if (mem) {
    // Memory first, so a reader in the same tick sees the row whether or not
    // the seal has finished. The disk write is fire-and-forget by necessity.
    mem.set(key, trimmed)
    void sealText(JSON.stringify(trimmed))
      .then((sealed) => {
        if (sealed) localStorage.setItem(key, sealed)
      })
      .catch(() => {})
    return
  }
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

/// Write the record of a finished call into a 1:1 thread.
///
/// The phones have always done this (Android `Session.logCallHistory`, iOS
/// `CallService.logCallEnded`); the desktop showed nothing at all, so a call
/// you took there left no trace in the conversation — founder: "на десктопе нет
/// системных сообщений о звонках, которые есть в приложениях".
///
/// Local by definition: no envelope, no delivery state, and the row is written
/// on BOTH sides independently. If the open thread is this one, the live sink
/// puts it on screen immediately; otherwise it lands in that thread's log and
/// appears when the user opens it.
/// `host` is the peer's island when the call crossed one (§5d). It is carried
/// on the ROW rather than in the storage key on purpose: the key is the whole
/// thread's, and moving it would take every message in that thread with it —
/// out of the backup enumerator (which parses the uin straight out of the key)
/// and out of every log this device has already written. The thread stays where
/// it is; the row says whose call it was, and `Chat` shows it in that person's
/// conversation only.
export function logCall(
  peerUin: number,
  text: string,
  missed: boolean,
  at: number,
  host?: string | null,
): void {
  const row: OutgoingRow = {
    // The host is part of the id too: two calls with the same peer number on
    // two islands in the same millisecond is not a real scenario, but a
    // dedup-by-id that treats them as one row is a wrong row, not a missing one.
    id: `call-${at}-${peerUin}${host ? `@${host}` : ''}`,
    text,
    sentAt: at,
    state: 'sent',
    kind: 'call',
    callMissed: missed,
    ...(host ? { peerHost: host } : {}),
  }
  const key = storageKey(false, peerUin)
  appendToThreadLog(key, row)
  if (_openThreadKey === key) _openThreadSink?.(row)
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
    const geo = loose as { lat?: number; lng?: number }
    return {
      id: loose.id,
      text: loose.caption ?? '',
      sentAt: Date.now(),
      state: 'sent',
      kind: 'other',
      mediaKind: loose.kind,
      ...(geo.lat != null && geo.lng != null ? { lat: geo.lat, lng: geo.lng } : {}),
    }
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

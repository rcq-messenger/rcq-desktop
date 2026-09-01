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
import { expiryFrom, lapsed, sendAnchorMs } from './disappearing'
import { forgetCachedImage } from './media'

export interface OutgoingRow {
  id: string
  text: string
  sentAt: number
  /// 'delivered'/'read' arrive as receipts from the peer (#636/#637) and only
  /// ever climb: sent -> delivered -> read, never back down (a delivered
  /// receipt straggling in after a read one must not un-read the row).
  state: 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
  error?: string
  /// Photo / video / file attachment, or a still-unsupported media kind echoed
  /// from another device via a carbon ('other' — voice/location the web can't
  /// render but should still show as "you sent this elsewhere").
  /// 'call' is not a message at all: it is the record a finished call leaves
  /// in the conversation, the way both phones write one. It never goes on the
  /// wire — each device logs its own — and it renders as a centred line rather
  /// than a bubble.
  ///
  /// ⚠ 'poll' is a LEGACY value. Polls were cut from this client (founder item
  /// 14a) and nothing composes one any more; rows written before that still
  /// carry the kind, and they draw as the "no longer supported" placeholder
  /// rather than disappearing out from under a conversation.
  kind?: 'text' | 'photo' | 'video' | 'file' | 'voice' | 'other' | 'call' | 'poll'
  /// For 'call': nobody picked up (or it was declined). Drives the icon.
  callMissed?: boolean
  /// For 'call': which call this row records. Present so two records of ONE
  /// call collapse into one row: this client's own, written when the ring
  /// ends, and the caller's `call_missed` marker (§5d) for the same call
  /// arriving off the queue. The row id is derived from it, so the dedupe is
  /// `appendToThreadLog`'s existing id check rather than a second scan.
  callId?: string
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
  /// Disappearing message (founder item 20): epoch ms after which this row is
  /// swept from state, from localStorage and out of any backup export. Absent =
  /// permanent. For my own messages the anchor is simply `sentAt`: the send
  /// time is not something this side has to guess at.
  expiresAt?: number
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

/// Exactly what is stored for a thread, with nothing filtered or rewritten.
/// Only the sweeper wants this: every other reader wants `loadPersisted`, which
/// hides what has already expired.
function rawRows(key: string): OutgoingRow[] {
  try {
    const arr = mem ? mem.get(key) : (() => {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as OutgoingRow[]) : null
    })()
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/// Every outgoing thread of the ACTIVE account, for the global search.
/// Enumerates the scoped keys (localStorage plus, under a PIN seal, the
/// in-memory overlay) rather than asking the server anything: the search
/// runs over what this device already holds, nothing else.
export function allOutgoingThreads(): { isGroup: boolean; id: number; rows: OutgoingRow[] }[] {
  const prefix = scopedKey('outgoing.')
  const keys = new Set<string>()
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(prefix)) keys.add(k)
    }
  } catch {
    /* storage can be unavailable (private mode teardown); mem still serves */
  }
  if (mem) for (const k of mem.keys()) if (k.startsWith(prefix)) keys.add(k)
  const out: { isGroup: boolean; id: number; rows: OutgoingRow[] }[] = []
  for (const k of keys) {
    const m = k.slice(prefix.length).match(/^(peer|group)\.(\d+)$/)
    if (!m) continue
    out.push({ isGroup: m[1] === 'group', id: Number(m[2]), rows: loadPersisted(k) })
  }
  return out
}

export function loadPersisted(key: string): OutgoingRow[] {
  const now = Date.now()
  return (
    rawRows(key)
      // Disappearing messages whose deadline passed while this thread was
      // closed (or this browser was). Filtered on READ as well as by the
      // sweeper below, so a row can never be painted once and then taken away.
      // Opening a chat must not flash a message that is already gone.
      .filter((r) => !lapsed(r.expiresAt, now))
      // 'sending' rows from a previous session were never delivered — surface
      // them as failed on rehydrate so the user retries.
      .map((r) => (r.state === 'sending' ? { ...r, state: 'failed' } : r))
  )
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

/// Drop every persisted outgoing row whose disappearing deadline has passed,
/// across EVERY thread this browser holds, including the ones nobody has
/// opened. Returns the ids that went, so the caller can take the metadata that
/// belongs to them with it (the reaction store lives in `incoming-store`, keyed
/// by message id, and the import between the two only goes one way).
///
/// ⚠ Deliberately a sweep over all the keys rather than something the open
/// chat does: a message you sent an hour ago with a one-hour timer has to stop
/// existing whether or not you happen to be looking at that conversation, and
/// the disk copy is the one that outlives the tab. `Chat` handles the rows it
/// owns in component state on the same interval; this handles the rest.
///
/// Called from the single sweeper timer in `incoming-store`, so the two halves
/// of a conversation never expire a few seconds apart on screen.
export function sweepExpiredOutgoing(now: number = Date.now()): string[] {
  const removed: string[] = []
  for (const k of outgoingKeys()) {
    // ⚠ `rawRows`, not `loadPersisted`. The loader already hides expired rows,
    // so a sweep built on it would compare a filtered list against itself,
    // find nothing to do and never write: the rows would stay on disk
    // forever while looking gone on screen.
    const rows = rawRows(k)
    const kept = rows.filter((r) => !lapsed(r.expiresAt, now))
    if (kept.length === rows.length) continue
    for (const r of rows) {
      if (!lapsed(r.expiresAt, now)) continue
      removed.push(r.id)
      // The decrypted picture goes with the row. It was cached under the media
      // id + key when it was first painted and nothing else ever invalidates
      // that entry, so a photo I sent with a timer on it would otherwise stay
      // readable on this disk long after the bubble went.
      if (r.kind === 'photo' && r.mediaId && r.mediaKey) void forgetCachedImage(r.mediaId, r.mediaKey)
    }
    savePersisted(k, kept)
  }
  return removed
}

/// The deadline a row I am sending right now should carry, given this thread's
/// timer. Anchored to `sentAt`, which for my own message IS the send time.
export function ownExpiry(ttlSeconds: number | null, sentAt: number): number | undefined {
  return expiryFrom(ttlSeconds, sentAt)
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
  callId?: string,
): void {
  const row: OutgoingRow = {
    // ⚠ DERIVED FROM THE CALL ID when there is one, so that two records of the
    // same call collapse: the one this client writes when the ring ends, and
    // the caller's `call_missed` marker for it arriving off the queue a moment
    // later (the two overlap whenever this client's socket comes back inside
    // the second the caller spent depositing). `appendToThreadLog` already
    // refuses a row whose id it holds, so the id IS the dedupe.
    //
    // Without one, the timestamp shape stands: the host is part of it too,
    // because two calls with the same peer number on two islands in the same
    // millisecond is not a real scenario, but a dedup-by-id that treats them
    // as one row is a wrong row, not a missing one.
    id: callId ? `call-id-${callId}` : `call-${at}-${peerUin}${host ? `@${host}` : ''}`,
    text,
    sentAt: at,
    state: 'sent',
    kind: 'call',
    callMissed: missed,
    ...(callId ? { callId } : {}),
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

// ── Receipts (#636/#637) ────────────────────────────────────────────────────

/// How far along the delivery ladder a state is. Receipts only move a row UP:
/// 'failed'/'sending' rows never got an id to the peer, so a receipt cannot
/// name them at all.
const STATE_RANK: Record<OutgoingRow['state'], number> = {
  sending: 0,
  failed: 0,
  sent: 1,
  delivered: 2,
  read: 3,
}

let _openThreadReceiptSink: ((ids: string[], state: 'delivered' | 'read') => void) | null = null

/// Chat registers this alongside setOutgoingSink: the open thread OWNS its
/// rows in component state, so a receipt for it must land there (the state
/// write below would be silently overwritten by Chat's own persist effect).
export function setReceiptSink(sink: ((ids: string[], state: 'delivered' | 'read') => void) | null): void {
  _openThreadReceiptSink = sink
}

/// Apply a peer's delivered/read receipt to our outgoing rows in that 1:1
/// thread — the second tick and the read tint (#637). Storage always, the
/// open thread additionally via its sink.
export function applyReceiptToOutgoing(peerUin: number, kind: 'delivered' | 'read', targetIDs: unknown): void {
  const ids = Array.isArray(targetIDs) ? targetIDs.filter((t): t is string => typeof t === 'string') : []
  if (ids.length === 0) return
  const key = storageKey(false, peerUin)
  const idSet = new Set(ids)
  const rows = loadPersisted(key)
  let changed = false
  const next = rows.map((r) => {
    if (!idSet.has(r.id) || STATE_RANK[r.state] >= STATE_RANK[kind]) return r
    changed = true
    return { ...r, state: kind }
  })
  if (changed) savePersisted(key, next)
  if (_openThreadKey === key) _openThreadReceiptSink?.(ids, kind)
}

/// Build a `sent` outgoing row from a carbon's inner envelope. Returns null
/// for kinds we don't surface (e.g. a nested reaction — reactions sync via
/// their own self-echo, never as a carbon).
function outgoingRowFromInner(inner: Envelope): OutgoingRow | null {
  const now = Date.now()
  /// A message I sent from my phone with a timer on it has to carry the same
  /// deadline here, or the copy on the desktop outlives the one the timer was
  /// set on. The anchor is the ORIGINATING device's `ts` when it sent one;
  /// `now` is when the carbon reached this browser, which can be much later.
  const dying = (ttl: unknown, ts: unknown): { expiresAt?: number } => {
    const at = expiryFrom(typeof ttl === 'number' ? ttl : null, sendAnchorMs(ts, now))
    return at != null ? { expiresAt: at } : {}
  }
  // ⚠⚠ `sentAt` is the SEND time, not "now". A carbon of my own message can
  // arrive a week after I wrote it (a browser opened after a trip, a phone that
  // drained late), and stamping it with the moment it arrived put last week's
  // message at the bottom of today's conversation with today's clock on it -
  // "as if I had just written it", in the words of the person who reported it.
  // `sendAnchorMs` is the same clamp the disappearing timers already use
  // against a skewed clock.
  const when = (ts: unknown): number => sendAnchorMs(ts, now)
  if (inner.kind === 'text') {
    return {
      id: inner.id,
      text: inner.text,
      sentAt: when(inner.ts),
      state: 'sent',
      kind: 'text',
      ...(inner.reply ? { replyTo: inner.reply } : {}),
      ...(inner.fwdName ? { fwdName: inner.fwdName } : {}),
      ...dying(inner.ttl, inner.ts),
    }
  }
  if (inner.kind === 'photo') {
    return {
      id: inner.id,
      text: inner.caption ?? '',
      sentAt: when(inner.ts),
      state: 'sent',
      kind: 'photo',
      mediaId: inner.mediaID,
      mediaKey: inner.mediaKey,
      ...(inner.reply ? { replyTo: inner.reply } : {}),
      ...(inner.fwdName ? { fwdName: inner.fwdName } : {}),
      ...dying(inner.ttl, inner.ts),
    }
  }
  // Video sent from another device (#15): keep the media ref + poster so the
  // web renders + plays it as a fromMe row, not a bare placeholder.
  if (inner.kind === 'video') {
    return {
      id: inner.id,
      text: inner.caption ?? '',
      sentAt: when(inner.ts),
      state: 'sent',
      kind: 'video',
      mediaId: inner.mediaID,
      mediaKey: inner.mediaKey,
      thumbnailB64: inner.thumbnailB64,
      durationSec: inner.durationSec,
      ...(inner.reply ? { replyTo: inner.reply } : {}),
      ...(inner.fwdName ? { fwdName: inner.fwdName } : {}),
      ...dying(inner.ttl, inner.ts),
    }
  }
  // File / document sent from another device (#16): keep the media ref + name/
  // mime/size for the download chip.
  if (inner.kind === 'file') {
    return {
      id: inner.id,
      text: inner.caption ?? '',
      sentAt: when(inner.ts),
      state: 'sent',
      kind: 'file',
      mediaId: inner.mediaID,
      mediaKey: inner.mediaKey,
      fileName: inner.fname,
      fileMime: inner.mime,
      fileSize: inner.size,
      ...(inner.reply ? { replyTo: inner.reply } : {}),
      ...(inner.fwdName ? { fwdName: inner.fwdName } : {}),
      ...dying(inner.ttl, inner.ts),
    }
  }
  if (inner.kind === 'voice' && inner.id && inner.mediaID && inner.mediaKey) {
    // A voice note sent from another device plays HERE too now (B2) — it used
    // to carbon in as the "recorded elsewhere" placeholder.
    return {
      id: inner.id,
      text: '',
      sentAt: when(inner.ts),
      state: 'sent',
      kind: 'voice',
      mediaId: inner.mediaID,
      mediaKey: inner.mediaKey,
      durationSec: typeof inner.durationSec === 'number' ? Math.round(inner.durationSec) : undefined,
      ...dying(inner.ttl, inner.ts),
    }
  }
  // A still-unsupported media kind sent from another device (location).
  // The web can't render these, but show a placeholder so the user sees that
  // they sent something here rather than a silent gap.
  const loose = inner as { kind?: string; id?: string; caption?: string; ttl?: unknown; ts?: unknown }
  if (loose.id && (loose.kind === 'voice' || loose.kind === 'location')) {
    const geo = loose as { lat?: number; lng?: number }
    return {
      id: loose.id,
      text: loose.caption ?? '',
      sentAt: when(loose.ts),
      state: 'sent',
      kind: 'other',
      mediaKind: loose.kind,
      ...(geo.lat != null && geo.lng != null ? { lat: geo.lat, lng: geo.lng } : {}),
      ...dying(loose.ttl, loose.ts),
    }
  }
  return null
}

/// The thread a carbon belongs to, or null for a shape we don't file.
export function carbonThreadKey(carbon: CarbonEnvelope): string | null {
  return carbon.gid != null ? storageKey(true, carbon.gid) : carbon.to != null ? storageKey(false, carbon.to) : null
}

let _openThreadEditSink: ((targetID: string, text: string) => void) | null = null

/// Chat registers this alongside setOutgoingSink, for the same reason the
/// receipt sink exists: the open thread owns its rows in component state,
/// and a bare storage write would be overwritten by Chat's persist effect.
export function setEditSink(sink: ((targetID: string, text: string) => void) | null): void {
  _openThreadEditSink = sink
}

/// Apply an edit made on ANOTHER of this account's devices to the outgoing
/// row it targets — the missing half of edit sync (the founder edited on the
/// desktop; the phone-side row never changed, and vice versa). Storage
/// always; the open thread additionally via its sink. Idempotent: the origin
/// device re-applies its own text. State/receipts stay untouched — an edit
/// changes what was said, not whether it was delivered.
export function applyEditToOutgoing(threadKey: string, targetID: string, text: string): void {
  const rows = loadPersisted(threadKey)
  if (rows.some((r) => r.id === targetID)) {
    savePersisted(
      threadKey,
      rows.map((r) => (r.id === targetID ? { ...r, text, edited: true } : r)),
    )
  }
  if (_openThreadKey === threadKey) _openThreadEditSink?.(targetID, text)
}

/// Handle a decrypted carbon: file its inner envelope as a fromMe row in the
/// destination thread. Idempotent by inner id (the origin device no-ops its
/// own carbon). Called from the receive dispatch for kind==='carbon'.
export function fileOutgoingCarbon(carbon: CarbonEnvelope): void {
  const threadKey = carbonThreadKey(carbon)
  if (!threadKey) return
  const row = outgoingRowFromInner(carbon.env)
  if (!row) return
  if (_openThreadKey === threadKey && _openThreadSink) {
    _openThreadSink(row) // Chat merges into state (dedup by id) + persists
  } else {
    appendToThreadLog(threadKey, row) // dedup + localStorage for a non-open thread
  }
}

// In-memory store of DECRYPTED incoming messages — 1:1 keyed by peer UIN, group
// keyed by group_id. The web chat was send-only (Chat.tsx kept only an outgoing
// log); this is the receive side. Module-level + event-based so any component
// subscribes via a hook. Persisted per-account in IndexedDB (survives reload).

import { useSyncExternalStore } from 'react'
import type { Envelope, ReplyContext } from './crypto'
import { idbGet, idbSet } from './signal-persist'
import { openValue, pinSealActive, sealExistingHistory, sealValue } from './pin-seal'
import { playSound } from './sounds'
import { markMention, mentionsMe } from './mentions'
import { contactsCache, snapshotFor } from './contacts-cache'
import { applyReceiptToOutgoing } from './outgoing-store'

export interface IncomingRow {
  id: string // envelope UUID
  from: number // sender UIN (the actual sender, from the sealed envelope)
  text: string // text body, or the caption for a photo, or '' for other media
  at: number // ms received
  // Defaults to 'text' when absent (back-compat with rows persisted before
  // media support). 'photo'/'video'/'file' carry mediaId/mediaKey (+ poster /
  // file metadata); 'other' is a still-unsupported media kind (voice/location)
  // shown as a label.
  kind?: 'text' | 'photo' | 'video' | 'file' | 'other' | 'poll'
  mediaId?: string
  mediaKey?: string
  mediaKind?: string // for 'other': the original envelope kind
  thumbnailB64?: string // for 'video': base64 JPEG poster
  durationSec?: number // for 'video': length in seconds
  fileName?: string // for 'file': original name
  fileMime?: string // for 'file': content type
  fileSize?: number // for 'file': plaintext byte length
  poll?: PollRow // for 'poll': the ballot (rendered + votable)
  replyTo?: ReplyContext // quoted message this is a reply to (if any)
  edited?: boolean // author edited this message after sending
}

/// A group poll carried inline in a 'poll' message — enough to render the
/// ballot offline; live tallies + voting hit /polls/{pollId}.
export interface PollRow {
  pollId: number
  question: string
  options: string[]
  single: boolean
  anon: boolean
}

/// Build an IncomingRow from a decrypted envelope, or null for kinds we
/// don't surface as a message (reactions, receipts, system, …). Photo
/// carries the media ref; iOS-only media kinds (video/voice/file/
/// location) become an 'other' placeholder so they're never silently
/// dropped. The envelope union is text/reaction/photo, but a real
/// inbound JSON can carry any iOS kind — inspect loosely for those.
function rowFromEnvelope(from: number, env: Envelope): IncomingRow | null {
  if (env.kind === 'text') {
    return { id: env.id, from, text: env.text, at: Date.now(), kind: 'text', replyTo: env.reply }
  }
  if (env.kind === 'photo') {
    return {
      id: env.id,
      from,
      text: env.caption ?? '',
      at: Date.now(),
      kind: 'photo',
      mediaId: env.mediaID,
      mediaKey: env.mediaKey,
      replyTo: env.reply,
    }
  }
  // Video (#15): keep the media ref + poster + duration so the web can play /
  // download it, not just label it.
  if (env.kind === 'video') {
    return {
      id: env.id,
      from,
      text: env.caption ?? '',
      at: Date.now(),
      kind: 'video',
      mediaId: env.mediaID,
      mediaKey: env.mediaKey,
      thumbnailB64: env.thumbnailB64,
      durationSec: env.durationSec,
      replyTo: env.reply,
    }
  }
  // File / document (#16): keep the media ref + name/mime/size for the
  // download chip.
  if (env.kind === 'file') {
    return {
      id: env.id,
      from,
      text: env.caption ?? '',
      at: Date.now(),
      kind: 'file',
      mediaId: env.mediaID,
      mediaKey: env.mediaKey,
      fileName: env.fname,
      fileMime: env.mime,
      fileSize: env.size,
      replyTo: env.reply,
    }
  }
  const loose = env as { kind?: string; id?: string; caption?: string }
  if (loose.id && (loose.kind === 'voice' || loose.kind === 'location')) {
    const geo = loose as { lat?: number; lng?: number }
    return {
      id: loose.id,
      from,
      text: loose.caption ?? '',
      at: Date.now(),
      kind: 'other',
      mediaKind: loose.kind,
      ...(geo.lat != null && geo.lng != null ? { lat: geo.lat, lng: geo.lng } : {}),
    }
  }
  // Group poll (terse wire keys poll/q/opts/sc/anon — see PollEnvelope). Was
  // silently dropped, so polls were invisible on web (#7).
  if (loose.kind === 'poll' && loose.id) {
    const p = env as unknown as { id: string; poll: number; q?: string; opts?: string[]; sc?: boolean; anon?: boolean }
    return {
      id: p.id,
      from,
      text: p.q ?? '', // question doubles as the toast/preview text
      at: Date.now(),
      kind: 'poll',
      poll: { pollId: p.poll, question: p.q ?? '', options: p.opts ?? [], single: !!p.sc, anon: !!p.anon },
    }
  }
  return null
}

const byPeer = new Map<number, IncomingRow[]>() // 1:1, keyed by peer UIN
const byGroup = new Map<number, IncomingRow[]>() // groups, keyed by group_id
const seen = new Set<string>() // dedupe (queue + ws can double-deliver)

/// Envelope ids this device itself put on the wire. Saved Messages ("Заметки")
/// is a thread whose peer is your own number, so a note now goes through the
/// same sealed path as any message — that is the only way the other devices on
/// the account ever see it — and comes straight back to the sender as an
/// ordinary incoming envelope. The optimistic row is already on screen, so the
/// echo has to be dropped here; a note written on ANOTHER device is not in this
/// set and shows normally, which is the whole point of the change.
const ownEnvelopes = new Set<string>()

export function noteOwnEnvelope(id: string): void {
  ownEnvelopes.add(id)
  // Unbounded growth is not a risk worth code, but a very long session with
  // thousands of sends should not hold every id forever either.
  if (ownEnvelopes.size > 5000) {
    for (const v of ownEnvelopes) {
      ownEnvelopes.delete(v)
      if (ownEnvelopes.size <= 4000) break
    }
  }
}
const listeners = new Set<() => void>()
const EMPTY: IncomingRow[] = []

// ── Reactions ───────────────────────────────────────────────────────
// targetID (the reacted message's UUID) -> (reactorUIN -> asset name).
// A reaction is its own envelope (kind:'reaction'); it can target EITHER
// of the two message logs (my outgoing or the peer's incoming) so it
// lives in its own store keyed by the target id, independent of which
// log holds the message. A reaction envelope upserts the reactor's asset;
// asset===null removes it. Persisted alongside the message history.
const reactionsByTarget = new Map<string, Map<number, string>>()
let reactionsVersion = 0
const reactionListeners = new Set<() => void>()

function emitReactions() {
  reactionsVersion++
  for (const l of reactionListeners) l()
}

/// Apply one reaction (from a received envelope or our own optimistic
/// toggle). asset===null clears this reactor's reaction on the target.
export function applyReaction(targetId: string, reactor: number, asset: string | null): void {
  let inner = reactionsByTarget.get(targetId)
  if (asset == null) {
    if (!inner) return
    if (!inner.delete(reactor)) return
    if (inner.size === 0) reactionsByTarget.delete(targetId)
  } else {
    if (!inner) {
      inner = new Map()
      reactionsByTarget.set(targetId, inner)
    } else if (inner.get(reactor) === asset) {
      return // no-op
    }
    inner.set(reactor, asset)
  }
  // Paint first, write second. The user's own reaction is the one case where
  // the two are visibly ordered: the tap has already happened, the picture
  // belongs on screen in that frame, and the archive can catch up after.
  emitReactions()
  persist()
}

/// Current (reactorUIN -> asset) for a target, or undefined. Read inside
/// a component that also subscribes via useReactionsVersion() so it
/// re-renders when reactions change.
export function reactionsForTarget(targetId: string): Map<number, string> | undefined {
  return reactionsByTarget.get(targetId)
}

/// Aggregate a target's reactions into display chips: one per distinct
/// asset, with a count and whether the viewer reacted with it.
export interface ReactionChip {
  asset: string
  count: number
  mine: boolean
}
export function aggregateReactions(targetId: string, viewerUin: number): ReactionChip[] {
  const inner = reactionsByTarget.get(targetId)
  if (!inner || inner.size === 0) return []
  const counts = new Map<string, number>()
  for (const asset of inner.values()) counts.set(asset, (counts.get(asset) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([asset, count]) => ({ asset, count, mine: inner.get(viewerUin) === asset }))
}

// ── Delete-for-everyone tombstones ──────────────────────────────────
// A delete envelope only carries the target message id, not which log holds
// it, and web keeps two logs (incoming + outgoing). So we tombstone the id:
// both render paths hide a tombstoned id, and the set is persisted so a
// reload / carbon can't bring it back. Removing from the incoming log too
// keeps memory tidy.
const deletedIds = new Set<string>()
let deletedVersion = 0
const deletedListeners = new Set<() => void>()

function emitDeleted() {
  deletedVersion++
  for (const l of deletedListeners) l()
}

export function isDeleted(targetId: string): boolean {
  return deletedIds.has(targetId)
}

/// Retract a message for everyone locally. `senderUin` (when the delete came
/// from a peer) gates the incoming removal to that sender's OWN message, so a
/// peer can't delete someone else's message; `fromSelf` (our own delete, or a
/// carbon of it) also lets it retract an OUTGOING row (hidden via the filter).
export function markDeleted(targetId: string, opts?: { senderUin?: number; fromSelf?: boolean; moderator?: boolean }): void {
  if (deletedIds.has(targetId)) return
  let removed = false
  const drop = (map: Map<number, IncomingRow[]>, threadKey: (id: number) => string) => {
    for (const [key, rows] of map) {
      const next = rows.filter(
        (r) => !(r.id === targetId && (opts?.senderUin == null || opts?.moderator || r.from === opts.senderUin)),
      )
      if (next.length !== rows.length) {
        map.set(key, next)
        removed = true
        // The row is gone from the array, so a count that still includes it no
        // longer describes anything: the unread run is measured by counting
        // back from the end, and every undecremented delete slides that
        // boundary one message the wrong way.
        const tk = threadKey(key)
        const n = unread.get(tk) ?? 0
        if (n > 0) {
          if (n > 1) unread.set(tk, n - 1)
          else unread.delete(tk)
          persistUnread()
          emitUnread()
        }
      }
    }
  }
  drop(byPeer, peerKey)
  drop(byGroup, groupKey)
  // Only tombstone when we either removed the sender's own incoming message,
  // it's our own delete, or the sender holds moderator power in the group the
  // delete arrived through — never let an ordinary peer tombstone (and thus
  // hide) a message that wasn't theirs. The moderator case must tombstone
  // even with nothing removed: the target may be OUR OWN message (it lives in
  // the outgoing log, which renders through this same tombstone set), or one
  // still in flight.
  if (!removed && !opts?.fromSelf && !opts?.moderator) return
  deletedIds.add(targetId)
  if (reactionsByTarget.delete(targetId)) emitReactions()
  persist()
  emit()
  emitDeleted()
}

export function useDeletedVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      deletedListeners.add(cb)
      return () => deletedListeners.delete(cb)
    },
    () => deletedVersion,
  )
}

function subscribeReactions(cb: () => void): () => void {
  reactionListeners.add(cb)
  return () => {
    reactionListeners.delete(cb)
  }
}
/// Bumps on any reaction change — a component calls this once to force a
/// re-render, then reads reactionsForTarget/aggregateReactions per row.
export function useReactionsVersion(): number {
  return useSyncExternalStore(subscribeReactions, () => reactionsVersion)
}

// ── Unread + live toasts ────────────────────────────────────────────
// Unread counts per thread key ("p:<uin>" / "g:<id>"). A message bumps
// unread only when its thread isn't the one currently open. Opening a
// thread (setActiveThread) clears it. Counts persist per account so
// badges survive a reload, like the native apps.
const unread = new Map<string, number>()
let _activeThread: string | null = null
const unreadListeners = new Set<() => void>()

/// A just-arrived message, for the in-app toast (real-time "push").
export interface Toast {
  id: string // envelope id (also the toast key)
  from: number // sender UIN
  groupId: number | null
  text: string // snippet/caption ('' for media w/o caption)
  kind: 'text' | 'photo' | 'video' | 'file' | 'other'
}
const toastListeners = new Set<(t: Toast) => void>()

const peerKey = (uin: number) => `p:${uin}`
const groupKey = (id: number) => `g:${id}`

function emitUnread() {
  for (const l of unreadListeners) l()
}

// Persistence (IndexedDB), scoped per account. Set by hydrateIncoming() on mount.
let _activeUin: number | null = null
/// Whose history has finished loading from IndexedDB. Read receipts hang on
/// this: a thread's rows are EMPTY until hydration lands, and "the peer has
/// written nothing" and "we have not read the disk yet" must not look alike
/// to the code that decides what has already been receipted.
let _hydratedFor: number | null = null
export function incomingHydrated(uin: number): boolean {
  return _hydratedFor === uin
}
const histKey = (uin: number) => `incoming:${uin}`
const unreadKey = (uin: number) => `rcq.web.unread.${uin}`

interface Persisted {
  peers: Record<string, IncomingRow[]>
  groups: Record<string, IncomingRow[]>
  // targetID -> (reactorUIN-as-string -> asset). Optional for back-compat
  // with blobs written before reactions were persisted.
  reactions?: Record<string, Record<string, string>>
  // Message ids retracted by delete-for-everyone. Persisted so a reload /
  // carbon can't resurrect a deleted message. Optional for back-compat.
  deleted?: string[]
}

function emit() {
  for (const l of listeners) l()
}

function persistUnread() {
  if (_activeUin == null) return
  try {
    localStorage.setItem(unreadKey(_activeUin), JSON.stringify(Object.fromEntries(unread)))
  } catch {
    /* quota / unavailable */
  }
}

/// Draining a mailbox rather than receiving live traffic.
///
/// Everything in a queue is "new" to this store, so on open the whole backlog
/// used to arrive as a wall of banners with a chime behind each one — the thing
/// a real push is careful never to do, because none of it is news: the user is
/// looking at the app right now and the unread badges already say it. A counter
/// rather than a flag, because several drains overlap (the primary queue, the
/// backup islands, every visited island's guest mailbox).
let _catchingUp = 0
export function beginCatchUp() {
  _catchingUp++
}
export function endCatchUp() {
  _catchingUp = Math.max(0, _catchingUp - 1)
}

/// Bump unread + fire a toast for a genuinely-new (post-dedupe) incoming
/// row, unless its thread is the one currently open — or unless we are catching
/// up on a mailbox, where the unread count is the whole notification.
function bumpUnread(threadKey: string, row: IncomingRow, groupId: number | null) {
  if (threadKey !== _activeThread) {
    unread.set(threadKey, (unread.get(threadKey) ?? 0) + 1)
    persistUnread()
    emitUnread()
    if (_catchingUp > 0) return
    playSound('message_incoming')
    // Media kinds pass through for a typed preview; text/poll/undefined show
    // their text (poll text is the question).
    const tk: Toast['kind'] =
      row.kind === 'photo' || row.kind === 'video' || row.kind === 'file' || row.kind === 'other'
        ? row.kind
        : 'text'
    const toast: Toast = {
      id: row.id,
      from: row.from,
      groupId,
      text: row.text,
      kind: tk,
    }
    for (const l of toastListeners) l(toast)
  }
}

/// Mark a thread read (clear its unread). Called by Chat on open + on
/// each new message while it's the active thread.
function clearUnread(threadKey: string) {
  if (unread.get(threadKey)) {
    unread.delete(threadKey)
    persistUnread()
    emitUnread()
  }
}

/// Set which thread is currently open ("p:<uin>" / "g:<id>" / null).
/// Clears that thread's unread. Chat calls this on mount/unmount.
export function setActiveThread(threadKey: string | null) {
  _activeThread = threadKey
  if (threadKey) clearUnread(threadKey)
}

export function markPeerRead(uin: number) {
  clearUnread(peerKey(uin))
}
export function markGroupRead(id: number) {
  clearUnread(groupKey(id))
}

export function onToast(cb: (t: Toast) => void): () => void {
  toastListeners.add(cb)
  return () => {
    toastListeners.delete(cb)
  }
}

function subscribeUnread(cb: () => void): () => void {
  unreadListeners.add(cb)
  return () => {
    unreadListeners.delete(cb)
  }
}

/// Non-hook reads of the unread counts — for list-level sorting/section totals
/// (call useTotalUnread() in the component so it re-renders on changes).
export function peerUnreadCount(uin: number): number {
  return unread.get(peerKey(uin)) ?? 0
}
export function groupUnreadCount(id: number): number {
  return unread.get(groupKey(id)) ?? 0
}

export function usePeerUnread(uin: number | null): number {
  return useSyncExternalStore(subscribeUnread, () => (uin == null ? 0 : unread.get(peerKey(uin)) ?? 0))
}
export function useGroupUnread(id: number | null): number {
  return useSyncExternalStore(subscribeUnread, () => (id == null ? 0 : unread.get(groupKey(id)) ?? 0))
}
export function useTotalUnread(): number {
  return useSyncExternalStore(subscribeUnread, () => {
    let n = 0
    for (const v of unread.values()) n += v
    return n
  })
}

/// Everything this account has RECEIVED, for a backup export. Returns the raw
/// rows keyed by thread; the caller maps them to the neutral archive record.
export function exportAllIncoming(): {
  peers: Record<string, IncomingRow[]>
  groups: Record<string, IncomingRow[]>
} {
  return { peers: Object.fromEntries(byPeer), groups: Object.fromEntries(byGroup) }
}

/// Merge restored rows into a thread. Only ADDS: a row whose id is already
/// known is skipped, so an old archive can never eat newer history, and
/// nothing already here is rewritten.
export function mergeRestoredIncoming(
  kind: 'peer' | 'group',
  id: number,
  rows: IncomingRow[],
): number {
  const map = kind === 'peer' ? byPeer : byGroup
  const prefix = kind === 'peer' ? 'p' : 'g'
  const existing = map.get(id) ?? []
  const known = new Set(existing.map((r) => r.id))
  const fresh = rows.filter((r) => !known.has(r.id))
  if (!fresh.length) return 0
  const merged = [...existing, ...fresh].sort((a, b) => a.at - b.at)
  map.set(id, merged)
  for (const r of fresh) seen.add(`${prefix}:${id}:${r.id}`)
  persist()
  emit()
  return fresh.length
}

/// Write the whole history to disk. ⚠ Genuinely the WHOLE history: this
/// snapshots every thread, every reaction and every tombstone, serializes it
/// and — with a PIN set — encrypts it. That is fine once, and ruinous per
/// event: one reaction, or one row of a queue drain, paid for the entire
/// archive. It was visible as a stutter at the exact moment a reaction
/// appeared, and as a drain that crawled through a large backlog.
///
/// So writes are coalesced: callers say "the store changed" and a single
/// write follows shortly after the burst. In-memory state is the source of
/// truth for everything on screen; this is the copy that survives a reload.
let persistTimer: ReturnType<typeof setTimeout> | null = null
let persistInFlight: Promise<void> = Promise.resolve()

function writeNow(): Promise<void> {
  if (_activeUin == null) return Promise.resolve()
  const reactions: Record<string, Record<string, string>> = {}
  for (const [t, inner] of reactionsByTarget) reactions[t] = Object.fromEntries(inner)
  const blob: Persisted = {
    peers: Object.fromEntries(byPeer),
    groups: Object.fromEntries(byGroup),
    reactions,
    deleted: [...deletedIds],
  }
  const uin = _activeUin
  // Sealed under the desktop PIN when there is one; the plain object otherwise
  // (a browser tab has nowhere to keep a key the page cannot reach).
  //
  // The caller gets the REAL promise: flushHistory runs before a queue ack, and
  // an ack issued on the strength of a write that actually failed erases the
  // island's only copy of rows this store never kept (that is how a fan-out
  // copy vanished on 2026-08-20). Only the background chain swallows.
  //
  // Chained behind the previous write: each write is a full snapshot, so two
  // in flight at once could land out of order and leave the OLDER one on disk.
  const write = persistInFlight
    .then(() => sealValue(blob))
    .then((stored) => idbSet(histKey(uin), stored))
  persistInFlight = write.catch(() => {})
  return write
}

function persist() {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    writeNow().catch(() => {})
  }, 300)
}

/// Write anything still pending and wait for it to land. The queue drain calls
/// this before acking: an ack tells the island it may let go of those rows, and
/// promising that while their only copy is a scheduled write is how a crash
/// between the two loses messages for good.
///
/// Unconditional on purpose. The old "only if a timer is pending" gate assumed
/// every change arrives through persist(); a row added and flushed inside the
/// same tick has no timer yet, and waiting on the previous write then vouched
/// for a snapshot that predates the row (2026-08-20 fan-out loss).
export async function flushHistory(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  await writeNow()
}

// A tab being closed or hidden gets no second chance at a scheduled write.
if (typeof document !== 'undefined') {
  const flushOnHide = () => {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
      writeNow().catch(() => {})
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushOnHide()
  })
  window.addEventListener('pagehide', flushOnHide)
}

/// Load this account's persisted history into the store (call once on mount).
export async function hydrateIncoming(uin: number): Promise<void> {
  _activeUin = uin
  // Restore persisted unread counts (badges survive reload).
  try {
    const raw = localStorage.getItem(unreadKey(uin))
    if (raw) {
      unread.clear()
      for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, number>)) {
        if (typeof v === 'number' && v > 0) unread.set(k, v)
      }
      // ...except for the thread that is open right now. Hydration is awaited
      // behind the socket, so on a reload straight onto a chat URL it lands
      // long after Chat cleared an empty map — and then nothing ever clears it
      // again, because bumpUnread skips the active thread. The count for the
      // conversation the user is looking at stayed stuck forever, showing as a
      // phantom in the tab title and, once there is an unread divider, putting
      // it N messages from the end of a thread that has been read.
      if (_activeThread && unread.delete(_activeThread)) persistUnread()
      emitUnread()
    }
  } catch {
    /* ignore */
  }
  // First point where the account scope is known and the database is the right
  // one, so this is where a history written before the PIN gets sealed. Not
  // awaited: it is a one-off sweep and the chat should not wait on it.
  if (pinSealActive()) void sealExistingHistory().catch(() => {})
  // Two shapes on disk: sealed (a desktop with a PIN) and the plain object
  // everyone else has. A sealed blob we cannot open belongs to a key that is
  // gone — the history stays as it is rather than being replaced with garbage.
  const stored = await idbGet<unknown>(histKey(uin)).catch(() => undefined)
  const saved = await openValue<Persisted>(stored).catch(() => undefined)
  // Hydrated either way: "nothing on disk" is an answer too, and callers that
  // wait for this flag (read receipts) would otherwise wait forever on a
  // fresh install.
  _hydratedFor = uin
  if (!saved) return
  for (const [k, rows] of Object.entries(saved.peers ?? {})) {
    byPeer.set(Number(k), rows)
    for (const r of rows) seen.add(`p:${k}:${r.id}`)
  }
  for (const [k, rows] of Object.entries(saved.groups ?? {})) {
    byGroup.set(Number(k), rows)
    for (const r of rows) seen.add(`g:${k}:${r.id}`)
  }
  for (const [t, m] of Object.entries(saved.reactions ?? {})) {
    const inner = new Map<number, string>()
    for (const [u, a] of Object.entries(m)) inner.set(Number(u), a)
    if (inner.size) reactionsByTarget.set(t, inner)
  }
  for (const id of saved.deleted ?? []) deletedIds.add(id)
  emit()
  emitReactions()
}

/// Ingest a decrypted 1:1 envelope (text/photo/other media). `from` is the sender.
/// In-place edit of an already-received message (author changed its text).
/// Replaces the thread array (new reference) so useSyncExternalStore re-renders.
function applyEditTo(map: Map<number, IncomingRow[]>, key: number, targetID: string, text: string): void {
  const prev = map.get(key)
  if (!prev || !prev.some((r) => r.id === targetID)) return
  map.set(key, prev.map((r) => (r.id === targetID ? { ...r, text, edited: true } : r)))
  persist()
  emit()
}

export function addIncoming(from: number, env: Envelope): void {
  // The peer's delivered/read receipt for OUR messages: second tick / read
  // tint on the outgoing rows of that thread (#636/#637). Never a row.
  if (env.kind === 'delivered' || env.kind === 'read') {
    applyReceiptToOutgoing(from, env.kind, env.targetIDs)
    return
  }
  // A reaction the peer placed on one of OUR messages (or removed) — apply
  // it to the reactions store rather than creating a message row.
  if (env.kind === 'reaction') {
    applyReaction(env.targetID, from, env.asset)
    return
  }
  if (env.kind === 'edit') {
    applyEditTo(byPeer, from, env.targetID, env.text)
    return
  }
  if (env.kind === 'delete') {
    // 1:1 delete-for-everyone: honor only the sender's OWN message (author
    // rule), unless it's our own delete carboned from another device.
    markDeleted(env.targetID, from === _activeUin ? { fromSelf: true } : { senderUin: from })
    return
  }
  const row = rowFromEnvelope(from, env)
  if (!row) return
  if (deletedIds.has(row.id)) return
  // Our own note bouncing back off the island (see [ownEnvelopes]).
  if (from === _activeUin && ownEnvelopes.has(row.id)) return
  const key = `p:${from}:${row.id}`
  if (seen.has(key)) return
  seen.add(key)
  const prev = byPeer.get(from) ?? EMPTY
  byPeer.set(from, [...prev, row])
  persist()
  emit()
  // A note I wrote on my OTHER device is not news, it is this device catching
  // up. It arrived as an ordinary envelope to my own number — which is what
  // makes it sync at all — and was then announced like a stranger's message:
  // a chime, a banner and an unread badge for something I typed myself a
  // second ago on the laptop in front of me. File it silently.
  //
  // ⚠ This is only the half a client can fix. The island pushes it too,
  // because a note ships as envelope_type "message" and that type is
  // pushable — and sealed sender means the island cannot tell a note from a
  // stranger's message to decide otherwise. Silencing the push needs the
  // SENDING side to mark a self-note as a non-pushable type, which is a wire
  // decision, not a local one.
  if (from === _activeUin) return
  bumpUnread(peerKey(from), row, null)
}

/// May `from` retract other people's messages in `groupId`? The owner may; an
/// admin may when a roster is cached. The chat list is fetched `?members=0`,
/// so the ROLE can be unknowable on the receive path — the owner check, off
/// the group row itself, never is. An admin's delete that arrives before any
/// roster was ever cached is simply ignored, same as on an old client.
function groupModerator(groupId: number, from: number): boolean {
  if (_activeUin == null) return false
  const groups = contactsCache.get(_activeUin)?.groups ?? snapshotFor(_activeUin)?.groups ?? []
  const g = groups.find((row) => row.id === groupId)
  if (!g) return false
  if (g.owner_uin === from) return true
  return (g.members ?? []).find((m) => m.uin === from)?.role === 'admin'
}

/// Ingest a decrypted GROUP envelope: routed by `groupId` (from the transport),
/// `from` is the member who sent it (from the sealed envelope). Deduped per
/// group+envelope-id (each member gets their own ciphertext of the same envelope).
export function addGroupIncoming(groupId: number, from: number, env: Envelope): void {
  if (env.kind === 'reaction') {
    applyReaction(env.targetID, from, env.asset)
    return
  }
  if (env.kind === 'edit') {
    applyEditTo(byGroup, groupId, env.targetID, env.text)
    return
  }
  if (env.kind === 'delete') {
    // Group delete: the author retracts their own message, and the group's
    // owner or an admin retracts anybody's (founder batch 21.08, item 3 —
    // "админ не может удалить чужое сообщение"). The wire is unchanged; the
    // RECEIVER decides whether this sender may. An older client ignores a
    // foreign delete and keeps the message — nothing breaks, it just stays.
    markDeleted(
      env.targetID,
      from === _activeUin
        ? { fromSelf: true }
        : { senderUin: from, moderator: groupModerator(groupId, from) },
    )
    return
  }
  const row = rowFromEnvelope(from, env)
  if (!row) return
  if (deletedIds.has(row.id)) return
  const key = `g:${groupId}:${row.id}`
  if (seen.has(key)) return
  seen.add(key)
  const prev = byGroup.get(groupId) ?? EMPTY
  byGroup.set(groupId, [...prev, row])
  persist()
  emit()
  bumpUnread(groupKey(groupId), row, groupId)
  noteMentionInGroup(groupId, row)
}

/// Raise the @ marker on a group thread the reader is not looking at.
///
/// Group-only by nature: a 1:1 body cannot name you as a third party, so the
/// marker would mean "someone wrote to you", which the unread badge already
/// says. Own messages never count. My nickname comes off the persisted roster
/// snapshot rather than a live fetch — this runs on the receive path, with no
/// component mounted and possibly no network, and the snapshot is written on
/// every contacts load.
function noteMentionInGroup(groupId: number, row: IncomingRow) {
  if (_activeUin == null) return
  if (row.from === _activeUin) return
  if (groupKey(groupId) === _activeThread) return
  const nick =
    contactsCache.get(_activeUin)?.me?.nickname ?? snapshotFor(_activeUin)?.me?.nickname ?? null
  if (!mentionsMe(row.text, _activeUin, nick)) return
  markMention(groupId)
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/// Subscribe to incoming 1:1 messages from a peer (null → none).
export function useIncoming(peerUin: number | null): IncomingRow[] {
  return useSyncExternalStore(subscribe, () => (peerUin == null ? EMPTY : byPeer.get(peerUin) ?? EMPTY))
}

/// Subscribe to incoming messages in a group (null → none).
export function useGroupIncoming(groupId: number | null): IncomingRow[] {
  return useSyncExternalStore(subscribe, () => (groupId == null ? EMPTY : byGroup.get(groupId) ?? EMPTY))
}

// In-memory store of DECRYPTED incoming messages — 1:1 keyed by peer UIN, group
// keyed by group_id. The web chat was send-only (Chat.tsx kept only an outgoing
// log); this is the receive side. Module-level + event-based so any component
// subscribes via a hook. Persisted per-account in IndexedDB (survives reload).

import { useSyncExternalStore } from 'react'
import type { Envelope, ReplyContext } from './crypto'
import { idbGet, idbSet } from './signal-persist'
import { playSound } from './sounds'

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
    return { id: loose.id, from, text: loose.caption ?? '', at: Date.now(), kind: 'other', mediaKind: loose.kind }
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
  persist()
  emitReactions()
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
const histKey = (uin: number) => `incoming:${uin}`
const unreadKey = (uin: number) => `rcq.web.unread.${uin}`

interface Persisted {
  peers: Record<string, IncomingRow[]>
  groups: Record<string, IncomingRow[]>
  // targetID -> (reactorUIN-as-string -> asset). Optional for back-compat
  // with blobs written before reactions were persisted.
  reactions?: Record<string, Record<string, string>>
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

/// Bump unread + fire a toast for a genuinely-new (post-dedupe) incoming
/// row, unless its thread is the one currently open.
function bumpUnread(threadKey: string, row: IncomingRow, groupId: number | null) {
  if (threadKey !== _activeThread) {
    unread.set(threadKey, (unread.get(threadKey) ?? 0) + 1)
    persistUnread()
    emitUnread()
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

function persist() {
  if (_activeUin == null) return
  const reactions: Record<string, Record<string, string>> = {}
  for (const [t, inner] of reactionsByTarget) reactions[t] = Object.fromEntries(inner)
  const blob: Persisted = {
    peers: Object.fromEntries(byPeer),
    groups: Object.fromEntries(byGroup),
    reactions,
  }
  void idbSet(histKey(_activeUin), blob).catch(() => {})
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
      emitUnread()
    }
  } catch {
    /* ignore */
  }
  const saved = await idbGet<Persisted>(histKey(uin)).catch(() => undefined)
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
  const row = rowFromEnvelope(from, env)
  if (!row) return
  const key = `p:${from}:${row.id}`
  if (seen.has(key)) return
  seen.add(key)
  const prev = byPeer.get(from) ?? EMPTY
  byPeer.set(from, [...prev, row])
  persist()
  emit()
  bumpUnread(peerKey(from), row, null)
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
  const row = rowFromEnvelope(from, env)
  if (!row) return
  const key = `g:${groupId}:${row.id}`
  if (seen.has(key)) return
  seen.add(key)
  const prev = byGroup.get(groupId) ?? EMPTY
  byGroup.set(groupId, [...prev, row])
  persist()
  emit()
  bumpUnread(groupKey(groupId), row, groupId)
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

// Variant A — cross-island "message requests" (consent).
//
// Cross-island delivery is permissionless (open mailbox + sealed deposit, like
// email): anyone who knows your `uin@host` can seal a message into your queue.
// Same-island has a /contacts/request approval flow; cross-island has none. So
// rather than auto-surfacing an unknown cross-island sender into your chat list,
// we QUARANTINE their messages here until you Accept (→ they become a normal
// cross-island contact and the held messages replay) or Block.
//
// Held messages are the already-decrypted Envelopes — they never reached the
// chat store, so an un-accepted stranger is invisible until you decide.

import type { Envelope } from './crypto'

import { scopedKey } from './account-scope'
import {
  answeredKey,
  mergeServerRequest,
  reconcileServerRequests as reconcileServerRows,
  type ServerPendingRow,
  type ServerRequestRef,
} from './crossisland-pending'
import { isSealed, openLocal, sealLocal } from './local-seal'

const KEY = () => scopedKey('ci-requests.v1')
const BLOCKED_KEY = () => scopedKey('ci-blocked.v1')
const MAX_HELD = 20 // cap held messages per pending sender
// §5f anti-abuse: a cross-island deposit is open (F3 is off), so a request
// costs a stranger one HTTP call. Bound the list so a flood fills a capped
// list rather than the disk; the oldest row falls off.
const MAX_PENDING = 50

export interface CrossIslandRequest {
  uin: number
  host: string
  firstAt: number
  msgs: Envelope[]
  /// §5f: true when this row was created by an explicit `contactreq` envelope
  /// rather than by quarantining a message. Such a row can have no messages at
  /// all — the sender asked to be added, they did not write anything yet.
  contactReq?: boolean
  /// Self-asserted display name + greeting from the `contactreq`, so the row
  /// renders before any key-card fetch. Cosmetic only: identity stays anchored
  /// by the keys pinned at accept-time, never by these.
  nickname?: string
  note?: string
  /// The signing keys the held envelopes on this row were sealed with, as the
  /// seal verified them (unique, capped). Accept compares them with the key
  /// the sender's island publishes for this address and refuses on a
  /// difference: `from`/`from_host` are unsigned in v=1, so without this an
  /// accept would pin the real person's keys and then replay somebody else's
  /// words into that person's thread.
  spubs?: string[]
  /// We already hold a contact at this address and these envelopes were NOT
  /// sealed with the key pinned for them. Shown on the row, never merged.
  keyMismatch?: boolean
  /// The row also stands for a request in the island's own list on `host`,
  /// addressed to our guest copy there (spec 2026-09-15, F1). Answering it
  /// clears that row too. See crossisland-pending.ts.
  server?: ServerRequestRef
  /// Deposits of our accept so far that did not reach the requester. The
  /// visited poll tries again up to three in all, then the row says so.
  srvAcceptTries?: number
}

/// What the receive path proved about who sealed an envelope it is holding.
export interface HeldSenderProof {
  spub?: string
  keyMismatch?: boolean
}

const MAX_SPUBS = 4

/// Note the proof on a row. The mismatch flag is sticky: once any envelope at
/// this address came under a key that is not the pinned one, the row keeps
/// saying so until the user decides.
function noteProof(row: CrossIslandRequest, proof?: HeldSenderProof): void {
  if (!proof) return
  if (proof.keyMismatch) row.keyMismatch = true
  const spub = typeof proof.spub === 'string' ? proof.spub : ''
  if (!spub) return
  const list = row.spubs ?? []
  if (!list.includes(spub)) row.spubs = [...list, spub].slice(-MAX_SPUBS)
}

function reqKey(uin: number, host: string): string {
  return `${uin}@${host.toLowerCase()}`
}

// -----------------------------------------------------------
// Storage: sealed at rest, held open in memory
// -----------------------------------------------------------
//
// ★★ These rows are the only thing in this client that holds a STRANGER'S
// words. A quarantined request is, by definition, a message from someone the
// owner has not agreed to hear from — and it sat in localStorage as readable
// JSON until it was accepted or dismissed, which for a request nobody ever
// opens is forever. Whoever ends up in front of this browser reads it without
// touching anything: no XSS, no console, just the storage tab.
//
// So the list is sealed with the non-extractable key from local-seal.ts. The
// decrypted copy lives in memory while the tab is open, which is what keeps
// every function below synchronous — the receive path calls them from inside
// a decrypt loop, and a promise there would mean re-plumbing the loop.
//
// ⚠ The seal only covers the CONTENT (`ci-requests.v1`), not the block list:
// `isBlocked` is asked synchronously by the call path, the profile push and
// federation gossip, and none of them can wait on a key. That list is a set of
// numbers with no words in it.

let cache: Record<string, CrossIslandRequest> | null = null
let loading: Promise<void> | null = null
/// ⚠ The key is resolved ONCE, when the store opens, and every later write
/// uses that one. `scopedKey` reads the active account, sealing is
/// asynchronous, and a read that resolved the key before the account was known
/// would write its result back under a DIFFERENT key — emptying the real list.
/// Caught doing exactly that in testing.
let storeKey: string | null = null
/// Mutations that arrived before the store finished opening (a queue drain can
/// beat it by milliseconds). Replayed in order, so nothing is dropped.
const deferred: Array<() => void> = []
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

/// Re-render when the list changes (or when it first opens). Returns the
/// unsubscribe.
export function onRequestsChanged(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/// Open the store. Safe to call from anywhere, any number of times; the first
/// call does the work. Callers that render the list should await it once so
/// they do not paint an empty list over a full one.
export function ensureRequestsLoaded(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      storeKey = KEY()
      const raw = localStorage.getItem(storeKey)
      let map: Record<string, CrossIslandRequest> = {}
      if (raw) {
        // Two shapes on disk: sealed (current) and the plain JSON everyone has
        // today. Plain is read once and then written back sealed.
        const text = isSealed(raw) ? await openLocal(raw) : raw
        if (text) {
          try {
            const parsed = JSON.parse(text) as Record<string, CrossIslandRequest>
            if (parsed && typeof parsed === 'object') map = parsed
          } catch {
            /* unreadable — start empty rather than throw inside a store */
          }
        }
        // A sealed blob we cannot open belongs to a key that is gone (site data
        // cleared, another account's database). Nothing to salvage; the row is
        // dropped rather than shown as garbage.
      }
      cache = map
      for (const op of deferred.splice(0)) op()
      // Re-seal on open: migrates the plain list, and re-writes an already
      // sealed one with a fresh nonce. Cheap and once per tab.
      void flush()
      notify()
    })()
  }
  return loading
}

// ⚠ Deliberately NOT started at import time. This module is imported by the
// receive loop, which is pulled in before the identity provider has set the
// account scope — so an eager load would read the unscoped key and write the
// (empty) result back over the real one.

async function flush(): Promise<void> {
  if (!cache || !storeKey) return
  const json = JSON.stringify(cache)
  const sealed = await sealLocal(json)
  // No seal available in this browser: store it the way it has always been
  // stored. Losing a stranger's request would be the worse failure, and the
  // storage screen reports which of the two happened.
  localStorage.setItem(storeKey, sealed ?? json)
}

function loadAll(): Record<string, CrossIslandRequest> {
  return cache ?? {}
}

function saveAll(map: Record<string, CrossIslandRequest>): void {
  cache = map
  void flush()
  notify()
}

/// Run `op` now if the store is open, else the moment it is. The return value
/// of a deferred mutation is decided by [isBlocked], which needs no store.
function whenLoaded(op: () => void): void {
  if (cache) op()
  else deferred.push(op)
}

function loadBlocked(): Record<string, true> {
  try {
    return JSON.parse(localStorage.getItem(BLOCKED_KEY()) || '{}') as Record<string, true>
  } catch {
    return {}
  }
}

export function isBlocked(uin: number, host: string): boolean {
  return loadBlocked()[reqKey(uin, host)] === true
}

/// Quarantine one decrypted envelope from an un-accepted cross-island sender.
/// No-op if they're blocked. Returns true if it was held (caller then skips the
/// normal ingest), false if blocked (caller drops it).
export function holdRequestMessage(uin: number, host: string, env: Envelope, proof?: HeldSenderProof): boolean {
  if (isBlocked(uin, host)) return false
  // ⚠ Deferred if the store is still opening: the queue drain starts the
  // moment the socket connects and can beat the key out of IndexedDB by a few
  // milliseconds. Dropping the envelope there would lose a stranger's first
  // message with no trace anywhere.
  whenLoaded(() => {
    const map = loadAll()
    const k = reqKey(uin, host)
    const existing = map[k] ?? { uin, host, firstAt: Date.now(), msgs: [] }
    noteProof(existing, proof)
    // Dedup by envelope id so a re-drained queue row doesn't pile up.
    if (!existing.msgs.some((m) => (m as { id?: string }).id === (env as { id?: string }).id)) {
      existing.msgs.push(env)
      if (existing.msgs.length > MAX_HELD) existing.msgs = existing.msgs.slice(-MAX_HELD)
    }
    map[k] = existing
    saveAll(map)
  })
  return true
}

/// §5f: file a PENDING cross-island contact request from `uin@host`, in the
/// same list a quarantined message request appears in — that list is this
/// client's "pending requests" surface, and a cross-island ask belongs beside
/// the same-island ones rather than in a second place.
///
/// No-op for a blocked sender (dropped silently, same as the same-island rule)
/// and for a sender who already has a row: a repeat `request` never creates a
/// second entry, which is also the client-side per-sender rate limit. Returns
/// true when a pending row now exists for them.
export function addContactRequest(
  uin: number,
  host: string,
  nickname?: string,
  note?: string,
  proof?: HeldSenderProof,
): boolean {
  if (isBlocked(uin, host)) return false
  whenLoaded(() => {
    const map = loadAll()
    const k = reqKey(uin, host)
    const existing = map[k]
    if (existing) {
      // Already pending — promote a message-quarantine row to also being a
      // contact request (they asked properly), but never duplicate the row and
      // never move `firstAt`, so a flood cannot bump itself to the top.
      const before = JSON.stringify([existing.contactReq, existing.spubs, existing.keyMismatch])
      if (!existing.contactReq) {
        existing.contactReq = true
        if (nickname) existing.nickname = nickname
        if (note) existing.note = note
      }
      // A repeat still records who sealed it: the accept check needs every key
      // this row's envelopes arrived under, not only the first one.
      noteProof(existing, proof)
      if (JSON.stringify([existing.contactReq, existing.spubs, existing.keyMismatch]) !== before) {
        map[k] = existing
        saveAll(map)
      }
      return
    }
    if (Object.keys(map).length >= MAX_PENDING) {
      const oldest = Object.values(map).sort((a, b) => a.firstAt - b.firstAt)[0]
      if (oldest) delete map[reqKey(oldest.uin, oldest.host)]
    }
    const row: CrossIslandRequest = {
      uin,
      host,
      firstAt: Date.now(),
      msgs: [],
      contactReq: true,
      nickname: nickname || undefined,
      note: note || undefined,
    }
    noteProof(row, proof)
    map[k] = row
    saveAll(map)
  })
  return true
}

export function listRequests(): CrossIslandRequest[] {
  return Object.values(loadAll()).sort((a, b) => b.firstAt - a.firstAt)
}

export function requestCount(): number {
  return Object.keys(loadAll()).length
}

/// Remove a pending request (after Accept replays its messages, or on dismiss).
///
/// Returns the row so the caller can replay the held messages. Null when the
/// store is not open yet — every UI caller runs long after that, and the one
/// receive-path caller (a `decline` from the peer) only needs the removal.
export function clearRequest(uin: number, host: string): CrossIslandRequest | null {
  if (!cache) {
    whenLoaded(() => clearRequest(uin, host))
    return null
  }
  const map = loadAll()
  const k = reqKey(uin, host)
  const r = map[k] ?? null
  delete map[k]
  saveAll(map)
  return r
}

/// Block a sender: drop the pending request + remember so future deposits are
/// dropped on arrival.
/// Let them through again. Without this a block was a one-way door with no
/// handle on the inside: the only way back was clearing site data.
export function unblockRequest(uin: number, host: string): void {
  const b = loadBlocked()
  delete b[reqKey(uin, host)]
  localStorage.setItem(BLOCKED_KEY(), JSON.stringify(b))
}

export function blockRequest(uin: number, host: string): void {
  clearRequest(uin, host)
  const b = loadBlocked()
  b[reqKey(uin, host)] = true
  localStorage.setItem(BLOCKED_KEY(), JSON.stringify(b))
}

// -----------------------------------------------------------
// Requests from an island's own list (spec 2026-09-15, F1)
// -----------------------------------------------------------

/// The row for (uin, host), or null. Null too while the store is still
/// opening: the poll that asks awaits `ensureRequestsLoaded` first.
export function getRequest(uin: number, host: string): CrossIslandRequest | null {
  return loadAll()[reqKey(uin, host)] ?? null
}

/// File one live row of `host`'s request list, addressed to our number there
/// (`guestUin`). No-op for a blocked sender. Merges into a §5f row for the same
/// person and never moves `firstAt` (crossisland-pending.ts).
export function upsertServerRequest(host: string, guestUin: number, row: ServerPendingRow): boolean {
  if (isBlocked(row.from_uin, host)) return false
  whenLoaded(() => {
    const map = loadAll()
    if (mergeServerRequest(map, host, guestUin, row, Date.now(), MAX_PENDING)) saveAll(map)
  })
  return true
}

/// Forget rows on `host` the island no longer lists (withdrawn by the
/// requester, expired, or answered from another device).
export function reconcileServerRequests(host: string, liveIds: number[]): void {
  whenLoaded(() => {
    const map = loadAll()
    if (reconcileServerRows(map, host, liveIds)) saveAll(map)
  })
}

/// An accept for this row was pinned here but its deposit did not reach the
/// requester. The row stays, without its held messages (they were released by
/// the accept), and the poll deposits again. Returns the tries so far.
export function noteAcceptUndelivered(uin: number, host: string): number {
  const map = loadAll()
  const r = map[reqKey(uin, host)]
  if (!r) return 0
  r.srvAcceptTries = (r.srvAcceptTries ?? 0) + 1
  r.msgs = []
  saveAll(map)
  return r.srvAcceptTries
}

// The island rows already answered on this device (or on another of ours, via
// a `ciack` carbon), so a poll never shows one twice. Plain and unsealed, like
// the block list next door: host and row id, no words. Scoped by account, so a
// UIN move carries it with every other `rcq.web.<uin>.` key (move-carry.ts).
const ANSWERED_KEY = () => scopedKey('ci-answered.v1')
/// Oldest entries fall off first. An island forgets a row it withdrew, so an
/// entry this old is one nobody will be shown again anyway.
const MAX_ANSWERED = 500

function loadAnswered(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ANSWERED_KEY()) || '[]') as unknown
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return []
  }
}

export function markAnswered(host: string, id: number): void {
  const k = answeredKey(host, id)
  // An answer that settled the row also settles a decline still waiting for
  // the island to take it.
  dropDeclining((list) => list.filter((x) => x !== k))
  const list = loadAnswered()
  if (list.includes(k)) return
  list.push(k)
  try {
    localStorage.setItem(ANSWERED_KEY(), JSON.stringify(list.slice(-MAX_ANSWERED)))
  } catch {
    /* quota: the row may be shown again, and answering it again is harmless */
  }
}

export function isAnswered(host: string, id: number): boolean {
  return loadAnswered().includes(answeredKey(host, id))
}

// Island rows a person declined here whose `respond(false)` the island has not
// taken yet (lost to the network, a 429, a 401 that could not be re-proved).
// The row is NOT answered until the island has it: the visited poll sends the
// same decline again, never a withdraw, because the spec's decline is an
// honest "no" the requester reads from that island. Same shape and scope as
// the answered set.
const DECLINING_KEY = () => scopedKey('ci-declining.v1')
const MAX_DECLINING = 200

function loadDeclining(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DECLINING_KEY()) || '[]') as unknown
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return []
  }
}

function dropDeclining(edit: (list: string[]) => string[]): void {
  const list = loadDeclining()
  if (list.length === 0) return
  const next = edit(list)
  if (next.length === list.length) return
  try {
    localStorage.setItem(DECLINING_KEY(), JSON.stringify(next))
  } catch {
    /* quota: the poll sends a decline that already landed, and the island answers it idempotently */
  }
}

export function markDeclinePending(host: string, id: number): void {
  const k = answeredKey(host, id)
  const list = loadDeclining()
  if (list.includes(k)) return
  list.push(k)
  try {
    localStorage.setItem(DECLINING_KEY(), JSON.stringify(list.slice(-MAX_DECLINING)))
  } catch {
    /* quota: the decline is still sent now, only not retried */
  }
}

export function isDeclinePending(host: string, id: number): boolean {
  return loadDeclining().includes(answeredKey(host, id))
}

/// Forget waiting declines on `host` for rows the island no longer lists
/// (the requester withdrew, or the row expired): nothing left to answer.
export function pruneDeclinePending(host: string, liveIds: number[]): void {
  const prefix = `${host.toLowerCase()}#`
  const live = new Set(liveIds.map((id) => answeredKey(host, id)))
  dropDeclining((list) => list.filter((k) => !k.startsWith(prefix) || live.has(k)))
}

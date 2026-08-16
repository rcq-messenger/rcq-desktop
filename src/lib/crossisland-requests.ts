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
}

function reqKey(uin: number, host: string): string {
  return `${uin}@${host.toLowerCase()}`
}

function loadAll(): Record<string, CrossIslandRequest> {
  try {
    return JSON.parse(localStorage.getItem(KEY()) || '{}') as Record<string, CrossIslandRequest>
  } catch {
    return {}
  }
}

function saveAll(map: Record<string, CrossIslandRequest>): void {
  localStorage.setItem(KEY(), JSON.stringify(map))
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
export function holdRequestMessage(uin: number, host: string, env: Envelope): boolean {
  if (isBlocked(uin, host)) return false
  const map = loadAll()
  const k = reqKey(uin, host)
  const existing = map[k] ?? { uin, host, firstAt: Date.now(), msgs: [] }
  // Dedup by envelope id so a re-drained queue row doesn't pile up.
  if (!existing.msgs.some((m) => (m as { id?: string }).id === (env as { id?: string }).id)) {
    existing.msgs.push(env)
    if (existing.msgs.length > MAX_HELD) existing.msgs = existing.msgs.slice(-MAX_HELD)
  }
  map[k] = existing
  saveAll(map)
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
export function addContactRequest(uin: number, host: string, nickname?: string, note?: string): boolean {
  if (isBlocked(uin, host)) return false
  const map = loadAll()
  const k = reqKey(uin, host)
  const existing = map[k]
  if (existing) {
    // Already pending — promote a message-quarantine row to also being a
    // contact request (they asked properly), but never duplicate the row and
    // never move `firstAt`, so a flood cannot bump itself to the top.
    if (!existing.contactReq) {
      existing.contactReq = true
      if (nickname) existing.nickname = nickname
      if (note) existing.note = note
      map[k] = existing
      saveAll(map)
    }
    return true
  }
  if (Object.keys(map).length >= MAX_PENDING) {
    const oldest = Object.values(map).sort((a, b) => a.firstAt - b.firstAt)[0]
    if (oldest) delete map[reqKey(oldest.uin, oldest.host)]
  }
  map[k] = {
    uin,
    host,
    firstAt: Date.now(),
    msgs: [],
    contactReq: true,
    nickname: nickname || undefined,
    note: note || undefined,
  }
  saveAll(map)
  return true
}

export function listRequests(): CrossIslandRequest[] {
  return Object.values(loadAll()).sort((a, b) => b.firstAt - a.firstAt)
}

export function requestCount(): number {
  return Object.keys(loadAll()).length
}

/// Remove a pending request (after Accept replays its messages, or on dismiss).
export function clearRequest(uin: number, host: string): CrossIslandRequest | null {
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

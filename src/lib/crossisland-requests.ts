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

const KEY = 'rcq.web.ci-requests.v1'
const BLOCKED_KEY = 'rcq.web.ci-blocked.v1'
const MAX_HELD = 20 // cap held messages per pending sender

export interface CrossIslandRequest {
  uin: number
  host: string
  firstAt: number
  msgs: Envelope[]
}

function reqKey(uin: number, host: string): string {
  return `${uin}@${host.toLowerCase()}`
}

function loadAll(): Record<string, CrossIslandRequest> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, CrossIslandRequest>
  } catch {
    return {}
  }
}

function saveAll(map: Record<string, CrossIslandRequest>): void {
  localStorage.setItem(KEY, JSON.stringify(map))
}

function loadBlocked(): Record<string, true> {
  try {
    return JSON.parse(localStorage.getItem(BLOCKED_KEY) || '{}') as Record<string, true>
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
export function blockRequest(uin: number, host: string): void {
  clearRequest(uin, host)
  const b = loadBlocked()
  b[reqKey(uin, host)] = true
  localStorage.setItem(BLOCKED_KEY, JSON.stringify(b))
}

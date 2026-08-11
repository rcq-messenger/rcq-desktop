// Cross-island GROUPS (room-host, federation §5c): a group lives entirely on
// ONE island. A member from another island becomes a first-class citizen of
// the group's island via a GUEST registration — recover-first with the SAME
// keypair (the multihome mechanic), giving a per-island (uin, jwt). All group
// machinery then runs unchanged on the host island: roster, fan-out, mailbox
// spool. The guest client deposits sends there and polls its guest mailbox.
// No island ever talks to another island.
//
// Unlike backup homes (multihome.ts), visited islands are PRIVATE: they are
// never published in the signed home-island record — group membership is not
// an addressing fact.
//
// Foreign group ids: per-island ints collide across islands, and every store
// (threads, unread, routes) keys groups by a number. Foreign groups therefore
// get a stable NEGATIVE local alias id, mapped here; the boundary translates
// alias ↔ (host, remoteId). Server ids are positive, so no collision.

import { type WebIdentity } from './crypto'
import {
  normalizeIslandHost,
  hostOfApiBase,
  recoverOnIsland,
  registerOnIsland,
} from './multihome'

import { scopedKey } from './account-scope'

export interface VisitedIsland {
  host: string
  uin: number // per-island uin of this identity (same keys as primary)
  jwt: string
  addedAt: number
}

interface ForeignGroupRef {
  host: string
  remoteId: number
  aliasId: number // negative, stable per account
}

const VISITED_KEY = () => scopedKey('visited.v1')
const ALIAS_KEY = () => scopedKey('fgroup-alias.v1')

export function listVisitedIslands(): VisitedIsland[] {
  try {
    return JSON.parse(localStorage.getItem(VISITED_KEY()) || '[]') as VisitedIsland[]
  } catch {
    return []
  }
}

function saveVisited(list: VisitedIsland[]): void {
  localStorage.setItem(VISITED_KEY(), JSON.stringify(list))
}

/// Guest credentials for `hostInput`, registering (recover-first) on first
/// use. Throws with a human-readable message on failure.
export async function ensureGuestOn(identity: WebIdentity, hostInput: string): Promise<VisitedIsland> {
  const host = normalizeIslandHost(hostInput)
  if (!host) throw new Error('invalid host')
  if (host === hostOfApiBase(identity.apiBase)) throw new Error('own island')
  const existing = listVisitedIslands().find((v) => v.host === host)
  if (existing) return existing
  const cred = (await recoverOnIsland(host, identity)) ?? (await registerOnIsland(host, identity))
  const v: VisitedIsland = { host, uin: cred.uin, jwt: cred.token, addedAt: Date.now() }
  saveVisited([...listVisitedIslands(), v])
  return v
}

/// Refresh an expired guest jwt via the recover handshake (we still hold the
/// signing key). Returns the updated entry, or null when recovery fails.
export async function refreshGuestAuth(identity: WebIdentity, host: string): Promise<VisitedIsland | null> {
  try {
    const cred = await recoverOnIsland(host, identity)
    if (!cred) return null
    const list = listVisitedIslands()
    const i = list.findIndex((v) => v.host === host)
    if (i < 0) return null
    list[i] = { ...list[i], uin: cred.uin, jwt: cred.token }
    saveVisited(list)
    return list[i]
  } catch {
    return null
  }
}

/// Identity clone that targets `host` with the guest credentials — every
/// existing Api.* call works against the group's island unchanged. Null when
/// the island was never visited.
export function guestIdentityFor(identity: WebIdentity, host: string): WebIdentity | null {
  const v = listVisitedIslands().find((x) => x.host === host)
  if (!v) return null
  return { ...identity, apiBase: `https://${v.host}`, jwt: v.jwt, uin: v.uin, guest: true }
}

// -----------------------------------------------------------
// Foreign-group alias ids
// -----------------------------------------------------------

function loadAliases(): ForeignGroupRef[] {
  try {
    return JSON.parse(localStorage.getItem(ALIAS_KEY()) || '[]') as ForeignGroupRef[]
  } catch {
    return []
  }
}

function saveAliases(list: ForeignGroupRef[]): void {
  localStorage.setItem(ALIAS_KEY(), JSON.stringify(list))
}

export function isForeignGroupId(id: number): boolean {
  return id < 0
}

/// Stable local alias for (host, remoteId); allocated on first sight.
export function aliasFor(host: string, remoteId: number): number {
  const list = loadAliases()
  const hit = list.find((r) => r.host === host && r.remoteId === remoteId)
  if (hit) return hit.aliasId
  const aliasId = -(1000 + list.length) // negative: server ids are positive
  saveAliases([...list, { host, remoteId, aliasId }])
  return aliasId
}

export function refByAlias(aliasId: number): { host: string; remoteId: number } | null {
  const hit = loadAliases().find((r) => r.aliasId === aliasId)
  return hit ? { host: hit.host, remoteId: hit.remoteId } : null
}

/// Drain the guest mailbox on every visited island (the receive path for
/// cross-island groups: the host island spools group fan-out into our guest
/// mailbox there). The handler gets each row plus the island it came from so
/// group rows can be filed under the local alias. A 401 re-proves the key
/// (recover) once and retries; an unreachable island just waits for the next
/// tick. The legacy /messages/queue fetch advances the cursor server-side.
export async function drainVisitedQueues(
  identity: WebIdentity,
  handle: (
    row: { envelope_type: string; payload: string; group_id: number | null },
    host: string,
  ) => Promise<void>,
): Promise<void> {
  for (const v of listVisitedIslands()) {
    try {
      const get = (jwt: string) =>
        fetch(`https://${v.host}/messages/queue`, {
          headers: { Authorization: `Bearer ${jwt}` },
        })
      let res = await get(v.jwt)
      if (res.status === 401) {
        const fresh = await refreshGuestAuth(identity, v.host)
        if (!fresh) continue
        res = await get(fresh.jwt)
      }
      if (!res.ok) continue
      const rows = (await res.json()) as Array<{
        envelope_type: string
        payload: string
        group_id: number | null
      }>
      for (const r of rows) await handle(r, v.host)
    } catch {
      /* island unreachable — next tick */
    }
  }
}

/// Resolve the (identity, server-side group id, island host) to use for any
/// group API call. Local groups pass through untouched.
export function groupApiCtx(
  identity: WebIdentity,
  groupId: number,
): { ident: WebIdentity; gid: number; host: string | null } {
  if (!isForeignGroupId(groupId)) return { ident: identity, gid: groupId, host: null }
  const ref = refByAlias(groupId)
  if (!ref) return { ident: identity, gid: groupId, host: null } // dangling alias — let the call 404
  const guest = guestIdentityFor(identity, ref.host)
  return guest
    ? { ident: guest, gid: ref.remoteId, host: ref.host }
    : { ident: identity, gid: ref.remoteId, host: ref.host }
}

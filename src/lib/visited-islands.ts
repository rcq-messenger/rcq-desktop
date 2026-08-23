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
import { drainGroupLog, islandHasGroupLog, type GroupLogRequest } from './group-log'

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

/// ⚠⚠ Guest tokens live HERE and nowhere else — never on disk.
///
/// A guest token is a live credential for this identity on somebody else's
/// island, and it sat in plain localStorage next to the host it belonged to.
/// It never needed to: `refreshGuestAuth` below already re-mints one through
/// the recover handshake with our own signing key, which is what happens when
/// a stored token ages out anyway. So the copy at rest bought a slightly
/// faster first request after a restart and cost a credential in the clear.
/// Same treatment the backup-island tokens just got in `multihome.ts`.
const tokens = new Map<string, string>()

const VISITED_KEY = () => scopedKey('visited.v1')
const ALIAS_KEY = () => scopedKey('fgroup-alias.v1')

export function listVisitedIslands(): VisitedIsland[] {
  try {
    const list = JSON.parse(localStorage.getItem(VISITED_KEY()) || '[]') as VisitedIsland[]
    // The token comes from memory. A record written by an older build still
    // carries one on disk; it is ignored rather than trusted, so upgrading
    // drops the stored credential on the first read.
    return list.map((v) => ({ ...v, jwt: tokens.get(v.host) ?? '' }))
  } catch {
    return []
  }
}

function saveVisited(list: VisitedIsland[]): void {
  // The only writer, which is what makes "no credential at rest" a property of
  // the file rather than a habit.
  const onDisk = list.map(({ jwt, ...rest }) => {
    if (jwt) tokens.set(rest.host, jwt)
    return { ...rest, jwt: '' }
  })
  localStorage.setItem(VISITED_KEY(), JSON.stringify(onDisk))
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

/// A guest identity that is guaranteed to carry a token, minting one when this
/// run has not needed that island yet.
///
/// ⚠ Use this, not `guestIdentityFor`, anywhere that does not already handle a
/// 401 by refreshing. Tokens are no longer persisted, so the first call to an
/// island after a restart has none — the contact list survives that because it
/// retries on 401, and the join card did not.
export async function ensureGuestAuth(
  identity: WebIdentity,
  host: string,
): Promise<WebIdentity | null> {
  const known = listVisitedIslands().find((v) => v.host === host)
  if (!known) return null
  if (known.jwt) return guestIdentityFor(identity, host)
  return (await refreshGuestAuth(identity, host)) ? guestIdentityFor(identity, host) : null
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

/// One row off a visited island's guest mailbox, legacy queue or room log.
export interface GuestQueueRow {
  envelope_type: string
  payload: string
  group_id: number | null
  // Stage 2 (core-metadata plan): retention/push class + durable per-mailbox
  // sequence, read when present. Cursoring is unchanged; `seq` is gappy per
  // device, so it is never used as a missing-message detector.
  cls?: number | null
  seq?: number | null
}

/// Drain the guest mailbox on every visited island (the receive path for
/// cross-island groups: the host island spools group fan-out into our guest
/// mailbox there). The handler gets each row plus the island it came from so
/// group rows can be filed under the local alias. A 401 re-proves the key
/// (recover) once and retries; an unreachable island just waits for the next
/// tick. The legacy /messages/queue fetch advances the cursor server-side.
///
/// Stage 5: a visited island that advertises `group_log` also gets the guest's
/// room logs drained, right after its legacy queue, when `log` is given. Its
/// handler must THROW on a transient failure (the log is acked by position;
/// the legacy handler swallows because that fetch is ack-less). A room lives
/// on its island, so the capability is read per island; one that lacks it is
/// asked nothing new. `log.persisted` is awaited before the log ack.
export async function drainVisitedQueues(
  identity: WebIdentity,
  handle: (row: GuestQueueRow, host: string) => Promise<void>,
  log?: GuestLogDrainHooks,
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
      const rows = (await res.json()) as GuestQueueRow[]
      for (const r of rows) await handle(r, v.host)
    } catch {
      /* island unreachable — next tick */
    }
    if (log) await drainVisitedLog(identity, v.host, log)
  }
}

/// The caller's half of a guest room-log drain: see multihome.ts LogDrainHooks.
export interface GuestLogDrainHooks {
  handle: (row: GuestQueueRow, host: string) => Promise<void>
  persisted?: () => Promise<void>
}

/// The guest's room logs on one visited island (Stage 5), when it keeps them.
/// Same guest token and the same 401 refresh as the queue above.
async function drainVisitedLog(identity: WebIdentity, host: string, log: GuestLogDrainHooks): Promise<void> {
  const apiBase = `https://${host}`
  if (!(await islandHasGroupLog(apiBase))) return
  // Read again rather than taken from the caller: the queue drain just before
  // this may have refreshed the token.
  const v = listVisitedIslands().find((x) => x.host === host)
  if (!v) return
  let jwt = v.jwt
  const request: GroupLogRequest = async (path, body) => {
    const post = () =>
      fetch(`${apiBase}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify(body),
      })
    let res = await post()
    if (res.status === 401) {
      const fresh = await refreshGuestAuth(identity, host)
      if (!fresh) return res
      jwt = fresh.jwt
      res = await post()
    }
    return res
  }
  try {
    await drainGroupLog(
      apiBase,
      v.uin,
      request,
      (r) => log.handle({ envelope_type: r.envelope_type, payload: r.payload, group_id: r.gid, cls: r.cls, seq: r.seq }, host),
      log.persisted,
    )
  } catch {
    /* island unreachable, or the log answered an error: next tick */
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

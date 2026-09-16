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

import { Api, ApiError } from './api'
import { type WebIdentity } from './crypto'
import {
  normalizeIslandHost,
  hostOfApiBase,
  listBackupHomes,
} from './multihome'
import { GuestJoinError, guestCredentialsFor, recoverGuestCopy } from './guest-register'
import { guestProfileBody, legacyNicknameRepairBody } from './guest-path'
import { announceRotatedElsewhere } from './rotated-signal'

import { scopedKey } from './account-scope'
import { isBurning } from './burn-cascade'
import { drainGroupLog, islandHasGroupLog, type GroupLogRequest } from './group-log'

export interface VisitedIsland {
  host: string
  uin: number // per-island uin of this identity (same keys as primary)
  jwt: string
  addedAt: number
  /// The island said this copy is a GUEST (spec 2026-09-15, 2.3): rooms only.
  /// Absent on entries older than the flag and on islands that do not say.
  guest?: boolean
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

/// Guest credentials for `hostInput`, made on first use.
///
/// Spec 2026-09-15, 12.1: an island that advertises `guest_accounts_v1` gets
/// `POST /auth/guest` with a proof bound to the room `opts.groupId` (its id
/// THERE), which works through a paid door and claims a seat an owner put us
/// in. Every other island keeps today's recover-first registration, without
/// `desired_uin`. A door refusal on that legacy path still throws the shape
/// `doorRefusalOf` reads; a refusal on the guest path throws `GuestJoinError`.
export async function ensureGuestOn(
  identity: WebIdentity,
  hostInput: string,
  opts?: { groupId?: number },
): Promise<VisitedIsland> {
  const host = normalizeIslandHost(hostInput)
  if (!host) throw new Error('invalid host')
  if (host === hostOfApiBase(identity.apiBase)) throw new Error('own island')
  // A burn is deleting every copy this browser knows of; a new one registered
  // meanwhile would be a copy nobody deletes (spec 2026-09-15, F2).
  if (isBurning()) throw new Error('burning')
  const existing = listVisitedIslands().find((v) => v.host === host)
  if (existing) return existing
  let cred
  try {
    cred = await guestCredentialsFor(host, identity, opts?.groupId)
  } catch (e) {
    // D2: the key was retired by a rotation. The account's rotated-elsewhere
    // notice, never a wipe and never a generic join error; rethrown so the
    // caller stops.
    if (e instanceof GuestJoinError && e.code === 'identity_rotated') announceRotatedElsewhere(identity.uin)
    throw e
  }
  const v: VisitedIsland = {
    host,
    uin: cred.uin,
    jwt: cred.token,
    addedAt: Date.now(),
    ...(cred.guest ? { guest: true } : {}),
  }
  saveVisited([...listVisitedIslands(), v])
  // #985(2): the row there was named by registration (a suggested name, not
  // ours) or by whoever added us to a group there, and has never heard the
  // name we actually use. Say it once, now, so a stale name corrects itself
  // without waiting for our next rename. Not awaited: a join must not wait
  // on, or fail over, a cosmetic.
  // E6 runs after it, never beside it: the repair reads the name the island
  // holds, and reading it before this push landed would mean repairing a name
  // that is about to be replaced anyway.
  void pushOwnNicknameTo(identity, host).then(() => repairLegacyNicknameOn(identity, host))
  return v
}

/// Forget the guest copy on `host` locally: the entry and its token. For a
/// copy the island confirmed it deleted while the account itself stays (a
/// burn cancelled halfway, spec 2026-09-15, F2). Kept, the entry would make
/// `ensureGuestOn` hand back a copy that no longer exists, and every join on
/// that island would fail at the recover that follows.
///
/// ⚠ The group aliases stay. They are allocated by list position, so dropping
/// one would let the next room reuse a live alias id; and a copy registered
/// again later maps the same (host, room) to the same alias, which keeps that
/// room's history where it was.
export function forgetVisitedIsland(hostInput: string): void {
  const host = normalizeIslandHost(hostInput) ?? hostInput.trim().toLowerCase()
  const list = listVisitedIslands()
  const next = list.filter((v) => v.host !== host)
  tokens.delete(host)
  if (next.length !== list.length) saveVisited(next)
}

/// #985(2), first half: our nickname as the residents of `host` see it.
///
/// A guest copy is a row of its own on that island, and `PUT /users/me` on the
/// home island updates the home row only: nothing on either island carries a
/// rename across, by design (§5c, islands do not talk). This client holds the
/// guest token, so it is the only party that can repeat the rename there.
///
/// Only the nickname travels. That island already shows a name to the group's
/// members, so nothing new is disclosed, and no other profile field has any
/// business going with it. Only to islands in this account's own store, never
/// to one learned from a peer. Best effort: false on any failure, with one
/// recover-and-retry on a 401 (tokens are memory-only and expire).
export async function pushNicknameToVisited(identity: WebIdentity, host: string, nickname: string): Promise<boolean> {
  // ⚠⚠ D1: a rename to another island is a request to a foreign island like
  // any other, and may not carry our home number. A name that IS a number
  // (`user-1234`, the minted default) or that holds our home number goes as the
  // neutral word instead (guestProfileBody).
  const body = guestProfileBody(nickname, identity.uin)
  if (!body) return false
  // E6: the legacy-name repair reads the copy's name and may write the neutral
  // word over it. While a rename of ours is in flight it stands aside, or a
  // real name pushed here would lose the race to "Guest".
  renaming.add(host)
  try {
    return await pushNicknameNow(identity, host, body)
  } finally {
    renaming.delete(host)
  }
}

async function pushNicknameNow(
  identity: WebIdentity,
  host: string,
  body: { nickname: string },
): Promise<boolean> {
  const ident = await ensureGuestAuth(identity, host).catch(() => null)
  if (!ident) return false
  try {
    await Api.updateProfile(ident, body)
    return true
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) return false
  }
  if (!(await refreshGuestAuth(identity, host))) return false
  const fresh = guestIdentityFor(identity, host)
  if (!fresh) return false
  try {
    await Api.updateProfile(fresh, body)
    return true
  } catch {
    return false
  }
}

/// The name the HOME island holds for us, pushed to our copy on `host`.
async function pushOwnNicknameTo(identity: WebIdentity, host: string): Promise<void> {
  try {
    const me = await Api.myInfo(identity)
    if (me.nickname) await pushNicknameToVisited(identity, host, me.nickname)
  } catch {
    /* the next rename pushes it again */
  }
}

/// Hosts with a rename of our copy in flight right now (see pushNickname...).
const renaming = new Set<string>()

/// Islands whose copy has already been looked at by the repair below. A list of
/// hosts, not a credential and not a secret, so the ordinary account-scoped
/// key; a browser that cannot write it simply does the read again next time,
/// and the repair is idempotent.
const NAME_FIX_KEY = () => scopedKey('guest-name-fix.v1')

function nameFixedHosts(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(NAME_FIX_KEY()) || '[]') as unknown
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function markNameFixed(host: string): void {
  const list = nameFixedHosts()
  if (list.includes(host)) return
  try {
    localStorage.setItem(NAME_FIX_KEY(), JSON.stringify([...list, host]))
  } catch {
    /* storage full or blocked: it runs again, and it changes nothing twice */
  }
}

/// E6: take our HOME NUMBER off the copy we hold on `host`, once.
///
/// Every copy this client made before D1 was minted or renamed with the
/// `user-<uin>` fallback, and the digits in it are our number at home: the one
/// fact a guest copy exists not to hand the island it lives on. No island
/// carries a rename across (§5c), so nothing but this client can take it off,
/// and it stays there until we do. So on the next sign-in to that island the
/// name the island holds is read, and a name that really spells our own number
/// is replaced with the neutral word every client uses.
///
/// ⚠⚠ Never a backup home. There the number is in the signed island record on
/// purpose, which is what a backup home IS; the hosts are told apart by the
/// backup store, not by how the copy looks.
///
/// Best effort and silent: an island that does not answer, a token that aged
/// out, a refusal - the host is left unmarked and the next sign-in tries again.
export async function repairLegacyNicknameOn(identity: WebIdentity, host: string): Promise<void> {
  if (renaming.has(host) || nameFixedHosts().includes(host)) return
  if (listBackupHomes().some((h) => h.host === host)) return
  const ident = guestIdentityFor(identity, host)
  if (!ident?.jwt) return
  try {
    const me = await Api.userInfo(ident, ident.uin)
    // ⚠ `identity.uin` is our number AT HOME, which is what may not be there.
    // `ident.uin` is the copy's own number on that island, which is that
    // island's own business and never a leak.
    const body = legacyNicknameRepairBody(me.nickname, identity.uin)
    if (body) await Api.updateProfile(ident, body)
    markNameFixed(host)
  } catch {
    /* unreachable or refused: not marked, so the next sign-in asks again */
  }
}

/// Refresh an expired guest jwt via the recover handshake (we still hold the
/// signing key). Returns the updated entry, or null when recovery fails.
export async function refreshGuestAuth(identity: WebIdentity, host: string): Promise<VisitedIsland | null> {
  try {
    const cred = await recoverGuestCopy(host, identity)
    if (!cred) return null
    const list = listVisitedIslands()
    const i = list.findIndex((v) => v.host === host)
    if (i < 0) return null
    // `guest` follows the island's latest answer: a recover can claim a seat
    // (guest from then on), and a settle elsewhere makes the row native.
    list[i] = { ...list[i], uin: cred.uin, jwt: cred.token, guest: cred.guest === true }
    saveVisited(list)
    // A recover IS a sign-in to that island (E6): the one moment this client is
    // holding a live token there and can take an old `user-<home uin>` name off
    // the copy. Not awaited, and it stands aside while a rename is in flight.
    void repairLegacyNicknameOn(identity, host)
    return list[i]
  } catch (e) {
    // D2: the recover inside the guest flow met a retired key.
    if (e instanceof GuestJoinError && e.code === 'identity_rotated') announceRotatedElsewhere(identity.uin)
    return null
  }
}

/// Record that the copy on `host` is (no longer) a guest, after a settle on
/// that island (spec 2026-09-15, 9.1). No-op for an island this account never
/// visited.
export function setVisitedGuest(host: string, guest: boolean): void {
  const list = listVisitedIslands()
  const i = list.findIndex((v) => v.host === host)
  if (i < 0 || (list[i].guest === true) === guest) return
  list[i] = { ...list[i], guest }
  saveVisited(list)
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
  opts: {
    /// An island the caller's trust layer has refused: nothing is sent to
    /// it, not even the token refresh. The console pins islands by their
    /// certificate fingerprint and needs this to hold a refusal here.
    skip?: (host: string) => boolean
  } = {},
): Promise<void> {
  for (const v of listVisitedIslands()) {
    if (opts.skip?.(v.host)) continue
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

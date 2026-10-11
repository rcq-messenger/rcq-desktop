// The gathering half of sender-trust.ts: what this device holds about a
// number, read off the stores (and, at most once per person and rate-limited,
// off the island), handed to the pure rule.
//
// Kept apart from message-receiver.tsx because the room-roster cache is its
// own small store, and from sender-trust.ts because the rule must stay pure
// enough to be proven offline.

import { Api, ApiError, onRosterFetched, type Contact, type GroupMember, type RCQGroup } from './api'
import { bytesToB64, type WebIdentity } from './crypto'
import { canonicalHost } from './crossisland-gate'
import { contactsCache, snapshotFor } from './contacts-cache'
import { listCrossIsland } from './crossisland-store'
import { theirCard } from './guest-card'
import { backupIdentityFor } from './multihome'
import { peerSealKeys } from './peer-keys'
import { directSenderTrust, roomSenderTrust, type SenderTrust, type TrustVerdict, type V2Identity } from './sender-trust'
import { pinFirstSight, repinSignKey, signPinFor } from './sign-pins'
import { guestIdentityFor, refByAlias } from './visited-islands'

function hostOf(apiBase: string): string {
  try {
    return new URL(apiBase).host
  } catch {
    return apiBase
  }
}

/// `from_host` when it names an island other than ours, else null. Compared in
/// one spelling: `API.RCQ.APP`, `api.rcq.app:443` and `api.rcq.app.` are ours.
export function foreignClaim(claimed: string | null | undefined, identity: WebIdentity): string | null {
  if (typeof claimed !== 'string' || !claimed) return null
  return canonicalHost(claimed) === canonicalHost(hostOf(identity.apiBase)) ? null : claimed
}

// ── our island's roster ────────────────────────────────────────────────────

/// The roster read straight from the island when this browser has never
/// stored one (a fresh sign-in drains the queue before the contacts page has
/// loaded anything). One read per account at a time; a failure is believed
/// for thirty seconds.
const rosterReads = new Map<number, { at: number; rows: Contact[] | null; flight?: Promise<Contact[] | null> }>()

async function ownRoster(identity: WebIdentity): Promise<Contact[] | null> {
  const held = contactsCache.get(identity.uin)?.contacts ?? snapshotFor(identity.uin)?.contacts
  if (held) return held
  const r = rosterReads.get(identity.uin)
  if (r?.rows) return r.rows
  if (r?.flight) return r.flight
  if (r && Date.now() - r.at < 30_000) return null
  const flight = Api.contacts(identity)
    .then((rows) => (Array.isArray(rows) ? rows : null))
    .catch(() => null)
    .then((rows) => {
      rosterReads.set(identity.uin, { at: Date.now(), rows })
      return rows
    })
  rosterReads.set(identity.uin, { at: Date.now(), rows: null, flight })
  return flight
}

/// Our island's roster row for `uin`, with its signing key. A row that
/// carries no key falls back to the island's card (peer-keys.ts: cached,
/// queued, one read per person per ten minutes).
async function ownRosterRow(identity: WebIdentity, uin: number): Promise<{ key: string | null } | null> {
  const rows = await ownRoster(identity)
  // Same-island rows only: a row with a host is a number on ANOTHER island.
  const row = rows?.find((c) => c.uin === uin && !c.host)
  if (!row) return null
  if (row.signing_key) return { key: row.signing_key }
  const keys = await peerSealKeys(identity, uin).catch(() => null)
  return { key: keys?.signing_key ?? null }
}

/// The one fresh card read a mismatch earns, per person per ten minutes. The
/// answer (or the lack of one) is reused inside that window, so a flood of
/// forged rows under a contact's number costs the island one read.
const CARD_RECHECK_MS = 10 * 60_000
const cardRechecks = new Map<string, { at: number; key: string | null }>()

async function freshCardKey(identity: WebIdentity, uin: number): Promise<string | null> {
  const k = `${identity.apiBase}|${identity.uin}|${uin}`
  const hit = cardRechecks.get(k)
  if (hit && Date.now() - hit.at < CARD_RECHECK_MS) return hit.key
  const info = await Api.userInfo(identity, uin, theirCard(uin)).catch(() => null)
  const key = info?.signing_key || null
  cardRechecks.set(k, { at: Date.now(), key })
  return key
}

/// The 1:1 verdict for one decrypted row: senderTrust over what this device
/// holds, the one card read a mismatch earns, and the pin written down. The
/// roster key is pinned the first time it is seen; a key our island vouches
/// for that differs from the pin is re-pinned WITH the banner (sign-pins.ts).
export async function resolveDirectTrust(
  identity: WebIdentity,
  senderUin: number,
  claimedHost: string | null | undefined,
  spub: string | null | undefined,
  v2: V2Identity | null | undefined,
): Promise<TrustVerdict> {
  const roster = senderUin === identity.uin ? null : await ownRosterRow(identity, senderUin)
  let pin = signPinFor(senderUin)
  if (!pin && roster?.key) pin = pinFirstSight(senderUin, roster.key)
  const input = {
    senderUin,
    myUin: identity.uin,
    spub: typeof spub === 'string' ? spub : null,
    v2: v2 ?? null,
    ownSigningKey: bytesToB64(identity.signingPub),
    claimedHost: foreignClaim(claimedHost, identity),
    roster,
    pin,
    crossIsland: listCrossIsland()
      .filter((c) => c.uin === senderUin)
      .map((c) => ({ host: c.host, signingKey: c.signingKey })),
  }
  let v = directSenderTrust(input)
  if (v.needsCard) v = directSenderTrust({ ...input, card: await freshCardKey(identity, senderUin) })
  if (v.repin) repinSignKey(senderUin, v.repin, v.keyChanged)
  return v
}

// ── room rosters ───────────────────────────────────────────────────────────

interface RosterEntry {
  at: number
  members: Map<number, { key: string | null; role: string }>
  /// The room's sealed blob, when the read that filled this entry carried it.
  stateBlob: string | null
}

/// Where a room's roster lives: our island for a room here, the room's island
/// (under our guest or backup copy there) for one of its local aliases.
export interface RoomCtx {
  ident: WebIdentity
  /// The island's own id for the room.
  gid: number
  /// The room's island, null for ours.
  host: string | null
  /// The id this device files the room under.
  localGid: number
}

export function roomCtx(identity: WebIdentity, localGid: number): RoomCtx | null {
  if (localGid >= 0) return { ident: identity, gid: localGid, host: null, localGid }
  const ref = refByAlias(localGid)
  if (!ref) return null
  const ident = guestIdentityFor(identity, ref.host) ?? backupIdentityFor(identity, ref.host)
  return ident ? { ident, gid: ref.remoteId, host: ref.host, localGid } : null
}

const rosters = new Map<string, RosterEntry>()
const rosterFlights = new Map<string, Promise<RosterEntry | null>>()
const rosterKey = (ident: WebIdentity, gid: number) => `${hostOf(ident.apiBase).toLowerCase()}|${ident.uin}|${gid}`

function entryFrom(members: GroupMember[], stateBlob: string | null): RosterEntry {
  const m = new Map<number, { key: string | null; role: string }>()
  for (const x of members) m.set(x.uin, { key: x.signing_key || null, role: x.role })
  return { at: Date.now(), members: m, stateBlob }
}

// Every roster any screen reads warms this one too (Chat's ensureRoster, the
// member list), so a busy room is rarely read for the receive path alone.
onRosterFetched((ident, gid, members) => {
  const k = rosterKey(ident, gid)
  rosters.set(k, entryFrom(members, rosters.get(k)?.stateBlob ?? null))
})

/// The full room the island pushed with a `group_membership_changed` (rooms of
/// up to a hundred): the roster as of that change, for free. The compact form
/// a larger room gets carries no roster and changes nothing here.
export function noteRoomSnapshot(identity: WebIdentity, group: RCQGroup): void {
  if (!Array.isArray(group.members) || group.members.length === 0 || typeof group.id !== 'number') return
  rosters.set(rosterKey(identity, group.id), entryFrom(group.members, group.state_blob ?? null))
}

/// A roster older than this is read again before it is believed. The roster of
/// a busy room is megabytes, every screen that reads one warms this cache, and
/// the island pushes small rooms' rosters on every change (noteRoomSnapshot),
/// so the receive path alone reads a room at most this often. A member who
/// joined since is caught by the miss below, not by this; what waits for it is
/// a member removed from a large room, whose rows pass until then.
const ROSTER_TTL_MS = 2 * 3600_000
/// A member missing from the roster, or under another key, earns one fresh
/// read at most this often per room: they may have joined or rotated since. A
/// stream of rows from outsiders costs the island one read per window.
const ROSTER_RECHECK_MS = 10_000

/// Read a room's roster from its island. Null when it could not be read
/// (anything but a definite "you are not in it" or "no such room").
function fetchRoster(ctx: RoomCtx): Promise<RosterEntry | null> {
  const k = rosterKey(ctx.ident, ctx.gid)
  const running = rosterFlights.get(k)
  if (running) return running
  const flight = Api.groupInfo(ctx.ident, ctx.gid)
    .then((g: RCQGroup) => {
      const e = entryFrom(Array.isArray(g.members) ? g.members : [], g.state_blob ?? null)
      rosters.set(k, e)
      return e
    })
    .catch((e) => {
      // Not a member any more, or no such room: an answer, and nobody speaks
      // there for us. Anything else is the network, and decides nothing.
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        const empty: RosterEntry = { at: Date.now(), members: new Map(), stateBlob: null }
        rosters.set(k, empty)
        return empty
      }
      return null
    })
    .finally(() => rosterFlights.delete(k))
  rosterFlights.set(k, flight)
  return flight
}

/// The roster to judge by: the cached one while it is young, a fresh read
/// otherwise, the stale copy when that read fails. Null only when nothing was
/// ever read and the island cannot be asked now.
async function roomRoster(ctx: RoomCtx): Promise<RosterEntry | null> {
  const hit = rosters.get(rosterKey(ctx.ident, ctx.gid))
  if (hit && Date.now() - hit.at < ROSTER_TTL_MS) return hit
  return (await fetchRoster(ctx)) ?? hit ?? null
}

export interface RoomDecision {
  trust: SenderTrust
  ctx: RoomCtx
  /// The sender's role in the roster that decided (owner/admin/member).
  role: string | null
  /// The room's sealed blob, when known (the room-key version bound).
  stateBlob: string | null
}

/// The verdict for one row in a room, or 'retry' when the roster could not be
/// read and nothing is cached: the caller leaves the row for a later drain
/// where it can (a v=1 seal or an unratcheted chain), drops it where it
/// cannot. `localGid` is the id this device files the room under.
export async function resolveRoomTrust(
  identity: WebIdentity,
  localGid: number,
  senderUin: number,
  spub: string | null | undefined,
  v2: V2Identity | null | undefined,
): Promise<RoomDecision | 'retry'> {
  const ctx = roomCtx(identity, localGid)
  // A room on an island we hold no copy on: nobody there can be asked about.
  if (!ctx) return { trust: 'unpinned', ctx: { ident: identity, gid: localGid, host: null, localGid }, role: null, stateBlob: null }
  // Our own number in this room needs no roster: our key, or nothing.
  if (senderUin === ctx.ident.uin) {
    const self = roomSenderTrust({
      senderUin,
      myUin: ctx.ident.uin,
      spub: typeof spub === 'string' ? spub : null,
      v2: v2 ?? null,
      ownSigningKey: bytesToB64(identity.signingPub),
      member: null,
    })
    return { trust: self.trust, ctx, role: null, stateBlob: rosters.get(rosterKey(ctx.ident, ctx.gid))?.stateBlob ?? null }
  }
  let r = await roomRoster(ctx)
  if (!r) return 'retry'
  const ownKey = bytesToB64(identity.signingPub)
  const memberKey = async (entry: RosterEntry): Promise<{ key: string | null } | null> => {
    const m = entry.members.get(senderUin)
    if (!m) return null
    if (m.key || ctx.host) return { key: m.key }
    // Our island, a row without a key: the card fallback, cached and queued.
    const keys = await peerSealKeys(identity, senderUin).catch(() => null)
    return { key: keys?.signing_key ?? null }
  }
  const ask = async (entry: RosterEntry) =>
    roomSenderTrust({
      senderUin,
      myUin: ctx.ident.uin,
      spub: typeof spub === 'string' ? spub : null,
      v2: v2 ?? null,
      ownSigningKey: ownKey,
      member: await memberKey(entry),
    })
  let v = await ask(r)
  if (v.refresh && Date.now() - r.at >= ROSTER_RECHECK_MS) {
    // Not in the copy we hold, or under another key: read it again once. A
    // read that fails decides nothing, and the row is left for later where
    // that is possible (a v=1 seal, a chain not yet ratcheted).
    const fresh = await fetchRoster(ctx)
    if (!fresh) return 'retry'
    r = fresh
    v = await ask(r)
  }
  const role = r.members.get(senderUin)?.role ?? null
  // A member of a room here is a person on our island: their key is pinned
  // like a contact's, on their first verified row, and a key the island
  // changed since is taken only with the banner (sign-pins.ts).
  if (v.trust === 'pinned' && ctx.host == null && typeof spub === 'string') {
    // A no-op unless a different key was pinned before.
    if (pinFirstSight(senderUin, spub)) repinSignKey(senderUin, spub, true)
  }
  return { trust: v.trust, ctx, role, stateBlob: r.stateBlob }
}

/// Read a room's roster afresh (and with it the sealed blob), for the
/// room-key version bound when the cached copy came without one.
export async function refreshRoomRoster(identity: WebIdentity, localGid: number): Promise<string | null> {
  const ctx = roomCtx(identity, localGid)
  if (!ctx) return null
  return (await fetchRoster(ctx))?.stateBlob ?? null
}

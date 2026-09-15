// The rules for a contact request that arrives through an island's own
// request list rather than as a sealed §5f envelope (spec 2026-09-15, F1).
//
// Somebody who lives on island B asks for a contact the only way B's app knows:
// `POST /contacts/request` to the number our guest copy holds on B. That row
// sits in B's database, addressed to a copy this person never signs in as, and
// until now nothing ever read it: the requester waited forever. The visited
// poll (crossisland-pending-poll.ts) now reads `GET /contacts/pending` there
// with the guest token and files each row into the same request list a §5f ask
// lands in, keyed by (uin, host).
//
// Pure: no store, no network, no imports, so the merge and the per-row verdict
// are proven offline against the built bundle (cli/test/pending-poll.mjs). The
// store (crossisland-requests.ts) and the poll call these and do the I/O.

/// Requests read from one island per poll, and the most rows that come ONLY
/// from that island's list the request list holds at once. The rest wait for
/// a later poll, so one hostile island cannot fill the list.
export const MAX_SERVER_ROWS_PER_HOST = 20
/// Entries of an island's answer looked at, at all. The island is somebody
/// else's; a longer array is cut before anything walks it.
export const MAX_RAW_SERVER_ROWS = 500
/// Deposits of one accept, counting the first, before the row says the island
/// did not take the answer and waits for a person.
export const MAX_ACCEPT_TRIES = 3
const NICKNAME_MAX = 64

/// One row of `GET /contacts/pending`, as far as this client believes it.
export interface ServerPendingRow {
  id: number
  from_uin: number
  nickname: string
}

/// What a request row remembers about the island row behind it. The island is
/// the row's own `host`; `guestUin` is our number there (the addressee).
export interface ServerRequestRef {
  id: number
  guestUin: number
  seenAt: number
}

/// The fields of a request row the merge reads and writes. Structural, so the
/// store's full row type fits without this file importing it.
export interface MergeableRequestRow {
  uin: number
  host: string
  firstAt: number
  msgs: unknown[]
  contactReq?: boolean
  nickname?: string
  server?: ServerRequestRef
  srvAcceptTries?: number
}

function reqKey(uin: number, host: string): string {
  return `${uin}@${host.toLowerCase()}`
}

const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0

/// The rows of an island's answer that are well formed and still pending.
///
/// ⚠ Nothing has type-checked this body, and it comes from an island we only
/// visit. A row without an integer id and sender is dropped, a nickname that
/// is not a string reads as none, and a state other than `pending` is not a
/// request (an older island may serve more than pending rows). Order is kept,
/// duplicates of an id are dropped.
export function validServerRows(raw: unknown): ServerPendingRow[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<number>()
  const out: ServerPendingRow[] = []
  for (const r of raw.slice(0, MAX_RAW_SERVER_ROWS)) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    if (!posInt(o.id) || !posInt(o.from_uin)) continue
    if (o.state !== undefined && o.state !== 'pending') continue
    if (seen.has(o.id)) continue
    seen.add(o.id)
    out.push({
      id: o.id,
      from_uin: o.from_uin,
      nickname: typeof o.nickname === 'string' ? o.nickname.trim().slice(0, NICKNAME_MAX) : '',
    })
  }
  return out
}

/// The answered-set entry for island row `id` on `host`.
export function answeredKey(host: string, id: number): string {
  return `${host.toLowerCase()}#${id}`
}

/// What the poll does with one live island row.
export interface ServerRowPlan {
  /// File it in the request list (a new row, or merged into a §5f one).
  upsert: boolean
  /// Clear it on the island (only ever sent where the island says it can).
  withdraw: boolean
  /// Remember it as answered, so it is never shown again.
  markAnswered: boolean
  /// Deposit our accept again: an earlier one did not reach the requester.
  redeposit: boolean
  /// Send the person's decline to the island again: an earlier one did not
  /// land. Always `respond(false)`, never a withdraw.
  retryDecline: boolean
}

export interface ServerRowFacts {
  blocked: boolean
  answered: boolean
  /// We already hold a cross-island contact at (from_uin, host).
  hasContact: boolean
  /// The island advertises `contact_pending_withdraw`.
  canWithdraw: boolean
  /// Deposits of our accept so far, when an accept is waiting to go out.
  acceptTries?: number
  /// The person declined this row here and the island has not taken it yet.
  declinePending?: boolean
}

/// The verdict for one live row. The rules, in order:
///  * a blocked sender is never shown, and their row is cleared where the
///    island allows it (a block is the person's latest word, and blocking
///    drops any accept still waiting);
///  * an accept that did not go out is deposited again, up to
///    `MAX_ACCEPT_TRIES` in all, and after that waits for a person. Either
///    way the island row is NEVER withdrawn while this device holds that
///    undelivered accept: it is what the retry hangs on, and the requester
///    has not heard anything yet;
///  * a decline that did not land is sent again as a decline;
///  * an answered row is not shown again; one still pending on an island that
///    can withdraw is a withdraw that did not land, and is tried again;
///  * a sender we already hold as a contact at that address needs no question:
///    the row is only cleared;
///  * anything else is a request for a person to decide.
///
/// ⚠⚠ Never `respond(false)` in place of a withdraw. On an island without the
/// capability the row is hidden here and left alone there: a decline would
/// tell the requester "no" for 180 days about a request that may have been
/// accepted from home. The one decline sent is the one a person pressed.
export function planServerRow(f: ServerRowFacts): ServerRowPlan {
  const plan: ServerRowPlan = { upsert: false, withdraw: false, markAnswered: false, redeposit: false, retryDecline: false }
  const tries = f.acceptTries ?? 0
  if (f.blocked) {
    plan.markAnswered = true
    plan.withdraw = f.canWithdraw
    return plan
  }
  if (tries > 0) {
    // Given up on (or the contact is gone): the row stays in front of the
    // person, nothing automatic.
    plan.redeposit = tries < MAX_ACCEPT_TRIES && f.hasContact
    return plan
  }
  if (f.declinePending) {
    plan.retryDecline = true
    return plan
  }
  if (f.answered) {
    plan.withdraw = f.canWithdraw
    return plan
  }
  if (f.hasContact) {
    plan.markAnswered = true
    plan.withdraw = f.canWithdraw
    return plan
  }
  plan.upsert = true
  return plan
}

/// File island row `row` from `host` into `map`. Returns true when `map`
/// changed.
///
/// Merges into an existing row for the same (uin, host), a §5f request or a
/// held message, and never moves its `firstAt`, so a request cannot bump itself
/// to the top by being seen again. The caller checks the block list first.
///
/// ⚠⚠ A NEW row from an island's list never pushes anything out. Every such
/// row is vouched for by that island alone, and an island that keeps its old
/// rows live and puts fresh senders at the head of each answer would otherwise
/// add rows every poll and, once the list is full, evict every §5f request and
/// every quarantined message from other islands along with the words it held.
/// So a host holds at most `MAX_SERVER_ROWS_PER_HOST` rows that are only an
/// island row, and on a full list the incoming row is the one dropped. It is
/// still pending there and comes back on a later poll once there is room.
export function mergeServerRequest(
  map: Record<string, MergeableRequestRow>,
  host: string,
  guestUin: number,
  row: ServerPendingRow,
  now: number,
  maxRows: number,
): boolean {
  const k = reqKey(row.from_uin, host)
  const existing = map[k]
  if (existing) {
    const same = existing.server && existing.server.id === row.id && existing.server.guestUin === guestUin
    let changed = false
    if (!same) {
      existing.server = { id: row.id, guestUin, seenAt: existing.server?.seenAt ?? now }
      changed = true
    }
    if (!existing.nickname && row.nickname) {
      existing.nickname = row.nickname
      changed = true
    }
    return changed
  }
  const all = Object.values(map)
  if (all.length >= maxRows) return false
  const h = host.toLowerCase()
  const islandOnly = all.filter((r) => r.host.toLowerCase() === h && isIslandOnlyRow(r)).length
  if (islandOnly >= MAX_SERVER_ROWS_PER_HOST) return false
  map[k] = {
    uin: row.from_uin,
    host: host.toLowerCase(),
    firstAt: now,
    msgs: [],
    nickname: row.nickname || undefined,
    server: { id: row.id, guestUin, seenAt: now },
  }
  return true
}

/// A row that stands for nothing but an island's list: no §5f request, no held
/// message.
function isIslandOnlyRow(r: MergeableRequestRow): boolean {
  return !!r.server && !r.contactReq && r.msgs.length === 0
}

/// Forget island rows on `host` that the island no longer lists. Returns true
/// when `map` changed.
///
/// A row that is ONLY an island row goes; a row that is also a §5f request or
/// holds messages keeps those and loses the island half. An accept still being
/// retried stops being retried: the requester withdrew, or the row expired.
export function reconcileServerRequests(
  map: Record<string, MergeableRequestRow>,
  host: string,
  liveIds: Iterable<number>,
): boolean {
  const live = new Set(liveIds)
  const h = host.toLowerCase()
  let changed = false
  for (const [k, r] of Object.entries(map)) {
    if (r.host.toLowerCase() !== h || !r.server || live.has(r.server.id)) continue
    changed = true
    if (r.contactReq || r.msgs.length > 0) {
      delete r.server
      delete r.srvAcceptTries
    } else {
      delete map[k]
    }
  }
  return changed
}

/// The island row a `ciack` from another of our devices names (`srv`), or null.
///
/// Read only off a carbon that passed the own-key gate, and only for the
/// island the ack itself is about: an ack for a request from B cannot mark a
/// row on C answered.
export function ackServerRef(srv: unknown, ackHost: string): { host: string; id: number } | null {
  if (!srv || typeof srv !== 'object') return null
  const o = srv as Record<string, unknown>
  if (typeof o.host !== 'string' || !posInt(o.id)) return null
  const host = o.host.trim().toLowerCase()
  if (!host || host !== ackHost.trim().toLowerCase()) return null
  return { host, id: o.id }
}

/// How a `DELETE /contacts/pending/{id}` ended.
///  * `done`: 204, or 404 with the endpoint's own `no_such_request` (already
///    gone, or never ours to clear: the island gives both the same answer).
///  * `route_lost`: a 404 WITHOUT that code, an island that lost the route
///    (downgraded, or a stale capability read). Not done: the capability is
///    read again and the poll tries later.
///  * `rate_limited`, `unauthorized`, `failed`: as they say.
export type WithdrawOutcome = 'done' | 'route_lost' | 'rate_limited' | 'unauthorized' | 'failed'

export function withdrawOutcome(status: number, code: string | null): WithdrawOutcome {
  if (status === 204 || status === 200) return 'done'
  if (status === 404) return code === 'no_such_request' ? 'done' : 'route_lost'
  if (status === 429) return 'rate_limited'
  if (status === 401) return 'unauthorized'
  return 'failed'
}

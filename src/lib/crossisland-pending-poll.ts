// Reading the contact requests addressed to our guest copies (spec 2026-09-15,
// F1), and clearing them there once they are answered.
//
// Run from the visited drain's tick (message-receiver.tsx) and, forced, when
// the requests screen opens. The schedule (pending-poll-schedule.ts) decides
// whether an island is due, so the 30 s tick costs no request most of the time.
//
// Only VISITED islands are asked (founder decision, open question (e)). A
// backup home is a mailbox for this same account under the same number people
// already write to at home; nobody there is meant to find it by number.
//
// ⚠⚠ Nothing here runs while a burn is under way, and nothing after the
// account in this tab changed: every await re-checks both before writing to a
// store, because the stores are scoped to the account active NOW.
//
// ⚠⚠ An answer to an island row reaches my other devices (the `ciack` carbon
// with `srv`) only AFTER it landed where it has to: the accept in the
// requester's mailbox, the decline on the island. The sending device gets its
// own carbon back, and an ack sent early once cleared the very row a failed
// accept was being retried on, and then the poll withdrew the requester's row.

import { accountScope } from './account-scope'
import { isBurning } from './burn-cascade'
import { contactsCache, snapshotFor } from './contacts-cache'
import { inboundSigningKeys } from './sender-key-store'
import { sendRequestAck } from './crossisland-ack'
import { sendContactAccept } from './crossisland-contactreq'
import {
  MAX_SERVER_ROWS_PER_HOST,
  planServerRow,
  validServerRows,
  withdrawOutcome,
  type ServerPendingRow,
  type WithdrawOutcome,
} from './crossisland-pending'
import {
  clearRequest,
  ensureRequestsLoaded,
  getRequest,
  isAnswered,
  isBlocked,
  isDeclinePending,
  markAnswered,
  markDeclinePending,
  noteAcceptUndelivered,
  pruneDeclinePending,
  reconcileServerRequests,
  upsertServerRequest,
} from './crossisland-requests'
import { getCrossIsland } from './crossisland-store'
import type { WebIdentity } from './crypto'
import { listPendingOn, respondOn, withdrawPendingOn } from './guest-contacts-api'
import { createPendingPollSchedule } from './pending-poll-schedule'
import { loadServerInfo } from './server-info'
import { listVisitedIslands, refByAlias } from './visited-islands'

const schedule = createPendingPollSchedule()

/// Automated answers (withdraws and repeated declines) the poll sends per
/// island per pass. With a pass every five minutes that is at most 36 an hour,
/// inside the schedule's own budget and well under the island's 60.
const MAX_AUTO_ANSWERS_PER_PASS = 3
/// One pass over every island, at most. Each call has its own 15 s deadline,
/// but a pass makes many; one that outlives this stops writing and lets the
/// next tick start a fresh pass.
const PASS_DEADLINE_MS = 3 * 60_000

// The capability, per island, with its own short memory. Not `fetchServerInfo`:
// that one keeps a success for the whole run, and a withdraw answered with a
// plain 404 must be able to make this client ask again.
const CAP_TTL_MS = 60 * 60_000
const CAP_UNKNOWN_TTL_MS = 5 * 60_000
const INFO_TIMEOUT_MS = 15_000
const caps = new Map<string, { value: boolean; at: number; ttl: number }>()

/// Does `host` serve `DELETE /contacts/pending/{id}`? An island that does not
/// answer reads as "no" for a few minutes.
export async function islandCanWithdraw(host: string): Promise<boolean> {
  const k = host.toLowerCase()
  const hit = caps.get(k)
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), INFO_TIMEOUT_MS)
  const info = await loadServerInfo(`https://${k}`, { signal: ctl.signal }).finally(() => clearTimeout(timer))
  const value = info?.capabilities.contact_pending_withdraw === true
  caps.set(k, { value, at: Date.now(), ttl: info ? CAP_TTL_MS : CAP_UNKNOWN_TTL_MS })
  return value
}

function forgetWithdrawCapability(host: string): void {
  caps.delete(host.toLowerCase())
}

let running: Promise<void> | null = null
/// Bumped when a pass runs out of time: the pass that was running sees a
/// different number at its next check and stops writing.
let generation = 0

function stillOurs(identity: WebIdentity, gen?: number): boolean {
  if (gen !== undefined && gen !== generation) return false
  return !isBurning() && accountScope() === identity.uin
}

/// Poll every visited island that is due. `force` asks for a poll now, which
/// the schedule grants at most once a minute per island and never inside a
/// 429 wait. Single-flight: a call while a pass runs joins that pass. Resolves
/// by `PASS_DEADLINE_MS` at the latest. Never throws.
export function pollVisitedPending(identity: WebIdentity, opts: { force?: boolean } = {}): Promise<void> {
  if (!running) {
    const gen = ++generation
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        if (generation === gen) generation++
        resolve()
      }, PASS_DEADLINE_MS)
    })
    const pass = pollPass(identity, opts.force === true, gen).catch(() => {
      /* a pass that failed is the next tick's to repeat */
    })
    running = Promise.race([pass, deadline]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
      running = null
    })
  }
  return running
}

async function pollPass(identity: WebIdentity, force: boolean, gen: number): Promise<void> {
  if (!stillOurs(identity, gen)) return
  await ensureRequestsLoaded()
  for (const v of listVisitedIslands()) {
    if (!stillOurs(identity, gen)) return
    const host = v.host
    const now = Date.now()
    if (force) schedule.force(host, now)
    if (!schedule.due(host, now)) continue
    schedule.onAttempt(host, now)
    const res = await listPendingOn(identity, host)
    if (!res) {
      schedule.onResult(host, Date.now(), { ok: false })
      continue
    }
    if (res.status === 429) {
      schedule.onResult(host, Date.now(), { ok: false, rateLimited: true, retryAfterSec: res.retryAfterSec })
      continue
    }
    if (res.status < 200 || res.status >= 300) {
      schedule.onResult(host, Date.now(), { ok: false })
      continue
    }
    schedule.onResult(host, Date.now(), { ok: true })
    if (!stillOurs(identity, gen)) return
    // Read again: the call may have re-proved the key and learned our number.
    const guestUin = listVisitedIslands().find((x) => x.host === host)?.uin ?? v.uin
    // validServerRows looks at no more than MAX_RAW_SERVER_ROWS entries.
    await ingestVisitedPending(identity, host, guestUin, validServerRows(res.json), gen)
  }
}

async function ingestVisitedPending(
  identity: WebIdentity,
  host: string,
  guestUin: number,
  rows: ServerPendingRow[],
  gen: number,
): Promise<void> {
  // Every live id counts for the reconcile, including rows past the per-pass
  // cap: those are still pending, only not read this time.
  const liveIds = rows.map((r) => r.id)
  reconcileServerRequests(host, liveIds)
  pruneDeclinePending(host, liveIds)
  const batch = rows.slice(0, MAX_SERVER_ROWS_PER_HOST)
  if (batch.length === 0) return
  const capable = await islandCanWithdraw(host)
  let autoAnswers = 0
  // A 429 or a spent budget stops the automated ANSWERS for this pass, never
  // the rest of the rows: a request behind a stuck one must still reach the
  // list.
  let answersStopped = false
  const answerAllowed = () => !answersStopped && autoAnswers < MAX_AUTO_ANSWERS_PER_PASS
  for (const row of batch) {
    if (!stillOurs(identity, gen)) return
    const held = getRequest(row.from_uin, host)
    const plan = planServerRow({
      blocked: isBlocked(row.from_uin, host),
      answered: isAnswered(host, row.id),
      hasContact: getCrossIsland(row.from_uin, host) != null,
      canWithdraw: capable,
      // Any accept this device still owes this person, whichever island row
      // id it was given for: the backstop against withdrawing their row.
      acceptTries: held?.srvAcceptTries,
      declinePending: isDeclinePending(host, row.id),
    })
    if (plan.markAnswered) markAnswered(host, row.id)
    if (plan.upsert) upsertServerRequest(host, guestUin, row)
    if (plan.redeposit) {
      await redepositAccept(identity, host, row, gen)
      continue
    }
    if (plan.retryDecline && answerAllowed()) {
      autoAnswers++
      const out = await declineServerRequest(identity, host, row.id, row.from_uin)
      if (out === 'rate_limited' || out === 'deferred') answersStopped = true
      continue
    }
    if (plan.withdraw && answerAllowed()) {
      autoAnswers++
      const out = await withdrawServerRequest(identity, host, row.id)
      if (out === 'rate_limited' || out === 'deferred') answersStopped = true
    }
  }
}

/// An accept pinned earlier whose deposit did not reach the requester: send it
/// again, and only once it lands clear the row here, tell my other devices,
/// and clear the row on the island.
async function redepositAccept(identity: WebIdentity, host: string, row: ServerPendingRow, gen: number): Promise<void> {
  const delivered = await sendContactAccept(identity, host, row.from_uin)
  if (!stillOurs(identity, gen)) return
  if (!delivered) {
    noteAcceptUndelivered(row.from_uin, host)
    return
  }
  clearRequest(row.from_uin, host)
  const pinned = getCrossIsland(row.from_uin, host)
  void sendRequestAck(
    identity,
    row.from_uin,
    host,
    'accept',
    pinned
      ? {
          nick: pinned.nickname?.trim() || undefined,
          ik: pinned.identityKey,
          sk: pinned.signingKey,
          sik: pinned.signalIdentityKey ?? null,
          gender: pinned.gender ?? null,
          status: pinned.statusMessage ?? null,
        }
      : undefined,
    { host, id: row.id },
  )
  await withdrawServerRequest(identity, host, row.id)
}

export type ServerAnswerOutcome = WithdrawOutcome | 'unsupported' | 'deferred'

/// Clear island row `id` on `host` after it was answered here. Always marks it
/// answered first, so it is never shown again whatever the island says.
///  * `unsupported`: the island cannot withdraw. The row is only hidden here,
///    never declined in its place.
///  * `route_lost`: a plain 404, the capability is read again and the next
///    poll retries.
///  * `deferred`: the hourly budget or a 429 wait; the next poll retries.
/// `byUser` for an answer given by hand, which the poll's budget never blocks.
export async function withdrawServerRequest(
  identity: WebIdentity,
  host: string,
  id: number,
  byUser = false,
): Promise<ServerAnswerOutcome> {
  markAnswered(host, id)
  if (!(await islandCanWithdraw(host))) return 'unsupported'
  const now = Date.now()
  if (!schedule.withdrawAllowed(host, now, byUser)) return 'deferred'
  schedule.noteWithdraw(host, now, byUser)
  const res = await withdrawPendingOn(identity, host, id)
  if (!res) return 'failed'
  const out = withdrawOutcome(res.status, res.code)
  if (out === 'route_lost') forgetWithdrawCapability(host)
  if (out === 'rate_limited') schedule.holdWithdraws(host, Date.now(), res.retryAfterSec)
  return out
}

/// Decline island row `id` from `requesterUin` on `host`: an honest
/// `respond(false)` there, which every island has always served.
///
/// The row is answered only once the island took it: a 2xx, or the 404 that
/// means there is no such row of ours any more. Until then it is a waiting
/// decline, which the poll sends again (and only ever as a decline). My other
/// devices are told at that same moment, never before. `done` when it landed.
/// `byUser` for the tap itself, which the poll's hourly budget never blocks.
export async function declineServerRequest(
  identity: WebIdentity,
  host: string,
  id: number,
  requesterUin: number,
  byUser = false,
): Promise<ServerAnswerOutcome> {
  markDeclinePending(host, id)
  const now = Date.now()
  if (!schedule.withdrawAllowed(host, now, byUser)) return 'deferred'
  schedule.noteWithdraw(host, now, byUser)
  const res = await respondOn(identity, host, id, false)
  if (!res) return 'failed'
  if (res.status === 429) {
    schedule.holdWithdraws(host, Date.now(), res.retryAfterSec)
    return 'rate_limited'
  }
  const landed = (res.status >= 200 && res.status < 300) || res.status === 404
  if (!landed) return res.status === 401 ? 'unauthorized' : 'failed'
  markAnswered(host, id)
  void sendRequestAck(identity, requesterUin, host, 'decline', undefined, { host, id })
  return 'done'
}

// -----------------------------------------------------------
// What a request row from an island's list can say about its sender
// -----------------------------------------------------------
//
// ⚠ All of it is what island B itself served (rosters, cards, nicknames). It
// can tell a person "you share a group with this number there", never who the
// person is: a hostile operator can put a row in its own database and a key in
// its own card. The accept hint says so. Read from what this device already
// holds; nothing here fetches.

function groupsOnHost(ownUin: number, host: string) {
  const h = host.toLowerCase()
  const all = contactsCache.get(ownUin)?.groups ?? snapshotFor(ownUin)?.groups ?? []
  return all.filter((g) => g.host?.toLowerCase() === h)
}

/// The names of our rooms on `host` whose cached roster lists `uin`, and
/// whether any roster on `host` is cached at all (without one, "not in your
/// groups" would be a guess).
export function sharedGroupsOn(ownUin: number, uin: number, host: string): { names: string[]; rosterKnown: boolean } {
  const onHost = groupsOnHost(ownUin, host)
  const rosterKnown = onHost.some((g) => (g.members?.length ?? 0) > 0)
  const names = onHost
    .filter((g) => g.members?.some((m) => m.uin === uin))
    .map((g) => g.name)
    .filter((n): n is string => typeof n === 'string' && n.trim() !== '')
  return { names, rosterKnown }
}

/// Signing keys this device saw for `uin` in rooms on `host` BEFORE any card:
/// the cached roster, and the inbound sender-key chains (the key their group
/// traffic is verified under). Accepting a card with another key needs a
/// person to confirm (critic 6, partly adopted).
export function priorSigningKeys(ownUin: number, uin: number, host: string): string[] {
  const onHost = groupsOnHost(ownUin, host)
  const out = new Set<string>()
  for (const g of onHost) {
    for (const m of g.members ?? []) if (m.uin === uin && m.signing_key) out.add(m.signing_key)
  }
  // A room on another island is filed locally under a negative alias, and a
  // chain may carry either that alias or the island's own id for it.
  const gids = onHost.flatMap((g) => {
    const ref = refByAlias(g.id)
    return ref ? [g.id, ref.remoteId] : [g.id]
  })
  for (const k of inboundSigningKeys(ownUin, uin, gids)) out.add(k)
  return [...out]
}

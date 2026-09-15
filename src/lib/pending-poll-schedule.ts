// When this client may ask a visited island for the contact requests addressed
// to our guest copy there (spec 2026-09-15, F1), and how often it may withdraw
// one of them.
//
// Pure: no store, no network, no imports, and the clock and the dice are passed
// in, so every rule below is proven offline against the built bundle
// (cli/test/pending-poll.mjs), the same way crossisland-gate.ts is.
//
// Why a schedule of its own rather than riding the 30 s visited drain:
//  * `GET /contacts/pending` is new traffic to somebody else's island. The
//    designed cadence is one poll per island per five minutes or slower, which
//    is less than the queue poll that island already sees, and the island caps
//    it at 120 a minute. Five minutes leaves that cap untouchable even with a
//    forced refresh and several installs behind one account.
//  * `DELETE /contacts/pending/{id}` is capped at 60 an hour per account. The
//    poll retries a withdraw that did not land, so without a budget of its own
//    a few stuck rows at 20 per poll would spend that cap in fifteen minutes
//    and leave nothing for the person pressing Accept.
//  * A 429 is an order. The island's `Retry-After` is honoured, with a floor
//    of five minutes, because a browser usually cannot read that header at all
//    (the island exposes only `ETag` to scripts) and must not guess low.

/// One poll per island per this long, give or take `POLL_JITTER`.
export const POLL_INTERVAL_MS = 5 * 60_000
/// ±20%, so installs of one account (and people behind one island) do not
/// fall into step.
export const POLL_JITTER = 0.2
/// Minutes to wait after the 1st, 2nd, ... consecutive failure; the last value
/// holds from then on.
export const BACKOFF_MINUTES = [5, 10, 20, 40, 60] as const
/// A refusal for rate never waits less than this, whatever the island said.
export const RETRY_AFTER_FLOOR_MS = 5 * 60_000
/// A forced poll (the requests screen opening) at most this often per island.
export const FORCE_DEBOUNCE_MS = 60_000
/// Withdraws the POLL may send per island per hour: half the island's cap, so
/// the other half is always there for an answer somebody gives by hand.
export const AUTO_WITHDRAW_PER_HOUR = 30
const HOUR_MS = 60 * 60_000

/// What one poll of one island came to.
export type PollOutcome =
  | { ok: true }
  /// `rateLimited` for a 429; `retryAfterSec` is what the island asked for,
  /// when the answer let us read it.
  | { ok: false; rateLimited?: boolean; retryAfterSec?: number | null }

export interface PendingPollSchedule {
  /// Is a poll of `host` due now? An island never polled is due at once.
  due(host: string, now: number): boolean
  /// Note that a poll of `host` is being sent now.
  onAttempt(host: string, now: number): void
  /// Note how it ended and pick the next time.
  onResult(host: string, now: number, outcome: PollOutcome): void
  /// Ask for a poll of `host` now, out of turn. Refused (false) within
  /// `FORCE_DEBOUNCE_MS` of the last attempt and while a 429 is being waited
  /// out; ordinary failure backoff does not refuse it, because a person opening
  /// the screen is the moment worth one more try.
  force(host: string, now: number): boolean
  /// May a withdraw go to `host` now? `byUser` is an answer given by hand: it
  /// is not counted against the poll's hourly budget, only against a 429.
  withdrawAllowed(host: string, now: number, byUser?: boolean): boolean
  /// Note a withdraw sent to `host` now.
  noteWithdraw(host: string, now: number, byUser?: boolean): void
  /// The island refused a withdraw for rate: send none until the wait is over.
  holdWithdraws(host: string, now: number, retryAfterSec?: number | null): void
}

interface HostState {
  next: number
  failures: number
  lastAttempt: number
  /// No poll, forced or not, before this (a 429 being waited out).
  holdUntil: number
  /// Automated withdraws inside the last hour.
  withdraws: number[]
  withdrawHoldUntil: number
}

/// How long a 429 is waited out: what the island asked, never under the floor.
export function rateLimitWaitMs(retryAfterSec?: number | null): number {
  const asked = typeof retryAfterSec === 'number' && Number.isFinite(retryAfterSec) && retryAfterSec > 0
    ? retryAfterSec * 1000
    : 0
  return Math.max(RETRY_AFTER_FLOOR_MS, asked)
}

/// The wait after `failures` consecutive failures (1-based).
export function backoffMs(failures: number): number {
  const i = Math.min(Math.max(failures, 1), BACKOFF_MINUTES.length) - 1
  return BACKOFF_MINUTES[i] * 60_000
}

/// `random` returns [0, 1), like Math.random; injected so the jitter bounds
/// can be tested at both ends.
export function createPendingPollSchedule(random: () => number = Math.random): PendingPollSchedule {
  const hosts = new Map<string, HostState>()
  const key = (host: string) => host.trim().toLowerCase()
  const stateOf = (host: string): HostState => {
    const k = key(host)
    let s = hosts.get(k)
    if (!s) {
      s = { next: 0, failures: 0, lastAttempt: -Infinity, holdUntil: 0, withdraws: [], withdrawHoldUntil: 0 }
      hosts.set(k, s)
    }
    return s
  }
  const pruneWithdraws = (s: HostState, now: number) => {
    s.withdraws = s.withdraws.filter((t) => now - t < HOUR_MS)
  }

  return {
    due(host, now) {
      const s = hosts.get(key(host))
      if (!s) return true
      return now >= s.next && now >= s.holdUntil
    },
    onAttempt(host, now) {
      stateOf(host).lastAttempt = now
    },
    onResult(host, now, outcome) {
      const s = stateOf(host)
      if (outcome.ok) {
        s.failures = 0
        s.holdUntil = 0
        const r = Math.min(Math.max(random(), 0), 1)
        s.next = now + Math.round(POLL_INTERVAL_MS * (1 + POLL_JITTER * (2 * r - 1)))
        return
      }
      s.failures += 1
      let wait = backoffMs(s.failures)
      if (outcome.rateLimited) {
        wait = Math.max(wait, rateLimitWaitMs(outcome.retryAfterSec))
        s.holdUntil = now + wait
      }
      s.next = now + wait
    },
    force(host, now) {
      const s = stateOf(host)
      if (now < s.holdUntil) return false
      if (now - s.lastAttempt < FORCE_DEBOUNCE_MS) return false
      s.next = Math.min(s.next, now)
      return true
    },
    withdrawAllowed(host, now, byUser = false) {
      const s = stateOf(host)
      if (now < s.withdrawHoldUntil) return false
      if (byUser) return true
      pruneWithdraws(s, now)
      return s.withdraws.length < AUTO_WITHDRAW_PER_HOUR
    },
    noteWithdraw(host, now, byUser = false) {
      if (byUser) return
      const s = stateOf(host)
      pruneWithdraws(s, now)
      s.withdraws.push(now)
    },
    holdWithdraws(host, now, retryAfterSec) {
      stateOf(host).withdrawHoldUntil = now + rateLimitWaitMs(retryAfterSec)
    },
  }
}

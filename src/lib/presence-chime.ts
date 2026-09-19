// Which presence chime, if any, a burst of `presence` frames is allowed to make.
//
// ⚠⚠ THE SAME RULE ANDROID APPLIES (data/PresenceChime.kt), deliberately, down
// to the constants. Reports #1030 and #1029 were filed against Android AND the
// Windows desktop, and two clients disagreeing about when a sound is honest is
// how the pair of them ends up wrong in different ways.
//
// Why a rule is needed at all: the island calls somebody online while their
// `last_seen` is inside a 60 second window, refreshed by a 25 second heartbeat,
// with no hysteresis. One missed ping — a tunnel, a screen-off, a throttled
// background tab — is a departure, and the next ping is an arrival, and nobody
// went anywhere. On top of that a `presence` frame carries no relationship: the
// island sends it to every group co-member, so the SCHEDULE of these sounds is
// set by strangers' activity in rooms the person happens to share.
//
// Pure and DOM-free on purpose: cli/test/presence-chime.mjs bundles this file
// alone and drives the cases.

export type PresenceSoundMode = 'all' | 'favorites' | 'off'

export interface PresenceFlip {
  uin: number
  /** True = they appeared, false = they disappeared. */
  online: boolean
  favorite: boolean
  /** Their thread is muted. Web honoured this before Android did. */
  muted: boolean
}

export interface PresenceDecision {
  uin: number
  online: boolean
}

/** Transitions in one burst past which this is the network, not a room
 *  filling up. The reconnect case is the loudest false chime there is. */
export const BULK_FLOOR = 4

/** How long one contact stays silent after chiming: the flap guard. */
export const PER_CONTACT_COOLDOWN_MS = 5 * 60_000

/** How long frames are collected before deciding. A reconnect delivers its
 *  presence frames in a rush, so "one frame, one sound" made a burst as loud
 *  as it was long; a short window turns the rush back into one event. */
export const BURST_WINDOW_MS = 400

export function decidePresenceChime(
  flips: PresenceFlip[],
  mode: PresenceSoundMode,
  departuresOn: boolean,
  lastChimedAt: Map<number, number>,
  now: number,
): PresenceDecision | null {
  if (mode === 'off') return null

  const worth = flips.filter((f) => {
    if (f.muted) return false
    if (mode === 'favorites' && !f.favorite) return false
    if (!f.online && !departuresOn) return false
    return true
  })
  if (worth.length === 0) return null

  // Counts what SURVIVED the filters, not what arrived: a wave of strangers
  // must not swallow the one friend in it.
  if (worth.length >= BULK_FLOOR) return null

  const fresh = worth.filter((f) => {
    const last = lastChimedAt.get(f.uin)
    // ⚠ Absent is "never", not "long ago". A sentinel here is an overflow
    // waiting to happen; the Kotlin twin shipped that bug for ten minutes.
    return last === undefined || now - last >= PER_CONTACT_COOLDOWN_MS
  })
  if (fresh.length === 0) return null

  // Chosen deliberately, never "the first frame that arrived": favourites
  // first, then an arrival over a departure, then the lower number.
  const rank = (f: PresenceFlip) => [f.favorite ? 0 : 1, f.online ? 0 : 1, f.uin]
  let pick = fresh[0]
  for (const f of fresh.slice(1)) {
    const a = rank(f)
    const b = rank(pick)
    if (a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))) pick = f
  }
  return { uin: pick.uin, online: pick.online }
}

/** Away and dnd are "around": an offline→away move is somebody appearing, and
 *  the contact list buckets them the same way. Shared so the watcher and the
 *  list cannot drift. */
export function presenceIsAround(status: string): boolean {
  return status === 'online' || status === 'away' || status === 'dnd'
}

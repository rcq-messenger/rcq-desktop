// "This account's keys were changed on another device", said from a place that
// has no React context: the guest paths (spec 2026-09-15, D2).
//
// A guest join or a guest recover can be the first request that meets the
// island's 404 `identity_rotated` for our signing key. That is the account's
// rotated-elsewhere state, not a failed join, and never a reason to wipe or to
// register the retired key again. identity-context.tsx listens for this event
// and raises the same notice a refused session mint raises.
//
// React-free and window-optional: visited-islands.ts is bundled into the
// console, which has no window and ignores the call.

export const ROTATED_ELSEWHERE_EVENT = 'rcq-identity-rotated-elsewhere'

/// Announce that `homeUin` (the account this browser is signed in as, never a
/// guest copy's number) answered as rotated somewhere.
export function announceRotatedElsewhere(homeUin: number): void {
  try {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
    window.dispatchEvent(new CustomEvent(ROTATED_ELSEWHERE_EVENT, { detail: { uin: homeUin } }))
  } catch {
    /* no window, or no CustomEvent: nothing to tell */
  }
}

/// The uin an announcement names, or null for an event of another shape.
export function rotatedUinOf(e: Event): number | null {
  const uin = (e as CustomEvent<{ uin?: unknown }>).detail?.uin
  return typeof uin === 'number' && Number.isSafeInteger(uin) ? uin : null
}

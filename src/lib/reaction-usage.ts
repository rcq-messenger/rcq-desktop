/// How often this account actually uses each reaction (founder item 21).
///
/// The quick bar is one horizontal scroller, and `REACTION_CAP` is 40: with a
/// curated set that long the reaction somebody reaches for every day can sit
/// off the right-hand edge, behind a sideways drag, while five they have never
/// used are in front of it. Counting locally and putting the used ones first
/// costs nothing and never leaves the device.
///
/// ── two rules that matter more than the counting ──────────────────────────
///
/// 1. ⚠ The order SETTLES WHEN THE BAR OPENS, never while it is open. Re-sorting
///    on every tap would move the buttons under the finger that is pressing
///    them, which is how a picker turns into a game of chance. `useReactionAssets`
///    snapshots the weights once per mount and the bar is mounted exactly for
///    as long as it is visible, so one opening = one order.
///
/// 2. ⚠ Ties break by the user's CONFIGURED order, not alphabetically and not by
///    whatever `Object.keys` felt like. Everything at zero (a fresh account, or
///    the long tail) therefore reads exactly as the settings sheet left it, and
///    the bar only ever differs from the configured order where there is a real
///    reason. `Array.prototype.sort` is stable in every engine we ship on, so a
///    plain comparison on the weight alone already preserves it.
///
/// Storage is per account: `rcq.web.<uin>.reactions.usage`. ⚠ The key is built
/// on every call rather than once at module load, because `scopedKey` reads the
/// scope `setAccountScope` installs during boot. A key captured at module-eval
/// time belongs to no account, and then the next account to sign in inherits the
/// first one's counts. See the header of `account-scope.ts` for the version of
/// this bug that already shipped.

import { scopedKey } from './account-scope'

const KEY = () => scopedKey('reactions.usage')

export type ReactionWeights = Record<string, number>

/// Every count this account has accumulated. Never throws: a corrupt or absent
/// blob simply means "no history", and an ordering with no history is the
/// configured order, which is the right answer anyway.
export function reactionWeights(): ReactionWeights {
  try {
    const raw = localStorage.getItem(KEY())
    if (!raw) return {}
    const obj = JSON.parse(raw) as unknown
    if (!obj || typeof obj !== 'object') return {}
    const out: ReactionWeights = {}
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/// Ceiling on any one count.
///
/// Not about storage (the numbers are tiny) but about how long a habit takes
/// to change. Without a cap, a reaction used two thousand times a year ago can
/// never be overtaken by the one being used today, and the bar ossifies into
/// whatever the first month looked like. Halving everything on overflow keeps
/// the ORDER and lets recent use catch up.
const MAX_COUNT = 512

/// Record one use. Called from the single place a reaction is actually chosen,
/// so a chip toggled off (which sends `null`) never counts: removing a reaction
/// is not a vote for it.
export function noteReactionUsed(asset: string): void {
  if (!asset) return
  const w = reactionWeights()
  w[asset] = (w[asset] ?? 0) + 1
  if (w[asset] >= MAX_COUNT) {
    for (const k of Object.keys(w)) {
      const halved = Math.floor(w[k] / 2)
      if (halved > 0) w[k] = halved
      else delete w[k]
    }
  }
  try {
    localStorage.setItem(KEY(), JSON.stringify(w))
  } catch {
    /* quota: an unordered bar is a small loss, a thrown handler is not */
  }
}

/// The bar's order for this opening: most-used first, ties left exactly as the
/// caller had them. Returns a NEW array; the input is never mutated (it comes
/// straight out of the choices store, which hands back its own value).
export function orderByUsage(assets: readonly string[], weights: ReactionWeights): string[] {
  return [...assets].sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0))
}

// Per-account choices for the kolobok picker: which emoticons appear in the
// composer PANEL, and which are the quick REACTIONS (both capped by
// PANEL_CAP / REACTION_CAP in emoticons.ts). Local-only UI
// preference (no wire/backend change), persisted in localStorage per account
// and kept in sync across tabs via the `storage` event — mirrors
// useCollapsedSections in local-store.ts.
//
// The panel is EMPTY by default (the user curates it → "Choose" CTA).
// Reactions DEFAULT to the historical six until the user customises, so the
// null-vs-`[]` distinction matters: an ABSENT key means "use defaults", a
// stored `[]` means "the user cleared them" and is respected. Never collapse
// the two with `arr.length ? arr : DEFAULT`.

import { useEffect, useState } from 'react'
import { DEFAULT_REACTIONS, PALETTE, PANEL_CAP, REACTION_CAP } from './emoticons'
import { orderByUsage, reactionWeights } from './reaction-usage'

// Only assets a CURRENT pack can draw. A panel curated before a pack was
// retired keeps its asset names, and a name with no glyph behind it renders
// as bare text (reported 2026-08-20, the day the old pack left). Filtered on
// READ, so the stored value heals on the next write without a migration.
const VALID_ASSETS = new Set(PALETTE.map((p) => p.asset))
const onlyValid = (arr: string[]) => arr.filter((a) => VALID_ASSETS.has(a))

const panelKey = (uin: number) => `rcq.web.emoticons.panel.${uin}`
const reactionKey = (uin: number) => `rcq.web.emoticons.reactions.${uin}`

// null = key absent (caller picks the default); array = the stored value.
function read(key: string): string[] | null {
  try {
    const raw = localStorage.getItem(key)
    if (raw == null) return null
    const a = JSON.parse(raw)
    return Array.isArray(a) ? (a as string[]) : null
  } catch {
    return null
  }
}

function write(key: string, arr: string[]) {
  localStorage.setItem(key, JSON.stringify(arr))
  // Same-document writes don't fire `storage` — dispatch it ourselves so the
  // hooks below re-render in this tab too (cross-tab fires it natively).
  window.dispatchEvent(new StorageEvent('storage', { key }))
}

export function getPanelAssets(uin: number): string[] {
  return onlyValid(read(panelKey(uin)) ?? [])
}
export function getReactionAssets(uin: number): string[] {
  const stored = read(reactionKey(uin))
  if (stored == null) return [...DEFAULT_REACTIONS]
  const filtered = onlyValid(stored)
  // A set the pack retirement emptied is not the user's "cleared them all":
  // fall back to the defaults rather than leaving a bare reaction bar.
  return filtered.length === 0 && stored.length > 0 ? [...DEFAULT_REACTIONS] : filtered
}

// Remove if present; append (preserving pick order) if absent and under the
// cap; no-op at the cap.
function toggle(cur: string[], asset: string, cap: number): string[] {
  if (cur.includes(asset)) return cur.filter((a) => a !== asset)
  if (cur.length >= cap) return cur
  return [...cur, asset]
}
export function togglePanelAsset(uin: number, asset: string) {
  write(panelKey(uin), toggle(getPanelAssets(uin), asset, PANEL_CAP))
}
export function toggleReactionAsset(uin: number, asset: string) {
  write(reactionKey(uin), toggle(getReactionAssets(uin), asset, REACTION_CAP))
}

// Reactive read: re-renders on local writes + cross-tab changes (mirrors
// useCollapsedSections). read() runs each render, so the returned array is the
// current value; the tick only forces the re-render.
function useStoredChoice(key: string, fallback: () => string[]): string[] {
  const [, setTick] = useState(0)
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === key || e.key == null) setTick((t) => t + 1)
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [key])
  return read(key) ?? fallback()
}
export function usePanelAssets(uin: number): string[] {
  useStoredChoice(panelKey(uin), () => [])
  return getPanelAssets(uin)
}
/// The quick bar's assets, most-used first (founder item 21).
///
/// ⚠ The usage weights are snapshotted ONCE per mount, not read on every
/// render. The quick bar is mounted exactly while it is visible, so one opening
/// = one order, and a tap can never re-sort the row under the finger that is
/// pressing it. The CONFIGURED set stays reactive (the settings sheet can add
/// or drop an asset and the bar follows); only the ordering is frozen.
///
/// This is also why the ordering lives here rather than in `ReactionPicker`:
/// every reader of the quick set goes through this hook, so there is one place
/// where "what is in the bar" and "in what order" are decided together.
export function useReactionAssets(uin: number): string[] {
  useStoredChoice(reactionKey(uin), () => [...DEFAULT_REACTIONS])
  const [weights] = useState(reactionWeights)
  return orderByUsage(getReactionAssets(uin), weights)
}

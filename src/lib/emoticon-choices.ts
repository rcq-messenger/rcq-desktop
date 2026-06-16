// Per-account choices for the kolobok picker: which emoticons appear in the
// composer PANEL, and which (<=6) are the quick REACTIONS. Local-only UI
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
import { DEFAULT_REACTIONS, PANEL_CAP, REACTION_CAP } from './emoticons'

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
  return read(panelKey(uin)) ?? []
}
export function getReactionAssets(uin: number): string[] {
  return read(reactionKey(uin)) ?? [...DEFAULT_REACTIONS]
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
  return useStoredChoice(panelKey(uin), () => [])
}
export function useReactionAssets(uin: number): string[] {
  return useStoredChoice(reactionKey(uin), () => [...DEFAULT_REACTIONS])
}

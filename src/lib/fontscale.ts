// Text size (#477, "на ПК Виндоус нет возможности регулировать размер шрифта").
//
// Both phones have had this for a while — Android as a 4-step segmented
// control (SettingsScreen.kt, 0.85 / 1.0 / 1.15 / 1.3), iOS as a Dynamic Type
// picker — and the desktop had a single hardcoded root font-size that answered
// one tester in one direction and nobody since.
//
// The mechanism is the one index.css already relies on: every size and spacing
// in this app is in rem, so the whole interface is a multiple of the root
// font-size, and the user's preference is one multiplier on it. That is why
// this file is nine lines of localStorage and a CSS custom property rather than
// a theme of its own — the scaling was already built, it just had no knob.
//
// Deliberately NOT a React context, unlike the theme: nothing renders from this
// value except the picker in Settings. A provider around the tree would
// re-render Chat on every step for no reader. Same shape as lib/sounds.ts, the
// repo's other write-only device preference.
//
// The four steps are Android's, so a user carrying both sees the same rungs.
// iOS's "System" tier is deliberately not copied: the browser has no OS text
// size to follow, and below 1024px the root is already `100%`, which follows
// the reader's own browser setting.

export type FontScale = 'small' | 'normal' | 'large' | 'largest'

/// Anyone rendering the current step. Declared up here because both the setter
/// and the cross-tab listener below notify through it.
const listeners = new Set<() => void>()

/// Order matters — this is the order the picker lists them in.
export const FONT_SCALES: FontScale[] = ['small', 'normal', 'large', 'largest']

const MULTIPLIER: Record<FontScale, number> = {
  small: 0.85,
  normal: 1,
  large: 1.15,
  largest: 1.3,
}

const STORAGE_KEY = 'rcq.web.chat.fontscale'

function isFontScale(v: string | null): v is FontScale {
  return v !== null && Object.prototype.hasOwnProperty.call(MULTIPLIER, v)
}

export function getFontScale(): FontScale {
  if (typeof window === 'undefined') return 'normal'
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return isFontScale(v) ? v : 'normal'
  } catch {
    // Private mode / storage disabled — the default is a working app.
    return 'normal'
  }
}

function applyFontScale(pref: FontScale) {
  document.documentElement.style.setProperty('--rcq-font-scale', String(MULTIPLIER[pref]))
}

export function setFontScale(pref: FontScale) {
  try {
    localStorage.setItem(STORAGE_KEY, pref)
  } catch {
    // Same as the theme: a preference we cannot persist still applies to
    // this session rather than refusing to change at all.
  }
  applyFontScale(pref)
  for (const l of listeners) l()
}

/// Called from main.tsx before React mounts, so the first paint is already at
/// the chosen size — the same reason the `desktop` class is added there rather
/// than in a component.
export function initFontScale() {
  applyFontScale(getFontScale())
  // chat.rcq.app is commonly open in two tabs. `storage` fires in the OTHER
  // tabs only, which is exactly what is wanted here.
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) {
      applyFontScale(getFontScale())
      for (const l of listeners) l()
    }
  })
}

/// Let a component follow the value rather than only seed itself from it —
/// otherwise the picker in Settings keeps showing the old step after another
/// tab changed the size, while the page around it is already scaled.
export function subscribeFontScale(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

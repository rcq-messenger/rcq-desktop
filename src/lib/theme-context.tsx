// Theme provider for the web-chat surface. Three-way state: explicit
// 'light', explicit 'dark', or 'system' which tracks the OS pref via
// `prefers-color-scheme`. The active concrete theme is applied as a
// class on <html> so Tailwind's `darkMode: 'class'` config picks it
// up; concrete values for both palettes live in `index.css`.
//
// Persists the user's choice in localStorage. Cross-tab sync via the
// `storage` event is wired so flipping the toggle in one tab doesn't
// leave a sibling tab on the old palette.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export type ThemePref = 'light' | 'dark' | 'system'
export type ThemeResolved = 'light' | 'dark'

const STORAGE_KEY = 'rcq.web.chat.theme'

interface ThemeCtx {
  pref: ThemePref
  resolved: ThemeResolved
  setPref: (p: ThemePref) => void
}

const Ctx = createContext<ThemeCtx | undefined>(undefined)

function detectInitialPref(): ThemePref {
  if (typeof window === 'undefined') return 'system'
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  return 'system'
}

function resolvePref(pref: ThemePref): ThemeResolved {
  if (pref !== 'system') return pref
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyToDocument(resolved: ThemeResolved) {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark', resolved === 'dark')
  // Tells the UA which color form-controls/scrollbars/native widgets
  // should render in. Cheap to set, surprisingly polish.
  document.documentElement.style.colorScheme = resolved
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(() => detectInitialPref())
  const [resolved, setResolved] = useState<ThemeResolved>(() => resolvePref(detectInitialPref()))

  // Re-resolve when the pref changes or when the system pref shifts
  // (the user toggled OS dark mode while the tab is open).
  useEffect(() => {
    const next = resolvePref(pref)
    setResolved(next)
    applyToDocument(next)
    if (pref !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      const r: ThemeResolved = media.matches ? 'dark' : 'light'
      setResolved(r)
      applyToDocument(r)
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [pref])

  // Cross-tab sync: a sibling tab toggling the pref bumps the
  // storage event here so we re-read and re-apply.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return
      setPrefState(detectInitialPref())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setPref = useCallback((p: ThemePref) => {
    setPrefState(p)
    try {
      localStorage.setItem(STORAGE_KEY, p)
    } catch {
      // Private mode etc.; live in-memory only.
    }
  }, [])

  const value = useMemo<ThemeCtx>(
    () => ({ pref, resolved, setPref }),
    [pref, resolved, setPref],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useTheme called outside ThemeProvider')
  return v
}

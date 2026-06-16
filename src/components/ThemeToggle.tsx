// Light/dark theme switch. Sits next to the language picker (Login
// splash + Settings) since that's where users look for "how do I
// change how this looks". Toggles between explicit light and dark —
// tapping commits an explicit pref (drops 'system'), which is what a
// user reaching for this button actually wants.

import { useTheme } from '../lib/theme-context'

interface Props {
  /// Override the button chrome so the toggle can match whatever bar it
  /// sits in (the Login splash uses the round default; the Contacts
  /// header passes its own icon-button class).
  className?: string
}

const DEFAULT_CLASS =
  'grid h-9 w-9 place-items-center rounded-full text-fg-secondary transition hover:bg-fg-primary/[0.06] hover:text-fg-primary active:scale-95'

export function ThemeToggle({ className = DEFAULT_CLASS }: Props) {
  const { resolved, setPref } = useTheme()
  const isDark = resolved === 'dark'
  return (
    <button
      type="button"
      onClick={() => setPref(isDark ? 'light' : 'dark')}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={isDark ? 'Light theme' : 'Dark theme'}
      className={className}
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
    </button>
  )
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  )
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </svg>
  )
}

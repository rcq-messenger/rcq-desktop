// Reusable styled dropdown — generic over option type so the language
// picker (LangCode) and the theme switcher (ThemePref) can share the
// same chrome instead of each rolling its own. Native <select> would
// be free keyboard + iOS picker, but it ignores our palette and renders
// an OS-native list that fights the brand. This keeps look + dark-mode
// support consistent with the rest of the surface.
//
// Closes on:
//   - click outside the trigger or panel
//   - Escape
//   - selecting an option

import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface DropdownOption<T extends string> {
  value: T
  label: string
  /// Optional leading glyph rendered to the left of the label —
  /// flag emoji, theme icon, status dot, etc.
  leading?: ReactNode
}

interface Props<T extends string> {
  value: T
  options: DropdownOption<T>[]
  onChange: (next: T) => void
  ariaLabel?: string
  variant?: 'row' | 'pill'
  /// Optional content to render in the trigger when the value's
  /// label is too verbose — language picker uses this so the
  /// trigger shows the native name only, while the open list shows
  /// flag + native + ASCII code.
  triggerLabel?: ReactNode
  /// Width-classes for the panel. Defaults to mirroring the trigger
  /// width so the popover lines up. Use `'w-56'` etc. to widen for
  /// long lists.
  panelWidthClass?: string
}

export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  variant = 'row',
  triggerLabel,
  panelWidthClass,
}: Props<T>) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const active = options.find((o) => o.value === value)

  const triggerBase =
    variant === 'pill'
      ? 'bg-surface border border-line rounded-full px-3 py-1.5'
      : 'w-full bg-surface-dim border border-line rounded-md px-3 py-2'

  return (
    <div ref={wrapRef} className={`relative inline-block ${variant === 'pill' ? '' : 'w-full'}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={`${triggerBase} text-sm text-fg-primary cursor-pointer outline-none focus:ring-2 focus:ring-accent flex items-center justify-between gap-2 transition-colors hover:border-fg-secondary`}
      >
        <span className="flex items-center gap-2 min-w-0">
          {active?.leading}
          <span className="truncate">{triggerLabel ?? active?.label ?? ''}</span>
        </span>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <ul
          role="listbox"
          className={`absolute z-30 mt-1 ${panelWidthClass ?? 'left-0 right-0'} max-h-64 overflow-y-auto rounded-md border border-line bg-surface shadow-lg py-1`}
        >
          {options.map((opt) => {
            const selected = opt.value === value
            return (
              <li key={opt.value} role="option" aria-selected={selected}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(opt.value)
                    setOpen(false)
                  }}
                  className={`w-full px-3 py-2 flex items-center gap-2 text-sm text-left transition-colors ${
                    selected
                      ? 'bg-accent/10 text-ink-black'
                      : 'text-fg-primary hover:bg-surface-dim'
                  }`}
                >
                  {opt.leading}
                  <span className="flex-1 truncate">{opt.label}</span>
                  {selected && <CheckIcon />}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`flex-shrink-0 text-fg-dim transition-transform ${open ? 'rotate-180' : ''}`}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0 text-accent"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

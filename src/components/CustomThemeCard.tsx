// The "pick your own background" card in Settings → Appearance.
//
// ⚠⚠ Two colours go in and NO text colour does. That is the whole design, and
// lib/custom-theme.ts is where it is enforced: the foreground is computed from
// the pair, and if the pair cannot carry readable text the PAIR moves until it
// can. A picker that also offers a text colour eventually produces white on
// cream, and the person who did it reports it as our bug, correctly.
//
// The card edits the CURRENT mode only. Light and dark hold separate pictures
// (the same pair that reads well over a light page is unreadable over a dark
// one), so the header says which one is being edited and switching the theme
// switches what this card shows.

import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../lib/i18n-context'
import { useTheme } from '../lib/theme-context'
import { load, resolve, save, type CustomTheme } from '../lib/custom-theme'

const PRESETS: Array<[string, string]> = [
  ['#0f172a', '#1e293b'],
  ['#111827', '#312e81'],
  ['#0b3d2e', '#134e4a'],
  ['#f8fafc', '#e2e8f0'],
  ['#fef3c7', '#fde68a'],
  ['#ede9fe', '#ddd6fe'],
]

export function CustomThemeCard() {
  const { t } = useI18n()
  const { resolved } = useTheme()
  const [theme, setTheme] = useState<CustomTheme | null>(() => load(resolved))

  // The stored picture belongs to a mode, so following the theme switch is not
  // a nicety: without it the card would edit dark while showing light's colours.
  useEffect(() => {
    setTheme(load(resolved))
  }, [resolved])

  const commit = useCallback(
    (next: CustomTheme | null) => {
      setTheme(next)
      save(next, resolved)
    },
    [resolved],
  )

  const from = theme?.from ?? (resolved === 'dark' ? '#0f172a' : '#f8fafc')
  const to = theme?.to ?? (resolved === 'dark' ? '#1e293b' : '#e2e8f0')
  const preview = resolve(from, to)

  return (
    <section className="bg-surface rounded-lg p-4 space-y-3">
      <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
        {t('settings.custom_theme.title')}
      </div>
      <p className="text-xs text-fg-dim">
        {t(resolved === 'dark' ? 'settings.custom_theme.for_dark' : 'settings.custom_theme.for_light')}
      </p>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="color"
            value={from}
            onChange={(e) => commit({ from: e.target.value, to, mode: resolved })}
            aria-label={t('settings.custom_theme.from')}
            className="h-8 w-12 rounded border border-line bg-transparent p-0"
          />
          {t('settings.custom_theme.from')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="color"
            value={to}
            onChange={(e) => commit({ from, to: e.target.value, mode: resolved })}
            aria-label={t('settings.custom_theme.to')}
            className="h-8 w-12 rounded border border-line bg-transparent p-0"
          />
          {t('settings.custom_theme.to')}
        </label>
      </div>

      {/* The preview shows the RESOLVED pair, not the raw input: if the colours
          had to move to stay readable, the person sees where they actually
          landed rather than a promise the app will not keep. */}
      <div
        className="rounded-lg p-4 text-sm"
        style={{
          backgroundImage: `linear-gradient(160deg, ${preview.from}, ${preview.to})`,
          color: preview.fg,
        }}
      >
        {t('settings.custom_theme.preview')}
      </div>

      {preview.adjusted && (
        <p className="text-xs text-fg-dim">{t('settings.custom_theme.adjusted')}</p>
      )}

      <div className="flex flex-wrap gap-2">
        {PRESETS.map(([a, b]) => (
          <button
            key={a + b}
            type="button"
            onClick={() => commit({ from: a, to: b, mode: resolved })}
            aria-label={`${a} ${b}`}
            className="h-7 w-12 rounded border border-line"
            style={{ backgroundImage: `linear-gradient(160deg, ${a}, ${b})` }}
          />
        ))}
      </div>

      {theme && (
        <button
          type="button"
          onClick={() => commit(null)}
          className="text-sm text-fg-secondary hover:text-fg-primary"
        >
          {t('settings.custom_theme.reset')}
        </button>
      )}
    </section>
  )
}

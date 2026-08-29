import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { islandLabel, normaliseIsland } from '../lib/island-choice'
import { useI18n } from '../lib/i18n-context'
import { IslandAvatar } from './IslandAvatar'

interface CatalogIsland {
  url: string
  name?: string
  description?: string
  region?: string
}

const CATALOG_URL = 'https://rcq.app/servers.json'
const FLAGSHIP = 'https://api.rcq.app'

/**
 * The island chooser the phones already have, for the desktop and the web
 * (megalist B5): the public catalog as a browsable list — logo, name, host,
 * a line of description — with «enter an address by hand» beneath it for the
 * self-hosters the catalog will never know about. The login page used to
 * offer a bare host input and nothing else, which told a newcomer nothing
 * about what exists.
 */
export function IslandPickerModal({
  current,
  onPick,
  onClose,
}: {
  current: string
  onPick: (base: string) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [catalog, setCatalog] = useState<CatalogIsland[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [manual, setManual] = useState('')

  useEffect(() => {
    let dead = false
    fetch(CATALOG_URL)
      .then((r) => r.json())
      .then((d: { servers?: CatalogIsland[] }) => {
        if (!dead) setCatalog(Array.isArray(d.servers) ? d.servers : [])
      })
      .catch(() => { if (!dead) setFailed(true) })
    return () => { dead = true }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function pick(base: string) {
    onPick(normaliseIsland(base))
    onClose()
  }

  const rows: { url: string; name?: string; description?: string; region?: string }[] = [
    { url: FLAGSHIP, name: 'RCQ Flagship', description: t('island.flagship.desc') },
    ...(catalog ?? []).filter((s) => normaliseIsland(s.url) !== FLAGSHIP),
  ]

  return createPortal(
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.16 }}
        onClick={onClose}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-md"
      >
        <motion.div
          initial={{ y: 12, scale: 0.97, opacity: 0 }}
          animate={{ y: 0, scale: 1, opacity: 1 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-md max-h-[80vh] mx-4 flex flex-col rounded-xl bg-surface shadow-xl overflow-hidden"
        >
          <header className="flex items-center justify-between px-4 py-3 border-b border-line/40">
            <span className="text-sm font-semibold">{t('island.picker.title')}</span>
            <button onClick={onClose} aria-label={t('common.cancel')} className="text-fg-secondary hover:text-fg-primary px-1">✕</button>
          </header>
          <div className="flex-1 min-h-0 overflow-y-auto py-1">
            {catalog == null && !failed && (
              <div className="py-8 text-center text-sm text-fg-dim">{t('common.loading')}</div>
            )}
            {failed && (
              <div className="py-4 text-center text-xs text-fg-dim">{t('island.picker.offline')}</div>
            )}
            {rows.map((s) => {
              const base = normaliseIsland(s.url)
              const active = base === current
              return (
                <button
                  key={s.url}
                  type="button"
                  onClick={() => pick(s.url)}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-field ${active ? 'bg-accent/10' : ''}`}
                >
                  <IslandAvatar apiBase={base} size={34} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium truncate">
                      {s.name || islandLabel(base)}
                      {s.region ? <span className="ml-1.5 text-[0.625rem] text-fg-dim uppercase">{s.region}</span> : null}
                    </span>
                    <span className="block text-xs text-fg-dim truncate">{islandLabel(base)}</span>
                    {s.description && (
                      <span className="block text-[0.6875rem] text-fg-secondary truncate">{s.description}</span>
                    )}
                  </span>
                  {active && <span className="flex-none text-accent text-sm">✓</span>}
                </button>
              )
            })}
          </div>
          <footer className="px-4 py-3 border-t border-line/40 space-y-2">
            <div className="text-[0.6875rem] uppercase tracking-wide text-fg-dim">{t('island.picker.manual')}</div>
            <div className="flex gap-2">
              <input
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && manual.trim()) pick(manual) }}
                placeholder="my-island.example.org"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                className="flex-1 min-w-0 h-9 px-3 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm"
              />
              <button
                type="button"
                onClick={() => manual.trim() && pick(manual)}
                disabled={!manual.trim()}
                className="h-9 px-3 rounded-md bg-accent text-white text-xs font-semibold disabled:opacity-40"
              >
                OK
              </button>
            </div>
          </footer>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}

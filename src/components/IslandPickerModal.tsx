import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { hostnameOf, isIpLiteral, islandLabel, normaliseIsland, type IslandAddress } from '../lib/island-choice'
import { isCaOnlyHost } from '../lib/island-trust'
import { isTauri } from '../lib/desktop'
import { useI18n } from '../lib/i18n-context'
import { useServerInfo } from '../lib/use-server-info'
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
 *
 * The hand-typed address may carry the island's certificate fingerprint after
 * a `#` (docs/island-fingerprint-design.md §3). It comes back beside the base
 * for the caller to pin BEFORE anything is dialled. A fragment that is not a
 * fingerprint is an error here, not something to drop: connecting anyway
 * would take a first-use pin while the person believes they pinned.
 */
export function IslandPickerModal({
  current,
  onPick,
  onClose,
}: {
  current: string
  onPick: (address: IslandAddress) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [catalog, setCatalog] = useState<CatalogIsland[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [manual, setManual] = useState('')
  const [error, setError] = useState<string | null>(null)
  /// The island whose house rules are being read, in place of the list.
  ///
  /// ⚠ A PAGE OF THIS MODAL, not an overlay on top of it. Both bars of this
  /// app carry a `backdrop-filter`, which makes them the containing block for
  /// anything `fixed` inside them, and a second overlay is how that trap gets
  /// sprung (Settings opens the same text in place for the same reason). One
  /// way back, the way the phones do it.
  const [rules, setRules] = useState<{ name: string; text: string } | null>(null)

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
    // Escape backs out one step at a time: out of the rules and back to the
    // list, then out of the picker. Closing the whole thing from the rules
    // would throw away the choice somebody opened them to make.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (rules) setRules(null)
      else onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, rules])

  function pick(input: string) {
    const address = normaliseIsland(input)
    if (address.badFingerprint) {
      setError(t('island.trust.not_fingerprint'))
      return
    }
    // The flagship is trusted through its authority and never pinned (§1); a
    // fragment on it is a wrong address, not a pin to take.
    if (address.fingerprint && isCaOnlyHost(hostnameOf(address.base))) {
      setError(t('island.trust.ca_only'))
      return
    }
    onPick(address)
    onClose()
  }

  const rows: { url: string; name?: string; description?: string; region?: string }[] = [
    { url: FLAGSHIP, name: 'RCQ Flagship', description: t('island.flagship.desc') },
    ...(catalog ?? []).filter((s) => normaliseIsland(s.url).base !== FLAGSHIP),
  ]

  // §5.4, the web in a browser only: a fragment, or a bare IP, is the shape of
  // an island without a certificate authority, and a browser cannot be told
  // to trust one. The desktop and the phones can.
  const typed = manual.trim()
  const browserHint =
    !isTauri() && typed.length > 0 && (typed.includes('#') || isIpLiteral(hostnameOf(normaliseIsland(typed).base)))

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
            <span className="text-sm font-semibold">{rules ? rules.name : t('island.picker.title')}</span>
            <button onClick={onClose} aria-label={t('common.cancel')} className="text-fg-secondary hover:text-fg-primary px-1">✕</button>
          </header>
          {rules ? (
            <>
              <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 text-xs text-fg-secondary leading-relaxed whitespace-pre-wrap">
                {rules.text}
              </div>
              <footer className="px-4 py-3 border-t border-line/40">
                <button
                  type="button"
                  onClick={() => setRules(null)}
                  className="text-xs text-accent hover:underline"
                >
                  {t('island.back_to_list')}
                </button>
              </footer>
            </>
          ) : (<>
          <div className="flex-1 min-h-0 overflow-y-auto py-1">
            {catalog == null && !failed && (
              <div className="py-8 text-center text-sm text-fg-dim">{t('common.loading')}</div>
            )}
            {failed && (
              <div className="py-4 text-center text-xs text-fg-dim">{t('island.picker.offline')}</div>
            )}
            {rows.map((s) => {
              const base = normaliseIsland(s.url).base
              const active = base === current
              return (
                // ⚠ The rules button is a SIBLING of the row, not a button
                // inside it: one button nested in another is markup a browser
                // is free to untangle however it likes, and the whole point of
                // this control is that it does something other than what the
                // row it sits in does.
                <div
                  key={s.url}
                  className={`flex items-stretch transition-colors hover:bg-field ${active ? 'bg-accent/10' : ''}`}
                >
                  <button
                    type="button"
                    onClick={() => pick(s.url)}
                    className="min-w-0 flex-1 flex items-center gap-3 px-4 py-2.5 text-left"
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
                      <IslandEntryLine apiBase={base} />
                    </span>
                    {active && <span className="flex-none text-accent text-sm">✓</span>}
                  </button>
                  <IslandRulesButton
                    apiBase={base}
                    fallbackName={s.name || islandLabel(base)}
                    onOpen={(name, text) => setRules({ name, text })}
                  />
                </div>
              )
            })}
          </div>
          <footer className="px-4 py-3 border-t border-line/40 space-y-2">
            <div className="text-[0.6875rem] uppercase tracking-wide text-fg-dim">{t('island.picker.manual')}</div>
            <div className="flex gap-2">
              <input
                value={manual}
                onChange={(e) => {
                  setManual(e.target.value)
                  setError(null)
                }}
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
            {error && <div className="text-xs text-red-500 leading-relaxed">{error}</div>}
            {!error && browserHint && (
              <div className="text-xs text-fg-dim leading-relaxed">{t('island.trust.browser_hint')}</div>
            )}
          </footer>
          </>)}
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}

/// The island's house rules, one click from the row that would join it
/// (founder, 07.09: "a good idea, so you can look before joining"). The same
/// words its own Settings page shows to the people already living there.
///
/// ⚠ Drawn ONLY when the operator actually wrote some. A blank welcome is the
/// ordinary case, and a button that opens an empty page is worse than no
/// button at all — so this renders nothing until the island has answered and
/// said it has something to show.
///
/// The extra `useServerInfo` costs no extra request: `fetchServerInfo` hands
/// every caller for the same island the one promise it already has in flight.
function IslandRulesButton({
  apiBase,
  fallbackName,
  onOpen,
}: {
  apiBase: string
  fallbackName: string
  onOpen: (name: string, text: string) => void
}) {
  const { t } = useI18n()
  const info = useServerInfo(apiBase)
  const text = info?.welcome.trim()
  if (!text) return null
  return (
    <button
      type="button"
      onClick={() => onOpen(info?.name.trim() || fallbackName, text)}
      title={t('island.rules.title')}
      aria-label={t('island.rules.title')}
      className="flex-none px-3 text-fg-dim hover:text-accent transition-colors"
    >
      {/* A sheet of paper with lines on it: hand-drawn like every other glyph
          in this tree, which ships no icon dependency. */}
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 3.5h9L19 8v12.5H6z" />
        <path d="M14 3.5V8h5M9 12h6M9 16h4" />
      </svg>
    </button>
  )
}

/// Whether an island lets you in at all, and what it charges, under its name
/// in the picker.
///
/// ⚠ Asked of the ISLAND, not of the catalogue. servers.json is a file we
/// maintain by hand and it would be stale the day after an operator changed
/// their price — and a wrong price is worse than no price. The island answers
/// for itself on /server/info, which the picker already warms for the logo.
///
/// ⚠⚠ TWO flags decide "closed", the same pair the create form reads (see
/// Login.tsx). `registration_policy` is what the door actually enforces;
/// `closed_island` also withholds the residents' envelope key. An operator can
/// set either alone, and this line used to read only the second — so an
/// invite-only island that had not been marked closed advertised itself as an
/// ordinary island and then refused the person at the last step.
///
/// ⚠ `useServerInfo`, not `useServerCapabilities`: the capabilities hook fills
/// its gaps with the PERMISSIVE defaults, which say "open". Printing that for
/// an island that has not answered yet — or cannot be reached at all — would
/// promise a door we never knocked on. Silence until the island speaks for
/// itself (founder, 07.09: the picker must say which islands are closed).
function IslandEntryLine({ apiBase }: { apiBase: string }) {
  const { t } = useI18n()
  const info = useServerInfo(apiBase)
  if (!info) return null
  const caps = info.capabilities
  const closed = caps.closed_island || caps.registration_policy === 'invite'
  if (!closed) {
    // Dim, unlike the closed line: this is the ordinary answer, and the row it
    // sits in should not shout it.
    return <span className="block text-[0.6875rem] text-fg-dim truncate">{t('island.entry.open')}</span>
  }
  const cents = caps.entry_price_cents ?? 0
  // Where the island sells entry, in its own words. `entry_url` is the
  // operator's setting, so a self-hoster sends people to their own shop and we
  // send people to ours; an island that set a price and no address gets the
  // line without a link rather than a link to somewhere we made up.
  const url = (caps.entry_url || '').trim()
  const line = cents > 0
    ? t('island.entry.price', { price: formatUsd(cents) })
    : caps.closed_island
      ? t('island.entry.closed')
      : t('island.entry.invite')
  if (!url || !/^https:\/\//i.test(url)) {
    return <span className="block text-[0.6875rem] text-accent truncate">{line}</span>
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      // ⚠ Stops here. This line sits inside the row that PICKS the island, and
      // a click that both opened a shop and chose an island would be two
      // answers to a question the person asked once.
      onClick={(e) => e.stopPropagation()}
      className="block text-[0.6875rem] text-accent truncate hover:underline"
    >
      {line} · {t('island.entry.buy')}
    </a>
  )
}

/// Cents to a string a person reads. Whole dollars lose the ".00": a club that
/// costs fifteen dollars should say fifteen dollars.
function formatUsd(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`
}

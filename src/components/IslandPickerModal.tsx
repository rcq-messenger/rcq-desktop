import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { listStoredIdentities } from '../lib/auth'
import { hostnameOf, isIpLiteral, islandLabel, normaliseIsland, type IslandAddress } from '../lib/island-choice'
import { isCaOnlyHost, prePinIsland } from '../lib/island-trust'
import { isTauri } from '../lib/desktop'
import { useI18n } from '../lib/i18n-context'
import { cachedCatalog, catalogBase, fetchCatalog, FLAGSHIP, type CatalogIsland } from '../lib/island-catalog'
import { forgetGatewayKey, redeemGatewayKey } from '../lib/island-gate'
import { forgetRememberedIsland, listRememberedIslands, rememberReachedIsland } from '../lib/remembered-islands'
import { fetchServerInfo } from '../lib/server-info'
import { IslandCarousel } from './IslandCarousel'
import type { DeckIsland } from './IslandCard'

/**
 * The island chooser the phones have, for the desktop and the web: the same
 * deck of cards (IslandCarousel), one island per page with the painting, the
 * name, the host, the door and the blurb, with «enter an address by hand» on
 * a page of its own beneath it for the self-hosters the catalogue will never
 * know about. It used to be a vertical list of rows (megalist B5); the founder
 * asked for the phones' carousel on the desktop (12.09).
 *
 * Three pages in one modal and never a second overlay: the deck, the typed
 * address, and an island's house rules. ⚠ Both bars of this app carry a
 * `backdrop-filter`, which makes them the containing block for anything
 * `fixed` inside them, and a second overlay is how that trap gets sprung.
 * Escape backs out one page at a time.
 *
 * The deck is the islands this profile REACHED and the catalogue does not
 * list (remembered-islands.ts, most recent first), then the catalogue with
 * the flagship first; an island in both shows once, on the catalogue card.
 * The flagship is on the deck whether or not the catalogue answered, so a
 * blocked rcq.app leaves a deck rather than an empty modal.
 *
 * The hand-typed address may carry the island's certificate fingerprint after
 * a `#` (docs/island-fingerprint-design.md §3). It comes back beside the base
 * for the caller to pin BEFORE anything is dialled. A fragment that is not a
 * fingerprint is an error here, not something to drop: connecting anyway
 * would take a first-use pin while the person believes they pinned. On the
 * desktop the typed page also takes a private island's gateway key
 * (island-gate.ts); the key is redeemed before the pick so the very first
 * request the form makes already passes the gate.
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
  const [catalog, setCatalog] = useState<CatalogIsland[] | null>(() => cachedCatalog())
  const [failed, setFailed] = useState(false)
  const [remembered, setRemembered] = useState(() => listRememberedIslands())
  /// Islands an account in the roster lives on. Read once: the roster does
  /// not change while this modal is open.
  const [homes] = useState(() => new Set(listStoredIdentities().map((a) => a.apiBase)))
  const [page, setPage] = useState<'deck' | 'manual'>('deck')
  const [manual, setManual] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rules, setRules] = useState<{ name: string; text: string } | null>(null)
  // Focus moves INTO the modal on open, off the row that opened it, so the
  // arrows and Escape are the modal's from the first keystroke.
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    box.current?.focus()
  }, [])

  useEffect(() => {
    let dead = false
    fetchCatalog()
      .then((list) => {
        if (dead) return
        setCatalog(list)
        setFailed(false)
      })
      .catch(() => {
        if (!dead) setFailed(true)
      })
    return () => {
      dead = true
    }
  }, [])

  const deck = useMemo<DeckIsland[]>(() => {
    const flagshipRow = (catalog ?? []).find((s) => catalogBase(s) === FLAGSHIP)
    const rows: DeckIsland[] = [
      { base: FLAGSHIP, name: 'RCQ Flagship', description: t('island.flagship.desc'), region: flagshipRow?.region },
    ]
    for (const s of catalog ?? []) {
      const base = catalogBase(s)
      if (base === FLAGSHIP || rows.some((r) => r.base === base)) continue
      rows.push({ base, name: s.name, description: s.description, region: s.region })
    }
    const listed = new Set(rows.map((r) => r.base))
    const mine: DeckIsland[] = remembered
      .filter((r) => !listed.has(r.base))
      .map((r) => ({ base: r.base, name: r.name || undefined, remembered: true }))
    return [...mine, ...rows]
  }, [catalog, remembered, t])

  // Opens on the island in force (Android :178). The catalogue may land after
  // the first frame and bring that island with it, so the deck is followed
  // to it until the person pages on their own.
  const paged = useRef(false)
  const [index, setIndex] = useState(() => Math.max(0, deck.findIndex((d) => d.base === current)))
  useEffect(() => {
    if (!paged.current) {
      const at = deck.findIndex((d) => d.base === current)
      if (at >= 0 && at !== index) setIndex(at)
    }
    if (index > deck.length - 1) setIndex(Math.max(0, deck.length - 1))
    // `index` is what this effect sets; following it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck, current])

  function setPage_(i: number) {
    paged.current = true
    setIndex(i)
  }

  useEffect(() => {
    // Escape backs out one step at a time: out of the rules and back to the
    // deck, out of the typed page and back to the deck, then out of the
    // picker. Closing the whole thing from the rules would throw away the
    // choice somebody opened them to make. The arrows, Home, End and Enter
    // drive the deck: the desktop has no swipe, and a deck you can only click
    // through is a list with extra steps.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (rules) setRules(null)
        else if (page === 'manual') setPage('deck')
        else onClose()
        return
      }
      if (rules || page !== 'deck') return
      const el = e.target instanceof HTMLElement ? e.target : null
      // A key aimed at a field belongs to the field. A BUTTON is not in that
      // list on purpose: the click that opened this modal leaves the login
      // page's island row focused, and the first version bailed out on any
      // button, so the arrows did nothing until the person clicked blank
      // space. Enter on a button is that button's, handled below.
      if (el?.closest('input, textarea, select')) return
      switch (e.key) {
        case 'ArrowLeft':
          setPage_(Math.max(0, index - 1))
          break
        case 'ArrowRight':
          setPage_(Math.min(deck.length - 1, index + 1))
          break
        case 'Home':
          setPage_(0)
          break
        case 'End':
          setPage_(deck.length - 1)
          break
        case 'Enter':
          if (el?.closest('button, a')) return
          if (deck[index]) pick(deck[index].base)
          break
        default:
          return
      }
      e.preventDefault()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  /// A card's Use: catalogue and remembered bases carry no fragment, and a
  /// remembered island's pin is already on file in the trust store.
  function pick(base: string) {
    onPick(normaliseIsland(base))
    onClose()
  }

  /// The typed page's OK.
  async function pickTyped() {
    const address = normaliseIsland(manual)
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
    const typedKey = key.trim()
    if (typedKey && isTauri()) {
      setBusy(true)
      try {
        // ⚠ The pin BEFORE the redeem. The redeem is the first request to
        // this island, and on an island without a certificate authority it
        // has to be judged by the fingerprint the person typed, not taken on
        // first use. The caller's `commit` pins again a moment later, which
        // is a no-op against the same value.
        if (address.fingerprint) await prePinIsland(address.base, address.fingerprint)
        const outcome = await redeemGatewayKey(address.base, typedKey)
        if (outcome === 'bad') {
          setError(t('island.gateway_key_bad'))
          return
        }
        if (outcome === 'offline') {
          setError(t('auth.error.register_offline', { island: islandLabel(address.base) }))
          return
        }
        // The island took the key: it is reached, and remembered NOW rather
        // than after a registration that may still fail, so the key is not
        // lost with it.
        if (outcome === 'ok') rememberReachedIsland(address.base, 'typed', { fingerprint: address.fingerprint })
      } finally {
        setBusy(false)
      }
    }
    onPick(address)
    // A typed island is remembered once it ANSWERS, not when it is typed: a
    // typo must not become a bookmark. The form is about to ask the same
    // question for its door line, and `fetchServerInfo` shares the one
    // request, so this costs nothing. After the pick, so a fingerprint
    // typed with the address is on file before the request is dialled.
    void fetchServerInfo(address.base).then((info) => {
      if (info) rememberReachedIsland(address.base, 'typed', { fingerprint: address.fingerprint })
    })
    onClose()
  }

  /// Forget takes the row and the gateway key, and leaves the accounts and
  /// the pin alone (see remembered-islands.ts).
  function forget(base: string) {
    forgetRememberedIsland(base)
    forgetGatewayKey(base)
    setRemembered(listRememberedIslands())
  }

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
          ref={box}
          tabIndex={-1}
          className="w-full max-w-xl max-h-[85vh] mx-4 flex flex-col rounded-xl bg-surface shadow-xl overflow-hidden outline-none"
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
          ) : page === 'manual' ? (
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2">
              <div className="text-[0.6875rem] uppercase tracking-wide text-fg-dim">{t('island.picker.manual')}</div>
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={manual}
                  onChange={(e) => {
                    setManual(e.target.value)
                    setError(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && manual.trim() && !busy) void pickTyped()
                  }}
                  placeholder="my-island.example.org"
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  className="flex-1 min-w-0 h-9 px-3 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm"
                />
                <button
                  type="button"
                  onClick={() => manual.trim() && !busy && void pickTyped()}
                  disabled={!manual.trim() || busy}
                  className="h-9 px-3 rounded-md bg-accent text-white text-xs font-semibold disabled:opacity-40"
                >
                  OK
                </button>
              </div>
              {/* Desktop only. A browser has nowhere to keep a secret that the
                  page itself cannot read, and could not put the key on its
                  socket anyway (island-gate.ts). */}
              {isTauri() && (
                <div className="space-y-1 pt-1">
                  <label className="block text-[0.6875rem] uppercase tracking-wide text-fg-dim">
                    {t('island.gateway_key')}
                  </label>
                  <input
                    value={key}
                    onChange={(e) => {
                      setKey(e.target.value)
                      setError(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && manual.trim() && !busy) void pickTyped()
                    }}
                    autoComplete="off"
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="off"
                    className="w-full h-9 px-3 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm"
                  />
                  <p className="text-xs text-fg-dim leading-relaxed">{t('island.gateway_key_hint')}</p>
                </div>
              )}
              {error && <div className="text-xs text-red-500 leading-relaxed">{error}</div>}
              {!error && browserHint && (
                <div className="text-xs text-fg-dim leading-relaxed">{t('island.trust.browser_hint')}</div>
              )}
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setPage('deck')}
                  className="text-xs text-accent hover:underline"
                >
                  {t('island.back_to_list')}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto px-4 pt-3 pb-3">
              <IslandCarousel
                islands={deck}
                index={Math.min(index, deck.length - 1)}
                onIndex={setPage_}
                current={current}
                homes={homes}
                onUse={pick}
                onForget={forget}
                onRules={(name, text) => setRules({ name, text })}
              />
              {failed && catalog == null && (
                <div className="mt-2 text-center text-xs text-fg-dim">{t('island.picker.offline')}</div>
              )}
              <div className="mt-2 text-center">
                <button
                  type="button"
                  onClick={() => setPage('manual')}
                  className="text-xs text-accent hover:underline py-1"
                >
                  {t('island.picker.manual')}
                </button>
              </div>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}

// `formatUsd` used to live here. It moved to lib/server-info.ts, next to the
// `entry_price_cents` field it formats, once the create form began printing
// the same price beside the access-code box. The door line, the crowd mark
// and the rules button moved to IslandCard.tsx with the deck.

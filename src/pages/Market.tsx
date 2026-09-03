// UIN market — the money layer's home screen, and the foundation for the
// whole UIN economy: claim a handle from the system today, with the scaffold
// for a peer-to-peer resale market and crypto/card checkout in place.
//
// Design language: restrained and premium (Stripe / Linear / ENS), NOT the
// chat's bordered minimalism and NOT decorative. Neutral palette, generous
// whitespace, typography does the work, and the single accent (green) is used
// only for MEANING — availability and the primary action. No gradient slabs,
// no glows: those read as noise, not value.
//
// Functionally: type a 3-9 digit handle, see live availability + price, take
// it. Taking it does NOT change who the account answers as — the number lands
// in the collection (Your numbers, below the field) and moving onto it is a
// second, deliberate step, the same split the Android client and the server
// (POST /uin/purchase{switch:false} then /uin/activate) use. Payments do not
// exist yet; the price is real (a function of digit count) and checkout is
// gated off. Real card/crypto checkout is the next layer.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import { Api, ApiError, type MyUins, type UinQuote, type UinSuggestion } from '../lib/api'
import { useToast } from '../lib/toast'
import { Logo } from '../components/Logo'
import { UinCheckout } from '../components/UinCheckout'
// ⚠ Aliased: this file already has its own `CoinIcon`, the generic coin glyph
// used as the crypto card's badge. This one is the actual coin's mark.
import { CoinIcon as ChainMark } from '../components/CoinIcons'
import { Till, forgetInvoice, listInvoices, type StoredInvoice } from '../lib/till'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'

const PRICE_CENTS_BY_LENGTH: Record<number, number> = {
  9: 99,
  8: 199,
  7: 499,
  6: 1499,
  5: 4999,
  4: 19900,
  3: 99900,
}
const TIER_LENGTHS = [3, 4, 5, 6, 7, 8, 9]
const JUST_BOUGHT_KEY = 'rcq.web.uin.justBought'
/// Set right before the reload that follows a switch, so the banner can say
/// "you now answer as N" rather than "you now hold N".
const JUST_SWITCHED_KEY = 'rcq.web.uin.justSwitched'

// ⚠ There is no checkout GATE any more, and there must not be one: the server
// decides. A quote comes back saying how a number is obtained — `free` for
// ordinary space, `purchase` for the scarce stock, `closed` for what is not
// sold at all — and this page draws the button that answer implies. The old
// boolean here was a promise made in a file nobody deploying the island reads;
// an island with no till now says so itself, in the quote.

// One reused spring + ease, applied consistently (premium motion is
// coherent, not per-element improvisation).
const SPRING = { type: 'spring' as const, stiffness: 420, damping: 34 }
const EASE = [0.22, 1, 0.36, 1] as const

function priceDisplay(cents: number): string {
  const d = cents / 100
  return cents % 100 === 0 ? `$${d.toFixed(0)}` : `$${d.toFixed(2)}`
}

/// Digits only, capped at 9, leading zeros stripped — a UIN is an integer.
function sanitize(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 9).replace(/^0+/, '')
}

export function Market() {
  const { identity, adoptMigration, beginMigration, endMigration } = useIdentity()
  const { t } = useI18n()
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)

  const [typed, setTyped] = useState('')
  const [quote, setQuote] = useState<UinQuote | null>(null)
  const [checking, setChecking] = useState(false)
  const [buying, setBuying] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { toast } = useToast()
  const [suggestions, setSuggestions] = useState<UinSuggestion[]>([])
  const [loadingSuggestions, setLoadingSuggestions] = useState(true)
  const [justBought, setJustBought] = useState<number | null>(null)
  const [justSwitched, setJustSwitched] = useState(false)
  // The collection. `null` = not loaded (or the island is too old to know
  // /uin/mine), which hides the whole section rather than showing an empty one.
  const [mine, setMine] = useState<MyUins | null>(null)
  // A number just taken: "it is yours, move onto it now or later?"
  const [held, setHeld] = useState<number | null>(null)
  // The held number the user tapped Switch on, awaiting confirmation.
  const [switchTarget, setSwitchTarget] = useState<number | null>(null)
  // #669: the phones can give a held number back and the web could not, so a
  // number taken by mistake was stuck on the account forever.
  const [releaseTarget, setReleaseTarget] = useState<number | null>(null)
  const [releasing, setReleasing] = useState(false)
  const [switching, setSwitching] = useState(false)
  // The number being paid for right now, if the checkout sheet is open.
  const [checkout, setCheckout] = useState<number | null>(null)
  const [redeeming, setRedeeming] = useState(false)
  // ⚠ Guards the one thing in this page that money depends on: a voucher must
  // be redeemed once. The poll keeps returning it and React may run an effect
  // twice, so the guard is a ref, not state.
  const redeemed = useRef<Set<string>>(new Set())
  // Invoices this browser has open. ⚠ Kept in state, not read from storage at
  // render time: a number you are already paying for must offer the payment
  // back, not a second invoice the till would refuse because the first one is
  // holding the number.
  const [openInvoices, setOpenInvoices] = useState<StoredInvoice[]>(() => listInvoices())

  useEffect(() => {
    const v = sessionStorage.getItem(JUST_BOUGHT_KEY)
    if (v) {
      setJustBought(Number(v))
      setJustSwitched(sessionStorage.getItem(JUST_SWITCHED_KEY) === '1')
      sessionStorage.removeItem(JUST_BOUGHT_KEY)
      sessionStorage.removeItem(JUST_SWITCHED_KEY)
      const h = setTimeout(() => setJustBought(null), 6000)
      return () => clearTimeout(h)
    }
  }, [])

  if (!identity) {
    navigate('/', { replace: true })
    return null
  }
  const id = identity

  const len = typed.length
  const validLen = len >= 3 && len <= 9
  const liveQuote = quote && quote.uin === Number(typed) ? quote : null
  const available = liveQuote?.available ?? false
  // ⚠ The price the island quoted, not the one this file believes. The local
  // ladder is for the tier list, where no number has been typed yet; once one
  // has, a figure the browser computed is a figure the browser could change.
  const localCents = liveQuote?.price_cents ?? (validLen ? PRICE_CENTS_BY_LENGTH[len] : null)
  // ⚠⚠ Missing on an island older than 03.09, where `available` meant "free".
  const acquire = liveQuote?.acquire ?? 'free'
  // ⚠⚠ `available` is FALSE for scarce stock, deliberately: three released
  // clients read that field alone and would otherwise offer, for free, exactly
  // the numbers that are now for sale. So a paid number is recognised by
  // `acquire`, and a free one by `available` as before.
  const forSale = validLen && acquire === 'purchase' && (liveQuote?.price_cents ?? 0) > 0
  const canTake = validLen && available && acquire === 'free' && !buying
  const canPay = forSale && !buying && !redeeming
  // An invoice already open on the number in the field. It holds that number,
  // which is exactly why the quote says unavailable.
  const resumable = validLen ? openInvoices.find((i) => i.uin === Number(typed)) : undefined

  useEffect(() => {
    if (!validLen || !Number(typed)) {
      setQuote(null)
      return
    }
    const target = Number(typed)
    let cancelled = false
    setChecking(true)
    const h = setTimeout(async () => {
      try {
        const q = await Api.uinQuote(id, target)
        if (!cancelled && Number(typed) === target) setQuote(q)
      } catch {
        /* soft fail */
      } finally {
        if (!cancelled) setChecking(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(h)
      setChecking(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed])

  const loadSuggestions = useCallback(async () => {
    setLoadingSuggestions(true)
    try {
      setSuggestions(await Api.uinSuggestions(id, 6))
    } catch {
      setSuggestions([])
    } finally {
      setLoadingSuggestions(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id.uin])

  useEffect(() => {
    void loadSuggestions()
  }, [loadSuggestions])

  const loadMine = useCallback(async () => {
    try {
      setMine(await Api.uinMine(id))
    } catch {
      // An island that predates the vault 404s here; the section stays hidden
      // rather than claiming the account holds nothing.
      setMine(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id.uin])

  useEffect(() => {
    void loadMine()
  }, [loadMine])

  function pick(uin: number) {
    setTyped(sanitize(String(uin)))
    setError(null)
    inputRef.current?.focus()
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  /// Take the number into the collection. It does NOT change who the account
  /// answers as — that is the separate step below, offered right away in the
  /// "it is yours" dialog for whoever wants it now.
  async function doPurchase() {
    if (!canTake) return
    const target = Number(typed)
    setBuying(true)
    setError(null)
    try {
      await Api.uinPurchase(id, target, false)
      // Close the confirm sheet by its own flag only. Clearing `typed` here
      // too pulled the price/CTA block out from under the exit animation and
      // left both dialogs on screen at once; the field is cleared when the
      // "it is yours" dialog closes instead.
      setConfirming(false)
      setHeld(target)
      await loadMine()
    } catch (e) {
      setConfirming(false)
      if (e instanceof ApiError) {
        if (e.status === 429) setError(t('uin_market.error.cooldown'))
        else if (e.status === 409 || e.body.includes('taken')) {
          setError(t('uin_market.error.taken'))
          setQuote(null)
        } else setError(t('uin_market.error.generic'))
      } else setError(t('uin_market.error.generic'))
    } finally {
      setBuying(false)
    }
  }

  /// Turn a voucher into a number.
  ///
  /// ⚠ Called from two places that both mean "somebody has paid": the open
  /// checkout sheet, and the sweep below that finds a payment made before the
  /// page was last closed. Both funnel through here so the once-only guard is
  /// in one place.
  const doRedeem = useCallback(
    async (target: number, voucher: string, invoiceId: string) => {
      if (redeemed.current.has(invoiceId)) return
      redeemed.current.add(invoiceId)
      setRedeeming(true)
      setError(null)
      try {
        await Api.uinRedeem(id, target, voucher, false)
        forgetInvoice(invoiceId)
        setOpenInvoices(listInvoices())
        setCheckout(null)
        setHeld(target)
        await loadMine()
      } catch (e) {
        setCheckout(null)
        // ⚠ `voucher_spent` is not a failure to show in red: it means this
        // number is already in the collection, which is what the buyer wanted.
        // Anything else keeps the invoice, so a retry is still possible.
        const spent = e instanceof ApiError && e.body.includes('voucher_spent')
        if (spent) {
          forgetInvoice(invoiceId)
          setOpenInvoices(listInvoices())
          await loadMine()
        } else {
          redeemed.current.delete(invoiceId)
          setError(
            e instanceof ApiError && e.body.includes('taken')
              ? t('uin_market.error.taken_paid')
              : t('uin_market.error.generic'),
          )
        }
      } finally {
        setRedeeming(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id.uin],
  )

  /// A payment that landed while nobody was looking.
  ///
  /// ⚠⚠ This is the whole reason invoices are kept in this browser. Somebody
  /// pays, closes the tab before the confirmation, and comes back: without
  /// this sweep their money bought a voucher that is sitting in a till nobody
  /// asks. It runs once per page load, quietly, and only ever finishes what
  /// was already paid for.
  useEffect(() => {
    let dead = false
    void (async () => {
      for (const stored of listInvoices()) {
        if (dead) return
        try {
          const inv = await Till.invoice(stored.id, stored.checkoutUrl)
          if (dead) return
          if (inv.status === 'paid' && inv.voucher) {
            await doRedeem(inv.uin, inv.voucher, inv.id)
          } else if (inv.status === 'expired') {
            // Nothing was paid and the invoice is dead. A transfer already
            // sent is still matched for a day by the till, so this only drops
            // what has no payment behind it.
            forgetInvoice(inv.id)
            setOpenInvoices(listInvoices())
          }
        } catch {
          /* a till we cannot reach today is one we ask again tomorrow */
        }
      }
    })()
    return () => {
      dead = true
    }
  }, [doRedeem])

  /// Answer as a number already held. This IS a migration: the JWT changes and
  /// libsignal sessions reset, so the page reloads under the new identity the
  /// same way a purchase-with-switch used to.
  async function doSwitch(target: number) {
    setSwitching(true)
    setError(null)
    // Before the request: the server's account_burned broadcast to the old
    // number can arrive over the websocket before the HTTP response does.
    beginMigration()
    try {
      const res = await Api.uinActivate(id, target)
      if (!res.new_uin || !res.token) throw new Error('no token')
      sessionStorage.setItem(JUST_BOUGHT_KEY, String(res.new_uin))
      sessionStorage.setItem(JUST_SWITCHED_KEY, '1')
      // Reloads under the new number. Market lives at the root of its own
      // host, so '/' is this page.
      adoptMigration(res.new_uin, res.token, '/')
    } catch (e) {
      endMigration()
      setSwitching(false)
      setSwitchTarget(null)
      setHeld(null)
      if (e instanceof ApiError && e.status === 429) setError(t('uin_market.error.cooldown'))
      else setError(t('uin_market.error.generic'))
      void loadMine()
    }
  }

  async function doRelease(uin: number) {
    setReleasing(true)
    setError(null)
    try {
      await Api.uinRelease(id, uin)
      setReleaseTarget(null)
      toast(t('uin_market.mine.release.done'))
      await loadMine()
      void loadSuggestions()
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 400
          ? t('uin_market.error.generic')
          : t('uin_market.error.generic'),
      )
      setReleaseTarget(null)
    } finally {
      setReleasing(false)
    }
  }

  const availabilityKey =
    checking && !liveQuote
      ? 'checking'
      : liveQuote
        ? liveQuote.available || liveQuote.acquire === 'purchase'
          ? 'ok'
          : 'no'
        : 'idle'

  function reasonText(reason?: string | null): string {
    switch (reason) {
      case 'taken':
        return t('uin_market.status.taken')
      // Short (six digits or fewer) or a recognisable shape. The island keeps
      // these as stock rather than handing them to whoever asks first, so the
      // field has to say so instead of offering a number that /purchase would
      // refuse. See services/uin.is_reserved_uin.
      case 'reserved':
        return t('uin_market.status.reserved')
      case 'self':
        return t('uin_market.status.self')
      case 'too_long':
        return t('uin_market.status.too_long')
      default:
        return t('uin_market.status.unavailable')
    }
  }

  return (
    <div className="min-h-screen bg-surface-dim text-fg-primary">
      {/* Header — the brand sits up top, quiet and centered. */}
      <header className="sticky top-0 z-20 backdrop-blur-xl bg-surface-dim/80">
        <div className="max-w-lg mx-auto px-5 h-14 flex items-center">
          <button
            // The market is a screen of the app now, so back is just back.
            // It used to live on its own host, where "/contacts" was not a
            // route and this button had to leave the site to work.
            //
            // ⚠ Back is HISTORY back, not the contact list (#604). Most people
            // reach the shop from Settings, and sending them to the home screen
            // threw away both the screen they were on and how far down it they
            // had scrolled. Opened cold (a bookmark, the desktop app's first
            // screen after a reload) there is nothing to go back to, so fall
            // back to where this button used to point — the same shape the
            // profile's Cancel already uses.
            onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/contacts'))}
            className="grid place-items-center h-9 w-9 -ml-1.5 rounded-full text-fg-secondary hover:text-fg-primary hover:bg-fg-primary/[0.06] active:scale-95 transition"
            aria-label={t('common.back')}
          >
            <BackIcon />
          </button>
          <div className="flex-1 flex items-center justify-center gap-2">
            <Logo size={20} spin />
            <span className="text-[0.9375rem] font-semibold tracking-tight">{t('brand.name')}</span>
          </div>
          <div className="w-9" aria-hidden />
        </div>
      </header>

      <main className="max-w-lg mx-auto px-5 pb-20 pt-3">
        <AnimatePresence>
          {justBought != null && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25, ease: EASE }}
              className="mb-5 flex items-center gap-3 rounded-2xl bg-accent/10 px-4 py-3"
            >
              <CheckCircle />
              <div className="text-sm leading-tight">
                <div className="font-semibold text-accent">{t('uin_market.bought.title')}</div>
                <div className="text-fg-secondary">
                  {justSwitched
                    ? t('uin_market.switched.body', { uin: `${justBought}` })
                    : t('uin_market.bought.body', { uin: `${justBought}` })}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* CLAIM — the primary action. Type leads, the field is the hero. */}
        <section className="pt-3">
          <h1 className="text-[1.625rem] sm:text-[2rem] font-bold tracking-tight leading-[1.1]">
            {t('uin_market.headline')}
          </h1>
          <p className="mt-2 text-sm text-fg-secondary max-w-sm leading-relaxed">
            {t('uin_market.subhead', { uin: `${id.uin}` })}
          </p>

          <div className="mt-6 flex items-center h-[88px] rounded-2xl bg-surface dark:bg-field px-5 transition-colors focus-within:bg-field dark:focus-within:bg-line">
            <input
              ref={inputRef}
              value={typed}
              onChange={(e) => {
                setTyped(sanitize(e.target.value))
                setError(null)
              }}
              inputMode="numeric"
              pattern="[0-9]*"
              autoFocus
              aria-label={t('uin_market.input.aria')}
              className="flex-1 min-w-0 bg-transparent outline-none text-4xl sm:text-5xl font-semibold tracking-tight tabular-nums caret-accent"
            />
            {/* The count next to the number said what the number already
                says by being looked at (megalist B6); the hint stays. */}
            {len === 0 && (
              <span className="ml-3 text-xs text-fg-dim whitespace-nowrap">
                {t('uin_market.plate.hint')}
              </span>
            )}
          </div>

          <AnimatePresence initial={false}>
            {validLen && localCents != null && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.22, ease: EASE }}
                className="overflow-hidden"
              >
                <div className="mt-4 flex items-center justify-between">
                  {/* ⚠⚠ NOT an AnimatePresence. This line has been INVISIBLE on
                      the live site: nested inside the height-animating parent
                      above, the presence swap stalled at opacity 0 and the
                      replacement never mounted, so the one place that says
                      whether a number is free showed the word it was born with
                      and then faded to nothing. A crossfade is not worth a
                      status line nobody can read. */}
                  <div className="h-6 flex items-center">
                    <div
                      key={availabilityKey}
                      className="flex items-center gap-2 text-sm"
                    >
                      {availabilityKey === 'checking' && (
                        <span className="flex items-center gap-2 text-fg-dim">
                          <Spinner /> {t('uin_market.status.checking')}
                        </span>
                      )}
                      {availabilityKey === 'ok' && (
                        <span className="font-medium text-accent">
                          {forSale ? t('uin_market.status.for_sale') : t('uin_market.status.available')}
                        </span>
                      )}
                      {availabilityKey === 'no' && (
                        <span className="font-medium text-fg-secondary">{reasonText(liveQuote?.reason)}</span>
                      )}
                      {availabilityKey === 'idle' && <span className="text-fg-dim">{t('uin_market.status.idle')}</span>}
                    </div>
                  </div>
                  {/* ⚠ A number you take for NOTHING must not wear a price.
                      The island quotes `price_cents` for ordinary space too —
                      it is the ladder figure, not a charge — so the field said
                      "$1.99" over a number the very next screen hands over
                      free, and the tier list right below said "free" for the
                      same length. One of the two had to stop lying. */}
                  <div className="text-3xl font-semibold tabular-nums tracking-tight">
                    {acquire === 'free' ? t('uin_market.tiers.free') : priceDisplay(localCents)}
                  </div>
                </div>

                <button
                  onClick={() => {
                    if (resumable || canPay) setCheckout(Number(typed))
                    else if (canTake) setConfirming(true)
                  }}
                  disabled={!canTake && !canPay && !resumable}
                  className="mt-4 w-full h-12 rounded-xl text-sm font-semibold bg-accent text-white
                             hover:bg-accent-dim active:scale-[0.99] disabled:bg-fg-primary/[0.06] disabled:text-fg-dim
                             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-dim
                             transition flex items-center justify-center gap-2"
                >
                  {buying || redeeming ? (
                    <>
                      <Spinner light /> {t('uin_market.cta.processing')}
                    </>
                  ) : resumable ? (
                    t('uin_market.cta.resume')
                  ) : forSale ? (
                    t('uin_market.cta.buy', { price: priceDisplay(localCents) })
                  ) : available ? (
                    t('uin_market.cta.take')
                  ) : checking ? (
                    t('uin_market.status.checking')
                  ) : (
                    t('uin_market.cta.unavailable')
                  )}
                </button>

                <AnimatePresence>
                  {error && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="mt-3 text-sm text-red-500 text-center"
                    >
                      {error}
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>
        </section>

        {/* YOUR NUMBERS — the collection, and which one is answering. Hidden
            entirely on an island too old to answer /uin/mine. */}
        {mine && (
          <section className="mt-11">
            <h2 className="text-[0.8125rem] font-semibold uppercase tracking-wider text-fg-secondary mb-3">
              {t('uin_market.mine.label')}
            </h2>

            <div className="rounded-2xl bg-surface dark:bg-field px-5 py-4">
              <div className="text-[0.6875rem] uppercase tracking-wider text-fg-dim">{t('uin_market.mine.active')}</div>
              <div className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">{mine.active}</div>
            </div>

            {mine.owned.length === 0 ? (
              <p className="mt-3 text-sm text-fg-dim">{t('uin_market.mine.empty')}</p>
            ) : (
              <div className="mt-2.5 space-y-2">
                {mine.owned.map((o) => (
                  <div
                    key={o.uin}
                    className="flex items-center justify-between rounded-2xl bg-surface-dim dark:bg-fg-primary/[0.07] px-4 py-3"
                  >
                    <div className="min-w-0">
                      <div className="text-lg font-semibold tracking-tight tabular-nums truncate">{o.uin}</div>
                    </div>
                    <div className="shrink-0 flex items-center gap-2">
                      <button
                        onClick={() => setReleaseTarget(o.uin)}
                        disabled={switching || releasing}
                        className="h-9 px-3 rounded-xl text-sm font-medium text-fg-secondary bg-field
                                   hover:bg-fg-primary/[0.09] active:scale-[0.98] disabled:opacity-40 transition"
                      >
                        {t('uin_market.mine.release')}
                      </button>
                      <button
                        onClick={() => setSwitchTarget(o.uin)}
                        disabled={switching || releasing}
                        className="h-9 px-4 rounded-xl text-sm font-semibold text-accent bg-accent/10
                                   hover:bg-accent/[0.18] active:scale-[0.98] disabled:opacity-40 transition"
                      >
                        {t('uin_market.mine.use')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <p className="mt-3 text-xs text-fg-dim">{t('uin_market.mine.note')}</p>
          </section>
        )}

        {/* AVAILABLE NOW — discovery from the live suggestions endpoint. */}
        <section className="mt-11">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[0.8125rem] font-semibold uppercase tracking-wider text-fg-secondary">
              {t('uin_market.suggest.label')}
            </h2>
            <button
              onClick={() => void loadSuggestions()}
              disabled={loadingSuggestions}
              className="grid place-items-center h-8 w-8 rounded-full text-fg-secondary hover:text-fg-primary hover:bg-fg-primary/[0.06] active:scale-95 disabled:opacity-40 transition"
              aria-label={t('uin_market.suggest.refresh')}
              title={t('uin_market.suggest.refresh')}
            >
              <RefreshIcon spinning={loadingSuggestions} />
            </button>
          </div>

          {loadingSuggestions && suggestions.length === 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-[74px] rounded-2xl bg-surface dark:bg-field animate-pulse" />
              ))}
            </div>
          ) : suggestions.length === 0 ? (
            <p className="text-sm text-fg-dim">{t('uin_market.suggest.empty')}</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              {suggestions.map((s) => (
                <button
                  key={s.uin}
                  onClick={() => pick(s.uin)}
                  className="rounded-2xl p-3.5 text-left bg-surface dark:bg-field hover:bg-field dark:hover:bg-line
                             active:scale-[0.98] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  <div className="text-lg font-semibold tracking-tight truncate">{s.uin}</div>
                  <div className="mt-1 text-xs">
                    {/* ⚠ Every number the island suggests is ordinary space,
                        which is free: the endpoint skips the scarce stock on
                        purpose. Printing its price-by-length here was quoting
                        a figure nobody is ever charged. */}
                    <span className="text-fg-secondary">{t('uin_market.tiers.free')}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* PRICING — clean list, the active length quietly highlighted. */}
        <section className="mt-11">
          <h2 className="text-[0.8125rem] font-semibold uppercase tracking-wider text-fg-secondary mb-1.5">
            {t('uin_market.tiers.label')}
          </h2>
          <div>
            {TIER_LENGTHS.map((d) => {
              const active = validLen && len === d
              return (
                <div key={d} className="relative flex items-center justify-between py-2.5 px-3 -mx-3 rounded-xl">
                  {active && (
                    <motion.div layoutId="tierHL" transition={SPRING} className="absolute inset-0 rounded-xl bg-accent/[0.08]" />
                  )}
                  <span className={'relative text-sm transition-colors ' + (active ? 'font-semibold text-accent' : 'text-fg-secondary')}>
                    {t(`uin_market.tiers.len${d}`)}
                  </span>
                  <span className={'relative text-sm tabular-nums transition-colors ' + (active ? 'font-semibold text-accent' : 'text-fg-primary')}>
                    {/* Three digits are not on sale (founder, 03.09). There are 761 of
                        them left in the whole network and no more are ever made, so
                        they are given by hand rather than priced. Saying so is worth a
                        row; hiding the row would only move the question. */}
                    {d === 3
                      ? t('uin_market.tiers.reserved')
                      : d >= 7
                        // ⚠ Ordinary space is free, so a price here would be a
                        // lie for almost every number of this length. The
                        // patterned ones that DO cost money say so in the
                        // field, where a real number has been typed.
                        ? t('uin_market.tiers.free')
                        : priceDisplay(PRICE_CENTS_BY_LENGTH[d])}
                  </span>
                </div>
              )
            })}
          </div>
          <p className="text-xs text-fg-dim mt-2 px-3">{t('uin_market.tiers.note')}</p>
        </section>

        {/* FOUNDATION — the UIN economy scaffolding, designed (not stubbed). */}
        <section className="mt-12 space-y-3">
          <FoundationCard
            soon={t('uin_market.soon')}
            title={t('uin_market.p2p.title')}
            body={t('uin_market.p2p.body')}
            icon={<P2PIcon />}
          >
          </FoundationCard>

          <FoundationCard
            title={t('uin_market.crypto.title')}
            body={t('uin_market.crypto.body')}
            icon={<CoinIcon />}
          >
            <div className="mt-4 flex flex-wrap gap-2">
              {/* ⚠ Only what an island can actually SEE arriving. Monero cannot be
                  watched without a private view key and a wallet scanning the
                  chain, so no explorer can answer for it; Bitcoin's fee and its
                  twenty-minute wait eat a fifteen-dollar sale; Ethereum's gas
                  does the same. Drawing a coin here is a promise. */}
              {[
                { id: 'tron', name: 'USDT · TRON' },
                { id: 'ton', name: 'TON' },
              ].map((m) => (
                <span
                  key={m.id}
                  className="flex items-center gap-1.5 rounded-lg bg-surface dark:bg-fg-primary/[0.06] px-2 py-1 text-xs font-semibold text-fg-secondary"
                >
                  <ChainMark chain={m.id} className="h-4 w-4" />
                  {m.name}
                </span>
              ))}
            </div>
          </FoundationCard>
        </section>

        {/* What a UIN is + what buying does. */}
        <section className="mt-11 space-y-4">
          <InfoRow title={t('uin_market.info.what.title')} body={t('uin_market.info.what.body')} />
          <InfoRow title={t('uin_market.info.migrate.title')} body={t('uin_market.info.migrate.body')} />
        </section>
      </main>

      {/* Paying for a scarce number. The sheet knows nothing about the island;
          it hands back a signed voucher and this page redeems it. */}
      <AnimatePresence>
        {checkout != null && (
          <UinCheckout
            uin={checkout}
            priceDisplay={priceDisplay(localCents ?? 0)}
            /// Straight from the quote for THIS number on THIS island — never
            /// a default. See the note on the prop.
            checkoutUrl={liveQuote?.checkout_url}
            resumeId={resumable?.id}
            onPaid={(voucher, invoiceId) => void doRedeem(checkout, voucher, invoiceId)}
            onClose={() => {
              setCheckout(null)
              setOpenInvoices(listInvoices())
            }}
          />
        )}
      </AnimatePresence>

      {/* Confirm — modal enters with weight, neutral surface, solid CTA. */}
      <AnimatePresence>
        {confirming && liveQuote?.available && localCents != null && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xl"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => !buying && setConfirming(false)}
          >
            <motion.div
              initial={{ opacity: 0, y: 16, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 16, scale: 0.97 }}
              transition={SPRING}
              className="w-full max-w-sm rounded-3xl bg-surface p-6 shadow-[0_24px_70px_-20px_rgba(0,0,0,0.4)]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-center">
                <div className="text-4xl font-bold tracking-tight">{typed}</div>
                {/* ⚠ This dialog only ever confirms a FREE take now - anything
                    with a price goes through the checkout sheet - so printing
                    the price-by-length here was quoting a figure nobody pays. */}
                <div className="mt-1 text-fg-secondary">{t('uin_market.tiers.free')}</div>
              </div>
              <p className="mt-4 text-sm text-fg-secondary leading-relaxed text-center">{t('uin_market.confirm.body')}</p>
              <div className="mt-6 flex gap-2.5">
                <button
                  onClick={() => setConfirming(false)}
                  disabled={buying}
                  className="flex-1 h-11 rounded-xl text-sm font-medium text-fg-secondary bg-surface dark:bg-field hover:bg-field dark:hover:bg-line active:scale-[0.99] transition"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={() => void doPurchase()}
                  disabled={buying}
                  className="flex-1 h-11 rounded-xl text-sm font-semibold text-white bg-accent hover:bg-accent-dim active:scale-[0.99] transition flex items-center justify-center gap-2"
                >
                  {buying ? <Spinner light /> : t('uin_market.confirm.cta')}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* It is yours — the offer to move onto it now. "Later" leaves the
          account exactly as it was and the number safely held. */}
      <AnimatePresence>
        {held != null && (
          <Modal
            onDismiss={() => {
              if (switching) return
              setHeld(null)
              setTyped('')
            }}
          >
            <div className="text-center">
              <div className="text-4xl font-bold tracking-tight">{held}</div>
            </div>
            <p className="mt-4 text-sm text-fg-secondary leading-relaxed text-center">
              {t('uin_market.held.body', { prev: `${id.uin}` })}
            </p>
            <div className="mt-6 flex gap-2.5">
              <button
                onClick={() => {
                  setHeld(null)
                  setTyped('')
                }}
                disabled={switching}
                className="flex-1 h-11 rounded-xl text-sm font-medium text-fg-secondary bg-surface dark:bg-field hover:bg-field dark:hover:bg-line active:scale-[0.99] transition"
              >
                {t('uin_market.held.later')}
              </button>
              <button
                onClick={() => void doSwitch(held)}
                disabled={switching}
                className="flex-1 h-11 rounded-xl text-sm font-semibold text-white bg-accent hover:bg-accent-dim active:scale-[0.99] transition flex items-center justify-center gap-2"
              >
                {switching ? <Spinner light /> : t('uin_market.held.now')}
              </button>
            </div>
          </Modal>
        )}
      </AnimatePresence>

      {/* Switch — names the number being left, because it is the one everybody
          currently knows this account by. */}
      <AnimatePresence>
        {releaseTarget != null && (
          <Modal onDismiss={() => !releasing && setReleaseTarget(null)}>
            <div className="text-center">
              <div className="text-4xl font-bold tracking-tight">{releaseTarget}</div>
            </div>
            <p className="mt-4 text-sm text-fg-secondary leading-relaxed text-center">
              {t('uin_market.mine.release.confirm.body')}
            </p>
            <div className="mt-6 flex gap-2.5">
              <button
                onClick={() => setReleaseTarget(null)}
                disabled={releasing}
                className="flex-1 h-11 rounded-xl text-sm font-medium text-fg-secondary bg-surface dark:bg-field hover:bg-field dark:hover:bg-line active:scale-[0.99] transition"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => void doRelease(releaseTarget)}
                disabled={releasing}
                className="flex-1 h-11 rounded-xl text-sm font-semibold text-white bg-red-500 hover:bg-red-600 active:scale-[0.99] transition flex items-center justify-center gap-2"
              >
                {releasing ? <Spinner light /> : t('uin_market.mine.release.confirm.cta')}
              </button>
            </div>
          </Modal>
        )}
        {switchTarget != null && (
          <Modal onDismiss={() => !switching && setSwitchTarget(null)}>
            <div className="text-center">
              <div className="text-4xl font-bold tracking-tight">{switchTarget}</div>
            </div>
            <p className="mt-4 text-sm text-fg-secondary leading-relaxed text-center">
              {t('uin_market.mine.confirm.body', { prev: `${mine?.active ?? id.uin}` })}
            </p>
            <div className="mt-6 flex gap-2.5">
              <button
                onClick={() => setSwitchTarget(null)}
                disabled={switching}
                className="flex-1 h-11 rounded-xl text-sm font-medium text-fg-secondary bg-surface dark:bg-field hover:bg-field dark:hover:bg-line active:scale-[0.99] transition"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => void doSwitch(switchTarget)}
                disabled={switching}
                className="flex-1 h-11 rounded-xl text-sm font-semibold text-white bg-accent hover:bg-accent-dim active:scale-[0.99] transition flex items-center justify-center gap-2"
              >
                {switching ? <Spinner light /> : t('uin_market.mine.confirm.cta')}
              </button>
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  )
}

/// The page's one modal shell: dimmed backdrop, weighted entrance, neutral
/// surface. Both UIN dialogs use it so they cannot drift apart.
function Modal({ onDismiss, children }: { onDismiss: () => void; children: ReactNode }) {
  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xl"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onDismiss}
    >
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 16, scale: 0.97 }}
        transition={SPRING}
        className="w-full max-w-sm rounded-3xl bg-surface p-6 shadow-[0_24px_70px_-20px_rgba(0,0,0,0.4)]"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </motion.div>
    </motion.div>
  )
}

function FoundationCard({
  soon,
  title,
  body,
  icon,
  children,
}: {
  /// The "soon" pill. ⚠ Optional since 03.09: crypto checkout stopped being a
  /// promise, and a card that says SOON above a working payment sheet is worse
  /// than no card at all.
  soon?: string
  title: string
  body: string
  icon: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="rounded-3xl bg-surface dark:bg-field p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="grid place-items-center h-9 w-9 rounded-xl bg-surface-dim dark:bg-fg-primary/[0.09] text-fg-secondary shrink-0">
            {icon}
          </span>
          <h3 className="text-[0.9375rem] font-semibold tracking-tight truncate">{title}</h3>
        </div>
        {soon && (
          <span className="shrink-0 rounded-full bg-fg-primary/[0.06] px-2.5 py-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-fg-dim">
            {soon}
          </span>
        )}
      </div>
      <p className="mt-2.5 text-sm text-fg-secondary leading-relaxed">{body}</p>
      {children}
    </div>
  )
}

function InfoRow({ title, body }: { title: string; body: string }) {
  return (
    <div className="space-y-1">
      <div className="text-[0.8125rem] font-semibold text-fg-primary">{title}</div>
      <div className="text-[0.8125rem] text-fg-secondary leading-relaxed">{body}</div>
    </div>
  )
}

function Spinner({ light = false }: { light?: boolean }) {
  return (
    <svg className="animate-spin" width="15" height="15" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke={light ? 'rgba(255,255,255,0.4)' : 'currentColor'} strokeWidth="3" opacity="0.3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke={light ? '#fff' : 'currentColor'} strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg
      className={spinning ? 'animate-spin' : ''}
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  )
}

function BackIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  )
}

function P2PIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 8h11l-2.5-2.5M17 16H6l2.5 2.5" />
    </svg>
  )
}

function CoinIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v8M9.5 10c0-1 1.1-1.6 2.5-1.6s2.5.6 2.5 1.6-1.1 1.5-2.5 1.5-2.5.6-2.5 1.6 1.1 1.6 2.5 1.6 2.5-.6 2.5-1.6" />
    </svg>
  )
}

function CheckCircle() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="shrink-0">
      <circle cx="12" cy="12" r="11" className="fill-accent/20" />
      <path d="M17 9l-6 6-3-3" stroke="rgb(var(--c-accent))" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Residency on the island section of Settings, beside the invites it pays
// for (founder item 5, 12.09).
//
// Three states and only two of them draw. A resident sees the date they
// became one and nothing to click: the fact is the whole row. Somebody who
// is not, on an island that sells entry (`entry_price_cents > 0`), sees the
// price and a block that opens in place: the island's own checkout when it
// names a till (EntryCheckout), else a link to its page, and always a field
// for a code somebody already holds, because until now an entry voucher was
// accepted by registration alone and a person already here for free had no
// door to residency short of a second account. Everybody else, which is
// everybody on an open island, gets no row: an offer that cannot be taken up
// is a question, not a setting.
//
// Opened IN PLACE rather than in a sheet, like the house rules below it: both
// bars of this app carry a backdrop-filter, and a `fixed` overlay inside them
// is how that trap gets sprung. The checkout itself is a portal-free fixed
// sheet mounted from here, the same way the number shop mounts its own.
//
// `resident_since` is the answer and the mark is the fallback, for an island
// that grants residency (a voucher at registration, the admin panel) but is
// older than the field. The mark is granted server-side on redeem; `onChanged`
// re-reads the own profile and the invites counter so both change at once.

import { useEffect, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { Api, ApiError, parseErrorCode, type UserInfo } from '../lib/api'
import type { WebIdentity } from '../lib/crypto'
import { useI18n } from '../lib/i18n-context'
import { formatUsd, type ServerCapabilities } from '../lib/server-info'
import { Till, forgetEntryInvoice, listEntryInvoices } from '../lib/till'
import { EntryCheckout } from './EntryCheckout'

export function ResidencyRow({
  identity,
  me,
  caps,
  islandName,
  host,
  onChanged,
}: {
  identity: WebIdentity | null
  me: UserInfo | null
  caps: ServerCapabilities
  islandName: string | null
  /// The island's hostname, `host[:port]`.
  host: string
  /// Residency was bought or a stale row was corrected: re-read the profile.
  onChanged: () => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [checkout, setCheckout] = useState<{ resumeId?: string } | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const resident =
    !!me?.resident_since || me?.badge === 'resident' || (me?.badges_earned ?? []).includes('resident')
  const cents = caps.entry_price_cents
  const tillUrl = caps.till_url
  const entryUrl = (caps.entry_url || '').trim()
  const buyLink = !tillUrl && /^https:\/\//i.test(entryUrl) ? entryUrl : ''

  async function redeem(voucher: string, invoiceId?: string) {
    if (!identity) return
    setBusy(true)
    setError(null)
    try {
      await Api.redeemResidency(identity, voucher.trim())
      if (invoiceId) forgetEntryInvoice(invoiceId)
      setDone(true)
      setOpen(false)
      setCheckout(null)
      onChanged()
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0
      const c = e instanceof ApiError ? parseErrorCode(e.body) : null
      if (status < 400 || status >= 500) setError(t('residency.error'))
      else if (c === 'already_resident') {
        // Refused BEFORE the voucher is touched, so the code is still good:
        // this row was simply stale, and re-reading fixes it.
        setError(t('residency.already'))
        onChanged()
      } else if (c === 'voucher_spent') setError(t('residency.code_spent'))
      else if (c === 'sales_disabled') setError(t('residency.not_sold'))
      else setError(t('residency.invalid'))
      // A code that came from a paid invoice must not vanish with the sheet:
      // the person can read it and try again.
      if (invoiceId) setCode(voucher)
    } finally {
      setBusy(false)
    }
  }

  // A payment that landed while nobody was looking: an entry invoice this
  // browser opened for THIS island, paid after the tab was closed. Redeemed
  // here rather than by the create form, because the person is signed in.
  useEffect(() => {
    if (!identity || resident || !tillUrl) return
    let dead = false
    void (async () => {
      for (const stored of listEntryInvoices()) {
        if (dead) return
        if (stored.host.toLowerCase() !== host.toLowerCase()) continue
        try {
          const inv = await Till.entryInvoice(stored.id, stored.tillUrl || tillUrl)
          if (dead) return
          if (inv.status === 'paid' && inv.voucher) {
            await redeem(inv.voucher, inv.id)
            return
          }
          if (inv.status === 'expired') forgetEntryInvoice(inv.id)
        } catch {
          /* a till we cannot reach today is one we ask again tomorrow */
        }
      }
    })()
    return () => {
      dead = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.uin, identity?.apiBase, resident, tillUrl])

  if (!identity || !me) return null

  if (resident) {
    const since = me.resident_since ? new Date(me.resident_since) : null
    const line =
      since && !Number.isNaN(since.getTime())
        ? t('residency.since', { date: since.toLocaleDateString() })
        : t('badge.resident')
    return (
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">{line}</span>
        <span className="text-accent text-sm" aria-hidden>✓</span>
      </div>
    )
  }

  if (!(cents > 0) && !done) return null

  const price = formatUsd(cents)
  // An open invoice for this island: the button resumes it instead of
  // writing a second one.
  const pending = listEntryInvoices().find((s) => s.host.toLowerCase() === host.toLowerCase())

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-3 text-left"
      >
        <span className="text-sm">{t('residency.title')}</span>
        <span className="text-sm text-fg-secondary">{t('island.entry.price', { price })}</span>
      </button>
      {open && (
        <div className="space-y-2">
          <p className="text-xs text-fg-dim leading-relaxed">{t('residency.body')}</p>
          {tillUrl ? (
            <button
              type="button"
              onClick={() => setCheckout({ resumeId: pending?.id })}
              className="h-9 px-4 rounded-md bg-accent hover:bg-accent-dim text-white text-xs font-semibold transition-colors"
            >
              {t('residency.buy', { price })}
            </button>
          ) : buyLink ? (
            <a
              href={buyLink}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-block text-xs text-accent hover:underline"
            >
              {t('residency.buy_on', { host: buyLink.replace(/^https:\/\//i, '').split('/')[0] })}
            </a>
          ) : null}
          <div className="space-y-1 pt-1">
            <label className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
              {t('residency.have_code')}
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.slice(0, 4096))
                  setError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && code.trim() && !busy) void redeem(code)
                }}
                placeholder={t('login.create.invite')}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                className="flex-1 min-w-0 h-9 px-3 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm font-mono"
              />
              <button
                type="button"
                onClick={() => code.trim() && !busy && void redeem(code)}
                disabled={!code.trim() || busy}
                className="h-9 px-3 rounded-md bg-accent text-white text-xs font-semibold disabled:opacity-40"
              >
                {busy ? t('residency.redeeming') : t('residency.redeem')}
              </button>
            </div>
            {error && <p className="text-xs text-red-500 leading-relaxed">{error}</p>}
          </div>
        </div>
      )}
      {done && <p className="text-xs text-accent">{t('residency.done')}</p>}
      <AnimatePresence>
        {checkout && (
          <EntryCheckout
            host={host}
            islandName={islandName ?? ''}
            priceDisplay={t('island.entry.price', { price })}
            tillUrl={tillUrl}
            termsUrl={caps.terms_url}
            resumeId={checkout.resumeId}
            onPaid={(voucher, id) => void redeem(voucher, id)}
            onClose={() => setCheckout(null)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

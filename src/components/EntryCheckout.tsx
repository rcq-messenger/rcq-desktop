// Paying for ENTRY (residency) to an island, in one sheet: the number
// checkout (UinCheckout) with the island where the number was.
//
// ⚠⚠ THE TILL IS THE ISLAND'S OWN, named on its /server/info as `till_url`,
// and this sheet is never drawn for an island that names none. There is no
// built-in fallback: the flagship's till compiled in would take a
// self-hoster's customer's money for an account on somebody else's island,
// and a Worker has no refund path. The price and the wallet on the invoice
// are the island's too: the till asks the island for both, per invoice, so
// what the picker quoted is what is charged and the money lands with the
// operator who is selling.
//
// Under the pay controls, every time: who is selling and what can be given
// back. On the flagship the seller is the RCQ team and the policy is at
// rcq.app/terms#refunds; on a self-hosted island the OPERATOR is the seller,
// their `terms_url` is linked when they set one, and when they did not the
// sheet says refunds are their decision. Never rcq.app's terms for somebody
// else's sale.
//
// What this sheet does NOT do: it never touches the island, never sees a
// token, and never redeems anything. It hands its caller the signed access
// code and stops; the create form pastes it into the code box, the residency
// row in Settings spends it on the account that is already here.

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import QRCode from 'qrcode'
import { Till, TillError, rememberEntryInvoice, forgetEntryInvoice, listEntryInvoices, type EntryInvoice } from '../lib/till'
import { useI18n } from '../lib/i18n-context'
import { formatUsd } from '../lib/server-info'
import { CoinIcon } from './CoinIcons'

const SPRING = { type: 'spring' as const, stiffness: 420, damping: 34 }
const POLL_MS = 6000

function payUri(chain: string, address: string, amount: string): string {
  if (chain === 'ton') return `ton://transfer/${address}?amount=${Math.round(Number(amount) * 1e9)}`
  return address
}

function Spinner() {
  return (
    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent text-fg-dim" />
  )
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1600)
          },
          () => {},
        )
      }}
      className="w-full text-left rounded-xl bg-surface dark:bg-field px-3.5 py-3 transition
                 hover:bg-field dark:hover:bg-line active:scale-[0.995]"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-fg-dim">{label}</span>
        <span className="text-xs font-medium text-accent">
          {copied ? t('uin_checkout.copied') : t('uin_checkout.copy')}
        </span>
      </div>
      <div className="mt-1 break-all text-sm font-mono tabular-nums">{value}</div>
    </button>
  )
}

export function EntryCheckout({
  host,
  islandName,
  priceDisplay,
  tillUrl,
  termsUrl,
  resumeId,
  onPaid,
  onClose,
}: {
  /// The island's hostname, the string the till sells entry BY and the one
  /// inside the voucher it signs.
  host: string
  islandName: string
  priceDisplay: string
  /// `capabilities.till_url`, required: see the file comment.
  tillUrl: string
  /// `capabilities.terms_url`, '' when the operator set none.
  termsUrl: string
  /// An invoice this browser already opened for this island, so a reload
  /// mid-payment does not offer a second one.
  resumeId?: string
  /// Called ONCE with the signed access code. The caller redeems it.
  onPaid: (voucher: string, invoiceId: string) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [chains, setChains] = useState<{ id: string; label: string }[]>([])
  const [invoice, setInvoice] = useState<EntryInvoice | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [left, setLeft] = useState<number>(0)
  /// What the till quoted for this island a moment ago, in cents. The caller's
  /// `priceDisplay` is built from /server/info, read once for the run, so an
  /// operator who edits the price mid-session leaves it showing the old one.
  const [quotedCents, setQuotedCents] = useState<number | null>(null)
  /// The stored invoice id came back from its own till as "no such invoice".
  /// Set only by the resume effect below, and only for that answer.
  const [resumeGone, setResumeGone] = useState(false)
  /// ⚠⚠ WHICH TILL THIS INVOICE LIVES AT, which is not always the island's
  /// current one. An invoice id only exists at the till that wrote it, and the
  /// row carries that address (`rcq.web.entry.invoices`); an operator who
  /// changes `uin_till_url` between paying and coming back would otherwise
  /// have us ask the NEW till about an id it never issued, get "no such
  /// invoice", and drop a row that still has money behind it. A fresh invoice
  /// is written at the island's current till, so the default is that.
  const [invoiceTill, setInvoiceTill] = useState(
    () => (resumeId ? listEntryInvoices().find((r) => r.id === resumeId)?.tillUrl : '') || tillUrl,
  )
  const handed = useRef(false)
  const flagship = host.toLowerCase() === 'api.rcq.app'

  useEffect(() => {
    if (!resumeId || resumeGone) return
    let dead = false
    Till.entryInvoice(resumeId, invoiceTill).then(
      (inv) => {
        if (dead) return
        setInvoice(inv)
        if (inv.status === 'paid' && inv.voucher && !handed.current) {
          handed.current = true
          onPaid(inv.voucher, inv.id)
          return
        }
        void QRCode.toDataURL(payUri(inv.chain, inv.address, inv.amount), {
          margin: 1, width: 320, color: { dark: '#000000', light: '#FFFFFF' },
        }).then((url) => !dead && setQr(url), () => {})
      },
      (e) => {
        if (dead) return
        // ⚠ A till that ANSWERS "no such invoice" is final, and the stored row
        // goes with it: an operator who rebuilt their till on an empty
        // database turns every id this browser kept into a 404, and a row left
        // behind then blocks the resume path forever, so this island could
        // never be paid from this browser again. Anything else keeps the id,
        // `http_404` included: that one is a 404 whose body was NOT the till's
        // own answer (a CDN page, a proxy mid-deploy, a route not up yet), and
        // those heal, while the money behind the row does not come back.
        if (e instanceof TillError && e.code === 'not_found') {
          forgetEntryInvoice(resumeId)
          setResumeGone(true)
          return
        }
        setError(t('uin_checkout.error.unreachable'))
      },
    )
    return () => {
      dead = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeId, resumeGone, invoiceTill])

  useEffect(() => {
    let dead = false
    if (resumeId && !resumeGone) return
    Till.entryQuote(host, tillUrl).then(
      (q) => {
        if (dead) return
        // The ISLAND's answer, through its till: a price of zero is "not on
        // sale", whatever the picker said a minute ago.
        if (!(q.price_cents > 0) || q.chains.length === 0) setError(t('entry_checkout.not_for_sale'))
        // And when it is on sale, this is the figure the invoice will carry.
        else setQuotedCents(q.price_cents)
        setChains(q.chains.map((c) => ({ id: c.id, label: c.label })))
      },
      () => !dead && setError(t('uin_checkout.error.unreachable')),
    )
    return () => {
      dead = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, tillUrl, resumeGone])

  const open = useCallback(
    async (chain: string) => {
      setBusy(true)
      setError(null)
      try {
        const inv = await Till.createEntryInvoice(host, chain, tillUrl)
        // Stored BEFORE anything else can fail: an invoice we cannot find
        // again is money that cannot be accounted for.
        rememberEntryInvoice(inv, tillUrl)
        setInvoiceTill(tillUrl)
        setInvoice(inv)
        setQr(
          await QRCode.toDataURL(payUri(inv.chain, inv.address, inv.amount), {
            margin: 1, width: 320, color: { dark: '#000000', light: '#FFFFFF' },
          }).catch(() => ''),
        )
      } catch (e) {
        const code = e instanceof TillError ? e.code : 'generic'
        setError(
          code === 'till_unreachable'
            ? t('uin_checkout.error.unreachable')
            : code === 'entry_not_for_sale' || code === 'bad_host' || code === 'island_no_wallet'
              ? t('entry_checkout.not_for_sale')
              : code === 'too_busy'
                ? t('uin_checkout.error.busy')
                : t('uin_checkout.error.generic'),
        )
      } finally {
        setBusy(false)
      }
    },
    [host, tillUrl, t],
  )

  // Poll while an invoice is open; the voucher is handed up exactly once.
  useEffect(() => {
    if (!invoice || invoice.status === 'paid') return
    let dead = false
    const tick = async () => {
      try {
        const fresh = await Till.entryInvoice(invoice.id, invoiceTill)
        if (dead) return
        setInvoice(fresh)
        if (fresh.status === 'paid' && fresh.voucher && !handed.current) {
          handed.current = true
          onPaid(fresh.voucher, fresh.id)
        }
      } catch {
        /* a poll that fails is a poll we repeat */
      }
    }
    const h = setInterval(() => void tick(), POLL_MS)
    return () => {
      dead = true
      clearInterval(h)
    }
  }, [invoice, onPaid, invoiceTill])

  useEffect(() => {
    if (!invoice) return
    const tick = () => setLeft(Math.max(0, invoice.expires_at - Math.floor(Date.now() / 1000)))
    tick()
    const h = setInterval(tick, 1000)
    return () => clearInterval(h)
  }, [invoice])

  const mm = String(Math.floor(left / 60)).padStart(2, '0')
  const ss = String(left % 60).padStart(2, '0')

  // What is actually being charged, and never the caller's cached figure once
  // the till has spoken: the invoice's own dollars first (the till asked the
  // island for them when it wrote the invoice), then the live quote. The
  // caller's string holds the place only until one of the two arrives.
  // Without this a price edited mid-session was read in dollars off
  // /server/info and paid in crypto at the new one, with nothing on screen
  // saying so.
  const chargedCents = invoice ? Math.round(invoice.usd * 100) : quotedCents

  // Who sells and what comes back, beside every control that takes money.
  const legal = (
    <div className="mt-4 space-y-1 text-[0.6875rem] text-fg-dim leading-relaxed text-center">
      <p>
        {flagship
          ? t('entry_checkout.seller_rcq')
          : t('entry_checkout.seller_operator', { island: islandName || host, host })}
      </p>
      <p>
        {t('entry_checkout.refund')}{' '}
        {termsUrl ? (
          <a href={termsUrl} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
            {t('entry_checkout.refund_link')}
          </a>
        ) : (
          t('entry_checkout.refund_operator')
        )}
      </p>
    </div>
  )

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xl"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={() => !busy && onClose()}
    >
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 16, scale: 0.97 }}
        transition={SPRING}
        className="w-full max-w-sm max-h-[88vh] overflow-y-auto rounded-3xl bg-surface p-6
                   shadow-[0_24px_70px_-20px_rgba(0,0,0,0.4)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-center">
          <div className="text-lg font-semibold tracking-tight">{t('entry_checkout.title', { island: islandName || host })}</div>
          <div className="text-xs text-fg-dim">{host}</div>
          <div className="mt-2 text-2xl font-bold tabular-nums">
            {chargedCents != null
              ? t('island.entry.price', { price: formatUsd(chargedCents) })
              : priceDisplay}
          </div>
        </div>

        {/* No AnimatePresence around these three: see UinCheckout. */}
        <div>
          {!invoice ? (
            <motion.div key="pick" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <p className="mt-4 text-sm text-fg-secondary leading-relaxed text-center">
                {t('uin_checkout.pick.body')}
              </p>
              <div className="mt-5 space-y-2.5">
                {chains.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => void open(c.id)}
                    disabled={busy}
                    className="w-full h-12 rounded-xl text-sm font-semibold bg-surface dark:bg-field
                               hover:bg-field dark:hover:bg-line active:scale-[0.99] transition
                               flex items-center justify-center gap-2.5 disabled:opacity-50"
                  >
                    <CoinIcon chain={c.id} className="h-6 w-6 shrink-0" />
                    {c.label}
                  </button>
                ))}
                {busy && (
                  <div className="flex justify-center pt-1">
                    <Spinner />
                  </div>
                )}
              </div>
              {legal}
            </motion.div>
          ) : invoice.status === 'paid' ? (
            <motion.div key="paid" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-6 text-center">
              <p className="text-sm text-fg-secondary">{t('entry_checkout.paid')}</p>
            </motion.div>
          ) : (
            <motion.div key="pay" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <p className="mt-4 text-sm text-fg-secondary leading-relaxed text-center">
                {t('uin_checkout.pay.body', { chain: invoice.chain_label })}
              </p>
              {qr && (
                <div className="mt-4 flex justify-center">
                  <img src={qr} alt="" className="h-40 w-40 rounded-xl" style={{ imageRendering: 'pixelated' }} />
                </div>
              )}
              <div className="mt-4 space-y-2">
                <CopyRow label={t('uin_checkout.amount')} value={invoice.amount} />
                <CopyRow label={t('uin_checkout.address')} value={invoice.address} />
              </div>
              <div className="mt-4 flex items-center justify-center gap-2 text-sm text-fg-dim">
                {left > 0 ? (
                  <>
                    <Spinner />
                    <span className="tabular-nums">{t('uin_checkout.waiting', { time: `${mm}:${ss}` })}</span>
                  </>
                ) : (
                  <span>{t('uin_checkout.expired')}</span>
                )}
              </div>
              <p className="mt-3 text-xs text-fg-dim leading-relaxed text-center">{t('uin_checkout.exact')}</p>
              {legal}
            </motion.div>
          )}
        </div>

        {error && <div className="mt-4 text-sm text-red-500 text-center">{error}</div>}

        <button
          onClick={() => {
            if (invoice && invoice.status !== 'paid' && left <= 0) forgetEntryInvoice(invoice.id)
            onClose()
          }}
          disabled={busy}
          className="mt-6 w-full h-11 rounded-xl text-sm font-medium text-fg-secondary
                     bg-surface dark:bg-field hover:bg-field dark:hover:bg-line active:scale-[0.99] transition"
        >
          {invoice && invoice.status !== 'paid' ? t('uin_checkout.later') : t('common.cancel')}
        </button>
      </motion.div>
    </motion.div>
  )
}

// Paying for a number, in one sheet.
//
// The shape of it follows what the money actually needs: pick a chain, send an
// EXACT amount to an address, wait. There is no account to create, no card
// form, no redirect to a processor, and nothing to sign in to — the amount is
// what identifies the payment, so the whole checkout is two values and a
// clock.
//
// ⚠ The exact amount is the entire mechanism. Every open invoice gets its own
// tail, so a transfer carrying it can only be this one. A rounded amount is a
// payment nobody can attribute, which is why the figure is presented as a
// thing to copy rather than a thing to read.
//
// What this component does NOT do: it never touches the island, never sees a
// token, and never redeems anything. It hands its caller a signed voucher and
// stops.

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import QRCode from 'qrcode'
import { Till, TillError, rememberInvoice, forgetInvoice, type UinInvoice } from '../lib/till'
import { useI18n } from '../lib/i18n-context'
import { CoinIcon } from './CoinIcons'

const SPRING = { type: 'spring' as const, stiffness: 420, damping: 34 }

/// How often we ask whether the money has landed. The chains we take confirm
/// in seconds (TON) or about a minute (TRON), and the till's own watcher runs
/// once a minute, so anything faster is asking a question that cannot have
/// changed.
const POLL_MS = 6000

/// Wallets read `ton://` and `tron:` links; a plain address in the QR is what
/// every wallet understands when it does not. ⚠ The amount goes in the link
/// where the scheme has a place for it, and is ALSO always shown as text: a
/// wallet that ignores the parameter would otherwise send the wrong figure and
/// the payment would match nothing.
function payUri(chain: string, address: string, amount: string): string {
  if (chain === 'ton') return `ton://transfer/${address}?amount=${Math.round(Number(amount) * 1e9)}`
  return address
}

function Spinner({ light = false }: { light?: boolean }) {
  return (
    <span
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent ${
        light ? 'text-white/90' : 'text-fg-dim'
      }`}
    />
  )
}

function CopyRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
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
      <div className={`mt-1 break-all text-sm ${mono ? 'font-mono tabular-nums' : ''}`}>{value}</div>
    </button>
  )
}

export function UinCheckout({
  uin,
  priceDisplay,
  resumeId,
  onPaid,
  onClose,
}: {
  uin: number
  priceDisplay: string
  /// An invoice this browser already opened for this number. ⚠ Passing it is
  /// what stops a reload from stranding somebody mid-payment: without it the
  /// sheet would offer to create a second invoice for a number the first one
  /// is holding, and the till would answer "taken" - by its own reservation.
  resumeId?: string
  /// Called with the signed voucher. The caller redeems it; this sheet has no
  /// idea what an island is.
  onPaid: (voucher: string, invoiceId: string) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [chains, setChains] = useState<{ id: string; label: string }[]>([])
  const [invoice, setInvoice] = useState<UinInvoice | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [left, setLeft] = useState<number>(0)
  const handed = useRef(false)

  // Pick up where the last visit left off.
  useEffect(() => {
    if (!resumeId) return
    let dead = false
    Till.invoice(resumeId).then(
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
      () => !dead && setError(t('uin_checkout.error.unreachable')),
    )
    return () => {
      dead = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeId])

  useEffect(() => {
    let dead = false
    if (resumeId) return
    Till.prices().then(
      (p) => !dead && setChains(p.chains.map((c) => ({ id: c.id, label: c.label }))),
      // A till that cannot be reached is worth saying out loud rather than
      // showing an empty row of buttons.
      () => !dead && setError(t('uin_checkout.error.unreachable')),
    )
    return () => {
      dead = true
    }
  }, [t])

  const open = useCallback(
    async (chain: string) => {
      setBusy(true)
      setError(null)
      try {
        const inv = await Till.createInvoice(uin, chain)
        // Stored BEFORE anything else can fail: an invoice we cannot find
        // again is money that cannot be accounted for.
        rememberInvoice(inv)
        setInvoice(inv)
        setQr(
          await QRCode.toDataURL(payUri(inv.chain, inv.address, inv.amount), {
            margin: 1,
            width: 320,
            color: { dark: '#000000', light: '#FFFFFF' },
          }).catch(() => ''),
        )
      } catch (e) {
        const code = e instanceof TillError ? e.code : 'generic'
        setError(
          code === 'uin_taken'
            ? t('uin_checkout.error.taken')
            : code === 'till_unreachable'
              ? t('uin_checkout.error.unreachable')
              : code === 'too_busy'
                ? t('uin_checkout.error.busy')
                : t('uin_checkout.error.generic'),
        )
      } finally {
        setBusy(false)
      }
    },
    [uin, t],
  )

  // Poll while an invoice is open. ⚠ The voucher is handed up exactly once
  // (`handed`): the till will keep returning it, and redeeming twice is a
  // refusal, not a second number.
  useEffect(() => {
    if (!invoice || invoice.status === 'paid') return
    let dead = false
    const tick = async () => {
      try {
        const fresh = await Till.invoice(invoice.id)
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
  }, [invoice, onPaid])

  useEffect(() => {
    if (!invoice) return
    const tick = () => setLeft(Math.max(0, invoice.expires_at - Math.floor(Date.now() / 1000)))
    tick()
    const h = setInterval(tick, 1000)
    return () => clearInterval(h)
  }, [invoice])

  const mm = String(Math.floor(left / 60)).padStart(2, '0')
  const ss = String(left % 60).padStart(2, '0')

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
          <div className="text-4xl font-bold tracking-tight tabular-nums">{uin}</div>
          <div className="mt-1 text-fg-secondary tabular-nums">{priceDisplay}</div>
        </div>

        {/* ⚠ No AnimatePresence around these three. It stalled: the panel being
            replaced finished its exit at opacity 0 and was never removed, so
            the invoice existed, the sheet's own footer knew it, and the buyer
            was left looking at the chain picker with nothing to click. A
            crossfade is not worth a dead screen in a checkout. */}
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
            </motion.div>
          ) : invoice.status === 'paid' ? (
            <motion.div
              key="paid"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="mt-6 text-center"
            >
              <p className="text-sm text-fg-secondary">{t('uin_checkout.paid.body')}</p>
              <div className="mt-4 flex justify-center">
                <Spinner />
              </div>
            </motion.div>
          ) : (
            <motion.div key="pay" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <p className="mt-4 text-sm text-fg-secondary leading-relaxed text-center">
                {t('uin_checkout.pay.body', { chain: invoice.chain_label })}
              </p>
              {qr && (
                <div className="mt-4 flex justify-center">
                  <img
                    src={qr}
                    alt=""
                    className="h-40 w-40 rounded-xl"
                    style={{ imageRendering: 'pixelated' }}
                  />
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
              <p className="mt-3 text-xs text-fg-dim leading-relaxed text-center">
                {t('uin_checkout.exact')}
              </p>
            </motion.div>
          )}
        </div>

        {error && <div className="mt-4 text-sm text-red-500 text-center">{error}</div>}

        <button
          onClick={() => {
            // Closing an invoice nobody paid is not worth remembering. One that
            // was paid stays in the list until it has been redeemed.
            if (invoice && invoice.status !== 'paid' && left <= 0) forgetInvoice(invoice.id)
            onClose()
          }}
          disabled={busy}
          className="mt-6 w-full h-11 rounded-xl text-sm font-medium text-fg-secondary
                     bg-surface dark:bg-field hover:bg-field dark:hover:bg-line active:scale-[0.99] transition"
        >
          {invoice && invoice.status !== 'paid'
            ? t('uin_checkout.later')
            : t('common.cancel')}
        </button>
      </motion.div>
    </motion.div>
  )
}

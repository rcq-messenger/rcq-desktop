// "Become a resident of {host}" on a guest copy (spec 2026-09-15, 9.1 and 12.1).
//
// A guest copy takes part in rooms and nothing else. Settling converts the SAME
// row, number and rooms included, into a resident's account: with an entry
// voucher or an invite pasted into the one code box every island's door already
// has, or with nothing on an open island. Used for a visited copy (the group
// screen of a room on another island) and for an account that is itself a
// guest copy (the contact list banner).
//
// ⚠ No `entry_url`, no purchase link here: the island's door screen is where
// entry is bought, and this box only takes a code somebody already has.

import { useState } from 'react'
import { Api, ApiError } from '../lib/api'
import type { WebIdentity } from '../lib/crypto'
import { guestRefusalOf, guestSettleErrorKey } from '../lib/guest-path'
import { useI18n } from '../lib/i18n-context'

interface Props {
  /// The identity that island answers to (a guest clone for a visited copy).
  ident: WebIdentity
  host: string
  /// Told once the island has made the row a resident's.
  onSettled: () => void
}

export function GuestSettleBox({ ident, host, onSettled }: Props) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function settle() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await Api.guestSettle(ident, code.trim() || undefined)
      setDone(true)
      onSettled()
    } catch (e) {
      if (e instanceof ApiError) {
        const refusal = guestRefusalOf(e.status, e.body)
        if (refusal.code === 'not_a_guest') {
          // Settled already, from another device or by the operator.
          setDone(true)
          onSettled()
          return
        }
        const key = guestSettleErrorKey(refusal.code, e.status)
        setError(t(key ?? (code.trim() ? 'auth.error.invite_invalid' : 'auth.error.network'), { host }))
      } else {
        setError(t('auth.error.network'))
      }
    } finally {
      setBusy(false)
    }
  }

  if (done) return <p className="text-sm text-fg-secondary">{t('guest.settle.done', { host })}</p>

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full h-10 rounded-md text-sm font-medium text-accent hover:bg-field transition-colors"
      >
        {t('guest.settle.action', { host })}
      </button>
    )
  }

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{t('guest.settle.action', { host })}</div>
      <div className="flex gap-2">
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value.slice(0, 512))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void settle()
          }}
          aria-label={t('guest.settle.action', { host })}
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 h-10 px-3 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm"
        />
        <button
          type="button"
          onClick={() => void settle()}
          disabled={busy}
          className="h-10 px-4 rounded-md bg-accent hover:bg-accent-dim text-white text-sm font-semibold disabled:opacity-40 transition-colors"
        >
          {busy ? t('residency.redeeming') : t('residency.redeem')}
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}

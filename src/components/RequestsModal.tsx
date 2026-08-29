/// Contact requests, both directions, in a window over the list you were
/// already looking at.
///
/// Two changes in one. It used to be a full-page route: on a desktop, checking
/// whether anyone had written took the whole window away from the chat list and
/// then had to be navigated back out of. Founder: "я все это делаю чтобы юзерам
/// меньше надо было ходить на дополнительные страницы".
///
/// And the OUTGOING half simply did not exist on web — the island has served
/// `/contacts/outgoing` since the phones got it, so a request sent from the
/// desktop disappeared with no way to see whether it was still waiting, had
/// been declined, or had ever been sent at all. The phones put that on its own
/// screen behind an overflow menu; here it is the second tab, because a window
/// with two tabs is cheaper than a window and a screen.

import { CenteredLoader } from './Spinner'
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Api, type OutgoingRequest } from '../lib/api'
import { useIdentity } from '../lib/identity-context'
import { useI18n } from '../lib/i18n-context'
import { PendingRequests } from '../pages/PendingRequests'
import { PersonAvatar } from './PersonAvatar'

type Tab = 'in' | 'out'

export function RequestsModal({ incomingCount, onClose }: { incomingCount: number; onClose: () => void }) {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('in')

  // ⚠ Through a portal — the third surface to fall into the backdrop-filter
  // trap the pin banner and the news sheet document: mounted inside the
  // blurred header, `fixed inset-0` sizes to the header strip, and the modal
  // rendered as a faint ghost UNDER the page content (megalist B4).
  return createPortal(
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.16 }}
        onClick={onClose}
        className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-md sm:items-center"
      >
        <motion.div
          initial={{ y: 16, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 16, opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-md h-[70vh] max-h-[560px] flex flex-col rounded-t-xl sm:rounded-xl bg-surface shadow-lg overflow-hidden"
        >
          <header className="flex items-center justify-between gap-2 px-4 pt-3">
            <span className="text-sm font-semibold">{t('pending.title')}</span>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common.close')}
              className="text-fg-secondary hover:text-fg-primary px-1"
            >
              ✕
            </button>
          </header>
          {/* Same segmented control the emoticon settings use — one idiom for
              tabs in this client, not two. */}
          <div className="mx-4 mt-3 grid grid-cols-2 gap-1 rounded-lg bg-ink-black/[0.05] p-1 text-sm">
            {(['in', 'out'] as Tab[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setTab(k)}
                className={`h-8 rounded-md font-medium transition-colors ${
                  tab === k ? 'bg-surface text-fg-primary shadow-sm' : 'text-fg-secondary'
                }`}
              >
                {k === 'in'
                  ? `${t('pending.tab.incoming')}${incomingCount > 0 ? ` · ${incomingCount}` : ''}`
                  : t('pending.tab.outgoing')}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto pt-3">
            {tab === 'in' ? <PendingRequests embedded /> : <OutgoingList />}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}

function OutgoingList() {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const [rows, setRows] = useState<OutgoingRequest[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [acting, setActing] = useState<number | null>(null)

  useEffect(() => {
    if (!identity) return
    let alive = true
    void Api.outgoingRequests(identity)
      .then((r) => alive && setRows(r))
      .catch((e) => alive && setError(e instanceof Error ? e.message : t('pending.error')))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.uin])

  async function cancel(toUin: number) {
    if (!identity) return
    setActing(toUin)
    try {
      await Api.cancelOutgoing(identity, toUin)
      setRows((r) => (r ?? []).filter((x) => x.to_uin !== toUin))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('pending.error'))
    } finally {
      setActing(null)
    }
  }

  if (error) return <div className="px-4 pb-4 text-sm text-red-500">{error}</div>
  if (!rows) return <CenteredLoader className="py-8" />
  if (rows.length === 0)
    return <div className="px-4 pb-6 text-center text-sm text-fg-secondary">{t('pending.outgoing.empty')}</div>

  return (
    <ul className="px-4 pb-4 space-y-2">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center gap-3 rounded-lg bg-surface-dim px-3 py-2.5">
          <PersonAvatar status="offline" size={32} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{r.nickname || `#${r.to_uin}`}</div>
            <div className="truncate text-[0.6875rem] text-fg-dim">
              #{r.to_uin} ·{' '}
              {r.state === 'declined' ? t('pending.outgoing.declined') : t('pending.outgoing.waiting')}
            </div>
          </div>
          <button
            type="button"
            disabled={acting === r.to_uin}
            onClick={() => void cancel(r.to_uin)}
            className="shrink-0 h-7 px-2 rounded-md bg-field text-xs font-medium hover:bg-line/50 transition-colors disabled:opacity-50"
          >
            {r.state === 'declined' ? t('pending.outgoing.dismiss') : t('pending.outgoing.cancel')}
          </button>
        </li>
      ))}
    </ul>
  )
}

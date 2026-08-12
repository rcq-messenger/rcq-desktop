// My reports (#475) — the reading half of the bug-bounty channel.
//
// The desktop could file a report but never see what came back: the operator's
// answer lives on the server behind GET /reports/mine, and nothing here called
// it. So a user typed into what looked like a suggestion box. Both phones have
// had this screen since Android v0.77 (ui/MyReportsScreen.kt, Views/MyReportsView.swift);
// this is the same shape with the same wording.
//
// Two things carried over from Android because they were paid for there:
//   • an answered report that is still `open` says "Answered", not "Waiting" —
//     the operator replies first and picks a verdict later, and a card that
//     keeps saying "waiting" next to a written answer reads as being ignored;
//   • the reason and the reply are copyable, which on this platform takes work:
//     the Tauri build sets `user-select: none` on everything (index.css) to
//     stop the app feeling like a web page, and `rcq-selectable` is the way
//     back in.

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Api, ApiError, type MyReport } from '../lib/api'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import { useToast } from '../lib/toast'

const KNOWN_STATUSES = new Set(['resolved', 'dismissed', 'duplicate'])

export function MyReports() {
  const { identity } = useIdentity()
  const { t, lang } = useI18n()
  const { toast } = useToast()
  const [items, setItems] = useState<MyReport[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refused, setRefused] = useState(false)

  useEffect(() => {
    if (!identity) return
    let alive = true
    setError(null)
    Api.myReports(identity)
      .then((rows) => {
        if (alive) setItems(rows)
      })
      .catch((e) => {
        if (!alive) return
        // A 404 is not a failure to reach the island, it is an island that
        // does not have this endpoint — self-hosted or simply older. Telling
        // that user to "try again" would be a loop with no exit.
        if (e instanceof ApiError && e.status === 404) {
          setItems([])
          return
        }
        setItems([])
        setError(t('myreports.load_error'))
      })
    return () => {
      alive = false
    }
  }, [identity, t])

  async function remove(report: MyReport) {
    if (!identity) return
    // The backend deletes for real — no tombstone, and the evidence blob goes
    // with it. On a mouse this is one stray click away from destroying both
    // your own words and the answer to them.
    if (!window.confirm(t('myreports.delete_confirm'))) return
    setRefused(false)
    try {
      await Api.deleteMyReport(identity, report.id)
      setItems((prev) => (prev ? prev.filter((r) => r.id !== report.id) : prev))
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setRefused(true)
        return
      }
      setError(t('myreports.delete_error'))
    }
  }

  function copy(text: string) {
    void navigator.clipboard?.writeText(text).catch(() => {})
    toast(t('chat.copied'))
  }

  function formatted(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleDateString(lang, { year: 'numeric', month: 'short', day: 'numeric' })
  }

  return (
    <div className="min-h-screen bg-surface-dim">
      <header className="rcq-header sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-3 h-14 flex items-center gap-3">
          <Link
            to="/settings"
            className="text-fg-secondary hover:text-fg-primary"
            aria-label={t('common.back')}
          >
            ←
          </Link>
          <div className="font-semibold">{t('myreports.title')}</div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-4 space-y-4">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-600">
            {error}
          </div>
        )}

        {refused && (
          <div className="bg-surface rounded-lg p-3 text-sm text-fg-secondary">
            {t('myreports.delete_refused')}
          </div>
        )}

        {items === null && !error && (
          <div className="text-center text-sm text-fg-secondary py-12">
            {t('contacts.loading')}
          </div>
        )}

        {items !== null && items.length === 0 && !error && (
          <div className="text-center text-sm text-fg-secondary py-12">
            {t('myreports.empty')}
          </div>
        )}

        {items?.map((r) => {
          const reply = (r.reply ?? '').trim()
          const answered = reply.length > 0
          const statusKey = KNOWN_STATUSES.has(r.status) ? r.status : 'open'
          const label =
            answered && statusKey === 'open'
              ? t('myreports.status.answered')
              : t(`myreports.status.${statusKey}`)
          const waiting = statusKey === 'open' && !answered
          // The platform tag the client glued on when sending is ours, not
          // something the reporter wrote. Showing it back to them reads as
          // their own text having been mangled.
          const reason = r.reason.replace(/^\[[^\]]{1,32}\]\s*/, '')

          return (
            <section key={r.id} className="bg-surface rounded-lg p-4 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div
                  className={
                    'text-xs font-semibold ' + (waiting ? 'text-accent' : 'text-fg-secondary')
                  }
                >
                  {label}
                </div>
                <div className="flex items-center gap-3 flex-none">
                  <span className="text-xs text-fg-dim">{formatted(r.created_at)}</span>
                  <button
                    type="button"
                    onClick={() => copy(reason)}
                    className="text-xs text-fg-dim hover:text-fg-primary transition-colors"
                  >
                    {t('myreports.copy')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(r)}
                    className="text-xs text-fg-dim hover:text-red-500 transition-colors"
                  >
                    {t('myreports.delete')}
                  </button>
                </div>
              </div>

              <div className="text-sm whitespace-pre-wrap break-words rcq-selectable">{reason}</div>

              {answered && (
                <div className="bg-surface-dim rounded-md p-3 space-y-1">
                  <div className="text-xs font-semibold text-accent">{t('myreports.answer')}</div>
                  <div className="text-sm whitespace-pre-wrap break-words rcq-selectable">
                    {reply}
                  </div>
                </div>
              )}
            </section>
          )
        })}
      </main>
    </div>
  )
}

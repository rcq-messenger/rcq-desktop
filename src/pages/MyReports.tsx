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
import { Api, ApiError, type MyReport, type ReportTurn } from '../lib/api'
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
  /// Kept apart from `error` on purpose: `error` is about the LOAD and gates
  /// the loading and empty branches below, so putting a failed delete in it
  /// would blank the list and then never clear.
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [refused, setRefused] = useState(false)
  /// Which report has its reply box open, and what is typed in it. One at a
  /// time: this is a queue of tickets, not a chat list.
  const [replyTo, setReplyTo] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  /// Add a turn and put it straight into the list, so the answer appears where
  /// it was typed instead of after a refresh nobody triggers.
  async function send(reportId: number) {
    const text = draft.trim()
    if (!identity || !text || sending) return
    setSending(true)
    setDeleteError(null)
    try {
      const turn = await Api.addToReport(identity, reportId, text)
      setItems((rows) =>
        (rows ?? []).map((r) =>
          r.id === reportId ? { ...r, thread: [...(r.thread ?? []), turn] } : r,
        ),
      )
      setDraft('')
      setReplyTo(null)
    } catch (e) {
      // A closed ticket is the one refusal worth naming: it is not a failure,
      // it is an answer.
      setDeleteError(
        e instanceof ApiError && e.status === 409
          ? t('myreports.closed')
          : t('myreports.send_error'),
      )
    } finally {
      setSending(false)
    }
  }

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
    setDeleteError(null)
    try {
      await Api.deleteMyReport(identity, report.id)
      setItems((prev) => (prev ? prev.filter((r) => r.id !== report.id) : prev))
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setRefused(true)
        return
      }
      // 404 means it is already gone — from another device, or from the
      // operator's side. Dropping the row is the honest answer, not an error.
      if (e instanceof ApiError && e.status === 404) {
        setItems((prev) => (prev ? prev.filter((r) => r.id !== report.id) : prev))
        return
      }
      setDeleteError(t('myreports.delete_error'))
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

        {deleteError && (
          <div className="bg-surface rounded-lg p-3 text-sm text-red-600">{deleteError}</div>
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
          const turns: ReportTurn[] = r.thread ?? []
          const answered = reply.length > 0 || turns.some((x) => x.from_admin)
          const statusKey = KNOWN_STATUSES.has(r.status) ? r.status : 'open'
          const label =
            answered && statusKey === 'open'
              ? t('myreports.status.answered')
              : t(`myreports.status.${statusKey}`)
          const waiting = statusKey === 'open' && !answered
          // The platform tag the client glued on when sending is ours, not
          // something the reporter wrote. Showing it back to them reads as
          // their own text having been mangled.
          //
          // Only OUR tags, not any leading bracket: reports also arrive from
          // the abuse flow with no tag at all, and a report that opens with
          // "[важно] ..." is the reporter's own emphasis, not ours to eat.
          const reason = r.reason.replace(
            /^\[(Web|Desktop [^\]]{0,24}|Android [^\]]{0,12}|iOS [^\]]{0,12})\]\s*/,
            '',
          )

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

              {/* The exchange. `thread` is what a current island sends; an
                  older one sends only the single `reply`, and that is what the
                  fallback below renders — the screen must not go blank against
                  an island that has not updated. */}
              {turns.length > 0
                ? turns.map((turn) => (
                    <div
                      key={turn.id}
                      className={`rounded-md p-3 space-y-1 ${
                        turn.from_admin ? 'bg-surface-dim' : 'bg-field'
                      }`}
                    >
                      <div
                        className={`text-xs font-semibold ${
                          turn.from_admin ? 'text-accent' : 'text-fg-secondary'
                        }`}
                      >
                        {turn.from_admin ? t('myreports.answer') : t('myreports.you')}
                      </div>
                      <div className="text-sm whitespace-pre-wrap break-words rcq-selectable">
                        {turn.body}
                      </div>
                    </div>
                  ))
                : answered && (
                    <div className="bg-surface-dim rounded-md p-3 space-y-1">
                      <div className="text-xs font-semibold text-accent">
                        {t('myreports.answer')}
                      </div>
                      <div className="text-sm whitespace-pre-wrap break-words rcq-selectable">
                        {reply}
                      </div>
                    </div>
                  )}

              {/* Writing back only makes sense while the ticket is open. A
                  closed one keeps its whole exchange readable. */}
              {statusKey === 'open' &&
                (replyTo === r.id ? (
                  <div className="space-y-2">
                    <textarea
                      autoFocus
                      rows={3}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder={t('myreports.reply.placeholder')}
                      className="w-full rounded-md bg-field px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent/60 rcq-selectable"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          setReplyTo(null)
                          setDraft('')
                        }}
                        className="flex-1 h-9 rounded-md bg-field text-sm font-medium hover:bg-line/40 transition-colors"
                      >
                        {t('common.cancel')}
                      </button>
                      <button
                        disabled={sending || !draft.trim()}
                        onClick={() => void send(r.id)}
                        className="flex-1 h-9 rounded-md bg-accent text-ink-black text-sm font-semibold disabled:opacity-40 transition-opacity"
                      >
                        {t('myreports.reply.send')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      setReplyTo(r.id)
                      setDraft('')
                    }}
                    className="w-full h-9 rounded-md bg-field text-sm font-medium hover:bg-line/40 transition-colors"
                  >
                    {t('myreports.reply')}
                  </button>
                ))}
            </section>
          )
        })}
      </main>
    </div>
  )
}

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
//
// Founder item 26 turned the two word-buttons in the corner into the same icon
// row the other clients carry (copy / edit / delete), added a copy for the
// ANSWER as well as the report, and put the report NUMBER on the row so the
// reporter can quote the same number the operator reads off the queue.

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Api,
  ApiError,
  reportNumber,
  REPORT_MAX_REASON,
  type MyReport,
  type ReportTurn,
} from '../lib/api'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import { useToast } from '../lib/toast'

const KNOWN_STATUSES = new Set(['resolved', 'dismissed', 'duplicate'])

/// The platform tag the client glued on when sending is ours, not something
/// the reporter wrote. Showing it back to them reads as their own text having
/// been mangled.
///
/// Only OUR tags, not any leading bracket: reports also arrive from the abuse
/// flow with no tag at all, and a report that opens with "[важно] ..." is the
/// reporter's own emphasis, not ours to eat.
///
/// Hoisted out of the row because editing needs the other direction too: the
/// tag comes off for reading and goes back on before saving, so an edit never
/// strips the marker the admin queue sorts by.
const TAG_RE = /^\[(Web|Desktop [^\]]{0,24}|Android [^\]]{0,12}|iOS [^\]]{0,12})\]\s*/

function splitTag(reason: string): { tag: string; body: string } {
  const tag = TAG_RE.exec(reason)?.[0] ?? ''
  return { tag, body: reason.slice(tag.length) }
}

export function MyReports() {
  const { identity } = useIdentity()
  const { t, lang } = useI18n()
  const { toast } = useToast()
  const [items, setItems] = useState<MyReport[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  /// Kept apart from `error` on purpose: `error` is about the LOAD and gates
  /// the loading and empty branches below, so putting a failed action in it
  /// would blank the list and then never clear. Every per-row action (send,
  /// edit, delete) reports through this one.
  const [actionError, setActionError] = useState<string | null>(null)
  const [refused, setRefused] = useState(false)
  /// Which report has its reply box open, and what is typed in it. One at a
  /// time: this is a queue of tickets, not a chat list.
  const [replyTo, setReplyTo] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  /// Which report is being rewritten, and the text so far. Same one-at-a-time
  /// rule as the reply box, and the two are mutually exclusive.
  const [editing, setEditing] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)

  /// Add a turn and put it straight into the list, so the answer appears where
  /// it was typed instead of after a refresh nobody triggers.
  async function send(reportId: number) {
    const text = draft.trim()
    if (!identity || !text || sending) return
    setSending(true)
    setActionError(null)
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
      setActionError(
        e instanceof ApiError && e.status === 409
          ? t('myreports.closed')
          : t('myreports.send_error'),
      )
    } finally {
      setSending(false)
    }
  }

  /// Rewrite the report itself, while nobody has answered it.
  ///
  /// ⚠ The island half of this (`PATCH /reports/mine/{id}`) does not exist on
  /// the flagship yet. An island without the route answers 404 from the router
  /// rather than from our handler, and the two are told apart by the body: our
  /// own 404 carries `{"detail":{"code":"not_found"}}`, FastAPI's carries the
  /// bare string. Getting that wrong either way is a lie to the user: "could
  /// not save, try again" on a button that can never work, or "your report is
  /// gone" on a report that is sitting right there.
  async function saveEdit(report: MyReport) {
    const text = editDraft.trim()
    if (!identity || !text || savingEdit) return
    const { tag, body } = splitTag(report.reason)
    if (text === body) {
      setEditing(null)
      return
    }
    setSavingEdit(true)
    setActionError(null)
    try {
      await Api.editMyReport(identity, report.id, `${tag}${text}`)
      setItems((rows) =>
        (rows ?? []).map((r) => (r.id === report.id ? { ...r, reason: `${tag}${text}` } : r)),
      )
      setEditing(null)
      setEditDraft('')
    } catch (e) {
      if (e instanceof ApiError && (e.status === 405 || (e.status === 404 && !e.body.includes('not_found')))) {
        setActionError(t('myreports.edit_unsupported'))
      } else if (e instanceof ApiError && e.status === 409) {
        setActionError(t('myreports.edit_answered'))
      } else {
        setActionError(t('myreports.edit_error'))
      }
    } finally {
      setSavingEdit(false)
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
    setActionError(null)
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
      setActionError(t('myreports.delete_error'))
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

        {actionError && (
          <div className="bg-surface rounded-lg p-3 text-sm text-red-600">{actionError}</div>
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
          const { tag, body: reason } = splitTag(r.reason)
          // Rewriting is for a report nobody has read out yet. Once an
          // operator has answered, changing the words underneath the answer
          // would make the exchange read as a non-sequitur for both sides, so
          // from then on the way to add something is `Write back`.
          const editable = statusKey === 'open' && !answered
          const isEditing = editing === r.id
          const num = reportNumber(r)
          // The tag rides along inside the stored string and still counts
          // against the server's 1000-character cap, so the box the user types
          // in is smaller than the cap by exactly the tag (separator included,
          // `tag` keeps its trailing space). Same arithmetic the composer in
          // Settings does when sending, only measured off the real tag rather
          // than the one this platform would have used.
          const limit = REPORT_MAX_REASON - tag.length

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
                <div className="flex items-center gap-2 flex-none">
                  {/* The number the operator quotes back. Selectable on
                      purpose: half the point is being able to paste it. */}
                  <span
                    className="text-xs text-fg-dim rcq-selectable"
                    title={t('myreports.number', { n: num })}
                  >
                    #{num}
                  </span>
                  <span className="text-xs text-fg-dim">{formatted(r.created_at)}</span>
                  <IconButton label={t('myreports.copy')} onClick={() => copy(reason)}>
                    <CopyIcon />
                  </IconButton>
                  {editable && (
                    <IconButton
                      label={t('myreports.edit')}
                      onClick={() => {
                        setActionError(null)
                        setReplyTo(null)
                        setEditing(isEditing ? null : r.id)
                        setEditDraft(reason)
                      }}
                    >
                      <PencilIcon />
                    </IconButton>
                  )}
                  <IconButton
                    label={t('myreports.delete')}
                    danger
                    onClick={() => void remove(r)}
                  >
                    <TrashIcon />
                  </IconButton>
                </div>
              </div>

              {isEditing ? (
                <div className="space-y-2">
                  <textarea
                    autoFocus
                    rows={4}
                    maxLength={limit}
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    placeholder={t('myreports.edit.placeholder')}
                    className="w-full rounded-md bg-field px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent/60 rcq-selectable"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setEditing(null)
                        setEditDraft('')
                      }}
                      className="flex-1 h-9 rounded-md bg-field text-sm font-medium hover:bg-line/40 transition-colors"
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      disabled={savingEdit || !editDraft.trim()}
                      onClick={() => void saveEdit(r)}
                      className="flex-1 h-9 rounded-md bg-accent text-ink-black text-sm font-semibold disabled:opacity-40 transition-opacity"
                    >
                      {t('myreports.edit.save')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="text-sm whitespace-pre-wrap break-words rcq-selectable">
                  {reason}
                </div>
              )}

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
                      <div className="flex items-center justify-between gap-3">
                        <div
                          className={`text-xs font-semibold ${
                            turn.from_admin ? 'text-accent' : 'text-fg-secondary'
                          }`}
                        >
                          {turn.from_admin ? t('myreports.answer') : t('myreports.you')}
                        </div>
                        {/* The answer gets its own copy, not just the report:
                            people quote the operator's words when they follow
                            up, and on the desktop build there is no selecting
                            them by hand (see the `rcq-selectable` note up top). */}
                        {turn.from_admin && (
                          <IconButton
                            label={t('myreports.copy_answer')}
                            onClick={() => copy(turn.body)}
                          >
                            <CopyIcon />
                          </IconButton>
                        )}
                      </div>
                      <div className="text-sm whitespace-pre-wrap break-words rcq-selectable">
                        {turn.body}
                      </div>
                    </div>
                  ))
                : answered && (
                    <div className="bg-surface-dim rounded-md p-3 space-y-1">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs font-semibold text-accent">
                          {t('myreports.answer')}
                        </div>
                        <IconButton
                          label={t('myreports.copy_answer')}
                          onClick={() => copy(reply)}
                        >
                          <CopyIcon />
                        </IconButton>
                      </div>
                      <div className="text-sm whitespace-pre-wrap break-words rcq-selectable">
                        {reply}
                      </div>
                    </div>
                  )}

              {/* Writing back only makes sense while the ticket is open. A
                  closed one keeps its whole exchange readable. Hidden while
                  the report itself is being rewritten: two open composers on
                  one card, each with its own Save, is a coin toss. */}
              {statusKey === 'open' &&
                !isEditing &&
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
                      setEditing(null)
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

/// One glyph in a row's action corner. Same target size and the same
/// label-on-both-`aria-label`-and-`title` habit as the other icon rows in the
/// app, so the action still has a name for a screen reader and on hover: an
/// icon-only button that says nothing is a guess.
function IconButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={
        'p-1 -my-1 text-fg-dim transition-colors ' +
        (danger ? 'hover:text-red-500' : 'hover:text-fg-primary')
      }
    >
      {children}
    </button>
  )
}

// ── glyphs ────────────────────────────────────────────────────────────────
// Hand-drawn rather than pulled from a pack: the app ships no icon dependency
// and every other screen draws its own the same way (see AudioRooms).

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  )
}

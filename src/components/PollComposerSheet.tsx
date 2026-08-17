/// Composing a group poll on the desktop (#578 — "на ПК нельзя создавать
/// опросы"). The web could already read a ballot and vote in it; the half that
/// was missing was making one, so a poll started on a phone was the only kind
/// of poll that existed.
///
/// This is Android's `PollComposerDialog` (ui/PollBubble.kt:175) in this app's
/// idiom: a question, two to ten options, and the two flags the island stores —
/// single-choice and anonymous. The caps are not ours to pick: the island
/// rejects anything outside 2..10 options (backend polls.py MIN_OPTIONS /
/// MAX_OPTIONS), and the phones trim + drop blank options before counting, so
/// a ballot made here and one made there are the same object.
///
/// Nothing here talks to the network. The caller owns the two-step create
/// (register the shape, then ship the envelope) because only it knows which
/// island the group lives on.

import { AnimatePresence, motion } from 'framer-motion'
import { useState } from 'react'
import { useI18n } from '../lib/i18n-context'

/// Island's own bounds (backend/app/routers/polls.py:45-46). Android enforces
/// the same two numbers in its composer; a client that let an 11th option
/// through would get a 422 after the user had typed it.
export const MIN_POLL_OPTIONS = 2
export const MAX_POLL_OPTIONS = 10
/// Per-field text caps, same as Android's composer (PollBubble.kt:191, 198).
const MAX_QUESTION_CHARS = 280
const MAX_OPTION_CHARS = 120

export function PollComposerSheet({
  onClose,
  onCreate,
}: {
  onClose: () => void
  /// Trimmed question + the non-blank options, in the order they were typed.
  onCreate: (question: string, options: string[], single: boolean, anon: boolean) => Promise<string | null>
}) {
  const { t } = useI18n()
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState<string[]>(['', ''])
  const [single, setSingle] = useState(true)
  const [anon, setAnon] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // What actually goes on the wire: trimmed, blanks dropped. A row left empty
  // in the middle is not an option, it is a row the user gave up on.
  const clean = options.map((o) => o.trim()).filter((o) => o.length > 0)
  const valid = question.trim().length > 0 && clean.length >= MIN_POLL_OPTIONS

  function setOption(i: number, v: string) {
    setOptions((prev) => prev.map((o, j) => (j === i ? v.slice(0, MAX_OPTION_CHARS) : o)))
  }

  async function submit() {
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    const err = await onCreate(question.trim(), clean, single, anon)
    if (err) {
      setError(err)
      setBusy(false)
      return
    }
    onClose()
  }

  return (
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
          className="w-full max-w-md max-h-[85vh] flex flex-col rounded-t-xl sm:rounded-xl bg-surface shadow-lg overflow-hidden"
        >
          <header className="flex items-center justify-between gap-2 px-4 py-3">
            <span className="text-sm font-semibold">{t('poll.create.title')}</span>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common.close')}
              className="text-fg-secondary hover:text-fg-primary px-1"
            >
              ✕
            </button>
          </header>

          <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-4">
            {error && <div className="rounded-md bg-red-50 p-2 text-xs text-red-600">{error}</div>}

            <div className="space-y-1">
              <label className="block text-xs font-semibold uppercase tracking-wide text-fg-secondary">
                {t('poll.create.question')}
              </label>
              <textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value.slice(0, MAX_QUESTION_CHARS))}
                rows={2}
                autoFocus
                placeholder={t('poll.create.question_placeholder')}
                className="w-full rounded-md bg-field px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-accent resize-none"
              />
            </div>

            <div className="space-y-1">
              <label className="block text-xs font-semibold uppercase tracking-wide text-fg-secondary">
                {t('poll.create.options')}
              </label>
              <div className="space-y-2">
                {options.map((opt, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      value={opt}
                      onChange={(e) => setOption(i, e.target.value)}
                      placeholder={t('poll.create.option', { n: i + 1 })}
                      className="h-10 min-w-0 flex-1 rounded-md bg-field px-3 text-sm outline-none focus:ring-1 focus:ring-accent"
                    />
                    {/* Below the floor there is nothing to remove: two rows are
                        the poll, not two of its rows. */}
                    {options.length > MIN_POLL_OPTIONS && (
                      <button
                        type="button"
                        onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))}
                        aria-label={t('poll.create.remove_option')}
                        title={t('poll.create.remove_option')}
                        className="h-10 w-8 shrink-0 rounded-md text-fg-dim hover:text-fg-primary hover:bg-field transition-colors"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {options.length < MAX_POLL_OPTIONS && (
                <button
                  type="button"
                  onClick={() => setOptions((prev) => [...prev, ''])}
                  className="mt-1 text-sm text-accent hover:underline"
                >
                  + {t('poll.create.add_option')}
                </button>
              )}
            </div>

            <div className="space-y-1 pt-1">
              <Toggle
                label={t('poll.create.single')}
                hint={t('poll.create.single.hint')}
                on={single}
                onChange={setSingle}
              />
              <Toggle
                label={t('poll.create.anon')}
                hint={t('poll.create.anon.hint')}
                on={anon}
                onChange={setAnon}
              />
            </div>
          </div>

          <div className="flex items-center gap-2 px-4 pb-4">
            <button
              onClick={onClose}
              disabled={busy}
              className="flex-1 h-10 rounded-md bg-field text-sm font-medium hover:bg-line/50 disabled:opacity-40 transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={() => void submit()}
              disabled={busy || !valid}
              className="flex-1 h-10 rounded-md bg-accent text-sm font-semibold text-white hover:bg-accent-dim disabled:opacity-40 transition-colors"
            >
              {busy ? '…' : t('poll.create.cta')}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

/// Same switch GroupSettingsModal uses — this sheet is its sibling and should
/// not invent a second one.
function Toggle({
  label,
  hint,
  on,
  onChange,
}: {
  label: string
  hint: string
  on: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className="w-full flex items-start gap-3 rounded-md px-1 py-2 text-left hover:bg-field/60 transition-colors"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{label}</span>
        <span className="block text-xs text-fg-dim">{hint}</span>
      </span>
      <span
        className={`mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-line'}`}
      >
        <span
          className={`block h-4 w-4 rounded-full bg-surface transition-transform mt-0.5 ${on ? 'translate-x-[1.125rem]' : 'translate-x-0.5'}`}
        />
      </span>
    </button>
  )
}

// "How this works" — three questions, one screen.
//
// ⚠ NOT a second carousel, and that distinction is the whole brief. The
// carousel shows what the app can DO, and nobody is confused about that. What
// people are confused about is three other things: who can read what they send,
// what an island is and why there is more than one, and what to do when it
// stops working. Those are the questions in the reports.
//
// And it lives in Settings permanently rather than only at first launch,
// because the question arrives on the third day, not in the first minute — by
// which time an onboarding screen is long gone.

import { Link } from 'react-router-dom'
import { useI18n } from '../lib/i18n-context'

export function HowItWorks() {
  const { t } = useI18n()
  return (
    <div className="min-h-screen bg-surface-dim">
      <header className="rcq-header sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link to="/settings" className="text-fg-secondary hover:text-fg-primary px-2">
            ←
          </Link>
          <div className="font-semibold">{t('how.title')}</div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-4 space-y-3">
        <Answer q={t('how.q1')} a={t('how.a1')} />
        <Answer q={t('how.q2')} a={t('how.a2')} />
        <Answer q={t('how.q3')} a={t('how.a3')} />

        <a
          href="https://rcq.app/faq"
          target="_blank"
          rel="noreferrer"
          className="block bg-surface rounded-lg p-4 text-sm text-accent hover:bg-field transition-colors"
        >
          {t('how.more')}
        </a>
      </main>
    </div>
  )
}

function Answer({ q, a }: { q: string; a: string }) {
  return (
    <section className="bg-surface rounded-lg p-4 space-y-2">
      <h2 className="text-sm font-semibold">{q}</h2>
      {/* `whitespace-pre-line` so a paragraph break in the translation survives
          without every language needing its own markup. */}
      <p className="text-sm text-fg-secondary leading-relaxed whitespace-pre-line">{a}</p>
    </section>
  )
}

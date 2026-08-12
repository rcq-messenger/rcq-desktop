// The operator's announcement feed, which the phones have had since 0.86 and
// this client did not have at all. It lives in a small panel under its own
// header button rather than on a route of its own: news is something you glance
// at and dismiss, and sending someone to a separate screen for three sentences
// is how a feed stops being read.
//
// The dot on the button is the whole point of the feature — without it nobody
// discovers a post exists. What counts as "new" is anything with an id above
// the last one this account acknowledged, and the pointer is per-account
// (`scopedKey`) because two accounts in one browser have separate read state.

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchNews, type NewsPost } from '../lib/api'
import { scopedKey } from '../lib/account-scope'
import { useIdentity } from '../lib/identity-context'
import { useI18n } from '../lib/i18n-context'

const SEEN_KEY = () => scopedKey('news.seen')

function readSeen(): number {
  const raw = localStorage.getItem(SEEN_KEY())
  const n = raw == null ? NaN : Number(raw)
  return Number.isFinite(n) ? n : -1
}

/// First run on this account seeds the pointer at the newest post instead of
/// zero. Android learned this the hard way: without seeding, everyone who
/// updated was told they had forty-six unread announcements they had not
/// missed. A brand-new account has not missed them either.
function seedIfUnset(latest: number | null) {
  if (latest == null) return
  if (localStorage.getItem(SEEN_KEY()) == null) {
    localStorage.setItem(SEEN_KEY(), String(latest))
  }
}

function markSeen(latest: number | null) {
  if (latest != null) localStorage.setItem(SEEN_KEY(), String(latest))
}

/// Posts carry both languages in one body, separated by a `---` rule (that is
/// how every post since 0.86 is written). Showing both at once doubles the
/// panel and hands half of it to a language the reader did not pick, so split
/// and take the half that matches. A post written in one language only has no
/// rule and is shown whole.
function inLanguage(body: string, lang: string): string {
  const parts = body.split(/\n\s*---\s*\n/)
  if (parts.length < 2) return body.trim()
  return (lang === 'ru' ? parts[0] : parts[1]).trim()
}

/// First line is the headline, the rest is the post.
function splitHeadline(text: string): { head: string; rest: string } {
  const nl = text.indexOf('\n')
  if (nl < 0) return { head: text, rest: '' }
  return { head: text.slice(0, nl).trim(), rest: text.slice(nl).trim() }
}

function NewsItem({ post, lang, t }: { post: NewsPost; lang: string; t: (k: string) => string }) {
  const [open, setOpen] = useState(false)
  const text = inLanguage(post.body, lang)
  const { head, rest } = splitHeadline(text)
  return (
    <article className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-fg-secondary">{post.author_label || 'RCQ'}</span>
        <span className="text-[0.625rem] font-mono text-fg-dim">
          {new Date(post.published_at).toLocaleDateString(lang === 'ru' ? 'ru-RU' : undefined, {
            day: '2-digit', month: '2-digit', year: '2-digit',
          })}
        </span>
      </div>
      <div className="text-sm font-medium text-fg-primary break-words rcq-selectable">{head}</div>
      {rest && (
        <>
          <div
            className={`text-sm text-fg-secondary whitespace-pre-wrap break-words rcq-selectable ${open ? '' : 'line-clamp-2'}`}
          >
            {rest}
          </div>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-xs text-accent hover:underline"
          >
            {open ? t('news.less') : t('news.more')}
          </button>
        </>
      )}
    </article>
  )
}

export function NewsButton({ className }: { className?: string }) {
  const { identity } = useIdentity()
  const { t, lang } = useI18n()
  const [open, setOpen] = useState(false)
  const [posts, setPosts] = useState<NewsPost[] | null>(null)
  const [error, setError] = useState(false)
  const [unread, setUnread] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    if (!identity) return
    try {
      const res = await fetchNews(identity)
      const items = [...res.items].sort((a, b) => b.id - a.id)
      seedIfUnset(res.latest_id ?? items[0]?.id ?? null)
      const seen = readSeen()
      setPosts(items)
      setUnread(items.filter((p) => p.id > seen).length)
      setError(false)
    } catch {
      // A feed that cannot be fetched is not worth an error banner on the home
      // screen — the button simply shows nothing new.
      setError(true)
    }
  }, [identity])

  useEffect(() => { void load() }, [load])

  // Close on outside click and on Escape, the two things every popover has to
  // do before it counts as one.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function toggle() {
    const next = !open
    setOpen(next)
    if (next && posts && posts.length > 0) {
      markSeen(posts[0].id)
      setUnread(0)
    }
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={toggle}
        className={className}
        title={t('news.title')}
        aria-label={t('news.title')}
        aria-expanded={open}
      >
        <NewspaperIcon />
        {unread > 0 && (
          <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-red-500" />
        )}
      </button>

      {open && (
        // ⚠ The height cap has to be relative to the WINDOW, not a constant.
        // At 26rem the panel hangs past the bottom of a laptop window (and of
        // the desktop app's default one): the inner scroll existed, but its
        // last rows sat below the viewport edge where nothing could reach
        // them, so an expanded post simply ended mid-sentence. 8rem covers the
        // header plus the panel's own offset.
        <div className="absolute right-0 top-full mt-1 w-[min(22rem,calc(100vw-2rem))] max-h-[min(26rem,calc(100vh-8rem))] overflow-y-auto overscroll-contain rounded-lg bg-surface shadow-xl z-30 p-3 space-y-3">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('news.title')}
          </div>

          {posts == null && !error && (
            <div className="text-sm text-fg-dim py-4 text-center">{t('common.loading')}</div>
          )}
          {error && (
            <div className="text-sm text-fg-dim py-4 text-center">{t('news.failed')}</div>
          )}
          {posts != null && posts.length === 0 && (
            <div className="text-sm text-fg-dim py-4 text-center">{t('news.empty')}</div>
          )}

          {/* Rendering is deliberately dumb: plain text, no markdown, no HTML
              from the server. */}
          {posts?.map((p) => <NewsItem key={p.id} post={p} lang={lang} t={t} />)}
        </div>
      )}
    </div>
  )
}

/// ⚠ Was a megaphone, whose cone plus two arcs is the same shape every OS uses
/// for VOLUME — next to a theme toggle and a settings gear it read as an audio
/// control, not as an announcement feed. A newspaper has no such twin in this
/// header.
function NewspaperIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5h12a1 1 0 0 1 1 1v12a2 2 0 0 0 2 2H6a2 2 0 0 1-2-2V5z" />
      <path d="M17 9h2a1 1 0 0 1 1 1v8a2 2 0 0 1-2 2" />
      <line x1="7.5" y1="8.5" x2="13.5" y2="8.5" />
      <line x1="7.5" y1="12" x2="13.5" y2="12" />
      <line x1="7.5" y1="15.5" x2="11" y2="15.5" />
    </svg>
  )
}

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

import { CenteredLoader } from './Spinner'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { fetchNews, type NewsAttachment, type NewsPost } from '../lib/api'
import { useWS } from '../lib/ws'
import { scopedKey } from '../lib/account-scope'
import { useIdentity } from '../lib/identity-context'
import { useI18n } from '../lib/i18n-context'
import { useIslandCard } from '../lib/use-server-info'
import { IslandAvatar } from './IslandAvatar'

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

/// News media never rendered on the web at all — the field arrived typed
/// `unknown` and no component looked at it (megalist A4). The feed is public
/// and unencrypted (unlike chat media), so a plain <img>/<video> off the
/// island's own /news/media/ path is the whole job. `object-contain` inside a
/// bounded box, no cropping — the iOS complaint in the same item is exactly a
/// crop, so the web renders the full frame from day one.
function NewsMedia({ atts, apiBase }: { atts: NewsAttachment[]; apiBase: string }) {
  return (
    <div className="space-y-2">
      {atts.map((a) =>
        a.kind === 'video' ? (
          <video
            key={a.media_id}
            controls
            playsInline
            preload="metadata"
            src={`${apiBase}/news/media/${a.media_id}`}
            className="w-full max-h-64 rounded-md bg-black/20 object-contain"
          />
        ) : (
          <img
            key={a.media_id}
            src={`${apiBase}/news/media/${a.media_id}`}
            alt=""
            loading="lazy"
            className="w-full max-h-64 rounded-md object-contain"
          />
        ),
      )}
    </div>
  )
}

/// What is left of `author_label` once the island itself is the author: the
/// operator's own words, or nothing.
///
/// Founder's decision (02.09): on every client the news section is the
/// ISLAND's, drawn by its logo and its name. A self-hoster's feed comes from
/// their own island under their own name, and "RCQ Team" over a post they
/// wrote themselves was simply untrue. So the stock labels go, and a label is
/// shown only when somebody typed one.
///
/// ⚠ A label EQUAL to the island's name is a stock label too. The island's
/// default is "RCQ Team" today and becomes the island's own name server-side
/// (changed in parallel with this); without this test every post would read
/// "Island Island" the day that ships. Case-insensitive throughout: an
/// operator who typed "rcq team" did not name anybody either.
function customAuthor(label: string | null, islandName: string): string {
  const own = (label ?? '').trim()
  const norm = own.toLowerCase()
  if (!norm || norm === 'rcq team' || norm === 'rcq' || norm === islandName.trim().toLowerCase()) return ''
  return own
}

function NewsItem({ post, lang, t, apiBase, islandName }: { post: NewsPost; lang: string; t: (k: string) => string; apiBase: string; islandName: string }) {
  const [open, setOpen] = useState(false)
  const text = inLanguage(post.body, lang)
  const { head, rest } = splitHeadline(text)
  const atts = Array.isArray(post.attachments) ? post.attachments : []
  const suffix = customAuthor(post.author_label, islandName)
  return (
    <article className="space-y-1">
      {/* The island's face and name, complete on the first frame off the same
          per-island cache Settings and Login draw from, the bare host standing
          in for an island that has never said its name. `items-center`, not
          baseline: a picture has no baseline for the date to sit on. */}
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 min-w-0 text-xs font-semibold text-fg-secondary">
          <IslandAvatar apiBase={apiBase} name={islandName} size={18} />
          <span className="truncate">{islandName || apiBase.replace(/^https?:\/\//, '')}</span>
          {suffix && <span className="font-normal text-fg-dim truncate">{suffix}</span>}
        </span>
        <span className="flex-none text-[0.625rem] text-fg-dim">
          {new Date(post.published_at).toLocaleDateString(lang === 'ru' ? 'ru-RU' : undefined, {
            day: '2-digit', month: '2-digit', year: '2-digit',
          })}
        </span>
      </div>
      <div className="text-sm font-medium text-fg-primary break-words rcq-selectable">{head}</div>
      {atts.length > 0 && <NewsMedia atts={atts} apiBase={apiBase} />}
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
  // Once, here, not in every row: the answer is the same run-cached one either
  // way, and NewsItem stays a plain row that draws what it is handed.
  const islandName = useIslandCard(identity?.apiBase).name
  const [open, setOpen] = useState(false)
  const [posts, setPosts] = useState<NewsPost[] | null>(null)
  const [error, setError] = useState(false)
  const [unread, setUnread] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  // Tailwind's `sm` breakpoint, read rather than styled around: which form the
  // panel takes decides WHERE it is mounted, and a class cannot move a node.
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 639px)').matches)
  useEffect(() => {
    const m = window.matchMedia('(max-width: 639px)')
    const on = () => setNarrow(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  /// The panel itself. Separate from `wrapRef` because in the narrow form the
  /// panel is portalled out of the wrapper, so "is this click inside?" can no
  /// longer be answered by the DOM tree the button lives in.
  const panelRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    if (!identity) return
    try {
      const res = await fetchNews(identity)
      // Newest first by PUBLISH TIME, id as the tiebreak — the same order the
      // island serves and Android renders. Sorting by id alone put the posts
      // in a different sequence than the phone whenever ids and publish times
      // disagree, e.g. a translation post backdated a second to sit under its
      // original (report #644).
      const items = [...res.items].sort(
        (a, b) => Date.parse(b.published_at) - Date.parse(a.published_at) || b.id - a.id,
      )
      // Seed from the island's own latest_id, or the highest id we can see —
      // items[0] is the newest by TIME, which is not the same thing.
      seedIfUnset(
        res.latest_id ?? (items.length ? items.reduce((m, p) => (p.id > m ? p.id : m), items[0].id) : null),
      )
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

  // Realtime (megalist A4): the island broadcasts `news_posted` the moment a
  // post is published (server 2026.08.29.3). Refetching keeps one code path
  // for ordering/seen — the frame is only the doorbell.
  const ws = useWS()
  useEffect(() => ws.on('news_posted', () => { void load() }), [ws, load])

  // Close on outside click and on Escape, the two things every popover has to
  // do before it counts as one.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (wrapRef.current?.contains(target)) return
      // The portalled sheet is outside the wrapper but is emphatically not
      // "outside the popover" — without this, tapping "read more" in it closed
      // the thing you were trying to read.
      if (panelRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)

  function toggle() {
    const next = !open
    if (next) {
      const r = wrapRef.current?.getBoundingClientRect()
      setAnchor(r ? { top: r.bottom + 4, right: window.innerWidth - r.right } : null)
    }
    setOpen(next)
    if (next && posts && posts.length > 0) {
      // The MAX id, not the first row. The feed is ordered by publish time
      // now, so the newest post is no longer necessarily the highest id — a
      // translation backdated to sit under its original outranks it. Marking
      // the first row seen left every id above it unread forever, and the dot
      // came straight back.
      markSeen(posts.reduce((max, p) => (p.id > max ? p.id : max), posts[0].id))
      setUnread(0)
    }
  }

  // One feed, two shapes. Identical content either way.
  const body = (
    <>
      <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
        {t('news.title')}
      </div>

      {posts == null && !error && (
        <CenteredLoader className="py-8" />
      )}
      {error && (
        <div className="text-sm text-fg-dim py-4 text-center">{t('news.failed')}</div>
      )}
      {posts != null && posts.length === 0 && (
        <div className="text-sm text-fg-dim py-4 text-center">{t('news.empty')}</div>
      )}

      {/* Rendering is deliberately dumb: plain text, no markdown, no HTML from
          the server. */}
      {posts?.map((p) => <NewsItem key={p.id} post={p} lang={lang} t={t} apiBase={identity?.apiBase ?? ''} islandName={islandName} />)}
    </>
  )

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

      {/* ⚠ #598: on a narrow window this stops being a popover at all. Anchored
          `right-0` under a button that sits three icons in from the edge, the
          22rem panel started 54px LEFT of the screen at 375px (measured), so
          the first characters of every line were simply gone. The reporter's
          own answer was "better not pinned under the button, as long as it
          fits by width", so below `sm` it becomes the bottom sheet every other
          narrow surface in this app already is (Chat's pickers,
          EmoticonConfigSheet, ShareGroupSheet): full window width, nothing left
          to overflow.

          ⚠⚠ Through a PORTAL, and that is not a nicety. `.rcq-header` carries a
          backdrop-filter, which per Filter Effects makes it the containing
          block for `position: fixed` descendants — rendered in place, the sheet
          came out pinned to the bottom edge of the HEADER, 345px ABOVE the top
          of the window (measured at 375x812). Chat.tsx carries the same warning
          about `.rcq-floating-bar`; this is the second surface here to fall
          into it. So the form decides where the node is MOUNTED, which is why
          `narrow` is state and not a `sm:` prefix. */}
      {open && narrow &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-end justify-center"
            role="dialog"
            aria-modal="true"
          >
            <div
              className="absolute inset-0 bg-black/40 backdrop-blur-md"
              onClick={() => setOpen(false)}
            />
            <div
              ref={panelRef}
              className="relative z-10 w-full max-h-[75vh] overflow-y-auto overscroll-contain rounded-t-2xl bg-surface shadow-xl p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] space-y-3"
            >
              {body}
            </div>
          </div>,
          document.body,
        )}

      {/* Wide enough to have room: the popover under its button, unchanged.
          ⚠ The height cap has to be relative to the WINDOW, not a constant. At
          26rem the panel hangs past the bottom of a laptop window (and of the
          desktop app's default one): the inner scroll existed, but its last
          rows sat below the viewport edge where nothing could reach them, so an
          expanded post simply ended mid-sentence. 8rem covers the header plus
          the panel's own offset. */}
      {/* ⚠⚠ Also through a portal, for the OTHER half of the same trap: a
          backdrop-filter ancestor is a backdrop ROOT, so this panel's own
          backdrop-blur, rendered inside the blurred header, had nothing to
          sample and drew as plain translucency — the founder's "фон почему-то
          прозрачный" (megalist B4). At body level the blur works, and the
          border that tried to compensate for the missing depth goes. Anchored
          to the button at open time; the header is sticky, so the anchor
          cannot scroll away while open. */}
      {open && !narrow && anchor &&
        createPortal(
          <div
            ref={panelRef}
            style={{ position: 'fixed', top: anchor.top, right: anchor.right }}
            className="w-[min(22rem,calc(100vw-2rem))] max-h-[min(26rem,calc(100vh-8rem))] overflow-y-auto overscroll-contain rounded-lg bg-surface/85 backdrop-blur-lg shadow-xl z-50 p-3 space-y-3"
          >
            {body}
          </div>,
          document.body,
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

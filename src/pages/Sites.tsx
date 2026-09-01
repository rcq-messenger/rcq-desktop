// The `.rcq` browser: the network's own pages, and nothing else.
//
// Design: docs/rcq-sites-design.md. What matters for reading this file:
//
// * A page is rendered in a LOCKED frame - `sandbox` with no `allow-scripts`,
//   fed through `srcdoc` so it has no origin of ours to reach back into. Not a
//   webview with our rules bolted on: a webview fingerprints the reader (fonts,
//   canvas, timings) far past anything the messenger gives away, and it goes to
//   the network on its own unless stopped.
// * `.rcq` is not DNS and never leaves this device as a name: `blog.is2.rcq`
//   is parsed HERE into island `is2` and site `blog`, and the fetch goes
//   straight to that island. The reader's own island is not a proxy - it would
//   otherwise hold a journal of what its users read elsewhere.
// * Links out of the network are text. A click is how a reader gets
//   deanonymised, and Tor's exit-node problem is one we can simply not have.
// * Pages of the same site are moved between HERE, in our own chrome: with no
//   scripts in the frame there is nothing inside a page that could navigate,
//   and that is the point rather than a limitation.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import { fetchCatalogue, fetchSiteIcon, fetchSitePage, parseRcqAddress, repin, type RcqAddress, type SitePage } from '../lib/sites'
import { MySitePanel } from '../components/MySitePanel'

const ERRORS = ['address', 'missing', 'frozen', 'unsigned', 'tampered', 'offline'] as const
type ErrorKind = (typeof ERRORS)[number]

/// A site's mark, or its first letter while there is none. The letter is not
/// a placeholder waiting for a picture: most sites will never have one, and a
/// row that jumps when an icon lands is worse than a row that never had it.
function SiteMark({ name, uri, size = 26 }: { name: string; uri?: string | null; size?: number }) {
  const box = { width: size, height: size }
  if (uri) {
    return (
      <img
        src={uri}
        alt=""
        style={box}
        className="flex-none rounded-[5px] object-cover bg-field"
      />
    )
  }
  return (
    <span
      style={box}
      className="flex-none rounded-[5px] bg-field text-fg-secondary flex items-center justify-center text-xs font-mono uppercase"
    >
      {name.slice(0, 1)}
    </span>
  )
}

export function Sites() {
  const { t } = useI18n()
  const { identity } = useIdentity()
  const [typed, setTyped] = useState('')
  const [addr, setAddr] = useState<RcqAddress | null>(null)
  const [page, setPage] = useState<SitePage | null>(null)
  const [error, setError] = useState<ErrorKind | null>(null)
  const [loading, setLoading] = useState(false)
  const [catalogue, setCatalogue] = useState<Array<{ name: string; title: string | null }>>([])
  /// name → the site's mark as a data URI, or null once we know there is none.
  const [icons, setIcons] = useState<Record<string, string | null>>({})
  const [mine, setMine] = useState(false)
  const [focused, setFocused] = useState(false)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // "My island" for a bare `name.rcq`, taken from this session's own API base:
  // a person's first site is reachable before they know what an island is.
  const ownHost = identity ? new URL(identity.apiBase).host : 'api.rcq.app'

  const open = useCallback(async (raw: string, path = 'index.html', fresh = false) => {
    const parsed = parseRcqAddress(raw, ownHost)
    if (!parsed) {
      setError('address')
      setPage(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const got = await fetchSitePage(parsed, path, fresh)
      setPage(got)
      void fetchSiteIcon(parsed, fresh).then((uri) => setIcons((cur) => ({ ...cur, [parsed.name]: uri })))
      setAddr(parsed)
      setTyped(parsed.display)
    } catch (e) {
      const kind = e instanceof Error ? e.message : 'missing'
      setPage(null)
      setError((ERRORS as readonly string[]).includes(kind) ? (kind as ErrorKind) : 'missing')
    } finally {
      setLoading(false)
    }
  }, [ownHost])

  // The catalogue of the reader's own island: what there is to look at at all,
  // and only the sites that asked to be in it.
  useEffect(() => {
    void fetchCatalogue(ownHost).then(setCatalogue)
  }, [ownHost])

  // Marks are fetched one by one after the list is drawn, and each is checked
  // against the owner's signature before it is shown. A list that waited for
  // them would be a list that an offline site could hold up.
  useEffect(() => {
    let live = true
    for (const s of catalogue) {
      const addr = parseRcqAddress(`${s.name}.rcq`, ownHost)
      if (!addr) continue
      void fetchSiteIcon(addr).then((uri) => {
        if (live) setIcons((cur) => ({ ...cur, [s.name]: uri }))
      })
    }
    return () => { live = false }
  }, [catalogue, ownHost])

  // The page is WRITTEN into a blank frame rather than handed over as
  // `srcdoc`. Both end up the same document, but `srcdoc` rendered NOTHING
  // inside the packaged desktop app - a white rectangle where the page should
  // be - while working everywhere else, including a reduced WKWebView harness
  // under the same custom scheme and the same policy (scratch probe, 01.09).
  // So the cause is still unaccounted for; what is established is that this
  // way renders in both engines and that way did not, and a browser that
  // shows a blank rectangle is not a browser.
  //
  // ⚠ This is why the frame carries `allow-same-origin`: a document can only
  // be written into if it is reachable, and an empty sandbox makes the frame
  // a stranger to us. What the frame must NOT have is `allow-scripts`, and it
  // does not: with nothing running inside, a shared origin buys the page
  // nothing - it cannot read the app, cannot touch storage, cannot fetch. The
  // meta policy written into the document itself (`default-src 'none'`) is the
  // lock that actually holds, and it is the same in both places.
  const paint = useCallback((html: string) => {
    const doc = frameRef.current?.contentDocument
    if (!doc) return false
    doc.open()
    doc.write(html)
    doc.close()
    return true
  }, [])

  useEffect(() => {
    const html = page?.html ?? ''
    if (paint(html)) return
    // The frame is mounted a tick after this effect on a first open.
    const t = setTimeout(() => paint(html), 50)
    return () => clearTimeout(t)
  }, [page, paint])

  return (
    <div className="h-screen [height:100dvh] flex flex-col bg-surface-dim overflow-hidden">
      {/* One capsule, the way a desktop browser does it: the address IS the
          control. Idle it sits centred with the site's mark and a reload
          glyph; focused it becomes an ordinary text field, left-aligned and
          selected, and Enter opens. There is no Open button - a button beside
          an address bar is a second way to do the thing the Return key
          already does (founder, 01.09). */}
      <header className="rcq-header sticky top-0 z-10 shrink-0">
        <div className="max-w-3xl mx-auto px-3 h-14 flex items-center gap-1.5">
          <Link to="/contacts" className="text-fg-secondary hover:text-fg-primary p-1.5 rounded-md hover:bg-field" aria-label={t('sites.back')}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </Link>

          <form
            className={`group flex-1 flex items-center gap-2 h-9 px-3 rounded-full bg-field transition-shadow ${
              focused ? 'ring-1 ring-accent' : 'hover:bg-line/40'
            }`}
            onSubmit={(e) => {
              e.preventDefault()
              void open(typed)
              inputRef.current?.blur()
            }}
          >
            {/* The mark stands in for the padlock a browser puts here, and it
                means the same thing: this is the site it says it is, checked
                against the owner's signature. */}
            {page && !focused && (
              <SiteMark name={addr?.name ?? ''} uri={icons[addr?.name ?? '']} size={18} />
            )}
            <input
              ref={inputRef}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onFocus={(e) => { setFocused(true); e.currentTarget.select() }}
              onBlur={() => { setFocused(false); if (addr) setTyped(addr.display) }}
              onKeyDown={(e) => {
                // Enter is handled here rather than left to the form's implicit
                // submission: a form whose only button is a reload button has
                // no submit button, and implicit submission is exactly the
                // corner of the spec engines disagree about. Escape puts the
                // address back the way a browser does.
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void open(e.currentTarget.value)
                  e.currentTarget.blur()
                } else if (e.key === 'Escape') {
                  inputRef.current?.blur()
                }
              }}
              placeholder={t('sites.address.placeholder')}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              aria-label={t('sites.address.placeholder')}
              className={`flex-1 min-w-0 bg-transparent outline-none text-sm font-mono text-fg-primary placeholder:text-fg-dim ${
                focused || !page ? 'text-left' : 'text-center'
              }`}
            />
            {/* Reload, and it really reloads: the bundle is served with a five
                minute cache, which is right for reading and wrong for somebody
                who just republished. */}
            {page && !focused && (
              <button
                type="button"
                onClick={() => addr && void open(addr.display, page.path, true)}
                className="text-fg-dim hover:text-fg-primary flex-none"
                title={t('sites.reload')}
                aria-label={t('sites.reload')}
              >
                {loading ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" className="animate-spin" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
                    <path d="M21 12a9 9 0 1 1-6.2-8.6" />
                  </svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M21 12a9 9 0 1 1-2.6-6.4" />
                    <path d="M21 3v5h-5" />
                  </svg>
                )}
              </button>
            )}
          </form>

          <button
            type="button"
            onClick={() => setMine(true)}
            className="text-fg-secondary hover:text-fg-primary p-2 rounded-md hover:bg-field"
            title={t('sites.mine')}
            aria-label={t('sites.mine')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 20h16" />
              <path d="M6 16l9-9 3 3-9 9H6z" />
            </svg>
          </button>
        </div>
        {/* A hair of progress under the bar. A spinner in the capsule says
            "something is happening"; this says where it has got to, which is
            what a slow island actually needs. */}
        <div className={`h-0.5 ${loading ? 'bg-accent/70 animate-pulse' : 'bg-transparent'}`} />
      </header>

      {/* The other pages of this site. With no scripts in the frame, a link
          inside a page cannot navigate - so the doors live out here. */}
      {page && page.pages.length > 1 && (
        <nav className="shrink-0 border-b border-border">
          <div className="max-w-3xl mx-auto px-3 py-1.5 flex items-center gap-1 overflow-x-auto">
            {page.pages.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => addr && void open(addr.display, p)}
                className={`px-2 py-1 rounded text-xs font-mono whitespace-nowrap ${
                  p === page.path ? 'bg-field text-fg-primary' : 'text-fg-secondary hover:text-fg-primary'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </nav>
      )}

      <main className="flex-1 min-h-0 overflow-hidden">
        {error && (
          <div className="max-w-3xl mx-auto px-4 py-8 text-sm text-fg-secondary">{t(`sites.error.${error}`)}</div>
        )}

        {!error && !page && (
          <div className="max-w-3xl mx-auto px-4 py-8 space-y-6 overflow-y-auto h-full">
            <div className="space-y-2">
              <div className="text-sm font-medium text-fg-primary">{t('sites.empty.title')}</div>
              <p className="text-xs text-fg-dim leading-relaxed">{t('sites.empty.body')}</p>
            </div>
            {catalogue.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs uppercase tracking-wide text-fg-dim">{t('sites.catalogue')}</div>
                {catalogue.map((s) => (
                  <button
                    key={s.name}
                    type="button"
                    onClick={() => void open(`${s.name}.rcq`)}
                    className="w-full flex items-center gap-3 text-left px-3 py-2 rounded-md hover:bg-field"
                  >
                    <SiteMark name={s.name} uri={icons[s.name]} />
                    <span className="min-w-0">
                      <span className="block text-sm font-mono text-fg-primary">{s.name}.rcq</span>
                      {s.title && <span className="block text-xs text-fg-secondary truncate">{s.title}</span>}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {!error && page && (
          <div className="h-full flex flex-col">
            {/* A pinned key that changed is the one thing worth interrupting
                for: these bytes are signed by somebody other than last time,
                which is exactly what the signature exists to make visible. */}
            {page.keyChanged && (
              <div className="px-4 py-2 text-xs bg-red-500/15 text-fg-primary flex items-center gap-3">
                <span className="flex-1">{t('sites.key_changed')}</span>
                <button
                  type="button"
                  className="underline"
                  onClick={() => {
                    if (!addr) return
                    repin(addr, page.key)
                    setPage({ ...page, keyChanged: false })
                  }}
                >
                  {t('sites.key_changed.accept')}
                </button>
              </div>
            )}
            <iframe
              ref={frameRef}
              title={addr?.display ?? ''}
              // ⚠⚠ No `allow-scripts`, and that is the whole lock: it is what
              // makes "no JS" true rather than a promise in the docs. Nothing
              // inside a page runs, so the page cannot reach the app, cannot
              // navigate itself and cannot ask the network for anything.
              sandbox="allow-same-origin"
              referrerPolicy="no-referrer"
              className="flex-1 w-full bg-white"
            />
          </div>
        )}
      </main>

      {/* Publishing lives here rather than in Settings: it is the same place
          you go to read, and a site is a place, not a preference. */}
      {mine && (
        <MySitePanel
          onClose={() => setMine(false)}
          onOpen={(name) => { setMine(false); void open(`${name}.rcq`) }}
        />
      )}
    </div>
  )
}

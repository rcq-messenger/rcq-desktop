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
// * Pages of the same site, and other sites, are moved between HERE, in our
//   own chrome: with no scripts in the frame there is nothing inside a page
//   that could navigate, and that is the point rather than a limitation. A
//   click on a link inside a page reaches the listener we attach to the
//   frame's document, and only the two kinds of link that stay inside the
//   network go anywhere.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import { useToast } from '../lib/toast'
import { isSentSoundEnabled, playSound } from '../lib/sounds'
import {
  displayAddress, fetchCatalogue, fetchSiteIcon, fetchSitePage, forgetRecent, noteRecent, parseRcqAddress,
  externalAlwaysAllowed, readRecents, recentKey, repin, setExternalAlwaysAllowed, siteLinkOf,
  type CatalogueEntry, type RcqAddress, type SitePage, type SiteRecent,
} from '../lib/sites'
import { SendTextError, sendTextTo, type ForwardTarget } from '../lib/send-text'
import { ForwardModal } from '../components/ForwardModal'
import { AddContactModal } from '../components/AddContactModal'
import { lookupContactName } from '../lib/contacts-cache'
import { openExternal } from '../lib/desktop'
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

/// The share glyph: an arrow leaving a tray, the shape every phone uses for
/// "hand this to somebody".
function ShareGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  )
}

/// One row of the start screen: the mark, the address, the catalogue line,
/// and at the right the share affordance (#852) - plus, for a recent, the way
/// to forget it.
///
/// A <div> with a button in it rather than one big <button>: the share and
/// the remove are buttons of their own, and a button inside a button is
/// invalid HTML that the browser is free to lift out of its row.
function SiteRow({
  name, address, title, ownerUin, icon, onOpen, onShare, onRemove, onOwner, t,
}: {
  name: string
  address: string
  title: string | null
  ownerUin?: number | null
  /// Tapping the author. The page owns the decision — see the comment below.
  onOwner?: (uin: number) => void
  icon: string | null | undefined
  onOpen: () => void
  onShare: () => void
  onRemove?: () => void
  t: (key: string) => string
}) {
  return (
    <div className="flex items-center rounded-md hover:bg-field">
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 flex items-center gap-3 text-left px-3 py-2"
      >
        <SiteMark name={name} uri={icon} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-mono text-fg-primary truncate">{address}</span>
          {title && <span className="block text-xs text-fg-secondary truncate">{title}</span>}
          {/* Who published it, and a way to reach them. The island already
              answers with this - a listed site is a shop window - so leaving
              it in an unread response helped nobody. */}
          {/* Only when the author asked to be named: the island answers with
              no owner at all otherwise, and a row reading "by #" was the
              shape of that decision leaking into the screen. */}
          {ownerUin != null && (
            <span className="block text-[0.6875rem] text-fg-dim">
              {t('sites.by')}{' '}
              {/* ⚠ Not a straight link into the thread any more (founder,
                  03.09). Tapping the author of a site you just found opened a
                  chat with a stranger, whose only content was a line saying
                  they are not in your contacts — a dead end reached by doing
                  the obvious thing. The page decides now: a contact opens the
                  conversation, anybody else opens "add contact", already
                  looking at that exact number.
                  And no hash before it: that went everywhere else on 03.09
                  and this row was missed. */}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onOwner?.(ownerUin) }}
                className="font-mono hover:text-fg-primary underline underline-offset-2"
              >
                {ownerUin}
              </button>
            </span>
          )}
        </span>
      </button>
      <button
        type="button"
        onClick={onShare}
        className="flex-none p-2 text-fg-dim hover:text-fg-primary"
        title={t('sites.share')}
        aria-label={t('sites.share')}
      >
        <ShareGlyph />
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="flex-none p-2 mr-1 text-fg-dim hover:text-fg-primary"
          title={t('sites.recents.remove')}
          aria-label={t('sites.recents.remove')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  )
}

/// What may be opened as a page. The manifest signs images and stylesheets
/// too, and neither is a page: decoded as text and parsed as HTML they paint a
/// screen of rubble. `siteLinkOf` already holds this line for a typed address;
/// a link inside a page and the `p` parameter hold it here.
function isPagePath(path: string | null | undefined): boolean {
  return !!path && /\.html?$/i.test(path)
}

export function Sites() {
  const { t } = useI18n()
  const { identity } = useIdentity()
  const { toast } = useToast()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [typed, setTyped] = useState('')
  const [addr, setAddr] = useState<RcqAddress | null>(null)
  const [page, setPage] = useState<SitePage | null>(null)
  /// A link out of the network, waiting for the reader to say yes.
  const [external, setExternal] = useState<string | null>(null)
  const [externalRemember, setExternalRemember] = useState(false)
  const [error, setError] = useState<ErrorKind | null>(null)
  const [loading, setLoading] = useState(false)
  const [catalogue, setCatalogue] = useState<CatalogueEntry[]>([])
  const [recentsAll, setRecents] = useState<SiteRecent[]>(() => readRecents())
  /// `name@host` → the site's mark as a data URI, or null once we know there
  /// is none. Keyed with the island, not the name alone: a recent from
  /// another island may share its name with a site on this one.
  const [icons, setIcons] = useState<Record<string, string | null>>({})
  const [mine, setMine] = useState(false)
  const [focused, setFocused] = useState(false)
  /// The address being handed to a chat, while the picker is up.
  const [sharing, setSharing] = useState<string | null>(null)
  // The author of a site, tapped. Holds the number while the add sheet is up.
  const [addOwner, setAddOwner] = useState<number | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  /// Bumped by every open and by every return to the catalogue: a fetch
  /// that lands after the reader has moved on is dropped, not drawn over
  /// wherever they moved on to.
  const turn = useRef(0)

  // "My island" for a bare `name.rcq`, taken from this session's own API base:
  // a person's first site is reachable before they know what an island is.
  const ownHost = identity ? new URL(identity.apiBase).host : 'api.rcq.app'

  // The recents this account can reach by address. The list is the device's,
  // not the account's, and an island only reachable as "my island" (a
  // self-hosted one under a domain of its own) has no address from anywhere
  // else - the grammar names islands as `<label>.rcq.app` or by port. Such a
  // row under another account would open to an address error, so it waits
  // for the account it belongs to rather than sitting there dead.
  //
  // ⚠ Memoised, and not for tidiness: this list is a dependency of the mark
  // effect below. A fresh array on every render made that effect run after
  // every render, and it sets state, so the screen re-rendered for as long as
  // it was mounted and asked each island for the same manifest again and
  // again.
  const recents = useMemo(
    () => recentsAll.filter((r) => parseRcqAddress(displayAddress(r.name, r.host, ownHost), ownHost)),
    [recentsAll, ownHost],
  )

  /// The fetch itself. Moving between pages of one site and reloading call
  /// this directly; opening a site by address goes through `go` and the URL.
  const open = useCallback(async (raw: string, path = 'index.html', fresh = false) => {
    const mine = ++turn.current
    const parsed = parseRcqAddress(raw, ownHost)
    if (!parsed) {
      setError('address')
      setPage(null)
      setAddr(null)
      setTyped(raw)
      return
    }
    // The bar shows the address from the moment it is asked for, the way a
    // browser does, so an error that follows is an error FOR that address
    // and Back knows what it is leaving.
    setAddr(parsed)
    setTyped(parsed.display)
    setLoading(true)
    setError(null)
    try {
      const got = await fetchSitePage(parsed, path, fresh)
      if (mine !== turn.current) return
      setPage(got)
      // A site that opened is a site this device has been to. Only one that
      // opened: an address that failed is not a place, and a row for it on
      // the start screen would fail again.
      setRecents(noteRecent(parsed, got.title))
      void fetchSiteIcon(parsed, fresh).then((uri) => setIcons((cur) => ({ ...cur, [recentKey(parsed)]: uri })))
    } catch (e) {
      if (mine !== turn.current) return
      const kind = e instanceof Error ? e.message : 'missing'
      setPage(null)
      setError((ERRORS as readonly string[]).includes(kind) ? (kind as ErrorKind) : 'missing')
    } finally {
      if (mine === turn.current) setLoading(false)
    }
  }, [ownHost])

  // The `a` param IS the reader's position. Opening a site pushes `?a=`,
  // the way back pushes the bare `/sites`, and this effect does the actual
  // opening and clearing for both - so the browser's own Back and Forward,
  // the chevron in the capsule and an address handed in from a chat (a
  // tapped `.rcq` name lands on the page, not on an empty bar) all go
  // through one door and cannot disagree about where the reader is. `p` is
  // the page a link with a path asked for (`https://e2ee.rcq/en.html`);
  // moving between pages from inside the site does not touch the URL.
  const asked = params.get('a')
  const askedPage = params.get('p')
  useEffect(() => {
    if (asked) {
      void open(asked, isPagePath(askedPage) ? (askedPage as string) : 'index.html')
      return
    }
    // Back to the catalogue: nothing of the page survives, and a fetch still
    // in flight for it is disowned rather than allowed to land on top.
    turn.current++
    setPage(null)
    setAddr(null)
    setError(null)
    setTyped('')
    setLoading(false)
    setRecents(readRecents())
    // Deliberately only on the address itself: re-running this when `open`
    // changes identity would reload the page under a reader who has since
    // navigated somewhere else in the same site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, askedPage])

  /// Open a site by address. Every way of asking for one - Enter in the bar,
  /// a catalogue row, one's own site in the panel, a link inside a page -
  /// lands here, and here means the URL, not the fetch: the effect above does
  /// the rest. `page` is for a link that named one.
  /**
   * Where tapping a site's author goes.
   *
   * A contact opens the conversation, which is what it always did and what you
   * want. Anybody else opens "add contact" already looking at their number,
   * because a thread with a stranger has nothing in it but a line explaining
   * that they are a stranger — a dead end reached by doing the obvious thing
   * (founder, 03.09).
   *
   * ⚠ The membership test reads the warm contacts cache, so a cold cache can
   * send an existing contact to the add sheet by mistake. That way round is
   * survivable: the sheet shows them, already added, and the conversation is
   * one tap further. The other way round is the dead end being fixed.
   */
  const openOwner = useCallback((uin: number) => {
    if (!identity) return
    if (lookupContactName(identity.uin, uin)) navigate(`/chat/${uin}`)
    else setAddOwner(uin)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.uin, navigate])

  const go = useCallback((raw: string, wantedPage?: string | null) => {
    // Typed with a scheme, the way people type every other address: the
    // scheme goes, and a path becomes the page.
    const link = siteLinkOf(raw)
    const address = link?.address ?? raw
    const wanted = wantedPage ?? link?.page ?? null
    const display = parseRcqAddress(address, ownHost)?.display ?? address.trim()
    if (display === asked && (wanted ?? 'index.html') === (askedPage || 'index.html')) {
      // The params do not change, so the effect will not fire, and for the
      // page already up that is the point. Enter on an address that failed
      // is a retry, though, and from an inner page it asks for the front.
      if (!page || page.path !== (wanted ?? 'index.html')) void open(address, wanted ?? 'index.html')
      return
    }
    navigate(`/sites?a=${encodeURIComponent(display)}${wanted ? `&p=${encodeURIComponent(wanted)}` : ''}`)
  }, [asked, askedPage, navigate, open, ownHost, page])

  // The catalogue of the reader's own island: what there is to look at at all,
  // and only the sites that asked to be in it.
  useEffect(() => {
    void fetchCatalogue(ownHost).then(setCatalogue)
  }, [ownHost])

  // Marks are fetched one by one after the list is drawn, and each is checked
  // against the owner's signature before it is shown. A list that waited for
  // them would be a list that an offline site could hold up.
  //
  // ⚠⚠ Only from THIS island. A recent row on someone else's island is drawn
  // with its letter, not with its mark: asking for the mark would tell that
  // island "this address still has me in its list" every time the reader
  // merely opens the browser, and the promise at the top of this file is that
  // an island learns about a reader when the reader opens something on it.
  // The mark of a foreign site is fetched when it is opened, which is a visit
  // that island sees anyway.
  //
  // ⚠ An address whose mark is already in hand is not asked again: the effect
  // runs whenever the catalogue or the recents change, and without this a list
  // that grew by one row re-fetched every mark it already had. The set is
  // filled where the mark ARRIVES, not where it is asked for - React mounts a
  // screen twice in development, and a set filled on the way out made the
  // second mount skip every address whose first-mount answer had just been
  // thrown away, so no marks appeared at all.
  const haveMarks = useRef<Set<string>>(new Set())
  useEffect(() => {
    let live = true
    const wanted: RcqAddress[] = []
    for (const s of catalogue) {
      const a = parseRcqAddress(`${s.name}.rcq`, ownHost)
      if (a) wanted.push(a)
    }
    for (const r of recents) {
      if (r.host !== ownHost) continue
      wanted.push({ name: r.name, host: r.host, display: displayAddress(r.name, r.host, ownHost) })
    }
    for (const a of wanted) {
      const key = recentKey(a)
      if (haveMarks.current.has(key)) continue
      void fetchSiteIcon(a).then((uri) => {
        if (!live) return
        haveMarks.current.add(key)
        setIcons((cur) => (cur[key] === uri ? cur : { ...cur, [key]: uri }))
      })
    }
    return () => { live = false }
  }, [catalogue, recents, ownHost])

  /// Where a click inside the page goes. Kept in a ref because the listener
  /// is attached to a document that is rewritten on every page, while the
  /// address and `open` it needs belong to whichever render is current.
  /// Out to the ordinary web. The desktop hands the address to the system
  /// browser (the webview opens nothing itself); the browser build opens a tab.
  /// Either way it leaves this app, which is the part worth a confirmation.
  function leaveForTheWeb(url: string) {
    void openExternal(url).then((took) => {
      if (!took) window.open(url, '_blank', 'noopener,noreferrer')
    })
  }

  const route = useRef<(pageMark: string | null, externalMark: string | null) => void>(() => {})
  route.current = (pageMark, externalMark) => {
    // A page of the same bundle: the sanitiser marked it (lib/sites), so
    // this is a file the manifest signs, never something the author typed
    // into the attribute.
    const inner = pageMark
    if (inner) {
      // A page, not any file the manifest happens to sign. The sanitiser
      // marks every in-bundle link, and a 2000s page links its full-size
      // photographs that way; opening one decoded its bytes as text and
      // painted the result. Such a link stays inert, as it was before.
      if (addr && isPagePath(inner)) void open(addr.display, inner)
      return
    }
    // Another site, bare or with a scheme: the reader, by the same door as a
    // name tapped in a chat. Every other link stays what it is - text.
    //
    // ⚠ A name with no island in it belongs to the island THIS page came
    // from, the way a bare name in a web page belongs to the site's own zone.
    // Resolved against the reader's island instead, an author on the flagship
    // writing `e2ee.rcq` sent every reader on another island to whoever
    // happens to hold that name over there.
    const raw = externalMark ?? ''
    const link = siteLinkOf(raw)
    if (!link) {
      // Not an address in this network. If it is an ordinary web link, it is
      // allowed to be one: the reader is told they are leaving and decides.
      // Anything else stays what it always was, which is text.
      if (/^https?:\/\//i.test(raw)) {
        if (externalAlwaysAllowed()) leaveForTheWeb(raw)
        else setExternal(raw)
      }
      return
    }
    const bare = parseRcqAddress(link.address, addr ? addr.host : ownHost)
    const address = addr && bare && bare.host === (addr ? addr.host : ownHost)
      ? displayAddress(bare.name, addr.host, ownHost)
      : link.address
    go(address, link.page)
  }

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
    if (!html) return true
    // Links that go somewhere inside the network get a pointer, so a reader
    // can tell them from the ones that are text. Marked here, in our chrome,
    // after the sanitiser has had the last word on what the page contains.
    //
    // ⚠⚠ AND EACH ONE GETS A REAL `href`, pointing at a fragment of the frame
    // itself. The listener below is the fast path and it works in Chromium,
    // but in WebKit a listener the parent attaches to the frame's document
    // never fires, so on the packaged desktop app every link inside a page was
    // dead (founder, 05.09: the language links on home.rcq do nothing). A
    // fragment href needs no listener and no script inside the frame: the
    // click moves the frame's own location, and the poll further down reads
    // it back. The value is still ours, written here, after the sanitiser
    // stripped whatever the author wrote.
    for (const a of Array.from(doc.querySelectorAll('a[data-rcq-external]'))) {
      const raw = a.getAttribute('data-rcq-external') ?? ''
      if (siteLinkOf(raw)) {
        a.setAttribute('data-rcq-site', '')
        a.setAttribute('href', '#rcq-site:' + encodeURIComponent(raw))
      } else if (/^https?:\/\//i.test(raw)) {
        a.setAttribute('data-rcq-web', '')
        a.setAttribute('href', '#rcq-web:' + encodeURIComponent(raw))
      }
    }
    for (const a of Array.from(doc.querySelectorAll('a[data-rcq-page]'))) {
      a.setAttribute('href', '#rcq-page:' + encodeURIComponent(a.getAttribute('data-rcq-page') ?? ''))
    }
    const style = doc.createElement('style')
    style.textContent = 'a[data-rcq-page],a[data-rcq-site],a[data-rcq-web]{cursor:pointer}'
    doc.head?.appendChild(style)
    // ⚠ Attached AFTER the write, every time: document.open() discards every
    // listener on the document, so one attached once would be gone with the
    // first page. The listener is ours, created in the app's own realm, which
    // is why it runs at all in a frame whose own scripts are off - and that
    // is the whole arrangement: the page cannot navigate, we can.
    doc.addEventListener(
      'click',
      (e) => {
        const a = (e.target as Element | null)?.closest?.('a')
        if (!a) return
        // Nothing inside a page navigates by itself, whatever the anchor
        // says: the two kinds that go somewhere are routed by our chrome,
        // and the rest do nothing, exactly as before.
        e.preventDefault()
        route.current(a.getAttribute('data-rcq-page'), a.getAttribute('data-rcq-external'))
      },
      true,
    )
    return true
  }, [])

  useEffect(() => {
    const html = page?.html ?? ''
    if (paint(html)) return
    // The frame is mounted a tick after this effect on a first open.
    const t = setTimeout(() => paint(html), 50)
    return () => clearTimeout(t)
  }, [page, paint])

  // The other half of the fragment trick above: in WebKit nothing tells us the
  // frame moved, because a `hashchange` attached from out here is gated the
  // same way the click listener is. So the frame's own location is read on a
  // timer while a page is open. In Chromium the click listener has already
  // routed and cleared, and this finds nothing to do.
  useEffect(() => {
    if (!page) return
    let last = ''
    const id = setInterval(() => {
      const w = frameRef.current?.contentWindow
      let hash = ''
      try { hash = w?.location?.hash ?? '' } catch { return }
      if (hash.length < 2 || hash === last) return
      last = hash
      try { if (w) w.location.hash = '' } catch { /* keep `last` as the guard */ }
      const mark = hash.slice(1)
      const sep = mark.indexOf(':')
      if (sep < 0) return
      const kind = mark.slice(0, sep)
      const value = decodeURIComponent(mark.slice(sep + 1))
      if (kind === 'rcq-page') route.current(value, null)
      else if (kind === 'rcq-site' || kind === 'rcq-web') route.current(null, value)
    }, 200)
    return () => clearInterval(id)
  }, [page])

  /// The share picked a chat: the address goes there as an ordinary text
  /// message (#852), by the same path a forward takes.
  async function shareTo(target: ForwardTarget) {
    if (!identity || !sharing) return
    try {
      await sendTextTo(identity, target, sharing)
      if (isSentSoundEnabled()) playSound('message_sent')
      setSharing(null)
      toast(`${t('chat.forward.sent')}: ${target.name}`)
    } catch (e) {
      toast(
        e instanceof SendTextError ? t(`chat.error.${e.code}`) : e instanceof Error ? e.message : t('chat.error.send_failed'),
        'error',
      )
    }
  }

  /// The share picked the clipboard instead: how an address leaves the app.
  function copyShared() {
    if (!sharing) return
    void navigator.clipboard?.writeText(sharing).catch(() => {})
    setSharing(null)
    toast(t('chat.copied'))
  }

  // The start screen, in three parts (founder, 02.09): what the island put
  // at the top, what this device opened last, and the rest of the catalogue
  // with those two taken out of it.
  // The three are a partition: a site appears in one of them, never twice.
  // Nearly everybody opens the pinned site first, so without this the flagship's
  // own page stood under PINNED and again under RECENT.
  const pinned = catalogue.filter((s) => s.featured)
  const pinnedKeys = new Set(pinned.map((s) => recentKey({ name: s.name, host: ownHost })))
  const recentRows = recents.filter((r) => !pinnedKeys.has(recentKey(r)))
  const shown = new Set<string>(pinnedKeys)
  for (const r of recentRows) shown.add(recentKey(r))
  const rest = catalogue.filter((s) => !shown.has(recentKey({ name: s.name, host: ownHost })))

  // Idle on a page the capsule carries the site's mark and the reload glyph;
  // focused it is a plain text field and both go.
  const idleOnPage = !!page && !focused

  const catalogueRow = (s: CatalogueEntry) => (
    <SiteRow
      key={s.name}
      name={s.name}
      address={`${s.name}.rcq`}
      title={s.title}
      ownerUin={s.owner_uin}
      icon={icons[recentKey({ name: s.name, host: ownHost })]}
      onOpen={() => go(`${s.name}.rcq`)}
      onShare={() => setSharing(`${s.name}.rcq`)}
      onOwner={openOwner}
      t={t}
    />
  )

  return (
    <div className="h-screen [height:calc(100dvh-var(--rcq-titlebar-inset))] pt-[var(--rcq-top-inset)] flex flex-col bg-surface-dim overflow-hidden">
      {/* One capsule across the row, the way a desktop browser does it: the
          address IS the control, and the way back lives inside it, at the
          left edge. On a page, or on an error for an address, the chevron
          returns to the catalogue; only from the catalogue does it leave the
          browser (founder, 02.09). Idle the address sits centred in the
          capsule, the site's mark on its left and the share and reload
          glyphs on its right; focused it becomes an ordinary text field,
          left-aligned and selected, and Enter opens. There is no Open
          button - a button beside an address bar is a second way to do the
          thing the Return key already does (founder, 01.09). */}
      <header className="rcq-header sticky top-0 z-10 shrink-0">
        <div className="max-w-3xl mx-auto px-3 h-14 flex items-center gap-1.5">
          <form
            className={`group flex-1 flex items-center gap-2 h-9 px-1.5 rounded-full bg-field transition-shadow ${
              focused ? 'ring-1 ring-accent' : 'hover:bg-line/40'
            }`}
            onSubmit={(e) => {
              e.preventDefault()
              go(typed)
              inputRef.current?.blur()
            }}
          >
            {/* The two ends of the capsule are the same width whatever is in
                them, so a centred address is centred in the CAPSULE rather
                than in what is left between the mark and the glyphs. With the
                chevron and the mark on one side and a single glyph on the
                other, that leftover sat to the right, and so did the domain
                (founder, 02.09). 26px is the chevron with its padding; 56
                holds the gap and the 18px mark on the left, and the share
                and reload glyphs with their gap on the right. */}
            <div className={`flex-none flex items-center gap-2 ${idleOnPage ? 'w-[56px]' : 'w-[26px]'}`}>
              <button
                type="button"
                onClick={() => navigate(asked ? '/sites' : '/contacts')}
                className="flex-none p-1 text-fg-secondary hover:text-fg-primary"
                title={t('sites.back')}
                aria-label={t('sites.back')}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
              {/* The mark stands in for the padlock a browser puts here, and it
                  means the same thing: this is the site it says it is, checked
                  against the owner's signature. */}
              {idleOnPage && addr && (
                <SiteMark name={addr.name} uri={icons[recentKey(addr)]} size={18} />
              )}
            </div>
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
                  go(e.currentTarget.value)
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
                focused ? 'text-left' : 'text-center'
              }`}
            />
            <div className={`flex-none flex items-center justify-end gap-2 ${idleOnPage ? 'w-[56px]' : 'w-[26px]'}`}>
              {/* Share: the address of the page that is up, into a chat or
                  onto the clipboard (#852). Next to reload, where a browser
                  keeps it. */}
              {idleOnPage && addr && (
                <button
                  type="button"
                  onClick={() => setSharing(addr.display)}
                  className="flex-none p-1 text-fg-dim hover:text-fg-primary"
                  title={t('sites.share')}
                  aria-label={t('sites.share')}
                >
                  <ShareGlyph size={15} />
                </button>
              )}
              {/* Reload, and it really reloads: the bundle is served with a five
                  minute cache, which is right for reading and wrong for somebody
                  who just republished. */}
              {idleOnPage && page && (
                <button
                  type="button"
                  onClick={() => addr && void open(addr.display, page.path, true)}
                  className="flex-none p-1 text-fg-dim hover:text-fg-primary"
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
            </div>
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
          inside a page cannot navigate on its own - so the doors live out
          here too, beside the links the page itself carries. */}
      {/* The strip belongs to the header, not to the page: the same blurred
          surface, so the chrome above a site reads as one bar (founder, 02.09)
          rather than a blurred strip stacked on a flat one. */}
      {page && page.pages.length > 1 && (
        <nav className="rcq-header shrink-0 border-b border-border">
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
            {pinned.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs uppercase tracking-wide text-fg-dim">{t('sites.pinned')}</div>
                {pinned.map(catalogueRow)}
              </div>
            )}
            {recentRows.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs uppercase tracking-wide text-fg-dim">{t('sites.recents')}</div>
                {recentRows.map((r) => {
                  const address = displayAddress(r.name, r.host, ownHost)
                  // Who a site belongs to is not in the bundle: the signed
                  // manifest carries no owner, only this island's catalogue
                  // does, and only when the author asked to be named. A recent
                  // is stored as name/host/title, so the byline is joined back
                  // on here from the catalogue already in state. A recent on
                  // somebody else's island stays bare on purpose: the start
                  // screen does not ask foreign islands anything.
                  const owner =
                    r.host === ownHost
                      ? catalogue.find((c) => c.name === r.name)?.owner_uin ?? null
                      : null
                  return (
                    <SiteRow
                      key={recentKey(r)}
                      name={r.name}
                      address={address}
                      title={r.title}
                      icon={icons[recentKey(r)]}
                      onOpen={() => go(address)}
                      onShare={() => setSharing(address)}
                      onRemove={() => setRecents(forgetRecent(recentKey(r)))}
                      ownerUin={owner}
                      onOwner={openOwner}
                      t={t}
                    />
                  )
                })}
              </div>
            )}
            {rest.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs uppercase tracking-wide text-fg-dim">{t('sites.catalogue')}</div>
                {rest.map(catalogueRow)}
              </div>
            )}
          </div>
        )}

        {!error && page && (
          <div className="h-full flex flex-col">
            {/* A frameset: the parts exist, the page that pointed at them
                cannot be drawn, so the doors are offered here rather than
                leaving the reader with a blank rectangle. */}
            {page.frameset && (
              <div className="px-4 py-2 text-xs bg-field text-fg-secondary flex items-center gap-2 flex-wrap">
                <span>{page.frames.length > 0 ? t('sites.frameset') : t('sites.frameset.missing')}</span>
                {page.frames.map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => addr && void open(addr.display, f)}
                    className="font-mono text-fg-primary hover:text-accent underline underline-offset-2"
                  >
                    {f}
                  </button>
                ))}
              </div>
            )}
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
          onOpen={(name) => { setMine(false); go(`${name}.rcq`) }}
        />
      )}

      {/* Sharing an address is picking a chat (#852): the same picker a
          forward uses, with the clipboard as the one row that is not a chat. */}
      {addOwner != null && (
        <AddContactModal initialQuery={`#${addOwner}`} onClose={() => setAddOwner(null)} />
      )}
      {/* Leaving the network. A site may link into the ordinary web, but not
          quietly: the address is shown in full, because the text of a link and
          where it goes are two different things and only one of them is
          checkable. */}
      {external && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-md sm:items-center p-0 sm:p-4">
          <div className="w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl bg-surface p-5 space-y-4">
            <div className="space-y-2">
              <h2 className="text-base font-semibold">{t('sites.external.title')}</h2>
              <p className="text-sm text-fg-secondary">{t('sites.external.body')}</p>
              <p className="break-all rounded-xl bg-field px-3 py-2 font-mono text-xs text-fg-primary">{external}</p>
            </div>
            <label className="flex items-center gap-2 text-sm text-fg-secondary">
              <input
                type="checkbox"
                checked={externalRemember}
                onChange={(e) => setExternalRemember(e.target.checked)}
                className="h-4 w-4 accent-accent"
              />
              {t('sites.external.remember')}
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => { setExternal(null); setExternalRemember(false) }}
                className="flex-1 h-11 rounded-xl bg-field text-sm font-medium text-fg-secondary hover:bg-fg-primary/[0.09] transition"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => {
                  if (externalRemember) setExternalAlwaysAllowed(true)
                  leaveForTheWeb(external)
                  setExternal(null)
                  setExternalRemember(false)
                }}
                className="flex-1 h-11 rounded-xl bg-accent text-sm font-semibold text-white hover:bg-accent-dim transition"
              >
                {t('sites.external.open')}
              </button>
            </div>
          </div>
        </div>
      )}
      <ForwardModal
        visible={sharing != null}
        onClose={() => setSharing(null)}
        onPick={shareTo}
        title={t('sites.share.title')}
        lead={{ label: t('sites.share.copy'), onPick: copyShared }}
      />
    </div>
  )
}

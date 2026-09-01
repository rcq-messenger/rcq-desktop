// Resolving `.rcq` addresses, verifying bundles, and preparing a page for the
// locked frame.
//
// ⚠⚠ There is no DNS anywhere in here, and that is the design rather than a
// shortcut: `.rcq` is not a domain, it is a marker that says "this name is
// resolved inside the network". The name is parsed on THIS device into an
// island and a site, and the request goes straight to that island. Nothing
// about what a person reads passes through a resolver, and their own island is
// not asked either - proxying would hand its operator a journal of what its
// users read elsewhere.
//
// ⚠⚠ The island is not trusted with the bytes. Every bundle carries a manifest
// signed by the owner's key with a hash per file; this module verifies the
// signature, then verifies each file it fetches against that manifest. The
// island can refuse to serve a site, it cannot alter one.

import { ed25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha256'
import { b64ToBytes } from './crypto'
import { canonicalJSON } from './federation'

export interface RcqAddress {
  /// Site name inside the island's zone.
  name: string
  /// Island host to ask, already resolved from the address.
  host: string
  /// What to show in the address bar: `blog.is2.rcq`.
  display: string
}

export interface SiteManifest {
  v: number
  name: string
  version: number
  /// Ed25519 public key (base64) the bundle is signed under.
  key: string
  /// path → sha256 hex of the file's bytes.
  files: Record<string, string>
  sig: string
  title?: string
  /// The site's mark, a path inside the bundle. Inside the SIGNATURE on
  /// purpose: this is what a site looks like in a list of sites, and an island
  /// that could choose it could dress one site up as another.
  icon?: string
}

export interface SitePage {
  /// Ready for the frame: assets inlined, everything outward removed.
  html: string
  /// Which file of the bundle this is.
  path: string
  /// Every `.html` in the bundle, so the reader can move between pages
  /// without a single script running inside the frame.
  pages: string[]
  version: number
  key: string
  /// We had a different key pinned for this name. Trust on first use, the same
  /// rule as safety numbers: the island may serve other bytes, it may not pass
  /// them off as the same site.
  keyChanged: boolean
}

/// Errors this module throws, by `message`. The screen turns them into text.
export type SiteError = 'address' | 'missing' | 'frozen' | 'unsigned' | 'tampered' | 'offline'

const PINS_KEY = 'rcq.web.sitePins'

/// Icons already fetched and checked this session, keyed by `name@host`. A
/// catalogue redraws often and an icon is the same bytes every time.
const iconCache = new Map<string, string | null>()

/// What a bundle may call its mark when the manifest does not say.
///
/// ⚠⚠ RASTER ONLY, and that is a network-wide decision rather than this
/// screen's taste. A mark is drawn by OUR chrome, outside the locked frame:
/// on a phone that means an SVG would be handed to a native decoder with no
/// sandbox around it and no sanitiser in front of it, and iOS has no native
/// SVG renderer at all. PNG and WebP are decoded by the same code that draws
/// every avatar in the app already.
const ICON_NAMES = ['icon.png', 'icon.webp', 'favicon.png']

/// `blog.is2.rcq` → { name: blog, host: is2.rcq.app }.
///
/// A bare `blog.rcq` means "on my own island", which is what makes somebody's
/// first site reachable before they know what an island is.
export function parseRcqAddress(raw: string, ownHost: string): RcqAddress | null {
  const cleaned = raw.trim().toLowerCase().replace(/^rcq:\/\//, '').replace(/\/+$/, '')
  if (!cleaned.endsWith('.rcq')) return null
  const parts = cleaned.slice(0, -'.rcq'.length).split('.').filter(Boolean)
  if (parts.length === 0 || parts.length > 2) return null
  const name = parts[0]
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) return null
  const island = parts[1]
  const host = island ? islandHostFromLabel(island, ownHost) : ownHost
  return { name, host, display: cleaned }
}

/// The island label → host mapping. An unknown label is treated as a hostname
/// so an operator can hand out an address before the clients know the island.
function islandHostFromLabel(label: string, ownHost: string): string {
  if (label === 'flagship' || label === 'rcq') return 'api.rcq.app'
  if (label === 'is2') return 'is2.rcq.app'
  if (label === 'here' || label === 'my') return ownHost
  return label.includes('.') || label.includes(':') ? label : `${label}.rcq.app`
}

/// Everything is https except a developer's own machine: an island is a
/// public host, and the one exception is spelled out rather than inferred.
function originOf(host: string): string {
  const local = host === 'localhost' || host.startsWith('localhost:') ||
    host === '127.0.0.1' || host.startsWith('127.0.0.1:')
  return `${local ? 'http' : 'https'}://${host}`
}

function readPins(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(PINS_KEY) || '{}') as Record<string, string>
  } catch {
    return {}
  }
}

/// The identity a pin belongs to: the site and the island that serves it,
/// never the string somebody typed. `blog.rcq` on your own island and
/// `blog.flagship.rcq` are one site; keyed by what was typed they would have
/// been two pins, and a key change would have gone unseen on the other one.
function pinKey(addr: RcqAddress): string {
  return `${addr.name}@${addr.host}`
}

/// Returns true when this name was pinned to a DIFFERENT key before.
function pin(display: string, key: string): boolean {
  const pins = readPins()
  const known = pins[display]
  if (known && known !== key) return true
  if (!known) {
    pins[display] = key
    try { localStorage.setItem(PINS_KEY, JSON.stringify(pins)) } catch { /* private mode */ }
  }
  return false
}

/// Forget the pin for a name, after the reader decided to trust the new key.
export function repin(addr: RcqAddress, key: string): void {
  const display = pinKey(addr)
  const pins = readPins()
  pins[display] = key
  try { localStorage.setItem(PINS_KEY, JSON.stringify(pins)) } catch { /* private mode */ }
}

/// Is this path in the bundle? `m.files[path]` looks like the same question
/// and is not: the value is a hash, so a truthiness test also answers "yes" to
/// anything inherited from Object.prototype (`constructor`, `toString`), and
/// "no" to a legitimate entry whose hash is somehow empty.
function hasFile(m: SiteManifest, path: string): boolean {
  return Object.prototype.hasOwnProperty.call(m.files, path)
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

async function get(url: string, fresh = false): Promise<Response> {
  // ⚠ `credentials: omit` is not hygiene, it is the feature: a read carries no
  // token, so the island cannot tie a page to a person.
  //
  // `fresh` is the reload button: a bundle is served with a five-minute cache,
  // which is right for reading and wrong for a person who just republished and
  // wants to see it.
  let res: Response
  try {
    res = await fetch(url, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: fresh ? 'reload' : 'default',
    })
  } catch {
    throw new Error('offline' satisfies SiteError)
  }
  if (res.status === 410) throw new Error('frozen' satisfies SiteError)
  if (!res.ok) throw new Error('missing' satisfies SiteError)
  return res
}

/// Fetch the manifest and check the owner's signature over it.
export async function fetchManifest(addr: RcqAddress, fresh = false): Promise<SiteManifest> {
  const res = await get(`${originOf(addr.host)}/sites/${encodeURIComponent(addr.name)}/manifest.json`, fresh)
  let m: SiteManifest
  try {
    m = (await res.json()) as SiteManifest
  } catch {
    throw new Error('unsigned' satisfies SiteError)
  }
  if (!m || typeof m.key !== 'string' || typeof m.sig !== 'string' || !m.files) {
    throw new Error('unsigned' satisfies SiteError)
  }
  const { sig, ...signed } = m
  let ok = false
  try {
    ok = ed25519.verify(b64ToBytes(sig), new TextEncoder().encode(canonicalJSON(signed)), b64ToBytes(m.key))
  } catch {
    ok = false
  }
  // The name is inside the signature too: without it, a manifest signed for
  // one site could be replayed under another name on the same island.
  if (!ok || m.name !== addr.name) throw new Error('unsigned' satisfies SiteError)
  return m
}

/// Fetch one file and check it against the manifest's hash.
async function fetchFile(addr: RcqAddress, m: SiteManifest, path: string, fresh = false): Promise<Uint8Array> {
  const want = hasFile(m, path) ? m.files[path] : null
  if (!want) throw new Error('missing' satisfies SiteError)
  const res = await get(`${originOf(addr.host)}/sites/${encodeURIComponent(addr.name)}/${path}`, fresh)
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (hex(sha256(bytes)) !== want) throw new Error('tampered' satisfies SiteError)
  return bytes
}

/// Types a bundle image may be turned into. SVG is here for pictures INSIDE a
/// page, where the locked frame and its policy apply; `iconPathOf` refuses it
/// for the mark, which our own chrome draws.
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
}

function dataUri(path: string, bytes: Uint8Array): string | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const type = IMAGE_TYPES[ext]
  if (!type) return null
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return `data:${type};base64,${btoa(bin)}`
}

/// Resolve `../a/b.png` against the page's own path, inside the bundle only.
function resolve(from: string, ref: string): string | null {
  if (/^[a-z]+:/i.test(ref) || ref.startsWith('//') || ref.startsWith('#')) return null
  const base = from.split('/').slice(0, -1)
  const out: string[] = ref.startsWith('/') ? [] : base
  for (const seg of ref.replace(/^\//, '').split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/') || null
}

/// Turn the bundle's HTML into a single self-contained document.
///
/// Everything that could reach the network or run is removed here rather than
/// merely blocked by the frame: two locks, because the frame's rules are the
/// browser's promise and this one is ours.
/// What a page may contain. An ALLOW-LIST, not a list of things to remove:
/// a deny-list is a promise that we thought of everything, and the web keeps
/// inventing elements. Anything not named here is unwrapped (its text stays,
/// the element goes), so an unknown tag costs a page its styling and never
/// its content.
const ALLOWED_TAGS = new Set([
  'html', 'head', 'body', 'title', 'style', 'meta',
  'div', 'span', 'p', 'br', 'hr', 'section', 'article', 'main', 'aside', 'nav',
  'header', 'footer', 'figure', 'figcaption', 'blockquote', 'pre', 'code', 'kbd', 'samp',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'a', 'img', 'strong', 'b', 'em', 'i', 'u', 's', 'small', 'sub', 'sup', 'mark',
  'time', 'abbr', 'cite', 'q', 'ruby', 'rt', 'rp', 'wbr', 'details', 'summary',
])

/// Attributes that may survive on any element. Everything else goes, which
/// covers `on*`, `ping`, `srcset`, `formaction`, `xlink:href` and whatever is
/// invented next without us having to name it.
const ALLOWED_ATTRS = new Set([
  'class', 'id', 'title', 'lang', 'dir', 'alt', 'width', 'height',
  'colspan', 'rowspan', 'headers', 'scope', 'span', 'datetime', 'cite', 'open',
  'start', 'reversed', 'value', 'charset',
])

/// Author CSS is kept, but never anything that fetches, and never anything
/// that can climb out of the `<style>` element it is written into.
///
/// The order matters and each pass exists because a conformance case walked
/// through the previous version (docs/rcq-sites-conformance.json):
///
/// 1. Comments go first: `/*…*/` can sit inside a property value and split a
///    keyword the later passes look for.
/// 2. CSS escapes are DECODED next, not deleted. `\75 rl(` IS `url(` to a
///    conforming parser and `@\69 mport` IS `@import`, so a scanner reading
///    the raw text sees neither. Deleting the escape leaves `rl(` and the
///    address it points at sitting in the file, inert but present; decoding
///    hands the real keyword to the passes below, which then neutralise it
///    like any other.
/// 3. `</style` is neutralised. The text is written into a `<style>` element
///    and serialised verbatim, so a stylesheet carrying that sequence closes
///    the element and everything after it is markup that never went through
///    the sanitiser. ⚠⚠ On the web the frame's CSP still refuses to run it;
///    the phones have no CSP, so this is the pass that has to hold there.
/// 4. Then the fetching constructs: @import in both its forms (a semicolon is
///    not required before a block), @font-face, image-set() which takes bare
///    strings and needs no url() at all, and url() itself unless it is an
///    inlined data: image.
function cleanCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?(\*\/|$)/g, '')
    .replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\(.)/g,
             (_m, hex, ch) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : ch))
    .replace(/<\s*\/\s*style/gi, '')
    .replace(/@import[^;{]*(;|(?=\{)|$)/gi, '')
    .replace(/@font-face\s*\{[^}]*\}/gi, '')
    .replace(/(-\w+-)?image-set\s*\([^)]*\)/gi, 'none')
    .replace(/url\(\s*(?:'\s*data:|"\s*data:|data:)[^)]*\)|url\([^)]*\)/gi,
             (m) => (/url\(\s*['"]?\s*data:/i.test(m) ? m : 'none'))
}

/// Turn the bundle's HTML into a single self-contained document.
///
/// Everything that could reach the network or run is removed here rather than
/// merely blocked by the frame: two locks, because the frame's rules are the
/// browser's promise and this one is ours.
/// Turn the bundle's HTML into a single self-contained document.
///
/// Everything that could reach the network or run is removed here rather than
/// merely blocked by the frame: two locks, because the frame's rules are the
/// browser's promise and this one is ours. The phones will have this half and
/// no CSP, so this is the half that has to be right.
async function inline(addr: RcqAddress, m: SiteManifest, path: string, html: string): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html')

  // Stylesheets first: a <link> is resolved into a <style> before the
  // allow-list walk, which then treats it like any author style block.
  for (const el of Array.from(doc.querySelectorAll('link'))) {
    const rel = (el.getAttribute('rel') || '').toLowerCase()
    const href = resolve(path, el.getAttribute('href') || '')
    if (rel !== 'stylesheet' || !href || !hasFile(m, href)) { el.remove(); continue }
    try {
      const css = new TextDecoder().decode(await fetchFile(addr, m, href))
      const style = doc.createElement('style')
      style.textContent = cleanCss(css)
      el.replaceWith(style)
    } catch {
      el.remove()
    }
  }

  // Elements that carry executable or fetching content whatever we do with
  // their attributes. Removed WITH their children, unlike the unwrap below:
  // the text inside a <script> is code, not prose.
  doc.querySelectorAll('script, iframe, object, embed, form, video, audio, source, track, base, svg, math, canvas, template, noscript, portal')
    .forEach((el) => el.remove())

  // Comments are dropped rather than passed through: they carry build paths
  // and names their author forgot about, and every engine disagrees slightly
  // about where one ends - which is a disagreement between our four
  // implementations waiting to happen.
  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_COMMENT)
  const comments: Node[] = []
  while (walker.nextNode()) comments.push(walker.currentNode)
  comments.forEach((c) => c.parentNode?.removeChild(c))

  // ⚠ The page must not be able to write into the channel between the
  // sanitiser and our own chrome: an author-supplied data-rcq-page would be
  // kept by the allow-list below and read by the page list as ours.
  doc.querySelectorAll('[data-rcq-page], [data-rcq-external]').forEach((el) => {
    el.removeAttribute('data-rcq-page')
    el.removeAttribute('data-rcq-external')
  })

  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = resolve(path, img.getAttribute('src') || '')
    if (!src || !hasFile(m, src)) { img.remove(); continue }
    try {
      const uri = dataUri(src, await fetchFile(addr, m, src))
      if (!uri) { img.remove(); continue }
      img.setAttribute('src', uri)
    } catch {
      img.remove()
    }
  }

  for (const a of Array.from(doc.querySelectorAll('a'))) {
    const href = a.getAttribute('href') || ''
    const inner = resolve(path, href)
    if (inner && hasFile(m, inner)) {
      // An internal link: the frame has no scripts, so it cannot navigate.
      // The page list in our own chrome is the door, and the anchor says
      // where it points.
      a.setAttribute('data-rcq-page', inner)
      a.setAttribute('title', inner)
    } else {
      // ⚠ An outward link stays as TEXT and does nothing. A click on a link
      // out of the network is how a reader gets deanonymised; Tor's exit-node
      // problem is one we can simply not have.
      a.setAttribute('data-rcq-external', href)
      a.setAttribute('title', href)
    }
  }

  // The allow-list walk. Unknown elements are unwrapped rather than deleted,
  // and every attribute not on the list goes - including the `src` we just
  // wrote, so images are put back by hand below.
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase()
    if (!ALLOWED_TAGS.has(tag)) {
      el.replaceWith(...Array.from(el.childNodes))
      continue
    }
    for (const attr of Array.from(el.attributes)) {
      const n = attr.name.toLowerCase()
      const keep =
        ALLOWED_ATTRS.has(n) ||
        (tag === 'img' && n === 'src' && attr.value.startsWith('data:')) ||
        (tag === 'a' && (n === 'data-rcq-page' || n === 'data-rcq-external')) ||
        // A style attribute may stay only once it can no longer fetch.
        (n === 'style' && !/url\s*\(|@import/i.test(attr.value))
      if (!keep) el.removeAttribute(attr.name)
    }
    if (tag === 'style') el.textContent = cleanCss(el.textContent || '')
  }

  // Our own policy last, so it is not one of the attributes just stripped.
  const meta = doc.createElement('meta')
  meta.setAttribute('http-equiv', 'Content-Security-Policy')
  meta.setAttribute('content', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'")
  doc.head.prepend(meta)
  return `<!doctype html>${doc.documentElement.outerHTML}`
}

/// Open a page of a site: verify, inline, and report what the reader should
/// know about the key.
export async function fetchSitePage(addr: RcqAddress, path = 'index.html', fresh = false): Promise<SitePage> {
  const m = await fetchManifest(addr, fresh)
  const raw = new TextDecoder().decode(await fetchFile(addr, m, path, fresh))
  const html = await inline(addr, m, path, raw)
  return {
    html,
    path,
    // index.html first, the rest alphabetically: the front page is the front
    // page, whatever it sorts as.
    pages: Object.keys(m.files)
      .filter((f) => f.toLowerCase().endsWith('.html'))
      .sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b))),
    version: m.version,
    key: m.key,
    keyChanged: pin(pinKey(addr), m.key),
  }
}

/// Which file in this bundle is the site's mark, if any.
export function iconPathOf(m: SiteManifest): string | null {
  // ⚠ The manifest names the mark, so the extension has to be checked here
  // rather than trusted: `"icon": "anything.svg"` was drawn by our own chrome
  // until a conformance case walked through this line
  // (docs/rcq-sites-conformance.json, sanitiser[41]).
  const raster = (p: string) => /\.(png|webp)$/i.test(p) && hasFile(m, p)
  if (m.icon && raster(m.icon)) return m.icon
  return ICON_NAMES.find((n) => raster(n)) ?? null
}

/// The site's mark as a `data:` URI, verified the same way a page is: the
/// manifest signature covers its hash, and the bytes are checked against it.
/// Null when the site has no mark, or when anything about it does not check
/// out - a mark we cannot verify is not drawn at all.
export async function fetchSiteIcon(addr: RcqAddress, fresh = false): Promise<string | null> {
  const key = `${addr.name}@${addr.host}`
  if (fresh) iconCache.delete(key)
  const cached = iconCache.get(key)
  if (cached !== undefined) return cached
  let uri: string | null = null
  try {
    const m = await fetchManifest(addr, fresh)
    const path = iconPathOf(m)
    if (path) uri = dataUri(path, await fetchFile(addr, m, path, fresh))
  } catch {
    uri = null
  }
  iconCache.set(key, uri)
  return uri
}

/// The catalogue of an island: only the sites that asked to be in it.
export async function fetchCatalogue(host: string): Promise<Array<{ name: string; title: string | null }>> {
  try {
    const res = await fetch(`${originOf(host)}/sites`, { credentials: 'omit', referrerPolicy: 'no-referrer' })
    if (!res.ok) return []
    const rows = (await res.json()) as Array<{ name: string; title: string | null }>
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

/// Test seam. `inline` is the half that has no network in it once the bundle
/// is in hand, and the conformance corpus drives it directly
/// (docs/rcq-sites-conformance.json).
export const _internal = { islandHostFromLabel, resolve, readPins, cleanCss, inline }

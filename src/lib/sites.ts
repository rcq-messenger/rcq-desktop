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
export function repin(display: string, key: string): void {
  const pins = readPins()
  pins[display] = key
  try { localStorage.setItem(PINS_KEY, JSON.stringify(pins)) } catch { /* private mode */ }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

async function get(url: string): Promise<Response> {
  // ⚠ `credentials: omit` is not hygiene, it is the feature: a read carries no
  // token, so the island cannot tie a page to a person.
  let res: Response
  try {
    res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' })
  } catch {
    throw new Error('offline' satisfies SiteError)
  }
  if (res.status === 410) throw new Error('frozen' satisfies SiteError)
  if (!res.ok) throw new Error('missing' satisfies SiteError)
  return res
}

/// Fetch the manifest and check the owner's signature over it.
export async function fetchManifest(addr: RcqAddress): Promise<SiteManifest> {
  const res = await get(`${originOf(addr.host)}/sites/${encodeURIComponent(addr.name)}/manifest.json`)
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
async function fetchFile(addr: RcqAddress, m: SiteManifest, path: string): Promise<Uint8Array> {
  const want = m.files[path]
  if (!want) throw new Error('missing' satisfies SiteError)
  const res = await get(`${originOf(addr.host)}/sites/${encodeURIComponent(addr.name)}/${path}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (hex(sha256(bytes)) !== want) throw new Error('tampered' satisfies SiteError)
  return bytes
}

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
async function inline(addr: RcqAddress, m: SiteManifest, path: string, html: string): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html')

  doc.querySelectorAll('script, iframe, object, embed, form, video, audio, source, base, meta[http-equiv]')
    .forEach((el) => el.remove())

  for (const el of Array.from(doc.querySelectorAll('link'))) {
    const rel = (el.getAttribute('rel') || '').toLowerCase()
    const href = resolve(path, el.getAttribute('href') || '')
    if (rel !== 'stylesheet' || !href || !m.files[href]) { el.remove(); continue }
    try {
      const css = new TextDecoder().decode(await fetchFile(addr, m, href))
      const style = doc.createElement('style')
      // `url(http…)` inside CSS is a fetch outward, so it goes the same way as
      // an outward link: nothing in a page may cause a request off the island.
      style.textContent = css.replace(/url\(\s*['"]?(https?:)?\/\/[^)]*\)/gi, 'none')
      el.replaceWith(style)
    } catch {
      el.remove()
    }
  }

  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = resolve(path, img.getAttribute('src') || '')
    img.removeAttribute('srcset')
    if (!src || !m.files[src]) { img.remove(); continue }
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
    a.removeAttribute('href')
    a.removeAttribute('target')
    const inner = resolve(path, href)
    if (inner && m.files[inner]) {
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

  // Attributes that fetch or execute, whatever element they sit on.
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const n = attr.name.toLowerCase()
      if (n.startsWith('on') || n === 'formaction' || n === 'ping' ||
          (n === 'style' && /url\s*\(/i.test(attr.value))) {
        el.removeAttribute(attr.name)
      }
    }
  }

  const meta = doc.createElement('meta')
  meta.setAttribute('http-equiv', 'Content-Security-Policy')
  meta.setAttribute('content', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'")
  doc.head.prepend(meta)
  return `<!doctype html>${doc.documentElement.outerHTML}`
}

/// Open a page of a site: verify, inline, and report what the reader should
/// know about the key.
export async function fetchSitePage(addr: RcqAddress, path = 'index.html'): Promise<SitePage> {
  const m = await fetchManifest(addr)
  const raw = new TextDecoder().decode(await fetchFile(addr, m, path))
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
    keyChanged: pin(addr.display, m.key),
  }
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

export const _internal = { islandHostFromLabel, resolve, readPins }

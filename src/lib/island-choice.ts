// Which island a new or recovered web account is created on.
//
// `apiBase` has always lived inside the identity, and both entry points already
// took one — the login screen simply never asked, so every account made in a
// browser landed on the flagship whatever its owner wanted. Self-hosting an
// island was a thing the phones could join and the web could not.
//
// Remembered between visits, because somebody who runs their own island is
// going to type the same host every time otherwise.
//
// An address may carry the island's certificate fingerprint after a `#`
// (docs/island-fingerprint-design.md §3): `203.0.113.5#ab12…`,
// `island.example:8443#AB:12:…` straight from openssl, or a pasted URL. The
// fragment is split off FIRST and the rest normalised as before, so an
// operator's `host:port#fp` pastes as one string. The pure helpers here are
// shared with the trust layer (island-trust.ts) and the address forms.

import { DEFAULT_API_BASE } from './auth'

const KEY = 'rcq.web.island'

export interface IslandAddress {
  /// `https://host[:port]`, or the flagship when the input was unusable.
  base: string
  /// The fingerprint typed after `#`, canonical (64 lowercase hex), or null
  /// when there was none or it did not parse.
  fingerprint: string | null
  /// A fragment was there but was not a SHA-256 fingerprint. The caller may
  /// warn; the trust layer treats it as absent rather than pinning garbage.
  badFingerprint: boolean
}

/// Canonical form of a fingerprint a person pasted: openssl's colons, any
/// case and stray spaces are accepted; anything that is not 32 bytes is null.
export function parseFingerprint(raw: string): string | null {
  const cleaned = raw.replace(/[:\s]/g, '').toLowerCase()
  return /^[0-9a-f]{64}$/.test(cleaned) ? cleaned : null
}

/// Display form (§2): 16 groups of 4, four groups to a line. Render it in a
/// monospace block that keeps the newlines.
export function displayFingerprint(fp: string): string {
  const groups = fp.match(/.{1,4}/g) ?? []
  const lines: string[] = []
  for (let i = 0; i < groups.length; i += 4) lines.push(groups.slice(i, i + 4).join(' '))
  return lines.join('\n')
}

/// `203.0.113.5` or a bracketed IPv6 literal. An island with no name at all,
/// which is the shape a walled-off network's island takes.
export function isIpLiteral(host: string): boolean {
  const h = host.trim()
  return /^\[.*\]$/.test(h) || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)
}

/// The hostname of a base URL (IPv6 brackets kept), '' when it is not one.
export function hostnameOf(base: string): string {
  try {
    return new URL(base).hostname
  } catch {
    return ''
  }
}

/// Host and port of a base URL the way the trust store keys them: the
/// hostname as written (brackets and all) and the port, 443 when implied.
export function splitHostPort(base: string): { host: string; port: number } {
  const u = new URL(base)
  return { host: u.hostname, port: u.port ? Number(u.port) : u.protocol === 'http:' ? 80 : 443 }
}

function normaliseBase(input: string): string {
  const raw = input.trim()
  if (!raw) return DEFAULT_API_BASE
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const u = new URL(withScheme)
    if (!u.hostname) return DEFAULT_API_BASE
    return `${u.protocol}//${u.host}`.replace(/\/+$/, '')
  } catch {
    return DEFAULT_API_BASE
  }
}

/// Normalise what a person types into a base URL: bare hosts get https, a
/// trailing slash goes, and anything unusable falls back to the flagship rather
/// than producing a URL that fails much later with a confusing error. A
/// `#fingerprint` fragment comes back beside the base rather than inside it.
export function normaliseIsland(input: string): IslandAddress {
  const raw = input.trim()
  // Split by hand, not through URL: openssl's form has colons and may carry
  // spaces, and a URL parser would mangle it (or refuse the whole address).
  const hash = raw.indexOf('#')
  const address = hash >= 0 ? raw.slice(0, hash) : raw
  const fragment = hash >= 0 ? raw.slice(hash + 1).trim() : ''
  const fingerprint = fragment ? parseFingerprint(fragment) : null
  return { base: normaliseBase(address), fingerprint, badFingerprint: fragment.length > 0 && fingerprint == null }
}

export function rememberedIsland(): string {
  return localStorage.getItem(KEY) || DEFAULT_API_BASE
}

export function rememberIsland(base: string) {
  if (base === DEFAULT_API_BASE) localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, base)
}

/// What the host looks like to a person: no scheme, no trailing slash.
export function islandLabel(base: string): string {
  return base.replace(/^https?:\/\//, '')
}

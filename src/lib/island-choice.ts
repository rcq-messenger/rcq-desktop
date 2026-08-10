// Which island a new or recovered web account is created on.
//
// `apiBase` has always lived inside the identity, and both entry points already
// took one — the login screen simply never asked, so every account made in a
// browser landed on the flagship whatever its owner wanted. Self-hosting an
// island was a thing the phones could join and the web could not.
//
// Remembered between visits, because somebody who runs their own island is
// going to type the same host every time otherwise.

import { DEFAULT_API_BASE } from './auth'

const KEY = 'rcq.web.island'

/// Normalise what a person types into a base URL: bare hosts get https, a
/// trailing slash goes, and anything unusable falls back to the flagship rather
/// than producing a URL that fails much later with a confusing error.
export function normaliseIsland(input: string): string {
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

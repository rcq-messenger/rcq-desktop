// The signing key first seen here for each number on OUR island.
//
// Every key a contact's seal is checked against comes from the island: the
// roster row, the member row, the card. A racing roster refresh, or an island
// that wanted to, could therefore swap a contact's key and every check below
// would agree with the new one without a word. So the first key seen for a
// number is written down here, and a later key is only taken when the island
// vouches for it AND the change is put on screen (Chat's key-changed banner):
// a legitimate reissue still goes through, a swap never goes through silently.
//
// Same island only. A cross-island contact's keys are pinned in
// crossisland-store.ts and never re-pinned at all.
//
// Per account (scopedKey), localStorage, synchronous: the receive path reads
// it from inside the decrypt loop.

import { scopedKey } from './account-scope'
import { sameSigningKey } from './crossisland-gate'

const KEY = () => scopedKey('signpins.v1')

export interface SignPin {
  /// The key we hold for this number now (base64).
  key: string
  /// When it was first written.
  at: number
  /// When the island last replaced it under us, if it ever did.
  changedAt?: number
  /// The previous key, for the banner's "why".
  previous?: string
  /// The person has seen the change (dismissed the banner).
  seen?: boolean
}

/// How many numbers are remembered. A room of thousands pins lazily, on a
/// member's first verified row, so this only fills with people who wrote.
const MAX_PINS = 4000

let cache: Record<string, SignPin> | null = null
let cacheKey: string | null = null
const listeners = new Set<() => void>()
let version = 0

// Another tab of the same account wrote: read it again rather than writing
// over it with an older copy.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === cacheKey) cache = null
  })
}

function load(): Record<string, SignPin> {
  const k = KEY()
  if (cache && cacheKey === k) return cache
  try {
    const raw = JSON.parse(localStorage.getItem(k) || '{}')
    cache = raw && typeof raw === 'object' ? (raw as Record<string, SignPin>) : {}
  } catch {
    cache = {}
  }
  cacheKey = k
  return cache
}

function save(map: Record<string, SignPin>): void {
  const entries = Object.entries(map)
  if (entries.length > MAX_PINS) {
    // Oldest first, but never a pin whose change is still unseen.
    entries.sort((a, b) => a[1].at - b[1].at)
    for (const [k, v] of entries) {
      if (Object.keys(map).length <= MAX_PINS - 200) break
      if (v.changedAt && !v.seen) continue
      delete map[k]
    }
  }
  cache = map
  try {
    localStorage.setItem(KEY(), JSON.stringify(map))
  } catch {
    /* quota: the in-memory copy still answers for this page */
  }
  version++
  for (const l of listeners) {
    try {
      l()
    } catch {
      /* a listener never breaks a pin */
    }
  }
}

export function signPinFor(uin: number): string | null {
  return load()[String(uin)]?.key ?? null
}

export function signPinRow(uin: number): SignPin | null {
  return load()[String(uin)] ?? null
}

/// Write `key` for `uin` if nothing is pinned yet. Returns the pinned key.
export function pinFirstSight(uin: number, key: string | null | undefined): string | null {
  const map = load()
  const have = map[String(uin)]
  if (have) return have.key
  if (typeof key !== 'string' || !key) return null
  map[String(uin)] = { key, at: Date.now() }
  save(map)
  return key
}

/// Seed pins from a roster this device just read: only numbers with nothing
/// pinned yet. A row whose key differs from the pin is NOT re-pinned here;
/// that happens when their next seal proves the new key, with the banner.
export function seedSignPins(rows: ReadonlyArray<{ uin: number; signing_key?: string | null; host?: string }>): void {
  const map = load()
  let changed = false
  const now = Date.now()
  for (const r of rows) {
    if (r.host || typeof r.signing_key !== 'string' || !r.signing_key) continue
    if (map[String(r.uin)]) continue
    map[String(r.uin)] = { key: r.signing_key, at: now }
    changed = true
  }
  if (changed) save(map)
}

/// The island now vouches for another key for `uin`, and a seal under it has
/// arrived (or the person accepted it). `announce` marks the change for the
/// banner; a first pin is not a change.
export function repinSignKey(uin: number, key: string, announce: boolean): void {
  const map = load()
  const have = map[String(uin)]
  if (have && sameSigningKey(have.key, key)) return
  map[String(uin)] = {
    key,
    at: have?.at ?? Date.now(),
    ...(announce && have ? { changedAt: Date.now(), previous: have.key, seen: false } : {}),
  }
  save(map)
}

/// A key change for `uin` the person has not dismissed yet, or null.
export function unseenKeyChange(uin: number): SignPin | null {
  const p = load()[String(uin)]
  return p && p.changedAt && !p.seen ? p : null
}

export function markKeyChangeSeen(uin: number): void {
  const map = load()
  const p = map[String(uin)]
  if (!p || !p.changedAt || p.seen) return
  map[String(uin)] = { ...p, seen: true }
  save(map)
}

/// Bumps on every write, for useSyncExternalStore beside onSignPinsChanged.
export function signPinsVersion(): number {
  return version
}

export function onSignPinsChanged(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

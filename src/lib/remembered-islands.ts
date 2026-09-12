// The islands this profile actually reached, kept so the picker can offer them
// again.
//
// Founder, 12.09: an island typed by hand on the desktop was lost the moment
// the person made a second account elsewhere or switched accounts. It existed
// in exactly two places, the one-slot `rcq.web.island` (overwritten by the
// next pick, deleted when the next pick was the flagship) and the `apiBase` of
// accounts created on it (gone with the account), and the picker never listed
// it: its rows were the catalogue plus the flagship, nothing else. The phones
// remember nothing either, but a phone keeps one account and the problem never
// shows.
//
// One row per island, written only when the island was REACHED: a register, a
// recover, a link from a phone, a typed address the island answered, a
// gateway key it accepted. Never from a pick alone, so a typo does not become
// a bookmark, and never from a correspondent's island or a visited group's
// (those are not islands the person has a home on; add them the day the
// founder asks).
//
// ⚠ Its own key, NOT the catalogue cache and NOT `rcq.island.<host>`: a
// catalogue refresh rewrites the first whole and the island card is rewritten
// on every /server/info. Flat, not `scopedKey`: the picker runs before any
// account is active (account-scope.ts), and the list is about this profile,
// not about one of its accounts. It survives a single account's sign-out
// (`removeStoredIdentity` runs no wipe) and every switch; it goes with the
// destroy-everything wipe, because `wipeLocalAccountData` takes every
// `rcq.web.*` key, and it should: a list of every island this laptop ever
// reached is the same thing `rcq.island.*` is deleted for.
//
// ⚠⚠ NO SECRET IN HERE. The gateway key for a private island is the island's
// front door for this device, and it is held next to the account keys in
// auth.ts (`islandGatewayKey`), where the desktop PIN vault seals it. This row
// only ever learns whether one exists, at render time, from there.
//
// React-free and storage-guarded, like island-card.ts.

import { catalogEntry } from './island-catalog'
import { islandCard } from './island-card'

export type ReachedHow = 'created' | 'recovered' | 'linked' | 'typed' | 'held'

export interface RememberedIsland {
  /// `https://host[:port]`, the form every `apiBase` in this tree takes.
  base: string
  /// The last name the island gave on /server/info, '' if it never answered.
  name: string
  /// From the catalogue row when there was one, else ''.
  region: string
  /// For the lettered tile when the island card is gone; the painting is
  /// derived from the host and needs nothing stored.
  logoVersion: string
  /// The fingerprint typed with the address, for "copy address with
  /// fingerprint" later. Public: it is the island's own certificate.
  fingerprint?: string
  addedAt: number
  lastUsedAt: number
  /// How this island first got onto the list. `held` is an account that was
  /// already on this device when the list was born.
  how: ReachedHow
}

const KEY = 'rcq.web.islands.v1'

/// Only an absolute island address is worth remembering. The web served
/// behind the front carries a RELATIVE `apiBase` ("/api", see ws.tsx), and
/// normalising that would hand back the flagship for an island that is not.
function usable(base: string | undefined | null): base is string {
  return typeof base === 'string' && /^https?:\/\/[^/]+$/i.test(base)
}

function read(): RememberedIsland[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as unknown
    if (!Array.isArray(list)) return []
    return list.filter(
      (r): r is RememberedIsland =>
        !!r && typeof r === 'object' && usable((r as RememberedIsland).base) && typeof (r as RememberedIsland).lastUsedAt === 'number',
    )
  } catch {
    return []
  }
}

function write(list: RememberedIsland[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* storage disabled or full: the picker simply does not remember */
  }
}

/// Every remembered island, most recently used first.
export function listRememberedIslands(): RememberedIsland[] {
  return read().sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

export function isRememberedIsland(base: string): boolean {
  return read().some((r) => r.base === base)
}

/// Put an island on the list, or bump the one already there. The name and the
/// region are looked up here rather than passed, so every call site is one
/// line: the island card (what the island said on /server/info) for the name,
/// the catalogue copy for the region.
export function rememberReachedIsland(
  base: string,
  how: ReachedHow,
  extra?: { fingerprint?: string | null },
): void {
  if (!usable(base)) return
  const now = Date.now()
  const card = islandCard(base)
  const entry = catalogEntry(base)
  const list = read()
  const i = list.findIndex((r) => r.base === base)
  if (i >= 0) {
    const prev = list[i]
    list[i] = {
      ...prev,
      // A blank answer does not erase a known name, same rule as
      // `rememberIslandCard`.
      name: card?.name || prev.name,
      region: entry?.region || prev.region,
      logoVersion: card?.logoVersion ?? prev.logoVersion,
      ...(extra?.fingerprint ? { fingerprint: extra.fingerprint } : {}),
      lastUsedAt: now,
    }
  } else {
    list.push({
      base,
      name: card?.name || entry?.name || '',
      region: entry?.region || '',
      logoVersion: card?.logoVersion || '',
      ...(extra?.fingerprint ? { fingerprint: extra.fingerprint } : {}),
      addedAt: now,
      lastUsedAt: now,
      how,
    })
  }
  write(list)
}

/// The island an account just booted or switched onto moves to the front.
/// A base that is not on the list is left alone: this is a bump, not a way
/// onto the list.
export function touchRememberedIsland(base: string | undefined | null): void {
  if (!usable(base)) return
  const list = read()
  const row = list.find((r) => r.base === base)
  if (!row) return
  row.lastUsedAt = Date.now()
  write(list)
}

/// Accounts that were already on this device when the list was born, so they
/// appear in the picker without anybody signing in again. Idempotent: an
/// island already listed is not touched (its `lastUsedAt` means something,
/// and a backfill on every boot would flatten the order).
export function backfillRememberedIslands(bases: Array<string | undefined>): void {
  const list = read()
  let touched = false
  const now = Date.now()
  for (const base of bases) {
    if (!usable(base) || list.some((r) => r.base === base)) continue
    const card = islandCard(base)
    const entry = catalogEntry(base)
    list.push({
      base,
      name: card?.name || entry?.name || '',
      region: entry?.region || '',
      logoVersion: card?.logoVersion || '',
      addedAt: now,
      // Oldest possible, so a backfilled island never outranks one the
      // person reached on purpose since.
      lastUsedAt: 0,
      how: 'held',
    })
    touched = true
  }
  if (touched) write(list)
}

/// Drop the row. The gateway key, when there is one, is the caller's to
/// forget as well (island-gate.ts), and the pin in the desktop trust store
/// stays: `forgetIslandTrust` is its own Settings action, and an island
/// forgotten here and reached again later should still be a known island.
export function forgetRememberedIsland(base: string): void {
  const list = read()
  const next = list.filter((r) => r.base !== base)
  if (next.length !== list.length) write(next)
}

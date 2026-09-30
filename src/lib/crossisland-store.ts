// Federation Layer B (F2) — local store of cross-island contacts.
//
// A peer on ANOTHER island is not a flagship user, so it can't live in the
// server-side /contacts list (there's no cross-island contact-request handshake).
// We keep cross-island contacts purely on this device, keyed by `uin@host`
// (uin is per-island, so the host is part of the identity of the handle).
//
// These carry the peer's pinned public keys (from their island's open key card)
// for display + future safety-number verification; the actual send re-resolves
// via federation-send so a moved peer still gets reached.

import { scopedKey } from './account-scope'
import { sameSigningKey } from './crossisland-gate'

export interface CrossIslandContact {
  uin: number
  host: string
  nickname: string
  identityKey: string            // v=1 X25519 (base64)
  signingKey: string             // v=1 Ed25519 (base64)
  signalIdentityKey?: string | null // v=2 libsignal / safety-number key (base64)
  addedAt: number
  // §5c display, from the open card (optional; old entries lack them).
  gender?: string | null
  statusMessage?: string | null
  // §5e display refresh, from a `profile` envelope the peer DEPOSITED — never
  // from their open card, which is unauthenticated: the same-island rule for a
  // picture is relationship-based (`owner_self or is_contact or shares_group`)
  // and `GET /media/{id}` has no auth at all, so the KEY is the whole access
  // decision and it may only ever travel inside an envelope sealed to us.
  // The blob itself was deposited to OUR island, so it renders from `apiBase`
  // like any other picture and keeps working while the peer's island is down.
  avatarMediaId?: string | null
  avatarMediaKey?: string | null
  /// `ts` (epoch SECONDS) of the newest §5e profile we have APPLIED for this
  /// peer. The stale guard: queue drains replay, backup and visited mailboxes
  /// deliver the same envelope again, and without this an old snapshot arriving
  /// after a new one would put the previous name back.
  profileTs?: number
}

// ⚠ This was a FLAT key while every other local store had already moved to
// per-account scoping, so cross-island contacts outlived the account that
// added them: unlink, create a fresh account, and a stranger from another
// island was sitting in the new roster. Same class of bug the comment in
// `account-scope.ts` describes, in the one store that was missed.
const KEY = () => scopedKey('crossisland.v1')

/// A local change, for the vault mirror. The store does NOT import the vault
/// module (that would be a cycle, and this file is imported by the
/// notification path where no vault exists); the mirror registers itself.
///
/// `kind: 'removed'` is separate because a removal has to leave a tombstone:
/// without one the next sync fetches the row straight back off the island and
/// deleting a cross-island contact undoes itself on the following boot.
export type CrossIslandEvent =
  | { kind: 'changed' }
  | { kind: 'removed'; uin: number; host: string }

let listener: ((e: CrossIslandEvent) => void) | null = null

export function setCrossIslandListener(fn: ((e: CrossIslandEvent) => void) | null): void {
  listener = fn
}

function notify(e: CrossIslandEvent): void {
  try {
    listener?.(e)
  } catch {
    /* a mirror that throws must never break the store write that just landed */
  }
}

export function ciKey(uin: number, host: string): string {
  return `${uin}@${host.toLowerCase()}`
}

function loadAll(): Record<string, CrossIslandContact> {
  try {
    return JSON.parse(localStorage.getItem(KEY()) || '{}') as Record<string, CrossIslandContact>
  } catch {
    return {}
  }
}

function saveAll(map: Record<string, CrossIslandContact>): void {
  localStorage.setItem(KEY(), JSON.stringify(map))
}

export function getCrossIsland(uin: number, host: string): CrossIslandContact | null {
  return loadAll()[ciKey(uin, host)] ?? null
}

/// The contact at (uin, host), but ONLY when `senderSigningKey` (the key a
/// received seal verified under) is the key pinned for them. Null otherwise.
///
/// ⚠⚠ Every receive-path trust decision about a cross-island contact goes
/// through this, not `getCrossIsland`. In a v=1 seal `from` and `from_host`
/// are outside the signature, so the address alone is a claim anyone can
/// write; the signing key is the part the seal proves. Anyone who knew one of
/// our accepted contacts' `uin@host`, and fetched our open key card, could
/// otherwise have sealed a message that skipped the quarantine and landed in
/// that contact's thread, or renamed them with a §5e profile.
export function getVerifiedCrossIsland(
  uin: number,
  host: string,
  senderSigningKey: string | null | undefined,
): CrossIslandContact | null {
  const c = getCrossIsland(uin, host)
  if (c) return sameSigningKey(c.signingKey, senderSigningKey) ? c : null
  return sameKeyElsewhere(uin, senderSigningKey)
}

/// The same person writing from another of their islands: a row for this
/// number under the SAME pinned key. The key is who they are, the address only
/// where the row came from: a backup made primary writes from its new home,
/// and the row kept after collapsing duplicates may be their other home (#1061
/// review). Without this their mail went to requests and the accept was then
/// refused as a number already held.
export function sameKeyElsewhere(uin: number, senderSigningKey: string | null | undefined): CrossIslandContact | null {
  if (!senderSigningKey) return null
  return listCrossIsland().find((c) => c.uin === uin && sameSigningKey(c.signingKey, senderSigningKey)) ?? null
}

export function saveCrossIsland(c: CrossIslandContact): void {
  const map = loadAll()
  map[ciKey(c.uin, c.host)] = c
  saveAll(map)
  notify({ kind: 'changed' })
}

/// The vault sync writing the merged set back. Deliberately silent: it is the
/// listener's own result coming home, and announcing it would loop.
export function replaceAllCrossIsland(rows: CrossIslandContact[]): void {
  const map: Record<string, CrossIslandContact> = {}
  for (const r of rows) map[ciKey(r.uin, r.host)] = r
  saveAll(map)
}

export function listCrossIsland(): CrossIslandContact[] {
  return Object.values(loadAll()).sort((a, b) => b.addedAt - a.addedAt)
}

/// Look up a cross-island contact by bare uin (for mapping an incoming sealed
/// message's senderUIN back to its thread). Per-island uins can collide in
/// theory; returns the first match, which is adequate for the common case.
export function findCrossIslandByUin(uin: number): CrossIslandContact | null {
  return listCrossIsland().find((c) => c.uin === uin) ?? null
}

/// §5e: apply a peer's own profile refresh to the row we already hold for them.
///
/// ⚠⚠ The ONLY writer for inbound display data, and deliberately the narrowest
/// one in this file. It writes exactly four fields onto an existing row and
/// copies the rest across untouched — no `{...row, ...incoming}`, so no future
/// field on the envelope can reach `identityKey`, `signingKey` or
/// `signalIdentityKey`. Those are pinned from the peer's island card at
/// add/accept time and are the anti-impersonation anchor; an inbound envelope
/// that can write them IS an impersonation path.
///
/// Returns false — and writes nothing — when we do not hold this peer as an
/// accepted cross-island contact. A `profile` from a stranger is cosmetic data
/// from someone we never agreed to hear from: it is DROPPED, not quarantined
/// and not turned into a pending row (§5f owns asking; this envelope does not).
///
/// The write lands in localStorage, i.e. on disk. It has to: the notification
/// path reads the stored snapshot with no live session behind it, so a
/// memory-only update would leave banners showing the name we are replacing.
export function applyCrossIslandProfile(
  uin: number,
  host: string,
  p: { nickname?: string; avatarMediaId?: string | null; avatarMediaKey?: string | null; ts: number },
): boolean {
  const map = loadAll()
  const k = ciKey(uin, host)
  const row = map[k]
  if (!row) return false
  const ts = Number.isFinite(p.ts) ? p.ts : 0
  // Older than what we already applied → ignore. Equal passes through as an
  // idempotent rewrite of the same values, which costs one localStorage write
  // and saves a whole class of "which copy arrived first" reasoning.
  if (row.profileTs != null && ts < row.profileTs) return false
  map[k] = {
    ...row,
    // An empty/absent name never blanks the row: we would rather show the name
    // from their card than `undefined`.
    nickname: p.nickname || row.nickname,
    // A SNAPSHOT, not a patch — absent means "I have no picture now", so the
    // one we hold goes. Both halves or neither: an id without its key names a
    // blob nobody can open.
    avatarMediaId: p.avatarMediaId && p.avatarMediaKey ? p.avatarMediaId : null,
    avatarMediaKey: p.avatarMediaId && p.avatarMediaKey ? p.avatarMediaKey : null,
    profileTs: ts,
  }
  saveAll(map)
  notify({ kind: 'changed' })
  return true
}

/// Is `uin` already a cross-island contact on an island OTHER than `host`?
/// (#1061) A conversation is filed by the bare number, so `N@a` and `N@b`
/// would share one history and every lookup by number would take whichever
/// came first. The add paths refuse; the same number on OUR island is the
/// caller's to check, against the roster.
export function crossIslandNumberElsewhere(uin: number, host: string): boolean {
  const want = canonHost(host)
  return listCrossIsland().some((c) => c.uin === uin && canonHost(c.host) !== want)
}

/// The same person twice under one number (#1061): a contact and their backup
/// copy on a third island, which gets the same number where it can, both added
/// before the add path refused that. Same number AND the same pinned signing
/// key is one person: the row added first stays, the rest are removed (and so
/// buried by the vault mirror, which a later sync respects). Same number under
/// another key is two people and is left alone. Returns how many went.
export function dedupeSamePersonCrossIsland(): number {
  const groups = new Map<string, CrossIslandContact[]>()
  for (const c of listCrossIsland()) {
    const k = `${c.uin}|${c.signingKey}`
    groups.set(k, [...(groups.get(k) ?? []), c])
  }
  let n = 0
  for (const same of groups.values()) {
    if (same.length < 2) continue
    // Ties broken by address, the same way on every client, so two devices
    // never keep different rows and bury both between them.
    // Plain code-unit order, not localeCompare: that follows the browser's
    // language, and Android and iOS compare by character codes.
    const byAge = [...same].sort((a, b) => {
      if (a.addedAt !== b.addedAt) return a.addedAt - b.addedAt
      const ka = ciKey(a.uin, a.host), kb = ciKey(b.uin, b.host)
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
    for (const c of byAge.slice(1)) {
      removeCrossIsland(c.uin, c.host)
      n++
    }
  }
  return n
}

/// One spelling of an island address for comparing two writers' stamps.
function canonHost(host: string): string {
  let h = host.trim().toLowerCase()
  if (h.endsWith(':443')) h = h.slice(0, -4)
  return h.replace(/\.+$/, '')
}

export function removeCrossIsland(uin: number, host: string): void {
  const map = loadAll()
  delete map[ciKey(uin, host)]
  saveAll(map)
  notify({ kind: 'removed', uin, host })
}

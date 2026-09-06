// Guest cards: how a stranger is allowed to write to you on a CLOSED island.
//
// On a closed island the key that seals an envelope to somebody is withheld
// from strangers, so knowing a number stops being enough. A guest card is what
// a resident hands out to be reachable anyway: 32 random bytes THIS DEVICE
// generates, of which the island is told only the sha256.
//
// ⚠⚠ THE RAW CARD NEVER GOES TO THE ISLAND. Not at registration, not at use.
// The island stores a digest and compares digests; the value itself travels
// only between people:
//
//   * in the FRAGMENT of a shared contact link (`…#c=<card>`), because a
//     fragment is never sent to a server, so the link can be pasted anywhere
//     without the island, Cloudflare or a middlebox ever seeing the card;
//   * in the clear INSIDE the first sealed envelope we send somebody, which is
//     what turns "I wrote to you first" into "you may write back" with no
//     server state, no screen and nothing for an operator to read.
//
// ⚠ And it never goes in a query string. It is a live credential with no
// expiry, and a query string is an access log — the same channel that held 816
// live session tokens until 22.08. It rides the `X-RCQ-Guest-Card` header.
//
// Two halves live here: OURS (cards we minted and handed out, which we can
// revoke) and THEIRS (cards other people gave us, which we must present to
// reach them). The second half is the one that must survive a reinstall, or a
// person restores their account and silently cannot write to anybody on a
// closed island any more.

import { Api } from './api'
import { scopedKey } from './account-scope'
import { sha256 } from '@noble/hashes/sha256'
import type { WebIdentity } from './crypto'

const CARD_BYTES = 32

/// Cards WE minted, by the label we gave them. The raw value is here because
/// we may have to show the link again; the island holds only the digest.
const MINE_KEY = () => scopedKey('guestcard.mine.v1')
/// Cards OTHER people gave us, keyed `uin@host` (or `uin` on our own island),
/// because that is the handle we present them against.
const THEIRS_KEY = () => scopedKey('guestcard.theirs.v1')

export interface MyCard {
  /// The raw card. Ours to keep and to re-share.
  card: string
  hash: string
  label?: string
  createdAt: number
}

function b64url(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/// The digest the island is told. Must match `models/guest_card.hash_card`:
/// sha256 of the raw string, hex, lowercase.
export function hashCard(raw: string): string {
  return hex(sha256(new TextEncoder().encode(raw.trim())))
}

export function newCard(): string {
  const b = new Uint8Array(CARD_BYTES)
  crypto.getRandomValues(b)
  return b64url(b)
}

// ── ours ───────────────────────────────────────────────────────────────────

function loadMine(): MyCard[] {
  try {
    const j = JSON.parse(localStorage.getItem(MINE_KEY()) || '[]')
    return Array.isArray(j) ? (j as MyCard[]) : []
  } catch {
    return []
  }
}

function saveMine(list: MyCard[]): void {
  try {
    localStorage.setItem(MINE_KEY(), JSON.stringify(list))
  } catch {
    /* no storage: the card still works, it just cannot be shown again */
  }
}

export function myCards(): MyCard[] {
  return loadMine().sort((a, b) => b.createdAt - a.createdAt)
}

/// Mint a card and tell the island its digest. Returns the raw card, which is
/// the only moment it exists outside this device's storage.
export async function mintCard(identity: WebIdentity, label?: string): Promise<MyCard> {
  const card = newCard()
  const hash = hashCard(card)
  await Api.addGuestCard(identity, hash, label)
  const row: MyCard = { card, hash, label, createdAt: Date.now() }
  saveMine([...loadMine(), row])
  return row
}

/// A card to put in a link or an envelope, minting one the first time.
///
/// ⚠ ONE card for everybody rather than one per person, deliberately, and the
/// trade is worth writing down. A card per contact would let a resident cut
/// off exactly one person; a shared card means revoking cuts off everyone it
/// was ever given to. But a card per contact also gives the island a stable
/// per-relationship identifier — it could count distinct correspondents and
/// their rhythm — and that is the metadata this whole design exists to avoid.
/// One card, revocable as a whole, keeps the island ignorant. A resident who
/// wants to cut one person off blocks them, which is a client-side act.
export async function shareableCard(identity: WebIdentity): Promise<string> {
  const live = loadMine().filter((c) => c.card)
  if (live.length) return live[live.length - 1].card
  return (await mintCard(identity, 'shared')).card
}

export async function revokeCard(identity: WebIdentity, hash: string): Promise<void> {
  await Api.revokeGuestCard(identity, hash)
  saveMine(loadMine().filter((c) => c.hash !== hash))
}

// ── theirs ─────────────────────────────────────────────────────────────────

export function handleOf(uin: number, host?: string | null): string {
  return host ? `${uin}@${host.toLowerCase()}` : String(uin)
}

function loadTheirs(): Record<string, string> {
  try {
    const j = JSON.parse(localStorage.getItem(THEIRS_KEY()) || '{}')
    return j && typeof j === 'object' ? (j as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/// Remember the card somebody gave us. Called from the link handler and from
/// the receive path when a first envelope carries one.
export function rememberTheirCard(uin: number, host: string | null | undefined, card: string): void {
  const c = card.trim()
  if (!c || c.length > 128) return
  const all = loadTheirs()
  const k = handleOf(uin, host)
  if (all[k] === c) return
  all[k] = c
  try {
    localStorage.setItem(THEIRS_KEY(), JSON.stringify(all))
  } catch {
    /* no storage: we simply cannot reach them after a reload */
  }
}

/// The card to present when asking an island about this person, or null.
export function theirCard(uin: number, host?: string | null): string | null {
  return loadTheirs()[handleOf(uin, host)] ?? null
}

export function forgetTheirCard(uin: number, host?: string | null): void {
  const all = loadTheirs()
  delete all[handleOf(uin, host)]
  try {
    localStorage.setItem(THEIRS_KEY(), JSON.stringify(all))
  } catch {
    /* nothing to do */
  }
}

/// Every card other people gave us, for the vault mirror: these are the half
/// that must survive a reinstall.
export function allTheirCards(): Record<string, string> {
  return loadTheirs()
}

export function replaceTheirCards(map: Record<string, string>): void {
  try {
    localStorage.setItem(THEIRS_KEY(), JSON.stringify(map))
  } catch {
    /* no storage */
  }
}

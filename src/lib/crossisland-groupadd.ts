// Federation §5c — putting a contact who lives on ANOTHER island into a group.
//
// The group's island has no account for a foreign uin, so `POST
// /groups/{id}/members` answers "no such user". The way round it, mirroring
// Android's `Session.addCrossIslandGroupMember`, is to give that island an
// account to point at: resolve the contact's PUBLIC keys there, or register
// them if nobody has, and put THAT uin in the roster. When the contact later
// opens the invite link their island-recovery is keyed by the same signing key,
// so they land on the very uin we added and the group is simply already theirs.
//
// ⚠ The uin is per-island. Adding a local contact's number to a group that
// lives elsewhere would enrol whoever happens to hold that number over there —
// the same mistake that had the web calling a stranger in §5d. Everything here
// is keyed by the SIGNING KEY, which is the same person on every island.
//
// Spec 2026-09-15, section 5: on an island that advertises `guest_accounts_v1`
// the resolve-or-mint above is replaced by ONE authenticated call,
// `POST /groups/{id}/guests`, which mints an unclaimed seat together with its
// membership and hands no token to anybody. The legacy chain stays for every
// other island, and on a paid island it keeps failing at the door until that
// island updates, which is what the spec wants.

import { Api, ApiError, type RCQGroup } from './api'
import type { WebIdentity } from './crypto'
import { cardIsStale, groupAddErrorKey, guestAddBody, guestRefusalOf, neutralGuestNickname, type GuestPath } from './guest-path'
import { islandGuestPath } from './guest-register'

/// The uin an island has issued to this signing key, or null if it has none.
export async function resolveUinOnIsland(
  host: string,
  signingKeyB64: string,
): Promise<number | null> {
  try {
    const url = `https://${host}/federation/uin-for-key?signing_key=${encodeURIComponent(signingKeyB64)}`
    const res = await fetch(url)
    if (!res.ok) return null
    const body = (await res.json()) as { uin?: number }
    return typeof body.uin === 'number' ? body.uin : null
  } catch {
    return null
  }
}

/// Register a contact's PUBLIC keys on `host` so the roster has a local uin to
/// hold. Only public material travels — this mints a shell account the contact
/// then recovers with their own private key.
export async function registerForeignKeysOn(
  host: string,
  identityKeyB64: string,
  signingKeyB64: string,
  nickname: string,
): Promise<number | null> {
  try {
    const res = await fetch(`https://${host}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nickname,
        identity_key: identityKeyB64,
        signing_key: signingKeyB64,
      }),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { uin?: number }
    return typeof body.uin === 'number' ? body.uin : null
  } catch {
    return null
  }
}

/// Resolve-or-mint in one call: the uin `host` knows this person by.
export async function uinForContactOnIsland(
  host: string,
  contact: { identityKey: string; signingKey: string; nickname: string; uin: number },
): Promise<number | null> {
  const known = await resolveUinOnIsland(host, contact.signingKey)
  if (known != null) return known
  return registerForeignKeysOn(
    host,
    contact.identityKey,
    contact.signingKey,
    // ⚠ D1: never `user-<their home number>`: that number is not this island's
    // business, and the same rule holds on every client.
    neutralGuestNickname(contact.nickname, [contact.uin]),
  )
}

/// The shareable form of a group invite. Always carries the host, because a
/// bare id means "on my own island" to the parser and the joiner's island is
/// not necessarily ours.
export function groupInviteLink(gid: number, host: string): string {
  return `https://rcq.app/g/${gid}@${host}`
}

/// Turn the island's refusal into a key our dictionaries carry. The router
/// emits distinct reasons and they mean genuinely different things to the
/// person pressing the button, so they are not collapsed into "failed". The
/// guest routes answer with `detail.code` (and `scope`), read first; the
/// native `add_member` strings are only readable by substring.
export function addMemberReasonKey(
  message: string | null | undefined,
  code?: string | null,
  scope?: string | null,
  status?: number,
): string {
  return groupAddErrorKey(code, scope, message, status)
}

/// `addMemberReasonKey` straight from whatever an add threw. The status rides
/// along for the limiter that answers 429 with no body of ours (E2).
export function addMemberReasonOf(e: unknown): string {
  if (e instanceof ApiError) {
    const refusal = guestRefusalOf(e.status, e.body)
    return addMemberReasonKey(e.message, refusal.code, refusal.scope, e.status)
  }
  return addMemberReasonKey(e instanceof Error ? e.message : null)
}

/// A contact whose home is `host`, as we pinned them.
export interface ForeignContactCard {
  uin: number
  host: string
  identityKey: string
  signingKey: string
  nickname: string
}

export type ForeignAddOutcome = { ok: true; group: RCQGroup } | { ok: false; reasonKey: string }

/// How long the card re-fetch may take before the add goes on with the pinned
/// card (an unreachable home is not a reason to refuse).
const CARD_TIMEOUT_MS = 10_000

async function fetchHomeCard(host: string, uin: number): Promise<{ identity_key?: unknown; signing_key?: unknown } | null> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), CARD_TIMEOUT_MS)
  try {
    const res = await fetch(`https://${host}/federation/keys/${uin}`, { signal: ctl.signal })
    if (!res.ok) return null
    const body = (await res.json()) as unknown
    return body && typeof body === 'object' ? (body as { identity_key?: unknown; signing_key?: unknown }) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/// Put a contact from another island into room `gid` on the island `adder`
/// talks to (spec 2026-09-15, 12.1 owner-add, steps 2 and 3):
///   * their card is fetched from their home again first; a key that differs
///     from the pinned one stops the add (`group.add.foreign.stale_key`),
///     because a seat minted from a stale card opens for the OLD seed;
///   * where the room's island advertises `guest_accounts_v1`,
///     `POST /groups/{gid}/guests` with our token there;
///   * elsewhere the legacy `uin-for-key` -> `/auth/register` -> `/members`.
/// `path` lets a caller adding several people ask the island once.
/// Sending them the link (step 4) stays with the caller.
export async function addForeignContactToGroup(
  adder: WebIdentity,
  gid: number,
  contact: ForeignContactCard,
  opts?: { path?: GuestPath },
): Promise<ForeignAddOutcome> {
  const fresh = await fetchHomeCard(contact.host, contact.uin)
  if (cardIsStale(contact, fresh)) return { ok: false, reasonKey: 'group.add.foreign.stale_key' }
  const path = opts?.path ?? (await islandGuestPath(adder.apiBase))
  if (path === 'guest') {
    try {
      const group = await Api.addGuestMember(adder, gid, guestAddBody(contact))
      return { ok: true, group }
    } catch (e) {
      return { ok: false, reasonKey: addMemberReasonOf(e) }
    }
  }
  let groupHost = adder.apiBase
  try {
    groupHost = new URL(adder.apiBase).host
  } catch {
    /* keep as given */
  }
  const there = await uinForContactOnIsland(groupHost, contact)
  if (there == null) return { ok: false, reasonKey: 'group.add.err.unreachable' }
  try {
    return { ok: true, group: await Api.addGroupMember(adder, gid, there) }
  } catch (e) {
    return { ok: false, reasonKey: addMemberReasonOf(e) }
  }
}

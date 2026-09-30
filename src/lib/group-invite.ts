// Group-invite deep links. iOS/Android share a group as either the
// custom scheme `rcq://group/<id>` (in-app tap) or the universal
// `https://rcq.app/g/<id>` (paste / browser / message body). When one
// of those lands in a chat as plain text we don't want to render it as
// a dead URL — we detect the group id and paint a join card instead
// (see GroupJoinCard + the /g/:id route).
//
// Cross-island groups (federation §5c): the link may carry the group's
// HOST island as `/g/<id>@<host>` — the joiner guest-registers there
// (recover-first) and the group becomes reachable from any island. A
// bare `<id>` keeps meaning "on my own island" (backward compatible;
// old clients simply don't parse the @host form).
//
// Mirrors the iOS parser in `ViewModels/AppState.swift`; we additionally
// accept `chat.rcq.app/g/<id>` so a link shared from the web client
// round-trips.

import type { WebIdentity } from './crypto'
import { groupInviteLink } from './crossisland-groupadd'
import { hostOfApiBase } from './multihome'
import { isForeignGroupId, refByAlias } from './visited-islands'
import { rememberRoomLinkKey } from './room-link-keys'
import { contactsCache } from './contacts-cache'

export interface GroupInviteRef {
  id: number
  host: string | null // null = own island
  /// The room link's key (#990 step 2), when the link carries one.
  k?: string | null
}

/// The (id, host) pair a group must be SHARED as. A route id is local to this
/// device — a negative one is an alias for a group that lives on another
/// island — so neither half can be taken from it directly: the id has to be
/// the one that island issued, and the host has to be that island, not ours.
/// Byte-for-byte the same rule as Android's `Session.groupShareRef`
/// (Session.kt:2957) so a link built here parses on a phone and back.
export function groupShareRef(identity: WebIdentity, routeId: number): { id: number; host: string } {
  const ref = isForeignGroupId(routeId) ? refByAlias(routeId) : null
  return ref
    ? { id: ref.remoteId, host: ref.host }
    : { id: routeId, host: hostOfApiBase(identity.apiBase) }
}

/// The shareable link for a group I am in, host and all. Android builds the
/// same string in `GroupLinkParser.canonicalUrl` (ChatScreen.kt:2215).
export function groupShareLink(identity: WebIdentity, routeId: number, shareToken?: string | null): string {
  const ref = groupShareRef(identity, routeId)
  const k = shareToken ?? contactsCache.get(identity.uin)?.groups.find((g) => g.id === routeId)?.share_token ?? null
  return groupInviteLink(ref.id, ref.host, k)
}

const PATTERNS: RegExp[] = [
  // https://rcq.app/g/123[@is2.rcq.app][?k=<key>]  ·  chat.rcq.app/g/123  ·  rcq.app/g/123
  /(?:https?:\/\/)?(?:www\.|chat\.)?rcq\.app\/g\/(\d+)(?:@([a-z0-9.-]+))?(?:\?k=([A-Za-z0-9_-]{8,64}))?/i,
  // rcq://group/123[@is2.rcq.app][?k=<key>]
  /rcq:\/\/group\/(\d+)(?:@([a-z0-9.-]+))?(?:\?k=([A-Za-z0-9_-]{8,64}))?/i,
]

/// If `text` is (or contains) a group-invite link, return the group id +
/// optional host island; otherwise null.
export function parseGroupInvite(text: string): GroupInviteRef | null {
  const trimmed = text.trim()
  for (const re of PATTERNS) {
    const m = trimmed.match(re)
    if (m) {
      const id = Number(m[1])
      if (Number.isFinite(id) && id > 0) {
        const host = m[2] ? m[2].toLowerCase() : null
        const k = m[3] ?? null
        // Remembered where the preview, the join and the guest entry find it.
        if (k) rememberRoomLinkKey(host, id, k)
        return { id, host, k }
      }
    }
  }
  return null
}

/// Back-compat shim for same-island callers (returns the id whether or not a
/// host is present; the join card resolves the host itself).
export function parseGroupInviteId(text: string): number | null {
  return parseGroupInvite(text)?.id ?? null
}

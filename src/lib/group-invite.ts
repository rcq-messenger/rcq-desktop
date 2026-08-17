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

export interface GroupInviteRef {
  id: number
  host: string | null // null = own island
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
export function groupShareLink(identity: WebIdentity, routeId: number): string {
  const ref = groupShareRef(identity, routeId)
  return groupInviteLink(ref.id, ref.host)
}

const PATTERNS: RegExp[] = [
  // https://rcq.app/g/123[@is2.rcq.app]  ·  chat.rcq.app/g/123  ·  rcq.app/g/123
  /(?:https?:\/\/)?(?:www\.|chat\.)?rcq\.app\/g\/(\d+)(?:@([a-z0-9.-]+))?/i,
  // rcq://group/123[@is2.rcq.app]
  /rcq:\/\/group\/(\d+)(?:@([a-z0-9.-]+))?/i,
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
        return { id, host: m[2] ? m[2].toLowerCase() : null }
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

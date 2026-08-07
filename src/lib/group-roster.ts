// The group roster, fetched per group and on demand.
//
// The chat list asks the island for `?members=0`: a row wants a name, a
// picture and a count, and the roster is the expensive half of a group
// payload — every member with two base64 keys, which on a group of a couple
// of thousand people is hundreds of kilobytes, on the boot path, on every
// poll. So a group that came out of `Api.groups` can legitimately carry no
// members at all.
//
// ⚠ Anything that encrypts per recipient has to come through here first.
// Sealing a message against an empty roster produces no ciphertexts, and the
// send paths read "no payloads" as an empty group — the message looks sent and
// reaches nobody.

import { Api, type RCQGroup } from './api'
import type { WebIdentity } from './crypto'

/// The group WITH its roster, fetching it when the list did not carry one.
///
/// A foreign group is returned untouched: its roster comes from its own
/// island, its id here is a local negative alias our island knows nothing
/// about, and the cross-island list is still fetched with members.
export async function ensureRoster(
  identity: WebIdentity,
  group: RCQGroup,
): Promise<RCQGroup> {
  if (group.members.length > 0 || group.host) return group
  try {
    const full = await Api.groupInfo(identity, group.id)
    // Only the roster is taken from the fetch; everything else on the row is
    // already what the list said it was.
    return { ...group, members: full.members, member_count: memberCount(full) }
  } catch {
    // Soft-fail to what we hold: the caller's own "no valid members" error is
    // a better thing for the user to see than a raw network failure here.
    return group
  }
}

/// How many people are in the group, whether or not the roster came with it.
/// Older islands do not send the count; the roster's own size is right there.
export function memberCount(group: RCQGroup): number {
  return group.member_count && group.member_count > 0
    ? group.member_count
    : group.members.length
}

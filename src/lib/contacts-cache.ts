// The warm contacts snapshot, and the read-only lookups off it.
//
// This lives apart from the Contacts PAGE on purpose. The lookups are wanted by
// things that sit ABOVE that page in the tree — the message toasts, the call
// overlay — and importing a page from a component mounted above it closes an
// import cycle that does not fail loudly: React contexts initialise in the
// wrong order and every `useX called outside XProvider` in the app fires at
// once. Hit for real when the call overlay reached in here for an avatar.
//
// Nothing in this file imports a component, a page, or a context. Keep it that
// way and the cycle cannot come back.

import type { Contact, PendingRequest, RCQGroup, UserInfo, UserStatus } from './api'

export interface ContactsSnapshot {
  contacts: Contact[]
  groups: RCQGroup[]
  pending: PendingRequest[]
  me: UserInfo | null
}

export const contactsCache = new Map<number, ContactsSnapshot>()

/// Best-effort name lookup off the warm cache — used by the in-app message
/// toasts so a "push" shows the sender/group name. Null when the cache is cold
/// or the id isn't known.
export function lookupContactName(viewerUin: number, uin: number): string | null {
  return contactsCache.get(viewerUin)?.contacts.find((c) => c.uin === uin)?.nickname || null
}

/// Last-known presence of a contact, so a toast shows the sender's status dot
/// and not just the nick.
export function lookupContactStatus(viewerUin: number, uin: number): UserStatus | null {
  return contactsCache.get(viewerUin)?.contacts.find((c) => c.uin === uin)?.status ?? null
}

/// A contact's avatar media. The call overlay is the reason this exists: it drew
/// a large letter of the nickname on the one screen where you look at nothing
/// else, while every list in the app already had their face.
export function lookupContactAvatar(
  viewerUin: number,
  uin: number,
): { mediaId?: string | null; mediaKey?: string | null } | null {
  const c = contactsCache.get(viewerUin)?.contacts.find((x) => x.uin === uin)
  return c ? { mediaId: c.avatar_media_id, mediaKey: c.avatar_media_key } : null
}

export function lookupGroupName(viewerUin: number, id: number): string | null {
  return contactsCache.get(viewerUin)?.groups.find((g) => g.id === id)?.name || null
}

/// Group avatar media, so a group toast shows the group's avatar, not a glyph.
export function lookupGroupAvatar(
  viewerUin: number,
  id: number,
): { mediaId?: string | null; mediaKey?: string | null } | null {
  const g = contactsCache.get(viewerUin)?.groups.find((x) => x.id === id)
  return g ? { mediaId: g.avatar_media_id, mediaKey: g.avatar_media_key } : null
}

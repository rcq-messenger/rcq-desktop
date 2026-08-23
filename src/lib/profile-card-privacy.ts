/// Who may OPEN my profile card (founder item 22).
///
/// The complaint behind it: a card is reachable from surfaces nobody chose to
/// appear on. React to a message in a group and your name lands in the "who
/// reacted" sheet; send a photo and your name sits over it in the viewer; join
/// anything and you are a row in a member list. Every one of those names is a
/// link, so being in a room is enough for a stranger to read your card.
///
/// This is NOT the island's existing `profile_visibility`, which blanks the
/// optional FIELDS (city, age, about, …) for outsiders. That one still lets
/// the card open, on an empty card. Item 22 is about the tap itself.
///
/// ── how it travels ────────────────────────────────────────────────────────
/// Same road as the other privacy scopes: written with `PUT /users/me` and
/// echoed back by `GET /users/{uin}/info`, plus a device-local mirror so a
/// surface can ask synchronously while it renders instead of waiting on a
/// fetch (`call_policy` is cached the same way, and for the same reason).
///
/// ⚠⚠ The mirror is a CACHE of a server value, never the source of truth, and
/// a setting that lives only on my own machine cannot stop anybody: the
/// stranger opening my card is running THEIR client, which never reads my
/// localStorage. What makes this real is the island refusing to serve the card
/// (`GET /users/{uin}/info` gated on the policy the way `last_seen` already
/// is) and publishing a per-viewer verdict next to the row so the other client
/// knows not to draw the link at all: `Contact.profile_openable`, the twin of
/// `callable`. Neither exists yet. Until they do, `canOpenProfileCard` is
/// honest about what it can see and fails OPEN.

import { scopedKey } from './account-scope'

export type ProfileCardPolicy = 'everyone' | 'contacts' | 'nobody'

const KEY = () => scopedKey('privacy.profileCard')

function coerce(raw: string | null | undefined): ProfileCardPolicy | null {
  return raw === 'everyone' || raw === 'contacts' || raw === 'nobody' ? raw : null
}

/// My own setting, from the device-local mirror. Defaults to "everyone",
/// matching the server default for the profile gates: a fresh account is not
/// silently unreachable.
export function myProfileCardPolicy(): ProfileCardPolicy {
  return coerce(localStorage.getItem(KEY())) ?? 'everyone'
}

/// Cache the value the island was just told about (or just echoed back).
export function setMyProfileCardPolicy(policy: ProfileCardPolicy): void {
  localStorage.setItem(KEY(), policy)
}

/// What a surface knows about the person whose name it is about to draw.
/// Every field is optional on purpose: these rows come from four different
/// endpoints and none of them is guaranteed to carry any of it.
export interface ProfileCardSubject {
  uin?: number | null
  /// The island's verdict for THIS viewer, when it publishes one.
  profile_openable?: boolean | null
  /// The raw tri-state. Only ever echoed to the owner, so in practice this is
  /// set only when the subject is me.
  profile_card_policy?: string | null
}

/// May this client turn the subject's name into a link to their card?
///
/// ⚠ Fails OPEN on anything it does not know. A name that stops being
/// clickable because a field was missing from one endpoint reads as a broken
/// screen, and the enforcement that matters is the island's anyway.
export function canOpenProfileCard(
  subject: ProfileCardSubject | null | undefined,
  ctx: { myUin?: number | null; isContact?: boolean } = {},
): boolean {
  if (!subject) return true
  // My own card is always mine to open, whatever I told the island.
  if (subject.uin != null && ctx.myUin != null && subject.uin === ctx.myUin) return true
  if (typeof subject.profile_openable === 'boolean') return subject.profile_openable
  const policy = coerce(subject.profile_card_policy)
  if (policy === 'nobody') return false
  if (policy === 'contacts') return ctx.isContact === true
  return true
}

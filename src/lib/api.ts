// Thin REST client. Reuses the JWT from the active WebIdentity and
// targets `apiBase` (defaults to https://api.rcq.app via the linking
// QR or fresh registration). All paths mirror the FastAPI router
// prefixes documented in `backend/app/routers/*.py`.

import type { WebIdentity, PeerBundle } from './crypto'

export class ApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`${status}: ${body}`)
  }
}

// A 401 on a Bearer-authed request means the JWT is dead — the device was
// unlinked/revoked on the phone, or the token expired. The session can't
// recover, so rather than surface a raw "401: device revoked" error with a
// Retry button, we hand off to a registered handler (the IdentityProvider)
// that drops the identity and routes back to login. Registered once at app
// start; null in tests / before mount.
// The handler is told WHOSE token died. Without that it can only ask "which
// account is active now?", and answer for a 401 that belonged to a different
// one — a request in flight for an account being signed out took the account
// that stays down with it.
let unauthorizedHandler: ((uin: number) => void) | null = null
export function setUnauthorizedHandler(fn: ((uin: number) => void) | null) {
  unauthorizedHandler = fn
}

/// Mint a replacement token for a session whose own has expired, from the
/// signing key (see auth.ts `mintSessionToken`). Registered by the
/// IdentityProvider, which also adopts the new token app-wide.
///
/// ★ This is what makes "keep no token on disk" possible AND fixes something
/// that was broken anyway: a web session used to simply END after 30 days, at
/// whatever moment the token expired, and the user was returned to the login
/// screen with an account many of them could not sign back into.
let tokenRefresher: ((identity: WebIdentity) => Promise<string | null>) | null = null
export function setTokenRefresher(fn: ((identity: WebIdentity) => Promise<string | null>) | null) {
  tokenRefresher = fn
}

async function request<T>(
  identity: WebIdentity,
  method: string,
  path: string,
  body?: unknown,
  retried = false,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${identity.jwt}`,
  }
  let payload: BodyInit | undefined
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(`${identity.apiBase}${path}`, {
    method,
    headers,
    body: payload,
  })
  const text = await res.text()
  if (!res.ok) {
    if (res.status === 401 && !identity.guest) {
      // Expired is the common case and it is recoverable: ask for a new token
      // and run the call again. ONE retry — a revoked install gets a perfectly
      // valid token and is still refused (its device id is denylisted), and
      // that must end as a sign-out rather than a loop.
      if (!retried && tokenRefresher) {
        const fresh = await tokenRefresher(identity)
        if (fresh) return request<T>({ ...identity, jwt: fresh }, method, path, body, true)
      }
      // ⚠ Only a token that was REFUSED ends the session. A call made with no
      // token at all (a tokenless account that started offline and has not
      // minted one yet) is answered 401 too, and treating that as a revocation
      // would sign people out of live accounts every time the network is down
      // at the wrong moment.
      if (identity.jwt) unauthorizedHandler?.(identity.uin)
    }
    throw new ApiError(res.status, text)
  }
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    return text as unknown as T
  }
}

// -----------------------------------------------------------
// Domain shapes — mirror the FastAPI Pydantic models. We only
// pull the fields we use; extra fields from the server are ignored
// silently (forward-compatible if backend adds anything).
// -----------------------------------------------------------

export type UserStatus = 'online' | 'away' | 'dnd' | 'invisible' | 'offline'

export interface Contact {
  uin: number
  nickname: string
  status: UserStatus
  status_message?: string
  blocked: boolean
  identity_key: string
  signing_key: string
  signal_identity_key?: string | null
  gender?: string | null
  // Profile picture: an encrypted blob id plus its key. The island only fills
  // these in for people allowed to see it (a mutual contact, yourself, or a
  // member of a group you are in), so the client never has to gate it.
  avatar_media_id?: string | null
  avatar_media_key?: string | null
  /// Whether WE may call this contact, per THEIR `call_policy` — "nobody"
  /// hides our call buttons. Optional for an older island that omits it, and
  /// absent is treated as callable. The island enforces the policy on the
  /// call_offer regardless, so this only decides what we DRAW.
  callable?: boolean | null
  // Federation (F2): set for a cross-island peer (the island host where they
  // live). Undefined/absent = a normal flagship contact. When present, the chat
  // send path routes via federation-send (deliverCrossIsland) instead of the
  // flagship /messages/sealed.
  host?: string
}

export interface UserInfo {
  uin: number
  nickname: string
  avatar_media_id?: string | null
  avatar_media_key?: string | null
  identity_key: string
  signing_key: string
  status: UserStatus
  status_message?: string | null
  first_name?: string | null
  last_name?: string | null
  age?: number | null
  gender?: string | null
  city?: string | null
  country?: string | null
  about?: string | null
  interests?: string | null
  homepage?: string | null
  last_seen?: string | null
  last_seen_visibility?: string | null
  gender_visibility?: string | null
  group_invite_policy?: string | null
  trade_policy?: string | null
  call_policy?: string | null
  hof_opt_in?: boolean | null
  hof_avatar?: string | null
}

export interface OutgoingRequest {
  id: number
  to_uin: number
  nickname: string
  /// pending — they have not answered; declined — they said no and this row is
  /// how you find out.
  state: 'pending' | 'declined'
}

export interface PendingRequest {
  id: number
  from_uin: number
  nickname: string
  state: 'pending' | 'accepted' | 'declined'
}

export interface GroupMember {
  uin: number
  nickname: string
  role: 'owner' | 'admin' | 'member'
  status: UserStatus
  identity_key: string
  signing_key: string
  signal_identity_key?: string | null
  // This member's client(s) understand the sender-keys group path (gmsg
  // broadcast + skdm). Absent/false → they only get the legacy per-member
  // fan-out (dual-send migration). See RCQ/docs/sender-keys-design.md.
  sender_keys?: boolean
  // Granular moderator caps the owner granted (subset of delete|members|info).
  // Empty/absent for a plain member; gates pinning a message from the chat.
  permissions?: string[]
  // Profile picture, gated by MEMBERSHIP rather than by the contact list:
  // sharing a group is the relationship here, the same one that already
  // exposes the nickname on this row.
  avatar_media_id?: string | null
  avatar_media_key?: string | null
}

export interface RCQGroup {
  // For a cross-island group the client rewrites this to the local ALIAS id
  // (negative) at the fetch boundary; the server-side id lives in the alias
  // map (visited-islands.ts).
  id: number
  name: string
  owner_uin: number
  avatar_seed: number
  created_at: string
  /// How many people are in the group, independent of whether `members` was
  /// fetched. A list row needs the number and nothing else, and the roster is
  /// the expensive half of a group payload. Absent on older islands — fall
  /// back to `members.length` there.
  member_count?: number
  /// ⚠ Can legitimately be EMPTY. The chat list is fetched with `?members=0`,
  /// so a group that came from `Api.groups` may carry no roster at all.
  /// Anything that encrypts per recipient must go through `ensureRoster`
  /// first — sealing against an empty roster produces no payloads at all, and
  /// against a stale one it misses whoever joined since.
  members: GroupMember[]
  // Owner-set display gate: hide the member roster from Group Info for
  // non-owners. Mirrors the iOS/backend `members_hidden`.
  members_hidden?: boolean
  /// The island sends both of these already; the web type simply never
  /// declared them, so nothing on this client could show or edit either.
  description?: string | null
  is_closed?: boolean
  // CLIENT-SIDE only: the island a cross-island group lives on (set at the
  // fetch boundary; never sent by a server).
  host?: string
  // Custom group avatar (encrypted media). When set, clients fetch + decrypt
  // it; otherwise the avatar is generated from `avatar_seed`.
  avatar_media_id?: string | null
  avatar_media_key?: string | null
  // Owner/admin-set plaintext pinned announcement (NULL = none).
  pinned_text?: string | null
  // Posting gate: 'all' (everyone) or 'owner_only' (broadcast — only the
  // owner posts; the server now enforces this for identified callers, the
  // composer below hides for non-owners). Absent → 'all'.
  post_policy?: string
}

/// Live poll state from `/polls/{id}`. `voter_uins` is populated only for
/// non-anonymous polls (the backend strips it otherwise).
export interface PollTally {
  option_index: number
  count: number
  voter_uins: number[]
}
export interface PollOut {
  poll_id?: number
  creator_uin?: number
  closed_at?: string | null
  tallies: PollTally[]
  total_votes: number
  my_votes: number[]
}

/// What `POST /groups/{id}/polls` hands back. The island only ever sees the
/// SHAPE of a ballot (how many options, single-choice, anonymous) — the
/// question and the option labels ride encrypted in the `poll` envelope — so
/// this id is the whole of the server-side link between the two.
export interface CreatePollOut {
  poll_id: number
  created_at?: string
}

/// Lightweight group info shown to a non-member who's about to join
/// (the join card / `/g/:id` page). Mirrors backend `GroupPreviewOut`
/// — name + member count + owner, no roster or history.
export interface GroupPreview {
  id: number
  name: string
  description?: string | null
  member_count: number
  is_closed: boolean
  owner_uin: number
  owner_nickname?: string | null
  avatar_media_id?: string | null
  avatar_media_key?: string | null
}

export interface ProfileUpdate {
  nickname?: string
  first_name?: string | null
  last_name?: string | null
  age?: number | null
  gender?: string | null
  city?: string | null
  country?: string | null
  about?: string | null
  homepage?: string | null
  status_message?: string | null
  last_seen_visibility?: string
  gender_visibility?: string
  group_invite_policy?: string
  trade_policy?: string
  call_policy?: string
  hof_opt_in?: boolean
  /// Public HoF avatar as a data-URI (image/gif|png|jpeg|webp, base64,
  /// capped ~256KB server-side). Empty string clears it.
  hof_avatar?: string
  /// Profile picture: id + key of an already-uploaded encrypted blob. Both
  /// blank clears it; leaving them out entirely leaves the picture alone, so a
  /// patch that only changes a nickname cannot wipe it.
  avatar_media_id?: string
  avatar_media_key?: string
}

/// UIN market — mirrors backend `app/routers/uin_shop.py` (`/uin/*`).
/// A custom 3-9 digit handle is bought (mock IAP today) and the account
/// is migrated to it; price is a pure function of digit count.
export interface UinQuote {
  uin: number
  length: number
  available: boolean
  price_cents: number | null
  price_display: string | null
  reason?: 'taken' | 'too_short' | 'too_long' | 'self' | null
}

export interface UinSuggestion {
  uin: number
  length: number
  price_cents: number
  price_display: string
}

/// Superset of the old {new_uin, token}: the server fills those in exactly
/// when it was asked to switch the account onto the number, and `owned` is
/// the collection afterwards. Taking a number and BECOMING it are two calls
/// now (`/uin/purchase` with switch=false, then `/uin/activate`).
export interface UinPurchaseResult {
  new_uin?: number | null
  token?: string | null
  switched?: boolean
  owned?: number[]
}

/// One number held but not in use.
export interface OwnedUin {
  uin: number
  length: number
  acquired_at: string
}

export interface MyUins {
  /// The number this account answers as right now.
  active: number
  owned: OwnedUin[]
}

/// TURN relay credentials, minted per call and short-lived (`ttl` seconds).
/// `urls` is empty on an island that runs no coturn — see `Api.turnCredentials`.
export interface TurnCredentials {
  urls: string[]
  username: string
  credential: string
  ttl: number
}

/// One of this account's own reports, as `/reports/mine` returns it.
/// `reply` is the operator's answer and is an empty string until there is
/// one; the operator's internal notes are deliberately not exposed. An older
/// island may omit the field entirely, hence the optional.
/// One turn in a report's conversation. `from_admin` is the only side the
/// reader needs: there is exactly one person on each end.
export interface ReportTurn {
  id: number
  from_admin: boolean
  body: string
  created_at: string
}

export interface MyReport {
  id: number
  reason: string
  /// 'open' | 'resolved' | 'dismissed' | 'duplicate' — a plain server string,
  /// not an enum, so unknown values must fall back rather than render a key.
  status: string
  created_at: string
  /// The last operator answer. Older islands send only this.
  reply?: string
  replied_at?: string | null
  /// The whole exchange, oldest first. Absent on an island that predates the
  /// ticket thread, which is why the screen falls back to `reply`.
  thread?: ReportTurn[]
}

/// The platform tag glued to the front of a bug report so the admin queue can
/// tell where it came from — the same convention as Android's `[Android 0.110]`.
export const REPORT_TAG = '[Web]'

/// The server caps `reason` at 1000 characters AFTER the tag is prepended, so
/// a composer capped at a flat 1000 lets the user type a report the island
/// then rejects with a 422 that reads to them as a network failure. Android
/// learned this the same way and does the same arithmetic.
export const REPORT_MAX_REASON = 1000

export function reportTextLimit(tag: string = REPORT_TAG): number {
  return REPORT_MAX_REASON - tag.length - 1
}

// -----------------------------------------------------------

export const Api = {
  // Profile -------------------------------------------------

  myInfo(id: WebIdentity): Promise<UserInfo> {
    return request<UserInfo>(id, 'GET', `/users/${id.uin}/info`)
  },

  userInfo(id: WebIdentity, uin: number): Promise<UserInfo> {
    return request<UserInfo>(id, 'GET', `/users/${uin}/info`)
  },

  updateProfile(id: WebIdentity, patch: ProfileUpdate): Promise<UserInfo> {
    return request<UserInfo>(id, 'PUT', '/users/me', patch)
  },

  searchUsers(id: WebIdentity, q: string, limit = 20): Promise<UserInfo[]> {
    const qs = new URLSearchParams({ q, limit: String(limit) })
    return request<UserInfo[]>(id, 'GET', `/users/search?${qs}`)
  },

  // Contacts ------------------------------------------------

  contacts(id: WebIdentity): Promise<Contact[]> {
    return request<Contact[]>(id, 'GET', '/contacts')
  },

  pendingRequests(id: WebIdentity): Promise<PendingRequest[]> {
    return request<PendingRequest[]>(id, 'GET', '/contacts/pending')
  },

  sendContactRequest(id: WebIdentity, toUIN: number): Promise<unknown> {
    return request<unknown>(id, 'POST', '/contacts/request', { to_uin: toUIN })
  },

  /// Requests WE sent that are still pending, plus ones the other side
  /// declined (there is no push for a decline, so the row IS the answer).
  /// The island has served these since the phones got them; the web simply
  /// never asked, so a request sent from the desktop vanished with no trace
  /// of whether it had been seen.
  outgoingRequests(id: WebIdentity): Promise<OutgoingRequest[]> {
    return request<OutgoingRequest[]>(id, 'GET', '/contacts/outgoing')
  },

  /// Withdraw a still-pending request, or dismiss a declined one. Pulls it out
  /// of the recipient's incoming list too.
  cancelOutgoing(id: WebIdentity, toUin: number): Promise<void> {
    return request<void>(id, 'DELETE', `/contacts/outgoing/${toUin}`)
  },

  respondToRequest(id: WebIdentity, requestId: number, accept: boolean): Promise<{ state: string }> {
    return request<{ state: string }>(id, 'POST', '/contacts/respond', {
      request_id: requestId,
      accept,
    })
  },

  removeContact(id: WebIdentity, uin: number): Promise<void> {
    return request<void>(id, 'DELETE', `/contacts/${uin}`)
  },

  blockContact(id: WebIdentity, uin: number, blocked: boolean): Promise<unknown> {
    return request<unknown>(id, 'POST', `/contacts/${uin}/block`, { blocked })
  },

  // Messages ------------------------------------------------

  sendSealed(id: WebIdentity, toUIN: number, payload: string, envelopeType: string = 'message'): Promise<void> {
    return request<void>(id, 'POST', '/messages/sealed', {
      to_uin: toUIN,
      envelope_type: envelopeType,
      payload,
    })
  },

  // Presence ------------------------------------------------

  setStatus(id: WebIdentity, status: UserStatus, statusMessage?: string | null): Promise<unknown> {
    return request<unknown>(id, 'POST', '/presence/status', {
      status,
      status_message: statusMessage ?? null,
    })
  },

  // Groups --------------------------------------------------

  /// The account's groups.
  ///
  /// `withMembers = false` asks the island to leave the roster out, which is
  /// the expensive part: every member with two base64 keys each, on a group
  /// with a couple of thousand people. The count still rides along in
  /// `member_count`, and the roster is one `groupInfo` away for the moments
  /// that genuinely need it — see `ensureRoster`. Older islands ignore the
  /// parameter and answer with the roster anyway, which is the safe direction.
  groups(id: WebIdentity, withMembers = true): Promise<RCQGroup[]> {
    return request<RCQGroup[]>(id, 'GET', withMembers ? '/groups' : '/groups?members=0')
  },

  groupInfo(id: WebIdentity, groupId: number): Promise<RCQGroup> {
    return request<RCQGroup>(id, 'GET', `/groups/${groupId}`)
  },

  // Live poll tallies (counts + my_votes + voter_uins for non-anonymous).
  loadPoll(id: WebIdentity, pollId: number): Promise<PollOut> {
    return request<PollOut>(id, 'GET', `/polls/${pollId}`)
  },

  // Toggle the caller's vote on an option; returns the refreshed tally.
  votePoll(id: WebIdentity, pollId: number, optionIndex: number): Promise<PollOut> {
    return request<PollOut>(id, 'POST', `/polls/${pollId}/vote`, { option_index: optionIndex })
  },

  /// Register a new poll's shape on the group's island. `message_id` is the
  /// envelope UUID we are about to send — that is what ties the tally rows to
  /// the ballot the members will decrypt. Body fields and their order mirror
  /// Android's `RcqApi.CreatePollBody`.
  createPoll(
    id: WebIdentity,
    groupId: number,
    body: { message_id: string; num_options: number; single_choice: boolean; anonymous: boolean },
  ): Promise<CreatePollOut> {
    return request<CreatePollOut>(id, 'POST', `/groups/${groupId}/polls`, body)
  },

  createGroup(id: WebIdentity, name: string, memberUINs: number[]): Promise<RCQGroup> {
    return request<RCQGroup>(id, 'POST', '/groups', {
      name,
      member_uins: memberUINs,
    })
  },

  addGroupMember(id: WebIdentity, groupId: number, uin: number): Promise<RCQGroup> {
    return request<RCQGroup>(id, 'POST', `/groups/${groupId}/members`, { uin })
  },

  removeGroupMember(id: WebIdentity, groupId: number, uin: number): Promise<unknown> {
    return request<unknown>(id, 'DELETE', `/groups/${groupId}/members/${uin}`)
  },

  renameGroup(id: WebIdentity, groupId: number, name: string): Promise<RCQGroup> {
    return request<RCQGroup>(id, 'PATCH', `/groups/${groupId}`, { name })
  },

  /// Everything an owner (or a member they granted `info`) can change about a
  /// group, in the shape the phones use. Only the keys you pass are sent;
  /// an empty string CLEARS description, pin and avatar, which is how the
  /// island reads "remove" on those three.
  patchGroup(
    id: WebIdentity,
    groupId: number,
    body: {
      name?: string
      description?: string
      pinned_text?: string
      post_policy?: 'all' | 'owner_only'
      is_closed?: boolean
      members_hidden?: boolean
      avatar_media_id?: string
      avatar_media_key?: string
    },
  ): Promise<RCQGroup> {
    return request<RCQGroup>(id, 'PATCH', `/groups/${groupId}`, body)
  },

  /// Grant / revoke a member's moderator capabilities. Owner only, server-side
  /// too. Returns the whole group, roster included.
  setMemberPermissions(
    id: WebIdentity,
    groupId: number,
    uin: number,
    permissions: string[],
  ): Promise<RCQGroup> {
    return request<RCQGroup>(id, 'POST', `/groups/${groupId}/members/${uin}/permissions`, {
      permissions,
    })
  },

  /// Set the group's single pinned-announcement slot. Used by both the
  /// settings editor and "Pin" from a chat message (one slot — the latest
  /// write wins, replacing whatever was pinned before). Empty string clears it.
  setGroupPinnedText(id: WebIdentity, groupId: number, pinnedText: string): Promise<RCQGroup> {
    return request<RCQGroup>(id, 'PATCH', `/groups/${groupId}`, { pinned_text: pinnedText })
  },

  deleteGroup(id: WebIdentity, groupId: number): Promise<unknown> {
    return request<unknown>(id, 'DELETE', `/groups/${groupId}`)
  },

  /// Non-member preview for a group-invite link — name, member count,
  /// owner, open/closed. Used by the in-chat join card + `/g/:id` page.
  groupPreview(id: WebIdentity, groupId: number): Promise<GroupPreview> {
    return request<GroupPreview>(id, 'GET', `/groups/${groupId}/preview`)
  },

  /// Self-join an open group. Idempotent — already-member returns the
  /// group; a closed group rejects a non-member with 403 {code:
  /// "group_closed"}, a blocked user with 403 {code: "blocked"}.
  joinGroup(id: WebIdentity, groupId: number): Promise<RCQGroup> {
    return request<RCQGroup>(id, 'POST', `/groups/${groupId}/join`)
  },

  /// Per-member fan-out send. The `payloads` list pairs each member
  /// with the ciphertext encrypted to their own identity key —
  /// server has no plaintext access (same envelope format as 1:1).
  sendGroupSealed(
    id: WebIdentity,
    groupId: number,
    payloads: Array<{ to_uin: number; payload: string }>,
    // The outer type lets the server tell an actual post ("message") from a
    // reaction/edit. It matters for owner_only groups: the server gates only
    // "message" on owner-identity, so members can still react. Defaults to
    // "message" for plain text/media sends.
    envelopeType: string = 'message',
  ): Promise<unknown> {
    return request<unknown>(id, 'POST', '/messages/group-sealed', {
      group_id: groupId,
      envelope_type: envelopeType,
      payloads,
    })
  },

  /// Sender-keys encrypt-once group send: ONE ciphertext for the whole
  /// group. The server fans the same blob to every member whose client
  /// advertised the `sender_keys` capability. See sendGroupSealed for the
  /// dual-send fallback that covers non-capable members.
  sendGroupBroadcast(
    id: WebIdentity,
    groupId: number,
    payload: string,
    envelopeType: string = 'message',
  ): Promise<unknown> {
    return request<unknown>(id, 'POST', '/messages/group-broadcast', {
      group_id: groupId,
      envelope_type: envelopeType,
      payload,
    })
  },

  /// Advertise this client's capabilities (fire-and-forget at app start).
  advertiseCapabilities(id: WebIdentity, senderKeys: boolean): Promise<void> {
    return request<void>(id, 'POST', '/users/me/capabilities', { sender_keys: senderKeys })
  },

  // Account -------------------------------------------------

  burnAccount(id: WebIdentity): Promise<void> {
    return request<void>(id, 'DELETE', '/auth/account')
  },

  /// Submit a bug report / feedback. Rides the same `/reports` channel as the
  /// mobile clients' in-app bug bounty: target_uin = self, context =
  /// "bug_bounty", the body prefixed with the platform tag so the admin queue
  /// shows where it came from. Server rate-limits bug reports to 20/hr per uin
  /// (abuse reports about another user are the 5/hr budget).
  sendReport(
    id: WebIdentity,
    text: string,
    attachments: { media_id: string; key: string; mime: string; size: number }[] = [],
    tag: string = REPORT_TAG,
  ): Promise<{ id: number }> {
    return request<{ id: number }>(id, 'POST', '/reports', {
      target_uin: id.uin,
      reason: `${tag} ${text}`,
      context: 'bug_bounty',
      attachments,
    })
  },

  /// The reports this account filed, newest first (server caps at 50), with
  /// the operator's answer when there is one.
  ///
  /// Deliberately NOT gated on the island's "reports open" switch: intake can
  /// be closed, but an answer already written must always be readable.
  myReports(id: WebIdentity): Promise<MyReport[]> {
    return request<MyReport[]>(id, 'GET', '/reports/mine')
  },

  /// Write back on your own report — the half that did not exist, so people
  /// answered a question by filing a second report. 409 when it is closed.
  addToReport(id: WebIdentity, reportId: number, body: string): Promise<ReportTurn> {
    return request<ReportTurn>(id, 'POST', `/reports/mine/${reportId}/messages`, { body })
  },

  /// Withdraw one of your own reports. 404 when it is not yours, 409
  /// `under_review` when it is an open accusation about someone else — that
  /// one is not yours to erase. The deletion is real: no tombstone, and the
  /// evidence blob goes with it.
  deleteMyReport(id: WebIdentity, reportId: number): Promise<void> {
    return request<void>(id, 'DELETE', `/reports/mine/${reportId}`)
  },

  // UIN market ----------------------------------------------

  /// Live availability + price check for a typed UIN. Server is the
  /// authority for availability; `reason` explains an unavailable one
  /// (taken/too_short/too_long/self).
  uinQuote(id: WebIdentity, uin: number): Promise<UinQuote> {
    return request<UinQuote>(id, 'POST', '/uin/quote', { uin })
  },

  /// A handful of random available UINs to seed discovery. Snapshot only
  /// (a suggestion can be taken before purchase — /purchase re-checks).
  uinSuggestions(id: WebIdentity, count = 6): Promise<UinSuggestion[]> {
    return request<UinSuggestion[]>(id, 'GET', `/uin/suggestions?count=${count}`)
  },

  /// Take a UIN. `switch` false (the default) puts it in the collection and
  /// leaves the account answering as it is; true migrates onto it right away
  /// and comes back with the new UIN + a fresh JWT.
  ///
  /// The old `receipt` argument is gone: the server never validated it, and a
  /// field that looks like a payment check but is not is worse than none.
  uinPurchase(id: WebIdentity, uin: number, switchNow = false): Promise<UinPurchaseResult> {
    return request<UinPurchaseResult>(id, 'POST', '/uin/purchase', { uin, switch: switchNow })
  },

  /// Everything this account holds plus the number it answers as. Answers
  /// whether or not the island runs a shop: closing a shop stops new sales,
  /// it does not hide from people what they already own.
  uinMine(id: WebIdentity): Promise<MyUins> {
    return request<MyUins>(id, 'GET', '/uin/mine')
  },

  /// Answer as a number already in the collection. The number in use goes
  /// into the collection in its place, so this is reversible and never loses
  /// one. Migrates, hence the fresh {new_uin, token}.
  uinActivate(id: WebIdentity, uin: number): Promise<UinPurchaseResult> {
    return request<UinPurchaseResult>(id, 'POST', '/uin/activate', { uin })
  },

  /// Take this session out of the account's linked-device list, on the way
  /// out. Only a linked session has an entry; for anything else the server
  /// answers ok and does nothing. Best-effort by design — see `signOut`.
  unlinkSelf(id: WebIdentity): Promise<void> {
    return request<void>(id, 'DELETE', '/devices/me')
  },

  // Calls ---------------------------------------------------

  /// Short-lived TURN credentials for a call, same endpoint the phones use.
  /// An island with no coturn configured answers with an EMPTY `urls` list,
  /// which means "STUN only" rather than an error — the call still connects
  /// on permissive networks and only fails behind a symmetric NAT.
  turnCredentials(id: WebIdentity): Promise<TurnCredentials> {
    return request<TurnCredentials>(id, 'GET', '/users/me/turn-credentials')
  },

  // Audio rooms ---------------------------------------------
  //
  // The list is a subscription list, not a directory: a room appears here
  // because you made it or accepted its key, and `active_count` is who is
  // inside at this instant. Being inside is the websocket mesh in `rooms.tsx`.

  audioRooms(id: WebIdentity): Promise<AudioRoomOut[]> {
    return request<AudioRoomOut[]>(id, 'GET', '/audio_rooms')
  },

  createAudioRoom(id: WebIdentity, name: string): Promise<AudioRoomOut> {
    return request<AudioRoomOut>(id, 'POST', '/audio_rooms', { name })
  },

  joinAudioRoom(id: WebIdentity, joinKey: string): Promise<AudioRoomOut> {
    return request<AudioRoomOut>(id, 'POST', '/audio_rooms/join', { join_key: joinKey })
  },

  /// Drop it from MY list. The room lives on for everyone else.
  forgetAudioRoom(id: WebIdentity, roomId: number): Promise<void> {
    return request<void>(id, 'DELETE', `/audio_rooms/${roomId}/membership`)
  },

  /// Owner only: the room stops existing.
  deleteAudioRoom(id: WebIdentity, roomId: number): Promise<void> {
    return request<void>(id, 'DELETE', `/audio_rooms/${roomId}`)
  },

  /// Owner only. Metadata only: the join key, the membership and anyone
  /// currently inside are untouched.
  renameAudioRoom(id: WebIdentity, roomId: number, name: string): Promise<AudioRoomOut> {
    return request<AudioRoomOut>(id, 'PATCH', `/audio_rooms/${roomId}`, { name })
  },

  /// Owner only: throw someone out and revoke their membership.
  kickFromAudioRoom(id: WebIdentity, roomId: number, uin: number): Promise<AudioRoomOut> {
    return request<AudioRoomOut>(id, 'POST', `/audio_rooms/${roomId}/kick`, { uin })
  },

  /// Owner only: silence one participant. The client honours it locally and
  /// everyone else paints the badge.
  muteAudioRoomMember(id: WebIdentity, roomId: number, uin: number, muted: boolean): Promise<AudioRoomOut> {
    return request<AudioRoomOut>(id, 'POST', `/audio_rooms/${roomId}/members/${uin}/mute`, { uin, muted })
  },

  /// Owner only: nobody but the owner may speak.
  setAudioRoomOwnerOnly(id: WebIdentity, roomId: number, enabled: boolean): Promise<AudioRoomOut> {
    return request<AudioRoomOut>(id, 'POST', `/audio_rooms/${roomId}/owner_only`, { enabled })
  },

  /// Owner only: mint a new join key. Everyone holding the old one keeps their
  /// membership; the old key simply stops letting new people in.
  rotateAudioRoomKey(id: WebIdentity, roomId: number): Promise<{ join_key: string }> {
    return request<{ join_key: string }>(id, 'POST', `/audio_rooms/${roomId}/rotate_key`, {})
  },
}

export interface AudioRoomOut {
  id: number
  name: string
  join_key: string
  owner_uin: number
  capacity: number
  active_count: number
}

// -----------------------------------------------------------
// News — the operator's announcement feed, same one the phones read.
// -----------------------------------------------------------

export interface NewsPost {
  id: number
  body: string
  author_label: string | null
  published_at: string
  attachments?: unknown
}

/// The feed is public and the GET is unauthenticated server-side; it rides the
/// authed helper because every caller here already has an identity and the
/// island should still see which account is reading.
export function fetchNews(id: WebIdentity): Promise<{ items: NewsPost[]; latest_id: number | null }> {
  return request<{ items: NewsPost[]; latest_id: number | null }>(id, 'GET', '/news')
}

/// Convert a server `UserInfo` / `Contact` row to the `PeerBundle`
/// shape `crypto.encryptV1` expects.
export function peerBundleFrom(info: { uin: number; identity_key: string; signing_key: string }): PeerBundle {
  return {
    uin: info.uin,
    identityKey: info.identity_key,
    signingKey: info.signing_key,
  }
}

// -----------------------------------------------------------
// Federation Layer B (F1) — the self-signed home-island record.
// See docs/federation-protocol.md and lib/federation.ts.
// -----------------------------------------------------------

/// Publish this account's signed home-island record to its island.
export function publishIslandRecord(id: WebIdentity, doc: unknown): Promise<{ ok: boolean; ts: number }> {
  return request<{ ok: boolean; ts: number }>(id, 'PUT', '/federation/island-record', doc)
}

/// Fetch a user's signed home-island record from `host`'s island. Throws
/// ApiError(404) when the island holds no record for that uin (the caller then
/// falls back to the single home it was given). The record is public; the GET is
/// unauthenticated server-side but riding the authed helper is harmless.
export function fetchIslandRecord(id: WebIdentity, uin: number): Promise<unknown> {
  return request<unknown>(id, 'GET', `/federation/island-record/${uin}`)
}

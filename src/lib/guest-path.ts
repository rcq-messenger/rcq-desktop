// Guest copies through a paid or invite door (spec 2026-09-15, sections 4, 5,
// 11 and 12): every decision the join and add paths make, with no network and
// no stores, so it is proven offline against the built bundle
// (cli/test/guest-path.mjs) the way crossisland-gate.ts is.
//
// What the rules are for. A paid island refuses `/auth/register` without a
// voucher, and both §5c guest paths used to be plain registrations, so nobody
// from another island could enter a room there and its owners could not add
// contacts from elsewhere. An island that runs the new code and admits guests
// says `guest_accounts_v1: true` in /server/info. There, and only there, the
// client takes the new routes; everywhere else (old islands, open islands,
// is2) it keeps the recover-first/register path it always had.

/// Which of the two ways onto an island this client takes.
export type GuestPath = 'legacy' | 'guest'

/// Section 12.1, the same table on every client:
///   no /server/info (unreachable)            -> legacy
///   capabilities.guest_accounts_v1 !== true  -> legacy
///   otherwise                                -> guest
/// ⚠ Strictly `true`. A string, a 1 or a missing field is an island that did
/// not say so, and the new routes on such an island are a 404 at best.
export function decideGuestPath(
  info: { capabilities?: { guest_accounts_v1?: unknown } | null } | null | undefined,
): GuestPath {
  return info?.capabilities?.guest_accounts_v1 === true ? 'guest' : 'legacy'
}

/// An island's refusal, read by its JSON code and never by substring (12.1).
/// `code` is `detail.code` when `detail` is an object, or `detail` itself when
/// it is a bare string (FastAPI's own "Not Found", and the English strings
/// `add_member` still answers with for native targets).
export interface GuestRefusal {
  status: number
  code: string | null
  /// `guest_add_limit` says which limit: "seat" or "group".
  scope: string | null
  /// `identity_rotated` names the number the key was retired from.
  uin: number | null
}

export function guestRefusalOf(status: number, body: string | null | undefined): GuestRefusal {
  const out: GuestRefusal = { status, code: null, scope: null, uin: null }
  if (!body) return out
  try {
    const doc = JSON.parse(body) as { detail?: unknown }
    const d = doc?.detail
    if (typeof d === 'string') {
      out.code = d
    } else if (d && typeof d === 'object') {
      const o = d as Record<string, unknown>
      if (typeof o.code === 'string') out.code = o.code
      if (typeof o.scope === 'string') out.scope = o.scope
      if (typeof o.uin === 'number') out.uin = o.uin
    }
  } catch {
    /* not JSON: a proxy page, an HTML 502 */
  }
  return out
}

/// What one `POST /auth/guest` (or its challenge) came to.
///  * ok       the island answered 200/201 with a session
///  * retry    the challenge went stale, was spent, or the key is mid-create:
///             ONE more attempt with a fresh challenge
///  * rotated  the key was retired there: the rotated-elsewhere flow, NEVER a
///             wipe (C0, P0.2)
///  * legacy   the island has no such route after all (404/405 with no code of
///             this endpoint): today's recover-first/register path
///  * recover  5xx or no answer: one recover-first attempt, whose credentials
///             are used if it has any
///  * refused  everything else: its sentence, and no legacy fallback, because
///             registering at the door would only be refused there too
export type GuestAttemptVerdict = 'ok' | 'retry' | 'rotated' | 'legacy' | 'recover' | 'refused'

const RETRY_CODES: ReadonlySet<string> = new Set(['invalid_challenge', 'guest_replayed', 'guest_busy'])
/// 404 codes that belong to `/auth/guest` itself. A 404 carrying anything else
/// is a router that does not know the path.
const OWN_404_CODES: ReadonlySet<string> = new Set(['group_not_found', 'identity_rotated'])

/// `status` null means the request never got an answer (network, abort).
export function guestAttemptVerdict(status: number | null, code: string | null): GuestAttemptVerdict {
  if (status == null || status === 0) return 'recover'
  if (status >= 200 && status < 300) return 'ok'
  if (code != null && RETRY_CODES.has(code)) return 'retry'
  if (code === 'identity_rotated') return 'rotated'
  if ((status === 404 || status === 405) && !(code != null && OWN_404_CODES.has(code))) return 'legacy'
  if (status >= 500) return 'recover'
  return 'refused'
}

/// F2 (16.09, the same rule on every client): a key retired by a rotation is
/// not a refused join. The moment an island answers `identity_rotated` the
/// account's rotated-elsewhere notice goes up over the whole app
/// (rotated-signal.ts, raised by identity-context.tsx), and that notice IS the
/// answer: it says what happened and the one way on from it. A second sentence
/// beside it, on whichever card the person happened to tap, reads as a
/// different problem and competes with the flow they are meant to follow.
///
/// So every SCREEN asks this first and shows nothing of its own when it is
/// true, whatever shape the error arrived in. `guestJoinErrorKey` still names a
/// sentence for the code, for a caller that raises no notice at all (the
/// console prints its line), never for a screen that has one.
export function rotatedElsewhereRefusal(code: string | null | undefined): boolean {
  return code === 'identity_rotated'
}

/// The sentence for a join that did not happen (12.5), or null when the code
/// is not one of ours and the caller keeps its own generic line. Every key
/// takes `{host}`; keys that do not use it ignore it.
///
/// `entry_required` / `invite_required` come back only from the LEGACY path, an
/// island too old for guests: the sentence says so instead of sending a person
/// to buy entry for a room they only wanted to read.
export function guestJoinErrorKey(code: string | null | undefined, status?: number): string | null {
  switch (code) {
    case 'guest_closed':
      return 'guest.join.closed'
    case 'guest_room_closed':
      return 'guest.join.room_closed'
    case 'guest_room_full':
      return 'guest.join.room_full'
    case 'guest_room_limit':
      return 'guest.join.room_limit'
    case 'guest_group_limit':
      return 'guest.join.group_limit'
    // A stale or spent challenge and a key mid-create were already retried once
    // in silence (guestAttemptVerdict); a second one, and the island's own
    // ceiling in front of the mint, are the same "try later" (D3).
    case 'invalid_challenge':
    case 'guest_replayed':
    case 'guest_busy':
    case 'island_busy':
    case 'guest_unavailable':
      return 'guest.unavailable'
    case 'guest_key_retired':
      return 'group.add.foreign.stale_key'
    case 'target_guest':
      return 'group.transfer.err.target_guest'
    case 'guest_restricted':
      return 'guest.restricted'
    case 'rate_limited':
      return 'guest.join.rate'
    case 'entry_required':
      return 'guest.join.old_paid'
    case 'invite_required':
    case 'invite_invalid':
      return 'guest.join.old_invite'
    case 'identity_rotated':
      return 'auth.rotated_elsewhere'
    case 'group_closed':
      return 'group_join.closed_hint'
    case 'blocked':
      return 'group_join.error.blocked'
    case 'group_not_found':
      return 'group_join.gone'
  }
  // A dependency limiter answers 429 in its own shape; any other 429 on these
  // routes is the same wait.
  if (status === 429) return 'guest.join.rate'
  return null
}

/// The sentence for an add that did not land, from the island's refusal. New
/// codes first (sections 5 and 11), then the English strings `add_member` has
/// always answered with for native targets, which only a substring can read.
///
/// `status` is the HTTP status, for the one case the body cannot carry: a
/// limiter in front of the island that answers 429 with a page of its own.
/// Android reads it (`GuestPath.shared`) and so does iOS (`GuestSentence.add`),
/// and without it this table alone said "couldn't add" where the other two said
/// "too many attempts" (E2, one table on every client).
export function groupAddErrorKey(
  code: string | null | undefined,
  scope: string | null | undefined,
  message: string | null | undefined,
  status?: number,
): string {
  switch (code) {
    case 'guest_restricted':
      return 'group.add.foreign.guest_adder'
    case 'guest_room_closed':
      return 'guest.join.room_closed'
    case 'guest_closed':
      return 'guest.join.closed'
    case 'guest_room_full':
      return 'guest.join.room_full'
    case 'guest_room_limit':
      return 'guest.join.room_limit'
    case 'guest_group_limit':
      return 'guest.join.group_limit'
    case 'guest_add_limit':
      return scope === 'seat' ? 'group.add.foreign.seat_limit' : 'group.add.foreign.limit'
    case 'guest_key_retired':
      return 'group.add.foreign.stale_key'
    case 'invalid_challenge':
    case 'guest_replayed':
    case 'guest_busy':
    case 'island_busy':
    case 'guest_unavailable':
      return 'guest.unavailable'
    case 'target_guest':
      return 'group.transfer.err.target_guest'
    case 'rate_limited':
      return 'guest.join.rate'
    case 'blocked':
      return 'group.add.err.blocked'
    case 'invite_contacts_only':
      return 'group.add.err.contacts_only'
    case 'invite_nobody':
      return 'group.add.err.nobody'
  }
  // The native strings arrive as a bare-string `detail` (read as `code` by
  // guestRefusalOf) or inside an error message, so both are looked in.
  const m = `${code ?? ''}\n${message ?? ''}`
  if (m.includes('the group owner has blocked this user')) return 'group.add.err.blocked'
  if (m.includes('only accepts group invites from their contacts')) return 'group.add.err.contacts_only'
  if (m.includes('does not accept group invites')) return 'group.add.err.nobody'
  if (m.includes('no such user')) return 'group.add.err.no_user'
  // A limiter that lost its body, the same line the join and the settle show.
  if (status === 429) return 'guest.join.rate'
  return 'group.add.err.failed'
}

/// The body of `POST /auth/guest` (section 4.2). Keys go as the standard
/// padded spelling the proof signed. No home host, no home number, no
/// `desired_uin`: nothing about where this person lives.
export function guestJoinBody(p: {
  host: string
  groupId: number
  nickname: string
  identityKey: string
  signingKey: string
  challenge: string
  signature: string
  /// Our number at home, which the name must never carry (D1).
  homeUin?: number
}): Record<string, unknown> {
  return {
    v: 1,
    host: p.host,
    group_id: p.groupId,
    nickname: neutralGuestNickname(p.nickname, p.homeUin != null ? [p.homeUin] : []),
    identity_key: p.identityKey,
    signing_key: p.signingKey,
    challenge: p.challenge,
    signature: p.signature,
  }
}

/// The body of a LEGACY guest registration (12.3): the register challenge and
/// its signature when the island handed one out, and ⚠⚠ never `desired_uin`.
/// The backup-home registration asks to keep our home number there; a guest
/// copy asking the same would park a room's guest on our home digits and tell
/// that island which number we hold at home.
export function legacyGuestRegisterBody(p: {
  nickname: string
  identityKey: string
  signingKey: string
  challenge?: string
  signature?: string
  /// Our number at home, which the name must never carry (D1).
  homeUin?: number
}): Record<string, unknown> {
  return {
    nickname: neutralGuestNickname(p.nickname, p.homeUin != null ? [p.homeUin] : []),
    identity_key: p.identityKey,
    signing_key: p.signingKey,
    ...(p.challenge && p.signature ? { challenge: p.challenge, signature: p.signature } : {}),
  }
}

/// The body of `POST /groups/{id}/guests` (section 5): the contact's PUBLIC
/// keys and a name, from the card we pinned. No home host, no home number.
export function guestAddBody(card: {
  identityKey: string
  signingKey: string
  nickname: string
  uin: number
}): { identity_key: string; signing_key: string; nickname: string } {
  return {
    identity_key: card.identityKey,
    signing_key: card.signingKey,
    nickname: neutralGuestNickname(card.nickname, [card.uin]),
  }
}

/// The body of the `PUT /users/me` that follows a join, which is the ONLY
/// thing this client ever writes to a profile on another island (#985(2): the
/// copy is named by whoever registered it until we say otherwise, and no island
/// carries a rename across).
///
/// ⚠⚠ D1 covers this request too. The name our home island holds is often the
/// minted default (`user-1234`, auth.ts suggestNickname), which reads as a
/// number and is what a room's members on that island would see; a name holding
/// our home number would hand that island the digits we hold at home for
/// nothing. Both become the neutral word. Null when there is no name to push.
export function guestProfileBody(name: string | null | undefined, homeUin?: number): { nickname: string } | null {
  if (!clampNickname(name ?? '')) return null
  return { nickname: neutralGuestNickname(name, homeUin != null ? [homeUin] : []) }
}

/// What a request to another island says as a name when it has none of its own
/// to say (D1): a word, the same on every client, and no digits at all.
export const GUEST_NICKNAME_PLACEHOLDER = 'Guest'

/// ⚠⚠ D1: no request to a foreign island may carry a home number as a name. The
/// server requires a nickname on both guest routes (`min_length=1`), so an
/// empty one becomes the placeholder instead of being left out. A name that is
/// a number (`user-1234`, `#1234`, `1234`) or that holds one of `homeUins` as a
/// whole number is replaced too: the digits in `user-<uin>` are exactly what
/// the fallback used to leak, and a random `user-NNNN` reads as one.
export function neutralGuestNickname(name: string | null | undefined, homeUins: ReadonlyArray<number> = []): string {
  const clamped = clampNickname(name ?? '')
  if (!clamped) return GUEST_NICKNAME_PLACEHOLDER
  if (/^(?:user-|#)?\d+$/i.test(clamped)) return GUEST_NICKNAME_PLACEHOLDER
  for (const uin of homeUins) if (nameCarriesNumber(clamped, uin)) return GUEST_NICKNAME_PLACEHOLDER
  return clamped
}

/// True when `name` spells `uin` as a whole run of digits: `user-4242`,
/// `#4242`, `Anna 4242`. `Anna 42420` is another number and not ours.
export function nameCarriesNumber(name: string, uin: number): boolean {
  if (!Number.isSafeInteger(uin) || uin <= 0) return false
  return new RegExp(`(^|\\D)${uin}(\\D|$)`).test(name)
}

/// E6, the legacy-name repair: the `PUT /users/me` body that takes our HOME
/// NUMBER off the copy on another island, or null when there is nothing to
/// repair.
///
/// Why it exists. Before D1 every guest copy was minted or renamed with the
/// `user-<uin>` fallback, and the uin in it is our number at HOME: the one
/// thing a copy exists not to tell the island it lives on. Those names are
/// still sitting on islands this account joined, and no island carries a
/// rename across, so only this client can take them off. Done once per island,
/// on the next sign-in there, and only when the stored name really spells our
/// own number: a name that merely looks like a number (`user-9`, somebody
/// else's digits) is the island's business, not a leak of ours, and renaming
/// it would be us overwriting a name we did not choose for no gain.
///
/// ⚠⚠ Never on a backup home. There the number is published on purpose (the
/// signed island record), and the caller is the one that knows which hosts
/// those are.
export function legacyNicknameRepairBody(
  current: string | null | undefined,
  homeUin: number,
): { nickname: string } | null {
  const name = clampNickname(current ?? '')
  if (!name) return null
  if (!nameCarriesNumber(name, homeUin)) return null
  return { nickname: GUEST_NICKNAME_PLACEHOLDER }
}

function clampNickname(name: string): string {
  return Array.from((name || '').trim()).slice(0, 64).join('')
}

/// 12.1 owner-add step 2: the contact's card fetched from their home again,
/// against the card we pinned. True only when the island served a key that
/// decodes and is a DIFFERENT key: then the person rotated and a seat minted
/// from our copy would open for whoever holds the old seed. No card
/// (unreachable) or a field that does not decode is not evidence of anything,
/// and the add goes on with the pinned card.
export function cardIsStale(
  pinned: { identityKey: string; signingKey: string },
  fetched: { identity_key?: unknown; signing_key?: unknown } | null | undefined,
): boolean {
  if (!fetched) return false
  return differs(pinned.identityKey, fetched.identity_key) || differs(pinned.signingKey, fetched.signing_key)
}

function differs(pinned: string, served: unknown): boolean {
  if (typeof served !== 'string' || !served) return false
  const a = b64Bytes(pinned)
  const b = b64Bytes(served)
  if (!a || !b) return false
  if (a.length !== b.length) return true
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff !== 0
}

function b64Bytes(s: string): Uint8Array | null {
  const clean = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  if (!clean || /[^A-Za-z0-9+/]/.test(clean) || clean.length % 4 === 1) return null
  try {
    const bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/// Roster self row says our account on this island is a guest copy (2.3).
/// Absent on an island older than the flag, which reads as not a guest.
export function rosterSelfIsGuest(
  members: ReadonlyArray<{ uin: number; guest?: boolean }> | null | undefined,
  myUin: number,
): boolean {
  return !!members?.some((m) => m.uin === myUin && m.guest === true)
}

/// E5, and F8 (16.09): "Add member" and the invite entry points are hidden
/// wherever OUR session on the room's island is a guest copy. The island
/// answers 403 `guest_restricted` to every add from a guest (section 11), so
/// the button can only ever walk the person into a refusal we could have
/// predicted. The share link stays: it is the one way a guest DOES bring
/// people into the room.
///
/// Which session is "ours" is decided by the room, and so is which flag
/// answers:
///   * a room on ANOTHER island: the copy we hold THERE (`copyIsGuest`, read
///     from that room's own roster under our number there, or from the visited
///     record). Our home account being a guest somewhere else says nothing
///     about this island;
///   * a room on OUR OWN island: the primary session itself
///     (`primaryIsGuest`). ⚠ F8, and the half that was missing: an account
///     signed in BY PHRASE into a guest copy is a guest on its own island,
///     every room it is in is a local room, and the add button was offered in
///     all of them for the island to refuse one name at a time.
///
/// Null or false is "not a guest", never a guess, so an island too old for the
/// flag keeps today's screen. The same rule and the same three inputs as
/// Android's `GuestPath.hideAddInRoom` (net/GuestPath.kt), so the two cannot
/// drift.
export function hideAddInRoom(
  roomHost: string | null | undefined,
  copyIsGuest: boolean | null | undefined,
  primaryIsGuest?: boolean | null,
): boolean {
  const foreign = roomHost != null && roomHost !== ''
  return foreign ? copyIsGuest === true : primaryIsGuest === true
}

/// A roster row that does not live on the room's island: a proven guest copy or
/// an unclaimed seat.
function nonResident(m: { guest?: boolean; invited?: boolean }): boolean {
  return m.guest === true || m.invited === true
}

/// 12.1 Leaving, as D8 has it for every client: whoever leaves, when the roster
/// shows at least one other member and every other member is a guest or an
/// unclaimed seat, the island deletes the room for everyone (section 8.1), so
/// the leaver is told first. A leaver who is a guest themselves is not the last
/// resident of anything.
///
/// ⚠ Three answers, not two (E4). "No roster in hand" is NOT "nothing to warn
/// about": a group row in the list carries no members, and reading that as a
/// quiet no deleted rooms without a word. `unknown` tells the caller to fetch
/// the roster (one request) and ask again; only an answer from a roster that
/// has us in it decides.
export type LeaveVerdict = 'last_resident' | 'unknown' | 'plain'

export function leaveWarningVerdict(
  members: ReadonlyArray<{ uin: number; guest?: boolean; invited?: boolean }> | null | undefined,
  myUin: number,
  /// The room's real member count when the caller knows it (`member_count`,
  /// which every island sends beside the roster and instead of it).
  total?: number | null,
): LeaveVerdict {
  if (!members || members.length === 0) return 'unknown'
  const me = members.find((m) => m.uin === myUin)
  // A roster without our own row is a partial page or a hidden one, and the
  // rule below would read "everyone else is a guest" off half a room.
  if (!me) return 'unknown'
  // F7 (16.09): so is a roster SHORTER than the room. A list row fetched with
  // `?members=0` carries the count and no members, a hidden roster carries
  // fewer rows than there are people, and an island may page a big one. Our own
  // row being on the page proves only that the page has us; every other member
  // may be sitting on the part we never received, and "everyone else here is a
  // guest" read off half a room deletes the room without a word. A short page
  // is NOT known: the caller fetches the rest and asks again.
  if (typeof total === 'number' && Number.isFinite(total) && members.length < total) return 'unknown'
  if (nonResident(me)) return 'plain'
  const others = members.filter((m) => m.uin !== myUin)
  if (others.length === 0) return 'plain'
  return others.every(nonResident) ? 'last_resident' : 'plain'
}

/// Whether the confirm shows the 12.5 warning, once the caller has spent its
/// one roster fetch (E4). `foreign` is "this room lives on another island".
///
/// A roster still unknown after the fetch is a room whose members this client
/// cannot see (hidden, or an island that would not answer). On another island
/// that is exactly the case the decision names: we may be the last resident
/// there and leaving may take the room with us, and leaving in silence on a
/// maybe is the failure this rule exists to stop. On our own island the room's
/// members are ours to lose and the plain confirm stands, as it always has.
export function leaveWarnAfterFetch(verdict: LeaveVerdict, foreign: boolean): boolean {
  if (verdict === 'last_resident') return true
  return verdict === 'unknown' && foreign
}

/// The verdict as a plain boolean, for a caller that already holds the roster
/// it is going to act on.
export function lastResidentLeave(
  members: ReadonlyArray<{ uin: number; guest?: boolean; invited?: boolean }> | null | undefined,
  myUin: number,
  total?: number | null,
): boolean {
  return leaveWarningVerdict(members, myUin, total) === 'last_resident'
}

/// How a roster row reads next to its name (2.3, D5): a seat nobody has opened
/// yet, a copy from another island, or neither.
export type MemberMark = 'guest' | 'invited' | null

export function memberMarkOf(member: { guest?: boolean; invited?: boolean } | null | undefined): MemberMark {
  if (!member) return null
  if (member.invited === true) return 'invited'
  if (member.guest === true) return 'guest'
  return null
}

/// The profile link for a member of a room (D5). `host` is the room's island
/// when it is not ours (#985(2)). The roster's mark rides along, because a
/// cross-island card is never fetched and the profile page has no other way to
/// learn that the number is a guest copy or an unclaimed seat.
export function memberProfileHref(
  uin: number,
  host: string | null | undefined,
  member?: { guest?: boolean; invited?: boolean } | null,
): string {
  const q: string[] = []
  if (host) q.push(`i=${encodeURIComponent(host)}`)
  const mark = memberMarkOf(member)
  if (mark === 'invited') q.push('invited=1')
  else if (mark === 'guest') q.push('guest=1')
  return `/profile/${uin}${q.length ? `?${q.join('&')}` : ''}`
}

/// The mark a profile page reads from its own link (`?guest=1`, `?invited=1`)
/// and from the card the island served (`guest: true`, own island only).
export function profileMarkOf(query: { get(key: string): string | null }, card?: { guest?: boolean } | null): MemberMark {
  if (query.get('invited') === '1') return 'invited'
  if (query.get('guest') === '1' || card?.guest === true) return 'guest'
  return null
}

/// What a peer's profile page offers (D5, D6):
///   * signed in as a guest copy: nothing (no request, no 1:1 from a copy);
///   * an unclaimed seat: nothing (nobody holds that key yet);
///   * a guest copy: one Add, the ordinary contact request to that number on
///     the room's island, which the person's home client picks up through its
///     pending poll (C1); never Message, so never a call or a visit either;
///   * anyone else: Add for a stranger, Message otherwise, as before.
export function peerProfileActions(p: {
  primaryGuest: boolean
  mark: MemberMark
  relationship: 'contact' | 'stranger' | 'unknown'
}): { add: boolean; message: boolean } {
  if (p.primaryGuest || p.mark === 'invited') return { add: false, message: false }
  if (p.mark === 'guest') return { add: p.relationship === 'stranger', message: false }
  if (p.relationship === 'stranger') return { add: true, message: false }
  return { add: false, message: true }
}

/// WHERE that one Add goes once `peerProfileActions` has offered it (D5).
///
///   * 'request'  the ordinary `POST /contacts/request` to that number on THIS
///     island. A marked guest copy on our own island, and it is not a
///     shortcut: the island keeps guest rows out of `/users/search` for every
///     caller (routers/users.py, `User.guest_status.is_(None)`, "Nor guest
///     copies, whoever asks"), so the add screen seeded with `#uin` can only
///     ever answer "no matches" and no request could leave at all. The copy's
///     home client surfaces the request through its pending poll (C1).
///   * 'search'   the add screen, seeded with the address: everybody else, and
///     ⚠ a guest copy on ANOTHER island too. That one is added as `uin@host`,
///     which needs the federation card, the keys pinned from it and the sealed
///     §5f deposit — all of which live on that screen and nowhere else.
export function profileAddMode(p: {
  mark: MemberMark
  crossIslandHost?: string | null
}): 'request' | 'search' {
  return p.mark === 'guest' && !p.crossIslandHost ? 'request' : 'search'
}

/// The sentence for a settle refusal (9.1, 12.1). Null for a code the caller
/// shows its generic line for. `not_a_guest` is not an error for the person:
/// the row is already a resident's.
export function guestSettleErrorKey(code: string | null | undefined, status?: number): string | null {
  switch (code) {
    case 'entry_required':
      return 'auth.error.entry_required'
    case 'invite_required':
      return 'auth.error.invite_required'
    // `bad_signature` is a voucher whose signature does not verify: the same
    // "that code was not accepted" as a voucher for another island or an
    // expired one, and the same key iOS shows (`GuestSentence.settle`).
    case 'invite_invalid':
    case 'voucher_other_island':
    case 'voucher_expired':
    case 'bad_signature':
      return 'auth.error.invite_invalid'
    case 'voucher_spent':
      return 'residency.code_spent'
    case 'invite_has_number':
      return 'guest.settle.number_invite'
    case 'not_a_guest':
      return 'guest.settle.done'
    // A DENY route answers this to a guest anywhere, the settle included when
    // an older island refuses it outright (section 11, `guest_restricted`).
    case 'guest_restricted':
      return 'guest.restricted'
    case 'guest_busy':
    case 'island_busy':
    case 'guest_unavailable':
      return 'guest.unavailable'
    case 'rate_limited':
      return 'guest.join.rate'
  }
  if (status === 429) return 'guest.join.rate'
  return null
}

/// The sentence for a refused ownership handover when the refusal is about
/// guests (section 11): null for every other code, which the screen's own
/// table reads.
export function transferGuestErrorKey(code: string | null | undefined): string | null {
  return code === 'target_guest' ? 'group.transfer.err.target_guest' : null
}

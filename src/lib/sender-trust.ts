// Who sealed this envelope? One answer, asked right after the decrypt and
// before ANY branch of the receive path acts on what it says.
//
// Pure on purpose, like crossisland-gate.ts: the receive router gathers what
// this device holds about the number (the roster row, the key first seen here,
// the cross-island rows, a room's member row) and hands it in, so the rule can
// be proven offline against the built bundle (cli/test/sender-auth.mjs).
//
// Why it exists (sender-auth audit, 11.10). A v=1 seal proves ONE thing: which
// Ed25519 key signed ek||env (`spub`, checked in decryptV1). `from` and
// `from_host` sit beside the signature, unsigned, and the deposit is
// anonymous. The only place `spub` was ever compared with anything was the
// cross-island gate, and only when the sender chose to write a foreign
// `from_host`. So anyone holding a recipient's open key card could seal
// `{from: V}` with their own key, leave the host out, and land text, edits,
// deletes, receipts, room keys, profile keys and sender-key chains as V, a
// contact of the recipient on the same island, or as any member of a room.
// Every branch of route() now starts from the verdict below, never from the
// bare number.
//
// The four answers:
//  * SELF     our own number under our own key (v=1), or one of our own
//             devices whose identity our island publishes (v=2);
//  * PINNED   the key is the one held for that number: our island's roster
//             row, a cross-island contact, or a room's member row. The island
//             and the thread come from THAT row, never from `from_host`;
//  * UNPINNED nothing here holds this number as a contact: a stranger, under
//             the stranger rules that already exist for their island. A key
//             pinned for them here all the same (a room member who wrote, a
//             request accepted, a contact since removed) still has to match;
//  * FORGED   a key IS held for this number (or the number is ours) and the
//             seal was made with another one. Content goes to the requests
//             list flagged as a changed key, control traffic is dropped.
//
// v=2 rows name no signing key. Their sender is the libsignal identity behind
// the session, and signal-device.ts checks that identity against the one our
// island publishes for (number, device) before it decrypts anything
// (verifyV2Identity). A row that passed is the island's holder of that number,
// which is the same standing a roster key has; one that did not is FORGED.

import { canonicalHost, sameSigningKey } from './crossisland-gate'

export type SenderTrust = 'self' | 'pinned' | 'unpinned' | 'forged'

/// The outcome of the v=2 identity check (signal-device verifyV2Identity).
export type V2Identity = 'verified' | 'mismatch'

export interface DirectTrustInput {
  senderUin: number
  myUin: number
  /// The key a v=1 seal verified under. Null on a v=2 row.
  spub: string | null
  /// The v=2 identity check. Null on a v=1 row.
  v2: V2Identity | null
  ownSigningKey: string | null
  /// `from_host` when it names ANOTHER island (any spelling of ours is null).
  /// Unsigned: it only says where to file a request, never who sent it.
  claimedHost: string | null
  /// Our island's roster row for this number, null when it is not a contact.
  /// `key` is null when the row carries no signing key and the card fallback
  /// found none either.
  roster: { key: string | null } | null
  /// The key first seen here for this number on our island (sign-pins.ts).
  pin: string | null
  /// A fresh read of their card, asked for only once a seal did not match:
  /// undefined = not asked yet, null = asked and nothing came back.
  card?: string | null
  /// Every cross-island contact this device holds under this number.
  crossIsland: ReadonlyArray<{ host: string; signingKey: string }>
}

export interface TrustVerdict {
  trust: SenderTrust
  /// The sender's island. On PINNED it is read off the row that pinned them
  /// (null = ours). On anything else it is the CLAIMED island, good only for
  /// filing a request under.
  host: string | null
  /// A key is held for this number and the seal was not made with it.
  keyChanged: boolean
  /// PINNED under a key our island vouches for which is not the one first
  /// seen here. The caller re-pins to it and says so on screen: a key never
  /// changes in silence.
  repin?: string
  /// No verdict yet: read the contact's card once (rate-limited, see the
  /// resolver) and ask again with `card` set.
  needsCard?: boolean
  /// A contact whose key nothing on this device can learn. Content is held as
  /// a request, nothing is applied.
  unverified?: boolean
  /// needsCard was set and the island could not be asked (the network, 429,
  /// 5xx, a cutoff): no answer, not a "no". Not a verdict: the row is judged
  /// again on a later drain. Set by the resolver, for a row that can wait
  /// only (one that cannot is judged as if no card came back), never by the
  /// rule.
  cardUnreachable?: boolean
  /// Our own roster could not be read (a fresh browser, /contacts failing),
  /// so a contact cannot be told from a stranger: the same "not yet", on the
  /// same terms.
  rosterUnread?: boolean
}

const pinned = (host: string | null, extra: Partial<TrustVerdict> = {}): TrustVerdict => ({
  trust: 'pinned',
  host,
  keyChanged: false,
  ...extra,
})
const forged = (host: string | null): TrustVerdict => ({ trust: 'forged', host, keyChanged: true })
const unpinned = (host: string | null, extra: Partial<TrustVerdict> = {}): TrustVerdict => ({
  trust: 'unpinned',
  host,
  keyChanged: false,
  ...extra,
})

/// The verdict for a 1:1 row (no group frame).
export function directSenderTrust(i: DirectTrustInput): TrustVerdict {
  const v1 = typeof i.spub === 'string'
  const foreign = i.claimedHost ? canonicalHost(i.claimedHost) : null

  // Our own number. Every installation of the account shares its signing key
  // and every device is published by our island, so nothing of ours ever
  // arrives any other way. The one exception is somebody on ANOTHER island
  // who holds the same digits there: a v=1 seal from a foreign island under a
  // key that is not ours is judged below as who it is, a person over there.
  if (i.senderUin === i.myUin) {
    if (v1 ? sameSigningKey(i.spub, i.ownSigningKey) : i.v2 === 'verified') {
      return { trust: 'self', host: null, keyChanged: false }
    }
    if (!(v1 && foreign)) return forged(null)
  }

  if (!v1) {
    // v=2 is same-island only, and names no signing key: the identity check
    // is the whole of the proof. The island does not vouch for this identity,
    // contact or not: the held row must say so (a changed key), or an accept
    // in the requests list releases it into that number's thread unchecked
    // (PendingRequests refuses a keyMismatch row that names no key).
    if (i.v2 !== 'verified') return forged(null)
    if (i.roster) return pinned(null)
    // The island's holder of this number is a real person, but this device
    // files the number's thread under a contact on another island (threads
    // are keyed by number, report 1061): never into their thread.
    if (i.crossIsland.length > 0) return forged(null)
    return unpinned(null)
  }

  const spub = i.spub as string
  // A key proves who sealed it: any row holding exactly this key is the
  // sender, and the row says where they live.
  const rk = i.roster?.key ?? null
  if (i.roster && rk && sameSigningKey(spub, rk)) {
    // The key our island holds for them.
    if (!i.pin || sameSigningKey(i.pin, rk)) return pinned(null)
    // Roster and pin disagree, and either may be the stale one: the roster
    // may name a key the island changed since (the pin then moved on with
    // a card), or the pin the key before a change the roster shows. Their
    // island's card decides. Taken on the roster's word alone, a contact's
    // OLD key (a leaked phrase, a reissue) spoke as them again and moved the
    // pin back to itself.
    if (i.card === undefined) return { ...forged(null), needsCard: true }
    if (i.card && !sameSigningKey(i.card, spub)) return forged(null)
    // The card agrees with the seal, or the island gave none: the roster's
    // word, as before. A change, and said out loud.
    return pinned(null, { keyChanged: true, repin: rk })
  }
  if (i.roster && !rk && i.pin && sameSigningKey(spub, i.pin)) return pinned(null)
  const ci = i.crossIsland.find((c) => sameSigningKey(c.signingKey, spub))
  if (ci) return pinned(ci.host)
  // A fresh card agreeing with the seal: our island vouches for this key now
  // (a reissue the roster has not caught up with yet).
  if (i.roster && typeof i.card === 'string' && i.card && sameSigningKey(spub, i.card)) {
    const changed = !!i.pin && !sameSigningKey(i.pin, i.card)
    return pinned(null, { keyChanged: changed, repin: i.card })
  }

  // No row holds this key.
  if (foreign) {
    const at = i.crossIsland.find((c) => canonicalHost(c.host) === foreign)
    return at ? forged(at.host) : unpinned(i.claimedHost)
  }
  if (i.roster) {
    // Before calling a contact's seal forged, ask their island once more: a
    // legitimate reissue is absorbed there, not filed as an impostor.
    if (i.card === undefined) return { ...forged(null), needsCard: true }
    if (!rk && !i.pin && !i.card) return unpinned(null, { unverified: true })
    return forged(null)
  }
  // Not a contact here, but this device files the number's thread under a
  // contact on another island.
  if (i.crossIsland.length > 0) return forged(null)
  // Not a contact here, but a key IS held for this number on our island
  // (sign-pins: a room member's verified row, an accepted request, a contact
  // since removed), and their thread is on this device. Same rule as a
  // contact's: the pinned key, or one the island vouches for now (taken with
  // the banner); anyone else is FORGED. Without this, anybody holding our
  // open card wrote, edited and deleted in that thread under the number.
  if (i.pin && !sameSigningKey(spub, i.pin)) {
    if (i.card === undefined) return { ...forged(null), needsCard: true }
    if (typeof i.card === 'string' && i.card && sameSigningKey(spub, i.card)) {
      return unpinned(null, { keyChanged: true, repin: i.card })
    }
    return forged(null)
  }
  return unpinned(null)
}

export interface RoomTrustInput {
  senderUin: number
  /// Our number in THIS room: the home number for a room on our island, our
  /// guest number for a room on another.
  myUin: number
  /// The key the per-member seal verified under, or the key a sender-key
  /// chain was bound to (a broadcast). Null on a v=2 row.
  spub: string | null
  v2: V2Identity | null
  ownSigningKey: string | null
  /// The room roster's row for this number, null when they are not in it.
  /// `key` is null when the row carries no signing key and the card fallback
  /// found none.
  member: { key: string | null } | null
}

export interface RoomVerdict {
  trust: SenderTrust
  /// Worth one roster refresh before believing this: the member may have
  /// joined, or rotated their key, since the copy we hold was read.
  refresh?: boolean
}

/// The verdict for a row inside a room: only a member, under the key the
/// roster holds for them, speaks there.
export function roomSenderTrust(i: RoomTrustInput): RoomVerdict {
  const v1 = typeof i.spub === 'string'
  if (i.senderUin === i.myUin) {
    return { trust: (v1 ? sameSigningKey(i.spub, i.ownSigningKey) : i.v2 === 'verified') ? 'self' : 'forged' }
  }
  if (!i.member) return { trust: 'unpinned', refresh: true }
  if (v1) {
    if (!i.member.key) return { trust: 'unpinned' }
    return sameSigningKey(i.spub, i.member.key) ? { trust: 'pinned' } : { trust: 'forged', refresh: true }
  }
  return { trust: i.v2 === 'verified' ? 'pinned' : 'forged' }
}

/// May control traffic (edit, delete, reaction, receipts) from a 1:1 sender
/// with this verdict be applied at all? SELF and PINNED always; a same-island
/// stranger inside their own thread, under the stranger rules that island has
/// always had; nobody else. Where it may be applied is the store's business
/// (incoming-store.ts): only inside that sender's own thread.
export function directControlAllowed(t: TrustVerdict): boolean {
  if (t.trust === 'self' || t.trust === 'pinned') return true
  return t.trust === 'unpinned' && t.host == null && !t.unverified
}

/// How far ahead of what we know a room key's version may jump. Every client
/// mints the next one as current + 1 (group-state.ts), and the sealed blob's
/// own header names the version it was sealed under, so a member who missed
/// a few rotations is a few behind, never thousands. Without a bound one
/// envelope carrying 2^53 wedged the room for good: `putRoomKey` is monotonic,
/// so every later legitimate key was refused.
export const ROOM_KEY_MAX_AHEAD = 16

export function roomKeyVersionAllowed(ver: unknown, held: number | null | undefined, sealedVer: number | null | undefined): boolean {
  if (typeof ver !== 'number' || !Number.isSafeInteger(ver) || ver < 0) return false
  const base = Math.max(held ?? 0, sealedVer ?? 0)
  return ver <= base + ROOM_KEY_MAX_AHEAD
}

/// An SKDM names the room its chain is for; the frame it rode names the room
/// it was deposited in. Only when they agree may the chain be filed: a chain
/// handed over in room A is never a key for room B.
export function skdmRoomMatches(envGid: unknown, frameGid: number | null | undefined): boolean {
  return typeof envGid === 'number' && typeof frameGid === 'number' && envGid === frameGid
}

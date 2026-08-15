// Federation §5e — cross-island profile refresh (name + picture), both
// directions. Sibling of `crossisland-contactreq.ts` (§5f): same transport,
// same receive placement, same gates.
//
// A cross-island contact's nickname and picture were read exactly ONCE, when
// they were added, out of their open key card — and then never again. The
// same-island path cannot help: `contact_renamed` is a WS broadcast to the
// island's own `contacts` table, which holds a pair of local uins and has no
// host column, so a holder on another island is not in that audience and
// cannot be put in it. Somebody added as "nick1" therefore read "nick1"
// forever.
//
// The fix is a PUSH, not a poll. Re-fetching the open card on a timer is the
// obvious alternative and the wrong one: it is an unauthenticated GET from our
// address to a server we do not control, repeated forever, telling that island
// who is looking at whom and how often — a periodic beacon to a third party to
// keep a cosmetic field fresh, in a system whose whole claim is metadata
// minimisation. So the person who CHANGED their profile deposits a sealed
// `profile` envelope to the islands of the contacts allowed to see it, the
// same shape §5d used for call signalling and §5f for contact requests.
//
// ⚠⚠ PICTURES ARE DEPOSITED, NOT PULLED. The encrypted blob goes to the
// RECIPIENT'S island under the same client-chosen id (§5b `PUT /media/{id}`)
// before the envelope naming it is sent. Pulling would mean an HTTP GET to a
// foreign island on every draw — a per-view beacon, plus a hard dependency on
// that island being up for a face to appear. And the KEY must never reach the
// open key card or the signed home record: both are unauthenticated, while the
// same-island rule for a picture is relationship-based (`owner_self or
// is_contact or shares_group`), and `GET /media/{id}` has no auth at all. The
// key IS the access decision, so it only ever travels sealed to one recipient.
//
// ⚠ This module never writes a contact's pinned `identityKey`/`signingKey`.
// Everything a `profile` carries is cosmetic; the keys stay anchored to the
// card fetched at add/accept time (§2.4).

import { Api } from './api'
import { contactsCache } from './contacts-cache'
import { newUUIDv4, type ProfileEnvelope, type WebIdentity } from './crypto'
import { isBlocked } from './crossisland-requests'
import { applyCrossIslandProfile, getCrossIsland, listCrossIsland, type CrossIslandContact } from './crossisland-store'
import { depositSealedToPrimary } from './federation-send'
import { depositEncryptedBlob, fetchEncryptedBlob } from './media'

const NICKNAME_MAX = 64
// A media id is a client-chosen uuid4 hex (32 chars) or an island-assigned id.
// Bounded and charset-restricted on the way IN because it is interpolated
// straight into `/media/{id}`: a peer-supplied `../…` must not be able to
// steer that fetch anywhere but at a blob.
const MEDIA_ID_MAX = 64
const MEDIA_KEY_MAX = 128
const MEDIA_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/// Our own display state as the wire carries it.
interface OwnProfile {
  nickname: string
  avatarMediaId: string | null
  avatarMediaKey: string | null
}

/// Read our CURRENT profile, island-first.
///
/// The island's copy is the one every same-island contact sees, and it is what
/// the save that triggered this push just wrote — including the case where an
/// older island silently dropped the avatar fields (Pydantic `extra=ignore`,
/// answers 200, commits nothing). Pushing what the island actually kept means
/// a cross-island contact never ends up holding a picture that no one else can
/// see. The warm snapshot is the fallback so a flaky moment still refreshes
/// the name.
async function readOwnProfile(identity: WebIdentity): Promise<OwnProfile | null> {
  try {
    const me = await Api.myInfo(identity)
    return {
      nickname: (me.nickname || `#${identity.uin}`).slice(0, NICKNAME_MAX),
      avatarMediaId: me.avatar_media_id ?? null,
      avatarMediaKey: me.avatar_media_key ?? null,
    }
  } catch {
    const cached = contactsCache.get(identity.uin)?.me
    if (!cached) return null
    return {
      nickname: (cached.nickname || `#${identity.uin}`).slice(0, NICKNAME_MAX),
      avatarMediaId: cached.avatar_media_id ?? null,
      avatarMediaKey: cached.avatar_media_key ?? null,
    }
  }
}

export function buildProfile(p: OwnProfile): ProfileEnvelope {
  return {
    kind: 'profile',
    id: newUUIDv4(),
    ts: Math.floor(Date.now() / 1000), // epoch SECONDS, same as `call`/`contactreq`
    nickname: p.nickname,
    avatar_media_id: p.avatarMediaId,
    avatar_media_key: p.avatarMediaKey,
  }
}

/// Deposit our profile to ONE cross-island contact's primary island.
///
/// `blob` is our already-encrypted avatar, fetched once by the caller and
/// deposited per island. When we HAVE a picture and its blob will not land on
/// their island, we send nothing at all and report failure. That looks
/// over-strict and is not: the envelope is a snapshot, so an absent picture
/// reads as "I removed mine" on the far side. Sending the name with the
/// picture stripped would delete our face from their client on a transient
/// media hiccup — worse than a name that refreshes on the next change.
async function depositProfile(
  identity: WebIdentity,
  peer: CrossIslandContact,
  p: OwnProfile,
  blob: Uint8Array | null,
): Promise<boolean> {
  if (p.avatarMediaId && p.avatarMediaKey) {
    if (!blob) return false
    const stored = await depositEncryptedBlob(peer.host, p.avatarMediaId, blob)
    if (!stored) return false
  }
  // Fall back to the keys pinned when we added them, so the refresh still
  // reaches a peer whose island cannot serve its open card right now.
  return depositSealedToPrimary(identity, peer.host, peer.uin, buildProfile(p), {
    identityKey: peer.identityKey,
    signingKey: peer.signingKey,
  })
}

async function deliverTo(identity: WebIdentity, targets: CrossIslandContact[]): Promise<number> {
  if (targets.length === 0) return 0
  const p = await readOwnProfile(identity)
  if (!p) return 0
  // Read our encrypted avatar ONCE, whatever the number of islands: the bytes
  // are identical for every recipient (same blob, same client-chosen id), only
  // the PUT differs.
  const blob = p.avatarMediaId && p.avatarMediaKey ? await fetchEncryptedBlob(identity.apiBase, p.avatarMediaId) : null
  const results = await Promise.all(targets.map((c) => depositProfile(identity, c, p, blob)))
  return results.filter(Boolean).length
}

/// Push our current name + picture to EVERY accepted cross-island contact.
///
/// Call after a profile change lands on the island (nickname or picture) —
/// nothing else refreshes them. Best effort throughout: a contact whose island
/// is unreachable simply keeps the snapshot they have until our next change,
/// exactly like any other deposit. Returns how many islands accepted it.
export function pushProfileToCrossIslandContacts(identity: WebIdentity): Promise<number> {
  // An entry in this store IS the accepted state in this client (§5f), so the
  // list is already "accepted cross-island contacts" — minus anyone blocked.
  return deliverTo(
    identity,
    listCrossIsland().filter((c) => !isBlocked(c.uin, c.host)),
  )
}

/// Push our current name + picture to ONE freshly-accepted cross-island
/// contact, so they start from a current name instead of whatever their card
/// fetch happened to catch. Both halves of §5f end here: the side that accepts
/// a request, and the side whose request was accepted.
export async function pushProfileTo(identity: WebIdentity, host: string, uin: number): Promise<boolean> {
  const peer = getCrossIsland(uin, host)
  if (!peer || isBlocked(uin, host)) return false
  return (await deliverTo(identity, [peer])) > 0
}

/// Apply a received `profile` from `senderUin@senderHost`.
///
/// Called from the receive router BESIDE the §5f contactreq branch and ABOVE
/// the message quarantine: this is display metadata, never a message, and it
/// must not reach the message store.
///
/// Deliberately synchronous and network-free — nothing here fetches a card, so
/// nothing here can write a pinned key.
export function handleProfile(senderUin: number, senderHost: string, env: ProfileEnvelope): void {
  // Same-island rule, unchanged: a blocked sender is dropped silently.
  if (isBlocked(senderUin, senderHost)) return

  // ⚠ Nothing has type-checked this envelope: the receive path is
  // `JSON.parse(...) as Envelope`, so `nickname` can be an object, a number or
  // absent, from a peer who simply wants it to be. `.trim()` on a non-string
  // throws, and the queue drain catches per BATCH, not per row — one hostile
  // deposit would abort the whole drain, every drain, forever. Coerce instead.
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
  const nickname = str(env.nickname, NICKNAME_MAX)
  const mediaId = str(env.avatar_media_id, MEDIA_ID_MAX)
  const mediaKey = str(env.avatar_media_key, MEDIA_KEY_MAX)
  const ts = typeof env.ts === 'number' && Number.isFinite(env.ts) ? env.ts : 0

  // A sender we do not hold as an accepted cross-island contact gets DROPPED
  // here: applyCrossIslandProfile writes nothing when there is no row, and
  // nothing in this file creates one. Cosmetic data from a stranger is not a
  // reason to put them anywhere — not the roster, not the quarantine, not a
  // pending row. It also means the alias, the keys and the rest of the row are
  // the only things that can ever have made it into that store.
  applyCrossIslandProfile(senderUin, senderHost, {
    nickname,
    avatarMediaId: MEDIA_ID_RE.test(mediaId) ? mediaId : null,
    avatarMediaKey: mediaKey || null,
    ts,
  })
}

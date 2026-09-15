// The consent decision for a sealed envelope from ANOTHER island, on its own.
//
// Pure on purpose: no store, no network, no imports. The receive router asks
// the stores (is this (uin, host) a pinned contact? what key did we pin?) and
// hands the answers here, so the rule itself can be proven offline against
// the built bundle (cli/test/crossisland-gate.mjs), the way member-name.ts is.
//
// Two reports shaped it.
//
// #985(1): the cross-island gate used to hold EVERY envelope kind from an
// unaccepted (uin, host). Everybody on a group's island stamps that island as
// `from_host`, so a co-member's control traffic sent to our guest copy there
// (a `visit` ping from opening a profile, a room-key hand-off) became a
// "message request" with nothing in it. Only content is worth asking the user
// about; control traffic from someone we never accepted has nothing to belong
// to and is DROPPED, never applied. Applying a `delete` or an `edit` from a
// stranger would be worse than holding it, and holding it is the bug.
//
// The pinned-key check: in a v=1 seal the Ed25519 signature covers ek||env
// only, and `from`/`from_host` sit beside it unsigned. So "(uin, host) is an
// accepted contact" is a claim anyone can make by writing two fields. What the
// seal DOES prove is which signing key sealed it (`spub`, verified in
// decryptV1). A sender is treated as the pinned contact only when that proven
// key is the key pinned for them. A mismatch is a stranger, and it is shown as
// one: never merged into the contact's thread without a word.

/// Envelope kinds that carry something a person wrote or sent. The same set
/// the same-island stranger quarantine holds (stranger-requests.ts), so the
/// two gates cannot drift apart. `poll` is in it because a ballot is content
/// even though this client no longer composes one: it renders as a notice, and
/// a stranger's notice belongs in the requests list like their text does.
export const CONTENT_KINDS: ReadonlySet<string> = new Set([
  'text',
  'photo',
  'video',
  'file',
  'voice',
  'location',
  'poll',
])

export function isContentKind(kind: unknown): boolean {
  return typeof kind === 'string' && CONTENT_KINDS.has(kind)
}

/// Base64 (standard or url-safe, padded or not) to bytes, or null when it is
/// not base64 at all. Compared as BYTES below because the two strings come from
/// different writers: the pinned key from an island's key card, the sealed one
/// from whichever client sealed it, and an encoder that pads differently must
/// not turn the real contact into a stranger.
function decodeB64(s: string): Uint8Array | null {
  const clean = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  if (!clean || /[^A-Za-z0-9+/=]/.test(clean)) return null
  const padded = clean.replace(/=+$/, '')
  if (padded.length % 4 === 1) return null
  try {
    const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/// True only when both keys are present, decode, and are the same bytes.
/// Anything missing or malformed is "not the same key": the failure mode of
/// this check has to be "stranger", never "contact".
export function sameSigningKey(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const x = decodeB64(a)
  const y = decodeB64(b)
  if (!x || !y || x.length === 0 || x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}

/// Is this `carbon` really from another of OUR devices?
///
/// A carbon is applied with our own authority: it files outgoing rows, edits
/// and deletes our messages, and its `ciack` pins a cross-island contact's
/// keys, blocks an address or clears a request. Matching `from` to our number
/// is not enough, because in a v=1 seal `from` and `from_host` are unsigned:
/// anyone who fetched our open key card could seal `{from: us, carbon: ciack}`
/// and pin THEIR key for a contact of ours, which walks straight past the
/// pinned-key check below. So:
///
///  * a carbon from another island is not ours (every carbon is sealed under
///    the home identity and stamped with the home island);
///  * a carbon that names a verified signing key is ours only when that key is
///    OUR signing key. v=2 names none (libsignal authenticated it) and keeps
///    its old behaviour;
///  * a carbon never rides a group row. Carbons are deposited 1:1 to our own
///    number; one decoded out of a broadcast was re-attributed by a sender-key
///    chain whose binding to our number proves nothing about who posted it.
export function carbonIsOwn(
  senderUin: number,
  myUin: number,
  senderHost: string | null | undefined,
  ownHost: string,
  senderSigningKey: string | null | undefined,
  ownSigningKey: string | null | undefined,
  groupRow: boolean,
): boolean {
  if (senderUin !== myUin) return false
  if (groupRow) return false
  if (typeof senderHost === 'string' && senderHost !== '' && senderHost !== ownHost) return false
  if (senderSigningKey != null) return sameSigningKey(senderSigningKey, ownSigningKey)
  return true
}

/// Inner kinds that are never applied out of a broadcast from a room on
/// ANOTHER island.
///
/// Exactly the kinds route() resolves before it reaches the group store, and
/// every one of them is resolved in the HOME namespace: a profile key filed
/// against the home-island user with those digits, a profile-key ask answered
/// by looking that number up on the home island, a room key or re-send request
/// looked up among home rooms, a missed call from a home user, a carbon applied
/// as our own. A member on the other island does not become a home user by
/// sharing a number with one, and a foreign member is never looked up on our
/// own island. Their group content and group control still reach the room.
export const FOREIGN_ROOM_DROP: ReadonlySet<string> = new Set([
  'carbon',
  'pkey',
  'pkeyask',
  'gskey',
  'gsknack',
  'skdm',
  'sknack',
  'homerec',
  'call',
  'contactreq',
  'profile',
])

/// True when a decoded broadcast from a room on another island must be dropped.
/// An envelope with no kind at all is malformed and dropped too.
export function foreignRoomBroadcastDropped(kind: unknown): boolean {
  return typeof kind !== 'string' || FOREIGN_ROOM_DROP.has(kind)
}

export type GateAction = 'deliver' | 'hold' | 'drop'

export interface GateVerdict {
  action: GateAction
  /// We DO hold a contact at this (uin, host), and the envelope was sealed by
  /// a different key. Set on hold and on drop alike, so the caller can say so
  /// rather than treating it as an ordinary stranger in silence.
  keyMismatch: boolean
}

/// The cross-island consent gate for one envelope that reached the 1:1 path.
///
/// `pinnedSigningKey` is the key pinned for this (uin, host) in the
/// cross-island contact store, or null when there is no such contact.
/// `senderSigningKey` is the key the seal verified under.
///
///  * pinned and the keys match  -> deliver (the normal 1:1 ingest)
///  * otherwise, content         -> hold as a message request
///  * otherwise, anything else   -> drop: not held, not applied
export function crossIslandGateVerdict(
  kind: unknown,
  pinnedSigningKey: string | null | undefined,
  senderSigningKey: string | null | undefined,
): GateVerdict {
  const pinned = typeof pinnedSigningKey === 'string' && pinnedSigningKey.length > 0
  const matches = pinned && sameSigningKey(pinnedSigningKey, senderSigningKey)
  if (matches) return { action: 'deliver', keyMismatch: false }
  return { action: isContentKind(kind) ? 'hold' : 'drop', keyMismatch: pinned }
}

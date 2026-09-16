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
///  * a carbon that NAMES a signing key (a v=1 seal) is ours only when that key
///    is OUR signing key, whatever inner kind it carries. An empty or
///    malformed key is a key that is not ours, not "no key";
///  * a `ciack` carbon is ours only under our own signing key, never without
///    one. It is the carbon that pins a cross-island contact's keys, which is
///    the whole forgery this rule exists to stop (spec 2026-09-15, P0.1);
///  * TRANSITIONAL: a carbon that names NO key is accepted for every other
///    inner kind. On a 1:1 row that is a v=2 row (decryptV1 always yields the
///    `spub` it verified; decryptIncoming's v=2 branch yields none), and
///    Android seals carbons v=2 by default, over its session with our other
///    installs. Refusing them all stopped every message sent, edited, deleted
///    or read on Android from syncing to web and desktop of the same account.
///    The same allowance iOS ships (MessageService.swift, the carbon branch).
///    It is an allowance, not proof: nothing in v=2 authenticates the sender.
///    `from` and `dev` sit in the outer wrap unsigned, crypto-v2 decrypt()
///    uses them as the libsignal address, and the in-memory identity store
///    trusts whatever identity key a first PreKey message for that address
///    brings, so anyone can open a fresh session "as" (our number, device 77)
///    and deposit a keyless carbon of text, an edit or a delete. That is the
///    residual risk we carry until the strict rule is back; what it can no
///    longer do is pin keys. A keyless carbon with no readable inner kind is
///    refused: Android's always carries one, and there is nothing to allow.
///    ⚠ TODO(strict carbons): once Android 0.194 (which seals carbons v=1
///    under the account key) has spread, drop this allowance so a carbon is
///    ours only under our own key for EVERY kind: carbonIsOwn then reduces to
///    the sameSigningKey line below, and cli/test/carbon-gate.mjs flips its
///    keyless cases to refused. Flip it together with the same allowance on
///    Android (net/CrossIslandGate.kt) and iOS (MessageService.swift, the
///    carbon branch): while any one client still takes keyless carbons, a
///    forged edit or delete still lands on that client;
///  * a carbon never rides a group row. Carbons are deposited 1:1 to our own
///    number; one decoded out of a broadcast was re-attributed by a sender-key
///    chain whose binding to our number proves nothing about who posted it.
///    This is also what keeps the keyless allowance to v=2 1:1 rows: the
///    other routes that name no key are group broadcasts.
export function carbonIsOwn(
  senderUin: number,
  myUin: number,
  senderHost: string | null | undefined,
  ownHost: string,
  senderSigningKey: string | null | undefined,
  ownSigningKey: string | null | undefined,
  groupRow: boolean,
  innerKind: unknown,
): boolean {
  if (senderUin !== myUin) return false
  if (groupRow) return false
  // Compared canonically, not byte for byte. The two sides have different
  // writers: ownHost is `new URL(apiBase).host` here, `from_host` is whatever
  // the sealing client stamped (Android: store.serverHost, as the account was
  // added). Since Android 0.194 seals carbons v=1, it stamps a host where its
  // v=2 carbons stamped none, and a case difference, an explicit :443 or a
  // trailing dot must not refuse every carbon from the account's phone. This
  // costs nothing in forgery terms: `from_host` is outside the v=1 signature,
  // so the key checks below carry the proof, not this line.
  if (typeof senderHost === 'string' && senderHost !== '' && canonicalHost(senderHost) !== canonicalHost(ownHost)) {
    return false
  }
  // A key was named (v=1): only ours will do, every inner kind. sameSigningKey
  // is false for an empty or malformed key and for a tab with no identity.
  if (senderSigningKey != null) return sameSigningKey(senderSigningKey, ownSigningKey)
  // No key named (v=2), the transitional allowance above.
  if (typeof innerKind !== 'string' || innerKind === '') return false
  return !CARBON_KINDS_OWN_KEY_ONLY.has(innerKind)
}

/// An island host in one spelling, for comparing two writers' stamps: lower
/// case, no default HTTPS port, no trailing dot (the DNS root label).
/// `API.RCQ.APP`, `api.rcq.app:443` and `api.rcq.app.` are all `api.rcq.app`.
/// A non-default port stays: `x.example:8443` is a different island address.
function canonicalHost(host: string): string {
  let h = host.trim().toLowerCase()
  if (h.endsWith(':443')) h = h.slice(0, -4)
  return h.replace(/\.+$/, '')
}

/// Inner carbon kinds taken ONLY under our own signing key, never over a v=2
/// session. `ciack` pins a cross-island contact's keys (crossisland-ack.ts).
/// Once the strict rule is on (see carbonIsOwn) this set has no job left.
export const CARBON_KINDS_OWN_KEY_ONLY: ReadonlySet<string> = new Set(['ciack'])

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

/// Inner kinds that are 1:1 by nature and never acted on out of ANY group frame
/// (spec 2026-09-15, section 7), a room on our own island included.
///
/// Why a client rule: `POST /messages/group-sealed` accepts a payload for any
/// subset of a room's members and does not check who sent it, so a member can
/// deposit something for exactly one other member and the island cannot tell
/// it from a group post. A guest copy has no contact edges, calls or requests
/// on its island by design, and that design would mean nothing if a room frame
/// could carry a contact request, a call, a profile push or a carbon into the
/// 1:1 handlers. Content in a group frame still renders, in that group's
/// thread and nowhere else.
///
/// `pkey` and `homerec` are 1:1 as well (every client seals them through
/// `/messages/sealed`), and both file state under the sender's bare number in
/// the HOME namespace: a profile key, and the island list our 1:1 sends to that
/// number follow. A per-member row from a room on another island reaches
/// route() under that island's numbering, so without these two a co-member
/// wearing a home contact's digits could replace that contact's face or
/// repoint where our messages to them go.
///
/// The rest of the list is the same one on every client (D4, 16.09):
///   * `readmark` is a carbon's inner kind (our own read on another device),
///     and a carbon never rides a room;
///   * `gskey` / `gsknack` are the room STATE key and its ask-back. Every
///     client seals them 1:1 under the outer type `skdm` / `sknack`
///     (group-state.ts `sendKeyTo` -> `Api.sendSealed`, Android GroupState.kt,
///     iOS CryptoService), so a queue row or a live frame carrying them never
///     has a `group_id`, and nothing legitimate is lost by refusing them inside
///     a room. Sender-key traffic (`skdm`, `sknack`) is NOT here: the group
///     log path carries it and route() needs it.
///   * `secscreen` and `shot` are the per-chat secure-screen toggle and the
///     "took a screenshot" notice, both about a 1:1 thread. ⚠ These are the
///     WIRE names, not the prose ones: Android encodes them as `secscreen` and
///     `shot` (crypto/Envelope.kt) and so does iOS (CryptoService.swift), and
///     this list once held `screenshot` and `secure-screen`, which no client
///     has ever put on the wire, so the notice it meant to drop went through.
///     Every name here is in `WIRE_KINDS` (crypto.ts), and the offline test
///     holds the list to it;
///   * every call kind: `call` and anything spelled `call_*`.
export const GROUP_FRAME_DROP: ReadonlySet<string> = new Set([
  'contactreq',
  'ciack',
  'pkeyask',
  'pkey',
  'profile',
  'visit',
  'call',
  'carbon',
  'readmark',
  'homerec',
  'gskey',
  'gsknack',
  'secscreen',
  'shot',
])

/// True when a row that came in as a group frame (it carries a `group_id`) must
/// be dropped before route() looks at it. A missing kind is left to the
/// existing handling, so an unchanged room sees no difference.
export function groupFrameDropped(kind: unknown): boolean {
  if (typeof kind !== 'string') return false
  return GROUP_FRAME_DROP.has(kind) || kind.startsWith('call_')
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

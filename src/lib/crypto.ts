// Wire-compatible ECIES sealed-sender envelope (v=1) for the web
// client. Mirrors the iOS Stage-1 implementation in
// `iOS/RCQ/RCQ/Services/CryptoService.swift` byte-for-byte:
//
//   1. Per-message ephemeral X25519 keypair.
//   2. ECDH(ephemeral_priv, recipient_identity_pub) → 32-byte shared.
//   3. HKDF-SHA256(shared, salt = ephemeral_pub || recipient_pub,
//                  info = "RCQ-1to1-v1") → 32-byte AEAD key.
//   4. Inner JSON: { from, spub, sig, env } — Ed25519 sig over
//      (ephemeral_pub || envelope_json_bytes); env is base64 of
//      the original envelope bytes (NOT re-serialized — sig is over
//      whatever bytes we shipped).
//   5. ChaCha20-Poly1305 seal: aad = ephemeral_pub, nonce = random
//      12 bytes. CryptoKit's "combined" wire is
//      nonce(12) || ciphertext || tag(16); we mirror that.
//   6. Outer JSON: { v: 1, ek: <ephemeral_pub_b64>, ct: <combined_b64> }
//      then base64-encode the whole thing again — that's what
//      `POST /messages/sealed` accepts in `envelope_b64`.
//
// We deliberately use the same audited noble libs the rest of the
// JS ecosystem standardised on (X25519, Ed25519, ChaCha20-Poly1305,
// HKDF-SHA256, SHA256). No custom crypto, no rolling our own.

import { x25519, ed25519 } from '@noble/curves/ed25519'
import { chacha20poly1305 } from '@noble/ciphers/chacha'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { randomBytes } from '@noble/ciphers/webcrypto'

const HKDF_INFO_V1 = new TextEncoder().encode('RCQ-1to1-v1')
const WIRE_VERSION_V1 = 1

// -----------------------------------------------------------
// base64 / hex helpers (no Buffer dependency — runs in browsers)
// -----------------------------------------------------------

export function bytesToB64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return btoa(s)
}

export function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, a) => acc + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrays) {
    out.set(a, off)
    off += a.length
  }
  return out
}

// -----------------------------------------------------------
// Envelope content shapes
// -----------------------------------------------------------

export interface ReplyContext {
  id: string // uppercase UUID
  snippet: string
  authorName: string
}

/// Mirrors iOS `Envelope` enum. Phase-1 web ships two variants — a
/// plain text message and a reaction. text/reply/forward all ride
/// `TextEnvelope` (the reply/forward fields are part of the same
/// shape on iOS). photo/video/system/etc. stay an iOS-only shape
/// for now and would be additive on the wire.
export interface TextEnvelope {
  kind: 'text'
  id: string // uppercase UUID, matches iOS JSONEncoder
  text: string
  /// Disappearing-message TTL in whole SECONDS (iOS/Android key "ttl"); absent
  /// means permanent. See `disappearing.ts` for what honouring it means here.
  ttl?: number
  /// Sender's epoch SECONDS, sent only alongside `ttl`. It is what the
  /// countdown is anchored to, so a message drained out of the queue a week
  /// late is already gone rather than granted a fresh lifetime (the Android
  /// bug). Same field name and units as the `call` / `contactreq` / `profile`
  /// envelopes. Additive: a decoder that does not know it ignores it, and a
  /// sender that does not send one falls back to receipt time.
  ts?: number
  fwdName?: string
  reply?: ReplyContext
}

/// Reaction envelope. Sent from either side of a chat to set or clear
/// the sender's reaction on a specific message. `asset` is one of the
/// KOLOBOK names served at `/emoticons/<name>.gif` — same six the iOS
/// `MessageActionSheet` uses (smile, biggrin, shok, cray, good, heart).
/// `null` clears the reaction. `targetID` is the UUID of the message
/// being reacted to.
export interface ReactionEnvelope {
  kind: 'reaction'
  targetID: string
  asset: string | null
}

/// Photo (and GIF — iOS ships animated GIFs as a photo envelope whose
/// decrypted blob is GIF bytes, magic-byte detected on render). Mirrors
/// iOS `Envelope.photo`: the bytes live as an AES-256-GCM blob at
/// `/media/{mediaID}`, decrypted with `mediaKey` (base64 of the raw
/// 32-byte key). `caption` optional. We send a minimal shape (no
/// ttl/album); iOS decodes the optional fields with decodeIfPresent.
export interface PhotoEnvelope {
  kind: 'photo'
  id: string // uppercase UUID
  mediaID: string
  mediaKey: string // base64 AES-256 key
  caption?: string
  /// Disappearing-message TTL in seconds + the sender's epoch seconds to count
  /// from. See TextEnvelope.
  ttl?: number
  ts?: number
  fwdName?: string
  reply?: ReplyContext
}

/// Video. Mirrors iOS `Envelope.video`: the bytes live as an AES-256-GCM blob
/// at `/media/{mediaID}` (decrypted with `mediaKey`), plus a base64 JPEG
/// `thumbnailB64` poster + `durationSec`. Wire keys match the iOS CodingKeys
/// (thumbnailB64 / durationSec). The web can't COMPOSE a video (no thumbnail/
/// duration extraction), but it renders + plays inbound ones (#15).
export interface VideoEnvelope {
  kind: 'video'
  id: string // uppercase UUID
  mediaID: string
  mediaKey: string // base64 AES-256 key
  thumbnailB64: string // base64 JPEG poster frame
  durationSec: number
  caption?: string
  /// Disappearing-message TTL in seconds + the sender's epoch seconds to count
  /// from. See TextEnvelope.
  ttl?: number
  ts?: number
  fwdName?: string
  reply?: ReplyContext
}

/// A geographic point. No blob — the coordinates ride in the envelope itself.
/// Wire keys match the phones exactly (`lat` / `lng` / `caption`), so a point
/// sent from the web opens on Android and iOS as a location and not as text.
export interface LocationEnvelope {
  kind: 'location'
  id: string // uppercase UUID
  lat: number
  lng: number
  caption?: string
  /// Disappearing-message TTL in seconds + the sender's epoch seconds to count
  /// from. See TextEnvelope.
  ttl?: number
  ts?: number
  reply?: ReplyContext
}

/// File / document. Mirrors iOS `Envelope.file`: the raw bytes are an
/// AES-256-GCM blob at `/media/{mediaID}`, decrypted with `mediaKey`; the
/// terse wire keys `fname`/`mime`/`size` carry the display name, content type,
/// and plaintext byte length (iOS CodingKeys fileName="fname", sizeBytes="size").
export interface VoiceEnvelope {
  kind: 'voice'
  id: string
  /// The phones' wire casing — mediaID, not mediaId (matches Photo/Video/File).
  mediaID: string
  mediaKey: string
  /// Clip length in seconds; drives the bubble timer before the blob loads.
  durationSec: number
  ttl?: number
  ts?: number
}

export interface FileEnvelope {
  kind: 'file'
  id: string // uppercase UUID
  mediaID: string
  mediaKey: string // base64 AES-256 key
  fname: string // original file name
  mime: string // content type
  size: number // plaintext byte length
  caption?: string
  /// Disappearing-message TTL in seconds + the sender's epoch seconds to count
  /// from. See TextEnvelope.
  ttl?: number
  ts?: number
  fwdName?: string
  reply?: ReplyContext
}

/// Carbon (multi-device send-side sync). When the user sends a message
/// from one device, that device also seals a `carbon` to the user's OWN
/// identity (to_uin = me) wrapping the original envelope plus its
/// destination. The user's other logged-in devices unwrap it and file
/// the inner message as `fromMe` in the destination thread. Exactly one
/// of `to` (1:1 peer UIN) / `gid` (group id) is set. Defined identically
/// on iOS/Android/web. The origin device re-receives its own carbon and
/// must no-op it (dedup by the inner envelope's id).
export interface CarbonEnvelope {
  kind: 'carbon'
  to?: number | null // 1:1 destination peer UIN (omit/null for a group carbon)
  gid?: number | null // group destination id (omit/null for a 1:1 carbon)
  env: Envelope // the original sent envelope (text/photo/…)
}

/// Cross-device READ marker (megalist A2). Rides INSIDE a self-carbon, so
/// the island sees exactly the sealed self-addressed blob it already sees
/// for every message mirror, edit and delete: no new envelope_type, no new
/// legible token, nothing it did not know before. The founder's condition
/// for this feature was precisely that.
///
/// `at` is the wall clock of the read, in ms. The receiving device clears
/// the thread's unread down to whatever arrived AFTER that moment, so a
/// marker that crosses paths with a fresh message cannot mark it read.
/// Monotonic by construction: an older marker never un-reads a thread.
export interface ReadMarkEnvelope {
  kind: 'readmark'
  at: number
}

/// Group poll announcement (iOS/Android kind "poll"). Terse wire keys to
/// match the mobile clients: `poll` = server poll id, `q` = question,
/// `opts` = option labels, `sc` = single-choice, `anon` = anonymous.
///
/// ⚠⚠ RECEIVE-ONLY since 2026-08-23. Polls were cut from this client (founder
/// item 14a): the ballots are not end-to-end encrypted (the island stores
/// `voter_uin` and `option_index` in the clear, for "anonymous" polls as much
/// as for open ones), and `polls.creator_uin` sits next to the envelope UUID,
/// which names the author of that one message. Nothing here composes or ships
/// one any more, and `envelopeToObject` deliberately has no branch for it.
///
/// The SHAPE stays because an old peer on an old build can still send one, and
/// a removed feature must still ANSWER: `incoming-store` turns it into the
/// "no longer supported" placeholder rather than dropping it on the floor,
/// where the reader would see a silent gap in the conversation.
export interface PollEnvelope {
  kind: 'poll'
  id: string // uppercase UUID (the message id)
  poll: number // server-side poll id (for /polls/{id} + /vote)
  q: string
  opts: string[]
  sc: boolean
  anon: boolean
}

/// Edit (iOS/Android kind "edit"): the author replaces the body of message
/// `targetID` with `text`. Recipients update that message in place.
export interface EditEnvelope {
  kind: 'edit'
  targetID: string
  text: string
}

/// Delete-for-everyone (iOS/Android kind "delete"): the author retracts the
/// message `targetID` for all recipients. Honored only for the author's own
/// message (1:1) or a group moderator; recipients re-check on receipt.
export interface DeleteEnvelope {
  kind: 'delete'
  targetID: string
}

/// Receipt (iOS/Android kinds "read" and "delivered"): the recipient reports
/// that `targetIDs` were seen / landed on their device, which is what moves
/// the sender's ticks.
///
/// ⚠ This is a WIRE type, not a local one: without it in the union the
/// receipt built by `sendDeliveredReceipt` had to be cast, `envelopeToObject`
/// had no branch for it, and every receipt this client sent went out as a
/// bare `{"kind":"delivered"}`. iOS then failed to decode it (`targetIDs`
/// missing), which means it also never ACKed the queue row — so each broken
/// receipt was redelivered to the phone on every drain, forever.
export interface ReceiptEnvelope {
  kind: 'read' | 'delivered'
  targetIDs: string[]
}

/// Home-island record self-push (federation gossip B1, kind "homerec"): the
/// sender hands a contact their own signed home-island record so the contact
/// caches where to reach them even if the sender's island later dies. `rec` is
/// the signed HomeIslandRecord (verified against the SENDER's pinned signing
/// key on receipt; never rendered as a message). Cross-client identical.
export interface HomeRecordEnvelope {
  kind: 'homerec'
  rec: unknown
}

/// Sender-key distribution (kind "skdm"): hands one group member the chain
/// key for a (kid, epoch) so they can derive message keys for the
/// encrypt-once `gmsg` broadcasts. Rides the per-member ECIES seal via
/// /messages/group-sealed (envelope_type "skdm"); never rendered. The
/// receiver binds the kid to the decrypt's authenticated sender. See
/// RCQ/docs/sender-keys-design.md.
export interface SkdmEnvelope {
  kind: 'skdm'
  gid: number
  kid: string
  e: number
  i: number
  ck: string // b64 32B chain key at index i
}

/// Sender-key recovery request (kind "sknack"): I got a `gmsg` for a kid I
/// don't hold; the kid's owner re-seals a fresh SKDM. Per-member sealed,
/// never rendered.
export interface SknackEnvelope {
  kind: 'sknack'
  gid: number
  kid: string
}

/// Cross-island call signalling (kind "call", spec §5d). A same-island call is
/// a PLAINTEXT websocket relay — `{type:"call_offer", to_uin, call_id, sdp…}`
/// forwarded by the island between two live sockets. Across an island boundary
/// there is no shared socket, so the very same signal is wrapped here, v=1
/// sealed to the peer's identity key, and deposited to their island.
///
/// `sig` is the websocket event type verbatim (call_offer / call_answer /
/// call_ice / call_end / call_renegotiate* / call_ice_restart*), `cid` is the
/// call id, `ts` is sender epoch SECONDS (a `call_offer` older than 60s is
/// stale — an offline drain delivers hours-old rows), and `data` carries the
/// signal's remaining fields.
///
/// ⚠ Every value in `data` is a STRING on the wire. Android types it
/// `Map<String, String>` and iOS `[String: String]`, so a numeric or boolean
/// value here decodes as a hard error on both phones and the signal is lost in
/// silence — which for a call means it rings and never connects.
export interface CallEnvelope {
  kind: 'call'
  id: string // uppercase UUID
  sig: string // the WS event type, verbatim
  cid: string // the call id
  ts: number // sender epoch SECONDS (matches `contactreq` / `profile`)
  data: Record<string, string>
}

/// Cross-island contact request (kind "contactreq", spec §5f). Adding someone
/// on another island used to be a purely local act: fetch their open key card,
/// write a local row, done — nothing was deposited and the peer was never told.
/// This envelope IS the missing half. `act` is the direction: "request" asks,
/// "accept" grants (and is deposited back by the accepter, so both sides end up
/// holding the other — the mutual state §5d calls gate on), "decline" refuses.
/// `nickname` is the sender's own display name, so the request renders before
/// any card fetch. `note` is an optional short greeting.
///
/// ⚠ Purely consent metadata: a `contactreq` never enters the message store and
/// never writes the pinned identity/signing keys of a contact. Those keys come
/// from the peer's open card at add-time and are the anti-impersonation anchor;
/// a self-asserted envelope must not be able to move them.
export interface ContactReqEnvelope {
  kind: 'contactreq'
  id: string // uppercase UUID
  ts: number // sender epoch SECONDS (matches the `call` envelope's `ts`)
  act: 'request' | 'accept' | 'decline'
  nickname: string
  note?: string | null
}

/// Cross-island profile refresh (kind "profile", spec §5e). A cross-island
/// contact's name and picture were read exactly ONCE — from their open key card
/// at add-time — and nothing ever refreshed them, because the island's
/// `contacts` table has a pair of local uins and no host column, so a holder on
/// another island is not in the `contact_renamed` audience and cannot be. This
/// envelope is the refresh, pushed by the person who changed their profile.
///
/// ⚠ Wire keys are SNAKE_CASE (`avatar_media_id` / `avatar_media_key`), unlike
/// the `photo` envelope's `mediaID`/`mediaKey`. The field names here are the
/// wire names on purpose: the receive path is `JSON.parse(...) as Envelope`, so
/// a camelCase field name in TypeScript would type-check against an object that
/// never carries that key — the exact shape of the bug that made web rooms send
/// `to` while the island read `to_uin` and every offer was dropped in silence.
///
/// ⚠ A SNAPSHOT, not a patch: it always states the sender's whole current
/// display state, so an absent picture means "I have no picture" (i.e. clear
/// the one you hold), not "unchanged". Optionals are OMITTED rather than sent
/// as null, matching `contactreq`'s `note`; decoders tolerate both.
///
/// ⚠ Purely cosmetic: a `profile` never writes a contact's pinned
/// identity/signing keys. Those are the anti-impersonation anchor (§2.4), and a
/// self-asserted envelope that could move them would BE the impersonation path.
export interface ProfileEnvelope {
  kind: 'profile'
  id: string // uppercase UUID
  ts: number // sender epoch SECONDS (matches the `call` / `contactreq` `ts`)
  nickname: string
  avatar_media_id?: string | null
  avatar_media_key?: string | null // base64 AES-256 key for the deposited blob
}

export type Envelope =
  | TextEnvelope
  | ReactionEnvelope
  | PhotoEnvelope
  | VideoEnvelope
  | FileEnvelope
  | VoiceEnvelope
  | LocationEnvelope
  | CarbonEnvelope
  | PollEnvelope
  | EditEnvelope
  | DeleteEnvelope
  | ReceiptEnvelope
  | ReadMarkEnvelope
  | HomeRecordEnvelope
  | SkdmEnvelope
  | SknackEnvelope
  | CallEnvelope
  | ContactReqEnvelope
  | ProfileEnvelope

/// Identity material a web session needs to send v=1 envelopes.
/// Bundled by the iOS app and shipped via the linking QR. Web reads
/// it once on link, persists in IndexedDB, never echoes the privs
/// back over the wire.
export interface WebIdentity {
  uin: number
  jwt: string
  apiBase: string // e.g. "https://api.rcq.app"
  identityPriv: Uint8Array  // X25519 private (32 bytes raw)
  identityPub: Uint8Array   // X25519 public  (32 bytes raw)
  signingPriv: Uint8Array   // Ed25519 seed   (32 bytes raw)
  signingPub: Uint8Array    // Ed25519 public (32 bytes raw)
  /// True on a GUEST identity clone targeting another island (cross-island
  /// groups, §5c). Gates the global 401 logout handler: an expired guest jwt
  /// must not log the user out of their primary session.
  guest?: boolean
}

/// Recipient material from `GET /users/{uin}/info`. Only the X25519
/// pub is load-bearing for v=1; signingKey rides for parity with the
/// iOS PeerBundle but isn't read on the sender side (the recipient
/// verifies the embedded sig with the spub *inside* the inner JSON,
/// not against this field).
export interface PeerBundle {
  uin: number
  identityKey: string // base64 X25519 pub
  signingKey: string  // base64 Ed25519 pub (unused on send)
}

// -----------------------------------------------------------
// JSON helpers
// -----------------------------------------------------------

/// Make a UUID that matches Foundation's JSONEncoder output:
/// uppercase canonical 8-4-4-4-12. iOS JSONDecoder is lenient on
/// case but we mirror the exact shape so signatures-over-bytes are
/// stable across runs / test vectors.
export function newUUIDv4(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  // RFC 4122 v4 + variant bits.
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  ).toUpperCase()
}

/// Encode an Envelope to bytes. iOS reads this via JSONDecoder which
/// is permissive about field order and whitespace, so any valid JSON
/// encoding works — only matters that the SAME bytes get embedded
/// in the inner `env` field AND signed-over (the iOS decryptor
/// verifies the sig against `ek || env_bytes` from the wire).
export function envelopeToObject(env: Envelope): Record<string, unknown> {
  // Build the object in the exact shape iOS `Envelope.encode(to:)`
  // produces. Key order doesn't strictly matter for decoding but
  // keeps signed-bytes deterministic across sender/test runs.
  const obj: Record<string, unknown> = { kind: env.kind }
  if (env.kind === 'text') {
    obj.id = env.id
    obj.text = env.text
    if (env.ttl != null) obj.ttl = env.ttl
    // Only beside a ttl. A bare timestamp on every message would be a new
    // metadata field inside the ciphertext that buys nothing, and the whole
    // point of `ts` is that the countdown has something to count from.
    if (env.ttl != null && env.ts != null) obj.ts = env.ts
    if (env.fwdName != null) obj.fwdName = env.fwdName
    if (env.reply != null) obj.reply = env.reply
  } else if (env.kind === 'reaction') {
    obj.targetID = env.targetID
    // iOS uses encodeIfPresent for `asset` — present means set the
    // reaction, absent means clear it. Omit the key entirely when
    // the caller passes null so the wire shape matches iOS exactly.
    if (env.asset != null) obj.asset = env.asset
  } else if (env.kind === 'photo') {
    obj.id = env.id
    obj.mediaID = env.mediaID
    obj.mediaKey = env.mediaKey
    if (env.caption != null) obj.caption = env.caption
    if (env.ttl != null) obj.ttl = env.ttl
    if (env.ttl != null && env.ts != null) obj.ts = env.ts
    if (env.fwdName != null) obj.fwdName = env.fwdName
    if (env.reply != null) obj.reply = env.reply
  } else if (env.kind === 'video') {
    obj.id = env.id
    obj.mediaID = env.mediaID
    obj.mediaKey = env.mediaKey
    obj.thumbnailB64 = env.thumbnailB64
    obj.durationSec = env.durationSec
    if (env.caption != null) obj.caption = env.caption
    if (env.ttl != null) obj.ttl = env.ttl
    if (env.ttl != null && env.ts != null) obj.ts = env.ts
    if (env.fwdName != null) obj.fwdName = env.fwdName
    if (env.reply != null) obj.reply = env.reply
  } else if (env.kind === 'file') {
    obj.id = env.id
    obj.mediaID = env.mediaID
    obj.mediaKey = env.mediaKey
    obj.fname = env.fname
    obj.mime = env.mime
    obj.size = env.size
    if (env.caption != null) obj.caption = env.caption
    if (env.ttl != null) obj.ttl = env.ttl
    if (env.ttl != null && env.ts != null) obj.ts = env.ts
    if (env.fwdName != null) obj.fwdName = env.fwdName
    if (env.reply != null) obj.reply = env.reply
  } else if (env.kind === 'location') {
    // ⚠⚠ This branch was simply MISSING, and the `else if` chain has no default:
    // a location built by `sendLocation` fell off the end of it and went on the
    // wire as the bare object `{"kind":"location"}`: no id, no coordinates, no
    // caption. Every point ever sent from the web or the desktop arrived on the
    // phones as an empty pin. Field order matches the phones (`Envelope.kt`
    // Location, iOS `case .location`): kind, id, lat, lng, caption.
    obj.id = env.id
    obj.lat = env.lat
    obj.lng = env.lng
    if (env.caption != null) obj.caption = env.caption
    if (env.ttl != null) obj.ttl = env.ttl
    if (env.ttl != null && env.ts != null) obj.ts = env.ts
    if (env.reply != null) obj.reply = env.reply
  } else if (env.kind === 'edit') {
    obj.targetID = env.targetID
    obj.text = env.text
  } else if (env.kind === 'delete') {
    obj.targetID = env.targetID
  } else if (env.kind === 'readmark') {
    // Cross-device read marker (A2). One field: when the read happened.
    // Which thread it belongs to is the carbon's own to/gid, so nothing is
    // repeated and nothing extra is written into the ciphertext.
    obj.at = env.at
  } else if (env.kind === 'read' || env.kind === 'delivered') {
    obj.targetIDs = env.targetIDs
  } else if (env.kind === 'homerec') {
    obj.rec = env.rec
  } else if (env.kind === 'skdm') {
    obj.gid = env.gid
    obj.kid = env.kid
    obj.e = env.e
    obj.i = env.i
    obj.ck = env.ck
  } else if (env.kind === 'sknack') {
    obj.gid = env.gid
    obj.kid = env.kid
  } else if (env.kind === 'call') {
    // §5d. Field order matches Android (`Envelope.kt`, the CallSignal branch)
    // and iOS (`CryptoService.swift`, `case .callSignal`) exactly: kind, id,
    // sig, cid, ts, data. `data` is always present — iOS decodes it with
    // decodeIfPresent and Android with a null-safe getter, but an omitted key
    // is a difference in the SIGNED bytes for no gain, and the map is never
    // empty in practice (even `call_end` carries a reason).
    obj.id = env.id
    obj.sig = env.sig
    obj.cid = env.cid
    obj.ts = env.ts
    obj.data = env.data
  } else if (env.kind === 'contactreq') {
    // §5f. Field order mirrors the spec block and the `call` envelope's shape
    // (kind, id, …, ts). `note` follows the encodeIfPresent rule every other
    // optional on this wire uses — OMITTED when absent, never `null` — so the
    // bytes match iOS/Android for the same request.
    obj.id = env.id
    obj.ts = env.ts
    obj.act = env.act
    obj.nickname = env.nickname
    if (env.note != null && env.note !== '') obj.note = env.note
  } else if (env.kind === 'profile') {
    // §5e. Same field order as the spec block and the same optional rule as
    // `note` above — OMITTED when absent, never `null` — so the bytes match
    // iOS/Android for the same profile. The avatar pair is all-or-nothing: an
    // id without its key names a blob nobody can open, and the key IS the
    // access decision (`GET /media/{id}` has no auth at all), so half a pair
    // is never worth putting on the wire.
    obj.id = env.id
    obj.ts = env.ts
    obj.nickname = env.nickname
    if (env.avatar_media_id && env.avatar_media_key) {
      obj.avatar_media_id = env.avatar_media_id
      obj.avatar_media_key = env.avatar_media_key
    }
  } else if (env.kind === 'carbon') {
    // Multi-device carbon: include only the destination that's set
    // (encodeIfPresent style, matches iOS/Android), nest the original
    // envelope as a sub-object so the other device decodes it directly.
    if (env.to != null) obj.to = env.to
    if (env.gid != null) obj.gid = env.gid
    obj.env = envelopeToObject(env.env)
  }
  return obj
}

export function encodeEnvelopeBytes(env: Envelope): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(envelopeToObject(env)))
}

// -----------------------------------------------------------
// Size-padding + message class (Stage 2 core-metadata plan).
//
// The one thing a sealed blob still leaks is its LENGTH: the outer wire is
// fixed-width apart from the inner sealed-sender JSON, so `envelope_b64` grows
// with the message. We hide that by padding the INNER plaintext (the bytes fed
// to the AEAD seal) up to a coarse size bucket before sealing, via a `_pad`
// filler field. The pad lives INSIDE the seal (a wire observer that parses the
// outer JSON sees only the padded `ct`), and it is transparent to every shipped
// decoder: the v=1 signature is over `ek || env_bytes` (not the inner JSON), and
// every receiver reads the inner by named keys and ignores an unknown `_pad`. So
// a new client can pad a message an old client still opens byte-for-byte.
// Padding is a SENDER-ONLY policy: receivers never look at buckets, so clients
// may pad differently (or not at all) with no interop risk.
// -----------------------------------------------------------

/// Size buckets (bytes) the inner plaintext is padded up to. Past the last fixed
/// rung the ladder continues in multiples of 65536. Coarse on purpose: the
/// observer learns only which rung a message fell on, and a text pads up to the
/// same rung whether it was composed on the web or a phone.
export const BUCKETS = [256, 1024, 4096, 16384, 65536] as const

/// The smallest bucket that holds `n` bytes.
export function bucketFor(n: number): number {
  for (const b of BUCKETS) if (n <= b) return b
  return Math.ceil(n / 65536) * 65536
}

/// The inner-JSON key the filler rides in. The filler is ASCII 'A', which JSON
/// never escapes, so the padded byte length is exact.
export const PAD_KEY = '_pad'
/// Byte cost of an EMPTY pad field: `,"_pad":""` is exactly 10 ASCII bytes.
const PAD_OVERHEAD = 10

/// Kinds whose on-wire size tracks what the user wrote or attached, and so are
/// worth padding. Receipts / reactions / signalling are omitted: they are tiny,
/// frequent, and their size carries no content, so buying them uniformity is not
/// worth the relay bytes. Padding is sender-only, so this set is a local policy
/// choice and never part of the interop contract.
const PAD_KINDS = new Set(['text', 'photo', 'video', 'file', 'location', 'edit', 'carbon'])
export function shouldPadKind(kind: string): boolean {
  return PAD_KINDS.has(kind)
}

/// Serialize `innerObj` and pad it up to its size bucket by appending a `_pad`
/// filler, returning the padded plaintext bytes to seal. `_pad` is added last,
/// so JSON.stringify writes it as a trailing `,"_pad":"AAAA..."` and the total
/// byte length lands exactly on the bucket.
export function padInnerBytes(innerObj: Record<string, unknown>): Uint8Array {
  const enc = new TextEncoder()
  const unpadded = enc.encode(JSON.stringify(innerObj)).length
  const target = bucketFor(unpadded + PAD_OVERHEAD)
  const k = target - unpadded - PAD_OVERHEAD
  return enc.encode(JSON.stringify({ ...innerObj, [PAD_KEY]: 'A'.repeat(k) }))
}

/// Mirror of the island's `_cls_for`: the retention / push class the server
/// derives from this `envelope_type`. Sent beside `envelope_type` so a new or
/// opaque type is classified by its sender rather than guessed by the island;
/// for every type shipped today it equals what the island derives, so push and
/// retention behaviour is unchanged. 0 = ephemeral, 1 = content, 2 = critical.
const CLS_EPHEMERAL = new Set(['typing', 'read', 'visit', 'presence', 'nudge', 'bounce'])
const CLS_CRITICAL = new Set(['skdm', 'sknack'])
export function messageClass(envelopeType: string): 0 | 1 | 2 {
  if (CLS_EPHEMERAL.has(envelopeType)) return 0
  if (CLS_CRITICAL.has(envelopeType)) return 2
  return 1
}

// -----------------------------------------------------------
// Encrypt (v=1)
// -----------------------------------------------------------

/// Build a wire-format-v=1 sealed envelope for a single recipient
/// and return it as the base64 blob `POST /messages/sealed` expects
/// in its `envelope_b64` field.
export function encryptV1(envelope: Envelope, sender: WebIdentity, recipient: PeerBundle): string {
  const recipientPub = b64ToBytes(recipient.identityKey)
  if (recipientPub.length !== 32) throw new Error('recipient identityKey is not 32 bytes')

  // 1. Per-message ephemeral keypair.
  const ephemeralPriv = x25519.utils.randomPrivateKey()
  const ephemeralPub = x25519.getPublicKey(ephemeralPriv)

  // 2. ECDH → 32-byte shared.
  const shared = x25519.getSharedSecret(ephemeralPriv, recipientPub)

  // 3. HKDF-SHA256(shared, salt = ek || rpub, info = "RCQ-1to1-v1").
  const salt = concat(ephemeralPub, recipientPub)
  const aeadKey = hkdf(sha256, shared, salt, HKDF_INFO_V1, 32)

  // 4. Inner JSON. The signature covers `ephemeral_pub ||
  //    envelope_bytes`; envelope is shipped as base64 of those
  //    same bytes (we don't re-serialize — sig stays valid).
  const envBytes = encodeEnvelopeBytes(envelope)
  const toSign = concat(ephemeralPub, envBytes)
  const signature = ed25519.sign(toSign, sender.signingPriv)
  // `from_host` lets the recipient tell a cross-island sender from a local one
  // and resolve their key card from the right island (Variant A consent +
  // correct labeling). Additive: old decoders ignore it. The authenticated
  // identity stays `spub` (the sig); the recipient anchors `from_host` by
  // fetching the sender's card there and checking `spub` matches.
  let fromHost = 'api.rcq.app'
  try {
    fromHost = new URL(sender.apiBase).host
  } catch {
    /* keep flagship default */
  }
  const innerObj = {
    from: sender.uin,
    from_host: fromHost,
    spub: bytesToB64(sender.signingPub),
    sig: bytesToB64(signature),
    env: bytesToB64(envBytes),
  }
  // Stage 2: pad the inner plaintext up to a size bucket for content kinds, so
  // the sealed blob's length no longer tracks the message. Transparent to every
  // decoder: the sig is over ek||env, not the inner, and receivers ignore the
  // extra `_pad` key (see the padding section above).
  const innerBytes = shouldPadKind(envelope.kind)
    ? padInnerBytes(innerObj)
    : new TextEncoder().encode(JSON.stringify(innerObj))

  // 5. ChaCha20-Poly1305 seal. CryptoKit's `combined` representation
  //    is nonce(12) || ciphertext || tag(16); the noble lib returns
  //    ciphertext || tag(16), so we prepend the nonce ourselves.
  const nonce = randomBytes(12)
  const cipher = chacha20poly1305(aeadKey, nonce, ephemeralPub) // aad = ek
  const ctWithTag = cipher.encrypt(innerBytes)
  const combined = concat(nonce, ctWithTag)

  // 6. Outer JSON → base64.
  const wireObj = {
    v: WIRE_VERSION_V1,
    ek: bytesToB64(ephemeralPub),
    ct: bytesToB64(combined),
  }
  const wireBytes = new TextEncoder().encode(JSON.stringify(wireObj))
  return bytesToB64(wireBytes)
}

// -----------------------------------------------------------
// Decrypt (v=1) — included for symmetry. Most inbound traffic in
// the current production state is v=2, which we can't decode without
// libsignal-WASM. v=1 still arrives for: (a) trade events (server
// sends a plain JSON `trade_received` event, no envelope), (b) any
// peer that hasn't uploaded a Stage-3 bundle, (c) future features
// that ride v=1 on purpose. So we keep the decoder ready.
// -----------------------------------------------------------

export interface DecryptedV1 {
  senderUIN: number
  /// The sender's island host, if they included it (cross-island routing +
  /// labeling). Absent from pre-`from_host` senders → treat as same-island.
  senderHost?: string
  /// Base64 Ed25519 key (`spub`) that signed this envelope — proven by the
  /// signature check below. Lets a `homerec` self-push bind the carried record
  /// to its real sender (rec.sk must equal this).
  senderSigningKey: string
  envelope: Envelope
}

export function decryptV1(envelopeB64: string, me: WebIdentity): DecryptedV1 {
  const wireBytes = b64ToBytes(envelopeB64)
  const wire = JSON.parse(new TextDecoder().decode(wireBytes))
  if (wire.v !== WIRE_VERSION_V1) throw new Error(`unsupported envelope version v=${wire.v}`)
  const ek = b64ToBytes(wire.ek)
  const combined = b64ToBytes(wire.ct)
  if (ek.length !== 32) throw new Error('malformed ek')
  if (combined.length < 12 + 16) throw new Error('malformed ct')

  const shared = x25519.getSharedSecret(me.identityPriv, ek)
  const salt = concat(ek, me.identityPub)
  const aeadKey = hkdf(sha256, shared, salt, HKDF_INFO_V1, 32)

  const nonce = combined.subarray(0, 12)
  const ctWithTag = combined.subarray(12)
  const cipher = chacha20poly1305(aeadKey, nonce, ek) // aad = ek
  const inner = cipher.decrypt(ctWithTag)
  const innerObj = JSON.parse(new TextDecoder().decode(inner))
  const from = innerObj.from as number
  const envBytes = b64ToBytes(innerObj.env)

  // Verify the sender's Ed25519 signature over (ek || envBytes).
  const spub = b64ToBytes(innerObj.spub)
  const sig = b64ToBytes(innerObj.sig)
  const toVerify = concat(ek, envBytes)
  const ok = ed25519.verify(sig, toVerify, spub)
  if (!ok) throw new Error('sender signature did not verify')

  const env = JSON.parse(new TextDecoder().decode(envBytes)) as Envelope
  const senderHost = typeof innerObj.from_host === 'string' ? (innerObj.from_host as string) : undefined
  return { senderUIN: from, senderHost, senderSigningKey: innerObj.spub as string, envelope: env }
}

// -----------------------------------------------------------
// Web-link seal — "connect to web" QR login. The web generates an ephemeral
// X25519 keypair (pub goes in the QR), the phone seals the account LinkBlob to
// it and POSTs the ciphertext to the one-time relay (/link/{token}), the web
// polls + opens it here. Same ECIES shape as encryptV1 (x25519 ECDH →
// HKDF-SHA256 → ChaCha20-Poly1305), but WITHOUT the inner envelope/signature:
// it carries a raw JSON blob, and confidentiality (only our ephemeral privkey
// can open it) is all that's needed. The phone authenticates itself by what's
// IN the blob (its real keys), not by a wrapper signature.
//
// Wire (base64 of JSON): { ek: <sender ephemeral pub>, ct: <nonce(12) || ct||tag> }
//   shared = ECDH(ephPriv, ek)
//   key    = HKDF-SHA256(shared, salt = ek || webEphPub, info = "RCQ-weblink-v1")
//   aead   = ChaCha20-Poly1305(key, nonce, aad = ek)
// Mobile clients MUST mirror this exactly when sealing.
// -----------------------------------------------------------

const HKDF_INFO_WEBLINK = new TextEncoder().encode('RCQ-weblink-v1')

/** The web's ephemeral X25519 keypair for one "connect to phone" session. The
 *  pub goes in the QR; the priv never leaves the browser. */
export function newLinkEphemeral(): { priv: Uint8Array; pub: Uint8Array } {
  const priv = x25519.utils.randomPrivateKey()
  const pub = x25519.getPublicKey(priv)
  return { priv, pub }
}

/** Open a sealed web-link blob the phone deposited for our ephemeral key.
 *  Returns the plaintext bytes (the LinkBlob JSON). [ephPub] is our own
 *  ephemeral pub (it's part of the HKDF salt, so it must match what the phone
 *  used). Throws on a malformed or wrong-key blob. */
export function openLinkSeal(sealedB64: string, ephPriv: Uint8Array, ephPub: Uint8Array): Uint8Array {
  const wire = JSON.parse(new TextDecoder().decode(b64ToBytes(sealedB64)))
  const ek = b64ToBytes(wire.ek) // the phone's ephemeral pub
  const combined = b64ToBytes(wire.ct)
  if (ek.length !== 32) throw new Error('malformed ek')
  if (combined.length < 12 + 16) throw new Error('malformed ct')
  const shared = x25519.getSharedSecret(ephPriv, ek)
  const salt = concat(ek, ephPub)
  const aeadKey = hkdf(sha256, shared, salt, HKDF_INFO_WEBLINK, 32)
  const nonce = combined.subarray(0, 12)
  const ctWithTag = combined.subarray(12)
  const cipher = chacha20poly1305(aeadKey, nonce, ek) // aad = ek
  return cipher.decrypt(ctWithTag)
}

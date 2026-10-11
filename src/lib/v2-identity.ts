// Who is behind a v=2 session? The pure half of the check signal-device.ts
// runs before it lets a v=2 row decrypt.
//
// A v=2 row names its sender in the OUTER wrap (`from`, `dev`), unsigned, and
// the libsignal stores this client builds keep peer identities in memory only
// and trust whatever identity a first PreKey message brings (TOFU, forgotten
// on every reload). So anyone with our bundle could open a fresh session "as"
// (any number, any device) and be taken for them: a contact, a member of a
// room, or one of our own devices with a carbon. Nothing on the wire changes
// to close that; what changes is that the identity key inside the message is
// read first and held against two things this device can stand on:
//
//  * the identity first seen here for that (number, device), persisted, so a
//    swap is never silent;
//  * the identity our island PUBLISHES for that (number, device) in
//    `GET /keys/{uin}/devices` (no prekey consumed), which is what vouches
//    for a first contact and for a legitimate reinstall.
//
// Both parsers walk protobuf by hand: the wasm build exposes neither a
// PreKeySignalMessage parser nor a session-record reader, and the two fields
// needed here sit at fixed field numbers in libsignal's own wire format.

import { sameSigningKey } from './crossisland-gate'
import type { V2Identity } from './sender-trust'

interface PbField {
  no: number
  wt: number
  bytes?: Uint8Array
}

/// The top-level fields of one protobuf message, or null when it does not
/// parse. Varints are read as plain numbers (only lengths matter here), and
/// groups (wire types 3/4, long deprecated) end the walk as malformed.
function pbFields(buf: Uint8Array): PbField[] | null {
  const out: PbField[] = []
  let p = 0
  const varint = (): number | null => {
    let v = 0
    let mul = 1
    for (let n = 0; n < 10; n++) {
      if (p >= buf.length) return null
      const b = buf[p++]
      v += (b & 0x7f) * mul
      if ((b & 0x80) === 0) return v
      mul *= 128
    }
    return null
  }
  while (p < buf.length) {
    const tag = varint()
    if (tag == null) return null
    const no = Math.floor(tag / 8)
    const wt = tag % 8
    if (no === 0) return null
    if (wt === 0) {
      if (varint() == null) return null
      out.push({ no, wt })
    } else if (wt === 1) {
      if (p + 8 > buf.length) return null
      p += 8
      out.push({ no, wt })
    } else if (wt === 2) {
      const len = varint()
      if (len == null || p + len > buf.length) return null
      out.push({ no, wt, bytes: buf.subarray(p, p + len) })
      p += len
    } else if (wt === 5) {
      if (p + 4 > buf.length) return null
      p += 4
      out.push({ no, wt })
    } else {
      return null
    }
  }
  return out
}

/// The sender's identity key inside a serialized PreKeySignalMessage (the
/// `msg` of a v=2 inner whose kind is "prekey"): one version byte, then the
/// protobuf, whose field 3 is `identity_key`. Null when it does not parse.
export function prekeyMessageIdentity(serialized: Uint8Array): Uint8Array | null {
  if (serialized.length < 2) return null
  const fields = pbFields(serialized.subarray(1))
  const ik = fields?.find((f) => f.no === 3 && f.wt === 2)?.bytes
  return ik && ik.length > 0 ? ik : null
}

/// The remote identity of every state in an exported session record
/// (RecordStructure: field 1 the current SessionStructure, field 2 each
/// previous one; inside, field 3 is `remote_identity_public`). A SignalMessage
/// opens on the current state or on one of the previous ones, and libsignal
/// promotes whichever opened it to current, so `current` read AFTER a decrypt
/// is the identity that sent the message.
export function sessionRemoteIdentities(record: Uint8Array): { current: Uint8Array | null; previous: Uint8Array[] } | null {
  const top = pbFields(record)
  if (!top) return null
  const remoteOf = (state: Uint8Array | undefined): Uint8Array | null => {
    if (!state) return null
    const ik = pbFields(state)?.find((f) => f.no === 3 && f.wt === 2)?.bytes
    return ik && ik.length > 0 ? ik : null
  }
  const current = remoteOf(top.find((f) => f.no === 1 && f.wt === 2)?.bytes)
  const previous = top
    .filter((f) => f.no === 2 && f.wt === 2)
    .map((f) => remoteOf(f.bytes))
    .filter((x): x is Uint8Array => x != null)
  return { current, previous }
}

/// What the island's device list says about one (number, device):
///  * a string: the identity it publishes for that device;
///  * undefined: the device is listed but the island names no identity (an
///    island older than the field), so it can vouch for nothing;
///  * null: the device is not on the list (revoked, unknown, or no account).
export type PublishedIdentity = string | null | undefined

export interface V2IdentityDecision {
  verdict: V2Identity
  /// Write `ik` down as the identity for this (number, device).
  remember: boolean
}

/// The rule, on its own.
///
///  * the identity first seen here: verified, nothing to write;
///  * otherwise the island's published identity decides: the same key is
///    verified (a first contact, or a reinstall the island has taken) and is
///    remembered from now on; another key is a mismatch;
///  * an island that names no identity cannot vouch: the first identity seen
///    is taken (what every build did before this one) and remembered, and any
///    later change is refused rather than taken in silence;
///  * a device the island does not list at all is vouched for by nobody.
export function v2IdentityDecision(memory: string | null, published: PublishedIdentity, ik: string): V2IdentityDecision {
  if (memory && sameSigningKey(memory, ik)) return { verdict: 'verified', remember: false }
  if (typeof published === 'string' && published) {
    return sameSigningKey(published, ik) ? { verdict: 'verified', remember: true } : { verdict: 'mismatch', remember: false }
  }
  if (published === undefined && !memory) return { verdict: 'verified', remember: true }
  return { verdict: 'mismatch', remember: false }
}

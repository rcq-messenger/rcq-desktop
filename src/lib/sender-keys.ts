// RCQ Sender Keys (custom v=1) — group encrypt-once.
//
// Canonical spec: RCQ/docs/sender-keys-design.md. This file must stay
// byte-for-byte compatible with the Android (SenderKeys.kt) and iOS
// (CryptoService sender-key methods) implementations — all three derive
// the same message keys and produce the same `gmsg`/`skdm` wire.
//
// Built ONLY on primitives already cross-platform in RCQ v=1: HMAC-SHA256
// (chain ratchet), ChaCha20-Poly1305 (message AEAD), and the existing
// encryptV1/decryptV1 ECIES seal (per-member chain distribution). No new
// crypto, no libsignal GroupCipher (its wire isn't verifiable across our
// three libsignal versions).

import { chacha20poly1305 } from '@noble/ciphers/chacha'
import { randomBytes } from '@noble/ciphers/webcrypto'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { ed25519 } from '@noble/curves/ed25519'
import { b64ToBytes, bytesToB64, encodeEnvelopeBytes, type Envelope, type WebIdentity } from './crypto'

// Out-of-order tolerance: derive at most this many message keys forward of
// a chain's current position before giving up (and NACKing).
export const MAX_SKIP = 512

// ---- ratchet ------------------------------------------------------------

/// mk_i = HMAC-SHA256(ck_i, 0x01); ck_{i+1} = HMAC-SHA256(ck_i, 0x02).
export function deriveMessageKey(chainKey: Uint8Array): Uint8Array {
  return hmac(sha256, chainKey, new Uint8Array([0x01]))
}
export function nextChainKey(chainKey: Uint8Array): Uint8Array {
  return hmac(sha256, chainKey, new Uint8Array([0x02]))
}

// ---- wire shapes --------------------------------------------------------

export interface GmsgWire {
  v: 1
  kid: string // b64 16B distribution id
  e: number // epoch
  i: number // message index
  n: string // b64 12B nonce
  ct: string // b64 ChaCha20-Poly1305 ciphertext||tag
}

/// SKDM inner-envelope kind (rides the per-member ECIES seal via
/// /messages/group-sealed, envelope_type "skdm").
export interface SkdmEnvelope {
  kind: 'skdm'
  gid: number
  kid: string
  e: number
  i: number // first index this member can decrypt
  ck: string // b64 32B chain key at index i
}

/// Recovery request for an unknown kid (rides the per-member seal,
/// envelope_type "sknack"). The kid owner re-seals a fresh SKDM back.
export interface SknackEnvelope {
  kind: 'sknack'
  gid: number
  kid: string
}

// ---- AEAD framing -------------------------------------------------------

function gmsgAAD(gid: number, kid: string, e: number, i: number): Uint8Array {
  return new TextEncoder().encode(`rcq.gmsg.v1|${gid}|${kid}|${e}|${i}`)
}

/// Encrypt one inner envelope under message key `mk` at (gid,kid,e,i). The
/// signature (Ed25519 over AAD||env-bytes) lives INSIDE the AEAD so group
/// members — who all hold the chain key after the SKDM — can still tell who
/// actually posted (the chain key alone doesn't authenticate a sender).
export function sealGmsg(
  envelope: Envelope,
  sender: WebIdentity,
  gid: number,
  kid: string,
  e: number,
  i: number,
  mk: Uint8Array,
): GmsgWire {
  const envBytes = encodeEnvelopeBytes(envelope)
  const aad = gmsgAAD(gid, kid, e, i)
  const toSign = new Uint8Array(aad.length + envBytes.length)
  toSign.set(aad, 0)
  toSign.set(envBytes, aad.length)
  const sig = ed25519.sign(toSign, sender.signingPriv)
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ env: bytesToB64(envBytes), sig: bytesToB64(sig) }),
  )
  const nonce = randomBytes(12)
  const ctWithTag = chacha20poly1305(mk, nonce, aad).encrypt(plaintext)
  return { v: 1, kid, e, i, n: bytesToB64(nonce), ct: bytesToB64(ctWithTag) }
}

export interface OpenedGmsg {
  envelope: Envelope
  /// True once the Ed25519 sig verified against `expectedSpub`.
  verified: boolean
}

/// Decrypt + verify a gmsg under `mk`, checking the sig against the signing
/// key the SKDM was bound to. Throws on AEAD failure (wrong key / tampering).
export function openGmsg(
  wire: GmsgWire,
  gid: number,
  mk: Uint8Array,
  expectedSpubB64: string,
): OpenedGmsg {
  const aad = gmsgAAD(gid, wire.kid, wire.e, wire.i)
  const nonce = b64ToBytes(wire.n)
  const plaintext = chacha20poly1305(mk, nonce, aad).decrypt(b64ToBytes(wire.ct))
  const inner = JSON.parse(new TextDecoder().decode(plaintext))
  const envBytes = b64ToBytes(inner.env)
  const toVerify = new Uint8Array(aad.length + envBytes.length)
  toVerify.set(aad, 0)
  toVerify.set(envBytes, aad.length)
  let verified = false
  try {
    verified = ed25519.verify(b64ToBytes(inner.sig), toVerify, b64ToBytes(expectedSpubB64))
  } catch {
    verified = false
  }
  const envelope = JSON.parse(new TextDecoder().decode(envBytes)) as Envelope
  return { envelope, verified }
}

// ---- random 16-byte distribution id -------------------------------------

export function newKid(): string {
  return bytesToB64(randomBytes(16))
}

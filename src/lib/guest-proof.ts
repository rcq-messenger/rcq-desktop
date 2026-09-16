// The signed bytes of an `rcq-guest-v1` proof (spec 2026-09-15, section 4.3).
//
// `POST /auth/guest` gives this identity a guest copy on a paid or invite
// island, together with its first room, without a voucher. The island can only
// check that we hold the signing key the copy will carry, so what that key
// signs pins down everything a relay, a front or a replaying stranger could
// otherwise change: the island (canonical host), the room (its id THERE), both
// public keys, and the island's own single-use challenge.
//
// Pure on purpose, like crossisland-gate.ts: no store, no network, no React.
// The server builds the same bytes in `app/services/guest_proof.py`, Android in
// crypto/GuestProof.kt, iOS in Services/GuestProof.swift, and
// `cli/test/fixtures/guest-proof-v1.json` (copied verbatim from rcq-server-ref)
// pins all of them to one vector, byte for byte.
//
// ⚠ THE SERVER NEVER SIGNS THE STRINGS IT WAS SENT. It decodes the keys and
// re-encodes them as standard padded base64, and canonicalises the host. So we
// sign the canonical spellings too, never a key string as some store happened
// to write it. Only the challenge goes in verbatim: it is the island's JWT and
// has to be signed exactly as handed over.

export const GUEST_PROOF_PREFIX = 'rcq-guest-v1'
export const GUEST_PROOF_VERSION = 1

/// `canonical_host` from rcq-server `services/reissue_proof.py`, line for line:
/// trimmed, lowercase, `:port` kept only when it is not 443, trailing dots
/// dropped, brackets around an IPv6 literal kept. `API.rcq.app:443`,
/// `api.rcq.app.` and `api.rcq.app` all name `api.rcq.app`.
export function canonicalGuestHost(value: string): string {
  let host = (value || '').trim().toLowerCase()
  let port = ''
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    if (end !== -1 && host.slice(end + 1, end + 2) === ':') {
      port = host.slice(end + 2)
      host = host.slice(0, end + 1)
    }
  } else if (host.split(':').length === 2) {
    const i = host.indexOf(':')
    port = host.slice(i + 1)
    host = host.slice(0, i)
  }
  host = host.replace(/\.+$/, '')
  return port && port !== '443' ? `${host}:${port}` : host
}

/// Standard padded base64 of raw bytes: the spelling the proof signs.
export function canonicalKeyB64(raw: Uint8Array): string {
  let s = ''
  for (let i = 0; i < raw.length; i++) s += String.fromCharCode(raw[i])
  return btoa(s)
}

/// A 32-byte key from any base64 spelling (standard or url-safe, padded or
/// not), or null. Mirrors the server's `decode_key32`, so a key our store kept
/// unpadded still signs as the island will rebuild it.
export function decodeKey32(value: string): Uint8Array | null {
  const clean = (value || '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  if (!clean || /[^A-Za-z0-9+/]/.test(clean) || clean.length % 4 === 1) return null
  try {
    const bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4))
    if (bin.length !== 32) return null
    const out = new Uint8Array(32)
    for (let i = 0; i < 32; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/// The exact bytes our signing key signs. UTF-8, six fields joined by a single
/// newline (0x0A), no trailing newline:
///
///     rcq-guest-v1
///     <host>          canonicalGuestHost
///     <group_id>      decimal, no sign, no leading zeros (the room id THERE)
///     <identity_key>  standard padded base64 of the 32 X25519 bytes
///     <signing_key>   standard padded base64 of the 32 Ed25519 bytes
///     <challenge>     verbatim, from POST /auth/guest/challenge
///
/// Throws on input that cannot be one line of the layout, as the server does:
/// a room id that is not a positive integer, a key that is not 32 bytes, or a
/// host or challenge carrying a line break (which would shift every field
/// after it, so two different requests could sign the same bytes).
export function guestProofBytes(
  host: string,
  groupId: number,
  identityKey: Uint8Array,
  signingKey: Uint8Array,
  challenge: string,
): Uint8Array {
  if (!Number.isSafeInteger(groupId) || groupId <= 0) throw new Error('group_id must be positive')
  if (identityKey.length !== 32 || signingKey.length !== 32) throw new Error('keys must be 32 bytes')
  const hostLine = canonicalGuestHost(host)
  if (!hostLine || /[\r\n]/.test(hostLine)) throw new Error('bad host')
  if (!challenge || /[\r\n]/.test(challenge)) throw new Error('bad challenge')
  const lines = [
    GUEST_PROOF_PREFIX,
    hostLine,
    String(groupId),
    canonicalKeyB64(identityKey),
    canonicalKeyB64(signingKey),
    challenge,
  ]
  return new TextEncoder().encode(lines.join('\n'))
}

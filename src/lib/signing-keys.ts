import { ed25519 } from '@noble/curves/ed25519'

/**
 * The Ed25519 keys this build accepts a signature from, by what the signature
 * authorises. Mirrors Android `SigningKeys.kt` and iOS `SigningKeys.swift`.
 *
 * ## Why a set, and why it is compiled in
 *
 * Every client used to pin exactly one key, written out in six places across
 * three codebases. That does not make rotation awkward, it makes it impossible:
 * a client that knows one key cannot be handed a payload signed by any other,
 * so the day the key has to change is the day every installed client stops
 * receiving relay updates and quietly runs on its bundled list until the fleet
 * moves out from under it.
 *
 * Accepting a set fixes the part that matters. Ship the successor, keep signing
 * with the incumbent, and switching becomes a signing-side decision with no
 * release and no flag day. Retiring the old key still needs a release, but
 * retiring is never the urgent direction.
 *
 * The set deliberately does NOT come from the signed payload. Letting a config
 * carry its own future keys would make even introducing a key releaseless, and
 * would also let an attacker holding the current key sign a payload adding one
 * of their own — after which rotating away from the stolen key evicts nobody,
 * because theirs is pinned in every client's cache. Rotation would be theatre.
 * Compiled in, a compromise lasts until we sign with the successor and not one
 * payload longer.
 *
 * ## Roles
 *
 * Relay config and the island list authorise different things: where traffic is
 * tunnelled, versus which island an account is silently given a backup mailbox
 * on. One key covers both today, so a leak costs both at once; each role also
 * carries its own successor, which is what lets them be pulled apart later
 * without a release.
 */
export type SigningRole = 'relay-config' | 'island-list'

/** In use since 2026-05. Signs both roles, which is the overlap the split
 *  exists to end. */
const INCUMBENT = 'TY834OFcBvtUqHcnVw/QrPBOaEAZo7a1GAmABMhjkT8='

/** Generated 2026-08-05, held offline, has never signed anything. */
const RELAY_SUCCESSOR = 'sr0g2D8rXZiEdU8cA6gaIWKxA34QIsysUJQsEeloL1o='

/** Generated 2026-08-05 for the island role alone, so the day the relay key is
 *  rotated or leaks, the island list does not have to move with it. */
const ISLAND_SUCCESSOR = 'YsA429yi8BeQKQVvi0HSykrK0SVsJlhNKhFwC+g7VWo='

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const ACCEPTED: Record<SigningRole, Uint8Array[]> = {
  'relay-config': [INCUMBENT, RELAY_SUCCESSOR].map(b64ToBytes),
  'island-list': [INCUMBENT, ISLAND_SUCCESSOR].map(b64ToBytes),
}

/**
 * True when `signature` is valid over `message` under ANY key this build
 * accepts for `role`.
 *
 * Every candidate is tried even after one succeeds, so which key signed a
 * payload is not observable from how long verification took. A malformed key or
 * signature counts as a failed verification, never a thrown error: the callers
 * are fetch paths that must fall back to what they already have rather than
 * blow up.
 */
export function verifySigned(
  role: SigningRole,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  let ok = false
  for (const key of ACCEPTED[role]) {
    let verified = false
    try {
      verified = ed25519.verify(signature, message, key)
    } catch {
      verified = false
    }
    ok = ok || verified
  }
  return ok
}

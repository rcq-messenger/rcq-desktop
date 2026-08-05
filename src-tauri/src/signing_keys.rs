//! The Ed25519 keys this build accepts a signature from, by what the signature
//! authorises. Mirrors Android `SigningKeys.kt` and iOS `SigningKeys.swift`.
//!
//! # Why a set, and why it is compiled in
//!
//! Every client used to pin exactly one key, written out in six places across
//! three codebases. That does not make rotation awkward, it makes it
//! impossible: a client that knows one key cannot be handed a payload signed by
//! any other, so the day the key has to change is the day every installed
//! client stops receiving relay updates and quietly runs on its bundled list
//! until the fleet moves out from under it.
//!
//! Accepting a set fixes the part that matters. Ship the successor, keep
//! signing with the incumbent, and switching becomes a signing-side decision
//! with no release and no flag day. Retiring the old key still needs a release,
//! but retiring is never the urgent direction.
//!
//! The set deliberately does NOT come from the signed payload. Letting a config
//! carry its own future keys would make even introducing a key releaseless, and
//! would also let an attacker holding the current key sign a payload adding one
//! of their own — after which rotating away from the stolen key evicts nobody,
//! because theirs is pinned in every client's cache. Rotation would be theatre.
//! Compiled in, a compromise lasts until we sign with the successor and not one
//! payload longer.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signature, VerifyingKey};

/// What a signature is allowed to authorise. Relay config and the island list
/// are separate because they are different powers — where traffic is tunnelled,
/// versus which island an account is silently given a backup mailbox on. One
/// key covers both today, so a leak costs both; each role also lists its own
/// successor, which is what lets them be pulled apart later without a release.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    RelayConfig,
    #[allow(dead_code)] // the desktop reads the island list from the web layer
    IslandList,
}

/// In use since 2026-05. Signs both roles, which is the overlap the split
/// exists to end.
const INCUMBENT: &str = "TY834OFcBvtUqHcnVw/QrPBOaEAZo7a1GAmABMhjkT8=";

/// Generated 2026-08-05, held offline, has never signed anything.
const RELAY_SUCCESSOR: &str = "sr0g2D8rXZiEdU8cA6gaIWKxA34QIsysUJQsEeloL1o=";

/// Generated 2026-08-05 for the island role alone, so the day the relay key is
/// rotated or leaks, the island list does not have to move with it.
const ISLAND_SUCCESSOR: &str = "YsA429yi8BeQKQVvi0HSykrK0SVsJlhNKhFwC+g7VWo=";

fn accepted(role: Role) -> &'static [&'static str] {
    match role {
        Role::RelayConfig => &[INCUMBENT, RELAY_SUCCESSOR],
        Role::IslandList => &[INCUMBENT, ISLAND_SUCCESSOR],
    }
}

/// True when `sig_b64` is a valid signature over `message` by ANY key this
/// build accepts for `role`.
///
/// Every candidate is tried even after one succeeds, so which key signed a
/// payload is not observable from how long verification took. A malformed key
/// or signature counts as a failed verification rather than an error: callers
/// are fetch paths that must fall back to what they already have.
pub fn verify(role: Role, message: &[u8], sig_b64: &str) -> bool {
    let Ok(sig_bytes) = B64.decode(sig_b64) else { return false };
    let Ok(signature) = Signature::from_slice(&sig_bytes) else { return false };
    let mut ok = false;
    for encoded in accepted(role) {
        let verified = B64
            .decode(encoded)
            .ok()
            .and_then(|raw| <[u8; 32]>::try_from(raw).ok())
            .and_then(|bytes| VerifyingKey::from_bytes(&bytes).ok())
            .map(|key| key.verify_strict(message, &signature).is_ok())
            .unwrap_or(false);
        ok = ok || verified;
    }
    ok
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The incumbent still verifies the payload compiled into this build, which
    /// is the case that must never break while the set grows.
    #[test]
    fn bundled_payload_verifies_under_the_set() {
        let bundled: serde_json::Value =
            serde_json::from_str(include_str!("../relay-config.json")).unwrap();
        let sig = bundled.get("sig").unwrap().as_str().unwrap();
        let mut signed = bundled.clone();
        signed.as_object_mut().unwrap().remove("sig");
        let mut message = String::new();
        crate::relay::canonical_for_test(&signed, &mut message);
        assert!(verify(Role::RelayConfig, message.as_bytes(), sig));
    }

    #[test]
    fn a_key_outside_the_set_is_refused() {
        // Valid base64, valid length, simply not one of ours.
        let stranger = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
        assert!(!verify(Role::RelayConfig, b"anything", stranger));
    }
}

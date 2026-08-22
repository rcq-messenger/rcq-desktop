// Federation Layer B (F2 prep) — resolve a peer's current home islands.
//
// Implements the sender-side resolution of docs/federation-protocol.md §4:
// given a peer's address (host + uin), fetch their key bundle (which anchors the
// identity key `ik` and the Ed25519 signing key `sk`) and their signed
// home-island record from `host`, verify the record per §2.4, and return the
// verified list of homes to deposit to.
//
// Read-only and wired into NO live send path yet. The F2 send-path change
// (depositing a sealed envelope to each resolved home on the peer's island
// instead of only the flagship) is the next, riskier step and is deliberately
// separate.

import { verifyHomeIslandRecord, type IslandHome } from './federation'

export interface ResolvedPeer {
  /// libsignal identity key (base64) anchored from the peer's bundle, or '' if
  /// the bundle was unavailable (v=1-only peer).
  ik: string
  /// Ed25519 signing key (base64) anchored from the peer's bundle.
  sk: string
  /// The peer's current home islands, in their preference order. Always at least
  /// the single home you were addressed with.
  homes: IslandHome[]
  /// True when `homes` came from a signature-verified record; false when it is
  /// the single-home fallback (no record published, or verification failed).
  verified: boolean
}

/// Resolve `uin@host` to its verified home islands (spec §4).
///
/// Anchors the peer's `ik`/`sk` from `GET /federation/keys/{uin}` — an OPEN,
/// minimal public-key card (no auth, no prekey consumed) the island serves for
/// any of its residents. That openness is what makes cross-island resolution
/// work: a sender on another island holds no token on the peer's island, so the
/// anchor source must be unauthenticated. (`/keys/{uin}/bundle` is still used
/// separately to start a v=2 session; it is not the anchor. On a Stage 3 island
/// that bundle is no longer session-token-gated either but spends an anonymous
/// deposit token instead, so the island never learns whose keys were fetched.)
export async function resolvePeerHomes(
  host: string,
  uin: number,
): Promise<ResolvedPeer> {
  const base = `https://${host}`
  const fallback = (ik = '', sk = ''): ResolvedPeer => ({ ik, sk, homes: [{ host, uin }], verified: false })

  // 1. Public-key card → candidate ik + sk (the keys the record must match).
  let ik = ''
  let sk = ''
  try {
    const res = await fetch(`${base}/federation/keys/${uin}`)
    if (res.ok) {
      const b = (await res.json()) as { signal_identity_key?: string; signing_key?: string }
      ik = b.signal_identity_key ?? ''
      sk = b.signing_key ?? ''
    }
  } catch {
    return fallback()
  }

  // 2. Home-island record (public, unauthenticated).
  let rec: unknown
  try {
    const res = await fetch(`${base}/federation/island-record/${uin}`)
    if (!res.ok) return fallback(ik, sk)
    rec = await res.json()
  } catch {
    return fallback(ik, sk)
  }

  // 3. Verify per §2.4, anchored to the bundle keys when we have them.
  const v = verifyHomeIslandRecord(rec, {
    expectedIk: ik || undefined,
    expectedSk: sk || undefined,
  })
  if (!v.ok) return fallback(ik, sk)
  return { ik: v.record.ik, sk: v.record.sk, homes: v.record.homes, verified: true }
}

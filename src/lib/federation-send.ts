// Federation Layer B (F2) — cross-island send.
//
// The reusable core that delivers a sealed envelope to a peer on ANOTHER island:
// resolve the peer's current homes (federation-protocol.md §4), seal the envelope
// to them (v=1 sealed sender, anchored from their island's open key card), and
// deposit a copy to each home's island. Receiving is unchanged — the peer polls
// their own island, into which we deposited.
//
// NOT yet wired into the live UI send path: that needs a cross-island *contact*
// model (a peer on another island does not fit the flagship's server-side
// /contacts system, so it has to be stored locally). This module is the proven,
// verified mechanism the eventual UI feature calls. v=1 only: a v=2 libsignal
// session needs the peer's auth-gated prekey bundle on their island, which a
// cross-island sender has no token for; v=1 needs only the public identity key
// from the open card, and v=1 is the 1:1 default anyway.

import type { WebIdentity, Envelope } from './crypto'
import { encryptV1 } from './crypto'
import { type ResolvedPeer } from './federation-resolve'
import { resolveAndMirrorHomes } from './multihome'

export interface PeerKeyCard {
  identity_key: string
  signing_key: string
  signal_identity_key?: string | null
  // §5c display: the open card now carries the peer's nickname (+ optional
  // gender/status) so a cross-island contact shows a real name, not uin@host.
  nickname?: string | null
  gender?: string | null
  status_message?: string | null
}

/// Fetch a peer's open public-key card from their island (no auth). Returns null
/// on any failure (caller decides whether to fall back to v=1-on-own-island).
export async function fetchPeerKeyCard(host: string, uin: number): Promise<PeerKeyCard | null> {
  try {
    const res = await fetch(`https://${host}/federation/keys/${uin}`)
    if (!res.ok) return null
    return (await res.json()) as PeerKeyCard
  } catch {
    return null
  }
}

export interface CrossIslandResult {
  /// Number of island homes the sealed envelope was accepted by (HTTP 2xx).
  delivered: number
  /// The homes that were attempted.
  homes: ResolvedPeer['homes']
  /// True if the peer's island routing record verified (else single-home guess).
  verified: boolean
}

/// Deliver one envelope to `peerUin@peerHost`, depositing to every resolved home.
///
/// Returns how many island homes accepted it. Throws only if the peer's key card
/// can't be fetched at all (no way to seal to them); transient per-home deposit
/// failures are counted, not thrown, so multi-homing degrades gracefully.
export async function deliverCrossIsland(
  sender: WebIdentity,
  peerHost: string,
  peerUin: number,
  envelope: Envelope,
  // Locally-pinned keys from the cross-island contact (anchored at add-time).
  // When present, the send survives the peer's island being blocked or dead:
  // we seal from these instead of depending on a live card fetch, and reach the
  // peer via the gossip mirror of their record. Omitted = legacy live-card-only.
  localKeys?: { identityKey: string; signingKey: string },
): Promise<CrossIslandResult> {
  // Prefer a fresh card (catches key rotation), but fall back to the locally-
  // pinned keys so a dead/blocked peer island doesn't break the send outright.
  const card = await fetchPeerKeyCard(peerHost, peerUin)
  const identityKey = card?.identity_key || localKeys?.identityKey
  const signingKey = card?.signing_key || localKeys?.signingKey || ''
  if (!identityKey) throw new Error(`cannot fetch key card for ${peerUin}@${peerHost}`)

  // Gossip-aware home resolution: mirror the record onto our island on success,
  // reap our gossip mirror when the peer's island is unreachable. Floor to the
  // single address we have when nothing resolves.
  let homes: ResolvedPeer['homes'] = []
  if (signingKey) homes = await resolveAndMirrorHomes(sender, peerHost, peerUin, signingKey)
  const verified = homes.length > 0
  if (homes.length === 0) homes = [{ host: peerHost, uin: peerUin }]

  const sealed = encryptV1(envelope, sender, { uin: peerUin, identityKey, signingKey })

  let delivered = 0
  for (const home of homes) {
    try {
      const res = await fetch(`https://${home.host}/messages/sealed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to_uin: home.uin, envelope_type: 'message', payload: sealed }),
      })
      if (res.ok) delivered++
    } catch {
      /* this home is unreachable; multi-homing covers it via the others */
    }
  }
  return { delivered, homes, verified }
}

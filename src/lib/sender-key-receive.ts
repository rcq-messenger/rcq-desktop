// Receive side of sender-keys: decode a `gmsg` broadcast into the inner
// envelope, plus the SKDM/SKNACK recovery handshake. Pure-ish orchestration
// over sender-key-store; network (group fetch + re-seal) is best-effort.

import { Api, type RCQGroup } from './api'
import { b64ToBytes, encryptV1, type Envelope, type WebIdentity } from './crypto'
import { holdGmsg, takeHeldForKid } from './held-gmsg'
import { openGmsg, type GmsgWire } from './sender-keys'
import {
  acceptSkdm,
  deriveInbound,
  knowsKid,
  ownChainSnapshot,
  ownKidForGroup,
  ownsKid,
} from './sender-key-store'

// Debounce NACKs so a burst of un-openable gmsg (e.g. a missed SKDM) fires at
// most one recovery request per kid per window.
const NACK_WINDOW_MS = 10 * 60 * 1000
const lastNack = new Map<string, number>()

function nowMs(): number {
  return Date.now()
}

export interface RoutedGmsg {
  senderUIN: number
  envelope: Envelope
}

/// Decode a `gmsg` broadcast payload (base64 of the gmsg wire JSON) for group
/// `gid`. Returns the inner envelope + real sender to route, or null when the
/// message is mine (carbon handles it), a replay, unverifiable, or pending an
/// SKDM (a NACK is fired in that last case).
export async function handleGmsg(
  identity: WebIdentity,
  payloadB64: string,
  gid: number,
): Promise<RoutedGmsg | null> {
  let wire: GmsgWire
  try {
    wire = JSON.parse(new TextDecoder().decode(b64ToBytes(payloadB64))) as GmsgWire
  } catch {
    return null
  }
  if (wire.v !== 1 || typeof wire.kid !== 'string') return null

  // My own broadcast echoed back by the server (the server can't exclude an
  // anonymous sender). Own multi-device sync rides the carbon, so drop it.
  // Scoped to THIS account: the sibling account in the same browser owns its
  // kids under its own uin and must still read ours as ordinary inbound.
  if (ownsKid(identity.uin, wire.kid)) return null

  const key = deriveInbound(identity.uin, wire.kid, wire.e, wire.i)
  if (!key) {
    if (!knowsKid(identity.uin, wire.kid)) {
      // Unknown kid: live delivery is unordered, so the SKDM may simply not
      // have arrived yet. Hold the raw packet for replay when it does, and
      // fire ONE recovery request. Holding adds no NACK of its own: this
      // branch stays the only NACK site, and the per-kid debounce above
      // already collapses the burst a missed SKDM produces.
      holdGmsg(identity.uin, { kid: wire.kid, gid, payloadB64, e: wire.e, i: wire.i })
      void sendNack(identity, gid, wire.kid)
    }
    return null // replay / epoch mismatch / too-far-ahead — silently dropped
  }
  let opened
  try {
    opened = openGmsg(wire, gid, key.mk, key.spub)
  } catch {
    return null // AEAD failure — wrong key / tampering
  }
  if (!opened.verified) {
    console.warn('[sender-keys] gmsg signature did not verify; dropping', { gid, kid: wire.kid })
    return null
  }
  return { senderUIN: key.senderUin, envelope: opened.envelope }
}

/// Store an inbound chain handed to us via an SKDM (bound to the
/// authenticated sender from the seal). Called from the receive router.
/// Returns true when the chain was stored (or refreshed), i.e. when a
/// replay of gmsgs held for this kid is worth firing.
export function handleSkdm(
  ownUin: number,
  senderUIN: number,
  senderSigningKey: string | undefined,
  env: { gid: number; kid: string; e: number; i: number; ck: string },
): boolean {
  if (!senderSigningKey) return false // unauthenticated: never trust an unbound chain
  return acceptSkdm(ownUin, env.kid, env.gid, senderUIN, senderSigningKey, env.e, env.i, env.ck)
}

export interface ReplayedGmsg extends RoutedGmsg {
  gid: number
}

/// Replay the broadcasts held for `kid` once its SKDM was accepted: each raw
/// packet goes back through `handleGmsg`, the normal decrypt path, in arrival
/// order. Returns what decrypted, for the caller to route. Dedup against a
/// copy the queue drain ALSO delivered is downstream and twofold: the chain
/// refuses a position it already ratcheted past, and the incoming store
/// dedups by envelope id. A packet that still cannot decrypt (say the SKDM
/// was for a newer epoch) is dropped or re-held by `handleGmsg` itself, and
/// cannot NACK-storm: the key is known now, and the not-known case sits
/// behind the same per-kid debounce as ever.
export async function replayHeldGmsg(identity: WebIdentity, kid: string): Promise<ReplayedGmsg[]> {
  const held = takeHeldForKid(identity.uin, kid)
  const out: ReplayedGmsg[] = []
  for (const h of held) {
    const got = await handleGmsg(identity, h.payloadB64, h.gid)
    if (got) out.push({ ...got, gid: h.gid })
  }
  return out
}

/// Answer a recovery request: if I own this group's chain, re-seal a current
/// SKDM to the requester so they can read going forward.
export async function handleSknack(
  identity: WebIdentity,
  requesterUIN: number,
  env: { gid: number; kid: string },
): Promise<void> {
  if (ownKidForGroup(identity.uin, env.gid) !== env.kid) return // not my kid (or rotated away)
  const snap = ownChainSnapshot(identity.uin, env.gid)
  if (!snap) return
  let group: RCQGroup
  try {
    group = await Api.groupInfo(identity, env.gid)
  } catch {
    return
  }
  const m = group.members.find((x) => x.uin === requesterUIN)
  if (!m || !m.identity_key) return
  try {
    const payload = encryptV1(
      { kind: 'skdm', gid: env.gid, kid: snap.kid, e: snap.e, i: snap.i, ck: snap.ck },
      identity,
      { uin: m.uin, identityKey: m.identity_key, signingKey: m.signing_key },
    )
    await Api.sendGroupSealed(identity, env.gid, [{ to_uin: m.uin, payload }], 'skdm')
  } catch {
    /* best effort */
  }
}

/// Fire one recovery request for an unknown kid to the group's capable
/// members (we don't know whose kid it is). Debounced per kid.
async function sendNack(identity: WebIdentity, gid: number, kid: string): Promise<void> {
  const prev = lastNack.get(kid)
  if (prev && nowMs() - prev < NACK_WINDOW_MS) return
  lastNack.set(kid, nowMs())
  let group: RCQGroup
  try {
    group = await Api.groupInfo(identity, gid)
  } catch {
    return
  }
  const payloads = group.members
    .filter((m) => m.sender_keys && m.uin !== identity.uin && m.identity_key)
    .map((m) => {
      try {
        return {
          to_uin: m.uin,
          payload: encryptV1({ kind: 'sknack', gid, kid }, identity, {
            uin: m.uin,
            identityKey: m.identity_key,
            signingKey: m.signing_key,
          }),
        }
      } catch {
        return null
      }
    })
    .filter((x): x is { to_uin: number; payload: string } => x !== null)
  if (payloads.length === 0) return
  try {
    await Api.sendGroupSealed(identity, gid, payloads, 'sknack')
  } catch {
    /* best effort */
  }
}

// Group send fan-out. Mirrors iOS `MessageService.sendGroupEnvelope`:
// the sender encrypts the same plaintext envelope ONCE PER MEMBER
// using each recipient's identity key, then ships the resulting
// `[{to_uin, payload}, ...]` list in one POST. Self is excluded —
// my own outgoing log lives in this browser session, no need to
// echo a copy back through the server.
//
// All v=1 (Stage 2) — same envelope format the 1:1 path uses.
// Stage 3 (libsignal) groups would ride a single Sender Key
// distribution, but that's deferred to phase-5 alongside
// libsignal-WASM.

import { b64ToBytes, bytesToB64, encryptV1, type Envelope, type WebIdentity } from './crypto'
import type { GroupMember } from './api'
import { sealGmsg } from './sender-keys'
import { advanceOwn, markDistributed, prepareOwnSend } from './sender-key-store'

export interface GroupPayload {
  to_uin: number
  payload: string
}

/// A member we couldn't encrypt to, with the reason. Returned so the
/// caller can surface "delivered to N of M" instead of silently
/// dropping people — and so a single bad key never sinks the whole
/// send (the failure mode the founder hit: a member with an empty /
/// zero identity_key threw out of `@noble/curves` x25519 and aborted
/// the entire group message).
export interface SkippedMember {
  uin: number
  reason: string
}

export interface GroupEncryptResult {
  payloads: GroupPayload[]
  skipped: SkippedMember[]
}

/// True only for a usable X25519 public key: base64 that decodes to
/// exactly 32 bytes that aren't all-zero. An empty or zero key is the
/// classic placeholder that makes `x25519.getSharedSecret` throw
/// "invalid private or public key received". We reject those up front
/// (and still try/catch the encrypt for low-order points noble guards
/// against internally).
function isUsableIdentityKey(b64: string): boolean {
  if (!b64) return false
  let bytes: Uint8Array
  try {
    bytes = b64ToBytes(b64)
  } catch {
    return false
  }
  if (bytes.length !== 32) return false
  // All-zero point — never a real key.
  return bytes.some((x) => x !== 0)
}

/// Build the per-member ciphertext list for a group send. Skips the
/// caller themselves (`sender.uin`) and any member whose identity key
/// is missing/invalid (collected in `skipped` rather than thrown) so
/// one bad member can't fail delivery to everyone else.
export function encryptGroupEnvelope(
  envelope: Envelope,
  sender: WebIdentity,
  members: GroupMember[],
): GroupEncryptResult {
  const payloads: GroupPayload[] = []
  const skipped: SkippedMember[] = []
  for (const m of members) {
    if (m.uin === sender.uin) continue
    if (!isUsableIdentityKey(m.identity_key)) {
      skipped.push({ uin: m.uin, reason: 'invalid_identity_key' })
      continue
    }
    try {
      const payload = encryptV1(envelope, sender, {
        uin: m.uin,
        identityKey: m.identity_key,
        signingKey: m.signing_key,
      })
      payloads.push({ to_uin: m.uin, payload })
    } catch (e) {
      // Defensive: low-order point or any other noble rejection.
      // Skip this member, keep delivering to the rest.
      skipped.push({
        uin: m.uin,
        reason: e instanceof Error ? e.message : 'encrypt_failed',
      })
    }
  }
  if (skipped.length > 0) {
    // Surface in the console so a recurring bad member is diagnosable
    // (which UIN, why) without blocking the send.
    console.warn('[group-send] skipped members with unusable keys:', skipped)
  }
  return { payloads, skipped }
}

export interface GroupDualSend {
  /// base64(JSON gmsg wire) — ONE ciphertext for the whole group. Null when
  /// nobody in the group is sender-keys-capable (pure legacy send).
  broadcastPayload: string | null
  /// SKDMs to seal to capable members who don't yet hold this chain (rides
  /// /messages/group-sealed, envelope_type "skdm"). Empty once distributed.
  skdmPayloads: GroupPayload[]
  /// Per-member ciphertexts for NON-capable members (legacy fan-out). Empty
  /// when every member is capable.
  legacyPayloads: GroupPayload[]
  skipped: SkippedMember[]
  /// MUST be called after the broadcast POST succeeds: marks the SKDM
  /// recipients as distributed and ratchets the outbound chain one step.
  commit: () => void
}

/// Build the dual-send for a group message: encrypt ONCE for every capable
/// member (broadcast) + SKDMs for capable members still missing the chain +
/// the legacy per-member fan-out for non-capable members. Rotates the
/// outbound chain when a previously-distributed member is gone (forward
/// secrecy). `gid` is the SERVER group id (the chain is keyed by it).
export function buildGroupDualSend(
  envelope: Envelope,
  sender: WebIdentity,
  gid: number,
  members: GroupMember[],
): GroupDualSend {
  const skipped: SkippedMember[] = []
  const capable: GroupMember[] = []
  const legacy: GroupMember[] = []
  for (const m of members) {
    if (m.uin === sender.uin) continue
    if (!isUsableIdentityKey(m.identity_key)) {
      skipped.push({ uin: m.uin, reason: 'invalid_identity_key' })
      continue
    }
    if (m.sender_keys) capable.push(m)
    else legacy.push(m)
  }

  // Legacy fan-out (unchanged path) for everyone without the capability.
  const legacyPayloads: GroupPayload[] = []
  for (const m of legacy) {
    try {
      legacyPayloads.push({
        to_uin: m.uin,
        payload: encryptV1(envelope, sender, {
          uin: m.uin,
          identityKey: m.identity_key,
          signingKey: m.signing_key,
        }),
      })
    } catch (e) {
      skipped.push({ uin: m.uin, reason: e instanceof Error ? e.message : 'encrypt_failed' })
    }
  }

  if (capable.length === 0) {
    return { broadcastPayload: null, skdmPayloads: [], legacyPayloads, skipped, commit: () => {} }
  }

  // Encrypt once under the outbound chain's current message key.
  const capableUins = capable.map((m) => m.uin)
  const step = prepareOwnSend(gid, capableUins)
  const gmsg = sealGmsg(envelope, sender, gid, step.kid, step.e, step.i, step.mk)
  const broadcastPayload = bytesToB64(new TextEncoder().encode(JSON.stringify(gmsg)))

  // SKDM to capable members who don't hold (kid, epoch) yet.
  const skdmPayloads: GroupPayload[] = []
  const distributedNow: number[] = []
  for (const m of capable) {
    if (!step.needDistribution.includes(m.uin)) continue
    try {
      skdmPayloads.push({
        to_uin: m.uin,
        payload: encryptV1(
          { kind: 'skdm', gid, kid: step.kid, e: step.e, i: step.i, ck: step.ckAtI },
          sender,
          { uin: m.uin, identityKey: m.identity_key, signingKey: m.signing_key },
        ),
      })
      distributedNow.push(m.uin)
    } catch (e) {
      skipped.push({ uin: m.uin, reason: e instanceof Error ? e.message : 'skdm_failed' })
    }
  }

  return {
    broadcastPayload,
    skdmPayloads,
    legacyPayloads,
    skipped,
    commit: () => {
      if (distributedNow.length > 0) markDistributed(gid, distributedNow)
      advanceOwn(gid)
    },
  }
}

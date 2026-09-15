// Receive side of sender-keys: decode a `gmsg` broadcast into the inner
// envelope, plus the SKDM/SKNACK recovery handshake. Pure-ish orchestration
// over sender-key-store; network (group fetch + re-seal) is best-effort.

import { Api, type RCQGroup } from './api'
import { b64ToBytes, encryptV1, type Envelope, type WebIdentity } from './crypto'
import { holdGmsg, takeHeldForKid, type GuestRoom } from './held-gmsg'
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
// most one recovery request per kid per window - and STOP asking about a kid
// nobody answers for. The flat in-memory 10-minute window turned one dead kid
// (its owner deleted their account; nobody alive can answer) into a forever
// machine: a 24/7 install re-asked a 971-member room every ten minutes, 366
// whole-room fan-outs in 12 hours, and a reload wiped the window and asked
// again immediately. So the state is persisted, the window doubles per
// unanswered ask, and after ATTEMPTS_MAX the kid is written off for a week
// (`skdmArrived` clears the record the moment a real answer lands, so a
// recovered kid never serves the sentence).
const NACK_BACKOFF_MS = [10 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000, 24 * 3600_000]
const NACK_ATTEMPTS_MAX = NACK_BACKOFF_MS.length
const NACK_WRITEOFF_MS = 7 * 24 * 3600_000
const NACK_STORE_KEY = 'rcq.web.sknack.v1'

type NackRec = { n: number; at: number }
let nackState: Record<string, NackRec> | null = null

function loadNackState(): Record<string, NackRec> {
  if (nackState) return nackState
  try {
    nackState = JSON.parse(localStorage.getItem(NACK_STORE_KEY) ?? '{}') as Record<string, NackRec>
  } catch {
    nackState = {}
  }
  return nackState
}

function saveNackState(): void {
  try {
    localStorage.setItem(NACK_STORE_KEY, JSON.stringify(nackState ?? {}))
  } catch {
    /* private mode: the in-memory copy still debounces this run */
  }
}

/// May we ask about `kid` now? Records the attempt when yes.
function nackAllowed(kid: string): boolean {
  const st = loadNackState()
  const rec = st[kid]
  if (!rec) {
    st[kid] = { n: 1, at: nowMs() }
    saveNackState()
    return true
  }
  const wait = rec.n >= NACK_ATTEMPTS_MAX ? NACK_WRITEOFF_MS : NACK_BACKOFF_MS[rec.n - 1]
  if (nowMs() - rec.at < wait) return false
  st[kid] = { n: Math.min(rec.n + 1, NACK_ATTEMPTS_MAX + 1), at: nowMs() }
  saveNackState()
  return true
}

/// A real SKDM for `kid` landed: the asks worked, forget the ledger.
export function nackAnswered(kid: string): void {
  const st = loadNackState()
  if (st[kid]) {
    delete st[kid]
    saveNackState()
  }
}

function nowMs(): number {
  return Date.now()
}

export interface RoutedGmsg {
  senderUIN: number
  envelope: Envelope
}

/// What decoding one broadcast came to. `routed` is the inner envelope plus
/// its real sender, or null when there is nothing to show; `held` says the
/// null is the RECOVERABLE kind: the packet is in the hold buffer waiting on
/// a chain this account has never been handed (a NACK went out). A caller
/// that acks rows by position needs the difference: the web's hold is in
/// memory, so a held live frame is not acked (the next drain re-serves it),
/// while every other null is terminal.
export interface DecodedGmsg {
  routed: RoutedGmsg | null
  held: boolean
}

/// Decode a `gmsg` broadcast payload (base64 of the gmsg wire JSON) for group
/// `gid`. Returns the inner envelope + real sender to route, or null when the
/// message is mine (carbon handles it), a replay, unverifiable, or pending an
/// SKDM (a NACK is fired in that last case).
///
/// `room` is for a broadcast out of a guest mailbox on ANOTHER island (§5c),
/// and then `gid` is that island's own id for the room (the AEAD binds it).
/// The chain is still looked up under `identity.uin`, the home account: that
/// is where the key messages for these rooms are filed today, because the
/// guest drains route them under the home identity (keying foreign rooms by
/// host and guest number instead is the planned follow-up). What the room
/// changes is everything that talks to the network, which has to happen on
/// the room's island under our guest identity there, and our own-echo check,
/// which must also know the kids we post under as a guest.
export async function handleGmsg(
  identity: WebIdentity,
  payloadB64: string,
  gid: number,
  room?: GuestRoom,
): Promise<RoutedGmsg | null> {
  return (await decodeGmsg(identity, payloadB64, gid, room)).routed
}

/// handleGmsg with the hold made visible (see DecodedGmsg).
export async function decodeGmsg(
  identity: WebIdentity,
  payloadB64: string,
  gid: number,
  room?: GuestRoom,
): Promise<DecodedGmsg> {
  const dropped: DecodedGmsg = { routed: null, held: false }
  let wire: GmsgWire
  try {
    wire = JSON.parse(new TextDecoder().decode(b64ToBytes(payloadB64))) as GmsgWire
  } catch {
    return dropped
  }
  if (wire.v !== 1 || typeof wire.kid !== 'string') return dropped

  // My own broadcast echoed back by the server (the server can't exclude an
  // anonymous sender). Own multi-device sync rides the carbon, so drop it.
  // Scoped to THIS account: the sibling account in the same browser owns its
  // kids under its own uin and must still read ours as ordinary inbound.
  if (ownsKid(identity.uin, wire.kid)) return dropped
  // In a room on another island we post as our guest number there, so the
  // chain we own for it is filed under that number (Chat sends with the guest
  // identity). Missing this read our own echo as an unknown kid: held, and a
  // re-send request fanned out to the whole room about our own message.
  if (room && ownsKid(room.ident.uin, wire.kid)) return dropped

  const key = deriveInbound(identity.uin, wire.kid, wire.e, wire.i)
  if (!key) {
    if (!knowsKid(identity.uin, wire.kid)) {
      // Unknown kid: live delivery is unordered, so the SKDM may simply not
      // have arrived yet. Hold the raw packet for replay when it does, and
      // fire ONE recovery request. Holding adds no NACK of its own: this
      // branch stays the only NACK site, and the per-kid debounce above
      // already collapses the burst a missed SKDM produces.
      holdGmsg(identity.uin, { kid: wire.kid, gid, payloadB64, e: wire.e, i: wire.i, room })
      // ⚠ A foreign room's roster and its re-send request live on ITS island:
      // asked of the home island under the home identity, this read the
      // roster of whatever local room shares the number and sealed the
      // request to its members.
      void sendNack(room ? room.ident : identity, gid, wire.kid)
      return { routed: null, held: true }
    }
    return dropped // replay / epoch mismatch / too-far-ahead, silently dropped
  }
  let opened
  try {
    opened = openGmsg(wire, gid, key.mk, key.spub)
  } catch {
    return dropped // AEAD failure: wrong key / tampering
  }
  if (!opened.verified) {
    console.warn('[sender-keys] gmsg signature did not verify; dropping', { gid, kid: wire.kid })
    return dropped
  }
  return { routed: { senderUIN: key.senderUin, envelope: opened.envelope }, held: false }
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
  const ok = acceptSkdm(ownUin, env.kid, env.gid, senderUIN, senderSigningKey, env.e, env.i, env.ck)
  if (ok) nackAnswered(env.kid)
  return ok
}

export interface ReplayedGmsg extends RoutedGmsg {
  gid: number
  /// The room's island, when the broadcast came out of a guest mailbox on
  /// another island. The caller must route it as that island's traffic, never
  /// as the home island's (see routeForeignRoomBroadcast).
  host?: string
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
    const got = await handleGmsg(identity, h.payloadB64, h.gid, h.room)
    // A foreign room's broadcast is decoded under its island's id but FILED
    // under the local alias, like every other row out of a guest mailbox.
    if (got) out.push(h.room ? { ...got, gid: h.room.aliasGid, host: h.room.host } : { ...got, gid: h.gid })
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
  if (!nackAllowed(kid)) return
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

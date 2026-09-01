// Telling my OWN other devices that a cross-island request has been answered.
//
// ⚠⚠ The bug this closes: a cross-island request is per-INSTALL state. The
// conveyor row carries no `to_device_id`, so every device of the account reads
// it and writes its own copy, while accepting speaks only to the PEER. Accept
// on the desktop and the phone still shows the request; accept it there too and
// the second accept re-fetches the key card and OVERWRITES the pinned keys with
// no comparison and no warning — on the one class of peer whose every message
// is encrypted to exactly those pinned keys.
//
// The fix is a self-carbon, the same carrier the read marker uses (A2): outer
// type `read`, which the island files as ephemeral and has always seen, so no
// new token and no new fact for it. The server is not touched.

import { Api, peerBundleFrom } from './api'
import { encryptV1, bytesToB64, type CarbonEnvelope, type CIAckEnvelope, type WebIdentity } from './crypto'
import { saveCrossIsland, getCrossIsland } from './crossisland-store'
import { clearRequest, blockRequest } from './crossisland-requests'
import { allowStranger } from './stranger-requests'

export interface CIAckCard {
  nick?: string
  ik: string
  sk: string
  sik?: string | null
  gender?: string | null
  status?: string | null
}

/// Fire-and-forget. A lost ack costs what the bug costs today (a request the
/// other device still shows), so it must never fail an accept that already
/// happened locally.
export async function sendRequestAck(
  identity: WebIdentity,
  uin: number,
  host: string,
  act: 'accept' | 'decline' | 'block',
  card?: CIAckCard,
): Promise<void> {
  try {
    const inner: CIAckEnvelope = { kind: 'ciack', uin, host, act, ...(card ? { card } : {}) }
    // ⚠⚠ `to` is MY OWN uin, not null, and that is a compatibility decision
    // rather than a meaning: this answer belongs to no thread and names its
    // subject in its own fields. But a client that predates `ciack` resolves
    // the carbon's destination FIRST, and on iOS a carbon with no destination
    // is dropped before it is acked — so the island would hand the same row
    // back on every drain for the thirty days of the queue TTL. Addressed to
    // myself it resolves to the Saved Messages thread, where an unknown inner
    // kind files nothing on any of the three clients (checked) and the row is
    // acked and gone.
    const carbon: CarbonEnvelope = { kind: 'carbon', to: identity.uin, gid: null, env: inner }
    const selfBundle = peerBundleFrom({
      uin: identity.uin,
      identity_key: bytesToB64(identity.identityPub),
      signing_key: bytesToB64(identity.signingPub),
    })
    await Api.sendSealed(identity, identity.uin, encryptV1(carbon, identity, selfBundle), 'read')
  } catch {
    /* best-effort, see above */
  }
}

/// Apply an ack that came from another of my devices. Returns true when
/// something actually changed here, so the caller can refresh a list.
///
/// ⚠ Idempotent by construction, because this arrives on the device that SENT
/// it too (the origin re-receives its own carbon): every branch is "drop the
/// row / remember the allowance", and the contact is only written when it is
/// missing. Never re-fetches anything: the card in the envelope is the one the
/// accepting device pinned, and copying it is the whole point — two devices
/// doing their own TOFU on the same peer is how the keys drift apart.
export function applyRequestAck(ack: {
  uin?: unknown
  host?: unknown
  act?: unknown
  card?: unknown
}): boolean {
  const uin = typeof ack.uin === 'number' ? ack.uin : null
  const host = typeof ack.host === 'string' ? ack.host : null
  const act = ack.act
  if (uin == null || host == null) return false
  if (act !== 'accept' && act !== 'decline' && act !== 'block') return false

  if (act === 'block') {
    blockRequest(uin, host)
    return true
  }
  if (act === 'decline') {
    return clearRequest(uin, host) != null
  }

  // Accept. A same-island stranger (host '') has no card and no §5f request:
  // the allowance IS the acceptance.
  if (host === '') {
    allowStranger(uin)
    clearRequest(uin, '')
    return true
  }
  const card = ack.card as CIAckCard | undefined
  if (card && typeof card.ik === 'string' && typeof card.sk === 'string' && !getCrossIsland(uin, host)) {
    saveCrossIsland({
      uin,
      host,
      nickname: card.nick?.trim() || `${uin}@${host}`,
      identityKey: card.ik,
      signingKey: card.sk,
      signalIdentityKey: card.sik ?? null,
      addedAt: Date.now(),
      gender: card.gender ?? null,
      statusMessage: card.status ?? null,
    })
  }
  // The held messages stay held on this device. They were quarantined here and
  // releasing them from a remote ack would replay a backlog into a chat list
  // nobody is looking at; the next message from an accepted contact flows
  // normally, and the row is gone either way.
  clearRequest(uin, host)
  return true
}

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
import { ackServerRef } from './crossisland-pending'
import {
  applyBlockDecision,
  blockRequest,
  clearRequest,
  decisionNow,
  getRequest,
  liftBlocksFor,
  localDecisionAt,
  markAnswered,
} from './crossisland-requests'
import { ackDecisionAt, ackKeys } from './crossisland-block-rules'
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
  act: 'accept' | 'decline' | 'block' | 'unblock',
  card?: CIAckCard,
  /// The island row the answer settled (spec 2026-09-15, F1), so my other
  /// devices mark it answered instead of polling it back into their list.
  srv?: { host: string; id: number },
  /// A block or an unblock: when it was decided, and for a block what it
  /// covers (crossisland-block-rules.ts).
  decision?: { at: number; keys?: string[]; keyOnly?: boolean },
): Promise<void> {
  try {
    const inner: CIAckEnvelope = {
      kind: 'ciack',
      uin,
      host,
      act,
      ...(card ? { card } : {}),
      ...(srv ? { srv } : {}),
      ...(decision ? { at: decision.at } : {}),
      ...(decision?.keys?.length ? { keys: decision.keys } : {}),
      ...(decision?.keyOnly ? { keyOnly: true } : {}),
    }
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

/// Block a sender from this device: the decision here, then the same one to
/// the account's other devices. `keys` are the keys blocked with the address
/// (a contact's pinned key, or the keys a request was sealed under);
/// `keyOnly` blocks only those, for a request under a contact's address with
/// another key. `srv` is the island row the block answers, if any.
export function blockSender(
  identity: WebIdentity,
  uin: number,
  host: string,
  opts: { keys?: string[]; keyOnly?: boolean; srv?: { host: string; id: number } } = {},
): void {
  const at = localDecisionAt(uin, host)
  const keys = (opts.keys ?? []).filter((k) => typeof k === 'string' && k.length > 0)
  const keyOnly = opts.keyOnly === true && keys.length > 0
  blockRequest(uin, host, { at, keys, keyOnly })
  void sendRequestAck(identity, uin, host, 'block', undefined, opts.srv, { at, keys, keyOnly })
}

/// Let a sender through again: every block that stops them (their address,
/// and a block made against their key on another of their islands), here and
/// on the account's other devices. `signingKey` is the key they are known by
/// (a contact's pinned key). Returns how many blocks were lifted.
///
/// Also what an explicit add or accept of this exact person calls: that is a
/// decision to hear from them, and a block left behind from an old request
/// would otherwise drop everything they write, with nothing on screen.
export function unblockSender(identity: WebIdentity, uin: number, host: string, signingKey?: string | null): number {
  const lifted = liftBlocksFor(uin, host, signingKey, decisionNow(), true)
  for (const a of lifted) void sendRequestAck(identity, a.uin, a.host, 'unblock', undefined, undefined, { at: a.at })
  return lifted.length
}

/// Lift exactly one entry of the block list, the one the list of blocks
/// (Privacy) shows as a row, here and on the account's other devices. Another
/// entry that blocks the same person stays: it is its own row in that list.
export function unblockEntry(identity: WebIdentity, uin: number, host: string): boolean {
  const at = localDecisionAt(uin, host)
  if (!applyBlockDecision(uin, host, { on: false, at })) return false
  void sendRequestAck(identity, uin, host, 'unblock', undefined, undefined, { at })
  return true
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
///
/// A block or an unblock is a decision with a time (`at`, or the row's deposit
/// stamp `srvAt` from a sender that predates it), and an older one than this
/// device holds changes nothing: the echo of my own block, drained after I
/// already unblocked, must not block again.
export function applyRequestAck(
  ack: {
    uin?: unknown
    host?: unknown
    act?: unknown
    card?: unknown
    srv?: unknown
    at?: unknown
    keys?: unknown
    keyOnly?: unknown
  },
  srvAt?: number,
): boolean {
  const uin = typeof ack.uin === 'number' && Number.isInteger(ack.uin) && ack.uin > 0 ? ack.uin : null
  const host = typeof ack.host === 'string' ? ack.host : null
  const act = ack.act
  if (uin == null || host == null) return false
  if (act !== 'accept' && act !== 'decline' && act !== 'block' && act !== 'unblock') return false

  const at = ackDecisionAt(ack.at, srvAt, decisionNow())
  if (act === 'block') {
    const blocked = ackServerRef(ack.srv, host)
    if (blocked) markAnswered(blocked.host, blocked.id)
    // An older Android or iOS names no keys: the address alone, as before.
    const keys = ackKeys(ack.keys)
    blockRequest(uin, host, { at, keys, keyOnly: ack.keyOnly === true && keys.length > 0 })
    return true
  }
  if (act === 'unblock') {
    return applyBlockDecision(uin, host, { on: false, at })
  }

  // ⚠⚠ This device holds an accept for this person that has not reached them
  // yet (crossisland-pending.ts, `srvAcceptTries`). That row is what the retry
  // hangs on: clearing it, or marking its island row answered, is what once
  // turned "island B is unreachable" into a withdraw of the requester's row
  // with the accept never delivered. Current builds send an ack for an island
  // row only after the answer landed, so this is for an older sender, and for
  // two devices giving two answers: the undelivered accept here wins, and the
  // poll clears the row once it lands or the island stops listing it.
  if (getRequest(uin, host)?.srvAcceptTries) return false

  // Whatever the answer was, the island row it settled is answered here too.
  // Only a row on the island this ack is about (ackServerRef).
  const srv = ackServerRef(ack.srv, host)
  if (srv) markAnswered(srv.host, srv.id)
  if (act === 'decline') {
    return clearRequest(uin, host) != null || srv != null
  }

  // Accept. An accept of this person on another device is a decision to hear
  // from them, and it lifts a block this device holds against them, if that
  // block is older: the address, or the key the accepting device pinned.
  // Without it a block made here before the person was accepted elsewhere
  // would now drop everything they write. A block held against ANOTHER key at
  // this address (an impostor's) is not theirs to lift, and stays.
  const card = ack.card as CIAckCard | undefined
  const cardKey = card && typeof card.sk === 'string' ? card.sk : null
  liftBlocksFor(uin, host, cardKey ?? getCrossIsland(uin, host)?.signingKey ?? null, at)
  // A same-island stranger (host '') has no card and no §5f request: the
  // allowance IS the acceptance.
  if (host === '') {
    allowStranger(uin)
    clearRequest(uin, '')
    return true
  }
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

// Contact requests, both directions.
//
// The CLI could send one and could never answer one. Two people whose only
// client is this one could not become contacts at all unless both happened to
// type `rcq add` at each other, because the island reads a reciprocal request
// as an acceptance. And a request sent from here vanished: no list, no state,
// no line when the answer came back. All four endpoints have been on the
// island since the phones got them and all four are already wrapped in
// api.ts; nothing about a terminal made this hard.
//
// The live half matters as much as the lists. `contact_request` and
// `contact_response` are plain island frames, not envelopes, so they were
// dropped by the socket's sealed-only filter; see CONTROL_WS_TYPES.

import { Api, ApiError, type OutgoingRequest, type PendingRequest } from '../../src/lib/api'
import type { WebIdentity } from '../../src/lib/crypto'
import { noteName, peerLabel } from './directory'
import { tr } from './i18n'
import { humanError } from './errors'

export interface RequestLists {
  incoming: PendingRequest[]
  outgoing: OutgoingRequest[]
}

/// Both lists in one round trip pair. Names on the rows are learned as we go,
/// so `#396` becomes `Vasya (#396)` everywhere else in the session.
export async function loadRequests(identity: WebIdentity): Promise<RequestLists> {
  const [incoming, outgoing] = await Promise.all([
    Api.pendingRequests(identity),
    Api.outgoingRequests(identity).catch(() => [] as OutgoingRequest[]),
  ])
  for (const r of incoming) noteName(identity.uin, r.from_uin, r.nickname)
  for (const r of outgoing) noteName(identity.uin, r.to_uin, r.nickname)
  return { incoming, outgoing }
}

/// What `rcq add` actually did. The island answers `state: "accepted"` when
/// the other side had already asked for us and our send closed the loop: the
/// one case where adding WORKED outright, which the CLI used to report as
/// "request sent" like every other.
export async function sendRequest(identity: WebIdentity, uin: number): Promise<'accepted' | 'pending' | 'already'> {
  try {
    const res = (await Api.sendContactRequest(identity, uin)) as { state?: string } | null
    return res?.state === 'accepted' ? 'accepted' : 'pending'
  } catch (e) {
    // 409 is not a failure worth an error: they are already in the list.
    if (e instanceof ApiError && e.status === 409) return 'already'
    throw e
  }
}

export type Answer = 'accepted' | 'declined'

/// Accept or decline the request FROM a uin. The island wants the request id,
/// which nobody has memorised, so the pending list is the lookup.
export async function respondTo(
  identity: WebIdentity,
  uin: number,
  accept: boolean,
): Promise<{ ok: true; answer: Answer } | { ok: false; reason: string }> {
  let pending: PendingRequest[]
  try {
    pending = await Api.pendingRequests(identity)
  } catch (e) {
    return { ok: false, reason: humanError(e) }
  }
  const row = pending.find((r) => r.from_uin === uin)
  if (!row) return { ok: false, reason: tr('req.noneFrom', { who: peerLabel(identity.uin, uin) }) }
  noteName(identity.uin, row.from_uin, row.nickname)
  await Api.respondToRequest(identity, row.id, accept)
  return { ok: true, answer: accept ? 'accepted' : 'declined' }
}

/// Withdraw a request we sent, or dismiss one they declined.
export async function cancelRequest(identity: WebIdentity, uin: number): Promise<void> {
  await Api.cancelOutgoing(identity, uin)
}

/// One human line for a live island frame about a request, or null when the
/// frame says nothing a person needs. Never throws: this runs on the socket.
export function describeRequestFrame(identity: WebIdentity, frame: { type: string; [k: string]: unknown }): string | null {
  if (frame.type === 'contact_request') {
    const from = frame.from_uin
    if (typeof from !== 'number') return null
    if (typeof frame.from_nickname === 'string') noteName(identity.uin, from, frame.from_nickname)
    return tr('req.incoming', { who: peerLabel(identity.uin, from), uin: from })
  }
  if (frame.type === 'contact_response') {
    // `to_uin` on this frame is the ANSWERER: the island is telling us what
    // the person we asked decided.
    const who = frame.to_uin
    if (typeof who !== 'number') return null
    const label = peerLabel(identity.uin, who)
    return frame.accepted === true ? tr('req.accepted', { who: label }) : tr('req.declined', { who: label })
  }
  if (frame.type === 'contact_request_cancelled') {
    const from = frame.from_uin
    if (typeof from !== 'number') return null
    return tr('req.withdrawn', { who: peerLabel(identity.uin, from) })
  }
  return null
}

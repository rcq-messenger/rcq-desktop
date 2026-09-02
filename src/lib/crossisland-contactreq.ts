// Federation §5f — cross-island contact requests, both directions.
//
// Adding someone on another island was a purely local act: fetch their open key
// card, write a row in `crossisland-store`, return success. Nothing was
// deposited to the peer's island and the peer was never told. Three reported
// defects were that one hole seen from three sides — a scan that claimed a
// request nobody sent, §5d calls gated on a mutual state the normal flow could
// never reach, and §5e profile refresh with no audience to address.
//
// The fix is one envelope (`kind:"contactreq"`), sealed v=1 to the identity key
// from the peer's open card and deposited to their PRIMARY island with the
// already-shipped `POST /messages/sealed`. Zero server changes: the island sees
// an opaque sealed blob of `envelope_type: "message"`, exactly as it does for a
// §5d call signal.
//
// ⚠ This module never writes a contact's pinned `identityKey`/`signingKey`.
// Those come from the peer's island card at add/accept time and are the
// anti-impersonation anchor (§2.4); a self-asserted envelope that could move
// them would BE the impersonation path. Everything a `contactreq` carries
// (nickname, note) is cosmetic.

import { Api } from './api'
import { contactsCache } from './contacts-cache'
import { newUUIDv4, type ContactReqEnvelope, type WebIdentity } from './crypto'
import { addContactRequest, clearRequest, isBlocked } from './crossisland-requests'
import { getCrossIsland } from './crossisland-store'
import { depositSealedToPrimary } from './federation-send'

export type ContactReqAct = ContactReqEnvelope['act']

/// A greeting is a message body's little brother, not a message body: bound it
/// on both send and receive so a hostile peer cannot park a novel in the
/// pending list of everyone who never accepted them.
export const CONTACTREQ_NOTE_MAX = 200
const NICKNAME_MAX = 64

/// Our own display name to put in the envelope. §5e's reasoning applies: the
/// name is self-asserted, and that is fine because identity is anchored by the
/// pinned keys, not by what a request calls itself. Read from the warm roster
/// snapshot first so the common case costs no round trip.
async function myDisplayName(identity: WebIdentity): Promise<string> {
  const cached = contactsCache.get(identity.uin)?.me?.nickname
  if (cached) return cached.slice(0, NICKNAME_MAX)
  try {
    const me = await Api.myInfo(identity)
    return (me.nickname || `${identity.uin}`).slice(0, NICKNAME_MAX)
  } catch {
    return `${identity.uin}`
  }
}

export function buildContactReq(act: ContactReqAct, nickname: string, note?: string | null): ContactReqEnvelope {
  const trimmed = (note ?? '').trim().slice(0, CONTACTREQ_NOTE_MAX)
  return {
    kind: 'contactreq',
    id: newUUIDv4(),
    ts: Math.floor(Date.now() / 1000), // epoch SECONDS, same as the `call` envelope
    act,
    nickname,
    note: trimmed || null,
  }
}

/// Deposit one `contactreq` to `uin@host`'s PRIMARY island. Returns true when
/// that island accepted it. Never throws — the caller decides what to tell the
/// user, and "not delivered" is a thing the user must be able to be told.
async function deposit(
  identity: WebIdentity,
  host: string,
  uin: number,
  act: ContactReqAct,
  note?: string | null,
): Promise<boolean> {
  const env = buildContactReq(act, await myDisplayName(identity), note)
  // Fall back to the keys pinned when we added them, so an accept still reaches
  // a peer whose island cannot serve its open card right now.
  const known = getCrossIsland(uin, host)
  const localKeys = known ? { identityKey: known.identityKey, signingKey: known.signingKey } : undefined
  return depositSealedToPrimary(identity, host, uin, env, localKeys)
}

/// "I want to add you." Sent from every place the client used to add a
/// cross-island contact silently.
export function sendContactRequest(
  identity: WebIdentity,
  host: string,
  uin: number,
  note?: string | null,
): Promise<boolean> {
  return deposit(identity, host, uin, 'request', note)
}

/// "I accepted you." The half that makes the relationship MUTUAL: without it
/// the accepter holds the requester but not the other way round, and §5d's call
/// gate (and §5e's audience) never opens.
export function sendContactAccept(identity: WebIdentity, host: string, uin: number): Promise<boolean> {
  return deposit(identity, host, uin, 'accept')
}

/// "No." Lets the requester drop their pending row instead of waiting forever.
export function sendContactDecline(identity: WebIdentity, host: string, uin: number): Promise<boolean> {
  return deposit(identity, host, uin, 'decline')
}

/// Apply a received `contactreq` from `senderUin@senderHost`.
///
/// Called from the receive router BEFORE the message quarantine: a contact
/// request is consent metadata, not a message. Quarantining it would hide the
/// very request it exists to ask, and it must never reach the message store.
///
/// Deliberately synchronous and network-free: nothing here fetches a card, so
/// nothing here can write a pinned key.
export function handleContactReq(senderUin: number, senderHost: string, env: ContactReqEnvelope): void {
  // Same-island rule, unchanged: a blocked sender's request is dropped
  // silently. (A removed sender is simply not in the store, so `request`
  // below files them as pending again — the same as any stranger.)
  if (isBlocked(senderUin, senderHost)) return

  const accepted = getCrossIsland(senderUin, senderHost) != null
  // ⚠ Nothing has type-checked this envelope: the receive path is
  // `JSON.parse(...) as Envelope`, so `nickname` can be an object, a number or
  // absent, from a peer who simply wants it to be. `.trim()` on a non-string
  // throws, and the queue drain catches per BATCH, not per row — one hostile
  // deposit would abort the whole drain, every drain, forever. Coerce instead.
  // (iOS gets this from its typed decoder, Android from `isJsonPrimitive`.)
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
  const nickname = str(env.nickname, NICKNAME_MAX)
  const note = str(env.note, CONTACTREQ_NOTE_MAX)

  if (env.act === 'decline') {
    // Silently: they said no, and telling the user "you were declined" is a
    // hostile-peer amplifier, not information. Our local row for them (the
    // pinned keys, any chat) is untouched — only the pending ask goes.
    clearRequest(senderUin, senderHost)
    return
  }

  if (env.act === 'accept') {
    // In this client an entry in the cross-island store IS the accepted state,
    // and we wrote it when the user added them — so the ordinary case is a
    // no-op that simply confirms the mutual relationship §5d checks.
    //
    // An `accept` from someone we never asked is NOT a licence to put them in
    // the roster: that would let any stranger self-add. Degrade it to the
    // pending list, where the user decides.
    if (accepted) return
    addContactRequest(senderUin, senderHost, nickname, note)
    return
  }

  // Anything that is not one of the three §5f acts is from a NEWER client than
  // this one: ignore it and keep the envelope (never throw the whole thing
  // away, never crash). Falling through to the "request" branch would have let
  // a future act — a withdraw, a block — file a pending row that means the
  // opposite of what the sender said. iOS (`default: break`) and Android
  // (`else -> Unit`) already ignore it; this matches them.
  if (env.act !== 'request') return

  // act === "request". Already accepted → a no-op, not a second row.
  if (accepted) return
  addContactRequest(senderUin, senderHost, nickname, note)
}

// Writing to somebody you have never written to.
//
// The mailbox is open by design (UIN culture: anyone may write first, sealed
// sender means the island could not filter by sender anyway) and this does not
// close it. It is about the difference between CHOOSING a stranger and hitting
// one. `/to 396` changed the prompt and said nothing at all; `rcq send` printed
// its note AFTER the message was already gone, which is a receipt, not a
// warning. The founder raised it twice. A uin is a handful of digits, a typo
// costs one keystroke, and the person on the other end is real.
//
// The gate is per THREAD and opens once: a contact, or anybody this account has
// already exchanged a message with, is never asked about again. What is left is
// exactly the cold case, which is the one that is either deliberate or a
// mistake.

import type { WebIdentity } from '../../src/lib/crypto'
import { isContact, lookupUser, peerLabel } from './directory'
import { tr } from './i18n'
import { hasThreadWith } from './receive'

export interface StrangerCheck {
  /// The island answered that there is no such account. Almost always a typo,
  /// and the send would fail later with a raw error anyway.
  missing: boolean
  /// `Vasya (#396)`, or the bare handle when nobody could name them.
  label: string
  /// The warning, ready to print, one line per element.
  lines: string[]
}

/// What must be said before the first message to this uin, or null when there
/// is nothing to say: a contact, or a thread that already exists.
///
/// Costs one /users/{uin}/info in the cold case only, which is also the answer
/// to "who did I just message" that the CLI never had.
export async function strangerCheck(identity: WebIdentity, uin: number): Promise<StrangerCheck | null> {
  if (uin === identity.uin) return null
  if (isContact(identity.uin, uin)) return null
  if (hasThreadWith(identity.uin, uin)) return null
  const got = await lookupUser(identity, uin)
  const label = peerLabel(identity.uin, uin)
  const lines: string[] = []
  if (got.state === 'missing') {
    lines.push(tr('stranger.missing', { uin }))
    return { missing: true, label, lines }
  }
  // The label already carries the name the lookup just found, so there is no
  // second line to spend on it.
  lines.push(tr('stranger.cold', { who: label }))
  if (got.state !== 'known') lines.push(tr('stranger.unverified'))
  lines.push(tr('stranger.reveals'))
  return { missing: false, label, lines }
}

/// Both languages, and the bare Enter of somebody who did not read the line is
/// a no. Asking is left to the caller: a one-shot command opens its own
/// readline on stderr, the interactive loop already holds one.
export function isYes(answer: string): boolean {
  return /^(y|yes|д|да)$/i.test(answer.trim())
}

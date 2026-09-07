// A contact who changed their UIN, and everything of theirs that lives on this
// device under the number they left.
//
// ## What the island actually does
//
// `POST /account/migrate` stands up a NEW `users` row carrying the same
// `identity_key` and `signing_key`, re-keys every uin-bearing row onto the new
// number (`services/uin_rows.PER_UIN_COLUMNS`, which includes
// `contacts.contact_uin` — MY row pointing at THEM) and deletes the old one.
//
// ⚠⚠ NOBODY IS TOLD. The only socket traffic a migration produces is
// `account_burned` to the migrating account's own sessions and a roster nudge
// to their GROUPS. A 1:1 contact of theirs receives nothing at all: the next
// `GET /contacts` simply serves the same person under a different number, and
// there is no field on the wire, anywhere, that says the two are the same
// person. So the client has to work it out, and the only evidence it gets is
// the pair of public keys that the migration copies verbatim.
//
// ## The rule
//
// One row vanished from the roster and one row appeared, both carrying the
// SAME (identity_key, signing_key), and that key pair belongs to exactly one
// row on each side. Anything less certain is left alone.
//
// ⚠⚠ Why "exactly one" and not "the obvious match": a signing key on this
// project is NOT unique per account. `routers/migrate.py` says so on the line
// that copies `identity_created_at` — on the flagship seven keys are held by
// more than one account, one of them by twelve — because a recovery phrase can
// stand up more than one identity. Where a key pair is shared, "they moved"
// and "they added another account and dropped this one" are indistinguishable,
// and guessing wrong files one person's conversation, name and section under
// another person's number. Doing nothing is the recoverable failure; that one
// is not.
//
// ## Why it is a queue and not a function call
//
// The received half of the conversation cannot be moved until the incoming
// store has read itself off IndexedDB (`movePeerHistory` refuses, loudly, for
// the reason written there). The roster refresh that SPOTS the move can easily
// land first. So a detected move is written down, scoped to the account, and
// drained on every refresh until the history half reports done.

import type { Contact } from './api'
import type { WebIdentity } from './crypto'
import { scopedKey } from './account-scope'
import { carryThreadTtl } from './disappearing'
import { carryTheirCard } from './guest-card'
import { movePeerHistory } from './incoming-store'
import { carryContactDeviceState } from './local-store'
import { forgetPeerHomes } from './multihome'
import { carryPeerProfileKey } from './profile-key'
import { moveThreadLog, storageKey } from './outgoing-store'
import { carryReceiptMemory } from './read-receipts'
import { peerKey } from './sections'
import { renameSectionMember } from './sections-vault'

export interface ContactMove {
  from: number
  to: number
  /// When this device noticed. Only used to give up on an entry that can never
  /// be drained (see MAX_PENDING_AGE_MS).
  at: number
  /// Everything except the message history has been carried.
  ///
  /// ⚠ Not an optimisation. An entry can sit in this queue across many roster
  /// refreshes waiting for the incoming store, and `renameSectionMember` WRITES
  /// THE VAULT SLOT every time it is called — unconditionally, by design (the
  /// write-timing note in sections-vault.ts). Re-running the carry on every
  /// refresh would put the sections slot on the wire once a minute for a day
  /// and burn the account's hourly vault budget for nothing.
  carried?: boolean
}

const PENDING_KEY = () => scopedKey('contact.moves.v1')

/// A pending entry is retried on every roster refresh. If the incoming store
/// has still not hydrated a day later, this browser is not going to finish the
/// job and the entry is dropped rather than retried for ever. Everything
/// except the message history has already been carried by then.
const MAX_PENDING_AGE_MS = 24 * 3600 * 1000

/// The pairs this device believes are the same person, from two roster answers.
///
/// `before` must be a roster this device actually held (a persisted snapshot
/// counts); `after` must be a FULL answer, never the rows kept across a 304 —
/// comparing a list against itself finds nothing, which is harmless, but
/// comparing against an empty cold-start list would call the whole roster new.
export function detectContactMoves(before: readonly Contact[], after: readonly Contact[]): ContactMove[] {
  if (before.length === 0 || after.length === 0) return []
  const beforeUins = new Set(before.map((c) => c.uin))
  const afterUins = new Set(after.map((c) => c.uin))

  // Key pair -> the rows holding it, per side. A pair held more than once on
  // either side is ambiguous and is dropped below.
  const index = (rows: readonly Contact[]) => {
    const m = new Map<string, Contact[]>()
    for (const c of rows) {
      if (!c.identity_key || !c.signing_key) continue
      const k = `${c.identity_key}|${c.signing_key}`
      const cur = m.get(k)
      if (cur) cur.push(c)
      else m.set(k, [c])
    }
    return m
  }
  const was = index(before)
  const now = index(after)

  const out: ContactMove[] = []
  for (const [k, appeared] of now) {
    if (appeared.length !== 1) continue
    const vanished = was.get(k)
    if (!vanished || vanished.length !== 1) continue
    const from = vanished[0].uin
    const to = appeared[0].uin
    // The person must have LEFT the old number and ARRIVED at the new one.
    // Both halves matter: a row that is still in the roster has not moved, and
    // a number that was already there is not where anybody arrived.
    if (from === to) continue
    if (afterUins.has(from) || beforeUins.has(to)) continue
    out.push({ from, to, at: Date.now() })
  }
  return out
}

/// Note the moves this refresh found and carry as much as can be carried now.
/// Returns the number of pairs newly recorded (for logging / a toast later).
export function noteContactMoves(
  identity: WebIdentity | null,
  before: readonly Contact[],
  after: readonly Contact[],
): number {
  const found = detectContactMoves(before, after)
  if (found.length > 0) writePending([...readPending(), ...found])
  drainContactMoves(identity)
  return found.length
}

/// Apply everything still outstanding. Safe to call on every refresh: each
/// carry is idempotent, and an entry only leaves the queue once the message
/// history has actually been moved.
export function drainContactMoves(identity: WebIdentity | null): void {
  const pending = readPending()
  if (pending.length === 0) return
  const now = Date.now()
  const kept: ContactMove[] = []
  let changed = false
  for (const move of pending) {
    if (!move.carried) {
      carryEverythingButHistory(identity, move)
      move.carried = true
      changed = true
    }
    const done = movePeerHistory(move.from, move.to)
    if (!done && now - move.at < MAX_PENDING_AGE_MS) kept.push(move)
    else changed = true
  }
  if (changed) writePending(kept)
}

/// Everything that does not need the incoming store to be awake.
///
/// ⚠⚠ ALL OF IT, EVERY TIME. A migration is the one change where a half-fix is
/// worse than none: carrying the name but not the section leaves the person
/// half-recognised, in a list they were deliberately filed out of, and the user
/// has no way to tell which half went missing. So this function is the
/// inventory — if a new per-contact store is added to `lib/`, it belongs here,
/// and the list in the report of 07.09 is what it was checked against.
function carryEverythingButHistory(identity: WebIdentity | null, move: ContactMove): void {
  const { from, to } = move
  // The name I gave them, my favourites, my archive, my mute. All device-only,
  // all keyed by the bare number. This is the founder's report.
  carryContactDeviceState(from, to)
  // The section I filed them in. Lives in the vault, so this write also carries
  // the move to my other devices.
  renameSectionMember(identity, peerKey(from), peerKey(to))
  // My own half of the conversation.
  moveThreadLog(storageKey(false, from), storageKey(false, to))
  // The key that opens their avatar. The island does not hold a copy.
  carryPeerProfileKey(from, to)
  // The thread's disappearing timer, the card they gave me, and what I have
  // already receipted to them.
  carryThreadTtl(from, to)
  carryTheirCard(from, to)
  carryReceiptMemory(from, to)
  // And the one thing that must NOT follow them (see forgetPeerHomes).
  forgetPeerHomes(from)
}

function readPending(): ContactMove[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_KEY()) || '[]') as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (m): m is ContactMove =>
        !!m &&
        typeof m === 'object' &&
        Number.isFinite((m as ContactMove).from) &&
        Number.isFinite((m as ContactMove).to) &&
        (m as ContactMove).from !== (m as ContactMove).to,
    ).map((m) => ({
      from: m.from,
      to: m.to,
      at: Number.isFinite(m.at) ? m.at : Date.now(),
      carried: m.carried === true,
    }))
  } catch {
    return []
  }
}

function writePending(moves: ContactMove[]): void {
  try {
    if (moves.length === 0) localStorage.removeItem(PENDING_KEY())
    else localStorage.setItem(PENDING_KEY(), JSON.stringify(moves))
  } catch {
    /* quota — the carry above already ran; only the history retry is lost */
  }
}

// Same-island stranger quarantine — the founder's «сообщения не от контактов
// помещать в запросы». OPT-IN per account: the mailbox stays open by default
// (UIN culture — anyone may write first), and whoever wants a contact-only
// inbox flips the switch in Privacy.
//
// Held rows ride the SAME sealed store as cross-island requests, with
// `host: ''` marking a same-island entry: the bell badge, the requests page
// and the held-message plumbing all come for free, and a stranger's words are
// sealed at rest exactly like a cross-island stranger's (the ★★ note in
// crossisland-requests.ts).

import { scopedKey } from './account-scope'
import { snapshotFor, contactsCache } from './contacts-cache'
import { loadPersisted, storageKey } from './outgoing-store'

/// Envelope kinds a stranger's quarantine holds. Control traffic (reactions,
/// receipts, edits of nothing we show, visits) from an unknown sender is
/// dropped, not held — there is no message for it to belong to.
const CONTENT_KINDS = new Set(['text', 'photo', 'video', 'file', 'voice', 'location'])

const SETTING = () => scopedKey('strangers.quarantine')
const ALLOWED = () => scopedKey('strangers.allowed')

export function strangerQuarantineEnabled(): boolean {
  return localStorage.getItem(SETTING()) === '1'
}

export function setStrangerQuarantine(on: boolean): void {
  if (on) localStorage.setItem(SETTING(), '1')
  else localStorage.removeItem(SETTING())
}

function loadAllowed(): Set<number> {
  try {
    const arr = JSON.parse(localStorage.getItem(ALLOWED()) || '[]') as number[]
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

/// Accepting a stranger's request means their FUTURE messages flow too.
export function allowStranger(uin: number): void {
  const s = loadAllowed()
  if (s.has(uin)) return
  s.add(uin)
  localStorage.setItem(ALLOWED(), JSON.stringify([...s]))
}

/// Is `uin` in this account's cached contact list? Exported for the
/// missed-call-marker gate in `message-receiver`, which asks the same question
/// the island's `call_policy: "contacts"` asks.
///
/// ⚠ Fails OPEN with no snapshot, which is the right default for both callers:
/// eating messages (or a missed call) because the roster has not loaded yet is
/// worse than letting one through.
export function isContact(myUin: number, uin: number): boolean {
  const snap = contactsCache.get(myUin) ?? snapshotFor(myUin)
  if (!snap) return true // no snapshot at all — fail OPEN, never eat messages blind
  return snap.contacts.some((c) => c.uin === uin)
}

/// Should this decrypted same-island 1:1 envelope go to the requests list
/// instead of the chat? Synchronous — called inside the receive loop.
export function shouldQuarantineStranger(myUin: number, senderUin: number, kind: string): boolean {
  if (!strangerQuarantineEnabled()) return false
  if (senderUin === myUin) return false
  if (!CONTENT_KINDS.has(kind)) return false
  if (loadAllowed().has(senderUin)) return false
  if (isContact(myUin, senderUin)) return false
  // I wrote to them first — their reply is invited, whatever the list says.
  if (loadPersisted(storageKey(false, senderUin)).length > 0) return false
  return true
}

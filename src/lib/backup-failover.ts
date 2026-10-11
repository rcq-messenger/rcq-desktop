// The home-screen line "your island is not answering, messages are arriving
// through your backup island" (Android's `receivingViaBackup`, iOS's
// `BackupFailover`).
//
// Without it a failover is completely silent: the backup poll keeps handing
// over mail while the primary is down, and nothing on screen says the island
// stopped answering, or that the backup can be made primary in Settings.
//
// Raised by the backup poll (message-receiver.tsx) only when ALL of these hold
// in one pass:
//   * the account has a backup home, and at least one of them answered its
//     queue fetch. The line says mail is arriving through it, which is not
//     true of a backup that is down as well;
//   * the browser has a network. Offline, the probe below fails the way a
//     dead island does, and the line would say two untrue things at once;
//   * the primary's socket is not open. An open socket has already answered
//     the question, and a backup pass beside it is only the usual extra copy;
//   * the primary did not answer `/health` over the route requests take right
//     now (the front, when it is engaged). A socket killed by the network
//     while HTTPS still answers is not an island that is down: the HTTP poll
//     delivers in that case, and the line would be wrong.
// Cleared the moment the socket opens, when the browser goes offline, and by
// any pass that finds one of the above no longer true.
//
// ⚠ Keyed by account. Two accounts can hold the same number on two islands,
// and an answer measured for the account being left must never show up on
// the next one, not even for the moment before its first pass.

import type { WebIdentity } from './crypto'

export interface FailoverInputs {
  /// At least one backup home answered its queue fetch in this pass.
  backupAnswered: boolean
  /// `navigator.onLine`, or true where nothing can say.
  online: boolean
  /// The primary island's socket is open right now.
  socketUp: boolean
  /// What the primary's `/health` said over the live route; null when it was
  /// not asked (the socket was up, or the browser was offline).
  primaryAnswered: boolean | null
}

/// Whether the line is up after a pass. Pure, so the rule above is the one
/// that is tested (cli/test/backup-failover.mjs).
export function failoverVerdict(i: FailoverInputs): boolean {
  if (!i.backupAnswered || !i.online || i.socketUp) return false
  return i.primaryAnswered === false
}

/// The account a verdict belongs to: the island and the number on it.
export function failoverAccount(identity: Pick<WebIdentity, 'apiBase' | 'uin'>): string {
  return `${identity.apiBase}#${identity.uin}`
}

let current: { account: string; on: boolean } = { account: '', on: false }
const listeners = new Set<() => void>()

export function setReceivingViaBackup(account: string, on: boolean): void {
  if (current.account === account && current.on === on) return
  // A verdict about another account replaces the old one rather than sitting
  // beside it: switching back later must not find a line left up from before.
  current = { account, on }
  for (const l of listeners) l()
}

export function subscribeFailover(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

/// The snapshot for `useSyncExternalStore`: a primitive, so a re-render never
/// sees a "change" that is only a new object.
export function isReceivingViaBackup(identity: Pick<WebIdentity, 'apiBase' | 'uin'> | null | undefined): boolean {
  if (!identity) return false
  return current.on && current.account === failoverAccount(identity)
}

export function browserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

/// Does the primary answer `/health` over the route requests take right now?
/// The global `fetch` on purpose: the front layer rewrites it when engaged,
/// and an island that answers through the front is not down. Same 2xx rule
/// and the same six seconds as the iOS probe.
export async function primaryAnswers(apiBase: string, timeoutMs = 6000): Promise<boolean> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`${apiBase}/health`, { cache: 'no-store', signal: ctl.signal })
    void res.body?.cancel()
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

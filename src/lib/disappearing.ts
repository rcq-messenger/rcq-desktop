/// Disappearing messages (founder item 20).
///
/// The `ttl` field has been declared on the envelope since the very first
/// version of this client and read by nothing: web and desktop re-encoded it on
/// forward and otherwise ignored it, so a message the SENDER was promised would
/// vanish sat here forever, and neither side was told. `backup-data.ts` even
/// admitted it in a comment while refusing to restore such a row. This module is
/// the missing half.
///
/// ── what a TTL means ──────────────────────────────────────────────────────
/// The sender packs `ttl` (whole seconds) into the encrypted envelope. It is a
/// LOCAL instruction to each device that holds a copy: drop this row once that
/// many seconds have passed. Nothing about it is enforceable (a peer running a
/// modified client keeps whatever it likes), and it is deliberately per-side,
/// the way Apple Messages and iOS `ChatSettingsStore` treat it: my timer decides
/// what MY thread does, and setting one does not reach into the peer's device
/// beyond the `ttl` they choose to honour.
///
/// ── the anchor ────────────────────────────────────────────────────────────
/// ⚠⚠ The countdown runs from when the message was SENT, not from when this
/// device happened to receive it. Anchoring at receipt is a real bug rather
/// than a shortcut: a device that was offline for a week drains the queue and
/// then keeps a "vanishes in 5 minutes" message for five minutes MORE, a week
/// after the author was told it was gone.
///
/// For our own outgoing rows the send time is simply `sentAt`. For an inbound
/// row it has to come off the wire, and the historic envelope carried no
/// timestamp at all: the island's queue rows do not expose one either (no
/// `created_at` on `/messages/queue`). So `ttl` now travels beside `ts`, the
/// sender's epoch SECONDS, exactly the field name and units the `call`,
/// `contactreq` and `profile` envelopes have always used. It rides INSIDE the
/// ciphertext, so it tells the island nothing. All three clients send it and
/// all three prefer it (§6.1.3). A sender that does not (an older build, or a
/// third-party one) falls back to receipt time here, while the phones fall
/// back one tier earlier, to the island's own deposit stamp.

import { scopedKey } from './account-scope'
import { useEffect, useState } from 'react'

/// The choices the UI offers, in the same order and with the same seconds as
/// iOS `ChatSettingsStore.ttlOptions`, so a thread set to "1 hour" on the phone
/// and on the desktop means the same hour. `null` = off.
export const TTL_OPTIONS: ReadonlyArray<{ i18n: string; seconds: number | null }> = [
  { i18n: 'chat.ttl.off', seconds: null },
  { i18n: 'chat.ttl.1m', seconds: 60 },
  { i18n: 'chat.ttl.5m', seconds: 300 },
  { i18n: 'chat.ttl.1h', seconds: 3600 },
  { i18n: 'chat.ttl.24h', seconds: 86_400 },
  { i18n: 'chat.ttl.7d', seconds: 604_800 },
]

/// The i18n key for a stored TTL, or the "off" label. An unknown number (a
/// value some future build wrote) resolves to nothing here and the caller
/// prints the raw seconds rather than a key.
export function ttlLabelKey(ttl: number | null): string | null {
  return TTL_OPTIONS.find((o) => o.seconds === ttl)?.i18n ?? null
}

/// `peer:<uin>` / `group:<id>`: the same thread key shape iOS uses, chosen over
/// this client's own `outgoing.peer.<uin>` storage key so the two clients can be
/// read side by side while debugging a thread.
export function ttlThreadKey(isGroup: boolean, id: number): string {
  return `${isGroup ? 'group' : 'peer'}:${id}`
}

/// ⚠ A FUNCTION, not a module constant. `scopedKey` reads the account scope that
/// `setAccountScope` installs during boot, and a key captured at module-eval
/// time is captured before that runs: the counts (and here, the timers) of one
/// account would be written under the flat namespace and then read by the next
/// account to sign in. This client has already paid for that mistake once, in
/// `account-scope.ts`'s own header.
const KEY = () => scopedKey('chat.ttl')

type Stored = Record<string, number>

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY())
    if (!raw) return {}
    const obj = JSON.parse(raw) as unknown
    return obj && typeof obj === 'object' ? (obj as Stored) : {}
  } catch {
    return {}
  }
}

/// The live timer for a thread, or null when disappearing is off there.
export function threadTtl(threadKey: string): number | null {
  const v = read()[threadKey]
  return typeof v === 'number' && v > 0 ? v : null
}

/// Set or clear a thread's timer. `null` (or anything non-positive) turns it off
/// and REMOVES the entry rather than storing a zero: "off" and "never touched"
/// are the same state here and should not be two shapes on disk.
export function setThreadTtl(threadKey: string, ttl: number | null): void {
  const cur = read()
  if (ttl != null && ttl > 0) cur[threadKey] = Math.floor(ttl)
  else delete cur[threadKey]
  try {
    localStorage.setItem(KEY(), JSON.stringify(cur))
  } catch {
    /* quota: the timer is a preference, not state anything depends on */
  }
  // Same-document writes do not fire `storage`, so the hook below would not see
  // our own change. Mirrors `emoticon-choices.ts`.
  window.dispatchEvent(new StorageEvent('storage', { key: KEY() }))
}

/// Reactive read of one thread's timer.
export function useThreadTtl(threadKey: string | null): number | null {
  const [, setTick] = useState(0)
  useEffect(() => {
    const key = KEY()
    const handler = (e: StorageEvent) => {
      if (e.key === key || e.key == null) setTick((n) => n + 1)
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])
  return threadKey ? threadTtl(threadKey) : null
}

/// Absolute epoch-ms deadline for a row, or undefined when it never expires.
/// `anchorMs` is the SEND time (see the header).
export function expiryFrom(ttlSeconds: number | null | undefined, anchorMs: number): number | undefined {
  if (ttlSeconds == null || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return undefined
  return anchorMs + Math.floor(ttlSeconds) * 1000
}

/// The send time to count from, given whatever the envelope carried.
///
/// `ts` is epoch SECONDS. Two sanity rails, because it is attacker-controlled:
/// a `ts` in the future would extend the life of the message past what the
/// sender claimed, and a `ts` from 1970 (a client sending milliseconds, or
/// zero) would make every message expire on arrival. Outside the window we fall
/// back to receipt, which is the honest "we do not know".
export function sendAnchorMs(ts: unknown, receivedMs: number): number {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return receivedMs
  const ms = Math.floor(ts) * 1000
  if (ms > receivedMs + 60_000) return receivedMs
  // A year is far past any TTL we offer; anything older is not a clock skew.
  if (ms < receivedMs - 365 * 24 * 3600 * 1000) return receivedMs
  return ms
}

/// Has this row's deadline passed? Rows with no deadline never expire.
export function lapsed(expiresAt: number | null | undefined, now: number = Date.now()): boolean {
  return expiresAt != null && expiresAt <= now
}

/// How long is left, as the "1h", "4m", "12s" shorthand both phones print
/// beside a disappearing message. Never negative; a lapsed row is swept rather
/// than drawn, so this is only ever read for a row that still exists.
export function remainingLabel(expiresAt: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  if (secs >= 86_400) return `${Math.ceil(secs / 86_400)}d`
  if (secs >= 3600) return `${Math.ceil(secs / 3600)}h`
  if (secs >= 60) return `${Math.ceil(secs / 60)}m`
  return `${secs}s`
}

/// How often the sweepers run. Short enough that a one-minute timer is honest
/// on screen, long enough to be free: the work is a filter over arrays already
/// in memory and it exits without touching the disk when nothing lapsed.
export const SWEEP_INTERVAL_MS = 10_000

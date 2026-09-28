/// The two keys a v=1 seal to a peer needs (identity + signing), without asking
/// the island every time.
///
/// ⚠⚠ Why this exists. The v=1 fallback of every delivered receipt and read
/// receipt, and the answer to a `pkeyask`, each read `/users/{uin}/info` afresh,
/// once per call. A drain after a night offline is dozens of calls, often for
/// the same few people, all at once; and a card read is exactly the request
/// that exhausted the island's database pool on 28.09 (24 stalls of 2 to 11
/// minutes in 30 days). So:
///
///   1. the roster first. An accepted contact's keys are already on this
///      device, and they are the same column the card would serve. Android's
///      `recipientKey` has always sealed to the roster first.
///   2. otherwise one read per peer per ten minutes, shared by every caller
///      that asks while it is on the wire, and queued per island with every
///      other peer lookup (api.ts limitPeerLookup).
///   3. a read that found nothing is believed for thirty seconds, so a failing
///      island is not asked once per queued receipt. What rides on this is a
///      tick or a face, never a message: a caller that gets null simply sends
///      nothing, exactly as it did when the read failed.
///
/// Keyed by island, account and peer, so neither a visited island nor another
/// account on this browser is ever handed the wrong person's keys.

import { Api } from './api'
import { contactsCache, snapshotFor } from './contacts-cache'
import { theirCard } from './guest-card'
import type { WebIdentity } from './crypto'

export interface SealKeys {
  identity_key: string
  signing_key: string
}

/// One answer per key at a time, kept for as long as `ttlFor` says. Generic so
/// the rule can be tested on its own (cli/test/peer-lookup.mjs).
export class PeerCache<V> {
  private held = new Map<string, { until: number; value: V }>()
  private flights = new Map<string, Promise<V>>()

  constructor(
    private readonly ttlFor: (value: V) => number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.held.get(key)
    if (hit && hit.until > this.now()) return Promise.resolve(hit.value)
    const running = this.flights.get(key)
    if (running) return running
    const flight = load()
      .then((value) => {
        this.remember(key, value)
        return value
      })
      .finally(() => {
        this.flights.delete(key)
      })
    this.flights.set(key, flight)
    return flight
  }

  clear(): void {
    this.held.clear()
    this.flights.clear()
  }

  private remember(key: string, value: V): void {
    const now = this.now()
    // Expired rows are dropped as the map grows, so a long session that talks
    // to many people once each does not keep all of them.
    if (this.held.size >= 256) {
      for (const [k, row] of this.held) if (row.until <= now) this.held.delete(k)
    }
    this.held.set(key, { until: now + this.ttlFor(value), value })
  }
}

const FOUND_TTL_MS = 10 * 60_000
const MISSING_TTL_MS = 30_000

const lookups = new PeerCache<SealKeys | null>((v) => (v ? FOUND_TTL_MS : MISSING_TTL_MS))

/// The keys to seal a v=1 copy to `uin` on `identity`'s island, or null when
/// neither the roster nor the island has them.
export async function peerSealKeys(identity: WebIdentity, uin: number): Promise<SealKeys | null> {
  const roster = contactsCache.get(identity.uin)?.contacts ?? snapshotFor(identity.uin)?.contacts
  // ⚠ Same-island rows only: a row with a host is a number on ANOTHER island,
  // and the same digits here are somebody else.
  const row = roster?.find((c) => c.uin === uin && !c.host)
  if (row?.identity_key && row.signing_key) {
    return { identity_key: row.identity_key, signing_key: row.signing_key }
  }
  return lookups.get(`${identity.apiBase}|${identity.uin}|${uin}`, async () => {
    const info = await Api.userInfo(identity, uin, theirCard(uin)).catch(() => null)
    return info?.identity_key && info.signing_key
      ? { identity_key: info.identity_key, signing_key: info.signing_key }
      : null
  })
}

/// On leaving an account, beside clearGroupPreviewCache. The keys are already
/// scoped to account and island and the page reloads; this keeps it true if
/// either of those changes.
export function clearPeerSealKeys(): void {
  lookups.clear()
}

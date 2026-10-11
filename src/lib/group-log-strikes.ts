// The strike ledgers of the receive drains, on disk (report 981).
//
// group-log.ts counts, per row, the consecutive drains it failed on, and acks
// it past as unreadable once the count is up. In memory that count died with
// the tab: open the app for a minute, one or two drains, reload, start again
// from one. A row that never opens then held its room until the island's log
// dropped it, thirty days on. So the web keeps it in localStorage, per
// account, one ledger per (island, number, lane): the room log of the primary
// island, its legacy queue, and the room logs of the backup and visited
// islands, each under its own scope.
//
// Only what is the row's fault is ever counted (group-log.ts,
// notTheRowsFault), which is what makes keeping it across boots safe: three
// boots without a libsignal device are no strike at all.
//
// ⚠ Per-viewer convenience storage, nothing more. Unreadable or full, it
// falls back to the copy in memory, which is exactly the old behaviour; and
// the keys are `rcq.web.<uin>.…`, so signing out wipes them with the account.

import { scopedKey } from './account-scope'
import type { StrikeEntry, StrikeStore } from './group-log'

const storageKey = () => scopedKey('glstrikes.v1')

/// The last ledger each scope wrote, for when localStorage will not answer.
const inMemory = new Map<string, Record<string, StrikeEntry>>()
/// Set once a write was refused (quota, a blocked store): from then on this
/// page reads its own copy, which is newer than whatever the disk kept.
let diskRefused = false

function sanitize(raw: unknown): Record<string, StrikeEntry> {
  const out: Record<string, StrikeEntry> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const e = v as Partial<StrikeEntry> | null
    if (!e || typeof e.sig !== 'string' || typeof e.n !== 'number' || !Number.isFinite(e.n)) continue
    out[k] = typeof e.any === 'number' && Number.isFinite(e.any) ? { sig: e.sig, n: e.n, any: e.any } : { sig: e.sig, n: e.n }
  }
  return out
}

function readAll(): Record<string, unknown> {
  const raw = JSON.parse(localStorage.getItem(storageKey()) || '{}') as unknown
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
}

/// The ledger of one drain: `apiBase` and `uin` as the drain is keyed (the
/// guest number on a visited island), `lane` telling the room log from the
/// legacy queue of the same mailbox.
export function localStrikeStore(apiBase: string, uin: number, lane: 'log' | 'queue' = 'log'): StrikeStore {
  const scope = `${apiBase}#${uin}#${lane}`
  return {
    read: () => {
      if (!diskRefused) {
        try {
          return sanitize(readAll()[scope])
        } catch {
          /* unreadable: the copy in memory below */
        }
      }
      return { ...(inMemory.get(scope) ?? {}) }
    },
    write: (strikes) => {
      inMemory.set(scope, { ...strikes })
      let all: Record<string, unknown> = {}
      try {
        all = readAll()
      } catch {
        /* not JSON any more: written over whole below */
      }
      try {
        if (Object.keys(strikes).length > 0) all[scope] = strikes
        else delete all[scope]
        if (Object.keys(all).length > 0) localStorage.setItem(storageKey(), JSON.stringify(all))
        else localStorage.removeItem(storageKey())
      } catch {
        diskRefused = true
      }
    },
  }
}

// The last nickname each group member was seen under (#982).
//
// The island deletes a membership row outright when somebody leaves, so the
// roster stops knowing their name the moment they walk out, and every message
// they ever wrote in the room fell back to their number. This keeps what the
// rosters showed: every roster fetch adds or overwrites (newest name wins), and
// nothing is removed because somebody left. The resolution order lives in
// `member-name.ts`.
//
// Keyed by (island host, group id on that island, uin). A uin is per island,
// and a foreign group's id here is a local alias the island has never heard of,
// so the key is the island's own id under the island's own host.
//
// Stored like the received history: one IndexedDB row per group, sealed under
// the desktop PIN when there is one (`pin-seal.ts` sweeps the `gnames:` prefix
// with the history). The rows go when the user leaves or deletes the group, and
// with everything else on sign-out (`idbClearAll`) or an account wipe.
//
// ⚠ A roster can be two thousand people and is re-fetched often. Nothing is
// written unless a name actually changed, the write is batched on a timer and
// handed to an idle slot, and IndexedDB does the disk work off the main thread.

import { useEffect, useSyncExternalStore } from 'react'
import { onRosterFetched, type GroupMember } from './api'
import { onAccountWipe } from './auth'
import { openValue, sealValue } from './pin-seal'
import { idbDel, idbGet, idbKeys, idbSet } from './signal-persist'

const PREFIX = 'gnames:'

const names = new Map<string, Map<number, string>>()
const loading = new Map<string, Promise<Map<number, string> | null>>()
/// Bumped by a leave/delete of that group, so a load or a note that was in
/// flight when the group was forgotten does not put the names back.
const epochs = new Map<string, number>()
let generation = 0

let version = 0
const listeners = new Set<() => void>()
function bump() {
  version++
  for (const fn of listeners) fn()
}

/// `host|gid`. `host` is the island's host as the API base names it; a foreign
/// group passes the host it was joined on.
export function groupNamesScope(apiBase: string, gid: number, host?: string | null): string {
  let h = host ?? ''
  if (!h) {
    try {
      h = new URL(apiBase).host
    } catch {
      h = apiBase
    }
  }
  return `${h.toLowerCase()}|${gid}`
}

function epochOf(scope: string): number {
  return epochs.get(scope) ?? 0
}

/// This group's map, read from disk the first time it is asked for. Null when
/// the group was forgotten while the read was in flight.
function load(scope: string): Promise<Map<number, string> | null> {
  const hit = names.get(scope)
  if (hit) return Promise.resolve(hit)
  const pending = loading.get(scope)
  if (pending) return pending
  const ep = epochOf(scope)
  const gen = generation
  const p = idbGet<unknown>(PREFIX + scope)
    .then((stored) => openValue<Record<string, string>>(stored))
    .catch(() => undefined)
    .then((saved) => {
      loading.delete(scope)
      if (ep !== epochOf(scope) || gen !== generation) return null
      const map = new Map<number, string>()
      if (saved && typeof saved === 'object') {
        for (const [k, v] of Object.entries(saved)) {
          const uin = Number(k)
          if (Number.isFinite(uin) && typeof v === 'string' && v.trim() !== '') map.set(uin, v)
        }
      }
      names.set(scope, map)
      if (map.size > 0) bump()
      return map
    })
  loading.set(scope, p)
  return p
}

/// Fold a fetched roster in. Cheap when nothing changed: one comparison per
/// member and no write.
export function noteRoster(scope: string, members: ReadonlyArray<Pick<GroupMember, 'uin' | 'nickname'>>) {
  if (members.length === 0) return
  void load(scope).then((map) => {
    if (!map || names.get(scope) !== map) return
    let changed = false
    for (const m of members) {
      const nick = m.nickname
      if (typeof nick !== 'string' || nick.trim() === '') continue
      if (map.get(m.uin) !== nick) {
        map.set(m.uin, nick)
        changed = true
      }
    }
    if (!changed) return
    bump()
    scheduleWrite(scope)
  })
}

export function lastKnownName(scope: string, uin: number): string | undefined {
  return names.get(scope)?.get(uin)
}

/// The user left or deleted the group: its names go with it.
export function forgetGroupNames(scope: string) {
  epochs.set(scope, epochOf(scope) + 1)
  names.delete(scope)
  loading.delete(scope)
  dirty.delete(scope)
  bump()
  void writeChain.then(() => idbDel(PREFIX + scope)).catch(() => {})
}

const dirty = new Set<string>()
let writeTimer: ReturnType<typeof setTimeout> | null = null
let writeChain: Promise<void> = Promise.resolve()

function writeDirty(): Promise<void> {
  const scopes = [...dirty]
  dirty.clear()
  for (const scope of scopes) {
    const map = names.get(scope)
    if (!map) continue
    const ep = epochOf(scope)
    const gen = generation
    const snapshot = Object.fromEntries(map)
    // Chained, so an older snapshot of the same group can never land last.
    writeChain = writeChain
      .then(() => sealValue(snapshot))
      .then((stored) => {
        if (ep !== epochOf(scope) || gen !== generation) return
        return idbSet(PREFIX + scope, stored)
      })
      .catch(() => {})
  }
  return writeChain
}

function scheduleWrite(scope: string) {
  dirty.add(scope)
  if (writeTimer) return
  writeTimer = setTimeout(() => {
    writeTimer = null
    const run = () => void writeDirty()
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
      .requestIdleCallback
    if (idle) idle(run, { timeout: 3000 })
    else run()
  }, 2000)
}

// A closing tab gets no second chance at the scheduled write.
if (typeof document !== 'undefined') {
  const flushOnHide = () => {
    if (!writeTimer) return
    clearTimeout(writeTimer)
    writeTimer = null
    void writeDirty()
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushOnHide()
  })
  window.addEventListener('pagehide', flushOnHide)
}

// Every roster the app fetches passes through here, whichever screen asked.
onRosterFetched((ident, gid, members) => {
  noteRoster(groupNamesScope(ident.apiBase, gid), members)
})

// Sign-out clears the whole database with `idbClearAll`; this covers the
// memory, and the wipes that do not come with that call.
onAccountWipe(() => {
  generation++
  names.clear()
  loading.clear()
  dirty.clear()
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  bump()
  void idbKeys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX)).map((k) => idbDel(k))))
    .catch(() => {})
})

/// Load this group's names and re-render when they change. Returns a counter
/// to put in memo dependencies.
export function useGroupNames(scope: string | null): number {
  useEffect(() => {
    if (scope) void load(scope)
  }, [scope])
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => version,
    () => 0,
  )
}

// Per-device contact-list state — favorites, archive, mute. iOS
// keeps these in UserDefaults via FavoritesStore / ArchiveStore /
// ChatSettingsStore; web mirrors the same model in localStorage.
// Server has no idea (the contact graph itself is server-stored,
// but UX state is private to this device).
//
// Keyed sets are persisted as JSON arrays so future migration to
// IndexedDB is a one-line read-fn swap. Each helper exposes
// React-ready hooks that subscribe to the underlying storage and
// re-render on change — across-tab sync via the native `storage`
// event.

import { useEffect, useState, useSyncExternalStore } from 'react'
import { accountScope, scopedKey } from './account-scope'

const KEYS = {
  favorites: 'rcq.web.favorites',
  archive: 'rcq.web.archive',
  favoriteGroups: 'rcq.web.favorites.groups',
  archiveGroups: 'rcq.web.archive.groups',
  mutedPeers: 'rcq.web.muted.peers',
  mutedGroups: 'rcq.web.muted.groups',
  aliases: 'rcq.web.contacts.aliases', // my own name for a contact, uin -> name
}

function readSet(key: string): Set<number> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as number[]
    return new Set(arr)
  } catch {
    return new Set()
  }
}

function writeSet(key: string, s: Set<number>) {
  localStorage.setItem(key, JSON.stringify([...s]))
  // Cross-tab sync — `storage` event fires for OTHER tabs only,
  // so we also dispatch a custom event in-tab so the same tab's
  // listeners pick up the change immediately.
  window.dispatchEvent(new StorageEvent('storage', { key }))
}

// Generic React hook that subscribes to a localStorage key and
// returns the current Set<number> + mutation helpers. Re-renders
// every consumer when any helper writes.
function useNumberSet(key: string) {
  const subscribe = (cb: () => void) => {
    const handler = (e: StorageEvent) => {
      if (e.key === key || e.key == null) cb()
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }
  const get = () => localStorage.getItem(key) ?? ''
  // useSyncExternalStore replays the value synchronously on every
  // mount; we materialise the Set lazily once per render.
  const snapshot = useSyncExternalStore(subscribe, get, () => '')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const set = (() => {
    try {
      return new Set<number>(snapshot ? (JSON.parse(snapshot) as number[]) : [])
    } catch {
      return new Set<number>()
    }
  })()

  return {
    has: (id: number) => set.has(id),
    set,
    add: (id: number) => {
      const s = readSet(key)
      s.add(id)
      writeSet(key, s)
    },
    remove: (id: number) => {
      const s = readSet(key)
      s.delete(id)
      writeSet(key, s)
    },
    toggle: (id: number) => {
      const s = readSet(key)
      if (s.has(id)) s.delete(id)
      else s.add(id)
      writeSet(key, s)
    },
  }
}

/// My own name for a contact, keyed by UIN. DEVICE-ONLY on purpose: what I
/// chose to call someone says more about the relationship than the contact row
/// does, it serves no server-side function, and an island that stores it is an
/// island that can be made to hand it over. The cost is honest — aliases do not
/// follow you to another device until the backup does.
export function useContactAliases() {
  const subscribe = (cb: () => void) => {
    const handler = (e: StorageEvent) => {
      if (e.key === KEYS.aliases || e.key == null) cb()
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }
  const get = () => localStorage.getItem(KEYS.aliases) ?? ''
  const snapshot = useSyncExternalStore(subscribe, get, () => '')
  let map: Record<string, string> = {}
  try {
    map = snapshot ? (JSON.parse(snapshot) as Record<string, string>) : {}
  } catch {
    map = {}
  }
  return {
    aliasFor: (uin: number, host?: string | null): string | undefined => map[aliasKey(uin, host)],
    setAlias: (uin: number, name: string | null, host?: string | null) => {
      let cur: Record<string, string> = {}
      try {
        cur = JSON.parse(localStorage.getItem(KEYS.aliases) ?? '{}') as Record<string, string>
      } catch {
        cur = {}
      }
      const trimmed = name?.trim().slice(0, 48)
      const k = aliasKey(uin, host)
      if (trimmed) cur[k] = trimmed
      else delete cur[k]
      localStorage.setItem(KEYS.aliases, JSON.stringify(cur))
      window.dispatchEvent(new StorageEvent('storage', { key: KEYS.aliases }))
    },
  }
}

/// ⚠ A uin is per-island, so `1234` on our island and `1234@is2.rcq.app` are
/// two different people. Keying an alias by the bare number gave them one
/// name between them: rename the stranger and your friend was renamed too.
/// Local contacts keep the bare key so every alias already saved survives.
function aliasKey(uin: number, host?: string | null): string {
  return host ? `${uin}@${host.toLowerCase()}` : String(uin)
}

/// The same lookup for code that is not a component. Message bodies are built
/// by a plain function (mentions, invites, links), and a mention that showed the
/// nick while the bubble above it showed my alias for the same person read as a
/// bug in the alias rather than as two names for the same person.
export function contactAlias(uin: number, host?: string | null): string | undefined {
  try {
    const map = JSON.parse(localStorage.getItem(KEYS.aliases) ?? '{}') as Record<string, string>
    return map[aliasKey(uin, host)]
  } catch {
    return undefined
  }
}

export function useFavorites() {
  return useNumberSet(KEYS.favorites)
}

export function useArchive() {
  return useNumberSet(KEYS.archive)
}

export function useMutedPeers() {
  return useNumberSet(KEYS.mutedPeers)
}

export function useMutedGroups() {
  return useNumberSet(KEYS.mutedGroups)
}

// Group-scoped favorite / archive — kept separate from the contact sets so a
// group id can never collide with a contact UIN.
export function useFavoriteGroups() {
  return useNumberSet(KEYS.favoriteGroups)
}

export function useArchiveGroups() {
  return useNumberSet(KEYS.archiveGroups)
}

// -----------------------------------------------------------
// Section collapse state — single string set, not numbers.
// -----------------------------------------------------------

/// Section ids the user collapsed.
///
/// ⚠ SCOPED BY ACCOUNT, like `sections.v1` next door. The ids in it name THIS
/// account's sections (the tree they come from is per account), so on a flat key
/// two accounts in one browser folded each other's list: collapse a section on
/// one and a section the other does not even have came back folded. Built on
/// every call, never captured at module load, because the scope is installed
/// during boot.
const collapsedKey = () => scopedKey('contacts.collapsed')

/// Where the set lived before it was scoped. Moved onto whichever account is
/// open and then dropped, rather than discarded: the value says nothing about
/// who collapsed what, so the account signed in when this update lands claims
/// it, the same rule the outgoing logs follow in account-scope.ts. Throwing it
/// away instead would unfold every section for everybody on upgrade.
const FLAT_COLLAPSED_KEY = 'rcq.web.contacts.collapsed'
let flatCollapsedMoved = false

function migrateFlatCollapsed(): void {
  // With no account scope yet `collapsedKey()` IS the flat key, and moving a key
  // onto itself would delete it.
  if (flatCollapsedMoved || accountScope() == null) return
  flatCollapsedMoved = true
  try {
    const flat = localStorage.getItem(FLAT_COLLAPSED_KEY)
    if (flat == null) return
    const key = collapsedKey()
    // Never overwrite: a scoped value is this account's own answer, newer than
    // anything from the pre-scope world.
    if (localStorage.getItem(key) == null) localStorage.setItem(key, flat)
    localStorage.removeItem(FLAT_COLLAPSED_KEY)
  } catch {
    /* storage denied: a fold preference is not worth throwing over */
  }
}

export function useCollapsedSections(): {
  has: (id: string) => boolean
  toggle: (id: string) => void
} {
  const [, setTick] = useState(0)
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === collapsedKey() || e.key == null) setTick((t) => t + 1)
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])

  const read = (): Set<string> => {
    migrateFlatCollapsed()
    try {
      const raw = localStorage.getItem(collapsedKey())
      if (!raw) return new Set()
      return new Set(JSON.parse(raw) as string[])
    } catch {
      return new Set()
    }
  }
  const write = (s: Set<string>) => {
    localStorage.setItem(collapsedKey(), JSON.stringify([...s]))
    window.dispatchEvent(new StorageEvent('storage', { key: collapsedKey() }))
  }

  const cur = read()
  return {
    has: (id) => cur.has(id),
    toggle: (id) => {
      const s = read()
      if (s.has(id)) s.delete(id)
      else s.add(id)
      write(s)
    },
  }
}

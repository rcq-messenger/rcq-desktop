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

const KEYS = {
  favorites: 'rcq.web.favorites',
  archive: 'rcq.web.archive',
  favoriteGroups: 'rcq.web.favorites.groups',
  archiveGroups: 'rcq.web.archive.groups',
  mutedPeers: 'rcq.web.muted.peers',
  mutedGroups: 'rcq.web.muted.groups',
  collapsed: 'rcq.web.contacts.collapsed', // section ids the user collapsed
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

export function useCollapsedSections(): {
  has: (id: string) => boolean
  toggle: (id: string) => void
} {
  const [, setTick] = useState(0)
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === KEYS.collapsed || e.key == null) setTick((t) => t + 1)
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])

  const read = (): Set<string> => {
    try {
      const raw = localStorage.getItem(KEYS.collapsed)
      if (!raw) return new Set()
      return new Set(JSON.parse(raw) as string[])
    } catch {
      return new Set()
    }
  }
  const write = (s: Set<string>) => {
    localStorage.setItem(KEYS.collapsed, JSON.stringify([...s]))
    window.dispatchEvent(new StorageEvent('storage', { key: KEYS.collapsed }))
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

// The cached sections tree, and the hooks over it.
//
// Same shape as local-store.ts: one localStorage key, a `storage` event for
// cross-tab sync (dispatched in-tab too, because the native event only fires
// for OTHER tabs), and `useSyncExternalStore` so every consumer repaints on a
// write. The tree itself is the vault's, not this device's: sections-vault.ts
// folds the island's copy into this cache and pushes local edits back out.
//
// ⚠⚠ SCOPED BY ACCOUNT, unlike the favorites/archive keys next door. This
// cache holds section names and the uin of every filed chat, so a flat key
// would hand one account's list to the next one that signs in here. That is
// the bug account-scope.ts was written for, and the cross-island store was the
// last file to be caught by it. `scopedKey` is read at call time, which means
// the store is only ever bound AFTER `setAccountScope` has run.
//
// The collapse set (KEYS.collapsed in local-store.ts) stays device-local and
// picks up the new section ids for free: a section collapsed on the desktop is
// not collapsed on the phone, which is the right answer for a per-screen view
// preference.

import { useSyncExternalStore } from 'react'
import { scopedKey } from './account-scope'
import { emptyTree, type SectionsTree } from './sections'

const KEY = () => scopedKey('sections.v1')

/// Bumped whenever a write lands, so `useSections` can key its parse on
/// something cheap instead of comparing trees.
const EVENT = 'rcq.sections'

export function loadSectionsTree(): SectionsTree {
  return parse(readRaw())
}

export function saveSectionsTree(tree: SectionsTree): void {
  try {
    localStorage.setItem(KEY(), JSON.stringify(tree))
  } catch {
    /* storage full or denied: the tree stays in the island's copy */
  }
  notify()
}

/// Sign-out / account burn. The tree is a copy of the vault slot, so dropping
/// it costs nothing but a re-read.
export function wipeSectionsCache(): void {
  try {
    localStorage.removeItem(KEY())
  } catch {
    /* nothing to drop */
  }
  notify()
}

function readRaw(): string {
  try {
    return localStorage.getItem(KEY()) ?? ''
  } catch {
    return ''
  }
}

function parse(raw: string): SectionsTree {
  if (!raw) return emptyTree()
  try {
    const j = JSON.parse(raw) as SectionsTree
    if (j && j.v === 1 && Array.isArray(j.s)) return j
  } catch {
    /* fall through */
  }
  return emptyTree()
}

function notify() {
  window.dispatchEvent(new StorageEvent('storage', { key: EVENT }))
}

function subscribe(cb: () => void) {
  const handler = (e: StorageEvent) => {
    if (e.key === EVENT || e.key === KEY() || e.key == null) cb()
  }
  window.addEventListener('storage', handler)
  return () => window.removeEventListener('storage', handler)
}

/// The tree, live. Parsed once per change rather than once per render: the
/// snapshot is the raw string (a stable primitive, which is what
/// useSyncExternalStore wants) and the parse is memoised beside it.
let lastRaw = ''
let lastTree: SectionsTree = emptyTree()

export function useSections(): SectionsTree {
  const raw = useSyncExternalStore(subscribe, readRaw, () => '')
  if (raw !== lastRaw) {
    lastRaw = raw
    lastTree = parse(raw)
  }
  return lastTree
}

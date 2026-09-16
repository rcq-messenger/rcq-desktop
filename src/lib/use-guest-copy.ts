// The hook half of guest-copy.ts: whether the signed-in account is a guest copy
// (spec 2026-09-15, 12.1), re-read when auth.ts records a new answer.
//
// ⚠ Subscribes to an event and reads a primitive, so no object identity can
// feed an effect dependency and loop (the React effect-dependency trap).

import { useSyncExternalStore } from 'react'
import { GUEST_COPY_EVENT, isPrimaryGuest } from './guest-copy'

function subscribe(onChange: () => void): () => void {
  window.addEventListener(GUEST_COPY_EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(GUEST_COPY_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

export function usePrimaryGuest(identity: { apiBase: string; uin: number } | null | undefined): boolean {
  const apiBase = identity?.apiBase ?? ''
  const uin = identity?.uin ?? 0
  return useSyncExternalStore(
    subscribe,
    () => (apiBase ? isPrimaryGuest({ apiBase, uin }) : false),
    () => false,
  )
}

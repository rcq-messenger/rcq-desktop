// Minimal session context — holds the active WebIdentity (or null
// when unlinked) and the setter to swap it. Avoids prop-drilling
// through Login → Contacts → Chat. Components that need the
// identity grab it via `useIdentity()`.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { WebIdentity } from './crypto'
import { clearIdentity, loadStoredIdentity, wipeLocalAccountData } from './auth'
import { setUnauthorizedHandler } from './api'
import { idbClearAll } from './signal-persist'

interface IdentityCtx {
  identity: WebIdentity | null
  setIdentity: (id: WebIdentity | null) => void
  signOut: () => void
}

const Ctx = createContext<IdentityCtx | undefined>(undefined)

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<WebIdentity | null>(null)
  const [hydrated, setHydrated] = useState(false)

  // One-shot rehydrate from localStorage on first mount. Until it
  // finishes we render nothing — Routes downstream gate on this.
  useEffect(() => {
    setIdentity(loadStoredIdentity())
    setHydrated(true)
  }, [])

  // Any 401 from an authed API call means this web session was revoked
  // (the phone unlinked it) or expired. Drop the identity so the app
  // routes straight back to login instead of showing a raw
  // "401: device revoked" error — both live (on the next request after
  // an unlink) and on a hard reload with a now-dead token.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearIdentity()
      setIdentity(null)
    })
    return () => setUnauthorizedHandler(null)
  }, [])

  const value = useMemo<IdentityCtx>(
    () => ({
      identity,
      setIdentity,
      // Sign-out / unlink: wipe ALL account-scoped local data (identity,
      // per-thread message logs, contacts state, device keys + decrypted
      // history in IndexedDB), then HARD-reload to '/'. The reload is the
      // bulletproof part — it drops every module-level in-memory cache
      // (incoming store, signal-device, contacts, peer targets, media
      // URLs) so a freshly created account starts truly clean. Without
      // this a new account inherited the old one's messages.
      signOut: () => {
        clearIdentity()
        wipeLocalAccountData()
        void idbClearAll().finally(() => {
          window.location.assign('/')
        })
      },
    }),
    [identity],
  )

  if (!hydrated) return null
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useIdentity(): IdentityCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useIdentity called outside IdentityProvider')
  return v
}

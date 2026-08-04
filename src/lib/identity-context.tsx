// Minimal session context — holds the active WebIdentity (or null
// when unlinked) and the setter to swap it. Avoids prop-drilling
// through Login → Contacts → Chat. Components that need the
// identity grab it via `useIdentity()`.

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { WebIdentity } from './crypto'
import {
  adoptMigratedUin,
  claimInstallToken,
  clearIdentity,
  loadStoredIdentity,
  persistIdentity,
  wipeLocalAccountData,
} from './auth'
import { Api, setUnauthorizedHandler } from './api'
import { idbClearAll } from './signal-persist'

interface IdentityCtx {
  identity: WebIdentity | null
  setIdentity: (id: WebIdentity | null) => void
  signOut: () => void
  /// Call BEFORE asking the server to change this account's UIN, and pair it
  /// with endMigration() if the request fails. It shields the browser from
  /// its own migration — see the `migrating` ref below.
  beginMigration: () => void
  endMigration: () => void
  /// Adopt a server-confirmed UIN migration (took a number and moved onto it,
  /// or switched to one already held) and hard-reload under it. Use this
  /// rather than setIdentity + a reload of your own.
  adoptMigration: (newUin: number, token: string, to?: string) => void
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

  // Name this browser to the server once. A session minted before the client
  // sent an install id keys as "primary" — the name every other install of the
  // account uses — so a phone and a browser recovered onto the SAME account
  // supersede each other's websocket and share one offline-queue cursor.
  // Only the token changes, so no reload: whoever holds the old jwt in a
  // closure is holding a session that still works.
  const claimedRef = useRef(false)
  useEffect(() => {
    if (!identity || claimedRef.current) return
    claimedRef.current = true
    void claimInstallToken(identity).then((jwt) => {
      if (!jwt) return
      const next = { ...identity, jwt }
      persistIdentity(next)
      setIdentity(next)
    })
  }, [identity])

  // A UIN migration by THIS tab is in flight. Two things arrive during it
  // that otherwise read as "this session is over", and both would throw away
  // an account that is perfectly alive on the server:
  //
  //  * 401 — every token for the OLD number is retired the moment the swap
  //    commits, so any request still in the air comes back unauthorized.
  //  * `account_burned` over the websocket — the migration deliberately fans
  //    that out to the old UIN so the user's OTHER devices tear down their
  //    stale state (app/routers/migrate.py). This tab is not another device:
  //    it is the one doing the migrating, and it is about to reload under the
  //    new number. Acting on it here ran the full sign-out — local data wiped,
  //    IndexedDB cleared, back to the login screen with the account gone
  //    unless the user had written down their recovery phrase.
  //
  // The flag is set before the request goes out (the broadcast can beat the
  // HTTP response) and is never cleared on success: the page reloads.
  const migrating = useRef(false)

  // Any other 401 from an authed API call means this web session was revoked
  // (the phone unlinked it) or expired. Drop the identity so the app
  // routes straight back to login instead of showing a raw
  // "401: device revoked" error — both live (on the next request after
  // an unlink) and on a hard reload with a now-dead token.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (migrating.current) return
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
        if (migrating.current) return
        // Tell the account this session is gone before forgetting how to say
        // so. Signing out used to clear local state only, so the phone went on
        // listing a desktop that no longer existed and its token stayed valid
        // — "на компе вышел из профиля и удалил, а в телефоне всё равно
        // показывает, что десктоп подключён".
        //
        // Fire-and-forget: a sign-out must not be blocked, or refused, by a
        // network that happens to be down. The entry then outlives the session
        // exactly as it does today, and the phone can still revoke it by hand.
        if (identity) void Api.unlinkSelf(identity).catch(() => {})
        clearIdentity()
        wipeLocalAccountData()
        void idbClearAll().finally(() => {
          window.location.assign('/')
        })
      },
      beginMigration: () => {
        migrating.current = true
      },
      endMigration: () => {
        migrating.current = false
      },
      adoptMigration: (newUin: number, token: string, to = '/') => {
        if (!identity) return
        migrating.current = true
        setIdentity(adoptMigratedUin(identity, newUin, token))
        // Hard reload, not a route change: every module-level cache is keyed
        // by the old uin/jwt (ws socket, libsignal device, incoming store).
        window.location.assign(to)
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

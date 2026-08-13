// Minimal session context — holds the active WebIdentity (or null
// when unlinked) and the setter to swap it. Avoids prop-drilling
// through Login → Contacts → Chat. Components that need the
// identity grab it via `useIdentity()`.

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { WebIdentity } from './crypto'
import {
  activateStoredIdentity,
  adoptMigratedUin,
  claimInstallToken,
  clearIdentity,
  clearSessionRevoked,
  listStoredIdentities,
  loadStoredIdentity,
  markSessionRevoked,
  persistIdentity,
  removeStoredIdentity,
  wipeLocalAccountData,
} from './auth'
import { migrateFlatDataInto, setAccountScope } from './account-scope'
import { defaultHome } from './routing'
import { Api, setUnauthorizedHandler } from './api'
import { idbClearAll } from './signal-persist'

interface IdentityCtx {
  identity: WebIdentity | null
  setIdentity: (id: WebIdentity | null) => void
  /// Every account this browser holds, active one first.
  accounts: WebIdentity[]
  /// Switch to another held account. A HARD reload follows, because every
  /// module-level cache on this page is keyed to the account that is leaving —
  /// the socket, the libsignal device, the incoming store, the contacts cache.
  /// Swapping them in place would mean auditing each one forever.
  switchAccount: (uin: number) => void
  /// Leave the login screen open to add a second account without signing the
  /// first one out.
  addAccount: () => void
  /// Forget ONE account and stay signed in to the rest.
  signOutAccount: (uin: number) => void
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
  const [accounts, setAccounts] = useState<WebIdentity[]>([])

  useEffect(() => {
    const stored = loadStoredIdentity()
    // ⚠ BEFORE anything reads a store. Every local key and the device database
    // are namespaced by the active account, and a read taken without a scope
    // would land in the flat namespace — which is the pre-multi-account world
    // and belongs to nobody in particular.
    setAccountScope(stored?.uin ?? null)
    if (stored) migrateFlatDataInto(stored.uin)
    setIdentity(stored)
    setAccounts(listStoredIdentities())
    setHydrated(true)
  }, [])

  // Name this browser to the server once. A session minted before the client
  // sent an install id keys as "primary" — the name every other install of the
  // account uses — so a phone and a browser recovered onto the SAME account
  // supersede each other's websocket and share one offline-queue cursor.
  // Only the token changes, so no reload: whoever holds the old jwt in a
  // closure is holding a session that still works.
  // Re-read the roster whenever the active account changes. Creating, recovering
  // or linking all set the identity, and all of them add a row.
  useEffect(() => {
    if (!hydrated) return
    setAccountScope(identity?.uin ?? null)
    setAccounts(listStoredIdentities())
  }, [identity, hydrated])

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
    setUnauthorizedHandler((uin: number) => {
      if (migrating.current) return
      // Mark before clearing: once the identity is gone we no longer know
      // which account died, and the Settings list would show a row that
      // silently bounces to login every time it is tapped ("зайти не даёт").
      const dying = loadStoredIdentity()
      // ⚠ Only the ACTIVE account's 401 ends this session. Signing another
      // account out fires `DELETE /devices/me` with ITS token, and that call
      // answers 401 whenever the phone had already revoked it — which used to
      // sign the user out of the account they were keeping, and mark it
      // "session ended" on the way. A 401 for anybody else is a fact about
      // them, not about us.
      if (!dying || dying.uin !== uin) return
      markSessionRevoked(dying.uin)
      clearIdentity()
      setIdentity(null)
    })
    return () => setUnauthorizedHandler(null)
  }, [])

  const value = useMemo<IdentityCtx>(
    () => ({
      identity,
      setIdentity,
      accounts,
      switchAccount: (uin: number) => {
        if (uin === identity?.uin) return
        if (!activateStoredIdentity(uin)) return
        window.location.assign('/')
      },
      addAccount: () => {
        // The roster keeps every account; clearing only the ACTIVE slot lands
        // on the login screen with the others still here, so "add" cannot
        // become "sign out of everything" by accident.
        clearIdentity()
        window.location.assign('/')
      },
      signOutAccount: (uin: number) => {
        // Tell the ACCOUNT BEING SIGNED OUT that this session is gone, not
        // whichever one happens to be active — otherwise leaving account B
        // would revoke account A's session on the phone.
        const leaving = accounts.find((a) => a.uin === uin)
        if (leaving) void Api.unlinkSelf(leaving).catch(() => {})
        const wasActive = uin === identity?.uin
        removeStoredIdentity(uin)
        clearSessionRevoked(uin)
        // Removing SOMEONE ELSE'S row touches nothing the running session
        // holds: the caches, the socket and the local stores are all scoped to
        // the account that stays active, and removeStoredIdentity deliberately
        // leaves the removed account's own logs alone. So just re-read the
        // roster. It used to reload the document for this too, which in the
        // desktop app meant a white flash and a visible re-entry through the
        // login screen for a row that was not even signed in as.
        if (!wasActive) {
          setAccounts(listStoredIdentities())
          return
        }
        // The ACTIVE account is going: every module-level cache (websocket,
        // signal device, incoming store, media URLs) still holds its data, and
        // only a document reload is guaranteed to drop all of it.
        // removeStoredIdentity has already promoted the next account into the
        // active slot, so this lands signed in as that one — but at the app's
        // home, not on the chat of the account that just left.
        const remaining = listStoredIdentities()
        window.location.assign(remaining.length ? defaultHome() : '/')
      },
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
    [identity, accounts],
  )

  if (!hydrated) return null
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useIdentity(): IdentityCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useIdentity called outside IdentityProvider')
  return v
}

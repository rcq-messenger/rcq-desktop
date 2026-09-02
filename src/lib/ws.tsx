// WebSocket lifecycle. Single connection per `WebIdentity`,
// auto-reconnect with capped backoff, JSON-event subscription
// pattern. Mirrors the iOS `WebSocketService`'s wire — backend
// supports the same WS for any number of devices per UIN, so
// the web client just registers under the existing scheme and
// receives the same events the phone does (`presence`,
// `contact_request`, `contact_response`, `message`, `trade_*`,
// `call_*`, etc.). `hood_*` was in this list until the hood was
// deleted server-side; no island emits it any more.
//
// Event payloads are typed loosely (`unknown`) at the transport
// layer — consumers cast/narrow at call sites where the
// envelope shape is known. Keeps this file decoupled from the
// growing list of event types the backend ships.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useIdentity } from './identity-context'
import { escalateForDeadSockets, refreshFrontRouting } from './front'
import { islandTrustRefusal, subscribeIslandTrust } from './island-trust'
import { handleVaultChanged, handleVaultReset, sweepVaultSlots } from './vault-sync'
import type { VaultChangedFrame } from './vault'

export type WsEvent = { type: string; [key: string]: unknown }
type Listener = (ev: WsEvent) => void

interface WsCtx {
  /// True iff the underlying socket is currently OPEN.
  connected: boolean
  /// Subscribe to events of a given type (or `*` for all). Returns
  /// the unsubscribe function — call from the cleanup of a useEffect
  /// to avoid leaks.
  on: (type: string, listener: Listener) => () => void
  /// Send a JSON message on the open socket. Returns whether the frame was
  /// actually handed to an OPEN socket — a closed one silently swallows the
  /// frame, and a caller holding something that MUST go out (a call ending)
  /// needs to know to keep holding it. Most callers ignore the result: the
  /// iOS client treats the WS as a best-effort channel and the server's
  /// authoritative state lives in REST.
  send: (msg: unknown) => boolean
}

const Ctx = createContext<WsCtx | undefined>(undefined)

/// How long a socket has to hold before its backoff is forgiven. Longer than
/// the 25s heartbeat, so "opened, pinged once, died" is not a healthy session.
const STABLE_MS = 60_000

export function WSProvider({ children }: { children: ReactNode }) {
  const { identity, signOut } = useIdentity()
  const [connected, setConnected] = useState(false)
  const sockRef = useRef<WebSocket | null>(null)
  const listenersRef = useRef<Map<string, Set<Listener>>>(new Map())
  const backoffRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /// When the live socket opened, or null when none is up. Only a socket that
  /// outlived [STABLE_MS] forgives the backoff.
  const openedAtRef = useRef<number | null>(null)
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const closedByUserRef = useRef(false)
  /// Consecutive sockets that died moments after opening. This is the one
  /// signature an HTTP health probe cannot see — a middlebox that passes every
  /// HTTPS request and kills WebSocket streams right after the handshake — so
  /// the socket layer has to notice it itself and escalate to the front.
  const shortLivedRef = useRef(0)

  const dispatch = useCallback((ev: WsEvent) => {
    const typed = listenersRef.current.get(ev.type)
    if (typed) for (const l of typed) l(ev)
    const all = listenersRef.current.get('*')
    if (all) for (const l of all) l(ev)
  }, [])

  const connect = useCallback(() => {
    // No token yet — a tokenless account that started offline and has not
    // minted one. Opening the socket anyway would be refused, and each refusal
    // costs one of the twelve connections a minute the island allows an
    // account. The identity changes the moment a token arrives, and this
    // effect re-runs then.
    if (!identity?.jwt) return
    closedByUserRef.current = false
    // One pending redial at a time. Without this, a straggler close event
    // could schedule a second timer over an existing one, and the cleanup
    // only remembers the last — the orphan then dials a parallel loop.
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    // This dial's socket has not opened yet. Without the reset, a socket
    // REPLACED while open (identity change mid-session) leaves its open-stamp
    // behind — the guard below keeps its close event from clearing it — and
    // the next socket's failure would then read as a five-minute session:
    // backoff forgiven, escalation streak wiped.
    openedAtRef.current = null

    // wss://api.rcq.app/ws/<uin>?token=<jwt>. apiBase usually carries the
    // https URL; swap scheme to wss (http→ws for local dev). When served
    // behind the CF front, apiBase is RELATIVE (e.g. "/api") → build a
    // same-origin wss URL from window.location so the WS rides the same
    // Cloudflare-fronted host as the rest of the app.
    const apiBase = identity.apiBase
    const wsBase = /^https?:/.test(apiBase)
      ? apiBase.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
      : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${apiBase}`
    const url = `${wsBase}/ws/${identity.uin}?token=${encodeURIComponent(identity.jwt)}`

    const ws = new WebSocket(url)
    sockRef.current = ws

    ws.addEventListener('open', () => {
      // ⚠ NOT `backoffRef.current = 0`. Opening is not the same as staying
      // open: a socket that dies a second later would clear the backoff on the
      // way in, and the curve never got past its first step. Measured on prod
      // 11.08 — thousands of sockets an hour, one account opening one every two
      // seconds for hours, which is also what "отправка идёт с большой
      // задержкой" looks like from the outside. The reset moved into `close`,
      // where the socket's actual lifetime is known.
      openedAtRef.current = Date.now()
      setConnected(true)
      // Keepalive heartbeat. The backend derives "online" from last_seen
      // freshness AND drops sockets that go silent (~90s) — without a ping
      // the web socket goes stale, so LIVE delivery stops and messages only
      // arrive in bursts on the next reconnect (felt as "slow delivery").
      // Mirror iOS: ping every 25s; the server pongs + refreshes last_seen.
      if (pingTimerRef.current) clearInterval(pingTimerRef.current)
      pingTimerRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
      }, 25_000)
    })
    ws.addEventListener('message', (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data && typeof data.type === 'string') dispatch(data as WsEvent)
      } catch {
        // Non-JSON frames are ignored; the backend ships only JSON
        // envelopes per WSManager.send/broadcast convention.
      }
    })
    ws.addEventListener('close', (ev) => {
      // Only the CURRENT socket may touch shared state or schedule a redial.
      // A close event from a socket this provider already replaced (the
      // effect re-ran on an identity change while it was open) arrives late,
      // from a stale closure — acting on it here spawned a second dial loop
      // under the same device id, and the two loops then superseded each
      // other's sockets on the island forever.
      if (sockRef.current !== ws) return
      setConnected(false)
      sockRef.current = null
      if (pingTimerRef.current) {
        clearInterval(pingTimerRef.current)
        pingTimerRef.current = null
      }
      const lived = openedAtRef.current ? Date.now() - openedAtRef.current : 0
      // The one line that tells a socket problem apart from everything else.
      // 1006 seconds after open, over and over, is a middlebox killing the
      // stream; 4401 is auth; a clean 1000 is the app's own doing.
      console.info(`[ws] closed code=${ev.code} reason=${ev.reason || '—'} lived=${(lived / 1000).toFixed(1)}s`)
      // 4401 / 4403 are auth-rejected — reconnecting won't help.
      if (closedByUserRef.current || ev.code === 4401 || ev.code === 4403) return
      // Neither will anything else while the island's certificate is on the
      // banner. A trust refusal is NOT a blocked route (fingerprint design
      // §5.5): the socket below was handed back dead by the trust wrapper and
      // never left this machine, so the streak and the front escalation must
      // not read it as a network that started killing sockets — the front
      // only ever proxies the flagship anyway, and the island stays refused
      // for the life of the process. The effect below redials when the record
      // changes, which is the only thing that can lift this.
      const refused = islandTrustRefusal(url)
      if (refused) {
        console.info(`[ws] island trust: ${refused} — no redial until the record changes`)
        return
      }
      // Exponential backoff capped at 30s. Mirrors common WS-client
      // behaviour; prevents thundering-herd on backend bounces.
      //
      // A session that HELD earns a clean slate; one that died on arrival does
      // not, so a run of short-lived sockets climbs the curve instead of
      // redialling once a second forever.
      if (lived >= STABLE_MS) backoffRef.current = 0
      openedAtRef.current = null
      // A socket that never opened (handshake refused or eaten) counts INTO
      // the streak, same as one that opened and died: both are the socket
      // road failing while the HTTP road may be fine, and both must be able
      // to reach the escalation below — including the leg where sockets die
      // THROUGH the front and the only way back to direct is another streak.
      // Only a socket that held a while resets the count.
      shortLivedRef.current = lived >= 10_000 ? 0 : shortLivedRef.current + 1
      const delay = Math.min(30_000, 1000 * 2 ** backoffRef.current)
      backoffRef.current = Math.min(backoffRef.current + 1, 5)
      // A socket that keeps dying is the first sign of a network that started
      // blocking mid-session, and it is the only such sign the desktop gets:
      // there is no route ladder re-walking underneath it. Re-decide the front
      // before redialling, from the second failure on — once is a bounce, twice
      // is worth a look — and the dial below then picks up whatever it decided.
      //
      // Three sockets in a row dead within seconds of opening is a different
      // disease: the island's HTTPS answers (so the health probe keeps voting
      // "direct"), yet no socket survives. That signature bypasses the probe
      // and asks the front layer to escalate on the socket evidence alone.
      const redial = () => { void connect() }
      if (shortLivedRef.current >= 3 && shortLivedRef.current % 3 === 0) {
        reconnectTimerRef.current = setTimeout(() => { void escalateForDeadSockets().finally(redial) }, delay)
      } else if (backoffRef.current >= 2) {
        reconnectTimerRef.current = setTimeout(() => { void refreshFrontRouting().finally(redial) }, delay)
      } else {
        reconnectTimerRef.current = setTimeout(redial, delay)
      }
    })
    ws.addEventListener('error', () => {
      // The 'close' handler above runs after every error, so
      // reconnect is already covered. Suppress noisy default
      // logging by handling here.
    })
  }, [identity, dispatch])

  // (Re-)open whenever the identity changes; tear down on sign-out.
  useEffect(() => {
    connect()
    return () => {
      closedByUserRef.current = true
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      if (pingTimerRef.current) {
        clearInterval(pingTimerRef.current)
        pingTimerRef.current = null
      }
      sockRef.current?.close()
      sockRef.current = null
      setConnected(false)
    }
  }, [connect])

  // The one way back from a refusal. The close handler above stops the loop
  // while the island is refused, so nothing else would ever dial again: the
  // banner's accept (and any probe that decides otherwise) replaces the trust
  // snapshot, and that is the signal to try once more. Cheap — the snapshot
  // changes only when a probe answers, and a dial while one is up is skipped.
  useEffect(
    () =>
      subscribeIslandTrust(() => {
        if (!sockRef.current && !closedByUserRef.current) connect()
      }),
    [connect],
  )

  // Account-burned handler. When the server fans out the
  // `account_burned` event (e.g. user pressed "Burn" on iOS while
  // this browser tab is open), drop the local identity so the
  // routing layer bounces back to /. The next render's IdentityCtx
  // is null which the Authed wrappers redirect from.
  useEffect(() => {
    let cancelled = false
    const set = listenersRef.current.get('account_burned') ?? new Set<Listener>()
    const handler: Listener = () => {
      if (cancelled) return
      signOut()
    }
    set.add(handler)
    listenersRef.current.set('account_burned', set)
    return () => {
      cancelled = true
      set.delete(handler)
    }
  }, [signOut])

  // The vault's two slots, kept fresh. This is the first consumer of
  // `vault_changed`: the island has fanned the frame out since the vault
  // shipped and nobody was listening, so a contact list or a section made on
  // another device only arrived on the next cold start.
  //
  // ⚠ The nudge alone is not enough and never was: it is pub/sub with no
  // replay, so the device whose socket was down when the write happened hears
  // nothing. The sweep below runs on EVERY (re)connect and compares versions.
  useEffect(() => {
    if (!identity) return
    const set = listenersRef.current.get('vault_changed') ?? new Set<Listener>()
    const handler: Listener = (ev) => {
      void handleVaultChanged(identity, ev as unknown as VaultChangedFrame)
    }
    set.add(handler)
    listenersRef.current.set('vault_changed', set)
    return () => {
      set.delete(handler)
    }
  }, [identity])

  // `vault_reset`: another device called `/auth/reissue`, so the island threw
  // the account's vault away and the identity every slot NAME and every slot
  // KEY is derived from is retired. This browser still holds the old one, so
  // the only correct move is to stop writing (see `handleVaultReset`) rather
  // than to republish a list nothing will ever read again, sealed with the key
  // the user has just declared compromised. The island has been sending this
  // frame since the reissue path learned to announce itself and no client
  // listened for it.
  useEffect(() => {
    if (!identity) return
    const set = listenersRef.current.get('vault_reset') ?? new Set<Listener>()
    const handler: Listener = () => handleVaultReset(identity)
    set.add(handler)
    listenersRef.current.set('vault_reset', set)
    return () => {
      set.delete(handler)
    }
  }, [identity])

  useEffect(() => {
    if (!connected || !identity) return
    void sweepVaultSlots(identity)
  }, [connected, identity])

  const on = useCallback<WsCtx['on']>((type, listener) => {
    const set = listenersRef.current.get(type) ?? new Set<Listener>()
    set.add(listener)
    listenersRef.current.set(type, set)
    return () => {
      const cur = listenersRef.current.get(type)
      if (!cur) return
      cur.delete(listener)
      if (cur.size === 0) listenersRef.current.delete(type)
    }
  }, [])

  const send = useCallback<WsCtx['send']>((msg) => {
    const ws = sockRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(msg))
    return true
  }, [])

  const value = useMemo<WsCtx>(() => ({ connected, on, send }), [connected, on, send])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useWS(): WsCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useWS called outside WSProvider')
  return v
}

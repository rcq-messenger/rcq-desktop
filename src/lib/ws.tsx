// WebSocket lifecycle. Single connection per `WebIdentity`,
// auto-reconnect with capped backoff, JSON-event subscription
// pattern. Mirrors the iOS `WebSocketService`'s wire — backend
// supports the same WS for any number of devices per UIN, so
// the web client just registers under the existing scheme and
// receives the same events the phone does (`presence`,
// `contact_request`, `contact_response`, `message`, `hood_*`,
// `trade_*`, `call_*`, etc.).
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
import { refreshFrontRouting } from './front'

export type WsEvent = { type: string; [key: string]: unknown }
type Listener = (ev: WsEvent) => void

interface WsCtx {
  /// True iff the underlying socket is currently OPEN.
  connected: boolean
  /// Subscribe to events of a given type (or `*` for all). Returns
  /// the unsubscribe function — call from the cleanup of a useEffect
  /// to avoid leaks.
  on: (type: string, listener: Listener) => () => void
  /// Send a JSON message on the open socket. No-op when not
  /// connected — the iOS client treats the WS as a best-effort
  /// channel and the server's authoritative state lives in REST.
  send: (msg: unknown) => void
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

  const dispatch = useCallback((ev: WsEvent) => {
    const typed = listenersRef.current.get(ev.type)
    if (typed) for (const l of typed) l(ev)
    const all = listenersRef.current.get('*')
    if (all) for (const l of all) l(ev)
  }, [])

  const connect = useCallback(() => {
    if (!identity) return
    closedByUserRef.current = false

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
      setConnected(false)
      sockRef.current = null
      if (pingTimerRef.current) {
        clearInterval(pingTimerRef.current)
        pingTimerRef.current = null
      }
      // 4401 / 4403 are auth-rejected — reconnecting won't help.
      if (closedByUserRef.current || ev.code === 4401 || ev.code === 4403) return
      // Exponential backoff capped at 30s. Mirrors common WS-client
      // behaviour; prevents thundering-herd on backend bounces.
      //
      // A session that HELD earns a clean slate; one that died on arrival does
      // not, so a run of short-lived sockets climbs the curve instead of
      // redialling once a second forever.
      const lived = openedAtRef.current ? Date.now() - openedAtRef.current : 0
      if (lived >= STABLE_MS) backoffRef.current = 0
      openedAtRef.current = null
      const delay = Math.min(30_000, 1000 * 2 ** backoffRef.current)
      backoffRef.current = Math.min(backoffRef.current + 1, 5)
      // A socket that keeps dying is the first sign of a network that started
      // blocking mid-session, and it is the only such sign the desktop gets:
      // there is no route ladder re-walking underneath it. Re-decide the front
      // before redialling, from the second failure on — once is a bounce, twice
      // is worth a look — and the dial below then picks up whatever it decided.
      const redial = () => { void connect() }
      if (backoffRef.current >= 2) {
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
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(msg))
  }, [])

  const value = useMemo<WsCtx>(() => ({ connected, on, send }), [connected, on, send])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useWS(): WsCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useWS called outside WSProvider')
  return v
}

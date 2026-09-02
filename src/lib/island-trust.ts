// An island trusted by its fingerprint, not by a certificate authority: the
// page's half of docs/island-fingerprint-design.md §7.3.
//
// A browser cannot be told to trust a private certificate, and neither can the
// webview the desktop wraps. So on the desktop the Rust side terminates TLS
// for such an island (src-tauri/src/island_trust.rs): a listener on loopback,
// bridged to the island with OUR verifier. This file is what makes the page
// use it. It does to a fingerprint island's origin exactly what front.ts does
// to the flagship's: rewrites `fetch` and `WebSocket` at the transport edge,
// once, so no caller reading `identity.apiBase` off the twenty-odd places
// that do can miss it. And for the same reason as front.ts it never touches
// `identity.apiBase`: that value is persisted, and a loopback address written
// into an account would outlive the session it was minted for.
//
// Every island origin that is not the flagship is probed ONCE per process
// BEFORE the first request to it: the primary island eagerly at boot and at
// login, any other origin from inside the `fetch` wrapper, which awaits the
// probe and only then lets the request go. The probe is one handshake through
// the Rust verifier, so it runs the rule on both outcomes and writes the `ca`
// record for a CA island; that is how a backup home, a foreign island or a
// visited group's island used for months over Let's Encrypt becomes a KNOWN
// island rather than one an attacker's self-signed certificate takes on first
// use. The probe leaves the origin in one of three states: `direct` (a CA
// island, the request goes out on the webview's own TLS), `loopback` (the
// forwarder), or `refused` (the fetch rejects with a TypeError carrying the
// reason, nothing is sent, the banner reads the snapshot below).
//
// ⚠ A request is NEVER re-issued after a failure. The first text probed on a
// webview `TypeError` and replayed the request through the forwarder, which
// for every non-primary island (no `ca` record, since the webview's TLS never
// runs the rule) turned an on-path self-signed certificate into a first use
// and a replay with the bearer token - the silent downgrade §1 promises
// cannot happen. Now a webview `TypeError` on a direct origin is a network
// failure or a changed certificate; the wrapper re-probes (throttled) only to
// refresh the `changed` state for the banner, and the caller sees the failure.
//
// A REFUSAL is not a blocked route. The island stays refused until the person
// decides on the banner; nothing here retries, and the front never enters
// into it (it only ever proxies the flagship).
//
// Off the desktop every export is a no-op: a browser shows §5.4's hint and
// nothing else.

import { isTauri } from './desktop'
import { isFrontHost } from './front'
import { splitHostPort } from './island-choice'

export type TrustState = 'ca' | 'pinned' | 'first_use' | 'changed' | 'ca_only' | 'offline'

/// A refusal as the Rust side reports it (§5.2). `old` is a fingerprint or
/// the literal 'ca'; `ca` says the refused chain was CA-valid; `typed` says
/// the record on file was entered by the person; `entered` says the NEW value
/// is one the person typed with the address and the store disagreed (§3).
export interface TrustChanged {
  old: string
  new: string
  ca: boolean
  typed: boolean
  entered: boolean
}

export interface ProbeResult {
  state: TrustState
  fingerprint?: string
  /// For `pinned`: whether the first-use notice was ever shown.
  noticed?: boolean
  changed?: TrustChanged
  /// For `offline`: what the store holds ('ca' or 'pinned'), if anything.
  on_file?: 'ca' | 'pinned'
}

export interface TrustStatus {
  mode: 'ca' | 'pinned' | null
  fingerprint?: string
  source?: 'tofu' | 'typed' | 'accepted'
  since?: number
  noticed?: boolean
  changed?: TrustChanged
}

export interface TrustEntry {
  host: string
  port: number
  mode: 'ca' | 'pinned'
  fingerprint?: string
  source?: 'tofu' | 'typed' | 'accepted'
  since: number
  noticed?: boolean
}

export interface ChangedIsland extends TrustChanged {
  host: string
  port: number
  /// `host[:port]`, what the banner names.
  authority: string
}

export interface FirstUseIsland {
  host: string
  port: number
  authority: string
  fingerprint: string
}

/// What the UI draws from. Replaced whole on every change so a
/// `useSyncExternalStore` reader sees a new reference.
export interface TrustSnapshot {
  changed: Record<string, ChangedIsland>
  firstUse: Record<string, FirstUseIsland>
}

// ── The observable ──────────────────────────────────────────────────────────

let snapshot: TrustSnapshot = { changed: {}, firstUse: {} }
const listeners = new Set<() => void>()

export function islandTrustSnapshot(): TrustSnapshot {
  return snapshot
}

export function subscribeIslandTrust(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function update(next: TrustSnapshot) {
  snapshot = next
  for (const fn of listeners) fn()
}

/// `host[:port]` as a person reads it - no port for 443.
export function islandAuthority(host: string, port: number): string {
  return port === 443 ? host : `${host}:${port}`
}

function feedChanged(host: string, port: number, changed: TrustChanged) {
  const authority = islandAuthority(host, port)
  const next = { changed: { ...snapshot.changed }, firstUse: { ...snapshot.firstUse } }
  next.changed[authority] = { ...changed, host, port, authority }
  delete next.firstUse[authority]
  update(next)
}

function feed(host: string, port: number, res: ProbeResult) {
  const authority = islandAuthority(host, port)
  const changed = { ...snapshot.changed }
  const firstUse = { ...snapshot.firstUse }
  switch (res.state) {
    case 'changed':
      if (res.changed) changed[authority] = { ...res.changed, host, port, authority }
      delete firstUse[authority]
      break
    case 'first_use':
      delete changed[authority]
      if (res.fingerprint) firstUse[authority] = { host, port, authority, fingerprint: res.fingerprint }
      break
    case 'pinned':
      delete changed[authority]
      // A notice that never got drawn (the app closed on it) is owed now.
      if (res.noticed === false && res.fingerprint) {
        firstUse[authority] = { host, port, authority, fingerprint: res.fingerprint }
      }
      break
    case 'ca':
      delete changed[authority]
      break
    case 'ca_only':
    case 'offline':
      // Says nothing about the certificate; whatever was on the banner stays.
      return
  }
  update({ changed, firstUse })
}

/// The first-use notice was closed: never again for this island.
export function dismissFirstUse(authority: string) {
  const entry = snapshot.firstUse[authority]
  if (!entry) return
  const firstUse = { ...snapshot.firstUse }
  delete firstUse[authority]
  update({ ...snapshot, firstUse })
  void markIslandNoticed(entry.host, entry.port)
}

// ── The Rust side ───────────────────────────────────────────────────────────

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import('@tauri-apps/api/core')
  return core.invoke<T>(cmd, args)
}

/// One TLS handshake with the rule applied; null off the desktop or when the
/// call itself failed (a bad host).
export async function probeIsland(host: string, port: number): Promise<ProbeResult | null> {
  if (!isTauri()) return null
  try {
    return await invoke<ProbeResult>('island_trust_probe', { host, port })
  } catch (e) {
    console.warn('[island-trust] probe failed', e)
    return null
  }
}

export async function islandTrustStatus(host: string, port: number): Promise<TrustStatus | null> {
  if (!isTauri()) return null
  try {
    return await invoke<TrustStatus>('island_trust_status', { host, port })
  } catch {
    return null
  }
}

export async function islandTrustList(): Promise<TrustEntry[]> {
  if (!isTauri()) return []
  try {
    return await invoke<TrustEntry[]>('island_trust_list')
  } catch {
    return []
  }
}

/// The banner's accept (§5.2). What gets written is the Rust side's call: a
/// CA-valid chain refused over a typed pin is recorded as `ca`, a value the
/// person typed stays `typed`, anything else is `accepted`.
export async function acceptIslandFingerprint(host: string, port: number, fingerprint: string): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await invoke('island_trust_accept', { host, port, fingerprint, source: 'accepted' })
  } catch (e) {
    console.warn('[island-trust] accept failed', e)
    return false
  }
  const authority = islandAuthority(host, port)
  if (snapshot.changed[authority]) {
    const changed = { ...snapshot.changed }
    delete changed[authority]
    update({ ...snapshot, changed })
  }
  // Whatever route this island had was decided against the old record; the
  // next request probes afresh against the new one.
  routes.delete(`https://${authority}`)
  lastProbe.delete(`https://${authority}`)
  return true
}

export async function forgetIslandTrust(host: string, port: number): Promise<void> {
  if (!isTauri()) return
  try {
    await invoke('island_trust_forget', { host, port })
  } catch {
    /* nothing to forget */
  }
  routes.delete(`https://${islandAuthority(host, port)}`)
}

async function markIslandNoticed(host: string, port: number): Promise<void> {
  if (!isTauri()) return
  try {
    await invoke('island_trust_noticed', { host, port })
  } catch {
    /* the notice shows once more next time; not worth surfacing */
  }
}

export type PrePinOutcome = 'pinned' | 'same' | 'conflict' | 'unsupported'

interface PrePinResult {
  state: 'pinned' | 'same' | 'conflict'
  changed?: TrustChanged
}

/// §3: the fingerprint typed with the address goes on file BEFORE the first
/// request, so the first handshake has to match it. Against a record that
/// disagrees nothing is written: the island goes onto the banner as refused,
/// and nothing is dialled until the person chooses. Registered synchronously
/// so a request that follows the pick in the same tick (the island card's
/// `/server/info`) waits on it inside the wrapper rather than racing it to a
/// first-use pin. 'unsupported' off the desktop, where there is no store.
export function prePinIsland(base: string, fingerprint: string): Promise<PrePinOutcome> {
  if (!isTauri()) return Promise.resolve('unsupported')
  let host: string
  let port: number
  try {
    ;({ host, port } = splitHostPort(base))
  } catch {
    return Promise.resolve('unsupported')
  }
  const origin = `https://${islandAuthority(host, port)}`
  const p = (async (): Promise<PrePinOutcome> => {
    try {
      const res = await invoke<PrePinResult>('island_trust_prepin', { host, port, fingerprint })
      if (res.state === 'conflict' && res.changed) {
        feedChanged(host, port, res.changed)
        routes.set(origin, { kind: 'refused', reason: 'changed' })
      } else {
        // Pinned (or the same value again): whatever route this origin had
        // was decided against a null record; probe afresh against the pin.
        routes.delete(origin)
      }
      return res.state
    } catch (e) {
      console.warn('[island-trust] pre-pin failed', e)
      return 'unsupported'
    }
  })()
  const wait = p.then(() => undefined)
  pending.set(origin, wait)
  void wait.finally(() => {
    if (pending.get(origin) === wait) pending.delete(origin)
  })
  return p
}

// ── Routes ──────────────────────────────────────────────────────────────────

type Route = { kind: 'direct' } | { kind: 'loopback'; port: number } | { kind: 'refused'; reason: string }

/// `https://host[:port]` → how requests to it travel. An origin is here once
/// its probe has answered; until then the wrapper waits.
const routes = new Map<string, Route>()
const inflight = new Map<string, Promise<Route>>()
/// A pre-pin in flight for an origin (§3). The gate awaits it first.
const pending = new Map<string, Promise<void>>()
const lastProbe = new Map<string, number>()
/// A failed request re-probes its island at most this often. A TypeError is
/// also what an offline island produces, and a probe per failed request on a
/// dead network would be a handshake attempt per retry.
const REPROBE_GAP_MS = 15_000

/// The hosts the rule never pins (§1): the flagship, anything under its apex,
/// and the front. Their TLS is the webview's, and a fragment typed for one of
/// them is an address error, not a pin to take.
export function isCaOnlyHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  return h === 'rcq.app' || h.endsWith('.rcq.app') || isFrontHost(h)
}

/// The https origin of a URL when it is one a fingerprint could govern: not
/// a CA-only host, and not something already on loopback.
function candidateOrigin(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'wss:') return null
  if (isCaOnlyHost(u.hostname)) return null
  return `https://${u.host}`
}

/// Whether the trust layer has REFUSED this url's island, and why (§5.5).
/// The socket layer asks before it draws any conclusion from a socket that
/// never opened: a refusal is not a blocked route. The socket the wrapper
/// hands back while an island is refused never leaves this machine, so
/// counting it as socket death would engage the front on evidence that has
/// nothing to do with the island, and redialling it would spin for the life
/// of the process - the record only changes when the person decides.
export function islandTrustRefusal(url: string): string | null {
  const origin = candidateOrigin(url)
  if (!origin) return null
  const route = routes.get(origin)
  return route?.kind === 'refused' ? route.reason : null
}

function toLoopback(url: string, port: number): string {
  const u = new URL(url)
  u.protocol = u.protocol === 'wss:' ? 'ws:' : 'http:'
  u.hostname = '127.0.0.1'
  u.port = String(port)
  return u.toString()
}

async function openForwarder(host: string, port: number): Promise<number | null> {
  try {
    return await invoke<number>('island_trust_open', { host, port })
  } catch (e) {
    console.warn('[island-trust] forwarder failed', e)
    return null
  }
}

/// The probe's answer as a route. `offline` says nothing about the
/// certificate, so it decides by what is on file: a pinned island goes
/// through the forwarder regardless (the bridge runs the rule on every
/// connection, and the webview's own TLS must never carry a request to an
/// island whose identity the person typed - an on-path attacker with a
/// CA-valid certificate could tell our handshake from the webview's and
/// answer only the webview's); anything else goes direct, where the webview
/// verifies it, and is asked again after the gap. Null: not decided.
async function routeFor(host: string, port: number, res: ProbeResult): Promise<Route | null> {
  switch (res.state) {
    case 'ca':
    case 'ca_only':
      return { kind: 'direct' }
    case 'pinned':
    case 'first_use': {
      const loopback = await openForwarder(host, port)
      return loopback == null ? null : { kind: 'loopback', port: loopback }
    }
    case 'changed':
      return { kind: 'refused', reason: 'changed' }
    case 'offline': {
      if (res.on_file !== 'pinned') return null
      const loopback = await openForwarder(host, port)
      return loopback == null ? null : { kind: 'loopback', port: loopback }
    }
  }
}

/// Probe `origin` and decide its route. One probe per origin at a time; a
/// second caller waits on the first. An undecided answer (offline, nothing on
/// file) leaves the origin direct for now WITHOUT remembering it, so the next
/// request after the gap asks again - and not before: on a dead network a
/// handshake per request would be a handshake per retry.
function gate(origin: string): Promise<Route> {
  const known = routes.get(origin)
  if (known) return Promise.resolve(known)
  const running = inflight.get(origin)
  if (running) return running
  const p = (async (): Promise<Route> => {
    await pending.get(origin)
    const decided = routes.get(origin)
    if (decided) return decided
    const at = lastProbe.get(origin)
    if (at != null && Date.now() - at < REPROBE_GAP_MS) return { kind: 'direct' }
    const { host, port } = splitHostPort(origin)
    lastProbe.set(origin, Date.now())
    const res = await probeIsland(host, port)
    if (!res) return { kind: 'direct' }
    feed(host, port, res)
    const route = await routeFor(host, port, res)
    if (!route) return { kind: 'direct' }
    routes.set(origin, route)
    console.info(`[island-trust] ${origin}: ${res.state} → ${route.kind}${route.kind === 'loopback' ? ` 127.0.0.1:${route.port}` : ''}`)
    return route
  })().finally(() => inflight.delete(origin))
  inflight.set(origin, p)
  return p
}

/// A request to a decided origin threw. The island went away, or its
/// certificate changed: on a direct origin the webview refused it, on a
/// loopback one the bridge did. Ask again, throttled, so a refusal reaches
/// the banner and a move to a CA reaches the route. The request itself is
/// not re-sent.
function reprobe(origin: string) {
  const at = lastProbe.get(origin)
  if (at != null && Date.now() - at < REPROBE_GAP_MS) return
  if (inflight.has(origin)) return
  lastProbe.set(origin, Date.now())
  const { host, port } = splitHostPort(origin)
  void probeIsland(host, port).then(async (res) => {
    if (!res) return
    feed(host, port, res)
    const route = await routeFor(host, port, res)
    if (route) routes.set(origin, route)
  })
}

/// The primary island, when the identity loads or the login form picks one.
/// The flagship, the front and anything under the apex are skipped inside:
/// nothing to decide there.
export async function engageIslandEagerly(apiBase: string | undefined): Promise<void> {
  if (!isTauri() || !apiBase) return
  const origin = candidateOrigin(apiBase)
  if (!origin) return
  await gate(origin)
}

function refusal(origin: string, reason: string): TypeError {
  return new TypeError(`island_trust: ${reason} ${origin}`)
}

let installed = false

/// Wrap `fetch` and `WebSocket` once. Installed AFTER `installFrontRouting`
/// so the two compose: this layer sees every call first and moves only an
/// island origin it has decided; the front's layer underneath moves only the
/// flagship, which this one never touches. No-op off the desktop.
///
/// Known limit, not solved here: a PLAIN `<img src>` straight from an island
/// (IslandAvatar's fallback road for the logo URL from server-info.ts) is
/// loaded by the webview's own image loader, which no `fetch` wrapper sees.
/// On a fingerprint island that road stays broken until the logo is fetched
/// as a blob - which IslandAvatar tries first, so the picture usually arrives
/// anyway.
export function installIslandTrust() {
  if (installed || !isTauri()) return
  installed = true

  const under = window.fetch.bind(window)

  function send(origin: string, route: Route, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (route.kind === 'refused') return Promise.reject(refusal(origin, route.reason))
    let moved: RequestInfo | URL = input
    if (route.kind === 'loopback') {
      // A Request carries headers, body and mode that must survive; rebuilding
      // it around a new URL is the only way to redirect one.
      moved =
        input instanceof Request
          ? new Request(toLoopback(input.url, route.port), input)
          : toLoopback(input instanceof URL ? input.toString() : input, route.port)
    }
    return under(moved, init).catch((e: unknown) => {
      // A TypeError is the whole of what a webview says about a certificate
      // it will not accept - the same as for an unplugged cable. The probe
      // tells the two apart, for the banner; the caller sees the failure.
      if (e instanceof TypeError) reprobe(origin)
      throw e
    })
  }

  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input instanceof Request ? input.url : null
    const origin = url == null ? null : candidateOrigin(url)
    if (!origin) return under(input, init)
    const known = routes.get(origin)
    if (known) return send(origin, known, input, init)
    // The first request to this origin waits for its probe. Nothing has been
    // sent yet, so nothing is replayed.
    return gate(origin).then((route) => send(origin, route, input, init))
  }) as typeof window.fetch

  const NativeWebSocket = window.WebSocket
  const Wrapped = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const raw = typeof url === 'string' ? url : url.toString()
    const origin = candidateOrigin(raw)
    if (!origin) return new NativeWebSocket(raw, protocols)
    const route = routes.get(origin)
    if (route?.kind === 'direct') return new NativeWebSocket(raw, protocols)
    if (route?.kind === 'loopback') return new NativeWebSocket(toLoopback(raw, route.port), protocols)
    // Refused, or not decided yet. A constructor cannot wait on a probe, and
    // no client opens a socket to an island before a REST call to it (login,
    // register and sync are REST), so this is the odd case: start the probe
    // and hand back a socket that fails on its own. Loopback port 1 has
    // nothing listening on any desktop, so the socket errors and closes at
    // once, and the reconnect loop's next attempt, after the probe, takes
    // the right route. Dialling the island on the webview's TLS instead
    // would carry the token to whatever certificate the webview happens to
    // accept.
    if (!route) void gate(origin)
    return new NativeWebSocket('ws://127.0.0.1:1/', protocols)
  } as unknown as typeof WebSocket
  Wrapped.prototype = NativeWebSocket.prototype
  // The readyState constants are read off the constructor in places
  // (`WebSocket.OPEN`), so a wrapper that drops them breaks callers silently.
  Object.defineProperties(Wrapped, {
    CONNECTING: { value: NativeWebSocket.CONNECTING },
    OPEN: { value: NativeWebSocket.OPEN },
    CLOSING: { value: NativeWebSocket.CLOSING },
    CLOSED: { value: NativeWebSocket.CLOSED },
  })
  window.WebSocket = Wrapped
}

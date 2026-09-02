// The route ladder: how the CLI reaches an island somebody is blocking.
//
// Until now it had none. One transport, one address, a direct TLS connection
// to the island and nothing after it - which for the client whose whole pitch
// is "no app store can take this away" was the wrong gap to have.
//
// ## The rungs
//
//   1. DIRECT - the island's own address. Always preferred, always re-checked,
//      so a network that stops blocking recovers on its own.
//   2. CDN FRONT - the same island under a Cloudflare name (`cdn.rcq.app`, or
//      whatever the signed config's `transport.front` moved it to). Only a
//      hostname changes, which is why this is the one circumvention layer the
//      CLI can do entirely by itself: no sidecar, no binary, no relaunch.
//      Flagship only - the front proxies one island, and sending a self-hosted
//      island through it would turn a working server into a 404.
//   3. THE USER'S PROXY - `rcq proxy set socks5://HOST:PORT`, which is Node's own
//      env-proxy transport (env-proxy.ts). Tor, i2p, an ssh -D tunnel, or a
//      sing-box the user installed and pointed at RCQ's relays
//      (`rcq routes --singbox` writes its config).
//
// Rungs 1 and 2 choose an ADDRESS. Rung 3 chooses a TRANSPORT, and the address
// ladder still runs inside it: proxy → island, and if that is dead, proxy →
// front. So the four states are direct, front, proxy, proxy+front.
//
// ## What this is NOT, and will not pretend to be
//
// There is no embedded obfuscated transport here and there cannot be one.
// VLESS+Reality and Hysteria2 are what the phones tunnel through, both by
// linking a Go sing-box core through gomobile; Node has nothing to link. So
// the CLI does not "support relays" - it cooperates with a sing-box the user
// installed, and `rcq routes` says exactly that.
//
// It builds no onion circuit either. A 2-hop chain is a sing-box `detour` and
// the entry guard is a sing-box outbound; what the CLI can honestly do is
// CHOOSE the entry (a TCP-reachability probe is portable) and WRITE the chain
// into a config for sing-box to run. See singbox.ts. Anything that says "the
// CLI does onion" would be describing sing-box's work.
//
// ## Ordering, and why it matches the phones
//
// Android walks direct -> front -> tunnel and then re-probes, dropping back to
// direct when the tunnel is up but carrying nothing (Session.kt
// runRouteLadder). Two of its rules are load-bearing and are kept here:
//
//   * Direct is preferred and re-checked. A network that blocked and then
//     stopped must not leave a client on the front forever.
//   * NEVER fall out of the user's own proxy. Somebody who pointed RCQ at Tor
//     and then had it quietly retry direct would be deanonymised by their own
//     messenger. A configured proxy is a MODE the ladder may not leave - the
//     same line SingBoxTransport.mayAutoEngage holds, for the same reason.
//     Nothing here can leave it in any case: the proxy is in the process
//     environment before this file is evaluated, and only a new process can
//     change that.
//
// What the CLI adds is stickiness. The phones walk the ladder at boot and hold
// the answer for the life of the process; a CLI process lives for one `rcq
// send`, so the answer is written down (routes.json) and reused for
// STICKY_TTL_MS. Without it every command on a censored network would pay the
// full probe budget again, and `rcq send` in a cron loop would pay it a
// thousand times a day.

import fs from 'node:fs'
import net from 'node:net'
import tls from 'node:tls'
import { setFrontHost } from '../../src/lib/front'
import { envProxySupported, readProxyUrl, redactProxyUrl } from './env-proxy'
import { tr } from './i18n'
import { addCaOnlyHost } from './island-trust'
import { frontHost, prime as primeRelayConfig } from './relay-config'
import { statePath, writeFileAtomic } from './state'

/// The flagship, as every identity records it and as the code names it. The
/// front rewrites this origin and no other.
const FLAGSHIP_HTTPS = 'https://api.rcq.app'
const FLAGSHIP_WSS = 'wss://api.rcq.app'

/// How long a decision is reused before the ladder is walked again. Short
/// enough that a network which stopped blocking is found within the half hour,
/// long enough that a cron job firing every minute does not probe every time.
const STICKY_TTL_MS = 30 * 60 * 1000

/// How long a walk where NOTHING answered is honoured. Short, because the
/// thing it is waiting for is usually a network coming back; long enough that
/// a script firing commands in a loop does not re-probe every one of them.
const COLD_TTL_MS = 60 * 1000

/// Probe budgets, growing rather than repeating - Android's lesson: one short
/// budget on a slow-but-open mobile network reported a healthy island as
/// blocked and moved the user onto a route they did not need. 4s, then 11s;
/// the total is the same patience a genuinely blocked user pays either way.
const TLS_BUDGETS_MS = [4000, 11000]

/// A proxy is measured with a real request, not a socket open: a SOCKS port
/// can accept while the circuit behind it is down. 25s because Tor and i2p can
/// take many seconds to build a first circuit, and a too-short test reports a
/// working proxy as dead (the phones learned that from an i2p report).
const PROXY_PROBE_MS = 25_000

export type RungName = 'direct' | 'front' | 'proxy' | 'proxy+front'

export interface RungResult {
  rung: RungName
  /// `ok` answered, `blocked` did not, `skipped` was not applicable (a front
  /// for a self-hosted island), `not-tried` came after something answered.
  verdict: 'ok' | 'blocked' | 'skipped' | 'not-tried'
  ms?: number
  detail?: string
}

export interface LadderWalk {
  at: number
  apiBase: string
  chosen: RungName | null
  rungs: RungResult[]
}

interface RoutesState {
  /// `cold` marks a walk where NOTHING answered. It is still written down, and
  /// still honoured for a short while: without it a machine that is simply
  /// offline (a laptop off wifi, a VPS mid-reboot) would pay the entire probe
  /// budget again on every single command before failing the way it was always
  /// going to fail.
  sticky?: { rung: RungName; at: number; cold?: boolean } | null
  last?: LadderWalk | null
  /// The sticky onion ENTRY tag for the sing-box config the CLI writes (O4's
  /// guard: pick once, keep, rotate only on confirmed block). Owned by
  /// singbox.ts, kept here so there is one route state file.
  onionEntry?: string | null
}

const STATE_FILE = 'routes.json'

export function loadRoutesState(): RoutesState {
  try {
    const j = JSON.parse(fs.readFileSync(statePath(STATE_FILE), 'utf8')) as RoutesState
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

export function saveRoutesState(patch: Partial<RoutesState>): void {
  try {
    writeFileAtomic(statePath(STATE_FILE), JSON.stringify({ ...loadRoutesState(), ...patch }, null, 1))
  } catch {
    /* a route note we cannot write costs one extra probe next time */
  }
}

// -----------------------------------------------------------------
// The transport underneath, which this file does not own
// -----------------------------------------------------------------

/// True when this process is really running behind the user's proxy.
///
/// ⚠ Not the same question as "is a proxy configured". The environment is what
/// Node's fetch and WebSocket read, once, at startup; `engageStartupEnv()` re-execs
/// the process to set it. So this asks what actually happened, not what the
/// config says - and it also answers true for somebody who exported the
/// variables themselves, whose traffic is proxied just as thoroughly.
///
/// ⚠ The runtime check is not decoration. Those variables are read by NOBODY
/// before Node 24, so the flag we set ourselves was the whole evidence base:
/// on Node 22 every rung, every `whoami` line and the routes file all said
/// `proxy` while every byte went direct. `engageStartupEnv` now refuses to run a
/// command there at all, and this is the second half of the same rule, for the
/// person who exported the variables by hand.
export function proxyActive(): boolean {
  if (!envProxySupported()) return false
  return process.env.RCQ_PROXY_ENGAGED === '1' || !!process.env.NODE_USE_ENV_PROXY
}

/// The proxy carrying this run, redacted for printing, or null.
export function activeProxyLabel(): string | null {
  if (!proxyActive()) return null
  const url = readProxyUrl()
  // ⚠ The fallback is redacted too, and it is the branch that needs it most:
  // it handles the proxy somebody exported by hand, which is the one that
  // actually tends to carry `user:password@`. Unredacted it went into
  // scrollback, into `rcq routes`, and into whatever gets pasted when asking
  // for help.
  const raw = process.env.HTTPS_PROXY ?? process.env.https_proxy
  return url ? redactProxyUrl(url) : raw ? redactProxyUrl(raw) : 'proxy'
}

// -----------------------------------------------------------------
// Engaged state, and the rewrite that carries it
// -----------------------------------------------------------------

let engagedFront = false
let installed = false
/// `fetch` as it was before the front wrapper went on. Probing must never be
/// routed by the thing it is deciding.
let nativeFetch: typeof fetch = globalThis.fetch
/// True when the front was engaged on SOCKET evidence - sockets die moments
/// after opening while ordinary requests sail through. A TLS probe cannot see
/// that failure, so while this is set the probe must not vote the routing back
/// to direct.
let frontForSockets = false

export interface Route {
  rung: RungName
  proxy: string | null
  front: string | null
}

export function currentRoute(): Route {
  const proxy = activeProxyLabel()
  return {
    rung: proxy ? (engagedFront ? 'proxy+front' : 'proxy') : engagedFront ? 'front' : 'direct',
    proxy,
    front: engagedFront ? frontHost() : null,
  }
}

/// Human-readable, never carrying a password.
export function describeRoute(r: Route = currentRoute()): string {
  const parts = [r.proxy ?? 'direct']
  if (r.front) parts.push(`front ${r.front}`)
  return parts.join(' + ')
}

/// True when `url` names the flagship ORIGIN, not merely a host that starts
/// with its name.
///
/// ⚠ A bare `startsWith` is wrong and quietly so: `https://api.rcq.app.evil
/// .example/x` starts with `https://api.rcq.app`, and swapping that prefix
/// hands the path to `cdn.rcq.app.evil.example` - a host somebody else owns,
/// with an Authorization header on it. The origin has to end where the URL
/// says it ends, which is a `/`, a `?`, a `#`, or nothing at all.
/// (`src/lib/front.ts` has the same shape and the same hole; it is shared web
/// code, so it is reported rather than edited from here.)
function atOrigin(url: string, origin: string): boolean {
  if (!url.startsWith(origin)) return false
  const next = url.charAt(origin.length)
  return next === '' || next === '/' || next === '?' || next === '#'
}

function rewrite(url: string): string {
  if (!engagedFront) return url
  if (atOrigin(url, FLAGSHIP_HTTPS)) return `https://${frontHost()}` + url.slice(FLAGSHIP_HTTPS.length)
  if (atOrigin(url, FLAGSHIP_WSS)) return `wss://${frontHost()}` + url.slice(FLAGSHIP_WSS.length)
  // Anything else is another island, a resolver, a mirror. The front proxies
  // the flagship alone.
  return url
}

/// Wrap `fetch` and `WebSocket` once, so every caller follows the route the
/// moment it changes - including sockets the reconnect loop opens later.
///
/// ★ Rewriting at the transport edge rather than threading a base through the
/// app is deliberate, and it is the call front.ts already made for the web:
/// the base is read straight off `identity.apiBase` in twenty-odd places, and
/// any one of them missed is a request that still names the blocked host. On a
/// censored network that is a hang, not a clean failure.
///
/// ⚠ And like front.ts, this never touches `identity.apiBase` itself. That
/// value is persisted, so swapping it would eventually write the front in as
/// the user's island - permanently, outliving whatever blocked them.
///
/// The proxy needs nothing here. It lives in the process environment and Node
/// applies it under both of these.
export function installRouting(): void {
  if (installed) return
  installed = true

  // Whatever bootstrap.ts left in place, deadline and all.
  nativeFetch = globalThis.fetch
  const beneath = nativeFetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const asUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    const moved = rewrite(asUrl)
    if (moved === asUrl) return beneath(input, init)
    // A Request carries headers, body and mode that must survive; rebuilding
    // it around a new URL is the only way to redirect one.
    if (input instanceof Request) return beneath(new Request(moved, input), init)
    return beneath(moved, init)
  }) as typeof fetch

  const NativeWebSocket = globalThis.WebSocket
  const Routed = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    // A constructor returning an object hands that object back.
    return new NativeWebSocket(rewrite(typeof url === 'string' ? url : url.toString()), protocols)
  } as unknown as typeof WebSocket
  Routed.prototype = NativeWebSocket.prototype
  // The readyState constants are read off the constructor (`WebSocket.OPEN`),
  // so a wrapper that drops them breaks callers silently.
  Object.defineProperties(Routed, {
    CONNECTING: { value: NativeWebSocket.CONNECTING },
    OPEN: { value: NativeWebSocket.OPEN },
    CLOSING: { value: NativeWebSocket.CLOSING },
    CLOSED: { value: NativeWebSocket.CLOSED },
  })
  globalThis.WebSocket = Routed
}

/// Test hook: put the front on or off without probing for it.
///
/// Nothing in the client calls this. The front is engaged by [walkLadder] on
/// evidence and by [escalateForDeadSockets] on a run of dead sockets, and both
/// of those need a network to mean anything - while the rewrite itself is pure
/// and is the piece that must not have a hole in it, because a caller it
/// misses is a request that still names the blocked host.
export function setFrontEngagedForTest(on: boolean): void {
  engagedFront = on
  frontForSockets = false
}

// -----------------------------------------------------------------
// Probes
// -----------------------------------------------------------------

/// TCP connect plus a completed TLS handshake, both inside `budgetMs`.
///
/// Asks the question the way the phones ask it. DPI kills the handshake, so
/// nothing is given away on sensitivity; what goes away is the false positive
/// of a full `GET /health` timing out on a network that is merely slow.
/// Certificate validation is left ON: an intercepting middlebox is not a route
/// to our island either.
///
/// ⚠ Raw sockets, so this does NOT go through the user's proxy. It is only
/// ever used when no proxy is engaged; [probeViaRequest] is the proxied twin.
///
/// `authorized` is judged by the store this process runs with, which under
/// the trust exec (env-proxy.ts) includes every pinned island: a fingerprint
/// island answers "reachable" here only once the trust gate has let it in,
/// and the gate runs before this ladder for that reason.
function tlsReachable(host: string, port: number, budgetMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        sock.destroy()
      } catch {
        /* already gone */
      }
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), budgetMs)
    // SNI carries names only; Node warns on an IP literal and ignores it.
    const sock = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host })
    sock.once('secureConnect', () => finish(sock.authorized))
    sock.once('error', () => finish(false))
  })
}

/// ⚠ The island's own port, not 443. Hard-coded 443 reported every island on
/// `:8443` as blocked, cost fifteen seconds of probing per cold minute, and
/// wrote it down as a route that answered nothing.
async function probeHost(host: string, port: number): Promise<boolean> {
  for (const budget of TLS_BUDGETS_MS) {
    if (await tlsReachable(host, port, budget)) return true
  }
  return false
}

/// Does `base` answer through whatever transport this process was started
/// with? A real request, because through a proxy a socket that opens proves
/// nothing about the circuit behind it - and because a raw TLS handshake would
/// walk straight past the proxy and measure the wrong thing.
async function probeViaRequest(base: string): Promise<boolean> {
  try {
    const res = await nativeFetch(`${base}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(PROXY_PROBE_MS),
    })
    return res.ok
  } catch {
    return false
  }
}

function hostPortOf(apiBase: string): { host: string; port: number } {
  try {
    const u = new URL(apiBase)
    // `hostname` keeps an IPv6 literal's brackets; the socket wants it bare.
    return { host: u.hostname.replace(/^\[|\]$/g, ''), port: u.port ? Number(u.port) : 443 }
  } catch {
    return { host: apiBase.replace(/^https?:\/\//, '').replace(/\/.*$/, ''), port: 443 }
  }
}

function isFlagship(apiBase: string): boolean {
  return apiBase.replace(/\/+$/, '') === FLAGSHIP_HTTPS
}

// -----------------------------------------------------------------
// The walk
// -----------------------------------------------------------------

/// Walk the ladder against `apiBase` and engage whatever answered. The record
/// is written down so `rcq routes` can show it from another process.
export async function walkLadder(apiBase: string): Promise<LadderWalk> {
  prepare()
  const walk: LadderWalk = { at: Date.now(), apiBase, chosen: null, rungs: [] }
  const proxied = proxyActive()
  const flagship = isFlagship(apiBase)
  const islandRung: RungName = proxied ? 'proxy' : 'direct'
  const frontRung: RungName = proxied ? 'proxy+front' : 'front'

  // The island's own address first, with the front OFF so the answer is about
  // the island. Through a proxy that is the proxy rung; without one it is the
  // direct rung. Either way it is the road we prefer.
  engagedFront = false
  frontForSockets = false
  const t0 = Date.now()
  const { host, port } = hostPortOf(apiBase)
  const islandOk = proxied ? await probeViaRequest(apiBase) : await probeHost(host, port)
  if (islandOk) {
    walk.rungs.push({ rung: islandRung, verdict: 'ok', ms: Date.now() - t0 })
    walk.rungs.push({ rung: frontRung, verdict: 'not-tried' })
    walk.chosen = islandRung
    record(walk)
    return walk
  }
  walk.rungs.push({ rung: islandRung, verdict: 'blocked', ms: Date.now() - t0 })

  if (!flagship) {
    walk.rungs.push({ rung: frontRung, verdict: 'skipped', detail: 'not the flagship island' })
    record(walk)
    return walk
  }

  const t1 = Date.now()
  const frontOk = proxied ? await probeViaRequest(`https://${frontHost()}`) : await probeHost(frontHost(), 443)
  if (frontOk) {
    engagedFront = true
    walk.rungs.push({ rung: frontRung, verdict: 'ok', ms: Date.now() - t1 })
    walk.chosen = frontRung
  } else {
    walk.rungs.push({ rung: frontRung, verdict: 'blocked', ms: Date.now() - t1 })
    // Both roads are shut. Stay on the island's own name rather than pinning
    // every request to a front that is also blocked, which would only add a
    // timeout to each failure. What is left to offer the person is a proxy,
    // which is what `rcq routes` prints at this point.
  }
  record(walk)
  return walk
}

function prepare(): void {
  primeRelayConfig()
  // Keep the shared multihome guard ("is this host a front, i.e. a road and
  // not an island?") pointed at the same name this ladder uses. A front
  // registered as a backup home is the flagship's own mailbox under another
  // name, and the redundancy it promises is fiction.
  setFrontHost(`https://${frontHost()}`)
  // And the trust rule's: a road is never pinned, wherever the signed config
  // moves it.
  addCaOnlyHost(frontHost())
  installRouting()
}

function record(walk: LadderWalk): void {
  const fallback: RungName = proxyActive() ? 'proxy' : 'direct'
  saveRoutesState({
    last: walk,
    sticky: walk.chosen
      ? { rung: walk.chosen, at: walk.at }
      : { rung: fallback, at: walk.at, cold: true },
  })
}

/// The last walk, for `rcq routes` in a process that did not do one.
export function lastWalk(): LadderWalk | null {
  return loadRoutesState().last ?? null
}

/// One rung of a walk as a padded line. The verdict translates; the rung name
/// and the milliseconds are data and stay bare, so a pipe reads the same bytes
/// in any language. Shared by `rcq routes` and the interactive `/routes`.
export function describeRung(r: RungResult): string {
  const verdict = tr(
    r.verdict === 'ok'
      ? 'routes.ok'
      : r.verdict === 'blocked'
        ? 'routes.blocked'
        : r.verdict === 'skipped'
          ? 'routes.skipped'
          : 'routes.notTried',
  )
  const ms = r.ms === undefined ? '' : `  ${r.ms}ms`
  return `  ${r.rung.padEnd(12)} ${verdict}${ms}${r.detail ? `  (${r.detail})` : ''}`
}

/// Bring the route up for `apiBase` before anything talks to the island.
///
/// Cheap by design: a decision younger than STICKY_TTL_MS is re-engaged
/// without a single probe, which is what keeps `rcq send` in a cron loop from
/// paying a handshake every minute. `force` walks regardless.
export async function ensureRoute(apiBase: string, force = false): Promise<Route> {
  prepare()
  const sticky = loadRoutesState().sticky
  const fresh =
    !force && sticky && Date.now() - sticky.at < (sticky.cold ? COLD_TTL_MS : STICKY_TTL_MS)
  if (fresh) {
    // A saved decision that no longer matches how this process was started (a
    // proxy set or cleared since) is not a decision about this run.
    const stickyProxied = sticky.rung === 'proxy' || sticky.rung === 'proxy+front'
    if (stickyProxied === proxyActive()) {
      engagedFront = sticky.rung === 'front' || sticky.rung === 'proxy+front'
      frontForSockets = false
      return currentRoute()
    }
  }
  await walkLadder(apiBase)
  return currentRoute()
}

/// Forget the sticky decision, so the next command walks the ladder again.
/// For a failure at the TRANSPORT level (connection refused, TLS error,
/// timeout) rather than an HTTP status: an island that answers 500 is
/// reachable, one that does not answer at all may not be.
export function noteRouteTrouble(): void {
  saveRoutesState({ sticky: null })
}

/// Escalate on socket evidence alone, the way front.ts does for the web: after
/// a run of sockets that died moments after opening while ordinary requests
/// were fine. The TLS probe is structurally unable to see that failure - it is
/// the signature of a middlebox that passes handshakes and kills streams.
///
/// direct -> front on the first streak; if sockets keep dying THROUGH the
/// front, the next streak hands the routing back, so a network where neither
/// road works idles at the ordinary backoff pace instead of thrashing.
///
/// Returns true when the route changed and the caller should redial.
export async function escalateForDeadSockets(apiBase: string): Promise<boolean> {
  if (!isFlagship(apiBase)) return false
  const proxied = proxyActive()
  if (engagedFront) {
    if (!frontForSockets) return false
    engagedFront = false
    frontForSockets = false
    saveRoutesState({ sticky: { rung: proxied ? 'proxy' : 'direct', at: Date.now() } })
    if (process.env.RCQ_VERBOSE) process.stderr.write('[route] sockets die via the front too, back to direct\n')
    return true
  }
  const reachable = proxied ? await probeViaRequest(`https://${frontHost()}`) : await probeHost(frontHost(), 443)
  if (!reachable) return false
  engagedFront = true
  frontForSockets = true
  saveRoutesState({ sticky: { rung: proxied ? 'proxy+front' : 'front', at: Date.now() } })
  if (process.env.RCQ_VERBOSE) {
    process.stderr.write(`[route] sockets keep dying while HTTPS answers, routing via ${frontHost()}\n`)
  }
  return true
}

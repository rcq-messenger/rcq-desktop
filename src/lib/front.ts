// Cloudflare front for the flagship island.
//
// The phones have had this layer for months: probe the island directly, and if
// it does not answer, send the same requests to a Cloudflare-fronted name that
// proxies to it. Only the transport address changes — same island, same
// identity, same keys. The desktop had NO such layer at all. Its only answer to
// a blocked island was the sing-box tunnel, which on this platform cannot be
// applied to a running window: wry fixes a webview's proxy when the webview is
// created, so engaging the tunnel means asking the user to relaunch.
//
// The front has none of that problem. It is a hostname, and a page can change
// the hostname it talks to at any moment. So this is the ONE circumvention
// layer the desktop can do fully, mid-session, with no sidecar and no relaunch
// — which makes it the first thing to reach for here, not the last.
//
// ★ Why this rewrites `fetch`/`WebSocket` instead of threading a base through
// the app: the base is read straight off `identity.apiBase` in twenty-odd
// places (API calls, media, avatars, QR, diagnostics), and any one of them
// missed is a request that still names the blocked host — on a censored network
// that is a hang, not a clean failure. Rewriting one exact origin at the
// transport edge cannot miss a caller.
//
// ⚠ And it deliberately does NOT touch `identity.apiBase` itself. That value is
// persisted (`persistIdentity` writes it back to localStorage, from seven call
// sites), so swapping it would eventually write the front in as the user's
// island — permanently, surviving the end of whatever blocked them.

/// The flagship, as every identity records it and as the code names it.
const FLAGSHIP_HTTPS = 'https://api.rcq.app'
const FLAGSHIP_WSS = 'wss://api.rcq.app'

/// Compiled-in front. Overridable by the signed relay config so the front can
/// be moved off the `rcq.app` apex without shipping a build — the apex is one
/// SNI rule away from taking the island and the front together.
const DEFAULT_FRONT = 'https://cdn.rcq.app'

let frontHttps = DEFAULT_FRONT
let engaged = false
let installed = false
/// True when the front was engaged on SOCKET evidence (sockets die moments
/// after opening while HTTPS answers). The regular health probe cannot see
/// that failure — `/health` is one HTTPS request — so while this is set the
/// probe must not vote the routing back to direct.
let engagedForSockets = false

/// True while requests to the flagship are being sent to the front instead.
export function frontEngaged(): boolean {
  return engaged
}

/// The front host in use, for diagnostics.
export function frontHost(): string {
  return frontHttps.replace(/^https:\/\//, '')
}

/// Point the front at a different name. Called with whatever the signed relay
/// config names; ignored unless it is an https URL, so a malformed payload
/// leaves the compiled-in name in place rather than breaking the fallback.
export function setFrontHost(url: string | null | undefined) {
  if (!url || !url.startsWith('https://')) return
  frontHttps = url.replace(/\/+$/, '')
}

/// True when `host` names a known CDN front of the flagship — a ROAD to the
/// island, never an island. Covers the compiled-in name and whatever the
/// signed config moved the front to. Multihoming must ask this everywhere it
/// meets a host: a front registered as a "backup home" is the flagship's own
/// mailbox by another name, so the redundancy it promises is fiction — and
/// its drain rides the same "primary" queue cursor as a legacy session,
/// advancing it fetch-by-fetch with no ack (founder's #911 carried exactly
/// this phantom, along with 24 other accounts).
export function isFrontHost(host: string | null | undefined): boolean {
  if (!host) return false
  const h = host.trim().toLowerCase()
  return (
    h === frontHttps.replace(/^https:\/\//, '').toLowerCase() ||
    h === DEFAULT_FRONT.replace(/^https:\/\//, '').toLowerCase()
  )
}

function rewrite(url: string): string {
  if (!engaged) return url
  if (url.startsWith(FLAGSHIP_HTTPS)) {
    return frontHttps + url.slice(FLAGSHIP_HTTPS.length)
  }
  if (url.startsWith(FLAGSHIP_WSS)) {
    return frontHttps.replace(/^https:/, 'wss:') + url.slice(FLAGSHIP_WSS.length)
  }
  // Anything else is another island, a relay, or an unrelated host. The front
  // only proxies the flagship, so sending someone else's island through it
  // would turn a working custom server into a 404.
  return url
}

/// Wrap `fetch` and `WebSocket` once, so every caller follows the front the
/// moment it engages — including sockets opened later by the reconnect loop.
export function installFrontRouting() {
  if (installed) return
  installed = true

  const nativeFetch = window.fetch.bind(window)
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string') return nativeFetch(rewrite(input), init)
    if (input instanceof URL) return nativeFetch(rewrite(input.toString()), init)
    // A Request carries headers, body and mode that must survive; rebuilding it
    // around a new URL is the only way to redirect one.
    if (input instanceof Request) {
      const moved = rewrite(input.url)
      return moved === input.url ? nativeFetch(input, init) : nativeFetch(new Request(moved, input), init)
    }
    return nativeFetch(input as RequestInfo, init)
  }) as typeof window.fetch

  const NativeWebSocket = window.WebSocket
  const Wrapped = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    return new NativeWebSocket(rewrite(typeof url === 'string' ? url : url.toString()), protocols)
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

async function reachable(base: string, timeoutMs: number): Promise<boolean> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    // Deliberately the NATIVE fetch by way of an absolute URL that rewrite()
    // leaves alone while `engaged` is false — probing must never be routed by
    // the thing it is deciding.
    const res = await fetch(`${base}/health`, { cache: 'no-store', signal: ctl.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/// Decide whether to route through the front. Direct is always preferred and
/// always re-checked, so a network that stops blocking recovers on its own
/// rather than leaving the user on the front forever.
///
/// Returns true when the front is now carrying traffic.
export async function refreshFrontRouting(): Promise<boolean> {
  // Engaged on socket evidence: the HTTPS probe below would say "direct is
  // fine" — that is exactly the lie that kept the ladder off while every
  // socket died. Only `escalateForDeadSockets` may end this engagement.
  if (engaged && engagedForSockets) return true
  const wasEngaged = engaged
  // Probe direct with the front OFF, so the answer is about the island.
  engaged = false
  if (await reachable(FLAGSHIP_HTTPS, 5000)) {
    if (wasEngaged) console.info('[front] island reachable again — back to direct')
    return false
  }
  if (await reachable(frontHttps, 5000)) {
    engaged = true
    if (!wasEngaged) console.info(`[front] island unreachable — routing via ${frontHost()}`)
    return true
  }
  // Neither answered. Stay direct: the tunnel is the next layer, and pinning
  // requests to a front that is also blocked would only add a timeout to every
  // one of them.
  return false
}

/// Escalate on socket evidence alone. Called by the socket layer after every
/// third consecutive socket that died moments after opening — the signature of
/// a middlebox that passes HTTPS and kills WebSocket streams, which the
/// `/health` probe above is structurally unable to notice.
///
/// Direct → front on the first streak; if sockets keep dying THROUGH the
/// front, the next streak hands the routing back to direct — each leg of that
/// alternation is three dead sockets long, so a network where neither road
/// works idles at the ordinary backoff pace rather than thrashing.
///
/// Returns true when the front is now carrying traffic.
export async function escalateForDeadSockets(): Promise<boolean> {
  if (engaged) {
    if (engagedForSockets) {
      engaged = false
      engagedForSockets = false
      console.info('[front] sockets die via the front too — back to direct')
    }
    return engaged
  }
  if (await reachable(frontHttps, 5000)) {
    engaged = true
    engagedForSockets = true
    console.info(`[front] sockets keep dying while HTTPS answers — routing via ${frontHost()}`)
    return true
  }
  return false
}

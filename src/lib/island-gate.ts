// A private island's gateway key, page side: how it is sent and how it is
// earned. Desktop only; every export is a no-op or a refusal in a browser.
//
// A masquerade island (backend/app/routers/gate.py) answers every request
// without a valid `X-RCQ-Auth` header with a decoy site: not a 401, a
// different site altogether, so that an outsider cannot tell an island from
// a blog. The phones stamp the header on every request to a host that has a
// key (Android's OkHttp interceptor in net/AccessToken.kt, iOS's
// `APIClient.setServerToken`). The web had nothing: no field, no header, so a
// private island could not be reached from a desktop at all, and the
// hand-typed address behind it was one more thing the picker lost (founder,
// 12.09).
//
// Done the way front.ts and island-trust.ts do it: `fetch` is wrapped ONCE at
// the transport edge, so the twenty-odd bare `fetch` calls that dial an
// island (register, recover, refresh, /server/info, the logo blob, the guest
// and backup paths) all carry the key without each of them knowing. The
// wrapper is installed AFTER the trust wrapper so it sees the original URL,
// stamps by EXACT authority (`host:port`, the same rule as the Android
// interceptor and iOS's `DepositAuthStore.stamp`), and the trust layer under
// it may then move the request to loopback with the header intact.
//
// ⚠ Known limit, not solved here: the browser cannot put a header on a
// WebSocket upgrade, so the socket to a gated island still meets the decoy
// until either the loopback bridge stamps it (src-tauri/src/island_trust.rs,
// the plan's preferred road) or /gate/check learns to read the key from the
// subprotocol Caddy copies. REST works, which is what the picker, the
// register and the recover need; presence over the socket does not yet.
//
// ⚠⚠ THE KEY IS A SECRET and this file is the only reader of it. It lives in
// the account rows (auth.ts `islandGatewayKey`), which the desktop PIN vault
// seals; never in `rcq.web.islands.v1`, never in `rcq.island.*`, never in the
// catalogue cache, never in a URL or a query string, never rendered. The
// browser build gets no field at all: localStorage there is readable by any
// script on the page (auth.ts, storage caveat), and the socket could not use
// the key anyway.

import { forgetIslandGatewayKey, hasIslandGatewayKey, installId, islandGatewayKey, setIslandGatewayKey } from './auth'
import { isTauri } from './desktop'

const HEADER = 'X-RCQ-Auth'

/// `host:port` of an island URL, lowercased, the port explicit. Null for
/// anything that is not an http(s) or ws(s) URL.
export function gateAuthority(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const plain = u.protocol === 'http:' || u.protocol === 'ws:'
  const secure = u.protocol === 'https:' || u.protocol === 'wss:'
  if (!plain && !secure) return null
  const port = u.port ? Number(u.port) : plain ? 80 : 443
  return `${u.hostname.toLowerCase()}:${port}`
}

/// Is there a key on file for this island? Read at render time by the
/// remembered card, which draws a lock glyph and nothing else from it.
export function gatewayKeyOnFile(base: string): boolean {
  if (!isTauri()) return false
  const authority = gateAuthority(base)
  return authority != null && hasIslandGatewayKey(authority)
}

export function forgetGatewayKey(base: string): void {
  const authority = gateAuthority(base)
  if (authority) forgetIslandGatewayKey(authority)
}

export type RedeemOutcome = 'ok' | 'no_gate' | 'bad' | 'offline'

/// Exchange the key a person pasted for this device's durable token
/// (POST /gate/redeem, the same call Android's `AccessRedeemer.redeem` makes)
/// and put it on file for the island's authority.
///
/// The outcomes mirror Android's: a clean 404 is an island with no gate at
/// all (an ordinary public island; nothing to store, the pick goes ahead),
/// a non-2xx or a body without a token is the gate refusing, or the decoy
/// answering in the gate's place, and a thrown fetch is the island not
/// answering. The device id is this install's own (32 hex), which is what
/// gate.py asks for.
export async function redeemGatewayKey(base: string, pasted: string): Promise<RedeemOutcome> {
  const key = pasted.trim()
  const authority = gateAuthority(base)
  if (!key || !authority || !isTauri()) return 'no_gate'
  try {
    const res = await fetch(`${base}/gate/redeem`, {
      method: 'POST',
      // The PASTED key rides this one request explicitly; the wrapper below
      // never overrides a header the caller set.
      headers: { 'Content-Type': 'application/json', [HEADER]: key },
      body: JSON.stringify({ device_id: installId() }),
    })
    if (res.status === 404) return 'no_gate'
    if (!res.ok) return 'bad'
    const out = (await res.json().catch(() => null)) as { token?: unknown } | null
    const durable = out?.token
    if (typeof durable !== 'string' || !durable) return 'bad'
    setIslandGatewayKey(authority, durable)
    return 'ok'
  } catch {
    return 'offline'
  }
}

let installed = false

/// Wrap `fetch` once so every request to an island with a key on file
/// carries it. Installed from main.tsx after `installIslandTrust`, so this
/// layer runs first and the trust layer's loopback rewrite keeps the header.
export function installIslandGate(): void {
  if (installed || !isTauri()) return
  installed = true
  const under = window.fetch.bind(window)
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input instanceof Request ? input.url : null
    const authority = url == null ? null : gateAuthority(url)
    if (!authority) return under(input, init)
    const key = islandGatewayKey(authority)
    if (!key) return under(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (headers.has(HEADER)) return under(input, init)
    headers.set(HEADER, key)
    return under(input, { ...init, headers })
  }) as typeof window.fetch
}

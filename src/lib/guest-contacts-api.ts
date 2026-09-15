// Contact-request calls on a VISITED island, made as our guest copy there
// (spec 2026-09-15, F1).
//
// `Api.request` is bound to the home island's apiBase and ends the session on
// a 401, which is the wrong thing twice over for a guest token: it names
// somebody else's island, and it is memory-only, so after a restart the first
// call is answered 401 by design. These go straight to `https://<host>` with
// the guest token and re-prove the key once on a 401, the same rule the
// visited drain follows.
//
// The answer is returned whole (status, refusal code, how long to wait)
// rather than thrown: every caller decides by the exact code, and "the island
// could not be reached" is null, a different thing from any status.

import { parseErrorCode, parseRetryAfter } from './api'
import type { WebIdentity } from './crypto'
import { ensureGuestAuth, refreshGuestAuth } from './visited-islands'

export interface GuestCall {
  status: number
  /// The refusal code, for a non-2xx answer that carries one.
  code: string | null
  /// Seconds the island asked us to wait, when it said and we could read it.
  /// A browser usually cannot read `Retry-After` across origins (the island
  /// exposes only `ETag`), so this is often null even on a 429.
  retryAfterSec: number | null
  json: unknown
}

/// One whole call: headers AND body. ⚠ The timer must outlive `fetch()`, which
/// resolves when the headers arrive; an island that sends headers and then
/// trickles the body would otherwise hold the caller forever.
const CALL_TIMEOUT_MS = 15_000
/// The most body read from a visited island. A real pending list is a few
/// kilobytes; anything past this is not one, and the call reads as failed.
const MAX_BODY_BYTES = 256 * 1024

/// The body as text, or null past `MAX_BODY_BYTES`. Aborts with the call's
/// signal like the fetch itself.
async function readCapped(res: Response): Promise<string | null> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      void reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    buf.set(c, off)
    off += c.byteLength
  }
  return new TextDecoder().decode(buf)
}

async function guestCall(
  identity: WebIdentity,
  host: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<GuestCall | null> {
  const ident = await ensureGuestAuth(identity, host).catch(() => null)
  if (!ident?.jwt) return null
  const send = async (jwt: string): Promise<{ res: Response; text: string | null }> => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), CALL_TIMEOUT_MS)
    try {
      const res = await fetch(`https://${host}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${jwt}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: ctl.signal,
      })
      if (res.status === 401) {
        void res.body?.cancel().catch(() => {})
        return { res, text: '' }
      }
      return { res, text: await readCapped(res) }
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    let { res, text } = await send(ident.jwt)
    if (res.status === 401) {
      const fresh = await refreshGuestAuth(identity, host)
      if (!fresh?.jwt) return { status: 401, code: null, retryAfterSec: null, json: null }
      ;({ res, text } = await send(fresh.jwt))
    }
    // Oversized: not an answer this client believes, the same as no answer.
    if (text === null) return null
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      /* not JSON: the status is the answer */
    }
    const header = Number(res.headers.get('Retry-After'))
    const retryAfterSec = Number.isFinite(header) && header > 0 ? Math.ceil(header) : parseRetryAfter(text)
    return { status: res.status, code: res.ok ? null : parseErrorCode(text), retryAfterSec, json }
  } catch {
    return null
  }
}

/// `GET /contacts/pending` on `host`: the requests addressed to our copy there.
export function listPendingOn(identity: WebIdentity, host: string): Promise<GuestCall | null> {
  return guestCall(identity, host, 'GET', '/contacts/pending')
}

/// `DELETE /contacts/pending/{id}` on `host`. Only ever called for an island
/// that advertises `contact_pending_withdraw`.
export function withdrawPendingOn(identity: WebIdentity, host: string, id: number): Promise<GuestCall | null> {
  return guestCall(identity, host, 'DELETE', `/contacts/pending/${id}`)
}

/// `POST /contacts/respond` on `host`. Used for an honest decline only: an
/// accept there would write contact edges on that island between the requester
/// and a copy nobody uses.
export function respondOn(identity: WebIdentity, host: string, id: number, accept: boolean): Promise<GuestCall | null> {
  return guestCall(identity, host, 'POST', '/contacts/respond', { request_id: id, accept })
}

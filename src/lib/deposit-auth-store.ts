// F3 deposit-auth client: mints and keeps a small reserve of anonymous blinded
// deposit tokens (blind-token.ts), one island at a time. A port of Android's
// `net/DepositAuthStore.kt`; see `RCQ/docs/deposit-auth-design.md` and
// `rcq-server-ref app/routers/deposit_auth.py`.
//
// Flow per island: GET /deposit-auth/params (epoch pubkey + PoW difficulty),
// prepare a random token, blind it, solve the SHA-256 hashcash bound to the
// blinded value, POST /deposit-auth/issue, unblind. A token is spent once;
// what it buys today is a peer's prekey bundle fetched with no session token
// (core-metadata plan, Stage 3): the island verifies a signature it cannot
// link to the mint, and so never learns whose keys we asked for.
//
// Tokens are minted a BATCH at a time into an in-memory reserve, which refills
// in the background once a token is taken, so a session start pays the PoW
// once and the fetches after it pay nothing. The first token of a batch is
// handed over the moment it lands (the caller never waits for the whole
// batch), and the reserve is pre-warmed at session start (prewarm) so the
// first bundle fetch usually pays nothing at all. The solver yields between
// slices (see solvePow), so the page stays responsive while it runs. One mint
// per island at a time; a second caller joins the run in flight. Best-effort:
// an island that issues no tokens, or a mint that fails, yields null, and the
// caller makes the request the legacy authenticated way.
//
// Epochs: every token carries the epoch it was minted under and dies with it.
// forget() and giveBack() compare a token's epoch with the cached params, so
// a 403 on a token of an epoch already rotated out does not throw away the
// fresh reserve, and a token of a dead epoch is never put back.
//
// In-memory only, never persisted: a reserve is cheap to re-mint, the tokens
// die with the issuer epoch anyway, and a token on disk is a token that
// outlives the session it was minted for.

import { blind, finalize, os2ip, prepare, solvePow, type IssuerKey } from './blind-token'
import { b64ToBytes, bytesToB64 } from './crypto'

/// The `{epoch_id, prepared, sig}` object a sealed deposit carries in its body
/// and a bundle fetch carries, base64url-encoded, in `X-Deposit-Token`.
export interface DepositToken {
  epoch_id: string
  prepared: string
  sig: string
}

/// How many tokens the reserve is topped up to.
const BATCH = 4

/// How long an island that answered 404 on /params (it issues no tokens) is
/// left alone before it is asked again. Long enough that such an island does
/// not cost a round trip per message, short enough that an upgrade is noticed
/// within the run. Cleared early by forget().
const DISABLED_MS = 10 * 60_000

/// How long the island is left alone after a mint FAILED (the issue answered
/// an error, the transport dropped, the signature did not verify) or after it
/// refused a freshly minted token twice in a row. Shorter than the 404 rest:
/// this is an island that is supposed to work and may be one reconnect away,
/// but every attempt in between costs a full proof-of-work, and a room of
/// peers would otherwise pay one or two per device before each authenticated
/// fallback.
const MINT_REST_MS = 90_000

/// How many times one top-up run may re-read the params after they rotated
/// under it (a 409 on issue, or a forget() from a 403 on spend) before it
/// gives up. Rotation is rare; an island that keeps rotating is broken, and
/// each round costs a proof-of-work.
const MAX_PARAM_RELOADS = 2

const REQUEST_TIMEOUT_MS = 15_000

interface Params {
  epochId: string
  key: IssuerKey
  difficulty: number
}

interface HostState {
  params: Params | null
  reserve: DepositToken[]
  /// The top-up in flight, if any: one per island at a time.
  minting: Promise<void> | null
  /// Callers waiting for the next token to land (or the mint to give up).
  waiters: Array<() => void>
  disabledUntil: number
}

const hosts = new Map<string, HostState>()

function stateFor(apiBase: string): HostState {
  let st = hosts.get(apiBase)
  if (!st) {
    st = { params: null, reserve: [], minting: null, waiters: [], disabledUntil: 0 }
    hosts.set(apiBase, st)
  }
  return st
}

function wake(st: HostState): void {
  const waiters = st.waiters
  st.waiters = []
  for (const w of waiters) w()
}

// Plain AbortController, as everywhere else in this tree: AbortSignal.timeout
// is still missing from older webviews this page runs in.
function fetchWithTimeout(url: string, init: RequestInit, ms = REQUEST_TIMEOUT_MS): Promise<Response> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  return fetch(url, { ...init, signal: ctl.signal }).finally(() => clearTimeout(timer))
}

function b64UrlToBytes(u: string): Uint8Array {
  const s = u.replace(/-/g, '+').replace(/_/g, '/')
  return b64ToBytes(s + '='.repeat((4 - (s.length % 4)) % 4))
}

function bytesToB64Url(b: Uint8Array): string {
  return bytesToB64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/// Take a token for `apiBase`, minting when the reserve is empty. Null when the
/// island issues none, is resting after a failure with nothing left in the
/// reserve, or the mint failed; the caller then falls back to the
/// authenticated request. Waits for the FIRST token of a batch only, so a cold
/// start costs one proof-of-work, not four; the rest of the batch lands in the
/// background. A token already in the reserve is handed out even while the
/// island rests: the rest is about not MINTING, and the token was paid for.
export async function takeToken(apiBase: string): Promise<DepositToken | null> {
  const st = stateFor(apiBase)
  while (st.reserve.length === 0) {
    if (Date.now() < st.disabledUntil) return null
    const mint = topUp(st, apiBase)
    await Promise.race([mint, new Promise<void>((resolve) => st.waiters.push(resolve))])
    if (st.reserve.length === 0 && !st.minting) return null
  }
  const token = st.reserve.shift()!
  if (st.reserve.length < BATCH) void topUp(st, apiBase)
  return token
}

/// Start one background batch for `apiBase` if the reserve is short, so the
/// first bundle fetch of the session finds a token waiting instead of paying
/// the proof-of-work in line. Called once the island's capabilities say it
/// takes tokens; a no-op while a mint is in flight, the reserve is full or
/// the island rests.
export function prewarm(apiBase: string): void {
  const st = stateFor(apiBase)
  if (st.reserve.length < BATCH) void topUp(st, apiBase)
}

/// Put back a token the island never VERIFIED: a bundle fetch that answered
/// 404 or 429, or whose transport failed, never reached the verifier, and the
/// token is as good as new. Goes to the front so it is the next one used.
/// Only while its epoch is still the cached one: a token of an epoch that
/// rotated out in the meantime is dead, and putting it back would only buy
/// the next fetch a 403.
export function giveBack(apiBase: string, token: DepositToken): void {
  const st = stateFor(apiBase)
  if (st.params?.epochId !== token.epoch_id) return
  st.reserve.unshift(token)
}

/// A spend answered 403 with `refused`: the epoch rotated under us (every
/// token minted under the old key is dead with it) or the island stopped
/// issuing. Drop the cached params and the reserve, and clear any rest, so
/// the next takeToken re-reads the params and mints afresh. Epoch-aware: when
/// the cached params are already NEWER than the refused token (another fetch
/// rotated them a moment ago, and the reserve was cleared with them), they
/// stay; only a straggler of the refused epoch is weeded out.
export function forget(apiBase: string, refused: DepositToken): void {
  const st = stateFor(apiBase)
  if (st.params && st.params.epochId !== refused.epoch_id) {
    st.reserve = st.reserve.filter((t) => t.epoch_id !== refused.epoch_id)
    return
  }
  st.params = null
  st.reserve = []
  st.disabledUntil = 0
}

/// Leave the island alone for MINT_REST_MS: a mint failed, or it refused a
/// fresh token twice. Tokens already in the reserve stay usable.
export function rest(apiBase: string): void {
  stateFor(apiBase).disabledUntil = Date.now() + MINT_REST_MS
}

/// The `X-Deposit-Token` header value: base64url, no padding, of the token
/// JSON. The island decodes with padding tolerance, so the unpadded form is
/// the canonical one.
export function headerValue(token: DepositToken): string {
  const json = JSON.stringify({ epoch_id: token.epoch_id, prepared: token.prepared, sig: token.sig })
  return bytesToB64Url(new TextEncoder().encode(json))
}

/// Mint until the reserve holds BATCH tokens. One run per island at a time; a
/// second caller joins the run in flight. Every token that lands wakes the
/// callers waiting in takeToken.
///
/// A token is pushed only while the params it was minted under are still the
/// cached ones. A forget() from a 403 elsewhere, or a 409 on issue, can land
/// while a mint is in flight; the token that then comes back belongs to a
/// dead epoch, and pushing it would hand the very next fetch a 403 (the retry
/// the contract asks for would then spend a dead token and fall back to the
/// session token). Dropped instead, and the run re-reads the params and goes
/// on, so the caller waiting in takeToken gets a token of the new epoch.
function topUp(st: HostState, apiBase: string): Promise<void> {
  if (st.minting) return st.minting
  st.minting = (async () => {
    try {
      for (let reloads = 0; reloads <= MAX_PARAM_RELOADS; reloads++) {
        if (Date.now() < st.disabledUntil) return
        const p = await ensureParams(st, apiBase)
        if (!p) return
        while (st.reserve.length < BATCH && st.params === p) {
          const token = await mintOne(st, apiBase, p)
          if (!token) break
          if (st.params !== p) break
          st.reserve.push(token)
          wake(st)
        }
        // Done, unless the params rotated under the run and the island is
        // not resting: then one more round, with fresh params.
        if (st.reserve.length >= BATCH || st.params === p) return
      }
    } catch (e) {
      console.warn('deposit-auth: mint failed:', e instanceof Error ? e.message : e)
      rest(apiBase)
    } finally {
      st.minting = null
      wake(st)
    }
  })()
  return st.minting
}

async function ensureParams(st: HostState, apiBase: string): Promise<Params | null> {
  if (st.params) return st.params
  const res = await fetchWithTimeout(`${apiBase}/deposit-auth/params`, {})
  if (res.status === 404) {
    // The island does not issue tokens. Remembered for a while so the next
    // fetch does not ask again.
    st.disabledUntil = Date.now() + DISABLED_MS
    return null
  }
  if (!res.ok) {
    rest(apiBase)
    return null
  }
  const o = (await res.json()) as {
    epoch_id?: string
    pubkey?: { n?: string; e?: number }
    pow?: { difficulty?: number }
  }
  if (typeof o.epoch_id !== 'string' || typeof o.pubkey?.n !== 'string' || typeof o.pubkey.e !== 'number') return null
  if (typeof o.pow?.difficulty !== 'number') return null
  const parsed: Params = {
    epochId: o.epoch_id,
    key: { n: os2ip(b64UrlToBytes(o.pubkey.n)), e: BigInt(o.pubkey.e) },
    difficulty: o.pow.difficulty,
  }
  st.params = parsed
  return parsed
}

async function mintOne(st: HostState, apiBase: string, p: Params): Promise<DepositToken | null> {
  const prepared = prepare()
  const b = blind(p.key, prepared)
  const blindedB64 = bytesToB64(b.blinded)
  const nonce = await solvePow(`${p.epochId}:${blindedB64}`, p.difficulty)
  const res = await fetchWithTimeout(`${apiBase}/deposit-auth/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ epoch_id: p.epochId, blinded: blindedB64, pow_nonce: nonce }),
  })
  if (res.status === 409) {
    // The epoch rotated between /params and /issue: the params are stale and
    // so is every token minted under them. The run re-reads them (topUp).
    if (st.params === p) {
      st.params = null
      st.reserve = []
    }
    return null
  }
  if (!res.ok) {
    // The island would not issue: a rest, so the next fetches take the
    // authenticated path at once instead of paying a proof-of-work each to
    // hear the same answer.
    rest(apiBase)
    return null
  }
  const o = (await res.json()) as { blind_sig?: string }
  if (typeof o.blind_sig !== 'string') {
    rest(apiBase)
    return null
  }
  const sig = finalize(p.key, b64ToBytes(o.blind_sig), b.blindInv, prepared)
  return { epoch_id: p.epochId, prepared: bytesToB64(prepared), sig: bytesToB64(sig) }
}

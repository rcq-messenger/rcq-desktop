// RCQ Federation Layer B (F1) — addressing + the self-signed home-island record.
//
// Pure functions only. NOTHING here is wired into a live send/receive path yet;
// this is the reference implementation of the wire formats in
// docs/federation-protocol.md that iOS and Android will mirror byte-for-byte.
//
// Trust model recap (see the spec §2.4): the record is Ed25519-signed by the
// account's `signing_key` (the v=1 sealed-sender signing key, the one primitive
// every client already has). It carries both that signing key (`sk`) and the
// libsignal identity key (`ik`, the safety-number key). A verifier checks the
// signature AND cross-checks `sk`/`ik` against keys it anchored independently
// (the peer's bundle + safety number). A mailbox or mirror can withhold or serve
// a stale-but-valid record; it can never forge one.

import { ed25519 } from '@noble/curves/ed25519'
import { bytesToB64, b64ToBytes } from './crypto'

/// Bare numbers resolve to the flagship island by convention (spec §1).
export const FLAGSHIP_HOST = 'api.rcq.app'

// ───────────────────────── addressing (spec §1) ─────────────────────────

export interface RcqAddress {
  uin: number
  host: string
}

const UIN_RE = /^[0-9]+$/
// RFC-3986-ish reg-name plus an optional :port. Deliberately strict: no spaces,
// no scheme, no path. We are parsing a host authority, not a URL.
const HOST_RE = /^[A-Za-z0-9.-]+(:[0-9]{1,5})?$/

/// Parse "777" -> {uin:777, host:flagship} and "777@host" -> {uin, host}.
/// Total and strict: anything that is not one of those two shapes throws, so a
/// caller never silently mis-routes. A bare all-digits string is always the
/// flagship handle, exactly as pre-federation clients already treat it.
export function parseAddress(input: string): RcqAddress {
  const s = input.trim()
  const at = s.indexOf('@')
  if (at === -1) {
    if (!UIN_RE.test(s)) throw new Error('invalid address: not a uin')
    return { uin: Number(s), host: FLAGSHIP_HOST }
  }
  const uinPart = s.slice(0, at)
  const host = s.slice(at + 1)
  if (!UIN_RE.test(uinPart)) throw new Error('invalid address: bad uin')
  if (!HOST_RE.test(host)) throw new Error('invalid address: bad host')
  return { uin: Number(uinPart), host: host.toLowerCase() }
}

/// Format for display/storage. The `@api.rcq.app` suffix is hidden by default
/// (flagship handles look like plain numbers); pass showFlagship to force it.
export function formatAddress(a: RcqAddress, opts?: { showFlagship?: boolean }): string {
  if (a.host === FLAGSHIP_HOST && !opts?.showFlagship) return String(a.uin)
  return `${a.uin}@${a.host}`
}

export function isFlagship(host: string): boolean {
  return host.toLowerCase() === FLAGSHIP_HOST
}

// ─────────────────── canonical JSON (spec §2.2) ───────────────────
// Byte-identical to the relay-config scheme (tools/sign-relay-config.py,
// RelayConfigStore.swift/.kt): object keys sorted recursively, compact
// separators, slashes and non-ASCII left unescaped, integers in shortest form,
// UTF-8. JSON.stringify already matches all of that once keys are pre-sorted:
// it emits no spaces, does not escape '/', preserves non-ASCII, and renders
// integers without a fractional part. Arrays keep their order (homes order is
// owner-meaningful); only object keys are sorted.

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortDeep((v as Record<string, unknown>)[k])
    }
    return out
  }
  return v
}

export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJSON(value))
}

// ─────────────────── the home-island record (spec §2) ───────────────────

export interface IslandHome {
  host: string
  uin: number
}

export interface HomeIslandRecord {
  v: 1
  ik: string // base64 libsignal identity key (safety-number key)
  sk: string // base64 Ed25519 signing_key (signs this record)
  homes: IslandHome[]
  ts: number // issued-at, Unix seconds
  sig: string // base64 Ed25519 signature over canonical(record without sig)
}

/// The exact subset of fields that gets signed, in the shape that canonicalizes.
/// Reconstructed explicitly (never "doc minus sig") so unknown/injected fields
/// can never enter the signed bytes.
function signedPart(r: { ik: string; sk: string; homes: IslandHome[]; ts: number }) {
  return {
    v: 1 as const,
    ik: r.ik,
    sk: r.sk,
    homes: r.homes.map((h) => ({ host: h.host, uin: h.uin })),
    ts: r.ts,
  }
}

/// Build and sign a record. `signingPriv` is the account's Ed25519 seed (32 raw
/// bytes, WebIdentity.signingPriv); `sk` must be the matching public
/// (bytesToB64(signingPub)); `ik` is base64 of signal_identity_key.
export function buildHomeIslandRecord(p: {
  ik: string
  sk: string
  signingPriv: Uint8Array
  homes: IslandHome[]
  ts: number
}): HomeIslandRecord {
  if (!p.homes.length) throw new Error('record needs at least one home')
  const part = signedPart(p)
  const sig = ed25519.sign(canonicalBytes(part), p.signingPriv)
  return { ...part, sig: bytesToB64(sig) }
}

export type VerifyResult =
  | { ok: true; record: HomeIslandRecord }
  | { ok: false; reason: string }

/// Verify a record per spec §2.4. The signature check alone proves only internal
/// consistency; pass expectedSk/expectedIk (anchored from the peer's bundle and
/// safety number) to actually bind it to the real peer, and minTs to reject a
/// rollback to a stale island list.
export function verifyHomeIslandRecord(
  doc: unknown,
  opts?: { expectedIk?: string; expectedSk?: string; minTs?: number },
): VerifyResult {
  const d = doc as Record<string, unknown>
  if (!d || d.v !== 1) return { ok: false, reason: 'unsupported version' }
  if (typeof d.ik !== 'string' || typeof d.sk !== 'string' || typeof d.sig !== 'string') {
    return { ok: false, reason: 'missing ik/sk/sig' }
  }
  if (!Number.isInteger(d.ts) || (d.ts as number) <= 0) {
    return { ok: false, reason: 'invalid ts' }
  }
  if (!Array.isArray(d.homes) || d.homes.length === 0) {
    return { ok: false, reason: 'missing homes' }
  }
  const homes: IslandHome[] = []
  for (const h of d.homes as unknown[]) {
    const he = h as Record<string, unknown>
    if (!he || typeof he.host !== 'string' || !Number.isInteger(he.uin)) {
      return { ok: false, reason: 'malformed home entry' }
    }
    homes.push({ host: he.host, uin: he.uin as number })
  }
  const part = signedPart({ ik: d.ik, sk: d.sk, homes, ts: d.ts as number })
  let valid = false
  try {
    valid = ed25519.verify(b64ToBytes(d.sig), canonicalBytes(part), b64ToBytes(d.sk))
  } catch {
    return { ok: false, reason: 'signature check threw' }
  }
  if (!valid) return { ok: false, reason: 'bad signature' }
  if (opts?.expectedSk && d.sk !== opts.expectedSk) return { ok: false, reason: 'sk not anchored' }
  if (opts?.expectedIk && d.ik !== opts.expectedIk) return { ok: false, reason: 'ik not anchored' }
  if (opts?.minTs != null && (d.ts as number) < opts.minTs) return { ok: false, reason: 'stale ts' }
  return { ok: true, record: { ...part, sig: d.sig } as HomeIslandRecord }
}

// ─────────────────── contact link / QR (spec §5) ───────────────────
// Backward compatible: the path stays a bare flagship UIN (old clients add the
// flagship handle), federation data rides in ignored query params
//   h = host, k = base64url Ed25519 signing_key (sk), i = base64url ik.

function b64ToUrl(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function urlToB64(u: string): string {
  const s = u.replace(/-/g, '+').replace(/_/g, '/')
  return s + '='.repeat((4 - (s.length % 4)) % 4)
}

/// Build the contact deep link. For a flagship contact with no keys this is
/// exactly today's `https://rcq.app/u/<uin>`.
export function buildContactLink(
  a: RcqAddress,
  keys?: { sk?: string; ik?: string },
  base = 'https://rcq.app',
  card?: string | null,
): string {
  const params = new URLSearchParams()
  if (!isFlagship(a.host)) params.set('h', a.host)
  if (keys?.sk) params.set('k', b64ToUrl(keys.sk))
  if (keys?.ik) params.set('i', b64ToUrl(keys.ik))
  const q = params.toString()
  // ⚠⚠ THE GUEST CARD GOES AFTER THE HASH, and that is the whole reason this
  // parameter exists separately from the three above. A fragment is never sent
  // to a server: not to rcq.app, not to whatever CDN is in front of it, not in
  // a Referer when the page navigates on. The card is a live credential with
  // no expiry, and everything else in this link is a PUBLIC key card, so the
  // two cannot share a home. Put it in the query and the credential lands in
  // an access log, which is how session tokens reached journald until 22.08.
  const frag = card ? `#c=${encodeURIComponent(card)}` : ''
  return `${base}/u/${a.uin}${q ? `?${q}` : ''}${frag}`
}

export interface ParsedContactLink {
  address: RcqAddress
  sk?: string // anchored Ed25519 signing_key, base64
  ik?: string // anchored identity key, base64
  /// A guest card the sharer put in the fragment, if any: what lets us reach
  /// them on a closed island. Never present on a link that came off a server.
  card?: string
}

/// Parse a scanned contact link. `uin` is the path segment; `search` is the raw
/// query string (with or without leading '?'). A link with no `h` is flagship.
export function parseContactLink(uin: string, search: string, hash = ''): ParsedContactLink {
  if (!UIN_RE.test(uin)) throw new Error('invalid contact link: bad uin')
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const host = params.get('h') || FLAGSHIP_HOST
  const address = parseAddress(`${uin}@${host}`)
  const k = params.get('k')
  const i = params.get('i')
  // The fragment, when the caller passed one. Bounded, because it arrives from
  // a scanned QR or a pasted string and ends up in a request header.
  const frag = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const c = (frag.get('c') || '').trim()
  return {
    address,
    sk: k ? urlToB64(k) : undefined,
    ik: i ? urlToB64(i) : undefined,
    card: c && c.length <= 128 ? c : undefined,
  }
}

// Web-session identity bootstrap. Two paths in:
//
//   1. **Link from iOS** — paste-in JSON blob from the LinkWebView
//      QR. Carries the existing iOS account's identity privs +
//      JWT, so the web becomes a clone of that UIN.
//
//   2. **Create new account** — generate fresh X25519 + Ed25519
//      keypairs locally, POST `/auth/register`, persist the result.
//      Backend mints a brand-new UIN. Account is web-native; no
//      iOS counterpart unless the user installs RCQ later (in which
//      case they install fresh — no backwards link from web to iOS).
//
// Storage caveat: localStorage is XSS-readable. Phase-1 prototype
// trade-off; phase-2 (libsignal-WASM) moves to non-extractable
// WebCrypto keys + IndexedDB.

import { ed25519 } from '@noble/curves/ed25519'
import { b64ToBytes, bytesToB64, type WebIdentity } from './crypto'
import { decodePhrase, deriveKeysFromSeed, encodeSeed, newSeed, parsePhrase } from './recovery'

const STORAGE_KEY = 'rcq.web.identity.v1'
const LINK_TTL_SECONDS = 5 * 60

/// Does this JWT already name an install? Payload peek only — the signature
/// is the server's business.
export function tokenNamesAnInstall(jwt: string): boolean {
  const parts = jwt.split('.')
  if (parts.length < 2) return false
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(parts[1].length / 4) * 4, '='))
    const dev = (JSON.parse(json) as { dev?: unknown }).dev
    return typeof dev === 'string' && dev.length > 0
  } catch {
    return false
  }
}

/// Swap a pre-claim session for one that names this browser. Returns the new
/// jwt, or null to keep the current one (already claimed, island too old to
/// know the route, offline). The server copies the offline-queue drain cursor
/// onto the new id, so nothing is re-downloaded.
export async function claimInstallToken(id: WebIdentity): Promise<string | null> {
  if (tokenNamesAnInstall(id.jwt)) return null
  try {
    const res = await fetch(`${id.apiBase}/auth/device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${id.jwt}` },
      body: JSON.stringify({ device_id: installId() }),
    })
    if (!res.ok) return null
    const out = (await res.json()) as { token?: string }
    return out.token || null
  } catch {
    return null
  }
}

// -----------------------------------------------------------
// Linking-blob path
// -----------------------------------------------------------

export interface LinkBlob {
  uin: number
  jwt: string
  api_base: string
  identity_priv: string
  identity_pub: string
  signing_priv: string
  signing_pub: string
  iat: number
}

/// Typed errors so the caller can translate via i18n. Codes
/// double as the i18n key suffix: `auth.error.<code>`.
export class LinkBlobError extends Error {
  constructor(public code: 'invalid_json' | 'missing_field' | 'expired' | 'mismatch' | 'wrong_size') {
    super(code)
  }
}

export function parseLinkBlob(raw: string): LinkBlob {
  const trimmed = raw.trim()
  let obj: any
  try {
    obj = JSON.parse(trimmed)
  } catch {
    // Linking blobs may have been base64-wrapped for QR-density;
    // try one round of decoding before giving up.
    try {
      obj = JSON.parse(new TextDecoder().decode(b64ToBytes(trimmed)))
    } catch {
      throw new LinkBlobError('invalid_json')
    }
  }
  for (const k of [
    'uin', 'jwt', 'api_base',
    'identity_priv', 'identity_pub',
    'signing_priv', 'signing_pub', 'iat',
  ]) {
    if (obj[k] == null) throw new LinkBlobError('missing_field')
  }
  return obj as LinkBlob
}

export function adoptLinkBlob(blob: LinkBlob): WebIdentity {
  const now = Math.floor(Date.now() / 1000)
  if (now - blob.iat > LINK_TTL_SECONDS) throw new LinkBlobError('expired')

  const identityPriv = b64ToBytes(blob.identity_priv)
  const identityPub = b64ToBytes(blob.identity_pub)
  const signingPriv = b64ToBytes(blob.signing_priv)
  const signingPub = b64ToBytes(blob.signing_pub)

  if (
    identityPriv.length !== 32 ||
    identityPub.length !== 32 ||
    signingPriv.length !== 32 ||
    signingPub.length !== 32
  ) {
    throw new LinkBlobError('wrong_size')
  }

  // Cross-check: Ed25519 pub derivable from `signing_priv` (treated
  // as a seed) must match the shipped `signing_pub`. Catches
  // paste-mix accidents before we sign anything broken.
  const derivedPub = ed25519.getPublicKey(signingPriv)
  for (let i = 0; i < 32; i++) {
    if (derivedPub[i] !== signingPub[i]) throw new LinkBlobError('mismatch')
  }

  const identity: WebIdentity = {
    uin: blob.uin,
    jwt: blob.jwt,
    apiBase: blob.api_base.replace(/\/+$/, ''),
    identityPriv,
    identityPub,
    signingPriv,
    signingPub,
  }
  persistIdentity(identity)
  return identity
}

// -----------------------------------------------------------
// Create-account path
// -----------------------------------------------------------

/// Default API base for fresh accounts created from the web. Phase-1
/// is single-tenant — every install talks to api.rcq.app. A future
/// settings panel can override.
export const DEFAULT_API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, '') || 'https://api.rcq.app'

/// Suggest a default nickname matching the iOS bootstrap heuristic
/// (`user-NNNN` with a 4-digit random suffix). The user can edit
/// before submitting.
export function suggestNickname(): string {
  return `user-${Math.floor(1000 + Math.random() * 9000)}`
}

interface RegisterResponse {
  uin: number
  token: string
}

/// This browser's install id, minted once and kept next to the theme (a
/// device pref, not account data — it survives a sign-out). The server keys a
/// session with no device id as "primary", the same name every OTHER install
/// of the account uses; two of those supersede each other's websocket in a
/// loop and share one offline-queue cursor. A browser recovered onto the same
/// account as a phone is exactly that case.
const INSTALL_KEY = 'rcq.web.install.id'

export function installId(): string {
  const existing = localStorage.getItem(INSTALL_KEY)
  if (existing) return existing
  const fresh = crypto.randomUUID().replace(/-/g, '')
  localStorage.setItem(INSTALL_KEY, fresh)
  return fresh
}

/// Mint a fresh account: generate keypairs, POST /auth/register,
/// adopt the returned UIN+JWT into a `WebIdentity`. Throws on
/// validation or network failure; caller surfaces via `auth.error.*`.
export async function createNewAccount(nickname: string, apiBase: string = DEFAULT_API_BASE): Promise<WebIdentity> {
  const trimmedNick = nickname.trim()
  if (!trimmedNick) throw new Error('Nickname is required.')

  // Identity is now derived from a 32-byte SEED (same HKDF scheme as iOS/Android
  // RecoveryPhrase), not raw random keys — so the account is portable: its
  // 24-word phrase recovers the SAME UIN on a phone via /auth/recover. The seed
  // is persisted locally and shown to the user once to back up.
  const seed = newSeed()
  const k = deriveKeysFromSeed(seed)

  const apiBaseTrimmed = apiBase.replace(/\/+$/, '')
  const res = await fetch(`${apiBaseTrimmed}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nickname: trimmedNick,
      identity_key: bytesToB64(k.identityPub),
      signing_key: bytesToB64(k.signingPub),
      device_id: installId(),
    }),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(text || `HTTP ${res.status}`)
  }
  const out = JSON.parse(text) as RegisterResponse

  const identity: WebIdentity = {
    uin: out.uin,
    jwt: out.token,
    apiBase: apiBaseTrimmed,
    identityPriv: k.identityPriv,
    identityPub: k.identityPub,
    signingPriv: k.signingPriv,
    signingPub: k.signingPub,
  }
  persistIdentity(identity, bytesToB64(seed))
  return identity
}

// -----------------------------------------------------------
// Recover-from-phrase path (web ⇄ mobile portability)
// -----------------------------------------------------------

export class RecoverError extends Error {
  constructor(public code: 'bad_phrase' | 'identity_not_found' | 'network' | 'bad_signature') {
    super(code)
  }
}

/// Restore an account from its 24-word recovery phrase: derive the keys, prove
/// possession of the signing key to /auth/recover, adopt the returned UIN+JWT.
/// Works for any account whose keys are seed-derived — including one first made
/// on a phone (iOS/Android) — so this is the web side of cross-device migration.
export async function recoverFromPhrase(phrase: string, apiBase: string = DEFAULT_API_BASE): Promise<WebIdentity> {
  const words = parsePhrase(phrase)
  const seed = decodePhrase(words)
  if (!seed) throw new RecoverError('bad_phrase')
  const k = deriveKeysFromSeed(seed)
  const signingKeyB64 = bytesToB64(k.signingPub)
  const apiBaseTrimmed = apiBase.replace(/\/+$/, '')

  let challenge: string
  let uin: number
  let token: string
  try {
    const chRes = await fetch(`${apiBaseTrimmed}/auth/recover/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signing_key: signingKeyB64 }),
    })
    if (!chRes.ok) throw new RecoverError('network')
    challenge = ((await chRes.json()) as { challenge: string }).challenge

    // base64 Ed25519 signature over the exact challenge string.
    const signature = bytesToB64(ed25519.sign(new TextEncoder().encode(challenge), k.signingPriv))
    const recRes = await fetch(`${apiBaseTrimmed}/auth/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signing_key: signingKeyB64, challenge, signature }),
    })
    if (recRes.status === 404) throw new RecoverError('identity_not_found')
    if (recRes.status === 401) throw new RecoverError('bad_signature')
    if (!recRes.ok) throw new RecoverError('network')
    const out = (await recRes.json()) as RegisterResponse
    uin = out.uin
    token = out.token
  } catch (e) {
    if (e instanceof RecoverError) throw e
    throw new RecoverError('network')
  }

  const identity: WebIdentity = {
    uin,
    jwt: token,
    apiBase: apiBaseTrimmed,
    identityPriv: k.identityPriv,
    identityPub: k.identityPub,
    signingPriv: k.signingPriv,
    signingPub: k.signingPub,
  }
  persistIdentity(identity, bytesToB64(seed))
  return identity
}

/// The current account's 24-word recovery phrase, or null when this account is
/// not seed-backed (a legacy raw-key web account, or one linked from a phone —
/// those have no seed stored here). Used by the Settings "back up" reveal.
export function currentRecoveryPhrase(): string[] | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    const stored = JSON.parse(raw) as StoredIdentity
    if (!stored.seed) return null
    return encodeSeed(b64ToBytes(stored.seed))
  } catch {
    return null
  }
}

// -----------------------------------------------------------
// Persistence
// -----------------------------------------------------------

interface StoredIdentity {
  uin: number
  jwt: string
  apiBase: string
  identityPriv: string
  identityPub: string
  signingPriv: string
  signingPub: string
  // base64 32-byte recovery seed for seed-derived accounts (create / recover).
  // Absent for legacy raw-key accounts and phone-linked sessions.
  seed?: string
}

/// Persist the identity. `seed` (base64) is written for seed-derived accounts;
/// when omitted, an existing stored seed is PRESERVED so unrelated re-persists
/// (token refresh, UIN migration, multihome) don't drop the recovery phrase.
export function persistIdentity(id: WebIdentity, seed?: string) {
  let keepSeed = seed
  if (keepSeed === undefined) {
    try {
      const prev = localStorage.getItem(STORAGE_KEY)
      if (prev) keepSeed = (JSON.parse(prev) as StoredIdentity).seed
    } catch {
      /* no prior seed */
    }
  }
  const stored: StoredIdentity = {
    uin: id.uin,
    jwt: id.jwt,
    apiBase: id.apiBase,
    identityPriv: bytesToB64(id.identityPriv),
    identityPub: bytesToB64(id.identityPub),
    signingPriv: bytesToB64(id.signingPriv),
    signingPub: bytesToB64(id.signingPub),
    ...(keepSeed ? { seed: keepSeed } : {}),
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
}

export function loadStoredIdentity(): WebIdentity | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    const stored = JSON.parse(raw) as StoredIdentity
    return {
      uin: stored.uin,
      jwt: stored.jwt,
      apiBase: stored.apiBase,
      identityPriv: b64ToBytes(stored.identityPriv),
      identityPub: b64ToBytes(stored.identityPub),
      signingPriv: b64ToBytes(stored.signingPriv),
      signingPub: b64ToBytes(stored.signingPub),
    }
  } catch {
    return null
  }
}

export function clearIdentity() {
  localStorage.removeItem(STORAGE_KEY)
}

/// Adopt a server-confirmed UIN migration (UIN-market purchase): the
/// account keeps its X25519/Ed25519 keypairs but gets a NEW uin + a fresh
/// JWT. Persist the updated identity. The caller should HARD-reload after
/// this so every in-memory cache (ws socket on the old jwt, the libsignal
/// device keyed by the old uin, incoming store) is rebuilt — the next
/// provision republishes a clean bundle under the new uin (the server
/// reset libsignal material on migrate, so peers re-handshake anyway).
export function adoptMigratedUin(current: WebIdentity, newUin: number, newToken: string): WebIdentity {
  const next: WebIdentity = { ...current, uin: newUin, jwt: newToken }
  persistIdentity(next)
  return next
}

/// Device-level prefs that should SURVIVE a sign-out (they're not
/// account data — they're how this browser is set up).
const PRESERVED_KEYS = new Set<string>([
  'rcq.web.chat.theme',
  'rcq.web.language',
  'rcq.web.sounds.enabled',
  // Which browser this is, not who is signed in. Re-minting it on sign-out
  // would leave the account's old cursor behind holding its queue.
  'rcq.web.install.id',
])

/// Wipe ALL account-scoped local data so a fresh account never inherits
/// the previous one's messages/contacts/keys. Removes the identity,
/// every per-thread outgoing log (`rcq.web.outgoing.*`), favorites/
/// archive/muted/collapsed, and the privacy pref — but keeps the
/// device prefs above. IndexedDB (device keys + decrypted history) is
/// cleared by the caller via `idbClearAll()`. This fixes the bug where
/// a new account saw the old account's group messages.
export function wipeLocalAccountData() {
  const toRemove: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (!k) continue
    if (PRESERVED_KEYS.has(k)) continue
    // Everything else under our namespaces is account data.
    if (k.startsWith('rcq.web.') || k.startsWith('rcq.privacy.')) toRemove.push(k)
  }
  for (const k of toRemove) localStorage.removeItem(k)
}

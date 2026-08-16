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
/// Every account this browser holds. The ACTIVE one stays in STORAGE_KEY as
/// well, unchanged, so a session that predates this reads exactly as before and
/// nothing has to be migrated to sign in.
const ACCOUNTS_KEY = 'rcq.web.accounts.v1'
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
  // Prove we hold the private half of the signing key we are about to claim.
  // A public signing key is public, so without this anyone could register an
  // account carrying somebody else's and capture where their recovery lands.
  // Best-effort: an island that predates the endpoint 404s and we register the
  // way we always did.
  const signingKeyB64 = bytesToB64(k.signingPub)
  let challenge: string | undefined
  try {
    const chRes = await fetch(`${apiBaseTrimmed}/auth/register/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signing_key: signingKeyB64 }),
    })
    if (chRes.ok) challenge = ((await chRes.json()) as { challenge: string }).challenge
  } catch {
    // no proof, same as an old island
  }
  const res = await fetch(`${apiBaseTrimmed}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nickname: trimmedNick,
      identity_key: bytesToB64(k.identityPub),
      signing_key: signingKeyB64,
      device_id: installId(),
      ...(challenge
        ? {
            challenge,
            signature: bytesToB64(ed25519.sign(new TextEncoder().encode(challenge), k.signingPriv)),
          }
        : {}),
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

/// Drop the stored recovery seed for the active account, keeping everything
/// else. The session, the keys and the message history are untouched: only the
/// 24 words stop being retrievable from this browser.
///
/// ★★ The seed is not "one more secret" next to the private keys — it is
/// strictly stronger than all of them together. The keys open this account's
/// traffic; the seed re-creates the account on ANY island, forever, and
/// survives key rotation. So it is the one thing worth being able to remove
/// from a browser, where nothing can be hidden from a script running in the
/// same origin (see docs/web-storage-inventory.md).
///
/// ⚠ Deliberately NOT the default, and deliberately not silent. For a lot of
/// people this browser holds the only copy of those words; deleting it for
/// them would destroy the account rather than protect it. The caller asks
/// first and says what is being lost.
export function forgetRecoverySeed(): void {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return
  let uin: number
  try {
    const { seed: _seed, ...rest } = JSON.parse(raw) as StoredIdentity
    uin = rest.uin
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rest))
  } catch {
    return
  }
  // ⚠ The account switcher keeps its OWN copy of every identity, seed
  // included. Clearing one store and leaving the other is the kind of half-fix
  // that reads as done and is not. Only this account's row, though — the other
  // accounts' phrases are not ours to delete.
  try {
    const list = readAccounts().map((a) => {
      if (a.uin !== uin) return a
      const { seed: _seed, ...rest } = a
      return rest
    })
    writeAccounts(list)
  } catch {
    /* no switcher list on this device */
  }
}

/// Does this browser still hold the words? Drives the settings control.
export function hasStoredRecoverySeed(): boolean {
  return currentRecoveryPhrase() != null
}

// -----------------------------------------------------------
// Persistence
// -----------------------------------------------------------

interface StoredIdentity {
  uin: number
  /// ⚠ Absent on purpose for an account marked `noToken` — see [persistIdentity].
  jwt?: string
  apiBase: string
  identityPriv: string
  identityPub: string
  signingPriv: string
  signingPub: string
  // base64 32-byte recovery seed for seed-derived accounts (create / recover).
  // Absent for legacy raw-key accounts and phone-linked sessions.
  seed?: string
  /// This island hands out a session token to whoever proves the signing key
  /// (POST /auth/refresh), so this browser keeps NO token on disk for the
  /// account and asks for one at start-up. Set by [markTokenless] after a
  /// refresh has actually worked once — never optimistically.
  noToken?: true
}

/// Is this account's token re-mintable, i.e. is there no point keeping one?
/// Read from whichever row we have: the active slot, else the switcher list.
function isTokenless(uin: number): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const active = JSON.parse(raw) as StoredIdentity
      if (active.uin === uin) return active.noToken === true
    }
  } catch {
    /* fall through to the list */
  }
  return readAccounts().find((a) => a.uin === uin)?.noToken === true
}

/// Persist the identity. `seed` (base64) is written for seed-derived accounts;
/// when omitted, an existing stored seed is PRESERVED so unrelated re-persists
/// (token refresh, UIN migration, multihome) don't drop the recovery phrase.
///
/// ★ The session token is written only while this account still needs it. Once
/// [markTokenless] has confirmed the island will mint one from the signing key,
/// the token stops being written at all: a 30-day bearer sitting next to the
/// keys that can produce it costs a reader nothing to pick up and buys its
/// owner nothing (docs/web-storage-inventory.md, fix 3).
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
  const tokenless = isTokenless(id.uin)
  const stored: StoredIdentity = {
    uin: id.uin,
    apiBase: id.apiBase,
    identityPriv: bytesToB64(id.identityPriv),
    identityPub: bytesToB64(id.identityPub),
    signingPriv: bytesToB64(id.signingPriv),
    signingPub: bytesToB64(id.signingPub),
    ...(tokenless ? { noToken: true } : { jwt: id.jwt }),
    ...(keepSeed ? { seed: keepSeed } : {}),
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
  // Keep the switcher row in step, or switching accounts would restore the
  // token this just removed.
  const list = readAccounts()
  const i = list.findIndex((a) => a.uin === id.uin)
  if (i >= 0) {
    list[i] = { ...list[i], ...stored }
    if (tokenless) delete list[i].jwt
    writeAccounts(list)
  }
}

/// Remember that this account never needs a stored token again, and drop the
/// one already on disk (both copies — the active slot and the switcher row).
///
/// Called after a refresh has succeeded, never before: an island too old to
/// know POST /auth/refresh, or an account whose signing key is shared with an
/// older one (the flagship has seven such keys), must go on keeping its token
/// rather than lose the only way back in.
export function markTokenless(uin: number): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const active = JSON.parse(raw) as StoredIdentity
      if (active.uin === uin) {
        const { jwt: _jwt, ...rest } = active
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...rest, noToken: true }))
      }
    }
  } catch {
    /* unreadable active row — the list below still gets cleaned */
  }
  const list = readAccounts()
  let touched = false
  for (let i = 0; i < list.length; i++) {
    if (list[i].uin !== uin) continue
    const { jwt: _jwt, ...rest } = list[i]
    list[i] = { ...rest, noToken: true }
    touched = true
  }
  if (touched) writeAccounts(list)
}

/// Does this browser still hold a session token for `uin` on disk? Drives the
/// "what is in this browser" screen; also the honest answer to "did the
/// tokenless path actually take on this island".
export function hasStoredToken(uin: number): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const active = JSON.parse(raw) as StoredIdentity
      if (active.uin === uin) return typeof active.jwt === 'string' && active.jwt.length > 0
    }
  } catch {
    /* fall through */
  }
  const row = readAccounts().find((a) => a.uin === uin)
  return typeof row?.jwt === 'string' && row.jwt.length > 0
}

// -----------------------------------------------------------
// Minting a session token from the signing key
// -----------------------------------------------------------

/// What came back from an attempt to mint a session token.
///
/// The three failures are deliberately NOT the same thing, because acting on
/// the wrong one signs somebody out of a live account:
///  * `dead` — the island says this identity is gone. The session really is
///    over; the caller may send the user back to the login screen.
///  * `unsupported` — the island predates POST /auth/refresh. Nothing is
///    wrong; this account simply goes on keeping its token on disk.
///  * neither — offline, a 5xx, a captive portal. Try again later and change
///    nothing in the meantime.
export interface TokenMint {
  token: string | null
  dead: boolean
  unsupported: boolean
}

/// Ask this account's island for a fresh session token, proving possession of
/// the Ed25519 signing key (the same challenge-response as recovery).
///
/// ⚠ Not /auth/recover. That resolves a key to the OLDEST account carrying it,
/// which for a shared key is somebody else's account — fine as a last-resort
/// "take me home", wrong as a start-up step. /auth/refresh names the uin.
export async function mintSessionToken(id: WebIdentity): Promise<TokenMint> {
  const miss: TokenMint = { token: null, dead: false, unsupported: false }
  const skB64 = bytesToB64(id.signingPub)
  try {
    const chRes = await fetch(`${id.apiBase}/auth/recover/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signing_key: skB64 }),
    })
    if (!chRes.ok) return miss
    const { challenge } = (await chRes.json()) as { challenge: string }
    const signature = bytesToB64(ed25519.sign(new TextEncoder().encode(challenge), id.signingPriv))
    const res = await fetch(`${id.apiBase}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uin: id.uin,
        signing_key: skB64,
        challenge,
        signature,
        device_id: installId(),
      }),
    })
    if (res.ok) {
      const out = (await res.json()) as { uin?: number; token?: string }
      // The island answering with a different number is not a token we can
      // use — it is a bug or a shared key, and adopting it would put this
      // browser into somebody else's account.
      if (out.token && out.uin === id.uin) return { token: out.token, dead: false, unsupported: false }
      return miss
    }
    if (res.status === 404) {
      // Two very different 404s: "no such account" (ours, coded) and "no such
      // route" (an island older than this endpoint).
      const text = await res.text()
      if (text.includes('identity_not_found')) return { token: null, dead: true, unsupported: false }
      return { token: null, dead: false, unsupported: true }
    }
    if (res.status === 405) return { token: null, dead: false, unsupported: true }
    return miss
  } catch {
    // Offline. Says nothing about the account.
    return miss
  }
}

/// The identity with a usable token: the one it already carries, else a freshly
/// minted one. For calls made on behalf of an account that is not the active
/// one (signing another account out, for instance), which under the tokenless
/// scheme holds no token in memory either.
export async function withSessionToken(id: WebIdentity): Promise<WebIdentity> {
  if (id.jwt) return id
  const mint = await mintSessionToken(id)
  return mint.token ? { ...id, jwt: mint.token } : id
}

function readAccounts(): StoredIdentity[] {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY)
    const list = raw ? (JSON.parse(raw) as StoredIdentity[]) : []
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function writeAccounts(list: StoredIdentity[]) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list))
}

function hydrate(stored: StoredIdentity): WebIdentity {
  return {
    uin: stored.uin,
    // Empty for a tokenless account until start-up mints one. Every caller
    // that needs it either runs after that (the whole app) or asks for it
    // itself via `withSessionToken`.
    jwt: stored.jwt ?? '',
    apiBase: stored.apiBase,
    identityPriv: b64ToBytes(stored.identityPriv),
    identityPub: b64ToBytes(stored.identityPub),
    signingPriv: b64ToBytes(stored.signingPriv),
    signingPub: b64ToBytes(stored.signingPub),
  }
}

/// Every account held here, active one first. The list is seeded from the
/// single stored identity the first time it is read, so an existing session
/// appears in it without anyone signing in again.
export function listStoredIdentities(): WebIdentity[] {
  let list = readAccounts()
  const activeRaw = localStorage.getItem(STORAGE_KEY)
  if (activeRaw) {
    try {
      const active = JSON.parse(activeRaw) as StoredIdentity
      if (!list.some((a) => a.uin === active.uin)) {
        list = [active, ...list]
        writeAccounts(list)
      }
    } catch {
      /* unreadable active entry — the list stands on its own */
    }
  }
  return list.map(hydrate)
}

/// Make `uin` the active account. Returns false when this browser does not hold
/// it, so a caller can refuse rather than sign the user out of everything.
export function activateStoredIdentity(uin: number): boolean {
  const hit = readAccounts().find((a) => a.uin === uin)
  if (!hit) return false
  localStorage.setItem(STORAGE_KEY, JSON.stringify(hit))
  return true
}

/// Forget ONE account, leaving the others alone.
///
/// ⚠ Its message logs and its IndexedDB are deliberately NOT swept here. They
/// are scoped by uin, so they harm nobody by staying, and a sign-out that also
/// destroys history is a thing people do by accident. Wiping everything is
/// still what the full sign-out does.
/// UINs whose session this browser knows is dead: the phone unlinked this
/// device, or the token expired. Kept OUT of the per-account scope on purpose —
/// it is a fact about this browser's copy of an account, and the account it
/// describes is exactly the one we can no longer authenticate as.
///
/// ⚠ The row is NOT deleted when this happens. A stored identity carries the
/// account's private keys, and for a web-native account this browser may be
/// the only place they exist: dropping it because a token died would destroy
/// the account for anyone who never wrote down their recovery phrase. So the
/// row stays, marked, and the user decides.
const REVOKED_KEY = 'rcq.web.revoked.v1'

export function markSessionRevoked(uin: number): void {
  const list = revokedAccounts()
  if (list.includes(uin)) return
  localStorage.setItem(REVOKED_KEY, JSON.stringify([...list, uin]))
}

export function revokedAccounts(): number[] {
  try {
    const raw = JSON.parse(localStorage.getItem(REVOKED_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((n) => typeof n === 'number') : []
  } catch {
    return []
  }
}

export function clearSessionRevoked(uin: number): void {
  const list = revokedAccounts().filter((n) => n !== uin)
  localStorage.setItem(REVOKED_KEY, JSON.stringify(list))
}

export function removeStoredIdentity(uin: number): WebIdentity | null {
  const list = readAccounts().filter((a) => a.uin !== uin)
  writeAccounts(list)
  const activeRaw = localStorage.getItem(STORAGE_KEY)
  let activeUin: number | null = null
  try {
    activeUin = activeRaw ? (JSON.parse(activeRaw) as StoredIdentity).uin : null
  } catch {
    /* ignore */
  }
  if (activeUin !== uin) return null
  localStorage.removeItem(STORAGE_KEY)
  const next = list[0]
  if (!next) return null
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  return hydrate(next)
}

export function loadStoredIdentity(): WebIdentity | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    return hydrate(JSON.parse(raw) as StoredIdentity)
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
  'rcq.web.chat.fontscale',
  'rcq.web.language',
  'rcq.web.sounds.enabled',
  'rcq.web.sounds.presence',
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

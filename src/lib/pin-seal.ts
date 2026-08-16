// Sealing the CONVERSATIONS under the desktop PIN.
//
// The PIN already took the account off this disk (desktop-vault.ts): the keys,
// the recovery phrase and the session live in vault.json and come back only
// when someone types the PIN. The history did not move. A locked app still had
// every message sitting in IndexedDB and every message the user sent sitting
// in localStorage, in plain JSON — so the lock screen protected the ability to
// BECOME you and not the thing most people think a lock protects.
//
// This closes that. One more random 32-byte key is generated when the PIN is
// switched on and stored inside the vault, sealed by the same Argon2id-derived
// key. It never touches the disk in the clear, so a machine that is closed —
// or taken — holds ciphertext for:
//
//   * the received history (IndexedDB `incoming:<uin>`),
//   * every outgoing log (localStorage `…outgoing.peer.N` / `.group.N`),
//   * the decrypted image cache (IndexedDB `img:*`).
//
// ⚠ How this differs from local-seal.ts, which seals with a non-extractable
// WebCrypto key. That key protects a profile dump because it cannot be
// exported — but the browser hands it to the page automatically, so it does
// NOT need a PIN and does NOT protect anything from someone who simply opens
// the app. This one is useless without the PIN, which is the whole point: a
// laptop found unlocked is a different threat from a laptop found closed, and
// only the second is what a PIN can honestly claim.
//
// ⚠ Not covered, and said plainly on the storage screen: the libsignal device
// (identity + sessions), the contact snapshot and the sender keys. They are
// keys and bookkeeping rather than words, and the device blob in particular is
// the one file whose loss breaks every peer's session — it deserves its own
// pass rather than a ride on this one.

const PREFIX = 'p1:'

let key: CryptoKey | null = null

/// The row inside the vault that carries the history key. Not an account row —
/// `auth.ts` only ever reads its own three — but it rides in the same sealed
/// JSON because that file is already the one thing on this disk the page
/// cannot read without a PIN.
export const HISTORY_KEY_ROW = 'rcq.desktop.historykey.v1'

/// Is the history being sealed right now? False in a browser, false on a
/// desktop with no PIN, and false while locked (nothing renders then anyway).
export function pinSealActive(): boolean {
  return key != null
}

/// A fresh key for a vault that is being created. Base64 of 32 random bytes.
export function newHistoryKeyB64(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  let s = ''
  for (const b of raw) s += String.fromCharCode(b)
  return btoa(s)
}

/// Adopt the key that came out of the vault (or drop it when the PIN goes
/// away). Imported non-extractable: from here on the page can use it and
/// cannot copy it back out.
export async function setHistoryKey(b64: string | null): Promise<void> {
  if (!b64) {
    key = null
    return
  }
  try {
    const raw = atob(b64)
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
    key = await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ])
  } catch {
    key = null
  }
}

// ── strings (localStorage) ───────────────────────────────────────────────────

export function isSealedText(s: string): boolean {
  return s.startsWith(PREFIX)
}

/// `p1:<base64 iv||ciphertext>`, or null when there is no PIN to seal under.
export async function sealText(plain: string): Promise<string | null> {
  if (!key) return null
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)),
    )
    const joined = new Uint8Array(iv.length + ct.length)
    joined.set(iv)
    joined.set(ct, iv.length)
    let s = ''
    for (const b of joined) s += String.fromCharCode(b)
    return PREFIX + btoa(s)
  } catch {
    return null
  }
}

/// The plaintext back, or null when this is not ours to open — a blob from a
/// PIN that was replaced, or a truncated one. Never throws: a store that
/// cannot read one row should show an empty thread, not a white screen.
export async function openText(blob: string): Promise<string | null> {
  if (!key || !isSealedText(blob)) return null
  try {
    const raw = atob(blob.slice(PREFIX.length))
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, 12) },
      key,
      bytes.subarray(12),
    )
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}

// ── structured values (IndexedDB) ────────────────────────────────────────────
//
// IndexedDB stores structured clones, so a sealed value is an object carrying
// two byte arrays rather than base64 — no string round-trip for a megabyte of
// JPEG.

export interface SealedValue {
  __pinSealed: 1
  iv: Uint8Array
  ct: Uint8Array
}

export function isSealedValue(v: unknown): v is SealedValue {
  return typeof v === 'object' && v != null && (v as SealedValue).__pinSealed === 1
}

async function sealRaw(bytes: BufferSource): Promise<SealedValue | null> {
  if (!key) return null
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes))
    return { __pinSealed: 1, iv, ct }
  } catch {
    return null
  }
}

async function openRaw(v: SealedValue): Promise<ArrayBuffer | null> {
  if (!key) return null
  try {
    // Copied into plain ArrayBuffers: what comes back out of IndexedDB is a
    // structured clone whose backing buffer TS will not accept as a
    // BufferSource (it could be a SharedArrayBuffer as far as the types know).
    return await crypto.subtle.decrypt({ name: 'AES-GCM', iv: copy(v.iv) }, key, copy(v.ct))
  } catch {
    return null
  }
}

function copy(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength)
  new Uint8Array(out).set(view)
  return out
}

/// Seal any JSON-able value for IndexedDB, or return it untouched when there
/// is no PIN. The caller stores whatever comes back.
export async function sealValue(value: unknown): Promise<unknown> {
  if (!key) return value
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  return (await sealRaw(bytes)) ?? value
}

/// The value back. Anything that is not a sealed blob is returned as it is —
/// that is how a history written before the PIN existed keeps opening.
export async function openValue<T>(stored: unknown): Promise<T | undefined> {
  if (!isSealedValue(stored)) return stored as T | undefined
  const plain = await openRaw(stored)
  if (!plain) return undefined
  try {
    return JSON.parse(new TextDecoder().decode(plain)) as T
  } catch {
    return undefined
  }
}

/// Bytes in, sealed value out (the image cache). Same fallback rule.
export async function sealBuffer(buf: ArrayBuffer): Promise<unknown> {
  if (!key) return buf
  return (await sealRaw(buf)) ?? buf
}

export async function openBuffer(stored: unknown): Promise<ArrayBuffer | null> {
  if (stored == null) return null
  if (!isSealedValue(stored)) return stored as ArrayBuffer
  return openRaw(stored)
}

// ── switching the PIN on and off ─────────────────────────────────────────────
//
// Rows written from now on are sealed by the calls above; these two passes are
// for what is ALREADY on the disk. Only the active account's database is
// touched — a second account's history is sealed the first time that account
// opens, because an unsealed blob keeps being readable and a sealed write
// replaces it.

/// Which stored keys carry conversation contents. Deliberately explicit: the
/// libsignal device blob and the non-extractable sealing key live in the same
/// store, and neither survives a JSON round-trip.
function isHistoryKey(k: string): boolean {
  return k.startsWith('incoming:') || (k.startsWith('img:') && k !== 'img:index')
}

/// Set once this database has been swept, so the sweep is not repeated on
/// every unlock. Without it, opening the app would read back every cached
/// picture just to confirm it is already sealed.
const SWEPT = 'pin-seal.v1'

/// Seal the history that was written before the PIN existed.
///
/// ⚠ Must run only AFTER the account scope is set — `signal-persist` resolves
/// the database name the first time it opens a connection, and a call made
/// before that pins the whole page to the unscoped database. That is why the
/// unlock path does not call this; `hydrateIncoming` does, once it knows whose
/// history it is loading.
export async function sealExistingHistory(): Promise<void> {
  if (!key) return
  const { idbGet, idbKeys, idbSet } = await import('./signal-persist')
  if (await idbGet<boolean>(SWEPT).catch(() => false)) return
  for (const k of await idbKeys().catch(() => [] as string[])) {
    if (!isHistoryKey(k)) continue
    const stored = await idbGet<unknown>(k).catch(() => undefined)
    if (stored == null || isSealedValue(stored)) continue
    const sealed = k.startsWith('img:') ? await sealBuffer(stored as ArrayBuffer) : await sealValue(stored)
    if (isSealedValue(sealed)) await idbSet(k, sealed).catch(() => {})
  }
  await idbSet(SWEPT, true).catch(() => {})
}

/// Put it back in the clear. Runs while the key is still held — the caller
/// drops it afterwards — because otherwise there would be nothing to open it
/// with, and a PIN being switched off must not take the history with it.
export async function releaseExistingHistory(): Promise<void> {
  if (!key) return
  const { idbDel, idbGet, idbKeys, idbSet } = await import('./signal-persist')
  for (const k of await idbKeys().catch(() => [] as string[])) {
    if (!isHistoryKey(k)) continue
    const stored = await idbGet<unknown>(k).catch(() => undefined)
    if (!isSealedValue(stored)) continue
    const plain = k.startsWith('img:')
      ? await openBuffer(stored)
      : await openValue<unknown>(stored)
    if (plain != null) await idbSet(k, plain).catch(() => {})
  }
  await idbDel(SWEPT).catch(() => {})
}

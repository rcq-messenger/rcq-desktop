// Minimal IndexedDB key/value store (no dependency). Used to persist the
// libsignal device (identity + prekeys + sessions) and decrypted history so a
// page reload doesn't churn keys (which would break peers' sessions) or lose
// chat history. Values are structured-cloned, so Uint8Array fields survive
// without base64. One DB ('rcq-web'), one object store ('kv').

// Per-account, for the same reason the localStorage keys are: two accounts
// sharing one device store would share libsignal sessions and decrypted
// history. Read once, when the connection is first opened — a database name
// cannot change under a live connection, which is why every account switch is
// a hard reload.
import { scopedDbName } from './account-scope'

const STORE = 'kv'

let _dbp: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  if (_dbp) return _dbp
  // ⚠ Loud, because it is exactly how a device key went missing: a page that
  // touches IDB before the account scope is set pins this cached connection to
  // the FLAT database for its whole life, its device blob lands there, and the
  // next (scoped) boot finds nothing and mints fresh keys over the primary
  // slot — every peer with a session is then sending into a void (2026-08-20).
  try {
    if (scopedDbName() === 'rcq-web' && localStorage.getItem('rcq.web.identity.v1')) {
      console.error('IDB opened UNSCOPED while an account exists — writes are landing in the flat database')
    }
  } catch {
    /* storage gated — nothing to warn about */
  }
  _dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(scopedDbName(), 1)
    req.onupgradeneeded = () => {
      const d = req.result
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return _dbp
}

/// Read one key from the FLAT (pre-multi-account, and accidentally-unscoped)
/// database, regardless of the current scope. Rescue path only: a QR-link page
/// used to live its whole life unscoped, so the device blob it wrote sits in
/// 'rcq-web' while every later boot reads 'rcq-web-<uin>'. Opening the flat DB
/// when it does not exist creates an empty shell, which is harmless.
export async function idbGetFlat<T>(key: string): Promise<T | undefined> {
  if (scopedDbName() === 'rcq-web') return undefined // flat IS the current db
  const flat = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('rcq-web', 1)
    req.onupgradeneeded = () => {
      const d = req.result
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = flat.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(key)
      req.onsuccess = () => resolve(req.result as T | undefined)
      req.onerror = () => reject(req.error)
    })
  } finally {
    flat.close()
  }
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}

export async function idbSet(key: string, val: unknown): Promise<void> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(val, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/// Every key in this account's store. Used when a PIN is switched on or off
/// and the data already on disk has to be re-written in the other shape.
export async function idbKeys(): Promise<string[]> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAllKeys()
    req.onsuccess = () => resolve((req.result as IDBValidKey[]).map(String))
    req.onerror = () => reject(req.error)
  })
}

export async function idbDel(key: string): Promise<void> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/// Wipe the entire kv store — device keys, sessions, decrypted history.
/// Used on sign-out so a fresh account never inherits the previous
/// account's data. Best-effort (resolves even on error).
export async function idbClearAll(): Promise<void> {
  try {
    const d = await db()
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    /* nothing persisted yet / IDB unavailable */
  }
}

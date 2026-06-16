// Minimal IndexedDB key/value store (no dependency). Used to persist the
// libsignal device (identity + prekeys + sessions) and decrypted history so a
// page reload doesn't churn keys (which would break peers' sessions) or lose
// chat history. Values are structured-cloned, so Uint8Array fields survive
// without base64. One DB ('rcq-web'), one object store ('kv').

const DB_NAME = 'rcq-web'
const STORE = 'kv'

let _dbp: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  if (_dbp) return _dbp
  _dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const d = req.result
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return _dbp
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

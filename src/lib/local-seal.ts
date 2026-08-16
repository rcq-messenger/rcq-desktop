// Sealing local data with a key this browser will not hand over.
//
// ★ The point is NOT "localStorage is unsafe, IndexedDB is safe" — both are
// read by any script in the origin, and moving bytes between them is not a
// fix (docs/web-storage-inventory.md says so in as many words). The point is
// the KEY: a WebCrypto key generated with `extractable: false` can be USED
// from this page and cannot be exported by anything — not by DevTools, not by
// a script that gets into the origin, not by a copy of the profile directory.
//
// So what this buys, precisely:
//
//  * A dump of the browser profile — the laptop taken, the phone handed over,
//    the disk imaged — yields ciphertext. This is the threat our people
//    actually meet, and the one where "it was all sitting there in plain
//    JSON" is the difference that matters.
//  * A script running in the origin can still ASK this module to decrypt
//    while the page is open. It cannot take the key with it, so it cannot
//    read anything after the tab is closed.
//
// Not a substitute for the CSP or for storing less. One more layer, applied
// where the contents are somebody else's words rather than our bookkeeping.
//
// ⚠ Degrades openly, never silently destructively: where the key cannot be
// made (no WebCrypto, no IndexedDB, a non-secure context), sealing returns
// null and the caller stores what it always stored. Losing a stranger's
// message request is a worse outcome than storing it the old way, and the
// "what is in this browser" screen tells the truth about which one happened.

import { idbGet, idbSet } from './signal-persist'

const KEY_ID = 'local-seal.v1'
const PREFIX = 's1:'

let keyPromise: Promise<CryptoKey | null> | null = null

/// This account's sealing key: the one in its device database, or a fresh
/// non-extractable one stored there. Null when the browser cannot do it.
function sealKey(): Promise<CryptoKey | null> {
  if (keyPromise) return keyPromise
  keyPromise = (async () => {
    try {
      if (!globalThis.crypto?.subtle) return null
      const existing = await idbGet<CryptoKey>(KEY_ID)
      // A CryptoKey survives IndexedDB as a structured clone — the key
      // material never becomes bytes we could hold.
      if (existing) return existing
      const fresh = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ])
      await idbSet(KEY_ID, fresh)
      return fresh
    } catch {
      return null
    }
  })()
  return keyPromise
}

/// Is sealing available at all in this browser? For the storage screen, which
/// must not claim protection that is not there.
export async function sealingAvailable(): Promise<boolean> {
  return (await sealKey()) != null
}

/// `s1:<base64 iv||ciphertext>`, or null when this browser cannot seal.
export async function sealLocal(plain: string): Promise<string | null> {
  const key = await sealKey()
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

export function isSealed(blob: string): boolean {
  return blob.startsWith(PREFIX)
}

/// The plaintext back, or null if this is not ours to open (a key that was
/// cleared, a truncated value, a blob from another account).
export async function openLocal(blob: string): Promise<string | null> {
  if (!isSealed(blob)) return null
  const key = await sealKey()
  if (!key) return null
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

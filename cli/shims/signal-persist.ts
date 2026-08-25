// File-backed stand-in for the web's IndexedDB KV (src/lib/signal-persist.ts,
// same export surface — build.mjs redirects the import). The only callers are
// the signal-device.ts keys, all '<name>:<uin>', so the uin picks the file:
// two accounts sharing one state dir must never share ratchets.
//
// IndexedDB structured-clones Uint8Arrays; JSON drops them, and a DeviceBlob
// nests them inside arrays of records (idkp, prekey recs, session recs). So
// every value is encoded {__u8: base64} recursively on write and revived on
// read. Writes are atomic (tmp + rename) — a torn device blob is every peer
// session gone.

import fs from 'node:fs'
import { readState, stateDir, statePath, writeState } from '../src/state'

function nameFor(key: string): string {
  const m = /:(\d+)$/.exec(key)
  return m ? `signal-${m[1]}.json` : 'signal-misc.json'
}

function encode(v: unknown): unknown {
  if (v instanceof Uint8Array) return { __u8: Buffer.from(v).toString('base64') }
  if (Array.isArray(v)) return v.map(encode)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[k] = encode(x)
    return out
  }
  return v
}

function decode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decode)
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.__u8 === 'string' && Object.keys(o).length === 1) {
      return new Uint8Array(Buffer.from(o.__u8, 'base64'))
    }
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(o)) out[k] = decode(x)
    return out
  }
  return v
}

// ⚠ Through the state layer, never fs: this file IS the ratchet. On a sealed
// dir it is ciphertext, and a raw read would parse to {} — which to libsignal
// looks like a device that has never had a session with anyone, so it would
// build fresh ones and every peer would reject the reused counters.
function readAll(name: string): Record<string, unknown> {
  try {
    const text = readState(name)
    return text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch (e) {
    // A sealed dir with no key must NOT read as empty (see above).
    if (e instanceof Error && /sealed/.test(e.message)) throw e
    return {}
  }
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const all = readAll(nameFor(key))
  return key in all ? (decode(all[key]) as T) : undefined
}

export async function idbSet(key: string, val: unknown): Promise<void> {
  const name = nameFor(key)
  const all = readAll(name)
  all[key] = encode(val)
  writeState(name, JSON.stringify(all))
}

export async function idbDel(key: string): Promise<void> {
  const name = nameFor(key)
  const all = readAll(name)
  if (!(key in all)) return
  delete all[key]
  writeState(name, JSON.stringify(all))
}

export async function idbKeys(): Promise<string[]> {
  const out: string[] = []
  for (const name of fs.readdirSync(stateDir())) {
    if (/^signal-.*\.json$/.test(name)) out.push(...Object.keys(readAll(name)))
  }
  return out
}

export async function idbClearAll(): Promise<void> {
  for (const name of fs.readdirSync(stateDir())) {
    if (/^signal-.*\.json$/.test(name)) fs.rmSync(statePath(name), { force: true })
  }
}

/// The web's rescue path for device blobs written into the pre-multi-account
/// flat database. The CLI never had one, so there is never anything to adopt.
export async function idbGetFlat<T>(_key: string): Promise<T | undefined> {
  return undefined
}

// `.rcqbak` — the same archive the phones read and write.
//
// Format lives in RCQ/docs/backup-format.md; the reference implementation is
// the Android one. The point of having a format of our own rather than dumping
// a database is that the three clients keep history in three different stores,
// so "took it on Android, restored it in the browser" only works if what
// travels is neutral.
//
// Everything here is WebCrypto: PBKDF2-HMAC-SHA256 (400k rounds) from the
// 24-word recovery phrase, then AES-256-GCM in 1 MiB chunks. Each chunk is
// authenticated with the header AND its index, so a truncated or reordered
// file fails to open instead of half-restoring a history.

const MAGIC = 'RCQBAK1\n'
export const BACKUP_VERSION = 1
const ROUNDS = 400_000
const CHUNK = 1 << 20
const END_MARKER = -1

/// The neutral message record. Adding a field is additive: a client that does
/// not know it ignores it. Exactly one of `peer` / `group` is set.
export interface BackupRecord {
  id: string
  peer: number | null
  group: number | null
  from_me: boolean
  sender: number | null
  sent_at: number
  kind: string
  body: string
  media_id?: string | null
  media_key?: string | null
  file_name?: string | null
  file_mime?: string | null
  file_size?: number | null
  duration_sec?: number | null
  thumb_b64?: string | null
  lat?: number | null
  lng?: number | null
  spoiler?: boolean
  album_id?: string | null
  edited?: boolean
  reply_to_id?: string | null
  reply_to_author?: string | null
  reply_to_snippet?: string | null
  reactions?: Record<string, string>
  expires_at?: number | null
}

export interface BackupHeader {
  version: number
  uin: number
  created_at: number
  kdf: string
  rounds: number
  salt: string
  cipher: string
}

const enc = new TextEncoder()
const dec = new TextDecoder()

function u32(n: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(new ArrayBuffer(4))
  new DataView(b.buffer).setInt32(0, n, true)
  return b
}

function b64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

/// Normalised the same way every client does it, so a phrase typed with odd
/// spacing or capitals still derives the same key.
async function deriveKey(phrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const norm = phrase.trim().toLowerCase().split(/\s+/).join(' ')
  const base = await crypto.subtle.importKey('raw', enc.encode(norm), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: ROUNDS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function aad(header: Uint8Array, index: number): Uint8Array {
  const out = new Uint8Array(header.length + 8)
  out.set(header, 0)
  new DataView(out.buffer).setBigInt64(header.length, BigInt(index), true)
  return out
}

/// Build the whole archive in memory and hand back a Blob. The browser is the
/// one place where streaming to disk is awkward, and a browser-side history is
/// far smaller than a phone's, so this is the honest trade rather than a
/// half-working stream.
export async function writeBackup(
  phrase: string,
  uin: number,
  entries: { name: string; bytes: Uint8Array }[],
): Promise<Blob> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await deriveKey(phrase, salt)
  const header: BackupHeader = {
    version: BACKUP_VERSION,
    uin,
    created_at: Date.now(),
    kdf: 'pbkdf2-sha256',
    rounds: ROUNDS,
    salt: b64(salt),
    cipher: 'aes-256-gcm',
  }
  const headerBytes = enc.encode(JSON.stringify(header))

  // Flatten the entries into one plaintext stream first, then chunk it. Same
  // framing as the phones: a JSON line naming the entry, then its bytes.
  let total = 0
  const parts: Uint8Array[] = []
  for (const e of entries) {
    const head = enc.encode(`{"name":"${e.name}","size":${e.bytes.length}}\n`)
    parts.push(head, e.bytes)
    total += head.length + e.bytes.length
  }
  const plain = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    plain.set(p, off)
    off += p.length
  }

  // Copied into plain ArrayBuffer-backed views: TypeScript's BlobPart will not
  // take a possibly-SharedArrayBuffer-backed Uint8Array.
  const own = (u: Uint8Array): Uint8Array<ArrayBuffer> => {
    const c = new Uint8Array(new ArrayBuffer(u.length))
    c.set(u)
    return c
  }
  const out: BlobPart[] = [own(enc.encode(MAGIC)), u32(headerBytes.length), own(headerBytes)]
  let index = 0
  for (let pos = 0; pos < plain.length; pos += CHUNK) {
    const slice = plain.subarray(pos, Math.min(pos + CHUNK, plain.length))
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad(headerBytes, index) as BufferSource },
        key,
        slice as BufferSource,
      ),
    )
    out.push(u32(nonce.length + ct.length), own(nonce), own(ct))
    index++
  }
  out.push(u32(END_MARKER))
  return new Blob(out, { type: 'application/octet-stream' })
}

export interface ReadBackup {
  header: BackupHeader
  entries: { name: string; bytes: Uint8Array }[]
}

export async function readBackup(file: ArrayBuffer, phrase: string): Promise<ReadBackup> {
  const all = new Uint8Array(file)
  const magic = dec.decode(all.subarray(0, MAGIC.length))
  if (magic !== MAGIC) throw new Error('not an RCQ backup')
  const view = new DataView(all.buffer)
  let p = MAGIC.length
  const hlen = view.getInt32(p, true)
  p += 4
  if (hlen < 1 || hlen > 8192) throw new Error('backup header looks wrong')
  const headerBytes = all.subarray(p, p + hlen)
  p += hlen
  const header = JSON.parse(dec.decode(headerBytes)) as BackupHeader
  if (header.version > BACKUP_VERSION) throw new Error('this backup was made by a newer version')
  const key = await deriveKey(phrase, unb64(header.salt))

  const chunks: Uint8Array[] = []
  let index = 0
  for (;;) {
    if (p + 4 > all.length) throw new Error('backup is truncated')
    const n = view.getInt32(p, true)
    p += 4
    if (n === END_MARKER) break
    if (n <= 12 || p + n > all.length) throw new Error('backup is damaged')
    const nonce = all.subarray(p, p + 12)
    const body = all.subarray(p + 12, p + n)
    p += n
    let plain: ArrayBuffer
    try {
      plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad(headerBytes, index) as BufferSource },
        key,
        body as BufferSource,
      )
    } catch {
      // The only realistic causes are a wrong phrase and a tampered file, and
      // only the first is something the person can act on.
      throw new Error('wrong recovery phrase, or the file is damaged')
    }
    chunks.push(new Uint8Array(plain))
    index++
  }

  const size = chunks.reduce((a, c) => a + c.length, 0)
  const plain = new Uint8Array(size)
  let off = 0
  for (const c of chunks) {
    plain.set(c, off)
    off += c.length
  }

  const entries: { name: string; bytes: Uint8Array }[] = []
  let q = 0
  while (q < plain.length) {
    let nl = q
    while (nl < plain.length && plain[nl] !== 0x0a) nl++
    if (nl >= plain.length) break
    const head = JSON.parse(dec.decode(plain.subarray(q, nl))) as { name: string; size: number }
    q = nl + 1
    const bytes = plain.subarray(q, q + head.size)
    q += head.size
    entries.push({ name: head.name, bytes })
  }
  return { header, entries }
}

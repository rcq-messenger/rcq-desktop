// Encrypted media fetch + decrypt for the web client. Mirrors iOS
// `MediaService` byte-for-byte:
//   - The server stores opaque blobs (`GET /media/{id}`, no auth).
//   - Each blob is AES-256-GCM sealed with a per-blob key. iOS uses
//     CryptoKit `AES.GCM.seal(...).combined`, whose wire layout is
//     nonce(12) || ciphertext || tag(16). The key is base64 of the
//     raw 32 bytes (the `avatar_media_key` / per-message media key).
//
// We decrypt via the browser's native WebCrypto (`crypto.subtle`):
// AES-GCM `decrypt` takes the 12-byte nonce as `iv` and expects the
// data as ciphertext WITH the 16-byte tag appended — which is exactly
// `combined` minus the leading nonce. No AAD (iOS seals without AAD).

import { b64ToBytes, bytesToB64 } from './crypto'
import {
  ByteReader,
  CHUNKED_HEADER_LEN,
  chunkRecordLen,
  looksChunked,
  openChunk,
  parseChunkedHeader,
} from './media-chunked'
import { isTauri, saveBufferDesktop } from './desktop'
import { openBuffer, sealBuffer } from './pin-seal'
import { idbDel, idbGet, idbSet } from './signal-persist'

// Cache the decrypted object URL per (mediaId, key) so repeated
// renders (Contacts row + Chat header + GroupInfo) don't re-fetch,
// re-decrypt, or leak a new object URL each time. Object URLs live for
// the page lifetime — fine for the handful of group avatars in view.
const _urlCache = new Map<string, Promise<string | null>>()

/// Decrypted avatar bytes, kept in IndexedDB so they survive a reload.
///
/// The map above dies with the page, so every visit to chat.rcq.app fetched and
/// AES-decrypted every avatar in the roster again — for pictures that only
/// change when somebody deliberately changes one, and whose cache key already
/// contains the media key, so a new picture cannot be served from an old entry.
/// Bounded, because this is a cache and not storage: an account that has seen a
/// thousand faces should not carry all of them forever.
const IMG_PREFIX = 'img:'
const IMG_INDEX = 'img:index'
const IMG_KEEP = 300

async function readCachedImage(k: string): Promise<ArrayBuffer | null> {
  return openBuffer(await idbGet<unknown>(IMG_PREFIX + k))
}

async function writeCachedImage(k: string, buf: ArrayBuffer) {
  // A cached picture is the contents of a conversation as much as its text is,
  // so it goes behind the desktop PIN with the rest (pin-seal.ts). Without one
  // this is the same `put` it always was.
  await idbSet(IMG_PREFIX + k, await sealBuffer(buf))
  // Insertion-ordered index, newest last. Trimming from the front drops the
  // least recently ADDED rather than least recently used — the distinction
  // costs a write per read and buys nothing for a list of faces.
  const index = (await idbGet<string[]>(IMG_INDEX)) ?? []
  const next = [...index.filter((x) => x !== k), k]
  const overflow = next.length - IMG_KEEP
  if (overflow > 0) {
    for (const gone of next.slice(0, overflow)) await idbDel(IMG_PREFIX + gone)
    await idbSet(IMG_INDEX, next.slice(overflow))
  } else {
    await idbSet(IMG_INDEX, next)
  }
}

function cacheKey(mediaId: string, keyB64: string): string {
  return `${mediaId}:${keyB64}`
}

/// Forget one decrypted picture: the object URL held for this page and the
/// plaintext copy in IndexedDB, index entry included.
///
/// ⚠ A disappearing photo is mostly NOT its message row. The row goes when the
/// sweeper runs, but the bytes it pointed at were decrypted once and written
/// here under `img:<mediaId>:<mediaKey>`, and nothing ever invalidated that
/// entry: the picture outlived the message that carried it, in the clear, with
/// the media key spelled out in the key name. Both sweepers call this for a
/// photo they take away (`incoming-store`, `outgoing-store`), which is the only
/// way the promise the row's `expiresAt` makes covers the larger half of it.
export async function forgetCachedImage(mediaId: string, keyB64: string): Promise<void> {
  const k = cacheKey(mediaId, keyB64)
  const pending = _urlCache.get(k)
  _urlCache.delete(k)
  if (pending) {
    try {
      const url = await pending
      // Revoking drops the browser's own copy of the decrypted blob. The row is
      // being taken off the screen in the same tick, so nothing is left holding
      // this URL.
      if (url) URL.revokeObjectURL(url)
    } catch {
      /* a failed decrypt has nothing to revoke */
    }
  }
  await idbDel(IMG_PREFIX + k).catch(() => {})
  try {
    const index = (await idbGet<string[]>(IMG_INDEX)) ?? []
    if (index.includes(k)) await idbSet(IMG_INDEX, index.filter((x) => x !== k))
  } catch {
    /* the entry itself is gone; a stale index line only costs one miss */
  }
}

/// Sniff an image MIME from the leading magic bytes so the object URL
/// carries the right type for `<img>`. iOS uploads avatars as JPEG,
/// but be tolerant of PNG/GIF/WebP too.
function sniffImageType(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp'
  return 'image/jpeg'
}

/// The most plaintext this page will materialise from ONE monolithic blob.
///
/// ⚠⚠ A receive-side ceiling, and it exists because a single-seal blob cannot
/// have one anywhere else: its one tag covers the whole file, so the bytes have
/// to be held, copied for `crypto.subtle` and allocated again as plaintext
/// before anything can say whether they are genuine. Three full-size copies of
/// a 400 MB video is a dead tab, and a dead tab is not a failed download — it
/// takes the chat with it. Refusing reads as "this did not load", which is
/// survivable and honest. Chunked containers are NOT subject to this: they cost
/// one chunk.
const MAX_MONOLITHIC_PLAINTEXT = 256 * 1024 * 1024

/// Decrypted plaintext as the pieces it arrived in, plus enough of the front to
/// sniff a MIME from. Kept as pieces on purpose: a Blob can be built out of
/// them without ever concatenating the whole file into one buffer, which is the
/// difference between playing a long video and killing the tab.
interface DecryptedParts {
  parts: Uint8Array[]
  head: Uint8Array
  bytes: number
}

/// Fetch the encrypted blob at `/media/{id}` and AES-256-GCM decrypt it.
///
/// Two shapes arrive here and both are handled by layout, never by guesswork
/// about who sent it:
///
///   * the monolithic seal `nonce(12) || ciphertext || tag(16)`, which every
///     client writes for anything of ordinary size, and
///   * RCQM1 (`media-chunked.ts`), the chunked container a client uses for a
///     file too big to seal in one piece. It is decrypted a chunk at a time
///     straight off the response stream, so a film costs one chunk of memory.
async function fetchDecryptParts(apiBase: string, mediaId: string, keyB64: string): Promise<DecryptedParts | null> {
  try {
    const keyBytes = b64ToBytes(keyB64)
    if (keyBytes.length !== 32) return null
    // Fresh ArrayBuffer so it's an unambiguous BufferSource for WebCrypto.
    const keyAb = new ArrayBuffer(32)
    new Uint8Array(keyAb).set(keyBytes)
    const key = await crypto.subtle.importKey('raw', keyAb, { name: 'AES-GCM' }, false, ['decrypt'])
    const res = await fetch(`${apiBase}/media/${mediaId}`)
    if (!res.ok) return null
    const declared = Number(res.headers.get('content-length'))
    const blobLength = Number.isFinite(declared) && declared > 0 ? declared : null
    if (!res.body) {
      // No streaming body (a test double, or an engine old enough not to have
      // one). The whole blob at once, still behind the ceiling.
      if (blobLength !== null && blobLength > MAX_MONOLITHIC_PLAINTEXT) return null
      return await decryptWhole(new Uint8Array(await res.arrayBuffer()), key)
    }
    const reader = new ByteReader(res.body)
    // Six bytes decide the shape, and a monolithic blob can be as short as 28,
    // so the sniff must not ask for the whole 30-byte header up front.
    const magic = await reader.readExactly(6)
    if (magic === null) return null
    if (!looksChunked(magic)) {
      const rest = await reader.readAll(MAX_MONOLITHIC_PLAINTEXT)
      if (rest === null) {
        console.warn(`[media] ${mediaId}: monolithic blob past the ${MAX_MONOLITHIC_PLAINTEXT} byte ceiling; not opened`)
        return null
      }
      const combined = new Uint8Array(magic.length + rest.length)
      combined.set(magic, 0)
      combined.set(rest, magic.length)
      return await decryptWhole(combined, key)
    }
    const tail = await reader.readExactly(CHUNKED_HEADER_LEN - magic.length)
    if (tail === null) return null
    const header = new Uint8Array(CHUNKED_HEADER_LEN)
    header.set(magic, 0)
    header.set(tail, magic.length)
    const h = parseChunkedHeader(header, blobLength)
    if (h === null) return null
    const parts: Uint8Array[] = []
    for (let i = 0; i < h.chunkCount; i++) {
      const record = await reader.readExactly(chunkRecordLen(h, i))
      if (record === null) return null
      // Throws on a bad tag, which for this container also means reordered,
      // dropped or edited. The catch below turns that into the same failed
      // bubble a bad monolithic seal produces.
      parts.push(await openChunk(record, i, h, key))
    }
    // Bytes after the last record mean this is not the file the header
    // describes, and the header is the only thing every tag agreed on.
    if (!(await reader.atEnd())) return null
    return { parts, head: parts.length > 0 ? parts[0].subarray(0, 32) : new Uint8Array(0), bytes: h.plainLen }
  } catch {
    return null
  }
}

async function decryptWhole(combined: Uint8Array, key: CryptoKey): Promise<DecryptedParts | null> {
  // nonce(12) || ciphertext || tag(16) — need at least nonce + tag.
  if (combined.length < 12 + 16) return null
  const iv = combined.slice(0, 12)
  const data = combined.slice(12) // ciphertext || tag
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, key, data as unknown as BufferSource),
  )
  return { parts: [plain], head: plain.subarray(0, 32), bytes: plain.length }
}

function joinParts(d: DecryptedParts): ArrayBuffer {
  const out = new Uint8Array(d.bytes)
  let at = 0
  for (const p of d.parts) {
    out.set(p, at)
    at += p.length
  }
  return out.buffer
}

/// The plaintext as one ArrayBuffer. For the paths whose whole job is to hand
/// the bytes to something that wants them contiguous (an image, the desktop
/// save dialog); anything that only needs to be rendered or downloaded should
/// take the Blob below instead and skip the copy.
async function fetchDecryptToBuffer(apiBase: string, mediaId: string, keyB64: string): Promise<ArrayBuffer | null> {
  const d = await fetchDecryptParts(apiBase, mediaId, keyB64)
  return d === null ? null : joinParts(d)
}

/// The plaintext as a Blob, built from the pieces it arrived in. The browser
/// owns the storage from here (it will spill a large one to disk), so nothing
/// on this path holds a whole video in the JS heap.
async function fetchDecryptToBlob(
  apiBase: string,
  mediaId: string,
  keyB64: string,
  type: (head: Uint8Array) => string,
): Promise<Blob | null> {
  const d = await fetchDecryptParts(apiBase, mediaId, keyB64)
  if (d === null) return null
  return new Blob(d.parts as unknown as BlobPart[], { type: type(d.head) })
}

/// Both halves at once: the object URL to render, and the bytes to cache. The
/// caller cannot re-read a Blob out of an object URL cheaply, and re-fetching
/// to fill the cache would defeat the point of having one.
async function fetchAndDecryptBuffer(
  apiBase: string,
  mediaId: string,
  keyB64: string,
): Promise<{ objectUrl: string; buf: ArrayBuffer } | null> {
  const buf = await fetchDecryptToBuffer(apiBase, mediaId, keyB64)
  if (!buf) return null
  return {
    objectUrl: URL.createObjectURL(new Blob([buf], { type: sniffImageType(new Uint8Array(buf)) })),
    buf,
  }
}

/// Sniff a video MIME from the leading magic bytes so `<video>` gets a usable
/// type. mp4 / quicktime carry an `ftyp` box at offset 4; WebM/Matroska start
/// with the EBML header. Defaults to video/mp4 (iOS records mp4).
function sniffVideoType(bytes: Uint8Array): string {
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70 // "ftyp"
  ) {
    if (bytes[8] === 0x71 && bytes[9] === 0x74) return 'video/quicktime' // "qt  " brand
    return 'video/mp4'
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'video/webm'
  }
  return 'video/mp4'
}

// -----------------------------------------------------------
// Upload (send side) — mirrors iOS MediaService.uploadImage:
// downscale to a sane max side + JPEG, AES-256-GCM seal in the
// CryptoKit `combined` layout (nonce(12)‖ct‖tag(16)), POST to
// /media/upload. Returns the media id + base64 key for the envelope.
// -----------------------------------------------------------

export interface UploadResult {
  mediaId: string
  keyB64: string
}

/// AES-256-GCM seal plaintext bytes under a fresh key, CryptoKit `combined`
/// layout (nonce(12) || ciphertext || tag(16)). Shared by the image/file
/// upload paths.
async function sealBytes(plaintext: ArrayBuffer): Promise<{ combined: Uint8Array; keyB64: string }> {
  const keyAb = new ArrayBuffer(32)
  const keyView = new Uint8Array(keyAb)
  crypto.getRandomValues(keyView)
  const nonceAb = new ArrayBuffer(12)
  const nonce = new Uint8Array(nonceAb)
  crypto.getRandomValues(nonce)

  const key = await crypto.subtle.importKey('raw', keyAb, { name: 'AES-GCM' }, false, ['encrypt'])
  const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonceAb }, key, plaintext)
  const ct = new Uint8Array(ctBuf) // ciphertext || tag(16)

  // CryptoKit `.combined` = nonce(12) || ciphertext || tag(16).
  const combined = new Uint8Array(12 + ct.length)
  combined.set(nonce, 0)
  combined.set(ct, 12)
  return { combined, keyB64: bytesToB64(keyView) }
}

/// Client-chosen media id (uuid4 hex, 32 chars) for the cross-island PUT
/// deposit — the same id must resolve on every island we deposit to.
function newMediaId(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

async function postBlob(apiBase: string, combined: Uint8Array, name: string): Promise<string | null> {
  const form = new FormData()
  form.append('blob', new Blob([combined.slice().buffer], { type: 'application/octet-stream' }), name)
  const res = await fetch(`${apiBase}/media/upload`, { method: 'POST', body: form })
  if (!res.ok) return null
  const out = (await res.json()) as { media_id: string; size: number }
  return out.media_id
}

/// Deposit an already-encrypted blob under a client-chosen id
/// (`PUT /media/{id}`, idempotent server-side). Returns true on success.
async function putBlob(base: string, mediaId: string, combined: Uint8Array, name: string): Promise<boolean> {
  try {
    const form = new FormData()
    form.append('blob', new Blob([combined.slice().buffer], { type: 'application/octet-stream' }), name)
    const res = await fetch(`${base}/media/${mediaId}`, { method: 'PUT', body: form })
    return res.ok
  } catch {
    return false
  }
}

/// Read an ALREADY-ENCRYPTED blob back off an island, ciphertext untouched.
///
/// §5e deposits the profile picture to each cross-island contact's island, and
/// the bytes it needs are the ones already sitting on ours from the ordinary
/// avatar upload. Deliberately no decrypt anywhere on this path: the key stays
/// in the sealed envelope, which is the whole access decision for a blob whose
/// `GET /media/{id}` has no auth.
export async function fetchEncryptedBlob(apiBase: string, mediaId: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(`${apiBase}/media/${mediaId}`)
    if (!res.ok) return null
    return new Uint8Array(await res.arrayBuffer())
  } catch {
    return null
  }
}

/// Deposit an already-encrypted blob to `host` under the SAME client-chosen id
/// (§5b `PUT /media/{id}`, idempotent, first-write-wins). Depositing the same
/// avatar to the same island twice is therefore free.
export function depositEncryptedBlob(host: string, mediaId: string, combined: Uint8Array): Promise<boolean> {
  return putBlob(`https://${host}`, mediaId, combined, 'photo.bin')
}

/// Cross-island media (deposit-the-blob): the recipient fetches media from
/// their OWN island, so the sender deposits the encrypted blob there itself —
/// islands never talk to each other, and the message survives our island
/// dying. The peer-island PUT is required (that's the copy the recipient
/// reads); our own island's copy is best-effort (carbons to linked devices).
async function uploadBlob(
  apiBase: string,
  combined: Uint8Array,
  name: string,
  peerHost?: string,
): Promise<string | null> {
  if (!peerHost) return postBlob(apiBase, combined, name)
  const mediaId = newMediaId()
  // Both PUTs awaited so our own outgoing bubble doesn't race the own-island
  // copy (it fetches /media/{id} from apiBase to render); only the peer's
  // copy is REQUIRED — that's the one the recipient reads.
  const [peerOk] = await Promise.all([
    putBlob(`https://${peerHost}`, mediaId, combined, name),
    putBlob(apiBase, mediaId, combined, name),
  ])
  if (!peerOk) return null
  return mediaId
}

/// Downscale an image File to <= maxSide px, re-encoded as JPEG, to keep
/// blobs small (iOS uses 1200/0.8; we use 1600/0.85). Falls back to the
/// original bytes if the canvas path fails (e.g. exotic format).
async function compressImage(file: File, maxSide = 1600, quality = 0.85): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, w, h)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
    return blob ?? file
  } catch {
    return file
  }
}

/// Encrypt + upload an image File. GIFs are uploaded as-is (no canvas
/// A bug-report attachment: an AES-GCM-sealed blob already uploaded to /media
/// plus the key the admin decrypts it with (same shape as the mobile clients).
export interface ReportAttachment {
  media_id: string
  key: string
  mime: string
  size: number
}

/// Seal + upload one bug-report attachment (#28). Images are compressed to
/// JPEG; other files go raw. Returns the descriptor or null on failure.
export async function uploadReportAttachment(apiBase: string, file: File): Promise<ReportAttachment | null> {
  const isImage = file.type.startsWith('image/')
  const blob = isImage ? await compressImage(file) : file
  const buf = await blob.arrayBuffer()
  const { combined, keyB64 } = await sealBytes(buf)
  const id = await postBlob(apiBase, combined, 'report.bin')
  if (!id) return null
  return {
    media_id: id,
    key: keyB64,
    mime: isImage ? 'image/jpeg' : (file.type || 'application/octet-stream'),
    size: buf.byteLength,
  }
}

/// re-encode, which would kill the animation). For a cross-island peer pass
/// `peerHost` — the blob is then deposited to THEIR island (+ ours,
/// best-effort) under a client-chosen id. Returns null on failure.
export async function uploadEncryptedImage(
  apiBase: string,
  file: File,
  peerHost?: string,
): Promise<UploadResult | null> {
  try {
    const isGif = file.type === 'image/gif'
    const source: Blob = isGif ? file : await compressImage(file)
    const { combined, keyB64 } = await sealBytes(await source.arrayBuffer())
    const mediaId = await uploadBlob(apiBase, combined, 'photo.bin', peerHost)
    if (!mediaId) return null
    return { mediaId, keyB64 }
  } catch {
    return null
  }
}

/// Fetch + decrypt an encrypted image, returning an object URL (cached)
/// or null on any failure. Safe to call repeatedly with the same args.
export function loadEncryptedImage(
  apiBase: string,
  mediaId: string,
  keyB64: string,
): Promise<string | null> {
  const k = cacheKey(mediaId, keyB64)
  const hit = _urlCache.get(k)
  if (hit) return hit
  const p = (async () => {
    const cached = await readCachedImage(k).catch(() => null)
    if (cached) {
      return URL.createObjectURL(new Blob([cached], { type: sniffImageType(new Uint8Array(cached)) }))
    }
    const url = await fetchAndDecryptBuffer(apiBase, mediaId, keyB64)
    if (!url) return null
    void writeCachedImage(k, url.buf).catch(() => {})
    return url.objectUrl
  })()
  _urlCache.set(k, p)
  // If the decrypt fails, drop the rejected/null promise so a later
  // attempt (e.g. after reconnect) can retry instead of caching null.
  void p.then((url) => {
    if (url === null) _urlCache.delete(k)
  })
  return p
}

// -----------------------------------------------------------
// File / document (#16) + video (#15) — the bytes are NOT images, so they
// skip the image cache + sniffing. Files upload raw (no canvas re-encode);
// videos decrypt-to-blob on demand for inline playback or download.
// -----------------------------------------------------------

export interface FileUploadResult {
  mediaId: string
  keyB64: string
  size: number // plaintext byte length, for the `file` envelope's `size`
}

/// Encrypt + upload a raw file (document) with NO transformation — the bytes
/// are sealed as-is (AES-256-GCM, CryptoKit `combined` layout nonce(12)‖ct‖tag).
/// Mirrors uploadEncryptedImage (incl. the cross-island `peerHost` deposit) but
/// skips the canvas re-encode so arbitrary file types survive byte-for-byte.
/// Returns the media id + base64 key + plaintext size for the `file` envelope.
export async function uploadEncryptedFile(
  apiBase: string,
  file: File,
  peerHost?: string,
): Promise<FileUploadResult | null> {
  try {
    const plaintext = await file.arrayBuffer()
    const { combined, keyB64 } = await sealBytes(plaintext)
    const mediaId = await uploadBlob(apiBase, combined, 'file.bin', peerHost)
    if (!mediaId) return null
    return { mediaId, keyB64, size: plaintext.byteLength }
  } catch {
    return null
  }
}

/// Fetch + decrypt a video to a fresh object URL for inline playback. NOT
/// cached (videos are large — we don't pin many decrypted blobs in memory);
/// the caller revokes the URL when the player unmounts. Null on failure.
export async function loadEncryptedVideo(
  apiBase: string,
  mediaId: string,
  keyB64: string,
): Promise<string | null> {
  const blob = await fetchDecryptToBlob(apiBase, mediaId, keyB64, sniffVideoType)
  if (!blob) return null
  return URL.createObjectURL(blob)
}

/// Fetch + decrypt any media and save it. Returns false on failure so the
/// caller can toast.
///
/// On the DESKTOP this asks where with the native save dialog (#642 — the
/// hidden `<a download>` click below did nothing at all on Windows, and on
/// mac/Linux dropped the file into Downloads without a word). In a browser
/// the anchor click stays: the browser owns the download UX there, and it is
/// the right one. A cancelled dialog reports success — the person changed
/// their mind, nothing failed.
export async function downloadEncryptedFile(
  apiBase: string,
  mediaId: string,
  keyB64: string,
  fileName: string,
  mime?: string,
): Promise<boolean> {
  const blob = await fetchDecryptToBlob(apiBase, mediaId, keyB64, () => mime || 'application/octet-stream')
  if (!blob) return false
  // ⚠ The desktop dialog wants the bytes contiguous, so THAT path pays for one
  // buffer; the browser path hands the Blob straight to an object URL and never
  // builds one at all.
  if (isTauri()) {
    const desktop = await saveBufferDesktop(await blob.arrayBuffer(), fileName)
    if (desktop !== null) return desktop !== 'failed'
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName || 'file'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
  return true
}

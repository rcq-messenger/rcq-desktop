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

// Cache the decrypted object URL per (mediaId, key) so repeated
// renders (Contacts row + Chat header + GroupInfo) don't re-fetch,
// re-decrypt, or leak a new object URL each time. Object URLs live for
// the page lifetime — fine for the handful of group avatars in view.
const _urlCache = new Map<string, Promise<string | null>>()

function cacheKey(mediaId: string, keyB64: string): string {
  return `${mediaId}:${keyB64}`
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

/// Fetch the encrypted blob at `/media/{id}` and AES-256-GCM decrypt it to the
/// raw plaintext ArrayBuffer. Shared by the image / video / file paths — none
/// of them sniff or wrap here; the caller decides the MIME + how to present the
/// bytes. Returns an ArrayBuffer (a valid BlobPart, avoiding the
/// Uint8Array<ArrayBufferLike> ↔ BlobPart friction in newer TS DOM libs).
async function fetchDecryptToBuffer(apiBase: string, mediaId: string, keyB64: string): Promise<ArrayBuffer | null> {
  try {
    const keyBytes = b64ToBytes(keyB64)
    if (keyBytes.length !== 32) return null
    // Fresh ArrayBuffer so it's an unambiguous BufferSource for WebCrypto.
    const keyAb = new ArrayBuffer(32)
    new Uint8Array(keyAb).set(keyBytes)
    const res = await fetch(`${apiBase}/media/${mediaId}`)
    if (!res.ok) return null
    const combinedBuf = await res.arrayBuffer()
    // nonce(12) || ciphertext || tag(16) — need at least nonce + tag.
    if (combinedBuf.byteLength < 12 + 16) return null
    // Slice into plain ArrayBuffers (valid BufferSource without fighting
    // the Uint8Array<ArrayBufferLike> generic in newer TS DOM libs).
    const iv = combinedBuf.slice(0, 12)
    const data = combinedBuf.slice(12) // ciphertext || tag
    const key = await crypto.subtle.importKey('raw', keyAb, { name: 'AES-GCM' }, false, ['decrypt'])
    return await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data)
  } catch {
    return null
  }
}

async function fetchAndDecrypt(apiBase: string, mediaId: string, keyB64: string): Promise<string | null> {
  const buf = await fetchDecryptToBuffer(apiBase, mediaId, keyB64)
  if (!buf) return null
  return URL.createObjectURL(new Blob([buf], { type: sniffImageType(new Uint8Array(buf)) }))
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
  const p = fetchAndDecrypt(apiBase, mediaId, keyB64)
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
  const buf = await fetchDecryptToBuffer(apiBase, mediaId, keyB64)
  if (!buf) return null
  return URL.createObjectURL(new Blob([buf], { type: sniffVideoType(new Uint8Array(buf)) }))
}

/// Fetch + decrypt any media and trigger a browser download with the given
/// file name + MIME. Returns false on failure so the caller can toast. The
/// object URL is revoked shortly after the click fires.
export async function downloadEncryptedFile(
  apiBase: string,
  mediaId: string,
  keyB64: string,
  fileName: string,
  mime?: string,
): Promise<boolean> {
  const buf = await fetchDecryptToBuffer(apiBase, mediaId, keyB64)
  if (!buf) return false
  const url = URL.createObjectURL(new Blob([buf], { type: mime || 'application/octet-stream' }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName || 'file'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
  return true
}

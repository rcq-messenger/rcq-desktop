// RCQM1, the chunked media container: the large-file twin of the single
// AES-256-GCM seal (`nonce(12) || ciphertext || tag(16)`) every other blob in
// this app uses.
//
// ## Why it exists at all
//
// A monolithic GCM seal puts its tag at the END, so no honest implementation
// may hand out a byte of plaintext before it has read the last byte and checked
// the tag. That is what "authenticated" means, and it puts a floor under what a
// download costs in memory: the blob, the copy `crypto.subtle` works on, and
// the plaintext, all live at once. Past a certain clip length that floor is
// above what a tab (or a phone) will give one page, and the failure is silent
// everywhere: an allocation that does not come back reads as "the video never
// loaded".
//
// Android ships the way out (`crypto/MediaStream.kt`): the plaintext is cut
// into chunks and each chunk gets its own seal under the same per-blob key, so
// an open costs one chunk of memory whatever the file weighs. THIS FILE IS THE
// READER FOR THAT FORMAT. Without it a video sent from a recent Android build
// is a dead bubble here: the first 12 bytes of the magic get read as a GCM
// nonce, `crypto.subtle.decrypt` throws, and the catch turns it into a null
// that nothing explains.
//
// ## The container
//
//     offset  0 : magic       "RCQM1"                     5
//     offset  5 : version     0x01                        1
//     offset  6 : chunkSize   uint32 BE, plaintext bytes  4
//     offset 10 : chunkCount  uint32 BE                   4
//     offset 14 : plainLen    uint64 BE                   8
//     offset 22 : noncePrefix random                      8
//                                                        -- 30 bytes
//     then chunkCount records, record i = ciphertext(len_i) || tag(16)
//     len_i = chunkSize, except the last = plainLen - chunkSize*(chunkCount-1)
//
//   * nonce for chunk i = `noncePrefix || uint32BE(i)`. The prefix is fresh
//     random per blob and the KEY is fresh random per blob, so no nonce repeats
//     under a key even if two blobs draw the same prefix.
//   * AAD for chunk i = `header(30) || uint32BE(i)`.
//
// Every structural fact lives in the header and the header is in the AAD of
// every chunk, so one tag failure is the answer to a chunk moved, duplicated,
// dropped or swapped in, and to the file being truncated, extended or edited.
//
// This side READS only. The web still seals every outgoing blob
// monolithically, which every shipped client on every platform opens.

export const CHUNKED_HEADER_LEN = 30

const MAGIC = [0x52, 0x43, 0x51, 0x4d, 0x31] // "RCQM1"
const VERSION = 1
const TAG_LEN = 16
const NONCE_PREFIX_AT = 22
const NONCE_PREFIX_LEN = 8

/// Sanity bounds on a header that arrived off the network. A blob claiming a
/// 2 GB chunk size must not make us allocate one, and a blob claiming 2^63
/// plaintext bytes must not be multiplied by anything.
const MIN_CHUNK = 64 * 1024
const MAX_CHUNK = 16 * 1024 * 1024
const MAX_PLAIN = 64 * 1024 * 1024 * 1024

export interface ChunkedHeader {
  /// The 30 header bytes exactly as they arrived: they are the AAD.
  bytes: Uint8Array
  chunkSize: number
  chunkCount: number
  plainLen: number
}

/// Are these leading bytes an RCQM1 container rather than a monolithic seal? A
/// monolithic blob starts with a 12-byte GCM nonce the sender generated, so it
/// can collide with this magic only by chance, at 1 in 2^48 per blob.
export function looksChunked(head: Uint8Array): boolean {
  if (head.length < MAGIC.length + 1) return false
  for (let i = 0; i < MAGIC.length; i++) if (head[i] !== MAGIC[i]) return false
  return head[MAGIC.length] === VERSION
}

export function chunkCountFor(plainLen: number, chunkSize: number): number {
  if (plainLen <= 0) return 1
  return Math.ceil(plainLen / chunkSize)
}

/// Exact encoded length of a container holding this much plaintext.
export function chunkedBlobLength(plainLen: number, chunkSize: number): number {
  return CHUNKED_HEADER_LEN + plainLen + TAG_LEN * chunkCountFor(plainLen, chunkSize)
}

/// Parse and sanity-check a header. `blobLength` is the encoded length when it
/// is known (a `Content-Length` we trust) and null when it is not; the reader
/// then proves the same fact by demanding the stream end exactly after the last
/// record.
///
/// ⚠ Order matters: the bounds are checked BEFORE any arithmetic runs on the
/// numbers they bound, so a header claiming 2^63 bytes is rejected here rather
/// than inside a multiplication.
export function parseChunkedHeader(head: Uint8Array, blobLength: number | null): ChunkedHeader | null {
  if (head.length < CHUNKED_HEADER_LEN) return null
  const bytes = head.slice(0, CHUNKED_HEADER_LEN)
  if (!looksChunked(bytes)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const chunkSize = view.getUint32(6, false)
  const chunkCount = view.getUint32(10, false)
  const declared = view.getBigUint64(14, false)
  if (declared > BigInt(MAX_PLAIN)) return null
  const plainLen = Number(declared)
  if (chunkSize < MIN_CHUNK || chunkSize > MAX_CHUNK) return null
  if (chunkCount <= 0 || chunkCount !== chunkCountFor(plainLen, chunkSize)) return null
  if (blobLength !== null && blobLength !== chunkedBlobLength(plainLen, chunkSize)) return null
  return { bytes, chunkSize, chunkCount, plainLen }
}

/// Plaintext bytes in record `index`.
export function chunkPlainLen(h: ChunkedHeader, index: number): number {
  return Math.max(0, Math.min(h.chunkSize, h.plainLen - index * h.chunkSize))
}

/// Encoded bytes of record `index`: its ciphertext plus its tag.
export function chunkRecordLen(h: ChunkedHeader, index: number): number {
  return chunkPlainLen(h, index) + TAG_LEN
}

function u32be(v: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, v >>> 0, false)
  return out
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/// Decrypt and VERIFY one record. `record` is `ciphertext || tag(16)`, which is
/// exactly the layout WebCrypto wants, so there is nothing to split.
///
/// Throws when the tag does not check out, which for this container also means
/// reordered, dropped, truncated or edited.
export async function openChunk(
  record: Uint8Array,
  index: number,
  h: ChunkedHeader,
  key: CryptoKey,
): Promise<Uint8Array> {
  const iv = concat(h.bytes.slice(NONCE_PREFIX_AT, NONCE_PREFIX_AT + NONCE_PREFIX_LEN), u32be(index))
  const aad = concat(h.bytes, u32be(index))
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource, additionalData: aad as unknown as BufferSource, tagLength: TAG_LEN * 8 },
    key,
    record as unknown as BufferSource,
  )
  return new Uint8Array(plain)
}

/// A byte-exact reader over a fetch body, because the container is a sequence
/// of records and a network chunk boundary has nothing to do with a record
/// boundary.
export class ByteReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private held: Uint8Array[] = []
  private have = 0
  private done = false

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader()
  }

  private async pull(): Promise<void> {
    if (this.done) return
    const { value, done } = await this.reader.read()
    if (done) {
      this.done = true
      return
    }
    if (value && value.length > 0) {
      this.held.push(value)
      this.have += value.length
    }
  }

  /// Exactly `n` bytes, or null when the stream ends first.
  async readExactly(n: number): Promise<Uint8Array | null> {
    while (this.have < n && !this.done) await this.pull()
    if (this.have < n) return null
    const out = new Uint8Array(n)
    let filled = 0
    while (filled < n) {
      const head = this.held[0]
      const take = Math.min(head.length, n - filled)
      out.set(head.subarray(0, take), filled)
      filled += take
      if (take === head.length) this.held.shift()
      else this.held[0] = head.subarray(take)
      this.have -= take
    }
    return out
  }

  /// Everything that is left, or null once it goes past `limit` — at which
  /// point the download is cancelled rather than run to the end for bytes
  /// nobody is going to be able to hold.
  async readAll(limit?: number): Promise<Uint8Array | null> {
    while (!this.done) {
      await this.pull()
      if (limit !== undefined && this.have > limit) {
        await this.cancel()
        return null
      }
    }
    const out = new Uint8Array(this.have)
    let filled = 0
    for (const part of this.held) {
      out.set(part, filled)
      filled += part.length
    }
    this.held = []
    this.have = 0
    return out
  }

  /// True when there is nothing more, which for a container is a fact worth
  /// checking: trailing bytes mean the file is not the file the header
  /// describes.
  async atEnd(): Promise<boolean> {
    while (this.have === 0 && !this.done) await this.pull()
    return this.have === 0 && this.done
  }

  async cancel(): Promise<void> {
    try {
      await this.reader.cancel()
    } catch {
      /* the body is already gone */
    }
  }
}

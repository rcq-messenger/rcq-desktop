// The per-member sealing fan-out, off the main thread.
//
// A send into a room with a long legacy tail is one `encryptV1` (X25519 +
// ChaCha + Ed25519, all in JS) PER MEMBER. On a slow Windows box that is
// 5-10ms each, and ~950 legacy members made the desktop "висит, часы" for
// many seconds even with the main-thread loop yielding between batches
// (founder relay, 31.08). Workers move the arithmetic off the UI thread
// entirely AND onto several cores at once - `group-crypto.ts` shards the
// roster across a small pool.
//
// The message protocol is one request per post: {reqId, envelope, sender,
// targets} in, {reqId, payloads, skipped} out. reqId is echoed back so two
// concurrent sends sharing the pool cannot adopt each other's answers.
// This file must stay importable OUTSIDE the DOM: only ./crypto (pure
// noble) may be imported here.

import { encryptV1, type Envelope, type WebIdentity } from './crypto'

interface SealRequest {
  reqId: number
  envelope: Envelope
  sender: WebIdentity
  targets: { uin: number; identityKey: string; signingKey: string }[]
}

self.onmessage = (e: MessageEvent<SealRequest>) => {
  const { reqId, envelope, sender, targets } = e.data
  const payloads: { to_uin: number; payload: string }[] = []
  const skipped: { uin: number; reason: string }[] = []
  for (const m of targets) {
    try {
      payloads.push({
        to_uin: m.uin,
        payload: encryptV1(envelope, sender, {
          uin: m.uin,
          identityKey: m.identityKey,
          signingKey: m.signingKey,
        }),
      })
    } catch (err) {
      skipped.push({ uin: m.uin, reason: err instanceof Error ? err.message : 'encrypt_failed' })
    }
  }
  ;(self as unknown as Worker).postMessage({ reqId, payloads, skipped })
}

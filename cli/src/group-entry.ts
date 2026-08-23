// Third bundle entry: the group send/receive path alone, for the fully-offline
// round-trip test (cli/test/group-roundtrip.mjs). Same purpose as
// crypto-entry.ts: prove the wiring the CLI now depends on without touching
// an island.
//
// `newTestIdentity` is here and only here: the real ones come from
// auth.ts, which registers with a server. Two accounts and one group are the
// whole fixture, and every byte of what happens between them is production
// code from src/lib.

import { x25519, ed25519 } from '@noble/curves/ed25519'
import { bytesToB64, type WebIdentity } from '../../src/lib/crypto'

export { buildGroupDualSend } from '../../src/lib/group-crypto'
export { handleGmsg, handleSkdm } from '../../src/lib/sender-key-receive'
export { decryptV1, bytesToB64 } from '../../src/lib/crypto'
export { knowsKid, ownsKid } from '../../src/lib/sender-key-store'
export { heldGmsgCount } from '../../src/lib/held-gmsg'
export { ackLiveGroupRow, drainGroupLog, forgetVouched, MAX_STRIKES, vouchedSeq } from '../../src/lib/group-log'

export function newTestIdentity(uin: number): WebIdentity & { identityKeyB64: string; signingKeyB64: string } {
  const identityPriv = crypto.getRandomValues(new Uint8Array(32))
  const signingPriv = crypto.getRandomValues(new Uint8Array(32))
  const identityPub = x25519.getPublicKey(identityPriv)
  const signingPub = ed25519.getPublicKey(signingPriv)
  return {
    uin,
    jwt: '',
    apiBase: 'http://127.0.0.1:9',
    identityPriv,
    identityPub,
    signingPriv,
    signingPub,
    identityKeyB64: bytesToB64(identityPub),
    signingKeyB64: bytesToB64(signingPub),
  }
}

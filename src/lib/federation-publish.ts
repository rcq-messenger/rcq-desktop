// Federation Layer B (F1) — publish this account's signed home-island record.
//
// Orchestration glue between the pure `federation.ts` codec, the libsignal
// device (for the identity key `ik`), and the API client. Kept separate so
// `federation.ts` stays dependency-free and unit-testable.

import type { WebIdentity } from './crypto'
import { bytesToB64 } from './crypto'
import { getDevice } from './signal-device'
import { buildHomeIslandRecord } from './federation'
import { publishIslandRecord } from './api'
import { assembleHomes, publishRecordToBackups } from './multihome'

/// Build, sign, and publish (or refresh) this account's home-island record.
///
/// Fire-and-forget: any failure — an island without the F1 endpoint, a transient
/// network error, a not-yet-bootstrapped libsignal device — is swallowed and
/// returns false, so this can NEVER block or break login. The homes list is the
/// primary island plus any backup homes the user added (multihoming v1); the
/// same signed record is PUT to every home, so senders can resolve it from
/// whichever island survives.
export async function publishHomeIslandRecord(identity: WebIdentity): Promise<boolean> {
  try {
    const device = await getDevice(identity)
    const ik = device.signalIdentityKeyB64()
    const sk = bytesToB64(identity.signingPub)
    const homes = assembleHomes(identity)
    const ts = Math.floor(Date.now() / 1000)
    const record = buildHomeIslandRecord({ ik, sk, signingPriv: identity.signingPriv, homes, ts })
    await publishIslandRecord(identity, record)
    void publishRecordToBackups(identity, record)
    return true
  } catch {
    return false
  }
}

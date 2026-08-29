// The one 1:1 text send path every mode shares: v=2 fan-out with the v=1
// fallback, the self-carbon, the history append and the sent-id dedup mark.
// `rcq send` wraps it in its drain/exit lifecycle; interactive mode calls it
// once per typed line without ever leaving the process.

import { Api, peerBundleFrom } from '../../src/lib/api'
import { bytesToB64, encryptV1, type CarbonEnvelope, type Envelope, type TextEnvelope, type WebIdentity } from '../../src/lib/crypto'
import { PartialFanOutError, sendV2 } from '../../src/lib/signal-device'
import { tr } from './i18n'
import { appendHistory, markSent } from './receive'
import { err } from './style'
import { humanError } from './errors'

/// Where a carbon says the message went: a 1:1 peer, or a group. Exactly one
/// of the two, which is how every client reads the envelope.
export type CarbonDest = { to: number; gid?: undefined } | { gid: number; to?: undefined }

/// Deposit a self-carbon so the phone/desktop show this message as ours —
/// mirrors Chat.tsx sendMessageCarbon: v=1 sealed to our OWN account key,
/// outer type 'carbon' (non-pushable — our phone must not ring for a message
/// we just typed). Best-effort: the message already went out.
export async function sendMessageCarbon(identity: WebIdentity, dest: CarbonDest, inner: Envelope): Promise<void> {
  try {
    const carbon: CarbonEnvelope = { kind: 'carbon', to: dest.to ?? null, gid: dest.gid ?? null, env: inner }
    const selfBundle = peerBundleFrom({
      uin: identity.uin,
      identity_key: bytesToB64(identity.identityPub),
      signing_key: bytesToB64(identity.signingPub),
    })
    await Api.sendSealed(identity, identity.uin, encryptV1(carbon, identity, selfBundle), 'carbon')
  } catch (e) {
    // Best-effort for the MESSAGE, which is already gone, but not invisible:
    // without the carbon this line never appears on the phone, and a founder
    // reading his own chat there would see half a conversation with no hint
    // why.
    process.stderr.write(
      err.dim(tr('fail.carbon', { err: humanError(e) })) + '\n',
    )
  }
}

/// Tell my OTHER devices that I read a thread (megalist A2). Same frame the
/// web, Android and iOS speak: a `readmark` inside the ordinary self-carbon,
/// under the outer type the island already files as EPHEMERAL, so it reaches
/// my other devices without pushing a banner to my own phone and without
/// teaching the island one new fact. Best-effort and silent: a lost marker
/// only means the other device clears its badge when it is next opened.
export async function sendReadMarker(identity: WebIdentity, dest: CarbonDest): Promise<void> {
  if (dest.to != null && dest.to === identity.uin) return
  try {
    const carbon: CarbonEnvelope = {
      kind: 'carbon',
      to: dest.to ?? null,
      gid: dest.gid ?? null,
      env: { kind: 'readmark', at: Date.now() },
    }
    const selfBundle = peerBundleFrom({
      uin: identity.uin,
      identity_key: bytesToB64(identity.identityPub),
      signing_key: bytesToB64(identity.signingPub),
    })
    await Api.sendSealed(identity, identity.uin, encryptV1(carbon, identity, selfBundle), 'read')
  } catch {
    /* best-effort: the badge on the other device is not worth a line here */
  }
}

/// Encrypt + ship one text to a peer. Throws on failure. Prefer v=2 (one
/// ciphertext per device of the peer). reached === 0 means the peer published
/// no libsignal bundle — fall back to v=1 ECIES. A PARTIAL fan-out is a
/// failed send, not a smaller number: the v=1 copy would reach the device
/// that already has the message and still not the one that missed it
/// (Chat.tsx, same rule).
export async function sendText(
  identity: WebIdentity,
  uin: number,
  text: string,
): Promise<{ id: string; mode: string }> {
  const env: TextEnvelope = { kind: 'text', id: crypto.randomUUID().toUpperCase(), text }
  let mode: string
  const reached = await sendV2(identity, uin, env, 'message').catch((e) => {
    if (e instanceof PartialFanOutError) throw e
    return 0
  })
  if (reached > 0) {
    mode = `v2 devices=${reached}`
  } else {
    const info = await Api.userInfo(identity, uin)
    await Api.sendSealed(identity, uin, encryptV1(env, identity, peerBundleFrom(info)), 'message')
    mode = 'v1'
  }
  // Our own id is "seen" BEFORE the carbon goes out: with a live socket
  // (interactive mode) the island's WS echo of the carbon can arrive before
  // the POST's own response — a mark placed after the await loses that race
  // and the typed line prints twice.
  markSent(env.id)
  await sendMessageCarbon(identity, { to: uin }, env)
  // Our half of the conversation belongs in the history file too — and the
  // seed of `seen` on the NEXT process start comes from this very row, which
  // is what keeps a redelivered self-carbon from printing after a restart.
  appendHistory(identity.uin, { at: new Date().toISOString(), from: identity.uin, to: uin, envelope: env })
  return { id: env.id, mode }
}

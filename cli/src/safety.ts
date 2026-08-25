// Safety numbers: the one check that says an island did not put itself in the
// middle of a conversation.
//
// Everything else in RCQ assumes the island is hostile and works anyway —
// except the very first key exchange, which has to trust SOMEBODY for the
// peer's identity key, and that somebody is the island. Signal's answer, and
// ours, is to make the trust checkable: both sides compute one number from the
// two identity keys, and if a middle sat between them the two numbers differ.
// Reading sixty digits to each other over the phone is not elegant, and it is
// the only thing here a censor cannot forge.
//
// ⚠ THE SAME NUMBER AS THE PHONES. Android (`SignalSession.safetyNumber`) and
// iOS (`SignalSession.safetyNumber`) both feed the generator the bare UIN as
// the identifier, version 2, 5200 iterations. A different identifier — the
// account uuid, say, which is what the wasm parameter is called — produces a
// perfectly good number that disagrees with the phone in the other person's
// hand, which is worse than having no number at all.

// ⚠ The browser path of this import is rewritten by build.mjs to the node
// shim; that is where the wasm actually comes from in this client.
import { WasmPublicKey, generateSafetyNumber } from './signalwasm/signal_wasm.js'
import { getDevice } from '../../src/lib/signal-device'
import type { WebIdentity } from '../../src/lib/crypto'
import { readState, writeState } from './state'
import { tr } from './i18n'

/// Where the last identity key we saw for each peer is remembered, so a change
/// can be noticed. Per account: two accounts on one machine see different
/// peers and must not share the file.
function pinFile(myUin: number): string {
  return `identity-pins-${myUin}.json`
}

type Pins = Record<string, { key: string; at: string }>

function loadPins(myUin: number): Pins {
  try {
    const text = readState(pinFile(myUin))
    return text ? (JSON.parse(text) as Pins) : {}
  } catch (e) {
    if (e instanceof Error && /sealed/.test(e.message)) throw e
    return {}
  }
}


/// The identity key of the peer's lowest-numbered live device.
///
/// One authenticated GET for the list and one for that device's bundle. No
/// deposit token is spent: this is a lookup a person asked for by name, not a
/// send, and the anonymous key path exists to keep SENDS from naming a sender.
async function primaryDeviceKey(identity: WebIdentity, peerUin: number): Promise<string | null> {
  const get = (path: string): Promise<Response> =>
    fetch(`${identity.apiBase}${path}`, {
      headers: { Authorization: `Bearer ${identity.jwt}` },
      signal: AbortSignal.timeout(15_000),
    })
  const listRes = await get(`/keys/${peerUin}/devices`)
  if (!listRes.ok) return null
  const list = (await listRes.json()) as { devices?: Array<{ device_id: number }> }
  const ids = (list.devices ?? [])
    .map((d) => d.device_id)
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b)
  for (const id of ids) {
    const res = await get(`/keys/${peerUin}/devices/${id}/bundle`)
    if (!res.ok) continue
    const bundle = (await res.json()) as { signal_identity_key?: string | null }
    if (bundle.signal_identity_key) return bundle.signal_identity_key
  }
  return null
}

export interface SafetyResult {
  /// Sixty digits in groups of five, as both phones print them.
  number: string
  /// The peer's identity key, base64, exactly as it went into the number.
  peerKey: string
  /// Set when this peer's key is not the one we saw last time. Either they
  /// reinstalled — the ordinary case — or somebody is standing in the middle,
  /// and nothing here can tell those apart. Saying so is the whole job.
  changedFrom?: { key: string; at: string }
  /// True the first time we ever record a key for this peer.
  firstSeen: boolean
}

/// Compute (and remember) the safety number for one peer.
///
/// ⚠ The peer's key comes from their island, over the same connection
/// everything else uses, so this call ALONE proves nothing: an island that
/// wanted to sit in the middle would serve its own key here too. What makes it
/// a check is comparing the printed number with the one on their screen,
/// through a channel the island does not carry. The text this prints says so.
export async function safetyNumber(identity: WebIdentity, peerUin: number): Promise<SafetyResult> {
  // ⚠ The DEVICE bundle, not `/users/{uin}/info`. That field carries the
  // identity of the account's PRIMARY slot, which a console-only account never
  // fills: `rcq` registers as a secondary device and publishes its keys under
  // its own device id. Reading the user row gave "this person has no key" for
  // every peer whose phone had not claimed the primary slot — including, in
  // testing, both ends of a working conversation.
  //
  // The lowest live device id is used: it is the peer's oldest surviving
  // install, which is the one the phones compute their number against.
  const peerKey = await primaryDeviceKey(identity, peerUin)
  if (!peerKey) throw new Error(tr('safety.noKey', { uin: String(peerUin) }))

  const device = await getDevice(identity)
  const mine = device.signalIdentityKeyB64()

  const fp = generateSafetyNumber(
    String(identity.uin),
    WasmPublicKey.deserialize(new Uint8Array(Buffer.from(mine, 'base64'))),
    String(peerUin),
    WasmPublicKey.deserialize(new Uint8Array(Buffer.from(peerKey, 'base64'))),
  ) as { displayable: string }
  const digits = fp.displayable.replace(/\s+/g, '')
  const grouped = (digits.match(/.{1,5}/g) ?? []).join(' ')

  const pins = loadPins(identity.uin)
  const before = pins[String(peerUin)]
  const firstSeen = !before
  const changed = before && before.key !== peerKey ? before : undefined
  pins[String(peerUin)] = { key: peerKey, at: new Date().toISOString() }
  writeState(pinFile(identity.uin), JSON.stringify(pins, null, 1))

  return { number: grouped, peerKey, changedFrom: changed, firstSeen }
}

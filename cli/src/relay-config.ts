// The signed relay config, read the way the phones read it.
//
// Plain-Node twin of Android `net/RelayConfigStore.kt` (and the iOS
// `RelayConfigStore.swift` beside it): fetch a JSON payload from mirrors that
// are hard to block, verify an Ed25519 signature against the keys compiled
// into `src/lib/signing-keys.ts`, cache the verified text, and fall back
// through memory -> disk -> a bundled pool so a fresh install on a censored
// network still has something.
//
// The CLI uses three things out of it, and one of them it cannot use at all:
//
//   * `transport.front` - the CDN name to send flagship traffic to when the
//     island's own address is blocked. This one the CLI CAN act on by itself
//     (see routes.ts): a front is a hostname, and changing a hostname needs no
//     binary we do not have.
//   * `transport.probe` - what a relay is measured with, for the sing-box
//     config the CLI writes out (singbox.ts).
//   * `relays` - VLESS+Reality / Hysteria2 descriptors. Node cannot speak
//     either protocol, and no amount of TypeScript will make it. They are
//     carried here ONLY so `rcq routes --singbox` can hand them to a sing-box
//     the user installed themselves.
//
// ⚠ The version floor is load-bearing. A signature proves a payload came from
// us and says nothing about when: anyone who can answer for a mirror can
// replay an OLD signed payload and walk a client back onto relays we retired.
// So a payload older than one already trusted is refused, exactly as the
// phones refuse it.

import fs from 'node:fs'
import { verifySigned } from '../../src/lib/signing-keys'
import { statePath, writeFileAtomic } from './state'

export interface Relay {
  tag: string
  /// 'vless' | 'hysteria2'. Anything else is carried through untouched so a
  /// payload naming a protocol this build does not know stays usable for the
  /// rest of its relays.
  proto: string
  server: string
  port: number
  sni: string
  uuid?: string
  publicKey?: string
  shortId?: string
  flow?: string
  password?: string
  obfsPassword?: string
}

/// Where a payload can be read from. `https` is a mirror URL; `dns-txt` is a
/// name whose TXT record carries the same signed bytes, read over DoH - the
/// channel that survives both mirror names being blocked, since it rides
/// resolvers half the internet needs to stay up.
export interface Source {
  kind: 'https' | 'dns-txt'
  value: string
}

/// The two names compiled in. Tried in order; the first signature-valid
/// payload wins. GitHub raw leads because it is hit far less by RU DPI than
/// Cloudflare.
const BUNDLED_SOURCES: Source[] = [
  { kind: 'https', value: 'https://raw.githubusercontent.com/rcq-messenger/rcq-ios/main/relay-config.json' },
  { kind: 'https', value: 'https://relay.rcq.app/v1/config' },
]

/// DoH endpoints, tried in order, addressed BY IP on purpose: asking a
/// resolver by name means resolving that name through ordinary DNS first,
/// which is the very thing being tampered with on the networks this channel
/// exists for. Their certificates carry the addresses in the SAN, so
/// verification is unaffected. Four jurisdictions, including one that answers
/// inside RU - a resolver cannot forge a signed payload, so one that answers
/// beats one that does not.
const DOH_RESOLVERS = [
  'https://1.1.1.1/dns-query', // Cloudflare
  'https://77.88.8.8/dns-query', // Yandex, answers inside RU
  'https://8.8.8.8/dns-query', // Google
  'https://9.9.9.9/dns-query', // Quad9
]

/// How many mirrors one refresh will walk. Each dead entry costs its full
/// timeout, and a payload listing fifty of them would turn a one-shot command
/// into a stall.
const MAX_SOURCES = 8

const CACHE_FILE = 'relay-config.json'

/// Compiled-in transport names. Both live under the flagship apex, which is
/// the single point this whole mechanism exists to move off.
export const DEFAULT_FRONT = 'cdn.rcq.app'
const DEFAULT_PROBE = 'https://api.rcq.app/health'

/// Records we publish carry this, so a name that also holds SPF or
/// verification records yields ours without guessing.
const TXT_PREFIX = 'rcq1:'

/// Bundled pool: a copy of the live signed config, last synced with **v146
/// (2026-08-23)**, all 14 endpoints across 7 machines, in signed priority
/// order. Last-resort fallback when no verified remote or disk list exists.
///
/// ⚠ It must not rot. On Android the same list once led with a domestic relay
/// that had been dead for weeks, so the first thing a censored client did was
/// dial a corpse. Re-sync with `curl -s https://relay.rcq.app/v1/config`.
const BUNDLED: Relay[] = [
  { tag: 'relay-do-fra-spaces-hy2', proto: 'hysteria2', server: '165.22.90.214', port: 443, sni: 'fra1.digitaloceanspaces.com', password: 'JN0qzA4LJfhHPKKN3QHj4eN8', obfsPassword: 'jXfGkLToOkTihpeJzDiNf8Bb' },
  { tag: 'relay-do-fra-spaces', proto: 'vless', server: '165.22.90.214', port: 443, sni: 'fra1.digitaloceanspaces.com', uuid: '2081b3c4-faaa-4cce-a0ab-607197b28237', publicKey: 'n33TZTLNrc6X7jTGrKWex_sk8aIQ6Qqz-eC8lqYMii8', shortId: 'aa5d483441e59ac7', flow: 'xtls-rprx-vision' },
  { tag: 'relay-oracle-il-hy2', proto: 'hysteria2', server: '129.159.143.135', port: 443, sni: 'www.microsoft.com', password: 'bvuvu74CVsiXdcJazcYphnO5', obfsPassword: 'PaEHrZABTk36orhfFON7Jure' },
  { tag: 'relay-oracle-il', proto: 'vless', server: '129.159.143.135', port: 443, sni: 'identity.oraclecloud.com', uuid: 'ff005e0c-175e-4475-a166-eeac88f514e2', publicKey: '_Hhc-2pjkvR914mddMdmuoOVaT74vWR8Gby7KmJp9F8', shortId: '318567678ac9878e', flow: 'xtls-rprx-vision' },
  { tag: 'relay-gcp-hy2', proto: 'hysteria2', server: '35.238.53.96', port: 443, sni: 'www.apple.com', password: 'QaY3uT8EmfZxfON65jaT5bSu', obfsPassword: 'fLpJ2c211xjnZcP9VNcNpbZP' },
  { tag: 'relay-gcp', proto: 'vless', server: '35.238.53.96', port: 443, sni: 'storage.googleapis.com', uuid: '8e3b35d3-18a6-406d-9ac6-c5558a806663', publicKey: 'mQZ8CJeMWyf7oYGWJG8oOI52or2kx4yTthl6AGZkSTw', shortId: 'b5b8979af1f27aab', flow: 'xtls-rprx-vision' },
  { tag: 'relay-vultr-waw', proto: 'vless', server: '64.176.71.251', port: 443, sni: 'ams1.vultrobjects.com', uuid: '2dc3cc4a-3d74-47a4-8f29-657073848dcc', publicKey: 'jNGlh9lw8faMZxgjZ0crsqcjD7dyOAySnxi8jwUsa1Y', shortId: 'ec8b28c68570d463', flow: 'xtls-rprx-vision' },
  { tag: 'relay-vultr-sto', proto: 'vless', server: '70.34.202.59', port: 443, sni: 'ams1.vultrobjects.com', uuid: '3652f269-d343-4206-8a27-dab72305d44b', publicKey: 'b8Q-XENkmpr7mAu2_e-_MWBv4WBFUFb0hq1dNSTViCA', shortId: 'b4957b7708c70f80', flow: 'xtls-rprx-vision' },
  { tag: 'relay-vultr-nrt', proto: 'vless', server: '139.180.194.73', port: 443, sni: 'nrt1.vultrobjects.com', uuid: '9bafd931-cbb8-4d67-b448-0495a8e325bd', publicKey: 'yrARhKJ0ICe2wVf9J5uk5O2dHvWhE_I8Vx_904zwQGM', shortId: 'b264d5f88bc0589c', flow: 'xtls-rprx-vision' },
  { tag: 'relay-vultr-sgp', proto: 'vless', server: '45.76.161.32', port: 443, sni: 'sgp1.vultrobjects.com', uuid: '17d55bda-9ba1-4e6e-8409-f46b2ba97bd0', publicKey: 'mYfGMTa0mgxLm06jf2_HTum9U5gUk6AIcMCSzIuRsXQ', shortId: 'ed11110c170bd554', flow: 'xtls-rprx-vision' },
  { tag: 'relay-vultr-waw-hy2', proto: 'hysteria2', server: '64.176.71.251', port: 443, sni: 'ams1.vultrobjects.com', password: 'c8Hy1pVwL9WD1LwmRJhNGFUo', obfsPassword: '8idmG6yKcCPKsMy64fd3jDcg' },
  { tag: 'relay-vultr-sto-hy2', proto: 'hysteria2', server: '70.34.202.59', port: 443, sni: 'ams1.vultrobjects.com', password: '2bueOgUc8lnL9GGADukx3V38', obfsPassword: 'M8MxAKjD4UgfCT2JOwkeWKYp' },
  { tag: 'relay-vultr-nrt-hy2', proto: 'hysteria2', server: '139.180.194.73', port: 443, sni: 'nrt1.vultrobjects.com', password: 'End6wDZP7I3A1VQfCIdNezbP', obfsPassword: 'lXRUg2N6BQztKtho87GJmmos' },
  { tag: 'relay-vultr-sgp-hy2', proto: 'hysteria2', server: '45.76.161.32', port: 443, sni: 'sgp1.vultrobjects.com', password: '7CGkcQoLzH8piLuhTsO7P7za', obfsPassword: 'W50oij0htTu06KYbhVEVtpfU' },
]

interface Parsed {
  relays: Relay[]
  version: number | null
  onionEnabled: boolean
  front: string
  probe: string
  sources: Source[] | null
}

let cached: Parsed | null = null
let primed = false

/// The relay list to use right now: verified remote -> disk -> bundled.
export function relays(): Relay[] {
  prime()
  return cached?.relays.length ? cached.relays : BUNDLED
}

/// True when [relays] is serving a verified payload rather than the bundled
/// floor. Diagnostics only.
export function usingRemote(): boolean {
  prime()
  return !!cached?.relays.length
}

/// Version of the last verified payload we hold, or null when the list in use
/// is the bundled one.
export function version(): number | null {
  prime()
  return cached?.version ?? null
}

/// The CDN front for the flagship, bare hostname.
export function frontHost(): string {
  prime()
  return cached?.front || DEFAULT_FRONT
}

/// True when `host` names a known CDN front of the flagship: a ROAD to the
/// island, never an island. Covers the compiled-in name and whatever a signed
/// payload moved the front to.
export function isFrontHost(host: string | null | undefined): boolean {
  if (!host) return false
  const h = host.trim().toLowerCase()
  return h === frontHost().trim().toLowerCase() || h === DEFAULT_FRONT
}

/// What a relay is measured with inside a sing-box `urltest`.
///
/// ⚠ This one goes THROUGH each relay, so the relay's allow-list has to permit
/// it. Relays derive that list from this same signed config on a timer, so a
/// probe published on a name relays do not yet allow breaks relay selection
/// for everyone until they catch up.
export function probeUrl(): string {
  prime()
  return cached?.probe || DEFAULT_PROBE
}

/// True when the signed config turns onion routing on. The CLI reports this
/// and passes it to the sing-box config it writes; it cannot build a chain by
/// itself (see singbox.ts).
export function onionEnabled(): boolean {
  prime()
  return cached?.onionEnabled ?? false
}

/// Load the last verified payload off disk into memory. Cheap, synchronous,
/// and idempotent: called by every accessor so a command that only reads the
/// front host never touches the network.
export function prime(): void {
  if (primed) return
  primed = true
  try {
    const text = fs.readFileSync(statePath(CACHE_FILE), 'utf8')
    const p = verifyAndParse(text)
    if (p) cached = p
  } catch {
    /* never fetched one, or the cache is unreadable: bundled it is */
  }
}

/// The mirrors to walk, freshest knowledge first: the ones the last verified
/// payload named, then the compiled-in pair.
///
/// ★ The bundled pair is ALWAYS appended and never replaced. A published
/// source list is an ADDITION, not a substitution - otherwise one bad push (a
/// typo'd host, a domain that lapses) would point every installed client at a
/// dead mirror with no route back, and no later push could reach them to fix
/// it. Config entries lead because they are the reason this exists: the two
/// compiled-in names are exactly what a censor enumerates first.
export function effectiveSources(): Source[] {
  prime()
  const remote = cached?.sources
  if (!remote?.length) return BUNDLED_SOURCES
  const seen = new Set<string>()
  const out: Source[] = []
  for (const s of [...remote, ...BUNDLED_SOURCES]) {
    const k = `${s.kind}:${s.value}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(s)
    if (out.length >= MAX_SOURCES) break
  }
  return out
}

export interface RefreshResult {
  /// The source that answered with a signature-valid payload, or null.
  from: Source | null
  version: number | null
  /// Every source walked, with what it did, for `rcq routes`.
  tried: { source: Source; outcome: 'ok' | 'no-answer' | 'bad-signature' | 'stale' }[]
}

/// Fetch a fresh list. First signature-valid payload wins; persisted to disk
/// and memory for the next run. Best-effort: on a blocked network every source
/// fails and the disk or bundled list stays in use.
///
/// This runs through whatever `globalThis.fetch` currently is, which is how it
/// picks up the front or the user's proxy once routes.ts has engaged one. The
/// signed config is PUBLIC, so carrying it over either leaks nothing.
export async function refresh(): Promise<RefreshResult> {
  prime()
  const res: RefreshResult = { from: null, version: version(), tried: [] }
  for (const source of effectiveSources()) {
    let body: string | null = null
    try {
      body = source.kind === 'https' ? await fetchMirror(source.value) : await fetchDnsTxt(source.value)
    } catch {
      body = null
    }
    if (!body) {
      res.tried.push({ source, outcome: 'no-answer' })
      continue
    }
    // The floor is whatever we already trust, so a mirror serving a genuinely
    // signed but older payload cannot move us backwards.
    const floor = cached?.version ?? null
    const parsed = verifyAndParse(body, floor)
    if (!parsed) {
      // Tell a replay apart from a forgery: the first is a mirror lagging, the
      // second is somebody trying something.
      res.tried.push({ source, outcome: verifyAndParse(body) ? 'stale' : 'bad-signature' })
      continue
    }
    cached = parsed
    res.tried.push({ source, outcome: 'ok' })
    res.from = source
    res.version = parsed.version
    try {
      writeFileAtomic(statePath(CACHE_FILE), body)
    } catch {
      /* a cache we cannot write is a slower next run, not a failure */
    }
    break
  }
  return res
}

const MIRROR_TIMEOUT_MS = 8000

async function fetchMirror(url: string): Promise<string | null> {
  const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS) })
  return r.ok ? await r.text() : null
}

// -----------------------------------------------------------------
// DoH: the payload out of a TXT record.
//
// A resolver cannot forge what it serves. The payload is signed, so a hostile
// or compelled resolver can only withhold it or replay an old one, and replay
// is what the version floor above is for. What it does leak is that this
// machine asked for our name, so the query rides whatever route is engaged,
// exactly like the HTTPS mirrors do.
// -----------------------------------------------------------------

const TYPE_TXT = 16
const CLASS_IN = 1
/// A DNS answer is small; anything larger is not one.
const MAX_DNS_RESPONSE = 64 * 1024

async function fetchDnsTxt(name: string): Promise<string | null> {
  const query = buildDnsQuery(name)
  if (!query) return null
  for (const resolver of DOH_RESOLVERS) {
    try {
      const r = await fetch(resolver, {
        method: 'POST',
        headers: { 'Content-Type': 'application/dns-message', Accept: 'application/dns-message' },
        // Copied into a plain ArrayBuffer: a Uint8Array over a SharedArrayBuffer
        // is not a BodyInit, and the DOM types will not take one on faith.
        body: query.slice().buffer as ArrayBuffer,
        cache: 'no-store',
        signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS),
      })
      if (!r.ok) continue
      const buf = new Uint8Array(await r.arrayBuffer())
      if (buf.length > MAX_DNS_RESPONSE) continue
      const payload = parseDnsTxt(buf)
      if (payload) return Buffer.from(payload, 'base64').toString('utf8')
    } catch {
      /* the next resolver */
    }
  }
  return null
}

/// A minimal query: one question, recursion desired, ID zero as RFC 8484 asks
/// (a cached DoH response must not be keyed on a random id).
export function buildDnsQuery(name: string): Uint8Array | null {
  const labels = name.trim().replace(/^\.+|\.+$/g, '').split('.')
  if (!labels.length || labels.some((l) => l.length === 0 || l.length > 63)) return null
  const bytes: number[] = []
  const u16 = (v: number) => {
    bytes.push((v >> 8) & 0xff, v & 0xff)
  }
  u16(0) // ID
  u16(0x0100) // RD
  u16(1) // QDCOUNT
  u16(0)
  u16(0)
  u16(0)
  for (const label of labels) {
    const enc = Buffer.from(label, 'ascii')
    bytes.push(enc.length)
    for (const b of enc) bytes.push(b)
  }
  bytes.push(0)
  u16(TYPE_TXT)
  u16(CLASS_IN)
  return new Uint8Array(bytes)
}

/// Pull our payload out of a DNS response, or null when it is not there.
///
/// A single TXT record's character-strings arrive in order, which is why the
/// whole payload goes in ONE record: order ACROSS records is not guaranteed by
/// DNS, so a payload split over several could reassemble into garbage.
///
/// Every failure is a null rather than a throw: these are bytes from a
/// resolver we do not control, on a path whose whole purpose is to be tried
/// when other things are already broken.
export function parseDnsTxt(msg: Uint8Array): string | null {
  if (msg.length < 12) return null
  const u16 = (at: number) => (at + 1 < msg.length ? (msg[at] << 8) | msg[at + 1] : -1)
  const answers = u16(6)
  if (answers <= 0) return null

  let pos = 12
  const questions = u16(4)
  for (let i = 0; i < questions; i++) {
    const next = skipName(msg, pos)
    if (next === null) return null
    pos = next + 4
  }
  for (let i = 0; i < answers; i++) {
    const next = skipName(msg, pos)
    if (next === null) return null
    pos = next
    if (pos + 10 > msg.length) return null
    const type = u16(pos)
    const rdLength = u16(pos + 8)
    pos += 10
    if (rdLength < 0 || pos + rdLength > msg.length) return null
    if (type === TYPE_TXT) {
      let text = ''
      let p = pos
      const end = pos + rdLength
      while (p < end) {
        const len = msg[p]
        if (p + 1 + len > end) return null
        text += Buffer.from(msg.subarray(p + 1, p + 1 + len)).toString('ascii')
        p += 1 + len
      }
      if (text.startsWith(TXT_PREFIX)) return text.slice(TXT_PREFIX.length)
    }
    pos += rdLength
  }
  return null
}

/// Advance past a NAME, which may end in a compression pointer. Null on a
/// malformed one rather than following it: a pointer chain from an untrusted
/// response is a loop waiting to happen.
function skipName(msg: Uint8Array, start: number): number | null {
  let pos = start
  for (;;) {
    if (pos >= msg.length) return null
    const len = msg[pos]
    if (len === 0) return pos + 1
    if ((len & 0xc0) === 0xc0) return pos + 2 <= msg.length ? pos + 2 : null
    if (len > 63) return null
    pos += 1 + len
  }
}

// -----------------------------------------------------------------
// Verification.
// -----------------------------------------------------------------

/// Verify the Ed25519 signature, then parse. Null on any failure - a bad
/// signature is treated as no list at all.
///
/// [minVersion] refuses a payload older than one already trusted (see the
/// replay note at the top of the file). Null means no floor, which is what
/// disk-priming and the tests want.
export function verifyAndParse(text: string, minVersion: number | null = null): Parsed | null {
  let root: unknown
  let node: JNode
  try {
    node = parseJson(text)
    root = JSON.parse(text)
  } catch {
    return null
  }
  if (!node || node.k !== 'obj' || !root || typeof root !== 'object') return null
  const o = root as Record<string, unknown>
  const sigB64 = typeof o.sig === 'string' ? o.sig : null
  if (!sigB64) return null
  // Sign over everything except `sig`.
  const signed: JNode = { k: 'obj', v: node.v.filter(([k]) => k !== 'sig') }
  const message = Buffer.from(canonical(signed), 'utf8')
  let sig: Uint8Array
  try {
    sig = new Uint8Array(Buffer.from(sigB64, 'base64'))
  } catch {
    return null
  }
  if (!verifySigned('relay-config', new Uint8Array(message), sig)) return null

  const parsedVersion = typeof o.version === 'number' && Number.isFinite(o.version) ? o.version : null
  if (parsedVersion !== null && minVersion !== null && parsedVersion < minVersion) return null

  const onion = o.onion as { enabled?: unknown } | undefined
  const transport = o.transport as { front?: unknown; probe?: unknown } | undefined
  const relayList: Relay[] = []
  const withPriority: { p: number; r: Relay }[] = []
  if (Array.isArray(o.relays)) {
    for (const raw of o.relays) {
      const e = raw as Record<string, unknown>
      const s = (k: string) => (typeof e[k] === 'string' && e[k] ? (e[k] as string) : undefined)
      const tag = s('tag')
      const server = s('server')
      const sni = s('sni')
      const port = typeof e.port === 'number' ? e.port : null
      if (!tag || !server || !sni || port === null) continue
      withPriority.push({
        p: typeof e.priority === 'number' ? e.priority : 100,
        r: {
          tag,
          proto: s('proto') || 'vless',
          server,
          port,
          sni,
          uuid: s('uuid'),
          publicKey: s('public_key'),
          shortId: s('short_id'),
          flow: s('flow'),
          password: s('password'),
          obfsPassword: s('obfs_password'),
        },
      })
    }
  }
  withPriority.sort((a, b) => a.p - b.p)
  for (const x of withPriority) relayList.push(x.r)

  // A payload without `transport` leaves the names alone rather than resetting
  // them to the compiled-in ones: a rollback must not silently drag a client
  // back onto the apex. Same for `sources`.
  const front = typeof transport?.front === 'string' && transport.front.trim()
    ? transport.front.trim()
    : cached?.front || DEFAULT_FRONT
  const probe = typeof transport?.probe === 'string' && transport.probe.startsWith('https://')
    ? transport.probe
    : cached?.probe || DEFAULT_PROBE

  return {
    relays: relayList,
    version: parsedVersion,
    onionEnabled: onion?.enabled === true,
    front,
    probe,
    sources: parseSources(o.sources) ?? cached?.sources ?? null,
  }
}

/// `[{"type":"https","url":"..."}, {"type":"dns-txt","name":"..."}]`. Unknown
/// types are skipped rather than rejected, so a payload that adds a channel
/// this build cannot speak stays usable for everything else.
function parseSources(raw: unknown): Source[] | null {
  if (!Array.isArray(raw)) return null
  const out: Source[] = []
  for (const el of raw) {
    const o = el as Record<string, unknown>
    const type = typeof o?.type === 'string' ? o.type : 'https'
    if (type === 'https' && typeof o?.url === 'string' && o.url.startsWith('https://')) {
      out.push({ kind: 'https', value: o.url })
    } else if (type === 'dns-txt' && typeof o?.name === 'string' && o.name.trim()) {
      out.push({ kind: 'dns-txt', value: o.name.trim() })
    }
  }
  return out.length ? out : null
}

// -----------------------------------------------------------------
// Canonical JSON, byte-for-byte with the Python signer
// (`json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=False)`),
// Android's `RelayConfigStore.canonical` and iOS's JSONSerialization
// `[.sortedKeys, .withoutEscapingSlashes]`.
//
// ★ Numbers keep their SOURCE TEXT, which is why this parses the payload a
// second time instead of re-serialising what `JSON.parse` produced. A number
// that survives a JS round trip as `1e3` or `1.0` where the signer wrote
// `1000` or `1.0` is one byte off and one byte is the whole signature. Today's
// payloads carry only small integers, where the round trip happens to be
// exact - which is precisely the kind of thing that holds until somebody
// publishes a float.
// -----------------------------------------------------------------

type JNode =
  | { k: 'obj'; v: [string, JNode][] }
  | { k: 'arr'; v: JNode[] }
  | { k: 'str'; v: string }
  | { k: 'raw'; v: string }

export function parseJson(text: string): JNode {
  let i = 0
  const ws = () => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i++
  }
  const fail = (): never => {
    throw new Error(`bad json at ${i}`)
  }
  const str = (): string => {
    if (text[i] !== '"') fail()
    const start = i
    i++
    while (i < text.length) {
      const c = text[i]
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '"') {
        i++
        return JSON.parse(text.slice(start, i)) as string
      }
      i++
    }
    return fail()
  }
  const value = (): JNode => {
    ws()
    const c = text[i]
    if (c === '{') {
      i++
      const entries: [string, JNode][] = []
      ws()
      if (text[i] === '}') {
        i++
        return { k: 'obj', v: entries }
      }
      for (;;) {
        ws()
        const key = str()
        ws()
        if (text[i] !== ':') fail()
        i++
        entries.push([key, value()])
        ws()
        if (text[i] === ',') {
          i++
          continue
        }
        if (text[i] === '}') {
          i++
          return { k: 'obj', v: entries }
        }
        fail()
      }
    }
    if (c === '[') {
      i++
      const items: JNode[] = []
      ws()
      if (text[i] === ']') {
        i++
        return { k: 'arr', v: items }
      }
      for (;;) {
        items.push(value())
        ws()
        if (text[i] === ',') {
          i++
          continue
        }
        if (text[i] === ']') {
          i++
          return { k: 'arr', v: items }
        }
        fail()
      }
    }
    if (c === '"') return { k: 'str', v: str() }
    const start = i
    while (i < text.length && !' \t\r\n,}]'.includes(text[i])) i++
    const raw = text.slice(start, i)
    if (raw === 'true' || raw === 'false' || raw === 'null') return { k: 'raw', v: raw }
    if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?$/.test(raw)) fail()
    return { k: 'raw', v: raw }
  }
  const root = value()
  ws()
  if (i !== text.length) fail()
  return root
}

export function canonical(n: JNode): string {
  switch (n.k) {
    case 'obj': {
      const parts = [...n.v]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([k, v]) => `${jsonString(k)}:${canonical(v)}`)
      return `{${parts.join(',')}}`
    }
    case 'arr':
      return `[${n.v.map(canonical).join(',')}]`
    case 'str':
      return jsonString(n.v)
    default:
      return n.v
  }
}

/// Python's `json.dumps(ensure_ascii=False)` escaping: the two mandatory
/// escapes, the five short forms, everything else below 0x20 as \uXXXX, and
/// nothing else touched (no escaped slashes, no escaped non-ASCII).
function jsonString(s: string): string {
  let out = '"'
  for (const ch of s) {
    switch (ch) {
      case '"':
        out += '\\"'
        break
      case '\\':
        out += '\\\\'
        break
      case '\n':
        out += '\\n'
        break
      case '\r':
        out += '\\r'
        break
      case '\t':
        out += '\\t'
        break
      case '\b':
        out += '\\b'
        break
      case '\f':
        out += '\\f'
        break
      default:
        out += ch < ' ' ? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}` : ch
    }
  }
  return out + '"'
}

/// For the tests: forget everything read this run.
export function resetForTest(): void {
  cached = null
  primed = false
}

// An island trusted by its fingerprint, not by a certificate authority: the
// console half of docs/island-fingerprint-design.md (§7.4, with §1 to §5 for
// the rule, the fingerprint, the address form, the store and the words).
//
// Node's global fetch and WebSocket take no custom verifier. What Node does
// take is NODE_EXTRA_CA_CERTS, read once at startup, and this CLI already
// replaces its own process to set startup-only environment (env-proxy.ts).
// So a pinned island is one PEM under island-certs/ that rides that exec as
// an extra trust anchor, and the rule of §1 runs in a probe of OUR OWN before
// the first request to the island: one node:tls handshake whose verdict and
// whose leaf are both in our hands, whichever way the platform's check went.
//
// ⚠ Nothing is ever re-run automatically. The first text of §7.4 ran the rule
// only after a command had failed with a TLS error, then re-ran the command:
// with no success-path write there was no `ca` record for any island, so a
// self-signed certificate on the path to an island used daily over Let's
// Encrypt was pinned after one stderr line nobody in a script reads, and the
// re-run carried the bearer token through it. Here the probe comes FIRST, a
// CA island is written down as `ca` the day it is first used, and from then
// on a private certificate for it is a change that stops the command.
//
// ⚠ An anchor is an anchor for every host. NODE_EXTRA_CA_CERTS has no notion
// of "this certificate, for this address only", and the installer's
// certificates carry CA:TRUE (openssl's -x509 default), so an island operator
// pinned by this device could in principle sign a certificate for any other
// name that Node would then accept. The phones and the desktop compare the
// leaf hash per host and have no such widening.
//
// What narrows it, host by host: wherever the probe runs, a CA-only host (the
// flagship, the front) is checked against the platform roots ALONE whenever
// an anchor is pinned, so a chain the pinned island signed for api.rcq.app is
// refused; and an island that moves to a CA has its anchor removed the moment
// the `ca` record is written. That check only covers hosts the probe actually
// visits, which is why `rcq islands` asks for it explicitly before reading
// the catalogue off rcq.app - it runs outside the gate (TRUST_FREE), under
// the widened store, and the unsigned catalogue it reads is what `--island
// <n>` resolves against for the register that follows.
//
// What is NOT narrowed: every other connection a trust-free verb makes, and
// the transport's own hosts. A widened store is widened for the whole
// process. It is a limit of the mechanism and is written down as one, not
// solved.

import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import { envProxySupported } from './env-proxy'
import { tr } from './i18n'
import { stateDir, statePath, writeFileAtomic } from './state'
import { err } from './style'

export const PINS_FILE = 'island-pins.json'
export const CERTS_DIR = 'island-certs'
const BUNDLE_FILE = 'bundle.pem'

/// How long one probe may take, dial and handshake together. Shorter than the
/// route ladder's second budget: a host that does not answer in this long is
/// handed to the ladder, which has its own patience for a blocked network.
const PROBE_MS = 8000
/// The second ask, when the answer decides whether a PINNED island may be
/// dialled at all. Matches the route ladder's own second budget (routes.ts):
/// a throttled mobile link that needs eleven seconds is not an attack, and
/// refusing a command over our own impatience would be worse than the gap it
/// closes.
const PATIENT_PROBE_MS = 11000

// -----------------------------------------------------------------
// The fingerprint (§2)
// -----------------------------------------------------------------

/// SHA-256 over the DER of the leaf exactly as presented, canonical form: 64
/// lowercase hex characters. What `openssl x509 -noout -fingerprint -sha256`
/// prints, minus the colons.
export function fingerprintOfDer(der: Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(der).digest('hex')
}

/// Parse what a person typed or pasted (openssl's `AB:CD:…`, any case, spaces
/// tolerated) into the canonical form, or null when it is not a fingerprint.
export function parseFingerprint(raw: string): string | null {
  const s = raw.replace(/[\s:]/g, '').toLowerCase()
  return /^[0-9a-f]{64}$/.test(s) ? s : null
}

/// 16 groups of 4, four groups to a line: the shape a person compares by eye
/// against what the operator published.
export function displayFingerprint(fp: string): string {
  const groups = fp.match(/.{4}/g) ?? [fp]
  const lines: string[] = []
  for (let i = 0; i < groups.length; i += 4) lines.push(groups.slice(i, i + 4).join(' '))
  return lines.join('\n')
}

// -----------------------------------------------------------------
// The address (§3)
// -----------------------------------------------------------------

export interface IslandAddress {
  /// Lowercase; an IPv6 literal keeps its brackets, so the key reads as typed.
  host: string
  port: number
  /// `host:port`, the store key (§4). The port is always explicit here.
  key: string
  /// The origin every request names: `https://host[:port]`.
  url: string
  /// The fragment the person typed, canonical, or null when there was none.
  fp: string | null
  /// `http://` is a plaintext island (only the offline tests have one); no
  /// certificate, nothing to trust or pin.
  plain: boolean
}

export type AddressProblem = { error: 'syntax' | 'notFingerprint' | 'caOnly'; detail: string }

/// A typed address that cannot be used, as an error a dispatcher can turn
/// into a usage exit: nothing was dialled.
export class AddressError extends Error {}

/// Split the fragment off FIRST, then normalise the rest.
///
/// ⚠ The normalisers everywhere else (`new URL(…).host`, the phones' URI
/// parsers) drop a fragment without a word, which is exactly the failure §3
/// names: a person who typed `host#fp` believes they pinned, and the client
/// takes a first-use pin from whoever answers. So a fragment that is not 64
/// hex is an ADDRESS ERROR here, never dropped, and a fragment on a host that
/// is only ever trusted through an authority is one too.
export function parseIslandAddress(raw: string): IslandAddress | AddressProblem {
  const s = raw.trim()
  if (!s) return { error: 'syntax', detail: raw }
  const hash = s.indexOf('#')
  const frag = hash >= 0 ? s.slice(hash + 1) : null
  const rest = hash >= 0 ? s.slice(0, hash) : s
  let u: URL
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(rest) ? rest : `https://${rest}`)
  } catch {
    return { error: 'syntax', detail: raw }
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname) return { error: 'syntax', detail: raw }
  const plain = u.protocol === 'http:'
  const host = u.hostname.toLowerCase()
  const port = u.port ? Number(u.port) : plain ? 80 : 443
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'syntax', detail: raw }
  let fp: string | null = null
  if (frag !== null) {
    fp = parseFingerprint(frag)
    if (!fp || plain) return { error: 'notFingerprint', detail: frag }
    if (isCaOnlyHost(host)) return { error: 'caOnly', detail: host }
  }
  // A path prefix survives as it always has (`--island https://x/y` was never
  // cut back to the origin); a trailing slash does not.
  const url = u.origin + u.pathname.replace(/\/+$/, '')
  return { host, port, key: `${host}:${port}`, url, fp, plain }
}

/// The address to hand out: what the installer prints and the phones copy.
export function addressWithFingerprint(key: string, fp: string): string {
  return `${key.replace(/:443$/, '')}#${fp}`
}

/// One sentence for an address that cannot be used.
export function describeAddressProblem(p: AddressProblem): string {
  switch (p.error) {
    case 'notFingerprint':
      return tr('island.trust.notFingerprint', { frag: p.detail })
    case 'caOnly':
      return tr('island.trust.caOnly', { host: p.detail })
    default:
      return tr('island.trust.badAddress', { addr: p.detail })
  }
}

// -----------------------------------------------------------------
// CA-only hosts (§1)
// -----------------------------------------------------------------

const extraCaOnly = new Set<string>()

/// The flagship, the front, anything under rcq.app: never pinned, typed or not.
export function isCaOnlyHost(host: string): boolean {
  const h = host.toLowerCase()
  return h === 'rcq.app' || h.endsWith('.rcq.app') || extraCaOnly.has(h)
}

/// The route ladder registers the front here, in case the signed config ever
/// moves it off rcq.app: a road is not an island and gets no pin.
export function addCaOnlyHost(host: string): void {
  extraCaOnly.add(host.toLowerCase())
}

// -----------------------------------------------------------------
// The store (§4)
// -----------------------------------------------------------------

export type PinSource = 'tofu' | 'typed' | 'accepted'
export type PinRecord =
  | { mode: 'ca'; since: number }
  | { mode: 'pinned'; fp: string; source: PinSource; since: number; noticed?: boolean }
type Store = Record<string, PinRecord>

function readStore(): Store {
  try {
    const j = JSON.parse(fs.readFileSync(statePath(PINS_FILE), 'utf8')) as unknown
    return j && typeof j === 'object' ? (j as Store) : {}
  } catch {
    return {}
  }
}

function writeStore(s: Store): void {
  writeFileAtomic(statePath(PINS_FILE), JSON.stringify(s, null, 1) + '\n')
}

export function recordFor(key: string): PinRecord | null {
  return readStore()[key] ?? null
}

export function listRecords(): Array<{ key: string; rec: PinRecord }> {
  return Object.entries(readStore()).map(([key, rec]) => ({ key, rec }))
}

function certsDir(): string {
  const dir = path.join(stateDir(), CERTS_DIR)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/// `127.0.0.1_8443.pem`; an IPv6 key loses its brackets and its colons, which
/// is still one file per key because a host never contains `_`.
export function pemPath(key: string): string {
  return path.join(certsDir(), `${key.replace(/[[\]]/g, '').replace(/:/g, '_')}.pem`)
}

function readPem(key: string): string | null {
  try {
    return fs.readFileSync(pemPath(key), 'utf8')
  } catch {
    return null
  }
}

function writePem(key: string, pem: string): void {
  writeFileAtomic(pemPath(key), pem.trim() + '\n')
}

function removePem(key: string): void {
  try {
    fs.unlinkSync(pemPath(key))
  } catch {
    /* none to remove */
  }
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

/// Drop everything on file for `key`. True when there was something.
export function forget(key: string): boolean {
  const s = readStore()
  const had = key in s
  delete s[key]
  writeStore(s)
  removePem(key)
  return had
}

/// The pre-pin of §3: what a person typed goes on file BEFORE the first
/// connection, and only over a null record. Anything already there that
/// disagrees is a change to be shown, never a silent write: an address that
/// arrives in a chat for an island this device already trusts must not be
/// able to replace that trust because somebody opened it.
export type TypedResult = 'written' | 'same' | { disagrees: string | 'ca' }

export function pinTyped(key: string, fp: string, replace = false): TypedResult {
  const s = readStore()
  const rec = s[key]
  if (rec && rec.mode === 'pinned' && rec.fp === fp) return 'same'
  if (rec && !replace) return { disagrees: rec.mode === 'ca' ? 'ca' : rec.fp }
  s[key] = { mode: 'pinned', fp, source: 'typed', since: unixNow() }
  writeStore(s)
  // The old anchor must not outlive the old pin: as long as its PEM rides the
  // bundle, Node would still accept the certificate the person just replaced.
  if (rec) removePem(key)
  return 'written'
}

/// Every pinned island's PEM, in a stable order, for the bundle.
export function pinnedPems(): Array<{ key: string; pem: string }> {
  const out: Array<{ key: string; pem: string }> = []
  for (const { key, rec } of listRecords()) {
    if (rec.mode !== 'pinned') continue
    const pem = readPem(key)
    if (pem) out.push({ key, pem })
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

export function hasPinnedAnchors(): boolean {
  return pinnedPems().length > 0
}

// -----------------------------------------------------------------
// The bundle NODE_EXTRA_CA_CERTS points at
// -----------------------------------------------------------------

export function bundlePath(): string {
  return path.join(certsDir(), BUNDLE_FILE)
}

/// The variable a person may already have had. It is folded into our bundle
/// rather than replaced, and remembered across the exec, because after it
/// NODE_EXTRA_CA_CERTS names our file and nothing else says where theirs was.
function originalExtraCerts(): string | undefined {
  const orig = process.env.RCQ_EXTRA_CA_CERTS_ORIG
  if (orig !== undefined) return orig || undefined
  const cur = process.env.NODE_EXTRA_CA_CERTS
  return cur && cur !== bundlePath() ? cur : undefined
}

export interface TrustBundle {
  path: string
  /// sha256 of the file's content: what the environment carries, so a process
  /// can tell the bundle it was started with from the one on disk now.
  hash: string
}

/// Write the bundle of every pinned PEM (plus the person's own extra CAs) and
/// say where it is. Null when nothing is pinned, in which case the variable
/// is left exactly as the person had it.
export function trustBundle(): TrustBundle | null {
  const pems = pinnedPems()
  if (pems.length === 0) return null
  let head = ''
  const orig = originalExtraCerts()
  if (orig) {
    try {
      head = fs.readFileSync(orig, 'utf8').trim() + '\n'
    } catch {
      /* the person's file is gone; ours still carries the islands */
    }
  }
  const body = head + pems.map((p) => p.pem.trim() + '\n').join('')
  const file = bundlePath()
  let current: string | null = null
  try {
    current = fs.readFileSync(file, 'utf8')
  } catch {
    /* first bundle */
  }
  if (current !== body) writeFileAtomic(file, body)
  return { path: file, hash: crypto.createHash('sha256').update(body).digest('hex') }
}

/// The environment half: what an exec (or a probe child) must carry.
export function trustVars(b: TrustBundle): NodeJS.ProcessEnv {
  const vars: NodeJS.ProcessEnv = { NODE_EXTRA_CA_CERTS: b.path, RCQ_TRUST_BUNDLE: b.hash }
  const orig = originalExtraCerts()
  vars.RCQ_EXTRA_CA_CERTS_ORIG = orig ?? ''
  return vars
}

/// Take the pinned anchors into THIS process, for a pin taken mid-command.
///
/// Node 24.5 can change the default store at runtime, and every later
/// `fetch` and `WebSocket` reads it (verified on 26.0 against a self-signed
/// island: refused before the call, 200 after). On an older runtime the store
/// is fixed at startup, and the caller decides between an exec (before the
/// command has done anything) and telling the person to run it again.
export function adoptAnchors(): 'adopted' | 'needs-restart' {
  const t = tls as unknown as {
    setDefaultCACertificates?: (certs: readonly string[]) => void
    getCACertificates?: (type: string) => string[]
  }
  if (typeof t.setDefaultCACertificates !== 'function' || typeof t.getCACertificates !== 'function') {
    return 'needs-restart'
  }
  const have = new Set(t.getCACertificates('default').map(fingerprintOfPem))
  const add = pinnedPems()
    .map((p) => p.pem)
    .filter((pem) => !have.has(fingerprintOfPem(pem)))
  if (add.length === 0) return 'adopted'
  try {
    t.setDefaultCACertificates([...t.getCACertificates('default'), ...add])
    return 'adopted'
  } catch {
    return 'needs-restart'
  }
}

const pemFps = new Map<string, string>()
function fingerprintOfPem(pem: string): string {
  let fp = pemFps.get(pem)
  if (!fp) {
    try {
      fp = fingerprintOfDer(new crypto.X509Certificate(pem).raw)
    } catch {
      fp = `unparsable:${crypto.createHash('sha256').update(pem).digest('hex')}`
    }
    pemFps.set(pem, fp)
  }
  return fp
}

/// The roots the platform trusts and NOTHING we pinned: the list `caValid` is
/// judged against. Taken from the store this process really runs with (which
/// under the exec includes our bundle, hence the subtraction) rather than from
/// the Mozilla list alone, so a CA the person installed on the box counts as
/// the platform, the way it does for every other program here.
function platformRoots(): string[] {
  const t = tls as unknown as { getCACertificates?: (type: string) => string[] }
  const all = typeof t.getCACertificates === 'function' ? t.getCACertificates('default') : [...tls.rootCertificates]
  const ours = new Set(pinnedPems().map((p) => fingerprintOfPem(p.pem)))
  return all.filter((pem) => !ours.has(fingerprintOfPem(pem)))
}

// -----------------------------------------------------------------
// The rule (§1), pure
// -----------------------------------------------------------------

export type Verdict =
  | { ok: true; firstUse: boolean }
  | { ok: false; reason: 'ca_only' }
  | { ok: false; reason: 'changed'; old: string | 'ca'; typed: boolean }

/// `decide` of §1 over one record. `caValid` means BOTH gates, chain and name
/// for the host that was dialled. Returns what to write, if anything; the
/// caller owns the store so this stays testable without one.
export function decide(
  rec: PinRecord | null,
  caOnly: boolean,
  fp: string,
  caValid: boolean,
  now: number = unixNow(),
): { verdict: Verdict; write?: PinRecord } {
  if (caOnly) return { verdict: caValid ? { ok: true, firstUse: false } : { ok: false, reason: 'ca_only' } }
  if (rec && rec.mode === 'pinned' && rec.source === 'typed') {
    // The fingerprint the person was handed; an authority's signature is not
    // the identity they typed, so caValid changes nothing on this branch.
    if (rec.fp === fp) return { verdict: { ok: true, firstUse: false } }
    return { verdict: { ok: false, reason: 'changed', old: rec.fp, typed: true } }
  }
  if (caValid) {
    // A tofu or accepted pin is overwritten: the island moved to a CA.
    return {
      verdict: { ok: true, firstUse: false },
      write: rec && rec.mode === 'ca' ? undefined : { mode: 'ca', since: now },
    }
  }
  if (!rec) {
    return {
      verdict: { ok: true, firstUse: true },
      write: { mode: 'pinned', fp, source: 'tofu', since: now, noticed: true },
    }
  }
  if (rec.mode === 'ca') return { verdict: { ok: false, reason: 'changed', old: 'ca', typed: false } }
  if (rec.fp === fp) return { verdict: { ok: true, firstUse: false } }
  return { verdict: { ok: false, reason: 'changed', old: rec.fp, typed: false } }
}

// -----------------------------------------------------------------
// Dialling: direct, or through the proxy this process runs behind
// -----------------------------------------------------------------

/// ⚠ A raw socket walks straight past the user's proxy. The route ladder
/// keeps its raw probe for the unproxied case only and measures a proxied
/// run with a real request; this probe cannot (fetch shows no certificate),
/// so it speaks the proxy's own protocol: SOCKS5 CONNECT or HTTP CONNECT,
/// the two Node carries. Somebody who pointed RCQ at Tor must not have their
/// address handed to the island by the very check that guards the island.
function probeProxy(): string | null {
  if (!process.env.NODE_USE_ENV_PROXY || !envProxySupported()) return null
  return process.env.HTTPS_PROXY || process.env.https_proxy || null
}

const PROXY_PORT: Record<string, number> = { 'socks5:': 1080, 'http:': 80, 'https:': 443 }

function connectTcp(host: string, port: number, deadline: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port })
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error('ETIMEDOUT'))
    }, Math.max(1, deadline - Date.now()))
    sock.once('connect', () => {
      clearTimeout(timer)
      sock.removeAllListeners('error')
      resolve(sock)
    })
    sock.once('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

/// Exact-count reads off a socket, for the two proxy handshakes. Whatever
/// arrives past what was asked for is pushed back before the socket is handed
/// on, so TLS starts on a clean stream.
function byteReader(sock: net.Socket, deadline: number) {
  let buf = Buffer.alloc(0)
  let pending: { need: (b: Buffer) => number | null; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null =
    null
  const pump = (): void => {
    if (!pending) return
    const n = pending.need(buf)
    if (n === null) return
    const out = buf.subarray(0, n)
    buf = buf.subarray(n)
    const p = pending
    pending = null
    p.resolve(out)
  }
  const onData = (d: Buffer): void => {
    buf = Buffer.concat([buf, d])
    pump()
  }
  const onEnd = (): void => pending?.reject(new Error('proxy closed the connection'))
  const onError = (e: Error): void => pending?.reject(e)
  sock.on('data', onData)
  sock.on('end', onEnd)
  sock.on('error', onError)
  const timer = setTimeout(() => pending?.reject(new Error('ETIMEDOUT')), Math.max(1, deadline - Date.now()))
  const ask = (need: (b: Buffer) => number | null): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      pending = { need, resolve, reject }
      pump()
    })
  return {
    readN: (n: number) => ask((b) => (b.length >= n ? n : null)),
    readUntil: (seq: string) =>
      ask((b) => {
        const i = b.indexOf(seq)
        return i < 0 ? null : i + seq.length
      }),
    release: (): void => {
      clearTimeout(timer)
      sock.off('data', onData)
      sock.off('end', onEnd)
      sock.off('error', onError)
      if (buf.length) sock.unshift(buf)
    },
  }
}

async function socks5Connect(sock: net.Socket, u: URL, host: string, port: number, deadline: number): Promise<void> {
  const r = byteReader(sock, deadline)
  try {
    const user = decodeURIComponent(u.username)
    const pass = decodeURIComponent(u.password)
    sock.write(Buffer.from(user ? [5, 2, 0, 2] : [5, 1, 0]))
    const hello = await r.readN(2)
    if (hello[0] !== 5 || hello[1] === 0xff) throw new Error('not a SOCKS5 proxy')
    if (hello[1] === 2) {
      const ub = Buffer.from(user)
      const pb = Buffer.from(pass)
      sock.write(Buffer.concat([Buffer.from([1, ub.length]), ub, Buffer.from([pb.length]), pb]))
      const auth = await r.readN(2)
      if (auth[1] !== 0) throw new Error('SOCKS5 authentication refused')
    } else if (hello[1] !== 0) {
      throw new Error('SOCKS5 method not supported')
    }
    let addr: Buffer
    if (net.isIPv4(host)) addr = Buffer.concat([Buffer.from([1]), Buffer.from(host.split('.').map(Number))])
    else if (net.isIPv6(host)) addr = Buffer.concat([Buffer.from([4]), ipv6Bytes(host)])
    else {
      const hb = Buffer.from(host)
      addr = Buffer.concat([Buffer.from([3, hb.length]), hb])
    }
    const portB = Buffer.alloc(2)
    portB.writeUInt16BE(port)
    sock.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, portB]))
    const head = await r.readN(4)
    if (head[1] !== 0) throw new Error(`SOCKS5 refused the connection (reply ${head[1]})`)
    const rest = head[3] === 1 ? 4 + 2 : head[3] === 4 ? 16 + 2 : head[3] === 3 ? (await r.readN(1))[0] + 2 : -1
    if (rest < 0) throw new Error('SOCKS5 reply not understood')
    await r.readN(rest)
  } finally {
    r.release()
  }
}

function ipv6Bytes(host: string): Buffer {
  // Expand `::` and hand back the sixteen bytes; a scope id is not accepted.
  const halves = host.split('::')
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : []
  const fill = 8 - left.length - right.length
  const groups = [...left, ...Array<string>(halves.length > 1 ? fill : 0).fill('0'), ...right]
  const out = Buffer.alloc(16)
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g || '0', 16), i * 2))
  return out
}

async function httpConnect(sock: net.Socket, u: URL, host: string, port: number, deadline: number): Promise<void> {
  const r = byteReader(sock, deadline)
  try {
    const authority = `${net.isIPv6(host) ? `[${host}]` : host}:${port}`
    const auth = u.username
      ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}\r\n`
      : ''
    sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`)
    const head = (await r.readUntil('\r\n\r\n')).toString('latin1')
    const m = /^HTTP\/1\.[01] (\d{3})/.exec(head)
    if (!m || m[1] !== '200') throw new Error(`proxy answered ${m ? m[1] : 'not HTTP'} to CONNECT`)
  } finally {
    r.release()
  }
}

/// A TCP stream to `host:port`, through `proxy` when there is one.
async function dial(host: string, port: number, proxy: string | null, deadline: number): Promise<net.Socket> {
  if (!proxy) return connectTcp(host, port, deadline)
  const u = new URL(proxy)
  const scheme = u.protocol.toLowerCase()
  if (!(scheme in PROXY_PORT)) throw new Error(`proxy scheme ${scheme} not supported`)
  let up: net.Socket = await connectTcp(u.hostname.replace(/^\[|\]$/g, ''), Number(u.port || PROXY_PORT[scheme]), deadline)
  if (scheme === 'https:') {
    up = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const bareProxy = u.hostname.replace(/^\[|\]$/g, '')
      const t = tls.connect({ socket: up, host: bareProxy, servername: net.isIP(bareProxy) ? undefined : bareProxy })
      t.once('secureConnect', () => resolve(t))
      t.once('error', reject)
    })
  }
  try {
    if (scheme === 'socks5:') await socks5Connect(up, u, host, port, deadline)
    else await httpConnect(up, u, host, port, deadline)
  } catch (e) {
    up.destroy()
    throw e
  }
  return up
}

// -----------------------------------------------------------------
// The handshake
// -----------------------------------------------------------------

interface Handshake {
  /// Chain AND name, against the `ca` list given: the `caValid` of §1.
  authorized: boolean
  /// Node's code for why not (DEPTH_ZERO_SELF_SIGNED_CERT, CERT_HAS_EXPIRED,
  /// ERR_TLS_CERT_ALTNAME_INVALID, …), or null.
  error: string | null
  leafDer: Buffer
  leafPem: string
}

/// One TLS handshake against `ca`, lenient or strict, and the leaf. Lenient
/// (`rejectUnauthorized: false`) still runs the chain check and the default
/// checkServerIdentity and reports both through `authorized`; it only declines
/// to tear the socket down, which is what lets ONE handshake answer both
/// "does the platform trust this for this host" and "what did it present".
/// Two connects would let a middlebox show one certificate to the judge and
/// another to the pin.
async function handshake(
  addr: IslandAddress,
  ca: readonly string[],
  strict: boolean,
  proxy: string | null,
  budgetMs: number = PROBE_MS,
): Promise<Handshake | { failed: string }> {
  const deadline = Date.now() + budgetMs
  const bare = addr.host.replace(/^\[|\]$/g, '')
  let sock: net.Socket
  try {
    sock = await dial(bare, addr.port, proxy, deadline)
  } catch (e) {
    return { failed: (e as NodeJS.ErrnoException).code ?? (e as Error).message }
  }
  return new Promise((resolve) => {
    let done = false
    const finish = (r: Handshake | { failed: string }): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      t.destroy()
      resolve(r)
    }
    const timer = setTimeout(() => finish({ failed: 'ETIMEDOUT' }), Math.max(1, deadline - Date.now()))
    const t = tls.connect({
      socket: sock,
      host: bare,
      // SNI carries names only (RFC 6066); Node warns on an IP and ignores it.
      servername: net.isIP(bare) ? undefined : bare,
      ca: [...ca],
      rejectUnauthorized: strict,
    })
    t.once('secureConnect', () => {
      const x = t.getPeerX509Certificate()
      if (!x) return finish({ failed: 'no certificate presented' })
      const e = t.authorizationError as unknown
      finish({
        authorized: t.authorized,
        error: e ? (typeof e === 'string' ? e : ((e as { code?: string }).code ?? String(e))) : null,
        leafDer: Buffer.from(x.raw),
        leafPem: x.toString(),
      })
    })
    t.once('error', (e: NodeJS.ErrnoException) => finish({ failed: e.code ?? e.message }))
  })
}

// -----------------------------------------------------------------
// The probe: one handshake, then the rule, then the store
// -----------------------------------------------------------------

export type ProbeOutcome =
  /// The platform trusts the chain for this host; the record says `ca`.
  | { state: 'ca' }
  /// The pin matched, or a first use was taken; the PEM is on disk.
  /// `newAnchor` says the PEM was written by THIS probe, so this process
  /// started without it.
  | { state: 'pinned'; fp: string; firstUse: boolean; newAnchor: boolean }
  | { state: 'refused'; reason: 'ca_only' | 'changed'; old: string | 'ca'; fp: string; ca: boolean; typed: boolean; code: string | null }
  /// A leaf Node would refuse as an anchor anyway: expired, a SAN without
  /// the host. Not pinned, whatever §1 would have said.
  | { state: 'unpinnable'; fp: string; code: string }
  | { state: 'unreachable'; detail: string }

export async function probeIsland(
  addr: IslandAddress,
  opts: { proxy?: string | null; budgetMs?: number } = {},
): Promise<ProbeOutcome> {
  const proxy = opts.proxy === undefined ? probeProxy() : opts.proxy
  const h = await handshake(addr, platformRoots(), false, proxy, opts.budgetMs)
  if ('failed' in h) return { state: 'unreachable', detail: h.failed }
  const fp = fingerprintOfDer(h.leafDer)
  const caOnly = isCaOnlyHost(addr.host)
  const rec = recordFor(addr.key)
  const { verdict, write } = decide(rec, caOnly, fp, h.authorized)
  if (!verdict.ok) {
    return verdict.reason === 'ca_only'
      ? { state: 'refused', reason: 'ca_only', old: 'ca', fp, ca: false, typed: false, code: h.error }
      : { state: 'refused', reason: 'changed', old: verdict.old, fp, ca: h.authorized, typed: verdict.typed, code: h.error }
  }
  if (caOnly) return { state: 'ca' }
  if (write?.mode === 'ca' || (rec?.mode === 'ca' && h.authorized)) {
    if (write) {
      const s = readStore()
      s[addr.key] = write
      writeStore(s)
    }
    // A pinned island that moved to an authority: its private certificate is
    // no longer needed as an anchor and must stop widening the store.
    removePem(addr.key)
    return { state: 'ca' }
  }
  // A typed pin that a CA-valid chain hashes to: the platform carries it, and
  // a CA-issued leaf could not serve as a root anyway (Node builds no partial
  // chains), so no anchor is written.
  if (h.authorized) return { state: 'pinned', fp, firstUse: false, newAnchor: false }
  // Pinned, first use included. The PEM must be one Node can use as an
  // anchor for this host, or the command that follows fails on the very
  // certificate this device just agreed to. ⚠ The first handshake cannot say:
  // OpenSSL reports the self-signed chain before it looks at the dates, and
  // the name check never runs on a chain it rejected. So the leaf is tried as
  // the ONLY root, strictly, which is exactly the store the command will run
  // with; the error code of that is the one that gets printed.
  let newAnchor = false
  if (readPem(addr.key)?.trim() !== h.leafPem.trim()) {
    const t = await handshake(addr, [h.leafPem], true, proxy)
    if ('failed' in t) return { state: 'unpinnable', fp, code: t.failed }
    writePem(addr.key, h.leafPem)
    newAnchor = true
  }
  if (write) {
    const s = readStore()
    s[addr.key] = write
    writeStore(s)
  }
  return { state: 'pinned', fp, firstUse: verdict.firstUse, newAnchor }
}

// -----------------------------------------------------------------
// What the person sees (§5), and the gate every dialler goes through
// -----------------------------------------------------------------

/// A fingerprint under its own label, twice: the canonical form to paste into
/// a command or a diff, and under it the display form of §2 - 16 groups of 4,
/// four groups to a line. This is the moment the whole feature exists for, the
/// one where a person has to compare two hashes by eye, and nobody does that
/// on a run of sixty-four characters. The same shape the first-use notice
/// below uses.
function fingerprintLines(label: string, fp: string): string[] {
  return [`  ${label}: ${fp}`, err.dim(displayFingerprint(fp).replace(/^/gm, '    '))]
}

/// The §5.2 text: the host, what is on file, what was presented, and the
/// command that accepts it (the console's "Trust the new fingerprint").
export function describeRefusal(key: string, old: string | 'ca', fp: string, typed: boolean): string {
  const host = key.replace(/:443$/, '')
  const lines = [typed ? tr('island.trust.changed_typed', { host }) : tr('island.trust.changed', { host })]
  if (old === 'ca') lines.push(`  ${tr('island.trust.on_file')}: ${tr('island.trust.via_ca')}`)
  else lines.push(...fingerprintLines(tr('island.trust.on_file'), old))
  lines.push(...fingerprintLines(tr('island.trust.presented'), fp))
  lines.push(tr('island.trust.accept', { host, fp }))
  return lines.join('\n')
}

/// The §3 text for a fragment against a record that disagrees: what is on
/// file, what was entered, and the command that makes the entered one win.
export function describeTypedDisagreement(key: string, old: string | 'ca', fp: string): string {
  const host = key.replace(/:443$/, '')
  return [
    tr('island.trust.typedDisagrees', { host }),
    ...(old === 'ca'
      ? [`  ${tr('island.trust.on_file')}: ${tr('island.trust.via_ca')}`]
      : fingerprintLines(tr('island.trust.on_file'), old)),
    ...fingerprintLines(tr('island.trust.entered'), fp),
    tr('island.trust.accept', { host, fp }),
  ].join('\n')
}

export type GateResult = 'ok' | 'unreachable' | 'unverified' | 'refused' | 'unpinnable' | 'restart'

/// One outcome per host per process; the ladder and the drains ask again.
const gated = new Map<string, GateResult>()

/// The gate in front of the first request to an island in this process:
/// probe, apply the rule, say what has to be said on stderr, and answer
/// whether the request may go. `refused` and `unpinnable` mean it may not,
/// and nothing was sent; `restart` means the pin was taken but this runtime
/// cannot adopt it without a new process; `unreachable` is not a trust
/// verdict at all, the command is left to fail (or find a road) on its own.
///
/// A CA-only host with nothing pinned is not probed: the request's own
/// validation IS the platform check then, and one more handshake to the
/// flagship on every command would buy nothing. With an anchor pinned it is,
/// see the head of this file.
export async function trustIsland(url: string, opts: { proxy?: string | null } = {}): Promise<GateResult> {
  const addr = parseIslandAddress(url)
  if ('error' in addr || addr.plain) return 'ok'
  const memo = gated.get(addr.key)
  if (memo) return memo
  if (isCaOnlyHost(addr.host) && !hasPinnedAnchors()) return 'ok'
  let r = await probeIsland(addr, opts)
  // ⚠ "did not answer" is not a verdict, but for a PINNED island it is not a
  // pass either, and this is the only place that can tell. Nothing else in
  // this process enforces the pin: the command's own fetch is judged by Node
  // against the platform roots plus our anchors, never against the record, so
  // a probe that gives up hands the connection carrying the bearer token to
  // exactly the check §1's typed branch exists to override - and a typed pin
  // writes no PEM, so the honest island fails that check while an attacker's
  // CA-valid chain passes it. Ask once more on the ladder's own budget before
  // deciding: our eight seconds are shorter than the eleven a throttled link
  // is allowed, and stalling one handshake must not be a way to disarm the
  // pin.
  if (r.state === 'unreachable' && recordFor(addr.key)?.mode === 'pinned') {
    r = await probeIsland(addr, { ...opts, budgetMs: PATIENT_PROBE_MS })
  }
  const result = report(addr, r)
  gated.set(addr.key, result)
  return result
}

function report(addr: IslandAddress, r: ProbeOutcome): GateResult {
  const host = addr.key.replace(/:443$/, '')
  switch (r.state) {
    case 'ca':
      return 'ok'
    case 'pinned': {
      if (r.firstUse) {
        process.stderr.write(err.yellow(tr('island.trust.first_use', { host, fp: r.fp })) + '\n')
        process.stderr.write(err.dim(displayFingerprint(r.fp)) + '\n')
      }
      if (!r.newAnchor) return 'ok'
      if (adoptAnchors() === 'adopted') return 'ok'
      return 'restart'
    }
    case 'refused':
      if (r.reason === 'ca_only') {
        process.stderr.write(err.yellow(tr('island.trust.caOnlyRefused', { host, code: r.code ?? '?' })) + '\n')
      } else {
        process.stderr.write(err.yellow(describeRefusal(addr.key, r.old, r.fp, r.typed)) + '\n')
      }
      return 'refused'
    case 'unpinnable':
      process.stderr.write(err.yellow(tr('island.trust.notAnchor', { host, code: r.code })) + '\n')
      process.stderr.write(err.dim(displayFingerprint(r.fp)) + '\n')
      return 'unpinnable'
    case 'unreachable':
      if (process.env.RCQ_VERBOSE) process.stderr.write(`[trust] ${host}: ${r.detail}\n`)
      // A record that CONSTRAINS this connection and a probe that could not
      // check it: the command may not send. Said by whoever was about to -
      // `island fingerprint` reaches this too, and it sends nothing, so it
      // prints what is on file instead.
      return recordFor(addr.key)?.mode === 'pinned' ? 'unverified' : 'unreachable'
  }
}

/// The gate for an island reached on the SIDE of a command (a visited room's
/// island inside a drain, a foreign join): true when a request may go to it.
/// A refusal has already been printed by the gate; a pin this runtime cannot
/// adopt without a new process is said here, once, and the host is left
/// alone for this run, because a command is never re-run from the inside.
export async function visitedTrusted(host: string): Promise<boolean> {
  const r = await trustIsland(`https://${host}`)
  if (r === 'ok' || r === 'unreachable') return true
  if (r === 'unverified') {
    if (!unverifiedSaid.has(host)) {
      unverifiedSaid.add(host)
      process.stderr.write(err.yellow(tr('island.trust.unverified', { host })) + '\n')
    }
    return false
  }
  if (r === 'restart' && !restartSaid.has(host)) {
    restartSaid.add(host)
    process.stderr.write(err.yellow(tr('island.trust.restart', { host })) + '\n')
  }
  return false
}
const restartSaid = new Set<string>()
const unverifiedSaid = new Set<string>()

/// How an island is trusted, one line, for `whoami`, `islands` and the
/// `island fingerprint` command.
export function describeTrust(rec: PinRecord | null): string {
  if (!rec) return tr('island.trust.settings.none')
  if (rec.mode === 'ca') return tr('island.trust.settings.ca')
  return `${tr('island.trust.settings.pinned')} ${rec.fp}`
}

/// The record as a JSON document, for `--json`.
export function trustJson(key: string, rec: PinRecord | null): Record<string, unknown> | null {
  if (!rec) return null
  return rec.mode === 'ca'
    ? { mode: 'ca', since: rec.since || null }
    : { mode: 'pinned', fp: rec.fp, source: rec.source, since: rec.since, address: addressWithFingerprint(key, rec.fp) }
}

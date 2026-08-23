// The user's OWN proxy: every RCQ byte pushed through a SOCKS5 or HTTP proxy
// they already run - Tor (Orbot, or a `tor` on 127.0.0.1:9050), i2pd (:4447),
// an `ssh -D` tunnel, a box of their own somewhere else.
//
// Vocabulary follows the phones, where this shipped as LOCAL_PROXY
// (RCQ/docs/proxy-design.md): ONE proxy at a time, and the proxy IS the
// circumvention layer - it does not stack with anything else. On the phones
// the alternatives are the relay pool and onion mode; the CLI has no
// sing-box, so here the choice is only "straight at the island" or "through
// the proxy you named".
//
// -- Node carries the traffic, not us -------------------------------------
// NODE_USE_ENV_PROXY=1 makes BOTH the global fetch and the global WebSocket
// honour HTTP(S)_PROXY, socks5:// included (experimental, and real: verified
// against api.rcq.app on 2026-08-23, one CONNECT through a local SOCKS5 for
// the fetch and one for the socket). So nothing else in cli/src or src/lib
// has to learn that a proxy exists.
//
// -- Why the process re-execs itself --------------------------------------
// That environment is read ONCE, inside prepareMainThreadExecution, before a
// single line of our code runs - that is where undici's EnvHttpProxyAgent is
// built - and `node:undici` is not exposed, so the dispatcher cannot be
// swapped afterwards. Assigning to process.env from here does nothing at all.
//
// So engaging a proxy is either the bash launcher exporting the vars, or this
// process exec'ing itself again with them set. The launcher loses: it is only
// one of the ways in (`node cli/dist/rcq.mjs ...` and a packaged bin are the
// others), and a proxy that engages only when somebody happened to go through
// a shell script is a proxy that silently does not engage. process.execve
// replaces the process IMAGE - same pid, same fds, same tty, same exit code,
// no child to supervise, no signals to forward, no second holder of the state
// lock - which is exactly the exec(3) the launcher would have done, done from
// the one place that can read the config. Cost: one extra process start per
// command, and only while a proxy is set.
//
// ⚠ Two ways a proxy silently does NOT protect, both observed on this machine
// and both defended against in proxyEnv() below: a lowercase `https_proxy`
// left over in the shell OVERRIDES the uppercase one we set, and `NO_PROXY=*`
// sends everything direct while the config still reads "proxy: on".

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { canonical } from './aliases'
import { tr } from './i18n'
import { statePath, writeFileAtomic } from './state'

const FILE = 'proxy.json'

/// Presets, the same two the phones' helper text names.
const PRESETS: Record<string, string> = {
  tor: 'socks5://127.0.0.1:9050',
  orbot: 'socks5://127.0.0.1:9050',
  i2p: 'socks5://127.0.0.1:4447',
  i2pd: 'socks5://127.0.0.1:4447',
}

/// ⚠ The ONLY three schemes Node accepts. Anything else (socks5h://, socks4://)
/// makes node itself throw inside prepareMainThreadExecution - before our code
/// runs, on EVERY command, including the one that would have cleared it. That
/// is why the value is validated on the way IN and again on the way out.
const DEFAULT_PORT: Record<string, number> = { 'socks5:': 1080, 'http:': 80, 'https:': 443 }

export type ProxyParse = { url: string } | { error: 'syntax' | 'scheme'; detail: string }

/// Turn what a person typed into the one canonical form we store: scheme,
/// host, explicit port. A bare `127.0.0.1:9050` means socks5 (the shape copied
/// out of Tor's own docs); `tor` and `i2p` are the presets.
export function normalizeProxyUrl(raw: string): ProxyParse {
  const s = raw.trim()
  if (!s) return { error: 'syntax', detail: raw }
  const preset = PRESETS[s.toLowerCase()]
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
  // A bare address means SOCKS5, the shape copied out of Tor's own docs - but
  // only with an explicit port. Without one, `rcq proxy set on` would quietly
  // become socks5://on:1080 and the mistake would surface as a dead network.
  if (!preset && !hasScheme && !/:\d{1,5}$/.test(s)) return { error: 'syntax', detail: raw }
  const withScheme = preset ?? (hasScheme ? s : `socks5://${s}`)
  let u: URL
  try {
    u = new URL(withScheme)
  } catch {
    return { error: 'syntax', detail: raw }
  }
  const scheme = u.protocol.toLowerCase()
  if (!(scheme in DEFAULT_PORT)) return { error: 'scheme', detail: scheme.replace(/:$/, '') }
  if (!u.hostname) return { error: 'syntax', detail: raw }
  const port = u.port || String(DEFAULT_PORT[scheme])
  const n = Number(port)
  if (!Number.isInteger(n) || n < 1 || n > 65535) return { error: 'syntax', detail: raw }
  const auth = u.username ? `${u.username}${u.password ? `:${u.password}` : ''}@` : ''
  return { url: `${scheme}//${auth}${u.hostname}:${port}` }
}

/// What to print. A proxy URL can carry a password and this goes into terminal
/// scrollback, into whoami, into whatever the person pastes when asking for
/// help - so the secret never leaves the 0600 file.
export function redactProxyUrl(url: string): string {
  try {
    const u = new URL(url)
    if (!u.username) return url
    return `${u.protocol}//${u.username}:***@${u.hostname}${u.port ? `:${u.port}` : ''}`
  } catch {
    return url
  }
}

/// Whether THIS runtime honours the proxy environment at all.
///
/// ⚠ NODE_USE_ENV_PROXY, and its `--use-env-proxy` twin, landed in Node 24. On
/// 22 and 23 nobody reads those variables: the process runs DIRECT while every
/// status surface, which can only see the variables we set ourselves, reports
/// a proxy. So the capability is asked of the runtime rather than assumed, and
/// the runtime's own flag table is the question to ask - a version comparison
/// alone would have to guess about backports and vendor builds, so it is only
/// the fallback.
export function envProxySupported(): boolean {
  try {
    if (process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) return true
  } catch {
    /* an exotic runtime with no flag table; fall through to the version */
  }
  return Number(process.versions.node.split('.')[0]) >= 24
}

/// What the config says, INCLUDING the case where it says something we cannot
/// carry. The difference matters: "no proxy" is a direct connection somebody
/// chose, and "a proxy we cannot parse" is a direct connection nobody chose.
export type ProxyConfig =
  | { url: string; from: 'env' | 'file' }
  | { invalid: true; from: 'env' | 'file'; error: 'syntax' | 'scheme'; detail: string }
  | null

export function readProxyConfig(): ProxyConfig {
  const env = process.env.RCQ_PROXY?.trim()
  if (env !== undefined && env !== '') {
    if (/^(off|none|no|0)$/i.test(env)) return null
    const p = normalizeProxyUrl(env)
    return 'url' in p ? { url: p.url, from: 'env' } : { invalid: true, from: 'env', ...p }
  }
  let raw: unknown
  try {
    raw = (JSON.parse(fs.readFileSync(statePath(FILE), 'utf8')) as { url?: unknown }).url
  } catch {
    return null
  }
  if (typeof raw !== 'string') return null
  // Re-validated on the way out: a hand-edited file must not be able to brick
  // every command (see the DEFAULT_PORT note) - but it must not be able to
  // silently downgrade one to a direct connection either, which is why the
  // failure is a value here and not a null.
  const p = normalizeProxyUrl(raw)
  return 'url' in p ? { url: p.url, from: 'file' } : { invalid: true, from: 'file', ...p }
}

/// The configured proxy, or null for "straight at the island".
///
/// RCQ_PROXY beats the file, so one command can be run differently without
/// touching the config: `RCQ_PROXY=off rcq whoami` shows what the proxy was
/// hiding, `RCQ_PROXY=tor rcq send ...` borrows one for a single line.
///
/// ⚠ For DISPLAY. A value that does not parse reads as "none" here, which is
/// the right answer for `rcq proxy show` and the wrong one for the code that
/// decides whether a command may go out: that one asks [readProxyConfig] and
/// refuses.
export function readProxyUrl(): string | null {
  const c = readProxyConfig()
  return c && 'url' in c ? c.url : null
}

export function saveProxyUrl(url: string): void {
  writeFileAtomic(statePath(FILE), JSON.stringify({ url }, null, 1) + '\n')
}

/// True when there was something to clear.
export function clearProxyUrl(): boolean {
  try {
    fs.unlinkSync(statePath(FILE))
    return true
  } catch {
    return false
  }
}

/// The environment a proxied RCQ process runs in.
///
/// Both cases of every variable are written, to the SAME value: undici reads
/// `https_proxy` as well as `HTTPS_PROXY`, PREFERS the lowercase one, and
/// throws when the two disagree. NO_PROXY is emptied for the same class of
/// reason - a leftover `NO_PROXY=*` sends everything direct while the config
/// still says the proxy is on, which is the worst possible way to be wrong.
export function proxyEnv(url: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_USE_ENV_PROXY: '1',
    HTTP_PROXY: url,
    http_proxy: url,
    HTTPS_PROXY: url,
    https_proxy: url,
    NO_PROXY: '',
    no_proxy: '',
    RCQ_PROXY_ENGAGED: '1',
  }
}

/// Node prints "SOCKS5 proxy support is experimental" on every start once the
/// var is set. True, and not news; stderr is where this CLI talks to a person,
/// so it is silenced on the exec rather than lived with on every command.
const QUIET = '--disable-warning=ExperimentalWarning'

/// Commands that must NEVER run behind the proxy they are configuring: a dead
/// proxy would otherwise take `rcq proxy clear` down with everything else, and
/// there would be no way back except deleting the file by hand. `__probe` is
/// already started with the environment it wants.
function configuresProxy(argv: string[]): boolean {
  const first = argv.find((a) => a !== '' && !a.startsWith('--'))
  if (!first) return false
  const verb = canonical(first)
  return verb === 'proxy' || verb === '__probe'
}

/// True when the environment this process ALREADY runs in carries exactly the
/// proxy the config names, which is the only case where somebody else's
/// exported variables can stand in for our own re-exec.
///
/// ⚠ It used to be enough that NODE_USE_ENV_PROXY was set at all. That reads
/// "somebody is driving", and on the ordinary corporate box it means
/// `HTTPS_PROXY=http://proxy.corp:3128` in a shell profile: a user who then
/// pointed RCQ at Tor rode the corporate proxy instead, with every surface
/// reporting Tor, because the config was never engaged. Ours wins for RCQ's
/// own traffic, and a mismatch is a re-exec rather than a shrug.
function envCarries(url: string): boolean {
  if (!process.env.NODE_USE_ENV_PROXY) return false
  // Any NO_PROXY at all can send some or all of it direct, and which part is
  // not knowable from here. The environment we build clears it.
  if (process.env.NO_PROXY || process.env.no_proxy) return false
  const same = (v?: string): boolean => {
    if (!v) return false
    const p = normalizeProxyUrl(v)
    return 'url' in p && p.url === url
  }
  return (
    same(process.env.HTTPS_PROXY ?? process.env.https_proxy) &&
    same(process.env.HTTP_PROXY ?? process.env.http_proxy)
  )
}

/// Engage the configured proxy for THIS command, by replacing the process with
/// a copy of itself that has the environment Node needs. Returns only when
/// there is nothing to do; otherwise the call never comes back, or the command
/// is refused outright.
///
/// ⚠ Everything that can go wrong here fails CLOSED. A proxy is a promise
/// about who sees the connection, and every way of half-keeping it (a value we
/// cannot parse, a runtime that ignores the environment) is a direct
/// connection made by somebody who asked for the opposite. Refusing the
/// command is loud and recoverable; leaking is neither.
export function engageProxy(): void {
  if (process.env.RCQ_PROXY_ENGAGED === '1') return
  if (configuresProxy(process.argv.slice(2))) return
  const cfg = readProxyConfig()
  if (cfg && 'invalid' in cfg) {
    // `RCQ_PROXY=socks5h://127.0.0.1:9050 rcq send ...` used to send the
    // message over the user's own address, with no diagnostic and exit 0,
    // while `rcq proxy set` refused the same spelling to their face.
    process.stderr.write(
      tr(cfg.error === 'scheme' ? 'proxy.scheme' : 'proxy.syntax', { scheme: cfg.detail, arg: cfg.detail }) +
        '\n' +
        tr('proxy.refusedBadValue', { source: cfg.from === 'env' ? 'RCQ_PROXY' : 'proxy.json' }) +
        '\n',
    )
    process.exit(1)
  }
  if (!cfg) return
  if (!envProxySupported()) {
    // Node 22 and 23 set the variables and read none of them. Running anyway
    // is the one outcome that cannot be allowed: it registers the throwaway
    // account from the real address while `whoami` prints the proxy.
    process.stderr.write(tr('proxy.ignored', { version: process.version }) + '\n')
    process.stderr.write(tr('proxy.refusedUnsupported') + '\n')
    process.exit(1)
  }
  const url = cfg.url
  if (envCarries(url)) return
  const args = [QUIET, ...process.execArgv, ...process.argv.slice(1)]
  const env = proxyEnv(url)
  if (process.env.RCQ_VERBOSE) process.stderr.write(`[proxy] ${redactProxyUrl(url)}\n`)
  const execve = (process as { execve?: (f: string, a: string[], e: NodeJS.ProcessEnv) => never }).execve
  if (typeof execve === 'function') {
    execve(process.execPath, [process.execPath, ...args], env)
    return // unreachable: the image is gone
  }
  // No execve (Windows; POSIX has had it since Node 23.11). A blocking child
  // with our own stdio is second best - it costs a parent sitting there doing
  // nothing - but the alternative is running unprotected. spawnSync, not
  // spawn: the parent must not fall through into the command it just handed
  // over, and process.exit is the only way to stop that here without
  // unwinding module evaluation.
  const r = spawnSync(process.execPath, args, { env, stdio: 'inherit' })
  process.exit(r.status ?? 1)
}

/// What the probe child reports, one JSON line on stdout.
export interface ProbeResult {
  ok: boolean
  status?: number
  ms?: number
  island?: string
  /// Why it failed, in the words the message table knows.
  reason?: 'refused' | 'notSocks' | 'notHttp' | 'timeout' | 'status' | 'other'
  detail?: string
}

/// Child side of `rcq proxy test`: one request to the island's /health through
/// whatever proxy this process was started with, reported as one JSON line.
export async function runProbe(apiBase: string): Promise<void> {
  const ms = Number(process.env.RCQ_PROBE_TIMEOUT_MS) > 0 ? Number(process.env.RCQ_PROBE_TIMEOUT_MS) : 15_000
  const t0 = Date.now()
  let res: ProbeResult
  try {
    // Its own signal: the 20s blanket deadline in bootstrap is sized for
    // commands, and Tor's first circuit is slower than an ordinary request.
    const r = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(ms) })
    const took = Date.now() - t0
    if (!r.ok) {
      res = { ok: false, reason: 'status', status: r.status, ms: took }
    } else {
      const body = (await r.json().catch(() => ({}))) as { version?: string }
      res = { ok: true, status: r.status, ms: took, island: body.version }
    }
  } catch (e) {
    res = classifyProbeError(e, Date.now() - t0)
  }
  process.stdout.write(JSON.stringify(res) + '\n')
}

/// Turn what fetch threw into something a person can act on. The shapes are
/// undici's, all four observed against real proxies on 2026-08-23.
function classifyProbeError(e: unknown, ms: number): ProbeResult {
  const wrapped = e as {
    name?: string
    cause?: { name?: string; code?: string; message?: string; address?: string; port?: number }
  }
  const c = wrapped.cause
  if (wrapped.name === 'TimeoutError' || c?.name === 'TimeoutError') return { ok: false, reason: 'timeout', ms }
  if (c?.code === 'ECONNREFUSED') {
    return { ok: false, reason: 'refused', ms, detail: c.address ? `${c.address}:${c.port ?? '?'}` : '' }
  }
  if (c?.name === 'Socks5ProxyError' || (c?.code ?? '').startsWith('UND_ERR_SOCKS5')) {
    return { ok: false, reason: 'notSocks', ms, detail: c?.message ?? '' }
  }
  if (c?.name === 'HTTPParserError') return { ok: false, reason: 'notHttp', ms, detail: c?.message ?? '' }
  return { ok: false, reason: 'other', ms, detail: c?.code ?? c?.message ?? (e as Error)?.message ?? '' }
}

/// Parent side: run one probe in a child that really is behind `url`.
export function probeThroughProxy(url: string, apiBase: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const args = [QUIET, ...process.execArgv, process.argv[1], '__probe', '--island', apiBase]
    // The URL travels in the ENVIRONMENT, never in argv: on Linux every user
    // on the box can read another process's command line, and a proxy URL can
    // carry a password.
    const child = spawn(process.execPath, args, {
      env: proxyEnv(url),
      stdio: ['ignore', 'pipe', process.env.RCQ_VERBOSE ? 'inherit' : 'ignore'],
    })
    let out = ''
    child.stdout.on('data', (b: Buffer) => {
      out += b.toString()
    })
    child.on('error', (e) => resolve({ ok: false, reason: 'other', detail: e.message }))
    child.on('close', () => {
      const line = out.trim().split('\n').filter(Boolean).pop()
      if (!line) return resolve({ ok: false, reason: 'other', detail: 'no answer from the probe' })
      try {
        resolve(JSON.parse(line) as ProbeResult)
      } catch {
        resolve({ ok: false, reason: 'other', detail: line.slice(0, 120) })
      }
    })
  })
}

/// A proxy address nothing can ever be listening on, used as the control run
/// of `rcq proxy test`.
export const DEAD_PROXY = 'socks5://127.0.0.1:1'

/// Does this runtime really apply the proxy environment? Answered with
/// evidence rather than with a version number, and without one packet leaving
/// the machine.
///
/// A child is started behind DEAD_PROXY and asked for a page served by a
/// server on THIS machine's loopback. Honoured, the request dies at the dead
/// proxy; ignored, it arrives. So an answer of true means the environment was
/// ignored and any green result from the real run would have meant nothing.
///
/// ⚠ The control run used to ask the ISLAND, which made the detector announce
/// the problem by sending the exact unproxied packet it exists to prevent: the
/// person asking "is it safe to talk to the island yet" was answered with a
/// packet to the island. It also blamed the proxy on a network where the
/// island itself is blocked, which is the network this whole feature is for.
/// Loopback has neither failure: undici's env-proxy has no localhost bypass
/// (NO_PROXY is cleared in proxyEnv), verified 2026-08-23.
export function probeEnvIgnored(): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, version: 'control' }))
    })
    srv.on('error', () => resolve(false))
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port
      void probeThroughProxy(DEAD_PROXY, `http://127.0.0.1:${port}`).then((r) => {
        srv.close()
        resolve(r.ok)
      })
    })
  })
}

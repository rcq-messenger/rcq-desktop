// A sing-box config, written for a sing-box the CLI does not ship.
//
// This is where the honesty of the whole route ladder lives. The phones tunnel
// through VLESS+Reality and Hysteria2 by linking a Go sing-box core; Node has
// nothing to link, and writing either protocol in TypeScript is not a session
// of work, it is a project. So the CLI does the thing it CAN do well: it takes
// the same Ed25519-verified relay list the phones use, applies the same
// selection rules, and emits the config file. The user runs
//
//     sing-box run -c ~/.config/rcq/singbox.json
//     rcq proxy set socks5://127.0.0.1:1089
//
// and from then on every RCQ byte rides the relays. The circumvention is
// sing-box's; the relay list, the tiering and the entry guard are ours.
//
// ## The selection rules, and why they are not Android's verbatim
//
// Two of them are stricter here, both on the side of the adversarial review in
// `RCQ/docs/relay-distribution-v2.md`:
//
//   * **Community relays never win a latency race** (amendment B). `urltest`
//     picks the FASTEST passing outbound, so a well-provisioned hostile relay
//     WINS and becomes the sole hop, seeing client-IP together with the island.
//     So signed-config relays are the primary group and the broker pool is a
//     nested `urltest` entered only through a wide tolerance - theirs while any
//     of theirs answers, everyone else's when none do. This is the same shape
//     Android uses to keep a paying customer on their own nodes.
//   * **A broker relay is never an onion ENTRY** (amendment C, option b). The
//     broker asserts `tier` over plain TLS, so a compromised or MITM'd broker
//     could otherwise mint an entry - the one hop that sees the client's
//     address. Only the signed config, whose every byte is signed against a
//     key compiled into this build, names an entry here.
//
// ## What the CLI can honestly do about onion
//
// Choose the entry, and write the chain. Both halves of Android's guard are
// portable, because neither needs the tunnel: the entry is chosen by TCP
// reachability with nearest-and-spread, and it is STICKY across runs (the Tor
// guard lesson - pick once, keep, rotate only on confirmed block). What is NOT
// ours is the circuit: `detour` is a sing-box outbound option, and sing-box is
// what builds and carries the two hops.
//
// Single-hop-first is kept: if the pinned entry does not answer, the config
// degrades to a single-hop race over the signed-config relays ONLY, rather
// than a dead 2-hop chain. Connectivity first, but never by single-hopping an
// onion user through a relay they did not vouch for.

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { loadRoutesState, proxyActive, saveRoutesState } from './routes'
import { onionEnabled, probeUrl, relays as configRelays, type Relay } from './relay-config'

/// The local mixed (SOCKS5 + HTTP) inbound the emitted config listens on.
/// 1089 is the port the phones use for the same inbound, so the muscle memory
/// carries over; `rcq proxy set socks5://127.0.0.1:1089` is the other half.
export const DEFAULT_LOCAL_PORT = 1089

export interface SingBoxOptions {
  /// Where the mixed inbound listens.
  port?: number
  /// Force onion on or off. Absent follows the signed config, which is how the
  /// fleet flips it with no release.
  onion?: boolean
  /// Community relays from the broker, already fetched. Empty is the norm.
  community?: Relay[]
}

export interface SingBoxBuild {
  config: unknown
  /// What was decided, in the order it was decided, for the person reading the
  /// command's output. Never translated at this level: the caller maps them.
  shape: 'onion' | 'onion-degraded' | 'single-hop'
  entry?: string
  entryReachable?: boolean
  /// False when the entry was chosen WITHOUT touching the network, which is
  /// what happens behind a proxy. The caller says so out loud rather than
  /// letting "entry pinned" imply a measurement nobody took.
  entryProbed?: boolean
  trustedCount: number
  communityCount: number
  port: number
}

/// Build the config. Async only because the onion entry is chosen by probing.
export async function buildSingBox(opts: SingBoxOptions = {}): Promise<SingBoxBuild> {
  const port = opts.port ?? DEFAULT_LOCAL_PORT
  const trusted = configRelays()
  // Deduped by proto:server:port with the SIGNED entry kept, so a broker row
  // that names a relay we already trust cannot demote it into the community
  // group.
  const seen = new Set(trusted.map(key))
  const community = (opts.community ?? [])
    .filter((r) => !seen.has(key(r)) && (seen.add(key(r)), true))
    // ⚠ And anything that cannot become a valid outbound is dropped here rather
    // than written out half-formed. sing-box validates the file as a whole and
    // refuses ALL of it for one bad entry, so a single malformed community
    // descriptor would cost the user every trusted relay as well. The signed
    // list is not filtered: its contents are signed by us, and silently
    // dropping an entry we published would hide a bad push instead of showing
    // it.
    .filter(usable)
  const wantOnion = opts.onion ?? onionEnabled()
  const vless = trusted.filter((r) => r.proto === 'vless')
  const probe = probeUrl()

  const outbounds: unknown[] = []
  const build: SingBoxBuild = {
    config: null,
    shape: 'single-hop',
    trustedCount: trusted.length,
    communityCount: community.length,
    port,
  }

  if (wantOnion && vless.length >= 2) {
    const entry = await selectEntry(vless)
    build.entry = entry.relay.tag
    build.entryReachable = entry.reachable
    build.entryProbed = entry.probed
    if (entry.reachable) {
      // 2-hop: a STICKY entry carries opaque tunnels to a set of EXITS, each
      // `detour`ed through it, and a urltest races the exits so the exit
      // rotates while the entry stays put. The entry sees "forward to that
      // relay" and never the island; the exit sees "from the entry, to the
      // island" and never the client.
      //
      // Exits may include community relays, and that is deliberate: an exit
      // never learns the client's address, which is the whole property the
      // entry restriction protects. Mixing more traffic through more exits is
      // what the second hop is FOR.
      const exitPool = [...vless, ...community.filter((r) => r.proto === 'vless')].filter(
        (r) => r.tag !== entry.relay.tag,
      )
      build.shape = 'onion'
      outbounds.push(urltest('out', exitPool.map((r) => `onion-${r.tag}`), probe, 50))
      outbounds.push({ ...vlessOutbound(entry.relay), tag: 'onion-entry' })
      for (const ex of exitPool) outbounds.push({ ...vlessOutbound(ex), tag: `onion-${ex.tag}`, detour: 'onion-entry' })
    } else {
      // Onion wanted, chain cannot form. Single-hop over the TRUSTED list only.
      build.shape = 'onion-degraded'
      outbounds.push(urltest('out', trusted.map((r) => r.tag), probe, 50))
      for (const r of trusted) outbounds.push(outboundFor(r))
    }
  } else if (wantOnion) {
    build.shape = 'onion-degraded'
    outbounds.push(urltest('out', trusted.map((r) => r.tag), probe, 50))
    for (const r of trusted) outbounds.push(outboundFor(r))
  } else if (community.length) {
    // Tier split (amendment B): the signed-config race is `out`'s first
    // members, and the whole community pool enters as ONE nested member behind
    // a wide tolerance, so a fast hostile relay cannot take the traffic off a
    // trusted one. Only a real failure moves it.
    //
    // ⚠⚠ `out` is written FIRST, and the reason is not tidiness. With no
    // `route.final`, sing-box's default outbound is the FIRST outbound in the
    // file (verified against sing-box 1.13.12: a config whose first outbound
    // was a dead socks proxy failed every request through it, the same config
    // with `direct` first answered 200) - and `sing-box check` says nothing
    // either way. Emitting the community group first therefore sent ONE
    // HUNDRED PERCENT of the traffic through broker relays and never consulted
    // the tiered selector at all: the precise inversion of the rule this
    // branch exists to enforce, while the CLI printed "fallback only, never an
    // entry". `route.final` below states it a second time, in the field that
    // is meant to state it.
    build.shape = 'single-hop'
    outbounds.push(urltest('out', [...trusted.map((r) => r.tag), 'community'], probe, 3000))
    outbounds.push(urltest('community', community.map((r) => r.tag), probe, 50))
    for (const r of [...trusted, ...community]) outbounds.push(outboundFor(r))
  } else {
    build.shape = 'single-hop'
    outbounds.push(urltest('out', trusted.map((r) => r.tag), probe, 50))
    for (const r of trusted) outbounds.push(outboundFor(r))
  }

  build.config = {
    log: { level: 'warn' },
    inbounds: [{ type: 'mixed', tag: 'in', listen: '127.0.0.1', listen_port: port }],
    outbounds,
    // Every branch above builds exactly one selector and calls it `out`, and
    // this is the field that says so. Left out, sing-box picks the first
    // outbound in the file, which makes the ORDER of a JSON array into a
    // routing decision - a place where one careless push silently reroutes
    // everything (it already did once, see the amendment-B branch).
    route: { final: 'out' },
  }
  return build
}

function key(r: Relay): string {
  return `${r.proto}:${r.server}:${r.port}`
}

/// Whether this descriptor has everything its protocol needs. Exactly the
/// fields sing-box refuses the file over: a VLESS+Reality outbound needs a uuid
/// and a Reality public key, a Hysteria2 one needs a password.
function usable(r: Relay): boolean {
  if (r.proto === 'hysteria2') return !!r.password
  if (r.proto === 'vless') return !!r.uuid && !!r.publicKey
  return false
}

function urltest(tag: string, members: string[], url: string, tolerance: number): unknown {
  return { type: 'urltest', tag, outbounds: members, url, interval: '5m', tolerance }
}

function outboundFor(r: Relay): unknown {
  return r.proto === 'hysteria2' ? hysteria2Outbound(r) : vlessOutbound(r)
}

function vlessOutbound(r: Relay): Record<string, unknown> {
  return {
    type: 'vless',
    tag: r.tag,
    server: r.server,
    server_port: r.port,
    uuid: r.uuid ?? '',
    flow: r.flow ?? 'xtls-rprx-vision',
    tls: {
      enabled: true,
      server_name: r.sni,
      utls: { enabled: true, fingerprint: 'chrome' },
      reality: { enabled: true, public_key: r.publicKey ?? '', short_id: r.shortId ?? '' },
    },
  }
}

/// UDP + Salamander obfs, every QUIC packet XOR-wrapped so DPI cannot
/// fingerprint the handshake. `insecure` is true because the relay carries a
/// self-signed certificate: the authentication is the user password plus the
/// obfs password, not PKI.
function hysteria2Outbound(r: Relay): Record<string, unknown> {
  const o: Record<string, unknown> = {
    type: 'hysteria2',
    tag: r.tag,
    server: r.server,
    server_port: r.port,
    password: r.password ?? '',
    tls: { enabled: true, server_name: r.sni, insecure: true },
  }
  if (r.obfsPassword) o.obfs = { type: 'salamander', password: r.obfsPassword }
  return o
}

// -----------------------------------------------------------------
// The onion entry guard
// -----------------------------------------------------------------

/// TCP-connect latency in ms, or null. The same instrument Android ranks entry
/// candidates with, and the only one available without a tunnel: it says
/// whether the address answers, nothing about whether Reality is happy behind
/// it.
///
/// ⚠⚠ A RAW SOCKET, so it does NOT go through the user's proxy: Node's
/// env-proxy covers fetch and WebSocket and nothing else. It may only be
/// called when no proxy is engaged - [selectEntry] is the one caller and holds
/// that line, the same way routes.ts gates its own `tls.connect` twin.
function tcpLatencyMs(host: string, port: number, timeoutMs = 4000): Promise<number | null> {
  return new Promise((resolve) => {
    const started = Date.now()
    let done = false
    const finish = (v: number | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      sock.destroy()
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    const sock = net.connect({ host, port })
    sock.once('connect', () => finish(Date.now() - started))
    sock.once('error', () => finish(null))
  })
}

/// Pick the sticky onion ENTRY among the signed-config VLESS relays.
///
/// Keeps a pinned entry when it still answers (the Tor guard property: pick
/// once, keep, do not reshuffle every run - a reshuffling client can be made
/// to walk its whole candidate set by an adversary who blocks one at a time).
/// Otherwise probes in parallel and picks NEAREST WITH SPREAD: random among
/// everything within 50ms of the best, so near-equals share load while a
/// clearly closer entry still wins.
///
/// `reachable` false means every candidate stayed silent. That is not a guard,
/// it is a guess, and the caller degrades to single-hop rather than writing a
/// chain that cannot form.
///
/// ⚠⚠ BEHIND A PROXY NOTHING IS PROBED. The probe is a raw TCP connect, and a
/// raw socket walks straight past the proxy: `rcq proxy set tor` followed by
/// the documented `rcq routes --singbox` opened a plaintext connection from
/// the user's real address to EVERY signed-config VLESS relay in parallel,
/// while the process believed it was behind Tor. On the one network this
/// feature exists for, dialling the whole relay fleet in the clear is the
/// observation that burns the user and the pool together. So under a proxy the
/// entry is chosen without a measurement: the pin if there is one, otherwise a
/// random candidate, reported as unprobed. A config written from a guess is
/// worth a note in the output; a list of relay addresses handed to the local
/// observer is not recoverable.
async function selectEntry(
  candidates: Relay[],
): Promise<{ relay: Relay; reachable: boolean; probed: boolean }> {
  const pinnedTag = loadRoutesState().onionEntry
  const pinned = candidates.find((r) => r.tag === pinnedTag)
  if (proxyActive()) {
    const pick = pinned ?? candidates[Math.floor(Math.random() * candidates.length)]
    saveRoutesState({ onionEntry: pick.tag })
    // `reachable` true: a chain over the signed list is what an onion user
    // asked for, and the degraded shape is for an entry that ANSWERED nothing,
    // which is not something this branch is in a position to claim.
    return { relay: pick, reachable: true, probed: false }
  }
  if (pinned && (await tcpLatencyMs(pinned.server, pinned.port)) !== null) {
    return { relay: pinned, reachable: true, probed: true }
  }
  const measured = (
    await Promise.all(candidates.map(async (r) => ({ r, ms: await tcpLatencyMs(r.server, r.port) })))
  ).filter((x): x is { r: Relay; ms: number } => x.ms !== null)
  if (!measured.length) {
    // Every probe failed (the relay port may itself be filtered). Still SPREAD:
    // a random candidate beats always camping on the first one.
    const pick = candidates[Math.floor(Math.random() * candidates.length)]
    saveRoutesState({ onionEntry: pick.tag })
    return { relay: pick, reachable: false, probed: true }
  }
  const best = Math.min(...measured.map((m) => m.ms))
  const near = measured.filter((m) => m.ms <= best + 50)
  const pick = near[Math.floor(Math.random() * near.length)].r
  saveRoutesState({ onionEntry: pick.tag })
  return { relay: pick, reachable: true, probed: true }
}

/// ⚠ There is no rotate-on-confirmed-block here, and that is a gap rather than
/// an oversight. The phones rotate the guard when the tunnel stays dead for a
/// minute WHILE CARRYING TRAFFIC through it; this process never carries a byte
/// through the entry, so it has nothing to confirm a block with. What it does
/// instead is the part it can see: [selectEntry] drops a pin that stops
/// answering a TCP connect and picks again. An entry that answers TCP and then
/// refuses Reality needs the person to notice, and `rcq routes --singbox`
/// re-picking is the lever they have.

// -----------------------------------------------------------------
// The binary we do not ship
// -----------------------------------------------------------------

/// Where a `sing-box` executable sits on this machine, or null. Nothing is
/// executed to find out - the answer only ever becomes a line of advice.
export function findSingBox(): string | null {
  const names = process.platform === 'win32' ? ['sing-box.exe', 'sing-box.cmd'] : ['sing-box']
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const full = path.join(dir, name)
      try {
        fs.accessSync(full, fs.constants.X_OK)
        return full
      } catch {
        /* next */
      }
    }
  }
  return null
}

// -----------------------------------------------------------------
// The broker
// -----------------------------------------------------------------

/// Ask the island's broker for a few community relays.
///
/// Best-effort and rationed by design: the broker hands out a small
/// per-network subset so no single requester learns the pool (the Tor BridgeDB
/// problem). It is fetched through whatever route is engaged, which matters -
/// a blocked user reaches it through the front or their proxy or not at all.
///
/// ⚠ Every relay here is COMMUNITY as far as this client is concerned, whatever
/// `tier` the answer claims. See the amendment-C note at the top of the file.
export async function fetchBridges(apiBase: string, n = 5): Promise<Relay[]> {
  try {
    const res = await fetch(`${apiBase}/broker/bridges?n=${n}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return []
    const body = (await res.json()) as { relays?: unknown }
    if (!Array.isArray(body.relays)) return []
    const out: Relay[] = []
    for (const raw of body.relays) {
      const e = raw as Record<string, unknown>
      const s = (k: string) => (typeof e[k] === 'string' && e[k] ? (e[k] as string) : undefined)
      const server = s('server')
      const sni = s('sni')
      const port = typeof e.port === 'number' ? e.port : null
      if (!server || !sni || port === null) continue
      const proto = s('proto') || 'vless'
      out.push({
        // The broker returns no stable tag on purpose (clients dedup by
        // proto:server:port), so one is synthesised for the config file.
        tag: `broker-${proto}-${server.replace(/[^a-z0-9]/gi, '-')}-${port}`,
        proto,
        server,
        port,
        sni,
        uuid: s('uuid'),
        // ⚠ `pbk` and `sid`, not `public_key` and `short_id`. The broker serves
        // the descriptor in the same shape the in-chat relay-share card uses
        // (Android `ContactRelayStore.relayFromJson`), which is the vless-URL
        // spelling, while the SIGNED config uses the long one. Reading only the
        // long names produced a relay with an empty Reality key, and sing-box
        // refuses the WHOLE file for one bad outbound: a single community
        // descriptor took every trusted relay down with it. The long names stay
        // accepted so a future broker that speaks them is not broken by this.
        publicKey: s('pbk') ?? s('public_key'),
        shortId: s('sid') ?? s('short_id'),
        flow: s('flow'),
        // ⚠ Same story on the Hysteria2 side, and it was missed when the vless
        // half was fixed: the broker's schema is `pw` and `obfs`
        // (backend/app/routers/broker.py `_PROTO_KEYS`), which is what Android
        // reads (ContactRelayStore `password = s("pw"), obfsPassword =
        // s("obfs")`). Reading only the long names left every Hysteria2
        // community relay without a password, `usable()` dropped it, and the
        // CLI then told the user "the broker handed out nothing, it may be
        // blocked here too" about an answer it had received and thrown away.
        password: s('pw') ?? s('password'),
        obfsPassword: s('obfs') ?? s('obfs_password'),
      })
    }
    return out
  } catch {
    return []
  }
}

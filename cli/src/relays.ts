// Running sing-box, so that "the island is blocked" is one command.
//
// The client cannot speak VLESS+Reality or Hysteria2 — Node has no such
// transports, and bundling a Go binary into a client whose whole distribution
// story is one unpacked file is not a trade we make. sing-box can, so the
// division of labour has always been: rcq writes the config, sing-box carries
// the packets, `rcq proxy` points rcq at it.
//
// What was missing is the middle. A person who needed relays got a paragraph
// of prose and five manual steps: install sing-box, write the config, run it
// in another terminal, keep it running, point the proxy at it. This file does
// the four that are ours.
//
// ⚠ NOT a supervisor and not a service. It starts a detached child, writes
// down its pid, and can stop it; if the process dies, `rcq relays` says so on
// the next look and the person restarts it. A real supervisor is systemd's
// job, and pretending otherwise would mean shipping a daemon that has to
// survive updates, sleep and reboots, which is exactly where hand-rolled ones
// break silently.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'

import { readProxyUrl, saveProxyUrl, clearProxyUrl } from './env-proxy'
import { tr } from './i18n'
import { statePath, writeFileAtomic } from './state'
import { DEFAULT_LOCAL_PORT, buildSingBox, fetchBridges, findSingBox } from './singbox'

const PID_FILE = 'singbox.pid'
const CONFIG_FILE = 'singbox.json'
const LOG_FILE = 'singbox.log'

export interface RelayState {
  running: boolean
  pid?: number
  port?: number
  /// The proxy rcq is pointed at, which is only ours when it names our port.
  proxy?: string | null
}

function readPid(): { pid: number; port: number } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(PID_FILE), 'utf8')) as { pid?: number; port?: number }
    if (!raw.pid || !raw.port) return null
    return { pid: raw.pid, port: raw.port }
  } catch {
    return null
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function relayState(): RelayState {
  const held = readPid()
  if (!held) return { running: false, proxy: readProxyUrl() }
  if (!alive(held.pid)) {
    try {
      fs.unlinkSync(statePath(PID_FILE))
    } catch {
      /* already gone */
    }
    return { running: false, proxy: readProxyUrl() }
  }
  return { running: true, pid: held.pid, port: held.port, proxy: readProxyUrl() }
}

/// Wait for the local port to accept a connection. sing-box exits non-zero on
/// a bad config within a second or so, so a port that never opens is the
/// honest signal that something is wrong, and the log file says what.
async function waitForPort(port: number, ms = 12_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port }, () => {
        sock.destroy()
        resolve(true)
      })
      sock.on('error', () => resolve(false))
      sock.setTimeout(800, () => {
        sock.destroy()
        resolve(false)
      })
    })
    if (ok) return true
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

export interface StartResult {
  port: number
  pid: number
  shape: 'onion' | 'onion-degraded' | 'single-hop'
  trustedCount: number
  communityCount: number
}

/// Write the config, start sing-box detached, wait for its port, and point rcq
/// at it. Throws with a human sentence at every step that can fail.
export async function startRelays(apiBase: string, opts: { port?: number; onion?: boolean } = {}): Promise<StartResult> {
  const already = relayState()
  if (already.running) throw new Error(tr('relays.alreadyRunning', { pid: String(already.pid) }))
  const bin = findSingBox()
  if (!bin) throw new Error(tr('relays.noSingBox'))
  const port = opts.port ?? DEFAULT_LOCAL_PORT

  // Community relays are a best-effort extra: the broker may be unreachable on
  // exactly the network that needs this, and the signed list alone is enough.
  const community = await fetchBridges(apiBase).catch(() => [])
  const built = await buildSingBox({ port, onion: opts.onion, community })
  writeFileAtomic(statePath(CONFIG_FILE), JSON.stringify(built.config, null, 2))

  // ⚠ Detached, with its output on a file. Inheriting our stdio would tie the
  // tunnel's life to this command's terminal, which is the opposite of what
  // somebody starting relays wants; and a pipe nobody reads fills up and stops
  // the child dead.
  const log = fs.openSync(statePath(LOG_FILE), 'a', 0o600)
  const child = spawn(bin, ['run', '-c', statePath(CONFIG_FILE)], {
    detached: true,
    stdio: ['ignore', log, log],
  })
  child.unref()
  if (!child.pid) throw new Error(tr('relays.spawnFailed'))
  writeFileAtomic(statePath(PID_FILE), JSON.stringify({ pid: child.pid, port }))

  if (!(await waitForPort(port))) {
    try {
      process.kill(child.pid)
    } catch {
      /* it already died, which is why the port never opened */
    }
    try {
      fs.unlinkSync(statePath(PID_FILE))
    } catch {
      /* nothing to remove */
    }
    throw new Error(tr('relays.portNever', { file: statePath(LOG_FILE) }))
  }

  saveProxyUrl(`socks5://127.0.0.1:${port}`)
  return {
    port,
    pid: child.pid,
    shape: built.shape,
    trustedCount: built.trustedCount,
    communityCount: built.communityCount,
  }
}

/// Stop it and take the proxy back off, but only if the proxy is OURS: a
/// person who pointed rcq at their own Tor or ssh tunnel and then stopped
/// relays should not silently lose it.
export function stopRelays(): { stopped: boolean; proxyCleared: boolean } {
  const held = readPid()
  let stopped = false
  if (held && alive(held.pid)) {
    try {
      process.kill(held.pid)
      stopped = true
    } catch {
      /* it went away between the check and the signal */
    }
  }
  try {
    fs.unlinkSync(statePath(PID_FILE))
  } catch {
    /* nothing to remove */
  }
  const proxy = readProxyUrl()
  const ours = !!held && proxy === `socks5://127.0.0.1:${held.port}`
  const proxyCleared = ours ? clearProxyUrl() : false
  return { stopped, proxyCleared }
}

// Plain-Node twin of the socket half of src/lib/ws.tsx (which is a React
// provider and cannot be imported here). Same wire: wss(apiBase)/ws/{uin}
// ?token=..., {type:'ping'} every 25s (the island derives "online" from
// last_seen freshness and drops sockets silent ~90s), exponential backoff
// capped at 30s. The backoff resets only after a socket HELD for a while —
// ws.tsx learned on prod that resetting on open lets a socket that dies a
// second later redial once a second forever.

import { currentDeviceId } from '../../src/lib/signal-device'
import type { WebIdentity } from '../../src/lib/crypto'

/// Copied from message-receiver.tsx: every sealed 1:1 envelope_type a peer or
/// our own other device can push. The server ships each frame with ws `type` =
/// its envelope_type, so subscribing only to 'message' drops reactions, edits,
/// receipts and carbons on the floor until the next queue drain.
export const SEALED_WS_TYPES = new Set([
  'message', 'reaction', 'delete', 'edit', 'read', 'system', 'secscreen',
  'visit', 'bounce', 'carbon', 'homerec', 'skdm', 'sknack', 'call',
])

export interface SealedFrame {
  type: string
  payload: string
  group_id?: number | null
  to_device_id?: number | null
}

/// How long a socket has to hold before its backoff is forgiven. Longer than
/// the 25s heartbeat, so "opened, pinged once, died" is not a healthy session.
const STABLE_MS = 60_000
const PING_MS = 25_000

export class RcqSocket {
  private ws: WebSocket | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private redialTimer: ReturnType<typeof setTimeout> | null = null
  private backoff = 0
  private openedAt: number | null = null
  private stopped = false

  constructor(
    private identity: WebIdentity,
    private onSealed: (frame: SealedFrame) => void,
    private onOpen?: () => void,
    private onAuthRejected?: () => void,
  ) {}

  start(): void {
    this.stopped = false
    this.dial()
  }

  /// Whether a live, open socket is currently held. The watch loop polls the
  /// queue while this is false — a network that answers HTTPS but kills every
  /// WebSocket right after the handshake is a real, observed RCQ failure mode.
  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  stop(): void {
    this.stopped = true
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.redialTimer) clearTimeout(this.redialTimer)
    this.pingTimer = null
    this.redialTimer = null
    this.ws?.close(1000)
    this.ws = null
  }

  private dial(): void {
    const wsBase = this.identity.apiBase.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
    const url = `${wsBase}/ws/${this.identity.uin}?token=${encodeURIComponent(this.identity.jwt)}`
    const ws = new WebSocket(url)
    this.ws = ws
    this.openedAt = null

    ws.addEventListener('open', () => {
      this.openedAt = Date.now()
      process.stderr.write('[ws] connected\n')
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
      }, PING_MS)
      this.onOpen?.()
    })

    ws.addEventListener('message', (e) => {
      let data: unknown
      try {
        data = JSON.parse(String((e as MessageEvent).data))
      } catch {
        return // the island ships only JSON frames
      }
      const ev = data as SealedFrame
      if (typeof ev.type !== 'string' || !SEALED_WS_TYPES.has(ev.type)) return
      if (typeof ev.payload !== 'string' || !ev.payload) return
      // Live delivery is NOT filtered by the island — every socket of the
      // account sees every copy of a fan-out — so a copy addressed to a
      // sibling device is dropped here. It is queued for that device, not us.
      if (typeof ev.to_device_id === 'number' && ev.to_device_id !== currentDeviceId()) return
      this.onSealed(ev)
    })

    ws.addEventListener('close', (ev) => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.pingTimer) {
        clearInterval(this.pingTimer)
        this.pingTimer = null
      }
      if (this.stopped) return
      const { code, reason } = ev as { code: number; reason: string }
      const lived = this.openedAt ? Date.now() - this.openedAt : 0
      process.stderr.write(`[ws] closed code=${code} reason=${reason || '-'} lived=${(lived / 1000).toFixed(1)}s\n`)
      // 4401 / 4403 are auth-rejected — reconnecting cannot help.
      if (code === 4401 || code === 4403) {
        this.onAuthRejected?.()
        return
      }
      if (lived >= STABLE_MS) this.backoff = 0
      this.openedAt = null
      // Jittered so a fleet of cron'd CLIs bounced by one island restart does
      // not redial in lockstep.
      const delay = Math.min(30_000, 1000 * 2 ** this.backoff) + Math.floor(Math.random() * 1000)
      this.backoff = Math.min(this.backoff + 1, 5)
      this.redialTimer = setTimeout(() => this.dial(), delay)
    })

    ws.addEventListener('error', () => {
      // 'close' follows every error; redial is covered there.
    })
  }
}

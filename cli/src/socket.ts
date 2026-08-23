// Plain-Node twin of the socket half of src/lib/ws.tsx (which is a React
// provider and cannot be imported here). Same wire: wss(apiBase)/ws/{uin}
// ?token=..., {type:'ping'} every 25s (the island derives "online" from
// last_seen freshness and drops sockets silent ~90s), exponential backoff
// capped at 30s. The backoff resets only after a socket HELD for a while —
// ws.tsx learned on prod that resetting on open lets a socket that dies a
// second later redial once a second forever.

import { currentDeviceId } from '../../src/lib/signal-device'
import type { WebIdentity } from '../../src/lib/crypto'
import { escalateForDeadSockets } from './routes'
import { tr } from './i18n'
import { err } from './style'

/// Copied from message-receiver.tsx: every sealed 1:1 envelope_type a peer or
/// our own other device can push. The server ships each frame with ws `type` =
/// its envelope_type, so subscribing only to 'message' drops reactions, edits,
/// receipts and carbons on the floor until the next queue drain.
export const SEALED_WS_TYPES = new Set([
  'message', 'reaction', 'delete', 'edit', 'read', 'system', 'secscreen',
  'visit', 'bounce', 'carbon', 'homerec', 'skdm', 'sknack', 'call',
])

/// Island frames that are NOT envelopes: plain JSON the server writes itself.
/// A contact request is the one that matters most: it is the only way to
/// learn, without polling, that somebody is asking to be let in. Dropping
/// these is why an interactive session could not tell you the answer to a
/// request you had sent thirty seconds earlier.
/// `vault_changed` joins them for a quieter reason: the island tells every
/// OTHER session of the account that a sealed slot moved (the writer is left
/// out by install name, so this is never our own echo). Nothing is merged from
/// it in the mirror phase, but it is the only signal that the copy this
/// process believes is current no longer is: see directory.ts.
export const CONTROL_WS_TYPES = new Set([
  'contact_request', 'contact_response', 'contact_request_cancelled', 'vault_changed',
])

export interface SealedFrame {
  type: string
  payload: string
  group_id?: number | null
  to_device_id?: number | null
}

/// A `gmsg` broadcast: one ciphertext for a whole room, opened with the
/// sender-key chain rather than a session. It carries no `to_device_id` (the
/// room is addressed, not a device), so it needs its own route.
export interface GroupFrame {
  payload: string
  group_id: number
  /// Stage 5: the row's seq in the room's log, when the island logged the
  /// post. Absent on an older island, and when the post was not logged.
  seq?: number
}

/// A control frame, verbatim. Shapes differ per type, so the reader picks the
/// fields it knows and ignores the rest.
export interface ControlFrame {
  type: string
  [k: string]: unknown
}

export interface SocketHandlers {
  onSealed: (frame: SealedFrame) => void
  onGroup?: (frame: GroupFrame) => void
  onControl?: (frame: ControlFrame) => void
  onOpen?: () => void
  onAuthRejected?: () => void
}

/// How long a socket has to hold before its backoff is forgiven. Longer than
/// the 25s heartbeat, so "opened, pinged once, died" is not a healthy session.
const STABLE_MS = 60_000
const PING_MS = 25_000

/// How many sockets in a row must die on arrival before the route ladder is
/// asked to escalate. Three, the same streak front.ts uses on the web, and for
/// the same reason: a middlebox that passes HTTPS and kills WebSocket streams
/// is invisible to the health probe, so the only evidence is the sockets
/// themselves, and one dead socket is a network hiccup, not evidence.
const DEAD_STREAK = 3

export class RcqSocket {
  private ws: WebSocket | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private redialTimer: ReturnType<typeof setTimeout> | null = null
  private backoff = 0
  private openedAt: number | null = null
  private stopped = false
  /// Whether the person has already been told the connection is gone.
  ///
  /// A flapping network used to write two raw lines per redial (`[ws] closed
  /// code=1006 …`, `[ws] connected`) straight into the middle of a
  /// conversation, forever. The codes are debugging detail (RCQ_VERBOSE keeps
  /// them); what a person needs is one line when the client goes offline and
  /// one when it comes back.
  private downSaid = false
  /// Sockets that died on arrival since the last one that held.
  private deadStreak = 0

  constructor(
    private identity: WebIdentity,
    private handlers: SocketHandlers,
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
      if (process.env.RCQ_VERBOSE) process.stderr.write('[ws] connected\n')
      if (this.downSaid) {
        this.downSaid = false
        process.stderr.write(err.dim(tr('ws.up')) + '\n')
      }
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
      }, PING_MS)
      this.handlers.onOpen?.()
    })

    ws.addEventListener('message', (e) => {
      let data: unknown
      try {
        data = JSON.parse(String((e as MessageEvent).data))
      } catch {
        return // the island ships only JSON frames
      }
      const ev = data as SealedFrame
      if (typeof ev.type !== 'string') return
      if (CONTROL_WS_TYPES.has(ev.type)) {
        this.handlers.onControl?.(data as ControlFrame)
        return
      }
      if (ev.type === 'gmsg') {
        // Fanned to every capable member of the room, not to a device.
        const { group_id: gid, seq } = data as { group_id?: unknown; seq?: unknown }
        if (typeof ev.payload === 'string' && ev.payload && typeof gid === 'number') {
          this.handlers.onGroup?.({ payload: ev.payload, group_id: gid, seq: typeof seq === 'number' ? seq : undefined })
        }
        return
      }
      if (!SEALED_WS_TYPES.has(ev.type)) return
      if (typeof ev.payload !== 'string' || !ev.payload) return
      // Live delivery is NOT filtered by the island — every socket of the
      // account sees every copy of a fan-out — so a copy addressed to a
      // sibling device is dropped here. It is queued for that device, not us.
      if (typeof ev.to_device_id === 'number' && ev.to_device_id !== currentDeviceId()) return
      this.handlers.onSealed(ev)
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
      if (process.env.RCQ_VERBOSE) {
        process.stderr.write(`[ws] closed code=${code} reason=${reason || '-'} lived=${(lived / 1000).toFixed(1)}s\n`)
      }
      // 4401 / 4403 are auth-rejected — reconnecting cannot help.
      if (code === 4401 || code === 4403) {
        this.handlers.onAuthRejected?.()
        return
      }
      if (!this.downSaid) {
        this.downSaid = true
        process.stderr.write(err.dim(tr('ws.down')) + '\n')
      }
      if (lived >= STABLE_MS) {
        this.backoff = 0
        this.deadStreak = 0
      } else {
        this.deadStreak++
      }
      this.openedAt = null
      // Jittered so a fleet of cron'd CLIs bounced by one island restart does
      // not redial in lockstep.
      const delay = Math.min(30_000, 1000 * 2 ** this.backoff) + Math.floor(Math.random() * 1000)
      this.backoff = Math.min(this.backoff + 1, 5)
      // A run of sockets that never held is the signature of a middlebox that
      // lets HTTPS through and kills streams: the failure the route ladder's
      // own probe is structurally unable to see. Ask it to escalate, and
      // redial straight away when it moved us: waiting out the backoff on a
      // road we just abandoned buys nothing.
      if (this.deadStreak >= DEAD_STREAK) {
        this.deadStreak = 0
        void escalateForDeadSockets(this.identity.apiBase).then((changed) => {
          if (!changed || this.stopped) return
          if (this.redialTimer) clearTimeout(this.redialTimer)
          this.backoff = 0
          this.redialTimer = setTimeout(() => this.dial(), 250)
        })
      }
      this.redialTimer = setTimeout(() => this.dial(), delay)
    })

    ws.addEventListener('error', () => {
      // 'close' follows every error; redial is covered there.
    })
  }
}

// One-to-one calls over WebRTC, speaking the signalling the phones already
// speak.
//
// The server is a dumb relay for SDP and ICE (`app/routers/ws.py`): it forwards
// `call_*` frames between two accounts and enforces one call at a time. Media
// never touches it — it goes peer to peer over DTLS-SRTP, with the island's
// coturn as a relay of last resort.
//
// The wire is pinned by the existing clients and is NOT ours to redesign; every
// field below was read off Android `CallController.kt` and iOS `WebRTCManager
// .swift` rather than invented here:
//
//   → call_offer      {to_uin, call_id, media:"audio"|"video", sdp}
//   → call_answer     {to_uin, call_id, sdp}
//   → call_ice        {to_uin, call_id, candidate: JSON "{sdp,sdpMLineIndex,sdpMid}"}
//   → call_end        {to_uin, call_id, reason}
//   → call_renegotiate[_answer|_decline]   mid-call audio→video upgrade
//   → call_ice_restart[_answer]            recover a dropped path, no re-ring
//
// Incoming frames are the same shape with `from_uin` instead of `to_uin`.
// ⚠ `sdp` is the RAW SDP text, not a serialised RTCSessionDescription, and the
// ICE candidate is a JSON STRING whose key for the candidate line is `sdp`.
// Both are easy to get subtly wrong and neither fails loudly — you just get a
// call that rings and never connects.
//
// ⚠⚠ ALL of the above is the SAME-ISLAND path. Every one of those frames names
// the peer by a bare `to_uin`, and the island that receives it resolves that
// number LOCALLY — so sending one for `1234@is2.rcq.app` rang our own #1234, a
// stranger. A peer on another island takes the §5d road instead: the identical
// signal, sealed into a `kind:"call"` envelope and deposited to their island
// (`crossisland-call.ts`). `signal()` below is the fork in the road, and it
// forks on ONE thing — whether the live call's peer has a host.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Api } from './api'
import { alwaysRelay } from './call-privacy'
import { dropCrossIslandIce, sendCrossIslandSignal } from './crossisland-call'
import { getCrossIsland } from './crossisland-store'
import { logCall } from './outgoing-store'
import { notifyDesktop, raiseDesktopWindow, turnTunnelUrl } from './desktop'
import { useI18n } from './i18n-context'
import { useIdentity } from './identity-context'
import { useWS } from './ws'
import { playEndTone, startRingback, startRingtone, stopTone } from './call-tones'

export type CallMedia = 'audio' | 'video'
export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connected' | 'ended'

export interface CallInfo {
  id: string
  peerUin: number
  peerName: string
  media: CallMedia
  outgoing: boolean
  /// The peer's island, when it is not ours (§5d). Set for the whole life of
  /// the call, on both sides, and it is what routes every signal: absent means
  /// the websocket, present means a sealed deposit to that host.
  peerHost?: string | null
}

/// How long an unanswered call rings before it gives up on its own. The caller
/// stops ringing first so the callee never keeps ringing for a call the caller
/// has already abandoned.
/// The line a finished call leaves in the conversation, in the phones' shape:
/// direction and kind, then either how long it lasted or why it did not.
///
/// The reasons come off the wire from whichever side hung up, so anything
/// unrecognised falls back to "ended" rather than to a blank row.
function logFinishedCall(info: CallInfo | null, reason: string, connectedAt: number | null): void {
  if (!info) return
  const secs = connectedAt ? Math.max(0, Math.round((Date.now() - connectedAt) / 1000)) : 0
  const connected = connectedAt !== null && secs >= 1
  // A call that rang here and was never answered is MISSED, whatever word the
  // other side put on the wire. The caller who gives up sends `ended`, not
  // `no_answer` — that one only fires on their own 60-second timeout — so
  // keying off the reason alone filed "A rang, I was away, A hung up" as an
  // ordinary finished call, grey arrow and all. The phones call it missed;
  // now so does this.
  const missed = !connected && !info.outgoing
  const parts = [
    info.media === 'video' ? 'call.log.video' : 'call.log.voice',
    info.outgoing ? 'call.log.outgoing' : 'call.log.incoming',
  ]
  const tail = connected
    ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
    : reason === 'declined' || reason === 'declinedElsewhere'
      ? 'call.log.declined'
      : reason === 'busy'
        ? 'call.log.busy'
        : // Nothing connected and it was not refused: for us it is "missed"
          // when it rang here, and "no answer" when it rang there.
          missed
          ? 'call.log.missed'
          : info.outgoing
            ? 'call.log.no_answer'
            : 'call.log.ended'
  // The keys are resolved at RENDER time, not here: the row outlives the
  // language the app happened to be in when the call ended.
  // The island goes on the row so a call with `1234@is2.rcq.app` is not filed
  // in the conversation of a local #1234 — one thread key, two different people.
  logCall(info.peerUin, `${parts[0]}|${parts[1]}|${tail}`, missed, Date.now(), info.peerHost)
}

const RING_TIMEOUT_MS = 60_000
const INCOMING_TIMEOUT_MS = 70_000
/// Answered, but no media path came up. Long enough for a slow TURN allocation
/// on a bad mobile network, short enough that nobody stares at a dead screen.
const CONNECT_TIMEOUT_MS = 30_000
/// ICE says "disconnected" on any blip. Wait before treating it as a real
/// break, or a lift ride costs you the call.
const DISCONNECT_GRACE_MS = 4_000
/// A connected call whose media stays down this long is OVER, whatever the
/// signalling said. #652: the peer hung up on a phone riding the obfuscated
/// transport, its `call_end` died with the tunnel, and this side sat in an
/// ICE-restart loop counting the call timer up forever. Restarts keep trying
/// inside this window; when it closes without a single 'connected', the call
/// ends locally. Generous on purpose - a network change plus a TURN
/// re-allocation must fit, or a metro ride ends real calls.
const DEAD_CALL_MS = 45_000
const TURN_FETCH_ATTEMPTS = 3
const TURN_RETRY_DELAY_MS = 700

/// Public STUN, same list the phones use. Only useful for discovering one's
/// own reflexive address; anything behind a symmetric NAT needs the TURN
/// relay that `Api.turnCredentials` hands out.
const STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
]

/// Bare hostname out of a `turn:host:port?transport=x` URI, for the desktop
/// TURN tunnel. Textual on purpose: TURN URIs are not something `new URL`
/// parses reliably in every webview we ship in.
function turnHostOf(url: string): string | null {
  const m = /^turns?:\[?([^\]:?]+)/.exec(url)
  return m && m[1] ? m[1] : null
}

interface CallCtx {
  phase: CallPhase
  info: CallInfo | null
  /// Why the last call ended, for the one-line summary on the ended card.
  endedReason: string
  localStream: MediaStream | null
  remoteStream: MediaStream | null
  /// Wall-clock ms when media actually started flowing (not when the call was
  /// answered) — the on-screen timer counts from here.
  connectedAt: number | null
  muted: boolean
  cameraOff: boolean
  /// The peer wants to turn this audio call into a video one.
  incomingUpgrade: boolean
  /// Set when we could not get a microphone at all, so the UI can say why the
  /// call refused to start instead of just vanishing.
  deviceError: string | null
  callable: boolean
  /// `peerHost` is the peer's island when they are not on ours (§5d) — the
  /// `?i=<host>` a cross-island thread carries. Omitted / null = our island,
  /// which is the same-island call this has always placed.
  start: (peerUin: number, peerName: string, media: CallMedia, peerHost?: string | null) => void
  accept: () => void
  decline: () => void
  hangUp: () => void
  toggleMute: () => void
  toggleCamera: () => void
  upgradeToVideo: () => void
  acceptUpgrade: () => void
  declineUpgrade: () => void
  dismissEnded: () => void
}

const Ctx = createContext<CallCtx | undefined>(undefined)

export function useCall(): CallCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useCall must be used inside <CallProvider>')
  return ctx
}

/// The live call's signal handler, published while <CallProvider> is mounted so
/// the receive loop can push a decrypted §5d envelope into it. A plain module
/// variable rather than a context because the receiver is not a component tree
/// away — it is `MessageReceiver`, a sibling that renders nothing.
let crossIslandSink: ((ev: { type: string; [k: string]: unknown }) => void) | null = null

/// Hand one decrypted cross-island call signal to the call state machine
/// (§5d). `ev` is in the SAME shape a websocket `call_*` frame arrives in —
/// `from_uin`, `call_id`, and the signal's own fields — plus `from_host`, which
/// is what tells the machine to answer back over a sealed deposit rather than
/// down our own island's socket.
///
/// The §5d gates (accepted contact, not blocked, offer not stale) are applied
/// by the CALLER, before this: they are consent and freshness rules about the
/// envelope, not about WebRTC, and the state machine below has no business
/// knowing them. A signal for a call this client does not have open simply
/// no-ops here, exactly as the websocket one does.
export function deliverCrossIslandCallSignal(ev: { type: string; [k: string]: unknown }): void {
  crossIslandSink?.(ev)
}

/// Everything the live call owns that must NOT be React state: the WS handler
/// and the timers read it from callbacks that were created many renders ago,
/// and a stale closure here is a call that answers into a dead peer connection.
interface Live {
  pc: RTCPeerConnection | null
  info: CallInfo | null
  local: MediaStream | null
  /// The callee's offer, held between "it is ringing" and "accept".
  pendingOffer: string | null
  /// ICE that arrived before the description it belongs to. Adding a candidate
  /// to a connection with no remote description throws, so it waits here.
  pendingIce: string[]
  /// Renegotiation (video upgrade) in flight, in either direction. An ICE
  /// restart must not be answered while one is, or the connection is asked to
  /// apply an offer in a non-stable signalling state.
  upgradeOffer: string | null
  upgradePending: boolean
  ringTimer: ReturnType<typeof setTimeout> | null
  connectTimer: ReturnType<typeof setTimeout> | null
  graceTimer: ReturnType<typeof setTimeout> | null
  /// Armed when a CONNECTED call's media path goes down; cleared the moment it
  /// comes back. Expiry = the peer is gone without a goodbye (#652).
  deadTimer: ReturnType<typeof setTimeout> | null
  /// Guards a double accept (a double click, or a click racing the Enter key)
  /// from running the answer path twice on one connection.
  accepting: boolean
}

/// Can this network actually get a relay candidate? Measured on a throwaway
/// connection with no media: cheap, and the alternative is guessing from the
/// presence of credentials, which says nothing about reachability.
///
/// Cached briefly, not for the session: a desktop window lives for days across
/// network changes, and a verdict measured on a long-gone Wi-Fi either forced
/// relay-only against a TURN that is no longer reachable (no candidates at
/// all) or silently skipped the relay this network now needs.
let relayProbe: Promise<boolean> | null = null
let relayProbeAt = 0
const RELAY_PROBE_TTL_MS = 120_000

function relayReachable(servers: RTCIceServer[]): Promise<boolean> {
  if (!servers.some((s) => 'username' in s && !!s.username)) return Promise.resolve(false)
  if (relayProbe && Date.now() - relayProbeAt < RELAY_PROBE_TTL_MS) return relayProbe
  relayProbe = null
  relayProbeAt = Date.now()
  relayProbe = new Promise<boolean>((resolve) => {
    let pc: RTCPeerConnection | null = null
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      try {
        pc?.close()
      } catch {
        /* already gone */
      }
      resolve(ok)
    }
    try {
      pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: 'relay' })
      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return finish(false) // gathering finished, nothing relayed
        if (ev.candidate.candidate.includes(' typ relay')) finish(true)
      }
      pc.createDataChannel('relay-probe')
      void pc.createOffer().then((o) => pc?.setLocalDescription(o)).catch(() => finish(false))
    } catch {
      finish(false)
    }
    // Long enough for an allocation on a slow link, short enough not to hold a
    // call the user is placing right now.
    setTimeout(() => finish(false), 4000)
  })
  return relayProbe
}

export function CallProvider({ children }: { children: ReactNode }) {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const { send, on, connected } = useWS()

  const [phase, setPhase] = useState<CallPhase>('idle')
  const [info, setInfo] = useState<CallInfo | null>(null)
  const [endedReason, setEndedReason] = useState('')
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [connectedAt, setConnectedAt] = useState<number | null>(null)
  // teardown() is a stable callback and cannot read the state above; the ref
  // is what tells it whether the call was ever actually connected, which is
  // the difference between "5 min" and "missed".
  const connectedAtRef = useRef<number | null>(null)
  const [muted, setMuted] = useState(false)
  const [cameraOff, setCameraOff] = useState(false)
  const [incomingUpgrade, setIncomingUpgrade] = useState(false)
  const [deviceError, setDeviceError] = useState<string | null>(null)

  const live = useRef<Live>({
    pc: null,
    info: null,
    local: null,
    pendingOffer: null,
    pendingIce: [],
    upgradeOffer: null,
    upgradePending: false,
    ringTimer: null,
    connectTimer: null,
    graceTimer: null,
    deadTimer: null,
    accepting: false,
  })

  // `send` and `identity` change identity across renders; the WS handler is
  // registered once, so it reads them from here instead of closing over them.
  const sendRef = useRef(send)
  sendRef.current = send
  const identityRef = useRef(identity)
  identityRef.current = identity
  const tRef = useRef(t)
  tRef.current = t

  /// Same-island signals owed to the peer while the socket happens to be down.
  /// `ws.send` on a closed socket silently drops the frame, and for a call
  /// that is not a lost optimization — a dropped `call_end` leaves the island
  /// convinced both parties are still on a call, and it answers every next
  /// offer from or to either of them with "busy" until that registration goes
  /// stale. Held here and flushed the moment the socket returns.
  const outboxRef = useRef<Array<Record<string, unknown> & { type: string; call_id: string }>>([])

  /// Put one signal on whichever road reaches the peer, and say whether it got
  /// there. §5d: our own island's socket for a local peer, a sealed deposit to
  /// the peer's island for a foreign one.
  ///
  /// The host is normally read off the live call, which is the only peer this
  /// client ever signals — every caller below addresses `l.info`. `hostOverride`
  /// exists for the one signal that is NOT about the live call: the "busy"
  /// refusal we owe a second caller while already on a call.
  ///
  /// ⚠ The WS branch is fire-and-forget and reports true: a socket send has no
  /// acknowledgement, and claiming otherwise would make the two roads report
  /// success on different terms. Only the deposit can actually tell us.
  const dispatch = useCallback(
    async (
      type: string,
      toUin: number,
      callId: string,
      extra: Record<string, unknown> = {},
      hostOverride?: string | null,
    ): Promise<boolean> => {
      const l = live.current
      const host =
        hostOverride !== undefined
          ? hostOverride
          : l.info && l.info.peerUin === toUin
            ? l.info.peerHost ?? null
            : null
      if (!host) {
        const frame = { type, to_uin: toUin, call_id: callId, ...extra }
        // The SEND's verdict, not the render's: `connected` state lags the
        // socket by a render, and a frame handed to a just-closed socket is
        // swallowed without a trace. send() itself checks the real readyState.
        if (!sendRef.current(frame)) {
          // Bounded: a long outage accumulates ICE nobody will ever apply.
          // Endings are never the ones dropped — they are the frames the
          // island's busy registry depends on.
          const box = outboxRef.current
          if (box.length >= 64) {
            const i = box.findIndex((f) => f.type !== 'call_end')
            box.splice(i === -1 ? 0 : i, 1)
          }
          box.push(frame)
        }
        return true
      }
      const id = identityRef.current
      if (!id) return false
      return sendCrossIslandSignal(id, host, toUin, type, callId, extra)
    },
    [],
  )

  /// Fire-and-forget `dispatch`, for the signals whose delivery nothing waits
  /// on (ICE, hangups, renegotiation). The offer is the exception and awaits.
  const signal = useCallback(
    (type: string, toUin: number, callId: string, extra: Record<string, unknown> = {}, hostOverride?: string | null) => {
      void dispatch(type, toUin, callId, extra, hostOverride)
    },
    [dispatch],
  )

  // Flush the held signals when the socket returns. A `call_end` goes out no
  // matter what — it is what clears the island's busy registration and tells
  // the peer to stop ringing. Everything else (ICE, renegotiation) is only
  // meaningful for the call still on foot, so frames from a call that ended
  // during the gap are dropped rather than replayed at a stranger.
  //
  // A frame the socket refuses (it died again between the render that flipped
  // `connected` and this effect running — the flapping-socket case exactly)
  // goes BACK in the box along with the rest, for the next reconnect. Frames
  // this flush chose to drop are dropped for good.
  useEffect(() => {
    if (!connected || outboxRef.current.length === 0) return
    const held = outboxRef.current
    outboxRef.current = []
    for (let i = 0; i < held.length; i++) {
      const frame = held[i]
      if (frame.type !== 'call_end' && live.current.info?.id !== frame.call_id) continue
      if (!sendRef.current(frame)) {
        outboxRef.current = held.slice(i).concat(outboxRef.current)
        return
      }
    }
  }, [connected])

  const clearTimers = useCallback(() => {
    const l = live.current
    for (const key of ['ringTimer', 'connectTimer', 'graceTimer', 'deadTimer'] as const) {
      if (l[key]) {
        clearTimeout(l[key] as ReturnType<typeof setTimeout>)
        l[key] = null
      }
    }
  }, [])

  /// Tear the call down locally. Signalling (if any is owed to the peer) has
  /// already happened by the time this runs — this is only about releasing the
  /// camera, the microphone and the connection.
  const teardown = useCallback(
    (reason: string) => {
      const l = live.current
      clearTimers()
      stopTone()
      l.local?.getTracks().forEach((t) => t.stop())
      try {
        l.pc?.close()
      } catch {
        /* already closed */
      }
      const had = l.info
      // §5d: any cross-island candidates still waiting on the batch timer
      // belong to a call that is over. Dropped rather than flushed — sending
      // them now would deposit (and, on a closed app, RING) for a call that
      // has already been torn down on both sides.
      if (had?.peerHost) dropCrossIslandIce(had.id)
      // The record this call leaves in the conversation. Written here, at the
      // single junction every ending passes through, and while `connectedAt`
      // and `l.info` are still readable — a moment later they are null.
      const startedAt = connectedAtRef.current
      l.pc = null
      l.local = null
      l.info = null
      l.pendingOffer = null
      l.pendingIce = []
      l.upgradeOffer = null
      l.upgradePending = false
      l.accepting = false
      setLocalStream(null)
      setRemoteStream(null)
      setConnectedAt(null)
      connectedAtRef.current = null
      setMuted(false)
      setCameraOff(false)
      setIncomingUpgrade(false)
      // `answered_elsewhere` is this account's OTHER device telling us it took
      // the call. Nothing ended for the user, so it gets no ended card and no
      // tone — the ring simply stops.
      if (reason === 'answered_elsewhere' || !had) {
        setPhase('idle')
        setInfo(null)
        setEndedReason('')
        return
      }
      // Log it before the ended card, so the row is already in the thread when
      // the user closes the card and looks at the conversation.
      logFinishedCall(had, reason, startedAt)
      setEndedReason(reason)
      setPhase('ended')
      playEndTone()
    },
    [clearTimers],
  )

  /// Hang up on our own initiative: tell the peer first, then tear down.
  const endLocally = useCallback(
    (reason: string) => {
      const l = live.current
      if (l.info) signal('call_end', l.info.peerUin, l.info.id, { reason })
      teardown(reason)
    },
    [signal, teardown],
  )

  /// TURN is worth retrying: one failed fetch silently leaves the call
  /// STUN-only, which dooms it behind a symmetric NAT. If it genuinely cannot
  /// be had we go ahead anyway — a call that might work beats no call.
  const iceServers = useCallback(async (): Promise<RTCIceServer[]> => {
    const servers: RTCIceServer[] = [{ urls: STUN_URLS }]
    if (!identity) return servers
    for (let attempt = 0; attempt < TURN_FETCH_ATTEMPTS; attempt++) {
      try {
        const creds = await Api.turnCredentials(identity)
        if (creds.urls.length) {
          // Desktop with the bypass up: swap the island's relay for the
          // shell's loopback TURN tunnel, KEEPING the island's credentials -
          // TURN auth happens inside the tunnel, same as Android. Everywhere
          // else turnTunnelUrl answers null and the URLs pass through as is.
          const host = creds.urls.map(turnHostOf).find((h) => h !== null) ?? null
          const tunnel = host ? await turnTunnelUrl(host) : null
          servers.push({
            urls: tunnel ? [tunnel] : creds.urls,
            username: creds.username,
            credential: creds.credential,
          })
        } else {
          console.warn('[call] island returned no TURN servers — STUN-only call')
        }
        return servers
      } catch {
        if (attempt < TURN_FETCH_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, TURN_RETRY_DELAY_MS))
        }
      }
    }
    console.error('[call] TURN fetch failed — STUN-only, a cross-NAT call may not connect')
    return servers
  }, [identity])

  /// Ask for the microphone (and camera, for a video call). Throws with a
  /// reason the UI can show: a call that cannot hear is not worth placing.
  const capture = useCallback(async (media: CallMedia): Promise<MediaStream> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('unsupported')
    }
    return navigator.mediaDevices.getUserMedia({
      audio: true,
      video: media === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    })
  }, [])

  const armConnectTimeout = useCallback(() => {
    const l = live.current
    if (l.connectTimer) clearTimeout(l.connectTimer)
    l.connectTimer = setTimeout(() => {
      if (live.current.pc?.connectionState !== 'connected') endLocally('failed')
    }, CONNECT_TIMEOUT_MS)
  }, [endLocally])

  /// Re-gather on a broken path and hand the peer a fresh offer, so a network
  /// change costs a couple of seconds of silence instead of the call.
  ///
  /// Only the CALLER restarts. Both ends see the same failure at the same
  /// moment, and two simultaneous restarts is glare — one side's offer arrives
  /// while it is itself waiting for an answer, and neither can be applied.
  const restartIce = useCallback(async () => {
    const l = live.current
    if (!l.pc || !l.info?.outgoing) return
    if (l.upgradePending || l.upgradeOffer) return
    try {
      const offer = await l.pc.createOffer({ iceRestart: true })
      await l.pc.setLocalDescription(offer)
      signal('call_ice_restart', l.info.peerUin, l.info.id, { sdp: offer.sdp })
    } catch (e) {
      console.error('[call] ICE restart failed', e)
    }
  }, [signal])

  const newPeerConnection = useCallback(
    async (): Promise<RTCPeerConnection> => {
      const servers = await iceServers()
      // ⚠ Calls used to run with the default ICE policy, which puts host and
      // srflx candidates in the SDP: the peer learns your LAN addresses and
      // your real public IP before a word is spoken. `relay` forces media
      // through our TURN server, so the peer sees the TURN address and nothing
      // else. Media transits our box now, which costs bandwidth and a little
      // latency, and that is the trade.
      //
      // ⚠⚠ But relay-only is only safe to demand when a relay candidate can
      // actually be obtained HERE. Android shipped this keyed on "credentials
      // exist" and three people reported calls ringing and then dying on the
      // timeout, on networks that cannot reach TURN: under `relay` with no
      // reachable server there are no candidates at all. So measure it, once,
      // and cache the answer for this session.
      const haveTurn = await relayReachable(servers)
      // ⚠⚠ And only when the user still wants it. Relay-only used to be
      // unconditional here, which is the right default and was the wrong rule:
      // somebody on a good line who would rather have the quality had no way to
      // say so, while the phones have had that switch since 0.108. Off means an
      // ordinary ICE policy — host and srflx candidates, and the peer sees the
      // address they imply.
      const pc = new RTCPeerConnection({
        iceServers: servers,
        ...(haveTurn && alwaysRelay() ? { iceTransportPolicy: 'relay' as const } : {}),
      })

      pc.onicecandidate = (ev) => {
        const l = live.current
        if (!ev.candidate || !l.info) return
        // The phones read the candidate line out of the key `sdp`. Sending it
        // under `candidate` (which is what the browser calls it) produces a
        // call that rings, answers, and never carries any sound.
        signal('call_ice', l.info.peerUin, l.info.id, {
          candidate: JSON.stringify({
            sdp: ev.candidate.candidate,
            sdpMLineIndex: ev.candidate.sdpMLineIndex ?? 0,
            sdpMid: ev.candidate.sdpMid ?? '',
          }),
        })
      }

      pc.ontrack = (ev) => {
        const stream = ev.streams[0]
        if (stream) {
          setRemoteStream(stream)
          return
        }
        setRemoteStream((prev) => {
          const s = prev ?? new MediaStream()
          s.addTrack(ev.track)
          return s
        })
      }

      pc.onconnectionstatechange = () => {
        const l = live.current
        const state = pc.connectionState
        if (state === 'connected') {
          if (l.connectTimer) {
            clearTimeout(l.connectTimer)
            l.connectTimer = null
          }
          if (l.graceTimer) {
            clearTimeout(l.graceTimer)
            l.graceTimer = null
          }
          if (l.deadTimer) {
            clearTimeout(l.deadTimer)
            l.deadTimer = null
          }
          stopTone()
          setConnectedAt((prev) => {
            const at = prev ?? Date.now()
            connectedAtRef.current = at
            return at
          })
          return
        }
        if (state === 'failed' || state === 'disconnected') {
          // The dead-call clock runs across every restart attempt below and
          // only 'connected' above stops it - a loop of hopeful restarts must
          // not keep a call that is over alive forever (#652).
          if (!l.deadTimer) {
            l.deadTimer = setTimeout(() => {
              live.current.deadTimer = null
              if (live.current.pc?.connectionState !== 'connected') endLocally('failed')
            }, DEAD_CALL_MS)
          }
        }
        if (state === 'failed') {
          void restartIce()
          return
        }
        if (state === 'disconnected') {
          if (l.graceTimer) return
          l.graceTimer = setTimeout(() => {
            live.current.graceTimer = null
            if (live.current.pc?.connectionState === 'disconnected') void restartIce()
          }, DISCONNECT_GRACE_MS)
        }
      }

      return pc
    },
    [iceServers, restartIce, signal, endLocally],
  )

  /// Candidates that arrived before their description. Applied in order once
  /// the remote description is in place.
  const flushIce = useCallback(() => {
    const l = live.current
    if (!l.pc || !l.pc.remoteDescription) return
    const queued = l.pendingIce
    l.pendingIce = []
    for (const raw of queued) void addRemoteIce(l.pc, raw)
  }, [])

  // ── outgoing ──────────────────────────────────────────────────────────

  const start = useCallback(
    (peerUin: number, peerName: string, media: CallMedia, peerHost?: string | null) => {
      if (live.current.info || phase === 'outgoing' || phase === 'incoming' || phase === 'connected') return
      const call: CallInfo = {
        id: crypto.randomUUID(),
        peerUin,
        peerName,
        media,
        outgoing: true,
        // §5d. Pinned onto the call at its birth, so every later signal — ICE,
        // the hangup, a video upgrade — takes the same road as the offer, even
        // though none of them is handed a host.
        peerHost: peerHost || null,
      }
      live.current.info = call
      setDeviceError(null)
      setInfo(call)
      setPhase('outgoing')

      void (async () => {
        try {
          const stream = await capture(media)
          // The user may have hung up while the permission prompt was open.
          if (live.current.info?.id !== call.id) {
            stream.getTracks().forEach((t) => t.stop())
            return
          }
          live.current.local = stream
          setLocalStream(stream)

          const pc = await newPeerConnection()
          if (live.current.info?.id !== call.id) {
            pc.close()
            stream.getTracks().forEach((t) => t.stop())
            return
          }
          live.current.pc = pc
          stream.getTracks().forEach((t) => pc.addTrack(t, stream))

          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          const sent = await dispatch('call_offer', peerUin, call.id, { media, sdp: offer.sdp })
          // The user may have hung up while the deposit was in flight.
          if (live.current.info?.id !== call.id) return
          // §5d: unlike a socket send, a deposit tells us whether it landed. A
          // peer island that is down or unreachable means the offer does not
          // exist anywhere, so there is nothing to ring — say so now instead of
          // playing ringback into the void for a full minute.
          // `teardown`, not `endLocally`: there is nobody to hang up ON. The
          // offer never reached their island, so no call exists at the other
          // end, and a `call_end` would only be a second deposit to the same
          // host that just refused the first.
          if (!sent) {
            teardown('unavailable')
            return
          }
          startRingback()
          live.current.ringTimer = setTimeout(() => endLocally('no_answer'), RING_TIMEOUT_MS)
        } catch (e) {
          console.error('[call] could not place the call', e)
          setDeviceError(describeDeviceError(e))
          endLocally('setup_failed')
        }
      })()
    },
    [capture, dispatch, endLocally, newPeerConnection, phase, teardown],
  )

  // ── incoming ──────────────────────────────────────────────────────────

  const accept = useCallback(() => {
    const l = live.current
    const call = l.info
    const offer = l.pendingOffer
    if (!call || !offer || l.accepting) return
    l.accepting = true
    stopTone()
    if (l.ringTimer) {
      clearTimeout(l.ringTimer)
      l.ringTimer = null
    }

    void (async () => {
      try {
        const stream = await capture(call.media)
        if (live.current.info?.id !== call.id) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        live.current.local = stream
        setLocalStream(stream)

        const pc = await newPeerConnection()
        if (live.current.info?.id !== call.id) {
          pc.close()
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        live.current.pc = pc
        stream.getTracks().forEach((t) => pc.addTrack(t, stream))

        await pc.setRemoteDescription({ type: 'offer', sdp: offer })
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        signal('call_answer', call.peerUin, call.id, { sdp: answer.sdp })
        live.current.pendingOffer = null
        setPhase('connected')
        flushIce()
        armConnectTimeout()
      } catch (e) {
        console.error('[call] could not answer', e)
        setDeviceError(describeDeviceError(e))
        endLocally('setup_failed')
      } finally {
        live.current.accepting = false
      }
    })()
  }, [armConnectTimeout, capture, endLocally, flushIce, newPeerConnection, signal])

  const decline = useCallback(() => endLocally('declined'), [endLocally])
  const hangUp = useCallback(() => endLocally('ended'), [endLocally])
  const dismissEnded = useCallback(() => {
    setPhase('idle')
    setInfo(null)
    setEndedReason('')
    setDeviceError(null)
  }, [])

  // ── in-call controls ──────────────────────────────────────────────────

  const toggleMute = useCallback(() => {
    const tracks = live.current.local?.getAudioTracks() ?? []
    const next = !muted
    tracks.forEach((t) => (t.enabled = !next))
    setMuted(next)
  }, [muted])

  const toggleCamera = useCallback(() => {
    const tracks = live.current.local?.getVideoTracks() ?? []
    if (!tracks.length) return
    const next = !cameraOff
    tracks.forEach((t) => (t.enabled = !next))
    setCameraOff(next)
  }, [cameraOff])

  /// Turn a running audio call into a video one. The peer is asked, not told —
  /// the phones show a prompt, and a camera that switches itself on because the
  /// other side felt like it would be a nasty surprise.
  const upgradeToVideo = useCallback(() => {
    const l = live.current
    if (!l.pc || !l.info || l.info.media === 'video' || l.upgradePending) return
    const call = l.info
    void (async () => {
      try {
        const cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } })
        const track = cam.getVideoTracks()[0]
        if (!track || live.current.info?.id !== call.id || !live.current.pc) {
          cam.getTracks().forEach((t) => t.stop())
          return
        }
        const stream = live.current.local
        stream?.addTrack(track)
        live.current.pc.addTrack(track, stream ?? cam)
        setLocalStream(stream ? new MediaStream(stream.getTracks()) : cam)
        live.current.upgradePending = true
        const offer = await live.current.pc.createOffer()
        await live.current.pc.setLocalDescription(offer)
        signal('call_renegotiate', call.peerUin, call.id, { sdp: offer.sdp })
      } catch (e) {
        console.error('[call] video upgrade failed', e)
        live.current.upgradePending = false
        setDeviceError(describeDeviceError(e))
      }
    })()
  }, [signal])

  /// Drop the camera we added for an upgrade the peer refused (or that failed),
  /// and put the connection back the way it was.
  const rollbackUpgrade = useCallback(() => {
    const l = live.current
    l.upgradePending = false
    const video = l.local?.getVideoTracks() ?? []
    if (!video.length || !l.pc) return
    for (const track of video) {
      const sender = l.pc.getSenders().find((s) => s.track === track)
      if (sender) l.pc.removeTrack(sender)
      track.stop()
      l.local?.removeTrack(track)
    }
    setLocalStream(l.local ? new MediaStream(l.local.getTracks()) : null)
    setCameraOff(false)
  }, [])

  const acceptUpgrade = useCallback(() => {
    const l = live.current
    const call = l.info
    const offer = l.upgradeOffer
    if (!call || !offer || !l.pc) return
    setIncomingUpgrade(false)
    l.upgradeOffer = null
    void (async () => {
      try {
        const cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } })
        const track = cam.getVideoTracks()[0]
        const pc = live.current.pc
        if (!track || !pc || live.current.info?.id !== call.id) {
          cam.getTracks().forEach((t) => t.stop())
          return
        }
        const stream = live.current.local
        stream?.addTrack(track)
        pc.addTrack(track, stream ?? cam)
        setLocalStream(stream ? new MediaStream(stream.getTracks()) : cam)
        await pc.setRemoteDescription({ type: 'offer', sdp: offer })
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        signal('call_renegotiate_answer', call.peerUin, call.id, { sdp: answer.sdp })
        const upgraded = { ...call, media: 'video' as CallMedia }
        live.current.info = upgraded
        setInfo(upgraded)
      } catch (e) {
        console.error('[call] could not accept the video upgrade', e)
        signal('call_renegotiate_decline', call.peerUin, call.id)
        rollbackUpgrade()
      }
    })()
  }, [rollbackUpgrade, signal])

  const declineUpgrade = useCallback(() => {
    const l = live.current
    if (!l.info) return
    setIncomingUpgrade(false)
    l.upgradeOffer = null
    signal('call_renegotiate_decline', l.info.peerUin, l.info.id)
  }, [signal])

  // ── signalling in ─────────────────────────────────────────────────────

  useEffect(() => {
    const handle = (ev: { type: string; [k: string]: unknown }) => {
      const from = Number(ev.from_uin ?? 0)
      const callId = String(ev.call_id ?? '')
      const sdp = typeof ev.sdp === 'string' ? ev.sdp : ''
      // §5d: present only on a signal that arrived as a sealed envelope, and
      // then it is the island the caller lives on. Everything we send back
      // about this call has to go there, because our own island would resolve
      // their number as one of its own.
      const fromHost = typeof ev.from_host === 'string' && ev.from_host ? ev.from_host : null
      const l = live.current

      switch (ev.type) {
        case 'call_offer': {
          if (!from || !sdp) return
          // Busy: the server guards this too, but it only knows about calls it
          // registered — a second offer that races ours still has to be told.
          // ⚠ Routed, not `sendRef`: a cross-island caller is not reachable
          // down our socket, and telling the wrong #1234 that we are busy is
          // the same defect §5d exists to close, in miniature.
          if (l.info) {
            signal('call_end', from, callId, { reason: 'busy' }, fromHost)
            return
          }
          const media: CallMedia = ev.media === 'video' ? 'video' : 'audio'
          // ⚠ A cross-island caller's name comes from the card we pinned when
          // they were added, and it is known SYNCHRONOUSLY — so the ringing
          // sheet and the desktop notification both carry it from the first
          // frame. It must never come from `/users/{uin}/info` (the same-island
          // lookup below): that endpoint answers about OUR island's #1234, so
          // asking it would print a local stranger's name over a caller from
          // somewhere else — the wrong-person mix-up §5d exists to end, in the
          // label this time instead of the wire.
          const known = fromHost ? getCrossIsland(from, fromHost) : null
          // The nameless fallback carries the ISLAND for a cross-island caller.
          // A bare `#1234` is how a LOCAL number is written everywhere in this
          // app, so using it for someone on another island reads as a person
          // the user may actually know — the wrong-person mix-up again, this
          // time in the label. (The gate upstream means `known` is non-null
          // here; only a card that carried no nickname reaches this.)
          const call: CallInfo = {
            id: callId,
            peerUin: from,
            peerName: known?.nickname || (fromHost ? `#${from}@${fromHost}` : `#${from}`),
            media,
            outgoing: false,
            peerHost: fromHost,
          }
          l.info = call
          l.pendingOffer = sdp
          setInfo(call)
          setPhase('incoming')
          setDeviceError(null)
          startRingtone()
          // On the desktop the window may be hidden in the tray, where a
          // ringing call would be audible and unanswerable. A phone call is
          // exactly the thing that is allowed to come to the front.
          void raiseDesktopWindow()
          void notifyDesktop(
            call.peerName,
            tRef.current(media === 'video' ? 'call.status.incoming_video' : 'call.status.incoming'),
          )
          // A same-island offer carries only a number. Put a name on the
          // ringing sheet if OUR island will tell us one, but never hold up the
          // ring for it. (A cross-island caller was already named above, from
          // the pinned card, and must not be asked about here.)
          if (!fromHost && identityRef.current) {
            void Api.userInfo(identityRef.current, from)
              .then((u) => {
                if (live.current.info?.id !== call.id || !u.nickname) return
                const named = { ...live.current.info, peerName: u.nickname }
                live.current.info = named
                setInfo(named)
              })
              .catch(() => {})
          }
          // If the caller's app dies mid-ring no `call_end` ever arrives, and
          // without this the sheet rings until someone closes the app.
          l.ringTimer = setTimeout(() => endLocally('no_answer'), INCOMING_TIMEOUT_MS)
          return
        }

        case 'call_answer': {
          const pc = l.pc
          if (!l.info || l.info.id !== callId || !pc || !sdp) return
          stopTone()
          if (l.ringTimer) {
            clearTimeout(l.ringTimer)
            l.ringTimer = null
          }
          void (async () => {
            try {
              await pc.setRemoteDescription({ type: 'answer', sdp })
              setPhase('connected')
              flushIce()
              armConnectTimeout()
            } catch (e) {
              console.error('[call] bad answer', e)
              endLocally('failed')
            }
          })()
          return
        }

        case 'call_ice': {
          if (!l.info || l.info.id !== callId) return
          // A cross-island sender batches a burst of trickle candidates into
          // ONE signal (`candidates` = a JSON array), because each deposit is a
          // round trip and, on a closed app, a ring. Android and iOS both send
          // and read this shape; `candidate` stays the single-candidate form
          // every same-island signal uses.
          const batch: string[] = []
          if (typeof ev.candidates === 'string') {
            try {
              const arr = JSON.parse(ev.candidates) as unknown
              if (Array.isArray(arr)) for (const c of arr) if (typeof c === 'string' && c) batch.push(c)
            } catch {
              /* a batch we cannot parse is not a call-ending event — ICE has others */
            }
          } else if (typeof ev.candidate === 'string' && ev.candidate) {
            batch.push(ev.candidate)
          }
          for (const raw of batch) {
            if (l.pc?.remoteDescription) void addRemoteIce(l.pc, raw)
            else l.pendingIce.push(raw)
          }
          return
        }

        case 'call_end': {
          if (!l.info) return
          // An empty call_id is the server speaking on the peer's behalf (a
          // policy refusal, or a socket that dropped); it applies to whatever
          // call we have open.
          if (callId && l.info.id !== callId) return
          const reason = typeof ev.reason === 'string' ? ev.reason : 'ended'
          teardown(reason)
          return
        }

        // The island's own verdicts about the callee. Android has routed both
        // for a while; ignoring them here meant a caller listened to fake
        // ringback for the full minute over a person who was never going to
        // hear it. `call_unreachable` = no socket AND no wake channel: nobody
        // will ever ring, so the call ends now. `call_offline` = the offer
        // left as a push and may yet raise their screen: keep the call open
        // but stop the ringback — a tone is a promise their device is ringing,
        // and right now nothing is.
        case 'call_unreachable': {
          if (!l.info) return
          if (callId && l.info.id !== callId) return
          teardown('unavailable')
          return
        }
        case 'call_offline': {
          if (!l.info || !l.info.outgoing) return
          if (callId && l.info.id !== callId) return
          stopTone()
          return
        }

        case 'call_renegotiate': {
          const pc = l.pc
          if (!l.info || l.info.id !== callId || !pc || !sdp) return
          if (l.info.media === 'video') {
            // Already on video — nothing to ask about, just answer it.
            const call = l.info
            void (async () => {
              try {
                await pc.setRemoteDescription({ type: 'offer', sdp })
                const answer = await pc.createAnswer()
                await pc.setLocalDescription(answer)
                signal('call_renegotiate_answer', call.peerUin, call.id, { sdp: answer.sdp })
              } catch (e) {
                console.error('[call] renegotiation failed', e)
              }
            })()
            return
          }
          l.upgradeOffer = sdp
          setIncomingUpgrade(true)
          return
        }

        case 'call_renegotiate_answer': {
          const pc = l.pc
          if (!l.info || l.info.id !== callId || !pc || !sdp) return
          const call = l.info
          void (async () => {
            try {
              await pc.setRemoteDescription({ type: 'answer', sdp })
              l.upgradePending = false
              const upgraded = { ...call, media: 'video' as CallMedia }
              live.current.info = upgraded
              setInfo(upgraded)
            } catch (e) {
              console.error('[call] bad renegotiation answer', e)
              rollbackUpgrade()
            }
          })()
          return
        }

        case 'call_renegotiate_decline': {
          if (!l.info || l.info.id !== callId) return
          rollbackUpgrade()
          return
        }

        case 'call_ice_restart': {
          const pc = l.pc
          if (!l.info || l.info.id !== callId || !pc || !sdp) return
          // Not while our own renegotiation is mid-handshake: the connection
          // is not in a stable signalling state and the offer cannot be applied.
          if (l.upgradePending || l.upgradeOffer) return
          const call = l.info
          void (async () => {
            try {
              await pc.setRemoteDescription({ type: 'offer', sdp })
              const answer = await pc.createAnswer()
              await pc.setLocalDescription(answer)
              signal('call_ice_restart_answer', call.peerUin, call.id, { sdp: answer.sdp })
            } catch (e) {
              console.error('[call] could not answer the ICE restart', e)
            }
          })()
          return
        }

        case 'call_ice_restart_answer': {
          if (!l.info || l.info.id !== callId || !l.pc || !sdp) return
          void l.pc.setRemoteDescription({ type: 'answer', sdp }).catch((e) => {
            console.error('[call] bad ICE restart answer', e)
          })
          return
        }
      }
    }

    const types = [
      'call_offer',
      'call_answer',
      'call_ice',
      'call_end',
      'call_unreachable',
      'call_offline',
      'call_renegotiate',
      'call_renegotiate_answer',
      'call_renegotiate_decline',
      'call_ice_restart',
      'call_ice_restart_answer',
    ]
    const offs = types.map((t) => on(t, handle))
    // §5d: a decrypted `kind:"call"` envelope re-enters the SAME state machine
    // as a live WS signal — one set of rules for both roads, so a cross-island
    // call cannot drift away from the same-island one it is a copy of. The
    // receiver (`message-receiver.tsx`) applies the §5d gates first and hands
    // over a frame in exactly the WS shape, plus `from_host`.
    crossIslandSink = handle
    return () => {
      offs.forEach((off) => off())
      if (crossIslandSink === handle) crossIslandSink = null
    }
  }, [armConnectTimeout, endLocally, flushIce, on, rollbackUpgrade, signal, teardown])

  // Signing out mid-call must not leave the microphone live.
  useEffect(() => {
    if (identity) return
    if (live.current.info) teardown('ended')
  }, [identity, teardown])

  // The "call ended" card says what happened and then gets out of the way. A
  // call that failed on a device gets longer, because it is asking the user to
  // go and change something.
  useEffect(() => {
    if (phase !== 'ended') return
    const timer = setTimeout(dismissEnded, deviceError ? 7000 : 3500)
    return () => clearTimeout(timer)
  }, [deviceError, dismissEnded, phase])

  const value = useMemo<CallCtx>(
    () => ({
      phase,
      info,
      endedReason,
      localStream,
      remoteStream,
      connectedAt,
      muted,
      cameraOff,
      incomingUpgrade,
      deviceError,
      // Outbound signalling can leave over HTTP now (§5d), but the peer's
      // REPLIES still come back down our own island's socket — their island
      // deposits into ours, ours pushes it to us. No socket, no answer, so an
      // offline client still must not offer a call button, cross-island or not.
      callable: connected && !!identity,
      start,
      accept,
      decline,
      hangUp,
      toggleMute,
      toggleCamera,
      upgradeToVideo,
      acceptUpgrade,
      declineUpgrade,
      dismissEnded,
    }),
    [
      accept,
      acceptUpgrade,
      cameraOff,
      connected,
      connectedAt,
      decline,
      declineUpgrade,
      deviceError,
      dismissEnded,
      endedReason,
      hangUp,
      identity,
      incomingUpgrade,
      info,
      localStream,
      muted,
      phase,
      remoteStream,
      start,
      toggleCamera,
      toggleMute,
      upgradeToVideo,
    ],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/// Apply one candidate from the wire. The phones put the candidate line under
/// the key `sdp`; a browser calls the same thing `candidate`, so we read both
/// and are lenient about which one a future client sends.
async function addRemoteIce(pc: RTCPeerConnection, raw: string) {
  try {
    const o = JSON.parse(raw) as { sdp?: string; candidate?: string; sdpMLineIndex?: number; sdpMid?: string }
    const candidate = o.sdp ?? o.candidate
    if (!candidate) return
    await pc.addIceCandidate({
      candidate,
      sdpMLineIndex: o.sdpMLineIndex ?? 0,
      sdpMid: o.sdpMid || null,
    })
  } catch (e) {
    // A candidate that cannot be applied is not fatal — ICE has others.
    console.warn('[call] dropped an ICE candidate', e)
  }
}

/// Map the browser's getUserMedia failures onto the i18n keys the call sheet
/// shows. `NotAllowedError` is the one users actually hit: the permission was
/// refused, or the OS never granted the app itself access to the microphone.
function describeDeviceError(e: unknown): string {
  const name = (e as { name?: string } | null)?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'call.error.permission'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'call.error.nodevice'
  if (name === 'NotReadableError') return 'call.error.busy_device'
  return 'call.error.generic'
}

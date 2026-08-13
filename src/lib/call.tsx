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
import { logCall } from './outgoing-store'
import { notifyDesktop, raiseDesktopWindow } from './desktop'
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
  logCall(info.peerUin, `${parts[0]}|${parts[1]}|${tail}`, missed, Date.now())
}

const RING_TIMEOUT_MS = 60_000
const INCOMING_TIMEOUT_MS = 70_000
/// Answered, but no media path came up. Long enough for a slow TURN allocation
/// on a bad mobile network, short enough that nobody stares at a dead screen.
const CONNECT_TIMEOUT_MS = 30_000
/// ICE says "disconnected" on any blip. Wait before treating it as a real
/// break, or a lift ride costs you the call.
const DISCONNECT_GRACE_MS = 4_000
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
  start: (peerUin: number, peerName: string, media: CallMedia) => void
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
  /// Guards a double accept (a double click, or a click racing the Enter key)
  /// from running the answer path twice on one connection.
  accepting: boolean
}

/// Can this network actually get a relay candidate? Measured once per session
/// on a throwaway connection with no media: cheap, and the alternative is
/// guessing from the presence of credentials, which says nothing about
/// reachability.
let relayProbe: Promise<boolean> | null = null

function relayReachable(servers: RTCIceServer[]): Promise<boolean> {
  if (!servers.some((s) => 'username' in s && !!s.username)) return Promise.resolve(false)
  if (relayProbe) return relayProbe
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

  const signal = useCallback((type: string, toUin: number, callId: string, extra: Record<string, unknown> = {}) => {
    sendRef.current({ type, to_uin: toUin, call_id: callId, ...extra })
  }, [])

  const clearTimers = useCallback(() => {
    const l = live.current
    for (const key of ['ringTimer', 'connectTimer', 'graceTimer'] as const) {
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
          servers.push({ urls: creds.urls, username: creds.username, credential: creds.credential })
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
      const pc = new RTCPeerConnection({
        iceServers: servers,
        ...(haveTurn ? { iceTransportPolicy: 'relay' as const } : {}),
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
          stopTone()
          setConnectedAt((prev) => {
            const at = prev ?? Date.now()
            connectedAtRef.current = at
            return at
          })
          return
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
    [iceServers, restartIce, signal],
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
    (peerUin: number, peerName: string, media: CallMedia) => {
      if (live.current.info || phase === 'outgoing' || phase === 'incoming' || phase === 'connected') return
      const call: CallInfo = {
        id: crypto.randomUUID(),
        peerUin,
        peerName,
        media,
        outgoing: true,
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
          signal('call_offer', peerUin, call.id, { media, sdp: offer.sdp })
          startRingback()
          live.current.ringTimer = setTimeout(() => endLocally('no_answer'), RING_TIMEOUT_MS)
        } catch (e) {
          console.error('[call] could not place the call', e)
          setDeviceError(describeDeviceError(e))
          endLocally('setup_failed')
        }
      })()
    },
    [capture, endLocally, newPeerConnection, phase, signal],
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
      const l = live.current

      switch (ev.type) {
        case 'call_offer': {
          if (!from || !sdp) return
          // Busy: the server guards this too, but it only knows about calls it
          // registered — a second offer that races ours still has to be told.
          if (l.info) {
            sendRef.current({ type: 'call_end', to_uin: from, call_id: callId, reason: 'busy' })
            return
          }
          const media: CallMedia = ev.media === 'video' ? 'video' : 'audio'
          const call: CallInfo = {
            id: callId,
            peerUin: from,
            peerName: `#${from}`,
            media,
            outgoing: false,
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
          // The offer carries only a number. Put a name on the ringing sheet
          // if the island will tell us one, but never hold up the ring for it.
          if (identityRef.current) {
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
          const raw = typeof ev.candidate === 'string' ? ev.candidate : ''
          if (!raw) return
          if (l.pc?.remoteDescription) void addRemoteIce(l.pc, raw)
          else l.pendingIce.push(raw)
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
      'call_renegotiate',
      'call_renegotiate_answer',
      'call_renegotiate_decline',
      'call_ice_restart',
      'call_ice_restart_answer',
    ]
    const offs = types.map((t) => on(t, handle))
    return () => offs.forEach((off) => off())
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
      // Calls ride the websocket and nothing else — there is no REST fallback
      // for signalling, so an offline client must not offer a call button.
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

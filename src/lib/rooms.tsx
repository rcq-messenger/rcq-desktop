/// Audio rooms on the web — the mesh half that only the phones had.
///
/// A room is a persistent Discord-style voice room: a row on the island, a
/// join key, and a set of people who happen to be inside RIGHT NOW. The list
/// and the membership are ordinary REST (`/audio_rooms`); being inside is a
/// WebRTC mesh, signalled over the same websocket the chat uses
/// (`room_enter` / `room_roster` / `room_offer` / `room_answer` / `room_ice`).
///
/// ⚠ Who offers whom is not a detail. Everyone ALREADY inside dials the person
/// who just walked in; the newcomer only answers. Both sides offering is glare,
/// and glare in a mesh is a room where two people cannot hear each other while
/// everyone else can — the kind of bug that reads as "the room is broken
/// sometimes". This mirrors AudioRoomController on Android exactly, because the
/// two have to interoperate inside one room.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Api } from './api'
import { useIdentity } from './identity-context'
import { useWS } from './ws'

export interface RoomSummary {
  id: number
  name: string
  join_key: string
  owner_uin: number
  capacity: number
  active_count: number
}

export interface RoomMember {
  uin: number
  nickname: string
  speaking?: boolean
  mutedByOwner?: boolean
  /// Avatar rides along on the roster (island gates it by room membership),
  /// so a room full of strangers still has faces in it.
  avatarMediaId?: string | null
  avatarMediaKey?: string | null
}

interface RoomsCtx {
  rooms: RoomSummary[]
  refresh: () => Promise<void>
  create: (name: string) => Promise<void>
  joinByKey: (key: string) => Promise<void>
  forget: (id: number) => Promise<void>
  remove: (id: number) => Promise<void>
  /// Owner only.
  rename: (id: number, name: string) => Promise<void>
  /// Currently inside this room, or null.
  activeRoomId: number | null
  joining: boolean
  roster: RoomMember[]
  micMuted: boolean
  setMicMuted: (muted: boolean) => void
  /// Camera in a room is opt-in and off by default: eight tiles of video is
  /// seven outgoing streams from a laptop.
  cameraOn: boolean
  setCameraEnabled: (on: boolean) => Promise<void>
  /// Live video per participant, and our own preview under our own uin.
  videos: Map<number, MediaStream>
  enter: (room: RoomSummary) => Promise<void>
  leave: () => void
  error: string | null
}

const Ctx = createContext<RoomsCtx | undefined>(undefined)

/// One shape for both places the island describes a participant: the roster
/// handed to a newcomer and the `room_member_entered` broadcast.
function toMember(m: Record<string, unknown>): RoomMember {
  const uin = Number(m.uin)
  return {
    uin,
    nickname: (m.nickname as string) || `#${uin}`,
    mutedByOwner: Boolean(m.muted_by_owner),
    avatarMediaId: (m.avatar_media_id as string | null) ?? null,
    avatarMediaKey: (m.avatar_media_key as string | null) ?? null,
  }
}

/// How often the corridor re-reads occupancy while it is on screen. Presence
/// events only reach people INSIDE a room, so a list watcher has nothing to
/// listen to and has to ask (same reasoning as the Android list, #530).
const LIST_POLL_MS = 15_000

export function RoomsProvider({ children }: { children: ReactNode }) {
  const { identity } = useIdentity()
  const ws = useWS()

  const [rooms, setRooms] = useState<RoomSummary[]>([])
  const [activeRoomId, setActiveRoomId] = useState<number | null>(null)
  const [joining, setJoining] = useState(false)
  const [roster, setRoster] = useState<RoomMember[]>([])
  const [micMuted, setMicMutedState] = useState(false)
  const [cameraOn, setCameraOnState] = useState(false)
  const [videos, setVideos] = useState<Map<number, MediaStream>>(new Map())
  const [error, setError] = useState<string | null>(null)

  /// Everything the mesh owns lives in a ref: it is mutated from websocket
  /// callbacks and must never be a render dependency.
  const mesh = useRef({
    peers: new Map<number, RTCPeerConnection>(),
    pendingIce: new Map<number, RTCIceCandidateInit[]>(),
    audioEls: new Map<number, HTMLAudioElement>(),
    /// One video transceiver per peer, minted at dial time even when the
    /// camera is off, so turning it on later renegotiates instead of
    /// rebuilding the bundle. Same reasoning as `OfferToReceiveVideo: true`
    /// on iOS.
    videoTx: new Map<number, RTCRtpTransceiver>(),
    /// True while our own offer to that peer is in flight — the glare guard.
    making: new Set<number>(),
    local: null as MediaStream | null,
    camera: null as MediaStream | null,
    ice: [] as RTCIceServer[],
    roomId: null as number | null,
    vad: null as { ctx: AudioContext; timer: number } | null,
  })

  const refresh = useCallback(async () => {
    if (!identity) return
    try {
      setRooms(await Api.audioRooms(identity))
    } catch {
      // A corridor that failed to refresh keeps showing what it had.
    }
  }, [identity])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), LIST_POLL_MS)
    return () => clearInterval(t)
  }, [refresh])

  // ---- signalling ----------------------------------------------------

  const signal = useCallback(
    (type: string, to: number, extra: Record<string, unknown>) => {
      if (mesh.current.roomId == null) return
      // ⚠ The island reads `to_uin` and answers with `from_uin` (ws.py, and
      // AudioRoomController on Android does the same). Anything else and the
      // relay drops the frame without a word: you enter, you see the roster,
      // and nobody can hear you.
      ws.send({ type, room_id: mesh.current.roomId, to_uin: to, ...extra })
    },
    [ws],
  )

  const attachRemote = useCallback((uin: number, stream: MediaStream) => {
    let el = mesh.current.audioEls.get(uin)
    if (!el) {
      el = document.createElement('audio')
      el.autoplay = true
      // Never rendered: the element exists to play, and a room of eight
      // players in the DOM is eight things to lay out for no reason.
      el.style.display = 'none'
      document.body.appendChild(el)
      mesh.current.audioEls.set(uin, el)
    }
    el.srcObject = stream
    void el.play().catch(() => {
      // Autoplay policy: the entry tap counts as the gesture, so this only
      // fires in odd cases. Nothing to do but let the next track try.
    })
  }, [])

  /// Remote camera in, remote camera out. A peer that turns its camera off
  /// replaces the track rather than dropping the line, so the track goes
  /// `muted` instead of `ended` — watch both or the tile keeps a frozen frame.
  const attachRemoteVideo = useCallback((uin: number, track: MediaStreamTrack, stream: MediaStream) => {
    const put = (present: boolean) =>
      setVideos((prev) => {
        const next = new Map(prev)
        if (present) next.set(uin, stream)
        else next.delete(uin)
        return next
      })
    put(!track.muted)
    track.onmute = () => put(false)
    track.onunmute = () => put(true)
    track.onended = () => put(false)
  }, [])

  const newPeer = useCallback(
    (uin: number): RTCPeerConnection => {
      const pc = new RTCPeerConnection({ iceServers: mesh.current.ice })
      mesh.current.local?.getAudioTracks().forEach((t) => pc.addTrack(t, mesh.current.local!))
      // The video line exists from the first offer even with the camera off:
      // switching it on later is then a renegotiation, not a new m-section.
      const cam = mesh.current.camera?.getVideoTracks()[0] ?? null
      const vtx = pc.addTransceiver('video', { direction: cam ? 'sendrecv' : 'recvonly' })
      if (cam) void vtx.sender.replaceTrack(cam)
      mesh.current.videoTx.set(uin, vtx)
      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return
        signal('room_ice', uin, {
          candidate: JSON.stringify({
            sdp: ev.candidate.candidate,
            sdpMLineIndex: ev.candidate.sdpMLineIndex ?? 0,
            sdpMid: ev.candidate.sdpMid ?? '',
          }),
        })
      }
      pc.ontrack = (ev) => {
        if (ev.track.kind === 'video') attachRemoteVideo(uin, ev.track, ev.streams[0] ?? new MediaStream([ev.track]))
        else attachRemote(uin, ev.streams[0])
      }
      mesh.current.peers.set(uin, pc)
      return pc
    },
    [attachRemote, attachRemoteVideo, signal],
  )

  /// Offer to one peer, marking the line busy for the glare guard.
  const offerTo = useCallback(
    async (uin: number, pc: RTCPeerConnection) => {
      mesh.current.making.add(uin)
      try {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        signal('room_offer', uin, { sdp: offer.sdp })
      } finally {
        mesh.current.making.delete(uin)
      }
    },
    [signal],
  )

  const dial = useCallback(
    async (uin: number) => {
      if (mesh.current.peers.has(uin)) return
      await offerTo(uin, newPeer(uin))
    },
    [newPeer, offerTo],
  )

  const dropPeer = useCallback((uin: number) => {
    mesh.current.peers.get(uin)?.close()
    mesh.current.peers.delete(uin)
    mesh.current.pendingIce.delete(uin)
    mesh.current.videoTx.delete(uin)
    mesh.current.making.delete(uin)
    setVideos((prev) => {
      if (!prev.has(uin)) return prev
      const next = new Map(prev)
      next.delete(uin)
      return next
    })
    const el = mesh.current.audioEls.get(uin)
    if (el) {
      el.srcObject = null
      el.remove()
      mesh.current.audioEls.delete(uin)
    }
  }, [])

  const teardown = useCallback(() => {
    Array.from(mesh.current.peers.keys()).forEach(dropPeer)
    mesh.current.local?.getTracks().forEach((t) => t.stop())
    mesh.current.camera?.getTracks().forEach((t) => t.stop())
    if (mesh.current.vad) {
      window.clearInterval(mesh.current.vad.timer)
      void mesh.current.vad.ctx.close().catch(() => {})
      mesh.current.vad = null
    }
    mesh.current.local = null
    mesh.current.camera = null
    mesh.current.roomId = null
    setRoster([])
    setVideos(new Map())
    setCameraOnState(false)
    setJoining(false)
    setActiveRoomId(null)
  }, [dropPeer])

  const leave = useCallback(() => {
    const id = mesh.current.roomId
    if (id != null) ws.send({ type: 'room_leave', room_id: id })
    teardown()
    void refresh()
  }, [refresh, teardown, ws])

  /// Tell the room when we start and stop talking. Without this the web
  /// participant is drawn as permanently silent for everyone else — the phones
  /// have had it since day one. Hysteresis on purpose: one threshold makes the
  /// ring flicker on every syllable.
  const startVad = useCallback(
    (stream: MediaStream, selfUin: number) => {
      const AC: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return
      let ctx: AudioContext
      try {
        ctx = new AC()
      } catch {
        return
      }
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      ctx.createMediaStreamSource(stream).connect(analyser)
      const buf = new Float32Array(analyser.fftSize)
      let on = false
      let quietTicks = 0
      const timer = window.setInterval(() => {
        analyser.getFloatTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
        const rms = Math.sqrt(sum / buf.length)
        const muted = !(mesh.current.local?.getAudioTracks()[0]?.enabled ?? false)
        const loud = !muted && rms > 0.045
        if (loud) quietTicks = 0
        else quietTicks += 1
        // ~450ms of quiet before the ring goes out, one tick to light it.
        const next = loud ? true : quietTicks < 3 ? on : false
        if (next === on) return
        on = next
        setRoster((r) => r.map((m) => (m.uin === selfUin ? { ...m, speaking: on } : m)))
        if (mesh.current.roomId != null) {
          ws.send({ type: 'room_speaking', room_id: mesh.current.roomId, speaking: on })
        }
      }, 150)
      mesh.current.vad = { ctx, timer }
    },
    [ws],
  )

  const setCameraEnabled = useCallback(
    async (on: boolean) => {
      const selfUin = identity?.uin ?? 0
      if (on) {
        if (mesh.current.camera) return
        let stream: MediaStream
        try {
          // 640/24, the budget iOS picked for rooms. A mesh of eight is seven
          // outgoing streams; 720p here is a laptop fan and a dropped call.
          stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 640 }, frameRate: { ideal: 24 } },
          })
        } catch {
          setError('cam')
          return
        }
        mesh.current.camera = stream
        setCameraOnState(true)
        if (selfUin) setVideos((prev) => new Map(prev).set(selfUin, stream))
      } else {
        mesh.current.camera?.getTracks().forEach((t) => t.stop())
        mesh.current.camera = null
        setCameraOnState(false)
        if (selfUin)
          setVideos((prev) => {
            const next = new Map(prev)
            next.delete(selfUin)
            return next
          })
      }
      const track = mesh.current.camera?.getVideoTracks()[0] ?? null
      // Same shape as `renegotiateAll` on iOS: swap the track on the line that
      // already exists, then re-offer to everyone.
      for (const [uin, pc] of Array.from(mesh.current.peers.entries())) {
        const tx = mesh.current.videoTx.get(uin)
        if (!tx) continue
        try {
          await tx.sender.replaceTrack(track)
          tx.direction = track ? 'sendrecv' : 'recvonly'
          await offerTo(uin, pc)
        } catch {
          // One peer refusing renegotiation must not strand the others.
        }
      }
    },
    [identity, offerTo],
  )

  // ---- entering ------------------------------------------------------

  const enter = useCallback(
    async (room: RoomSummary) => {
      if (!identity) return
      setError(null)
      setJoining(true)
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        mesh.current.local = stream
        stream.getAudioTracks().forEach((t) => (t.enabled = !micMuted))
        startVad(stream, identity.uin)
      } catch {
        setJoining(false)
        setError('mic')
        return
      }
      const servers: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302'] }]
      try {
        const creds = await Api.turnCredentials(identity)
        if (creds.urls.length) {
          servers.push({ urls: creds.urls, username: creds.username, credential: creds.credential })
        }
      } catch {
        // STUN-only: a room across two NATs may not connect, but refusing to
        // enter at all is worse than trying.
      }
      mesh.current.ice = servers
      mesh.current.roomId = room.id
      setActiveRoomId(room.id)
      ws.send({ type: 'room_enter', room_id: room.id })
    },
    [identity, micMuted, startVad, ws],
  )

  const setMicMuted = useCallback((muted: boolean) => {
    setMicMutedState(muted)
    mesh.current.local?.getAudioTracks().forEach((t) => (t.enabled = !muted))
  }, [])

  // ---- websocket events ----------------------------------------------

  useEffect(() => {
    const offs: Array<() => void> = []
    const mine = (ev: Record<string, unknown>) =>
      mesh.current.roomId != null && Number(ev.room_id) === mesh.current.roomId
    // `from_uin` on the relayed signalling frames, plain `uin` on the roster
    // events (room_member_left, room_speaking). Both spellings come from the
    // island, so read both.
    const from = (ev: Record<string, unknown>) => Number(ev.from_uin ?? ev.uin ?? 0) || null

    offs.push(
      ws.on('room_roster', (ev) => {
        if (!mine(ev)) return
        setJoining(false)
        const members = ((ev.members as Array<Record<string, unknown>>) ?? []).map(toMember)
        setRoster(members)
        // We are the newcomer here: the people already inside dial US.
      }),
    )
    offs.push(
      ws.on('room_enter_rejected', (ev) => {
        if (!mine(ev)) return
        setError((ev.reason as string) || 'rejected')
        teardown()
      }),
    )
    offs.push(
      ws.on('room_member_entered', (ev) => {
        if (!mine(ev)) return
        const m = (ev.member as Record<string, unknown>) ?? {}
        const uin = Number(m.uin)
        if (!uin) return
        setRoster((r) => (r.some((x) => x.uin === uin) ? r : [...r, toMember(m)]))
        // We were already inside, so we are the offerer for this one.
        void dial(uin)
      }),
    )
    offs.push(
      ws.on('room_member_left', (ev) => {
        if (!mine(ev)) return
        const uin = from(ev)
        if (!uin) return
        setRoster((r) => r.filter((x) => x.uin !== uin))
        dropPeer(uin)
      }),
    )
    offs.push(
      ws.on('room_offer', async (ev) => {
        if (!mine(ev)) return
        const uin = from(ev)
        if (!uin) return
        const pc = mesh.current.peers.get(uin) ?? newPeer(uin)
        // ⚠ Glare. Once either side can turn a camera on mid-room, both can
        // re-offer at the same instant. The lower uin holds its ground and
        // ignores the colliding offer; the higher one yields and answers.
        // Whoever yields ends up answering the other's offer, so the line
        // survives instead of both sides sitting in have-local-offer.
        const colliding = mesh.current.making.has(uin) || pc.signalingState !== 'stable'
        if (colliding && (identity?.uin ?? 0) < uin) return
        await pc.setRemoteDescription({ type: 'offer', sdp: String(ev.sdp ?? '') })
        const queued = mesh.current.pendingIce.get(uin) ?? []
        for (const c of queued) await pc.addIceCandidate(c).catch(() => {})
        mesh.current.pendingIce.delete(uin)
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        signal('room_answer', uin, { sdp: answer.sdp })
      }),
    )
    offs.push(
      ws.on('room_answer', async (ev) => {
        if (!mine(ev)) return
        const uin = from(ev)
        const pc = uin ? mesh.current.peers.get(uin) : null
        if (!pc || !uin) return
        await pc.setRemoteDescription({ type: 'answer', sdp: String(ev.sdp ?? '') })
        const queued = mesh.current.pendingIce.get(uin) ?? []
        for (const c of queued) await pc.addIceCandidate(c).catch(() => {})
        mesh.current.pendingIce.delete(uin)
      }),
    )
    offs.push(
      ws.on('room_ice', async (ev) => {
        if (!mine(ev)) return
        const uin = from(ev)
        if (!uin) return
        let parsed: { sdp?: string; sdpMLineIndex?: number; sdpMid?: string }
        try {
          parsed = JSON.parse(String(ev.candidate ?? '{}'))
        } catch {
          return
        }
        const init: RTCIceCandidateInit = {
          candidate: parsed.sdp ?? '',
          sdpMLineIndex: parsed.sdpMLineIndex ?? 0,
          sdpMid: parsed.sdpMid ?? '0',
        }
        const pc = mesh.current.peers.get(uin)
        // ⚠ A candidate can arrive before the description it belongs to.
        // Queue it rather than dropping it: dropping is a peer that connects
        // on a good network and silently does not on a slow one.
        if (!pc || !pc.remoteDescription) {
          const q = mesh.current.pendingIce.get(uin) ?? []
          q.push(init)
          mesh.current.pendingIce.set(uin, q)
          return
        }
        await pc.addIceCandidate(init).catch(() => {})
      }),
    )
    offs.push(
      ws.on('room_speaking', (ev) => {
        if (!mine(ev)) return
        const uin = from(ev)
        if (!uin) return
        const on = Boolean(ev.speaking)
        setRoster((r) => r.map((m) => (m.uin === uin ? { ...m, speaking: on } : m)))
      }),
    )
    // ⚠ The island calls it `audio_room_deleted`; `room_deleted` never
    // existed, so until now deleting a room left everyone else sitting in it.
    offs.push(
      ws.on('audio_room_deleted', (ev) => {
        const id = Number(ev.room_id)
        setRooms((rs) => rs.filter((r) => r.id !== id))
        if (mesh.current.roomId === id) teardown()
      }),
    )
    // Being kicked or having membership revoked is the same exit as deletion.
    for (const kind of ['audio_room_kicked', 'audio_room_membership_revoked']) {
      offs.push(
        ws.on(kind, (ev) => {
          const id = Number(ev.room_id)
          setRooms((rs) => rs.filter((r) => r.id !== id))
          if (mesh.current.roomId === id) teardown()
        }),
      )
    }
    offs.push(
      ws.on('audio_room_renamed', (ev) => {
        const id = Number(ev.room_id)
        const name = String(ev.name ?? '')
        if (!id || !name) return
        setRooms((rs) => rs.map((r) => (r.id === id ? { ...r, name } : r)))
      }),
    )
    offs.push(
      ws.on('audio_room_member_muted', (ev) => {
        if (!mine(ev)) return
        const target = Number(ev.uin ?? 0)
        if (!target) return
        const muted = Boolean(ev.muted_by_owner)
        setRoster((r) => r.map((m) => (m.uin === target ? { ...m, mutedByOwner: muted } : m)))
      }),
    )
    return () => offs.forEach((off) => off())
  }, [dial, dropPeer, identity, newPeer, signal, teardown, ws])

  // Leaving the page is leaving the room; without this the island keeps us in
  // the roster until the socket times out and everyone else hears a ghost.
  useEffect(() => {
    const bye = () => {
      if (mesh.current.roomId != null) ws.send({ type: 'room_leave', room_id: mesh.current.roomId })
    }
    window.addEventListener('beforeunload', bye)
    return () => {
      window.removeEventListener('beforeunload', bye)
      bye()
    }
  }, [ws])

  const create = useCallback(
    async (name: string) => {
      if (!identity || !name.trim()) return
      await Api.createAudioRoom(identity, name.trim())
      await refresh()
    },
    [identity, refresh],
  )

  const joinByKey = useCallback(
    async (key: string) => {
      if (!identity) return
      setError(null)
      try {
        await Api.joinAudioRoom(identity, key.trim().toUpperCase())
        await refresh()
      } catch {
        setError('badkey')
      }
    },
    [identity, refresh],
  )

  const forget = useCallback(
    async (id: number) => {
      if (!identity) return
      await Api.forgetAudioRoom(identity, id)
      await refresh()
    },
    [identity, refresh],
  )

  const remove = useCallback(
    async (id: number) => {
      if (!identity) return
      await Api.deleteAudioRoom(identity, id)
      await refresh()
    },
    [identity, refresh],
  )

  const rename = useCallback(
    async (id: number, name: string) => {
      if (!identity || !name.trim()) return
      await Api.renameAudioRoom(identity, id, name.trim())
      await refresh()
    },
    [identity, refresh],
  )

  const value = useMemo<RoomsCtx>(
    () => ({
      rooms, refresh, create, joinByKey, forget, remove, rename,
      activeRoomId, joining, roster, micMuted, setMicMuted,
      cameraOn, setCameraEnabled, videos, enter, leave, error,
    }),
    [rooms, refresh, create, joinByKey, forget, remove, rename, activeRoomId, joining, roster, micMuted, setMicMuted, cameraOn, setCameraEnabled, videos, enter, leave, error],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useRooms(): RoomsCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useRooms outside RoomsProvider')
  return v
}

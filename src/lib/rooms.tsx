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
}

interface RoomsCtx {
  rooms: RoomSummary[]
  refresh: () => Promise<void>
  create: (name: string) => Promise<void>
  joinByKey: (key: string) => Promise<void>
  forget: (id: number) => Promise<void>
  remove: (id: number) => Promise<void>
  /// Currently inside this room, or null.
  activeRoomId: number | null
  joining: boolean
  roster: RoomMember[]
  micMuted: boolean
  setMicMuted: (muted: boolean) => void
  enter: (room: RoomSummary) => Promise<void>
  leave: () => void
  error: string | null
}

const Ctx = createContext<RoomsCtx | undefined>(undefined)

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
  const [error, setError] = useState<string | null>(null)

  /// Everything the mesh owns lives in a ref: it is mutated from websocket
  /// callbacks and must never be a render dependency.
  const mesh = useRef({
    peers: new Map<number, RTCPeerConnection>(),
    pendingIce: new Map<number, RTCIceCandidateInit[]>(),
    audioEls: new Map<number, HTMLAudioElement>(),
    local: null as MediaStream | null,
    ice: [] as RTCIceServer[],
    roomId: null as number | null,
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
      ws.send({ type, room_id: mesh.current.roomId, to, ...extra })
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

  const newPeer = useCallback(
    (uin: number): RTCPeerConnection => {
      const pc = new RTCPeerConnection({ iceServers: mesh.current.ice })
      mesh.current.local?.getTracks().forEach((t) => pc.addTrack(t, mesh.current.local!))
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
      pc.ontrack = (ev) => attachRemote(uin, ev.streams[0])
      mesh.current.peers.set(uin, pc)
      return pc
    },
    [attachRemote, signal],
  )

  const dial = useCallback(
    async (uin: number) => {
      if (mesh.current.peers.has(uin)) return
      const pc = newPeer(uin)
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      signal('room_offer', uin, { sdp: offer.sdp })
    },
    [newPeer, signal],
  )

  const dropPeer = useCallback((uin: number) => {
    mesh.current.peers.get(uin)?.close()
    mesh.current.peers.delete(uin)
    mesh.current.pendingIce.delete(uin)
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
    mesh.current.local = null
    mesh.current.roomId = null
    setRoster([])
    setJoining(false)
    setActiveRoomId(null)
  }, [dropPeer])

  const leave = useCallback(() => {
    const id = mesh.current.roomId
    if (id != null) ws.send({ type: 'room_leave', room_id: id })
    teardown()
    void refresh()
  }, [refresh, teardown, ws])

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
    [identity, micMuted, ws],
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
    const from = (ev: Record<string, unknown>) => Number(ev.from ?? ev.uin ?? 0) || null

    offs.push(
      ws.on('room_roster', (ev) => {
        if (!mine(ev)) return
        setJoining(false)
        const members = ((ev.members as Array<Record<string, unknown>>) ?? []).map((m) => ({
          uin: Number(m.uin),
          nickname: (m.nickname as string) || `#${m.uin}`,
        }))
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
        setRoster((r) => (r.some((x) => x.uin === uin) ? r : [...r, { uin, nickname: (m.nickname as string) || `#${uin}` }]))
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
    offs.push(
      ws.on('room_deleted', (ev) => {
        const id = Number(ev.room_id)
        setRooms((rs) => rs.filter((r) => r.id !== id))
        if (mesh.current.roomId === id) teardown()
      }),
    )
    return () => offs.forEach((off) => off())
  }, [dial, dropPeer, newPeer, signal, teardown, ws])

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

  const value = useMemo<RoomsCtx>(
    () => ({
      rooms, refresh, create, joinByKey, forget, remove,
      activeRoomId, joining, roster, micMuted, setMicMuted, enter, leave, error,
    }),
    [rooms, refresh, create, joinByKey, forget, remove, activeRoomId, joining, roster, micMuted, setMicMuted, enter, leave, error],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useRooms(): RoomsCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useRooms outside RoomsProvider')
  return v
}

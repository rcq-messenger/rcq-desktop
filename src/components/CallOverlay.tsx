// The call screen. Mounted once at app level, above every route, because a
// call is not something you can navigate away from — it follows the user
// through the app the way it does on the phones.
//
// Four faces of one sheet: ringing in, ringing out, connected, ended. All of
// the state and every decision lives in `lib/call.tsx`; this file only draws
// and dispatches.

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useCall } from '../lib/call'
import { PersonAvatar } from './PersonAvatar'
import { lookupContactAvatar } from '../lib/contacts-cache'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'

export function CallOverlay() {
  const call = useCall()
  const { t } = useI18n()
  const { phase, info } = call

  if (phase === 'idle' || !info) return null

  return (
    <AnimatePresence>
      <motion.div
        key="call"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-50 bg-surface-dim flex flex-col"
      >
        {phase === 'connected' && info.media === 'video' ? (
          <VideoStage />
        ) : (
          <Portrait subtitle={statusLine(t, call)} />
        )}
        <Controls />
      </motion.div>
    </AnimatePresence>
  )
}

/// One line under the name that says what the call is doing right now.
function statusLine(t: (k: string, v?: Record<string, string | number>) => string, call: ReturnType<typeof useCall>) {
  switch (call.phase) {
    case 'outgoing':
      return t('call.status.ringing')
    case 'incoming':
      return call.info?.media === 'video' ? t('call.status.incoming_video') : t('call.status.incoming')
    case 'connected':
      return call.connectedAt === null ? t('call.status.connecting') : ''
    case 'ended':
      return t(endedKey(call.endedReason))
    default:
      return ''
  }
}

/// The reasons come off the wire from whichever client hung up, so an unknown
/// one has to read as something rather than blank.
function endedKey(reason: string): string {
  switch (reason) {
    case 'declined':
    case 'declinedElsewhere':
      return 'call.ended.declined'
    case 'busy':
      return 'call.ended.busy'
    case 'no_answer':
      return 'call.ended.no_answer'
    case 'unavailable':
      return 'call.ended.unavailable'
    case 'failed':
      return 'call.ended.failed'
    case 'setup_failed':
      return 'call.ended.setup_failed'
    default:
      return 'call.ended.ended'
  }
}

/// Audio calls, and every stage before the video is flowing: a big initial, the
/// name, and one line of status. No video element, so nothing flashes black.
function Portrait({ subtitle }: { subtitle: string }) {
  const { info, phase, connectedAt, deviceError, remoteStream } = useCall()
  const { t } = useI18n()
  const { identity } = useIdentity()
  if (!info) return null
  // The person's actual face, like everywhere else in the app. A call is the
  // one screen where you look at nothing but this, and it was the one screen
  // showing a letter. PersonAvatar falls back on its own when there is no
  // picture, so there is nothing to branch on here.
  const avatar = identity ? lookupContactAvatar(identity.uin, info.peerUin) : null

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
      {/* Remote audio has to be attached to an element or nothing is heard. */}
      <RemoteAudio stream={remoteStream} />
      <PersonAvatar
        status={'offline'}
        size={112}
        mediaId={avatar?.mediaId}
        mediaKey={avatar?.mediaKey}
      />
      <div>
        <div className="text-2xl font-medium">{info.peerName}</div>
        <div className="font-mono text-sm text-fg-dim">#{info.peerUin}</div>
      </div>
      {phase === 'connected' && connectedAt !== null ? (
        <Elapsed since={connectedAt} />
      ) : (
        <div className="text-fg-secondary min-h-6">{subtitle}</div>
      )}
      {deviceError && <div className="text-sm text-red-500 max-w-xs">{t(deviceError)}</div>}
    </div>
  )
}

/// Video call: the peer fills the screen, we sit in the corner. The local
/// preview is mirrored, because a preview that is not mirrored feels wrong to
/// everyone who has ever used a mirror.
function VideoStage() {
  const { localStream, remoteStream, cameraOff, info, connectedAt } = useCall()
  const remoteRef = useRef<HTMLVideoElement | null>(null)
  const localRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    if (remoteRef.current) remoteRef.current.srcObject = remoteStream
  }, [remoteStream])
  useEffect(() => {
    if (localRef.current) localRef.current.srcObject = localStream
  }, [localStream])

  return (
    <div className="flex-1 relative bg-black overflow-hidden">
      <video ref={remoteRef} autoPlay playsInline className="w-full h-full object-contain" />
      {!cameraOff && (
        <video
          ref={localRef}
          autoPlay
          playsInline
          muted
          className="absolute bottom-4 right-4 w-36 rounded-xl shadow-lg [transform:scaleX(-1)]"
        />
      )}
      <div className="absolute top-4 left-0 right-0 flex flex-col items-center gap-1 text-white drop-shadow">
        <div className="text-lg font-medium">{info?.peerName}</div>
        {connectedAt !== null && <Elapsed since={connectedAt} className="text-sm opacity-80" />}
      </div>
    </div>
  )
}

/// A hidden <audio> is what actually makes the call audible — a MediaStream
/// with no element attached is decoded by nobody.
function RemoteAudio({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLAudioElement | null>(null)
  useEffect(() => {
    if (!ref.current) return
    ref.current.srcObject = stream
    void ref.current.play().catch(() => {
      // Autoplay policy. The user is mid-call, so a gesture has happened in
      // every real path; nothing useful to do if it still refuses.
    })
  }, [stream])
  return <audio ref={ref} autoPlay className="hidden" />
}

function Elapsed({ since, className = 'text-fg-secondary' }: { since: number; className?: string }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const total = Math.max(0, Math.floor((now - since) / 1000))
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return <div className={`font-mono tabular-nums ${className}`}>{`${mm}:${ss}`}</div>
}

function Controls() {
  const call = useCall()
  const { t } = useI18n()
  const { phase, info } = call
  if (!info) return null

  if (phase === 'incoming') {
    return (
      <div className="flex-none pb-10 pt-6 px-6 flex flex-col items-center gap-6">
        <div className="flex items-center gap-10">
          <RoundButton tone="danger" label={t('call.decline')} onClick={call.decline}>
            <HangUpIcon />
          </RoundButton>
          <RoundButton tone="accept" label={t('call.accept')} onClick={call.accept}>
            {info.media === 'video' ? <CameraIcon /> : <PhoneIcon />}
          </RoundButton>
        </div>
      </div>
    )
  }

  if (phase === 'ended') {
    return <div className="flex-none pb-10 pt-6 px-6 h-24" />
  }

  return (
    <div className="flex-none pb-10 pt-6 px-6 flex flex-col items-center gap-5">
      {call.incomingUpgrade && (
        <div className="flex items-center gap-3 bg-surface rounded-2xl px-4 py-3">
          <span className="text-sm">{t('call.upgrade.ask')}</span>
          <button
            onClick={call.acceptUpgrade}
            className="text-sm font-medium px-3 py-1 rounded-full bg-accent text-white"
          >
            {t('call.upgrade.accept')}
          </button>
          <button onClick={call.declineUpgrade} className="text-sm px-2 py-1 text-fg-secondary">
            {t('call.upgrade.decline')}
          </button>
        </div>
      )}
      <div className="flex items-center gap-6">
        <RoundButton
          tone={call.muted ? 'on' : 'neutral'}
          label={call.muted ? t('call.unmute') : t('call.mute')}
          onClick={call.toggleMute}
          disabled={phase !== 'connected'}
        >
          {call.muted ? <MicOffIcon /> : <MicIcon />}
        </RoundButton>

        {info.media === 'video' ? (
          <RoundButton
            tone={call.cameraOff ? 'on' : 'neutral'}
            label={call.cameraOff ? t('call.camera_on') : t('call.camera_off')}
            onClick={call.toggleCamera}
            disabled={phase !== 'connected'}
          >
            <CameraIcon />
          </RoundButton>
        ) : (
          <RoundButton
            tone="neutral"
            label={t('call.to_video')}
            onClick={call.upgradeToVideo}
            disabled={phase !== 'connected'}
          >
            <CameraIcon />
          </RoundButton>
        )}

        <RoundButton tone="danger" label={t('call.hang_up')} onClick={call.hangUp}>
          <HangUpIcon />
        </RoundButton>
      </div>
    </div>
  )
}

function RoundButton({
  children,
  label,
  onClick,
  tone,
  disabled,
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
  tone: 'neutral' | 'danger' | 'accept' | 'on'
  disabled?: boolean
}) {
  // Colour carries meaning and nothing else: green answers, red ends, and an
  // engaged toggle inverts. Everything else stays a plain surface.
  const tones: Record<string, string> = {
    neutral: 'bg-surface text-fg-primary hover:bg-surface-dim',
    on: 'bg-fg-primary text-surface',
    danger: 'bg-red-600 text-white hover:bg-red-700',
    accept: 'bg-accent text-white hover:bg-accent-dim',
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`w-16 h-16 rounded-full flex items-center justify-center transition-colors disabled:opacity-40 ${tones[tone]}`}
    >
      {children}
    </button>
  )
}

// ── glyphs ────────────────────────────────────────────────────────────────
// Inline so a call never waits on an icon font or a sprite request.

function PhoneIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />
    </svg>
  )
}

function HangUpIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <g transform="rotate(135 12 12)">
        <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />
      </g>
    </svg>
  )
}

function MicIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0M12 17v5" />
    </svg>
  )
}

function MicOffIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 9v1a3 3 0 0 0 4.6 2.5M15 10V5a3 3 0 0 0-5.9-.7" />
      <path d="M5 10a7 7 0 0 0 10.7 6M19 10a7 7 0 0 1-.6 2.8M12 17v5M3 3l18 18" />
    </svg>
  )
}

function CameraIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 7l-7 5 7 5V7z" />
      <rect x="1" y="5" width="15" height="14" rx="2" />
    </svg>
  )
}

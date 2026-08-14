// The round control at the bottom of anything live: a call, an audio room.
//
// Colour carries meaning and nothing else: green answers, red ends, and an
// engaged toggle inverts. Everything else stays a plain surface. Lifted out of
// CallOverlay when rooms needed the same row of buttons — two screens drawing
// the same control by hand is how they drift apart.

import type { ReactNode } from 'react'

export function RoundButton({
  children,
  label,
  onClick,
  tone,
  disabled,
  size = 64,
}: {
  children: ReactNode
  label: string
  onClick: () => void
  tone: 'neutral' | 'danger' | 'accept' | 'on'
  disabled?: boolean
  size?: number
}) {
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
      style={{ width: size, height: size }}
      className={`rounded-full flex items-center justify-center transition-colors disabled:opacity-40 ${tones[tone]}`}
    >
      {children}
    </button>
  )
}

// ── glyphs ────────────────────────────────────────────────────────────────
// Inline so a call never waits on an icon font or a sprite request.

export function PhoneIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />
    </svg>
  )
}

export function HangUpIcon() {
  return (
    // ⚠ A handset rotated inside its own 24-box does not fit: the corners of
    // the rotated glyph fall outside the viewBox and get clipped flat, which
    // is what the red button looked like. Rotate AND scale about the centre.
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <g transform="rotate(135 12 12) translate(12 12) scale(0.82) translate(-12 -12)">
        <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />
      </g>
    </svg>
  )
}

export function MicIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0M12 17v5" />
    </svg>
  )
}

export function MicOffIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 9v1a3 3 0 0 0 4.6 2.5M15 10V5a3 3 0 0 0-5.9-.7" />
      <path d="M5 10a7 7 0 0 0 10.7 6M19 10a7 7 0 0 1-.6 2.8M12 17v5M3 3l18 18" />
    </svg>
  )
}

export function CameraIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 7l-7 5 7 5V7z" />
      <rect x="1" y="5" width="15" height="14" rx="2" />
    </svg>
  )
}

export function CameraOffIcon() {
  // The same camcorder as CameraIcon with a stroke through it, drawn as the
  // body-with-a-corner-missing plus the lens wedge, so it still reads as a
  // camera. The first attempt was a handful of loose segments and looked it.
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 19H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1" />
      <path d="M8 5h6a2 2 0 0 1 2 2v6" />
      <path d="M23 7l-7 5" />
      <path d="M2 2l20 20" />
    </svg>
  )
}

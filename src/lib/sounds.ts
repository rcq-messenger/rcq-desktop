// Sound cues — same names as iOS `SoundService`. Files are mp3 (NOT the
// original .aif: AIFF only plays in Safari, so the .aif cues were silent
// in Chrome/most browsers — that's why "there are no sounds on web").
// HTMLAudioElement caches the buffer per cue so repeats are instant.
// Best-effort; the caller never sees a thrown error.

export type SoundCue =
  | 'app_startup'
  | 'message_incoming'
  | 'contact_online'
  | 'contact_offline'
  | 'message_sent'
  | 'nudge'

const FILES: Record<SoundCue, string> = {
  app_startup: '/sounds/app_startup.mp3',
  message_incoming: '/sounds/message_incoming.mp3',
  contact_online: '/sounds/contact_online.mp3',
  contact_offline: '/sounds/contact_offline.mp3',
  message_sent: '/sounds/message_sent.mp3',
  nudge: '/sounds/nudge.mp3',
}

const cache = new Map<SoundCue, HTMLAudioElement>()
let userInteracted = false

// Unlock the audio context on the first user gesture. Browser autoplay
// policy refuses .play() until the user clicks/taps once; we wire a
// one-shot listener at module load so cues fired soon after the first
// interaction work first try.
if (typeof window !== 'undefined') {
  const unlock = () => {
    userInteracted = true
    window.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
  }
  window.addEventListener('pointerdown', unlock, { once: true })
  window.addEventListener('keydown', unlock, { once: true })
}

function audioFor(cue: SoundCue): HTMLAudioElement {
  let a = cache.get(cue)
  if (!a) {
    a = new Audio(FILES[cue])
    a.preload = 'auto'
    cache.set(cue, a)
  }
  return a
}

/// Playback is best-effort. Mute toggle lives in localStorage —
/// `rcq.web.sounds.enabled` defaults to true; Settings can flip it.
export function playSound(cue: SoundCue): void {
  if (typeof window === 'undefined') return
  if (!userInteracted) return // browser autoplay-policy bail
  if (localStorage.getItem('rcq.web.sounds.enabled') === '0') return
  const a = audioFor(cue)
  try {
    a.currentTime = 0
    void a.play().catch(() => {
      // Format-not-supported / other transient. Sound is optional,
      // we don't surface failures.
    })
  } catch {
    /* noop */
  }
}

export function isSoundEnabled(): boolean {
  if (typeof window === 'undefined') return true
  return localStorage.getItem('rcq.web.sounds.enabled') !== '0'
}

export function setSoundEnabled(on: boolean) {
  localStorage.setItem('rcq.web.sounds.enabled', on ? '1' : '0')
}

// Sub-toggle: play a chime when a contact comes online / goes offline
// (mirrors iOS's separate presence-sound setting). Defaults on; only
// consulted by the contact_online / contact_offline cue sites, and only
// matters when the master `rcq.web.sounds.enabled` is also on.
export function isPresenceSoundEnabled(): boolean {
  if (typeof window === 'undefined') return true
  return localStorage.getItem('rcq.web.sounds.presence') !== '0'
}

export function setPresenceSoundEnabled(on: boolean) {
  localStorage.setItem('rcq.web.sounds.presence', on ? '1' : '0')
}

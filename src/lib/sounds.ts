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

/// The desktop app, detected the way `desktop.ts` does it. Inlined rather than
/// imported: this module is pulled in by the incoming store, and the desktop
/// bridge has no business in that import graph.
function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/// Playback is best-effort. Mute toggle lives in localStorage —
/// `rcq.web.sounds.enabled` defaults to true; Settings can flip it.
export function playSound(cue: SoundCue): void {
  if (typeof window === 'undefined') return
  // Browser autoplay-policy bail. ⚠ Not on the desktop (#983): an app started
  // from the tray at login may never see a click in its window, and then it
  // never chimed at all. WebView2 lets the page play; if it ever refuses, the
  // rejected promise below is swallowed like any other failure.
  if (!userInteracted && !inTauri()) return
  if (localStorage.getItem('rcq.web.sounds.enabled') === '0') return
  const a = audioFor(cue)
  try {
    a.currentTime = 0
    a.volume = soundVolume()
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

// How loud the chimes and the call tones play, 0..1 (#983). Defaults to full,
// which is what everybody had before the slider existed. The desktop had no
// level of its own, and Windows only lists the WebView2 process in the mixer
// while something is actually playing, so there was nowhere to turn it down.
const VOLUME_KEY = 'rcq.web.sounds.volume'

export function soundVolume(): number {
  if (typeof window === 'undefined') return 1
  try {
    const raw = localStorage.getItem(VOLUME_KEY)
    if (raw == null) return 1
    const v = Number(raw)
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1
  } catch {
    return 1
  }
}

export function setSoundVolume(v: number) {
  const clamped = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1
  localStorage.setItem(VOLUME_KEY, String(clamped))
}

/// One chime at the current level, for the slider: moving it silently leaves
/// the person guessing what they picked. Bypasses the gesture gate, because
/// dragging the slider IS the gesture.
export function previewSoundVolume() {
  if (typeof window === 'undefined') return
  // A disabled range input still receives pointer events in Chromium, so the
  // slider's release handler alone does not keep a muted app quiet.
  if (!isSoundEnabled()) return
  const a = audioFor('message_incoming')
  try {
    a.currentTime = 0
    a.volume = soundVolume()
    void a.play().catch(() => {})
  } catch {
    /* noop */
  }
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

// Sub-toggle: the chime on YOUR OWN outgoing message. Same shape as the
// presence one, and it exists for the same reason: the master switch was the
// only way to silence it, which also cost you the incoming chime — the one
// sound people actually want. Defaults on, so nobody's app changes until they
// come looking for this.
export function isSentSoundEnabled(): boolean {
  if (typeof window === 'undefined') return true
  return localStorage.getItem('rcq.web.sounds.sent') !== '0'
}

export function setSentSoundEnabled(on: boolean) {
  localStorage.setItem('rcq.web.sounds.sent', on ? '1' : '0')
}

// Call tones, synthesised rather than shipped.
//
// A ringtone is a repeating pattern of two frequencies — a handful of lines of
// WebAudio, and no megabytes of audio assets to bundle, cache-bust and keep in
// sync across the web build and the desktop bundle. The cadences below are the
// European ones the phones already sound like: 425 Hz, one second on.
//
// Everything here is best-effort. Browsers refuse to start an AudioContext
// before the first user gesture, so an incoming ring on a page nobody has
// touched yet stays silent — the visual call sheet is the real notification,
// the tone is the courtesy.

type Tone = { ctx: AudioContext; timer: ReturnType<typeof setInterval> | null }

let active: Tone | null = null

function context(): AudioContext | null {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    const ctx = new Ctor()
    // Suspended until a gesture on most browsers; resuming is harmless when
    // it is already running, and succeeds silently once the user has clicked.
    void ctx.resume().catch(() => {})
    return ctx
  } catch {
    return null
  }
}

/// One burst of `freqs` played together for `seconds`, with short fades so the
/// tone starts and stops without a click.
function burst(ctx: AudioContext, freqs: number[], seconds: number, volume: number) {
  const now = ctx.currentTime
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(volume, now + 0.02)
  gain.gain.setValueAtTime(volume, now + seconds - 0.02)
  gain.gain.linearRampToValueAtTime(0, now + seconds)
  gain.connect(ctx.destination)
  for (const f of freqs) {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(f, now)
    osc.connect(gain)
    osc.start(now)
    osc.stop(now + seconds)
  }
}

function loop(freqs: number[], onSeconds: number, periodSeconds: number, volume: number) {
  stopTone()
  const ctx = context()
  if (!ctx) return
  const fire = () => burst(ctx, freqs, onSeconds, volume)
  fire()
  active = { ctx, timer: setInterval(fire, periodSeconds * 1000) }
}

/// Caller side: the "it is ringing over there" tone. Quiet — it plays into the
/// same headset the call is about to use.
export function startRingback() {
  loop([425], 1, 5, 0.05)
}

/// Callee side: the incoming ring. Two tones so it reads as a bell rather than
/// a test signal, and louder, because it has to be noticed.
export function startRingtone() {
  loop([440, 554], 1.2, 3, 0.09)
}

/// One short low note for a call that ended, so a drop is audible without
/// looking at the screen.
export function playEndTone() {
  stopTone()
  const ctx = context()
  if (!ctx) return
  burst(ctx, [280], 0.35, 0.06)
  setTimeout(() => void ctx.close().catch(() => {}), 600)
}

export function stopTone() {
  if (!active) return
  if (active.timer) clearInterval(active.timer)
  void active.ctx.close().catch(() => {})
  active = null
}

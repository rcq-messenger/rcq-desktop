// The full-screen veil for transitions that end in a hard reload: switching
// accounts, adopting a restored identity, adding one. The founder's ask
// (21.08), after the PIN unlock got its staged reveal: the same moments used
// to freeze the old screen mid-click until the new page arrived, which reads
// as a hang, not a handoff.
//
// Imperative DOM on purpose: every caller navigates away within a second, so
// mounting React state for it would be plumbing for a corpse. The veil fades
// in over whatever is on screen and simply dies with the page. Tailwind
// classes work here — they are global CSS, not component magic.

let shown = false

export function showTransitionVeil(): void {
  if (shown || typeof document === 'undefined') return
  shown = true
  const veil = document.createElement('div')
  veil.className = 'fixed inset-0 z-[100] flex items-center justify-center transition-opacity duration-200'
  veil.style.opacity = '0'
  veil.style.backgroundColor = 'rgb(var(--c-surface-dim))'
  const spinner = document.createElement('span')
  spinner.className = 'block h-7 w-7 rounded-full border-2 border-line border-t-accent animate-spin'
  veil.appendChild(spinner)
  document.body.appendChild(veil)
  // Two frames so the starting opacity reaches the screen before the fade.
  requestAnimationFrame(() => requestAnimationFrame(() => { veil.style.opacity = '1' }))
}

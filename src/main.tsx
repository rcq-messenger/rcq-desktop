import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { bypassStatus, isTauri } from './lib/desktop'
import { installFrontRouting, refreshFrontRouting, setFrontHost } from './lib/front'
import { wipeLocalAccountData } from './lib/auth'
import { idbClearAll } from './lib/signal-persist'
import { initFontScale } from './lib/fontscale'

// Desktop (Tauri) build only: mark the root so the desktop-sized root font in
// index.css applies. The palette is no longer keyed off this — both surfaces
// are true black since 2026-08-05 — but the type size still is: it answers a
// window on a monitor, and lifting it in the browser would grow the layout on
// phones too.
if (isTauri()) document.documentElement.classList.add('desktop')

// The user's own multiplier on that root size (#477). Applied here rather than
// from a component for the same reason as the class above: after the first
// paint it is a visible jump.
initFontScale()

// Desktop only: put the Cloudflare front in front of the flagship, so a
// blocked island has an answer that does not need the tunnel (which on this
// platform cannot be applied to a window that is already open).
//
// Not for the browser build. chat.rcq.app is served from the island's own
// address, so a user who cannot reach the island never loaded this page to
// begin with — there is nothing for a front to rescue there.
//
// Installed before React mounts so the very first request already goes through
// the wrapper, and probed without blocking the mount: a healthy user must not
// wait on a censorship check, and a blocked one is no worse off than today
// while it runs.
if (isTauri()) {
  installFrontRouting()
  void (async () => {
    // Ask the signed list where the front lives before deciding whether to use
    // it. Local call, no network: Rust already holds the verified payload.
    // Nothing names one today, so this is the compiled-in host until a config
    // push moves it — which is the whole point, since the front and the island
    // share the apex and one rule by name takes both.
    const status = await bypassStatus()
    if (status?.relay_front) setFrontHost(`https://${status.relay_front}`)
    await refreshFrontRouting()
  })()
}

// ★ One origin, one session.
//
// market.rcq.app used to serve this same app, and localStorage is per-ORIGIN,
// so an account signed in on both hosts had TWO independent copies of its
// identity — private keys included. Signing out of chat.rcq.app could not
// touch the other one: the browser had simply never been told they were the
// same thing. Reported 2026-08-04, and it does what it says on the tin — "I
// signed out" left a fully usable session behind on our own second hostname.
//
// The market is a screen of the app now, not a website, so this host only
// forwards — and on the way past it destroys the copy of the account it is
// holding. Forwarding alone would have left that copy on disk: unreachable by
// the app, still a full identity with private keys in it, still there after a
// sign-out the user believes they performed. Signing out has to mean signed
// out, including from a hostname we should never have kept a session on.
//
// Both steps run before React mounts, so no session is established here again.
if (!isTauri() && window.location.hostname.startsWith('market.')) {
  const chat = window.location.hostname.replace(/^market\./, 'chat.')
  const onward = `${window.location.protocol}//${chat}/market`
  void (async () => {
    try {
      wipeLocalAccountData()
      await idbClearAll()
    } catch {
      // Never strand the user on a blank page because a cleanup failed —
      // forwarding is the part they are waiting for.
    }
    window.location.replace(onward)
  })()
} else {
  mount()
}

function mount() {

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { isTauri } from './lib/desktop'

// Desktop (Tauri) build only: mark the root so the true-black dark theme
// override in index.css applies. The web build never gets this class, so
// chat.rcq.app keeps the grey dark theme.
if (isTauri()) document.documentElement.classList.add('desktop')

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
// forwards. Done before React mounts, so no session is ever established here
// again.
if (!isTauri() && window.location.hostname.startsWith('market.')) {
  const chat = window.location.hostname.replace(/^market\./, 'chat.')
  window.location.replace(`${window.location.protocol}//${chat}/market`)
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

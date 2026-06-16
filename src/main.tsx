import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { isTauri } from './lib/desktop'

// Desktop (Tauri) build only: mark the root so the true-black dark theme
// override in index.css applies. The web build never gets this class, so
// chat.rcq.app keeps the grey dark theme.
if (isTauri()) document.documentElement.classList.add('desktop')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

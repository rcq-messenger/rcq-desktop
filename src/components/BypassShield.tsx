// Header shield for the RCQ relays on desktop, the same badge the phones
// carry, and on desktop also the way in to turning them on.
//
// The feature is named "RCQ relays" in every string now, not "bypass" or
// "circumvention": it is a privacy layer anyone can use, and being the only
// road out of a censored network is a consequence of that, not the pitch. The
// `bypass.*` / `settings.bypass.*` keys and this file's name are unchanged on
// purpose so the four clients keep sharing one vocabulary of keys.
//
// It is deliberately honest about two things: solid only once the island has
// answered THROUGH the relay, amber while the tunnel is up but has not been
// seen carrying anything. The phones learned that the hard way, from a shield
// that claimed a working bypass over a dead chain ("щит есть, связи нет").
//
// It used to render nothing at all while the bypass was off, which meant the
// only way to reach the feature was Settings → scroll → a section near the
// bottom, and the only link to diagnostics in the whole app was inside that
// same section. So the shield now stays visible (dimmed) whenever this is a
// desktop build, and clicking it opens the switch and the diagnostics link
// right there. Renders nothing in the browser, where there is no bypass at all.

import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  bypassStatus,
  networkDiagnostics,
  relaunchApp,
  setBypassEnabled,
  type BypassStatus,
} from '../lib/desktop'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'

// Re-probe on this cadence: often enough that a relay dying turns the shield
// amber while the user is still looking at it, rarely enough that we are not
// hammering the island from every idle window.
const RECHECK_MS = 2 * 60 * 1000

export function BypassShield({ className = '' }: { className?: string }) {
  const { t } = useI18n()
  const { identity } = useIdentity()
  const [status, setStatus] = useState<BypassStatus | null>(null)
  const [verified, setVerified] = useState(false)
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!identity) return
    let alive = true
    const host = identity.apiBase.replace(/^https?:\/\//, '').replace(/\/.*$/, '')

    async function check() {
      const s = await bypassStatus()
      if (!alive) return
      setStatus(s)
      if (!s?.running) return setVerified(false)
      // Seconds on a censored network — each probe waits out its timeout — so
      // this stays on the slow timer and is never tied to opening the menu.
      const diag = await networkDiagnostics(host)
      if (alive) setVerified(!!diag?.route_ok)
    }

    void check()
    const timer = setInterval(() => void check(), RECHECK_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [identity])

  // Close on click-outside and on Escape, the same as the other header menus.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Browser build: there is no bypass to offer.
  if (!status) return null

  const running = status.running
  const tone = !running ? 'text-fg-secondary' : verified ? 'text-accent' : 'text-amber-500'
  const label = running
    ? t(verified ? 'bypass.shield.verified' : 'bypass.shield.unverified')
    : t('bypass.shield.off')

  // What the switch should READ: the user's own choice, or an auto-engaged
  // tunnel. Without the second half an automatic tunnel showed an "off" switch
  // over a working bypass, which reads as a bug in both directions.
  const wanted = status.enabled || status.auto

  async function toggle(enabled: boolean) {
    if (!(await setBypassEnabled(enabled))) return
    // Turning an auto tunnel off is an opt-out the backend records; reflect it
    // here immediately so the switch does not spring back.
    setStatus((s) => (s ? { ...s, enabled, auto: false } : s))
  }

  return (
    <div className="relative flex-none" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={label}
        aria-label={label}
        aria-expanded={open}
        className={'flex-none p-1 rounded-md hover:bg-surface-dim transition-colors ' + className}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={'w-[1.125rem] h-[1.125rem] ' + tone}>
          <path d="M12 2 4 5.5v6c0 4.6 3.2 8.9 8 10.5 4.8-1.6 8-5.9 8-10.5v-6L12 2Z" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-surface rounded-lg shadow-lg p-3 space-y-2 z-30">
          <label
            className={
              'flex items-center justify-between gap-3 ' +
              (status.supported ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed')
            }
          >
            <span className="text-sm">{t('settings.bypass.toggle')}</span>
            <input
              type="checkbox"
              checked={wanted}
              disabled={!status.supported}
              onChange={(e) => void toggle(e.target.checked)}
              className="w-5 h-5 accent-accent cursor-pointer"
            />
          </label>

          {/* The switch says "relays" and this is the only screen some people
              will ever meet the word on, so the way to look it up has to be
              here and not only in Settings. target="_blank" is turned into the
              system browser by the handler main.tsx installs. */}
          <a
            href="https://rcq.app/faq#relays"
            target="_blank"
            rel="noreferrer"
            className="inline-block text-xs text-accent underline-offset-2 hover:underline"
          >
            {t('settings.bypass.learn')}
          </a>

          {!status.supported && (
            <p className="text-xs text-fg-dim">{t('settings.bypass.unsupported')}</p>
          )}

          {/* The app turned this on by itself after the island did not answer
              directly. Saying so is the difference between "it is protecting
              me" and "why is my client routing through somewhere". */}
          {status.auto && <p className="text-xs text-fg-dim">{t('bypass.auto_note')}</p>}

          {/* The proxy is bound to the webview when the window is built, so a
              flip only takes effect after a restart. Saying so here is what
              stops the switch from looking broken. */}
          {/* Raised mid-session because the island stopped answering. The switch
              and the core now AGREE — both on — so the condition below would say
              nothing, and the user would be looking at a tunnel the page is not
              using with no explanation for why the app still cannot connect. */}
          {status.needs_relaunch && (
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-fg-dim">{t('bypass.needs_relaunch')}</p>
              <button
                onClick={() => void relaunchApp()}
                className="shrink-0 h-7 px-2 rounded-md bg-field text-xs font-medium hover:bg-line/50 transition-colors"
              >
                {t('settings.bypass.restart_now')}
              </button>
            </div>
          )}

          {status.supported && !status.needs_relaunch && wanted !== status.running && (
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-fg-dim">
                {status.enabled && status.tried_at_startup
                  ? t('settings.bypass.failed')
                  : t('settings.bypass.restart_note')}
              </p>
              <button
                onClick={() => void relaunchApp()}
                className="shrink-0 h-7 px-2 rounded-md bg-field text-xs font-medium hover:bg-line/50 transition-colors"
              >
                {t('settings.bypass.restart_now')}
              </button>
            </div>
          )}

          {running && (
            <p className="text-xs text-fg-dim">
              {t('settings.bypass.running', { count: status.relay_count })}
              {status.relay_config_version != null &&
                ` · ${t('settings.bypass.list_version', { version: status.relay_config_version })}`}
            </p>
          )}

          <Link
            to="/diagnostics"
            onClick={() => setOpen(false)}
            className="block text-xs font-medium text-accent hover:underline"
          >
            {t('diag.title')}
          </Link>
        </div>
      )}
    </div>
  )
}

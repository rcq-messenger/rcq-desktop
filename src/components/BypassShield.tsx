// Header shield for the desktop bypass, the same badge the phones carry.
//
// It is deliberately honest about two different things: it appears only when
// traffic is actually going through a relay, and it only goes solid once the
// island has answered over that route. Amber means the tunnel is up but has
// not been seen carrying anything — the phones learned that the hard way, from
// a shield that claimed a working bypass over a dead chain ("щит есть, связи
// нет"). Renders nothing off the desktop, or with the bypass off.

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { bypassStatus, networkDiagnostics } from '../lib/desktop'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'

// Re-probe on this cadence: often enough that a relay dying turns the shield
// amber while the user is still looking at it, rarely enough that we are not
// hammering the island from every idle window.
const RECHECK_MS = 2 * 60 * 1000

export function BypassShield({ className = '' }: { className?: string }) {
  const { t } = useI18n()
  const { identity } = useIdentity()
  const [on, setOn] = useState(false)
  const [verified, setVerified] = useState(false)

  useEffect(() => {
    if (!identity) return
    let alive = true
    const host = identity.apiBase.replace(/^https?:\/\//, '').replace(/\/.*$/, '')

    async function check() {
      const status = await bypassStatus()
      if (!alive) return
      setOn(!!status?.running)
      if (!status?.running) return setVerified(false)
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

  if (!on) return null

  return (
    <Link
      to="/diagnostics"
      title={t(verified ? 'bypass.shield.verified' : 'bypass.shield.unverified')}
      aria-label={t(verified ? 'bypass.shield.verified' : 'bypass.shield.unverified')}
      className={'flex-none p-1 rounded-md hover:bg-surface-dim transition-colors ' + className}
    >
      <svg
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        className={'w-[18px] h-[18px] ' + (verified ? 'text-accent' : 'text-amber-500')}
      >
        <path d="M12 2 4 5.5v6c0 4.6 3.2 8.9 8 10.5 4.8-1.6 8-5.9 8-10.5v-6L12 2Z" />
      </svg>
    </Link>
  )
}

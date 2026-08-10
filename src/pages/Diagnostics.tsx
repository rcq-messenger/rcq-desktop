// Connection diagnostics — the tool for "why won't it connect" on a censored
// network, mirroring the phones' ConnectionDiagnostics.
//
// The two probes are the point: the island reached directly, and the island
// reached the way we are actually routing. Direct blocked but route reachable
// means the relay is doing its job. Both failing means the network is blocking
// everything we can reach. Both are run in Rust, so "direct" is genuinely
// direct — a fetch from this page would go through the webview's proxy and
// could never answer that question.

import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Api } from '../lib/api'
import type { WebIdentity } from '../lib/crypto'
import { isTauri, networkDiagnostics, type NetworkDiagnostics } from '../lib/desktop'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import { useWS } from '../lib/ws'

/// What a call would find if one were placed right now: a usable microphone,
/// and somewhere to relay media when the two ends cannot see each other.
/// Answering these on a quiet screen beats discovering them mid-call.
interface CallReadiness {
  /// An i18n key rather than a verdict, because "no access" and "no device"
  /// need different things done about them.
  mic: string
  /// Relay servers the island handed out. `null` means we could not ask.
  turn: number | null
}

async function checkCalls(identity: WebIdentity): Promise<CallReadiness> {
  let mic = 'diag.mic_ok'
  if (!navigator.mediaDevices?.getUserMedia) {
    mic = 'diag.mic_unsupported'
  } else {
    try {
      // Actually open the device. Querying the permission alone would pass on
      // macOS right up until the hardened runtime refuses the capture itself.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((track) => track.stop())
    } catch (e) {
      const name = (e as { name?: string } | null)?.name ?? ''
      mic = name === 'NotFoundError' ? 'diag.mic_none' : 'diag.mic_denied'
    }
  }

  let turn: number | null = null
  try {
    turn = (await Api.turnCredentials(identity)).urls.length
  } catch {
    // Island unreachable or too old for the endpoint; the row says "unknown"
    // rather than claiming there are no relays.
  }
  return { mic, turn }
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'bad' }) {
  const color = tone === 'ok' ? 'text-accent' : tone === 'bad' ? 'text-red-600' : 'text-fg-secondary'
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-fg-secondary">{label}</span>
      <span className={'text-right ' + color}>{value}</span>
    </div>
  )
}

export function Diagnostics() {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const navigate = useNavigate()
  const { connected } = useWS()
  const [running, setRunning] = useState(true)
  const [diag, setDiag] = useState<NetworkDiagnostics | null>(null)
  // Bumped by "Run again"; the only other trigger is arriving on the page.
  const [attempt, setAttempt] = useState(0)
  const [calls, setCalls] = useState<CallReadiness | null>(null)

  const host = identity?.apiBase.replace(/^https?:\/\//, '').replace(/\/.*$/, '') ?? ''

  useEffect(() => {
    if (!host) return
    let alive = true
    void (async () => {
      setRunning(true)
      const [result, callState] = await Promise.all([
        networkDiagnostics(host),
        identity ? checkCalls(identity) : Promise.resolve(null),
      ])
      if (!alive) return
      setDiag(result)
      setCalls(callState)
      setRunning(false)
    })()
    return () => {
      alive = false
    }
  }, [host, attempt, identity])

  if (!identity) {
    navigate('/', { replace: true })
    return null
  }

  return (
    <div className="min-h-screen bg-surface-dim">
      <header className="rcq-header sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-3 h-14 flex items-center gap-3">
          <Link to="/settings" className="text-fg-secondary hover:text-fg-primary" aria-label={t('common.back')}>
            ←
          </Link>
          <div className="font-semibold">{t('diag.title')}</div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-4 space-y-4">
        <section className="bg-surface rounded-lg p-4 space-y-2">
          <Row
            label={t('diag.route')}
            value={diag?.tunnel ? t('diag.mode_tunnel') : t('diag.mode_direct')}
          />
          <Row
            label={t('diag.island_direct')}
            value={
              running || !diag
                ? '…'
                : diag.direct_ok
                  ? t('diag.reachable')
                  : t('diag.blocked')
            }
            tone={running || !diag ? undefined : diag.direct_ok ? 'ok' : 'bad'}
          />
          <Row
            label={t('diag.island_route')}
            value={
              running || !diag
                ? '…'
                : diag.route_ok
                  ? t('diag.reachable')
                  : t('diag.unreachable')
            }
            tone={running || !diag ? undefined : diag.route_ok ? 'ok' : 'bad'}
          />
          <Row
            label={t('diag.ws')}
            value={connected ? t('diag.connected') : t('diag.disconnected')}
            tone={connected ? 'ok' : 'bad'}
          />
          {isTauri() && (
            <Row
              label={t('diag.relays')}
              value={
                diag?.relay_config_version != null
                  ? t('diag.relays_signed', {
                      count: diag.relay_count,
                      version: diag.relay_config_version,
                    })
                  : t('diag.relays_bundled', { count: diag?.relay_count ?? 0 })
              }
            />
          )}
          <Row
            label={t('diag.mic')}
            value={running || !calls ? '…' : t(calls.mic)}
            tone={running || !calls ? undefined : calls.mic === 'diag.mic_ok' ? 'ok' : 'bad'}
          />
          <Row
            label={t('diag.turn')}
            value={
              running || !calls
                ? '…'
                : calls.turn === null
                  ? t('diag.turn_unknown')
                  : calls.turn > 0
                    ? t('diag.turn_ok', { count: calls.turn })
                    : t('diag.turn_none')
            }
            tone={running || !calls || calls.turn === null ? undefined : calls.turn > 0 ? 'ok' : 'bad'}
          />
          <Row label={t('diag.island')} value={host} />
        </section>

        <p className="text-xs text-fg-dim leading-relaxed">{t('diag.footer')}</p>

        <button
          onClick={() => setAttempt((n) => n + 1)}
          disabled={running}
          className="w-full h-10 rounded-md bg-field text-sm font-medium hover:bg-line/50 disabled:opacity-40 transition-colors"
        >
          {running ? t('diag.running') : t('diag.run_again')}
        </button>
      </main>
    </div>
  )
}

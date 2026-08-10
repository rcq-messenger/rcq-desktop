// Incoming contact requests. Lives behind a tab/badge from the
// Contacts header. Accept / decline triggers `/contacts/respond`;
// the backend pushes a `contact_response` to the proposer over
// WS so they don't have to refresh.

import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Api, type PendingRequest } from '../lib/api'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import { useWS } from '../lib/ws'
import { listRequests, clearRequest, blockRequest, type CrossIslandRequest } from '../lib/crossisland-requests'
import { saveCrossIsland } from '../lib/crossisland-store'
import { fetchPeerKeyCard } from '../lib/federation-send'
import { addIncoming, beginCatchUp, endCatchUp } from '../lib/incoming-store'

export function PendingRequests() {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const ws = useWS()
  const navigate = useNavigate()
  const [requests, setRequests] = useState<PendingRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [acting, setActing] = useState<number | null>(null)
  // Cross-island message requests (Variant A): held in localStorage, accepted
  // by adding the sender as a cross-island contact + replaying their messages.
  const [ci, setCi] = useState<CrossIslandRequest[]>(() => listRequests())
  const [ciActing, setCiActing] = useState<string | null>(null)

  async function acceptCI(r: CrossIslandRequest) {
    const tag = `${r.uin}@${r.host}`
    setCiActing(tag)
    try {
      const card = await fetchPeerKeyCard(r.host, r.uin)
      if (!card) throw new Error('card')
      saveCrossIsland({
        uin: r.uin,
        host: r.host,
        nickname: card.nickname?.trim() || tag,
        identityKey: card.identity_key,
        signingKey: card.signing_key,
        signalIdentityKey: card.signal_identity_key ?? null,
        addedAt: Date.now(),
        gender: card.gender ?? null,
        statusMessage: card.status_message ?? null,
      })
      const held = clearRequest(r.uin, r.host)
      // Held messages are a backlog being released by an explicit accept, not
      // traffic arriving now: a banner per quarantined message would fire a
      // burst at the exact moment the user is looking at the request.
      beginCatchUp()
      try {
        held?.msgs.forEach((m) => addIncoming(r.uin, m)) // surface the held messages
      } finally {
        endCatchUp()
      }
      setCi(listRequests())
      navigate(`/chat/${r.uin}?i=${encodeURIComponent(r.host)}`)
    } catch {
      setError(t('pending.error'))
    } finally {
      setCiActing(null)
    }
  }

  function blockCI(r: CrossIslandRequest) {
    blockRequest(r.uin, r.host)
    setCi(listRequests())
  }

  async function refresh() {
    if (!identity) return
    setError(null)
    setLoading(true)
    try {
      const list = await Api.pendingRequests(identity)
      setRequests(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('pending.error'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    // Live updates: when a fresh `contact_request` lands while we're
    // here, append it. `contact_response` is for OUR outgoing
    // requests, which the AddContact flow handles separately.
    const off = ws.on('contact_request', () => {
      void refresh()
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.uin])

  if (!identity) {
    navigate('/', { replace: true })
    return null
  }

  async function respond(reqId: number, accept: boolean) {
    setActing(reqId)
    try {
      await Api.respondToRequest(identity!, reqId, accept)
      setRequests((rs) => rs.filter((r) => r.id !== reqId))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('pending.error'))
    } finally {
      setActing(null)
    }
  }

  return (
    <div className="min-h-screen bg-surface-dim">
      <header className="sticky top-0 bg-surface border-b border-line z-10">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link to="/contacts" className="text-fg-secondary hover:text-fg-primary px-2">
            ←
          </Link>
          <div className="font-semibold">{t('pending.title')}</div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-4">
        {ci.length > 0 && (
          <section className="mb-4">
            <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide mb-2">
              {t('ci.section')}
            </div>
            <ul className="bg-surface rounded-lg border border-line divide-y divide-line">
              {ci.map((r) => {
                const tag = `${r.uin}@${r.host}`
                const firstText = r.msgs.find((m) => m.kind === 'text') as { text?: string } | undefined
                return (
                  <li key={tag} className="p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-mono text-sm truncate">{tag}</div>
                        <div className="text-xs text-fg-dim truncate">
                          {firstText?.text || t('ci.wants', { n: r.msgs.length })}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => blockCI(r)}
                          className="px-3 h-9 rounded-md border border-line text-sm font-medium hover:bg-surface-dim transition-colors"
                        >
                          {t('ci.block')}
                        </button>
                        <button
                          onClick={() => void acceptCI(r)}
                          disabled={ciActing === tag}
                          className="px-3 h-9 rounded-md bg-accent hover:bg-accent-dim text-white text-sm font-semibold disabled:opacity-40 transition-colors"
                        >
                          {t('pending.accept')}
                        </button>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {loading && requests.length === 0 && (
          <div className="text-center text-sm text-fg-secondary py-12">
            {t('contacts.loading')}
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-600 mb-4">
            {error}
            <button onClick={refresh} className="ml-3 underline">
              {t('common.retry')}
            </button>
          </div>
        )}

        {!loading && requests.length === 0 && ci.length === 0 && !error && (
          <div className="text-center text-sm text-fg-secondary py-12">
            {t('pending.empty')}
          </div>
        )}

        <ul className="bg-surface rounded-lg border border-line divide-y divide-line">
          {requests.map((r) => (
            <li key={r.id} className="p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium truncate">
                    {r.nickname || `#${r.from_uin}`}
                  </div>
                  <div className="font-mono text-xs text-fg-dim">#{r.from_uin}</div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void respond(r.id, false)}
                    disabled={acting === r.id}
                    className="px-3 h-9 rounded-md border border-line text-sm font-medium hover:bg-surface-dim disabled:opacity-40 transition-colors"
                  >
                    {t('pending.decline')}
                  </button>
                  <button
                    onClick={() => void respond(r.id, true)}
                    disabled={acting === r.id}
                    className="px-3 h-9 rounded-md bg-accent hover:bg-accent-dim text-white text-sm font-semibold disabled:opacity-40 transition-colors"
                  >
                    {t('pending.accept')}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </main>
    </div>
  )
}

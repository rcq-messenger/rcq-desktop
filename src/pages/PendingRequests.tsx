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
import { sendContactAccept, sendContactDecline } from '../lib/crossisland-contactreq'
import { pushProfileTo } from '../lib/crossisland-profile'
import { fetchPeerKeyCard } from '../lib/federation-send'
import { addIncoming, beginCatchUp, endCatchUp } from '../lib/incoming-store'

/// [embedded] drops the page chrome so the same body can live inside a modal.
export function PendingRequests({ embedded = false }: { embedded?: boolean } = {}) {
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
      // §5f symmetry: acceptance is only half-done on this device. Deposit an
      // `accept` back to the requester's island so BOTH sides hold the other as
      // an accepted cross-island contact — that mutual state is the precondition
      // §5d call signalling checks and §5e profile refresh assumes.
      const acked = await sendContactAccept(identity!, r.host, r.uin)
      // §5e: they hold us from this moment, with whatever name their key-card
      // fetch caught. Give them the current one now — the alternative is that
      // they carry a stale name until the next time we happen to edit the
      // profile, which for most people is never. Fire-and-forget, and after the
      // accept so the ordering on their side is "accepted, then named".
      void pushProfileTo(identity!, r.host, r.uin)
      if (!acked) {
        // Accepted here regardless (the row + pinned keys are written), but say
        // so plainly rather than implying the other side knows.
        setError(t('ci.accept_undelivered'))
        return
      }
      navigate(`/chat/${r.uin}?i=${encodeURIComponent(r.host)}`)
    } catch {
      setError(t('pending.error'))
    } finally {
      setCiActing(null)
    }
  }

  /// §5f decline: drop the row here and tell them, so their pending row goes
  /// too instead of waiting forever. Offered only for an actual contact request
  /// — a quarantined MESSAGE has no request to answer, and replying to one would
  /// confirm to a stranger that their deposit landed in front of a human.
  async function declineCI(r: CrossIslandRequest) {
    const tag = `${r.uin}@${r.host}`
    setCiActing(tag)
    clearRequest(r.uin, r.host)
    setCi(listRequests())
    try {
      await sendContactDecline(identity!, r.host, r.uin)
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
    // A §5f cross-island request arrives as an ordinary sealed `message` push,
    // not as `contact_request` — the island cannot know what is inside it — and
    // the receive loop files it into a local store asynchronously (decrypt
    // first). So this list watches the STORE rather than the socket: hooking
    // the push directly would re-read before the decrypt that writes the row
    // has finished. Cheap enough: one localStorage read while the list is open.
    const poll = setInterval(() => setCi(listRequests()), 3000)
    return () => {
      off()
      clearInterval(poll)
    }
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
    <div className={embedded ? '' : 'min-h-screen bg-surface-dim'}>
      {!embedded && (
        <header className="rcq-header sticky top-0 z-10">
          <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
            <Link to="/contacts" className="text-fg-secondary hover:text-fg-primary px-2">
              ←
            </Link>
            <div className="font-semibold">{t('pending.title')}</div>
          </div>
        </header>
      )}

      <main className={embedded ? 'px-4 pb-4' : 'max-w-2xl mx-auto px-4 py-4'}>
        {ci.length > 0 && (
          <section className="mb-4">
            <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide mb-2">
              {t('ci.section')}
            </div>
            <ul className="bg-surface rounded-lg">
              {ci.map((r) => {
                const tag = `${r.uin}@${r.host}`
                const firstText = r.msgs.find((m) => m.kind === 'text') as { text?: string } | undefined
                // A §5f contact request says what it wants and who is asking;
                // a quarantined message row keeps showing its first message.
                const subtitle = r.contactReq
                  ? r.note || t('ci.wants_contact')
                  : firstText?.text || t('ci.wants', { n: r.msgs.length })
                return (
                  // ⚠ Stacked, not a single row. Three actions plus a name plus
                  // an island tag do not fit side by side: the buttons are
                  // `shrink-0` and take what they need, so the identity column
                  // collapsed to "my…", "83796…", "хочет …" — every field
                  // truncated to uselessness, which is exactly what a request
                  // screen must not do (founder screenshot). Who is asking gets
                  // the full width; the actions get their own line.
                  <li key={tag} className="p-4 space-y-3">
                    <div className="flex flex-col gap-3">
                      <div className="min-w-0">
                        {/* The island tag always stays visible: a self-asserted
                            name from another island must never be able to pass
                            as a local contact (§5e). */}
                        {r.nickname ? (
                          <>
                            <div className="font-medium break-words">{r.nickname}</div>
                            <div className="font-mono text-xs text-fg-dim break-all">{tag}</div>
                          </>
                        ) : (
                          <div className="font-mono text-sm break-all">{tag}</div>
                        )}
                        <div className="text-xs text-fg-dim break-words line-clamp-2">{subtitle}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => blockCI(r)}
                          className="flex-1 h-9 rounded-md bg-field text-sm font-medium hover:bg-line/50 transition-colors"
                        >
                          {t('ci.block')}
                        </button>
                        {r.contactReq && (
                          <button
                            onClick={() => void declineCI(r)}
                            disabled={ciActing === tag}
                            className="flex-1 h-9 rounded-md bg-field text-sm font-medium hover:bg-line/50 disabled:opacity-40 transition-colors"
                          >
                            {t('pending.decline')}
                          </button>
                        )}
                        <button
                          onClick={() => void acceptCI(r)}
                          disabled={ciActing === tag}
                          className="flex-1 h-9 rounded-md bg-accent hover:bg-accent-dim text-white text-sm font-semibold disabled:opacity-40 transition-colors"
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

        <ul className="bg-surface rounded-lg">
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
                    className="px-3 h-9 rounded-md bg-field text-sm font-medium hover:bg-line/50 disabled:opacity-40 transition-colors"
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

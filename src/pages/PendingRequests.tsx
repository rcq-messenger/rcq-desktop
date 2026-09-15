// Incoming contact requests. Lives behind a tab/badge from the
// Contacts header. Accept / decline triggers `/contacts/respond`;
// the backend pushes a `contact_response` to the proposer over
// WS so they don't have to refresh.

import { CenteredLoader } from '../components/Spinner'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Api, type PendingRequest } from '../lib/api'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import { useWS } from '../lib/ws'
import {
  listRequests,
  clearRequest,
  blockRequest,
  ensureRequestsLoaded,
  getRequest,
  noteAcceptUndelivered,
  onRequestsChanged,
  type CrossIslandRequest,
} from '../lib/crossisland-requests'
import { MAX_ACCEPT_TRIES } from '../lib/crossisland-pending'
import {
  declineServerRequest,
  pollVisitedPending,
  priorSigningKeys,
  sharedGroupsOn,
  withdrawServerRequest,
} from '../lib/crossisland-pending-poll'
import { getCrossIsland, saveCrossIsland } from '../lib/crossisland-store'
import { sameSigningKey } from '../lib/crossisland-gate'
import { sendRequestAck } from '../lib/crossisland-ack'
import { sendContactAccept, sendContactDecline } from '../lib/crossisland-contactreq'
import { pushProfileTo } from '../lib/crossisland-profile'
import { fetchPeerKeyCard } from '../lib/federation-send'
import { addIncoming, beginCatchUp, endCatchUp } from '../lib/incoming-store'
import { allowStranger } from '../lib/stranger-requests'

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
  /// The row whose card key differs from a key this device already saw for
  /// that person in a group on the same island: the accept waits for a second,
  /// deliberate tap (spec 2026-09-15, F1 prior-key check).
  const [keyConfirm, setKeyConfirm] = useState<string | null>(null)

  async function acceptCI(r: CrossIslandRequest, keyChangeConfirmed = false) {
    const tag = `${r.uin}@${r.host}`
    // A SAME-ISLAND stranger (host '' — the opt-in Privacy quarantine): no
    // key card to pin, no §5f dance. Accepting means "let this person talk":
    // remember the allowance, release what they already wrote, open the chat.
    if (r.host === '') {
      allowStranger(r.uin)
      void sendRequestAck(identity!, r.uin, '', 'accept')
      const held = clearRequest(r.uin, '')
      beginCatchUp()
      try {
        held?.msgs.forEach((m) => addIncoming(r.uin, m))
      } finally {
        endCatchUp()
      }
      setCi(listRequests())
      navigate(`/chat/${r.uin}`)
      return
    }
    setCiActing(tag)
    setError(null)
    try {
      const card = await fetchPeerKeyCard(r.host, r.uin)
      if (!card) throw new Error('card')
      // ⚠⚠ The address on these envelopes is unsigned (v=1), the key they were
      // sealed with is not. Accepting pins the key THAT ISLAND publishes for
      // the address and then replays the held messages into that person's
      // thread, so a sender whose key is not the published one would have
      // their words shown as someone else's. Refuse instead, and say why. A
      // genuine key rotation passes: the island publishes the new key, and it
      // is the one the envelopes carry.
      if ((r.spubs ?? []).some((k) => !sameSigningKey(k, card.signing_key))) {
        setError(t('ci.key_mismatch_refused'))
        return
      }
      // ⚠⚠ Keys are never re-pinned. An accept that is being retried (its
      // deposit did not go out) finds the contact already saved, and a card
      // that now says something else is refused, not written over it.
      const pinned = getCrossIsland(r.uin, r.host)
      if (pinned && !sameSigningKey(pinned.signingKey, card.signing_key)) {
        setError(t('ci.key_mismatch_refused'))
        return
      }
      // A row from the island's own list is vouched for by that island alone:
      // its operator writes both the row and the card. A key this device saw
      // the person use in a group there BEFORE is the one thing it cannot
      // rewrite after the fact, so a card that disagrees with it waits for a
      // person to confirm.
      if (r.server && !keyChangeConfirmed) {
        const prior = priorSigningKeys(identity!.uin, r.uin, r.host)
        if (prior.some((k) => !sameSigningKey(k, card.signing_key))) {
          setKeyConfirm(tag)
          return
        }
      }
      setKeyConfirm(null)
      if (!pinned) {
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
      }
      // A row that is only a §5f request or held messages goes now, as before.
      // A row from the island's list stays until our accept has actually
      // reached the requester: it is what the retry hangs on.
      const heldMsgs = r.server ? (getRequest(r.uin, r.host)?.msgs ?? []) : (clearRequest(r.uin, r.host)?.msgs ?? [])
      // Held messages are a backlog being released by an explicit accept, not
      // traffic arriving now: a banner per quarantined message would fire a
      // burst at the exact moment the user is looking at the request.
      beginCatchUp()
      try {
        heldMsgs.forEach((m) => addIncoming(r.uin, m)) // surface the held messages
      } finally {
        endCatchUp()
      }
      setCi(listRequests())
      // §5f symmetry: acceptance is only half-done on this device. Deposit an
      // `accept` back to the requester's island so BOTH sides hold the other as
      // an accepted cross-island contact — that mutual state is the precondition
      // §5d call signalling checks and §5e profile refresh assumes.
      // My OTHER devices hold their own copy of this request (the conveyor row
      // has no device id). Hand them the answer AND the card just pinned, so
      // the row disappears there instead of inviting a second accept that would
      // re-TOFU the peer and overwrite these very keys.
      const ackCard = {
        nick: card.nickname?.trim() || undefined,
        ik: card.identity_key,
        sk: card.signing_key,
        sik: card.signal_identity_key ?? null,
        gender: card.gender ?? null,
        status: card.status_message ?? null,
      }
      // ⚠⚠ Not yet for a row from an island's list. This device receives its
      // own carbon back, and applying it clears the row and marks the island
      // row answered: sent before the deposit lands, it wiped the very row a
      // failed accept is retried on, and the next poll withdrew the
      // requester's row with our accept never delivered. That ack goes out
      // below once the accept landed, or from the poll's redeposit.
      if (!r.server) void sendRequestAck(identity!, r.uin, r.host, 'accept', ackCard)
      const acked = await sendContactAccept(identity!, r.host, r.uin)
      // §5e: they hold us from this moment, with whatever name their key-card
      // fetch caught. Give them the current one now — the alternative is that
      // they carry a stale name until the next time we happen to edit the
      // profile, which for most people is never. Fire-and-forget, and after the
      // accept so the ordering on their side is "accepted, then named".
      void pushProfileTo(identity!, r.host, r.uin)
      if (r.server) {
        if (!acked) {
          // Kept, and the visited poll deposits it again (crossisland-pending).
          noteAcceptUndelivered(r.uin, r.host)
          setCi(listRequests())
          setError(t('ci.srv.retrying', { host: r.host }))
          return
        }
        clearRequest(r.uin, r.host)
        void sendRequestAck(identity!, r.uin, r.host, 'accept', ackCard, { host: r.host, id: r.server.id })
        // Clears the row on that island where it can; where it cannot, the row
        // is only hidden here, never declined in its place.
        void withdrawServerRequest(identity!, r.host, r.server.id, true)
        setCi(listRequests())
      }
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
  ///
  /// A row from an island's own list is declined THERE, with an honest
  /// `respond(false)`: the requester's app reads that answer from that island.
  /// The row leaves this list at once; if the island does not take the answer
  /// now, the visited poll sends the same decline again (never a withdraw),
  /// and my other devices hear of it only once it landed.
  async function declineCI(r: CrossIslandRequest) {
    const tag = `${r.uin}@${r.host}`
    setCiActing(tag)
    setKeyConfirm(null)
    setError(null)
    const srv = r.server && r.host !== '' ? { host: r.host, id: r.server.id } : undefined
    clearRequest(r.uin, r.host)
    if (!srv) void sendRequestAck(identity!, r.uin, r.host, 'decline')
    setCi(listRequests())
    // Same-island quarantined rows have no §5f request to answer — dropping
    // the row is the whole of it (and telling a stranger their message was
    // seen is exactly what the quarantine avoids).
    if (r.host === '') {
      setCiActing(null)
      return
    }
    try {
      const [landed] = await Promise.all([
        srv ? declineServerRequest(identity!, srv.host, srv.id, r.uin, true) : Promise.resolve('done' as const),
        r.contactReq ? sendContactDecline(identity!, r.host, r.uin) : Promise.resolve(true),
      ])
      if (landed !== 'done') setError(t('ci.srv.retrying', { host: r.host }))
    } catch {
      setError(t('pending.error'))
    } finally {
      setCiActing(null)
    }
  }

  function blockCI(r: CrossIslandRequest) {
    const srv = r.server && r.host !== '' ? { host: r.host, id: r.server.id } : undefined
    setKeyConfirm(null)
    blockRequest(r.uin, r.host)
    void sendRequestAck(identity!, r.uin, r.host, 'block', undefined, srv)
    // Cleared on the island where it can be; hidden here either way.
    if (srv) void withdrawServerRequest(identity!, srv.host, srv.id, true)
    setCi(listRequests())
  }

  async function refresh() {
    if (!identity) return
    setError(null)
    setLoading(true)
    // The requests addressed to our guest copies on other islands too. Not
    // awaited: the store notifies the list when rows land, and the schedule
    // lets this through at most once a minute per island.
    void pollVisitedPending(identity, { force: true })
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
    // The store is sealed at rest, so it opens asynchronously: read it once it
    // is up rather than showing an empty list for the first three seconds.
    const offStore = onRequestsChanged(() => setCi(listRequests()))
    void ensureRequestsLoaded().then(() => setCi(listRequests()))
    return () => {
      off()
      offStore()
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
                // host '' = a same-island stranger from the Privacy quarantine:
                // render a plain #uin, not a dangling "@".
                const tag = r.host === '' ? `${r.uin}` : `${r.uin}@${r.host}`
                const firstText = r.msgs.find((m) => m.kind === 'text') as { text?: string } | undefined
                const fromIsland = !!r.server && r.host !== ''
                // A §5f contact request says what it wants and who is asking;
                // a request from the island's own list says where it was made;
                // a quarantined message row keeps showing its first message.
                const subtitle = r.contactReq
                  ? r.note || t('ci.wants_contact')
                  : fromIsland
                    ? t('ci.srv.subtitle', { host: r.host })
                    : firstText?.text || t('ci.wants', { n: r.msgs.length })
                // Read from what this device already holds, no fetch: the
                // roster snapshot of our rooms on that island.
                const shared = fromIsland ? sharedGroupsOn(identity.uin, r.uin, r.host) : null
                const tries = r.srvAcceptTries ?? 0
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
                            <div className="text-xs text-fg-dim break-all">{tag}</div>
                          </>
                        ) : (
                          <div className="text-sm break-all">{tag}</div>
                        )}
                        <div className="text-xs text-fg-dim break-words line-clamp-2">{subtitle}</div>
                        {shared && shared.names.length > 0 && (
                          <div className="text-xs text-fg-dim break-words">
                            {shared.names.length === 1
                              ? t('ci.srv.via_group', { name: shared.names[0] })
                              : t('ci.srv.via_groups', { name: shared.names[0], n: shared.names.length - 1 })}
                          </div>
                        )}
                        {shared && shared.names.length === 0 && shared.rosterKnown && (
                          <div className="text-xs text-fg-dim break-words">{t('ci.srv.no_group')}</div>
                        )}
                        {/* We hold a contact at this address and these were
                            sealed under another key. Said out loud: the row
                            looks like the contact, and must not pass as them. */}
                        {r.keyMismatch && (
                          <div className="mt-1 text-xs text-amber-600 break-words">{t('ci.key_mismatch')}</div>
                        )}
                        {fromIsland && tries > 0 && (
                          <div className="mt-1 text-xs text-amber-600 break-words">
                            {tries >= MAX_ACCEPT_TRIES
                              ? t('ci.srv.gave_up', { host: r.host })
                              : t('ci.srv.retrying', { host: r.host })}
                          </div>
                        )}
                        {/* Who vouches for this person, said before the tap
                            that discloses our home number. */}
                        {fromIsland && tries === 0 && (
                          <div className="mt-1 text-xs text-fg-secondary break-words">
                            {t('ci.srv.accept_hint', { host: r.host })}
                          </div>
                        )}
                        {keyConfirm === tag && (
                          <div className="mt-1 text-xs text-amber-600 break-words">
                            {t('ci.srv.key_differs', { host: r.host })}
                          </div>
                        )}
                      </div>
                      {keyConfirm === tag ? (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setKeyConfirm(null)}
                            className="flex-1 h-9 rounded-md bg-field text-sm font-medium hover:bg-line/50 transition-colors"
                          >
                            {t('common.cancel')}
                          </button>
                          <button
                            onClick={() => void acceptCI(r, true)}
                            disabled={ciActing === tag}
                            className="flex-1 h-9 rounded-md bg-accent hover:bg-accent-dim text-white text-sm font-semibold disabled:opacity-40 transition-colors"
                          >
                            {t('pending.accept')}
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => blockCI(r)}
                            className="flex-1 h-9 rounded-md bg-field text-sm font-medium hover:bg-line/50 transition-colors"
                          >
                            {t('ci.block')}
                          </button>
                          {(r.contactReq || fromIsland) && (
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
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {loading && requests.length === 0 && (
          <CenteredLoader />
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
                    {r.nickname || `${r.from_uin}`}
                  </div>
                  <div className="text-xs text-fg-dim">{r.from_uin}</div>
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

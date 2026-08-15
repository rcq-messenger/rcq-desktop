// Find users + send contact request. Hits `/users/search` with a
// debounced query — backend matches against nickname / first / last
// / city / country / interests / UIN (numeric). Sending fires
// `/contacts/request`; the WS push to the recipient is the
// backend's job.

import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Api, type UserInfo } from '../lib/api'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import { parseAddress } from '../lib/federation'
import { resolvePeerHomes } from '../lib/federation-resolve'
import { fetchPeerKeyCard } from '../lib/federation-send'
import { saveCrossIsland } from '../lib/crossisland-store'
import { sendContactRequest } from '../lib/crossisland-contactreq'

/// [embedded] drops the page chrome so the same body can live inside a modal.
/// The founder's rule for the desktop: fewer full-page detours, more windows
/// over the list you were already looking at.
export function AddContact({ embedded = false }: { embedded?: boolean } = {}) {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<UserInfo[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /// Recipient UINs we've already requested in this session — drives
  /// the "Requested" pill in place of the Add button so a double-tap
  /// doesn't re-send.
  const [requested, setRequested] = useState<Set<number>>(new Set())
  const [ciBusy, setCiBusy] = useState(false)

  // Federation (F2): if the query is an explicit `uin@host` whose host is NOT
  // our OWN island, offer to add it as a local cross-island contact. Compared
  // to our own island, not the flagship: a self-hoster on is2 adding
  // `911@api.rcq.app` must see the flagship as cross-island. Requires an
  // explicit `@` so a bare UIN stays a normal local search.
  const crossIsland = useMemo(() => {
    if (!query.includes('@') || !identity) return null
    try {
      const a = parseAddress(query.trim())
      return a.host !== new URL(identity.apiBase).host ? a : null
    } catch {
      return null
    }
  }, [query, identity])

  if (!identity) {
    navigate('/', { replace: true })
    return null
  }

  async function addCrossIsland() {
    if (!crossIsland) return
    setCiBusy(true)
    setError(null)
    try {
      const card = await fetchPeerKeyCard(crossIsland.host, crossIsland.uin)
      if (!card) throw new Error(`No user ${crossIsland.uin} on ${crossIsland.host}`)
      // Best-effort: confirm their island routing record verifies (not fatal).
      const resolved = await resolvePeerHomes(crossIsland.host, crossIsland.uin)
      saveCrossIsland({
        uin: crossIsland.uin,
        host: crossIsland.host,
        nickname: card.nickname?.trim() || `${crossIsland.uin}@${crossIsland.host}`,
        identityKey: card.identity_key,
        signingKey: card.signing_key,
        signalIdentityKey: card.signal_identity_key ?? null,
        addedAt: Date.now(),
        gender: card.gender ?? null,
        statusMessage: card.status_message ?? null,
      })
      void resolved // verified flag available for future UX
      // §5f: the local row above is only OUR half. Tell the peer, by depositing
      // a sealed `contactreq` to their primary island — without this the add is
      // silent, they never see a request, and a cross-island call to them is
      // gated on a mutual state that can never be reached.
      // ⚠ The local row is written first and left alone on failure: it holds the
      // keys pinned from their card, and a network hiccup must not discard them.
      const sent = await sendContactRequest(identity!, crossIsland.host, crossIsland.uin)
      if (!sent) {
        // Do not claim a request was sent when only a local row exists — that
        // false claim is what turned this design gap into a bug report.
        setError(t('add.ci.undelivered'))
        return
      }
      navigate(`/chat/${crossIsland.uin}?i=${encodeURIComponent(crossIsland.host)}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('add.error'))
    } finally {
      setCiBusy(false)
    }
  }

  // Debounced search — fires 300ms after the user stops typing.
  useEffect(() => {
    if (!query.trim() || crossIsland) {
      setResults([])
      return
    }
    const handle = setTimeout(async () => {
      setSearching(true)
      setError(null)
      try {
        const list = await Api.searchUsers(identity!, query.trim())
        setResults(list)
      } catch (e) {
        setError(e instanceof Error ? e.message : t('add.error'))
      } finally {
        setSearching(false)
      }
    }, 300)
    return () => clearTimeout(handle)
  }, [query, identity, t, crossIsland])

  async function add(u: UserInfo) {
    try {
      await Api.sendContactRequest(identity!, u.uin)
      setRequested((s) => new Set(s).add(u.uin))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('add.error'))
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
            <div className="font-semibold">{t('add.title')}</div>
          </div>
        </header>
      )}

      <main className={embedded ? 'px-4 pb-4 space-y-4' : 'max-w-2xl mx-auto px-4 py-4 space-y-4'}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('add.placeholder')}
          className="w-full h-11 px-3 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
        />

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-600">
            {error}
          </div>
        )}

        {crossIsland && (
          <div className="bg-surface rounded-lg p-4 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{crossIsland.uin}<span className="text-fg-dim">@{crossIsland.host}</span></div>
              <div className="text-xs text-fg-dim">Cross-island contact (another RCQ island)</div>
            </div>
            <button
              onClick={() => void addCrossIsland()}
              disabled={ciBusy}
              className="px-3 h-9 rounded-md bg-accent hover:bg-accent-dim text-white text-sm font-semibold transition-colors disabled:opacity-50"
            >
              {ciBusy ? '…' : t('add.cta')}
            </button>
          </div>
        )}

        {!query.trim() && (
          <div className="text-center text-sm text-fg-secondary py-12">
            {t('add.hint')}
          </div>
        )}

        {searching && (
          <div className="text-center text-sm text-fg-secondary py-4">
            {t('contacts.loading')}
          </div>
        )}

        {!searching && query.trim() && !crossIsland && results.length === 0 && !error && (
          <div className="text-center text-sm text-fg-secondary py-12">
            {t('add.no_match')}
          </div>
        )}

        <ul className="bg-surface rounded-lg">
          {results.map((u) => (
            <li key={u.uin} className="p-4 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{u.nickname || `#${u.uin}`}</div>
                <div className="font-mono text-xs text-fg-dim">#{u.uin}</div>
                {u.city && (
                  <div className="text-xs text-fg-dim truncate">{u.city}{u.country ? `, ${u.country}` : ''}</div>
                )}
              </div>
              {requested.has(u.uin) ? (
                <span className="text-xs text-fg-dim px-3 py-1.5">{t('add.requested')}</span>
              ) : (
                <button
                  onClick={() => void add(u)}
                  className="px-3 h-9 rounded-md bg-accent hover:bg-accent-dim text-white text-sm font-semibold transition-colors"
                >
                  {t('add.cta')}
                </button>
              )}
            </li>
          ))}
        </ul>
      </main>
    </div>
  )
}

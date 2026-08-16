// "What is in this browser" — the storage inventory, shown to its owner.
//
// ⚠ This screen exists because of an asymmetry we were on the wrong side of.
// We ask people to trust a client they cannot inspect: the phone at least has
// a PIN and an encrypted database, while a browser tab holds keys, history and
// other people's words in storage that anyone with the unlocked machine can
// read. The honest answer is not to pretend otherwise — it is to show the list
// and hand over the switch.
//
// Measured, not described: every number here is read out of this browser at
// render time. A screen that listed what we THINK is stored would go stale the
// first time somebody added a key, and then it would be worse than nothing.
//
// The companion document is docs/web-storage-inventory.md, which carries the
// threat model this screen is the user-facing half of.

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import { forgetRecoverySeed, hasStoredRecoverySeed, hasStoredToken } from '../lib/auth'
import { sealingAvailable } from '../lib/local-seal'
import { vaultState, vaultSupported } from '../lib/desktop-vault'
import { ensureRequestsLoaded, requestCount } from '../lib/crossisland-requests'
import { useToast } from '../lib/toast'

/// Which of the four groups a localStorage key belongs to. Deliberately a
/// function of the key NAME, so a key added by somebody else's feature still
/// lands somewhere sensible instead of vanishing from the list.
function groupOf(key: string): 'account' | 'messages' | 'lists' | 'settings' {
  const k = key.toLowerCase()
  if (k.includes('identity.v1') || k.includes('accounts.v1') || k.includes('multihome') ||
      k.includes('visited.v1') || k.includes('revoked.v1')) return 'account'
  if (k.includes('outgoing.') || k.includes('unread')) return 'messages'
  if (k.includes('theme') || k.includes('fontscale') || k.includes('language') ||
      k.includes('sounds') || k.includes('privacy') || k.includes('install.id') ||
      k.includes('scoped.v') || k.includes('collapsed') || k.includes('alwaysrelay')) return 'settings'
  return 'lists'
}

interface Measured {
  bytes: Record<'account' | 'messages' | 'lists' | 'settings', number>
  counts: Record<'account' | 'messages' | 'lists' | 'settings', number>
  idbBytes: number | null
}

function measure(): Omit<Measured, 'idbBytes'> {
  const bytes = { account: 0, messages: 0, lists: 0, settings: 0 }
  const counts = { account: 0, messages: 0, lists: 0, settings: 0 }
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (!k || !(k.startsWith('rcq.') || k.startsWith('rcq-'))) continue
    const g = groupOf(k)
    bytes[g] += (localStorage.getItem(k) || '').length + k.length
    counts[g] += 1
  }
  return { bytes, counts }
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function BrowserStorage() {
  const { t } = useI18n()
  const { identity, signOut } = useIdentity()
  const { toast } = useToast()
  const [version, setVersion] = useState(0)
  const [idbBytes, setIdbBytes] = useState<number | null>(null)
  const [sealed, setSealed] = useState<boolean | null>(null)
  /// Desktop only: is the account behind a PIN on this machine? Null in a
  /// browser, where the row is not drawn at all rather than drawn as "off" —
  /// there is no PIN to switch on here, and offering one would be a lie.
  const [pinOn, setPinOn] = useState<boolean | null>(null)
  const [requests, setRequests] = useState(0)
  const [confirmForget, setConfirmForget] = useState(false)
  const [confirmWipe, setConfirmWipe] = useState(false)

  const { bytes, counts } = measure()
  const hasSeed = hasStoredRecoverySeed()
  const keepsToken = identity ? hasStoredToken(identity.uin) : false

  useEffect(() => {
    // The browser will only estimate the whole origin, so this is history +
    // device keys + anything else in IndexedDB, and it is labelled as such.
    void navigator.storage?.estimate?.().then((e) => setIdbBytes(e.usage ?? null)).catch(() => {})
    void sealingAvailable().then(setSealed)
    if (vaultSupported()) void vaultState().then((v) => setPinOn(v.exists))
    void ensureRequestsLoaded().then(() => setRequests(requestCount()))
  }, [version])

  return (
    <div className="min-h-screen bg-surface-dim">
      <header className="rcq-header sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link to="/settings" className="text-fg-secondary hover:text-fg-primary px-2">
            ←
          </Link>
          <div className="font-semibold">{t('storage.title')}</div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-4 space-y-3">
        <p className="text-sm text-fg-secondary leading-relaxed whitespace-pre-line px-1">
          {t('storage.intro')}
        </p>

        {/* 1. The account itself. */}
        <section className="bg-surface rounded-lg p-4 space-y-3">
          <Head title={t('storage.account.title')} size={human(bytes.account)} n={counts.account} t={t} />
          <p className="text-sm text-fg-secondary leading-relaxed">{t('storage.account.body')}</p>

          <Fact
            label={t('storage.phrase.label')}
            value={hasSeed ? t('storage.phrase.kept') : t('storage.phrase.gone')}
            warn={hasSeed}
          />
          {pinOn !== null && (
            <Fact
              label={t('storage.pin.label')}
              value={pinOn ? t('storage.pin.on') : t('storage.pin.off')}
              warn={!pinOn}
            />
          )}
          <Fact
            label={t('storage.token.label')}
            value={keepsToken ? t('storage.token.kept') : t('storage.token.none')}
            warn={keepsToken}
          />

          {hasSeed && !confirmForget && (
            <button
              onClick={() => setConfirmForget(true)}
              className="w-full h-9 rounded-md text-sm font-medium text-red-600 hover:bg-red-500/10 transition-colors"
            >
              {t('settings.recovery.forget')}
            </button>
          )}
          {hasSeed && confirmForget && (
            <div className="space-y-2 rounded-md bg-surface-dim p-3">
              <p className="text-xs text-fg-secondary leading-relaxed">
                {t('settings.recovery.forget.warn')}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmForget(false)}
                  className="flex-1 h-9 rounded-md bg-field text-sm font-medium hover:bg-line/40 transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={() => {
                    forgetRecoverySeed()
                    setConfirmForget(false)
                    setVersion((v) => v + 1)
                    toast(t('settings.recovery.forgotten'))
                  }}
                  className="flex-1 h-9 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-semibold transition-colors"
                >
                  {t('settings.recovery.forget.confirm')}
                </button>
              </div>
            </div>
          )}
        </section>

        {/* 2. Conversations. */}
        <section className="bg-surface rounded-lg p-4 space-y-3">
          <Head title={t('storage.messages.title')} size={human(bytes.messages)} n={counts.messages} t={t} />
          <p className="text-sm text-fg-secondary leading-relaxed">{t('storage.messages.body')}</p>
          {idbBytes != null && (
            <Fact label={t('storage.idb.label')} value={human(idbBytes)} />
          )}
        </section>

        {/* 3. Lists — contacts, requests, counters. */}
        <section className="bg-surface rounded-lg p-4 space-y-3">
          <Head title={t('storage.lists.title')} size={human(bytes.lists)} n={counts.lists} t={t} />
          <p className="text-sm text-fg-secondary leading-relaxed">{t('storage.lists.body')}</p>
          <Fact
            label={t('storage.requests.label')}
            value={
              sealed === null
                ? '…'
                : sealed
                  ? t('storage.requests.sealed', { n: String(requests) })
                  : t('storage.requests.plain', { n: String(requests) })
            }
            warn={sealed === false}
          />
        </section>

        {/* 4. Preferences. */}
        <section className="bg-surface rounded-lg p-4 space-y-2">
          <Head title={t('storage.settings.title')} size={human(bytes.settings)} n={counts.settings} t={t} />
          <p className="text-sm text-fg-secondary leading-relaxed">{t('storage.settings.body')}</p>
        </section>

        {/* What this screen does NOT claim. Same words as the doc and as any
            public text about it — a browser cannot hide anything from code
            running in its own page. */}
        <section className="bg-surface rounded-lg p-4 space-y-2">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('storage.limits.title')}
          </div>
          <p className="text-sm text-fg-secondary leading-relaxed whitespace-pre-line">
            {t('storage.limits.body')}
          </p>
        </section>

        {/* The switch. */}
        <section className="bg-surface rounded-lg p-4 space-y-2">
          {!confirmWipe ? (
            <button
              onClick={() => setConfirmWipe(true)}
              className="w-full h-10 rounded-md text-sm font-semibold text-red-600 hover:bg-red-500/10 transition-colors"
            >
              {t('storage.wipe')}
            </button>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-fg-secondary leading-relaxed">{t('storage.wipe.warn')}</p>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmWipe(false)}
                  className="flex-1 h-9 rounded-md bg-field text-sm font-medium hover:bg-line/40 transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={signOut}
                  className="flex-1 h-9 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-semibold transition-colors"
                >
                  {t('storage.wipe.confirm')}
                </button>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

function Head({
  title,
  size,
  n,
  t,
}: {
  title: string
  size: string
  n: number
  t: (k: string, p?: Record<string, string | number>) => string
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      <span className="text-xs text-fg-dim shrink-0">{t('storage.size', { size, n: String(n) })}</span>
    </div>
  )
}

/// Label left, value right — but wrapping as WHOLE lines. On a phone a value
/// like "not stored, asked for at start-up" is wider than the column, and
/// letting the label wrap instead left it reading as two broken columns.
function Fact({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
      <span className="text-fg-secondary whitespace-nowrap">{label}</span>
      <span
        className={`ml-auto text-right ${warn ? 'text-amber-600 dark:text-amber-500' : 'text-fg-primary'}`}
      >
        {value}
      </span>
    </div>
  )
}

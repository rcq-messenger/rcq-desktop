// What a person sees of island trust (docs/island-fingerprint-design.md §5).
//
// Two surfaces in one file because they read the same store: the banner and
// the first-use notice at the top of every screen, and the row in Settings
// that says how the island is trusted. Both draw from the snapshot that
// lib/island-trust.ts keeps; nothing else in the app has to remember to check.

import { useEffect, useState, useSyncExternalStore } from 'react'
import { useI18n } from '../lib/i18n-context'
import { useToast } from '../lib/toast'
import { isTauri } from '../lib/desktop'
import { displayFingerprint, splitHostPort } from '../lib/island-choice'
import {
  acceptIslandFingerprint,
  dismissFirstUse,
  islandAuthority,
  islandTrustSnapshot,
  islandTrustStatus,
  subscribeIslandTrust,
  type ChangedIsland,
  type FirstUseIsland,
  type TrustStatus,
} from '../lib/island-trust'

/// Stands in for `{fp}` in a translated sentence so the fingerprint can be
/// drawn as a block where the words put it. Plain ASCII on purpose: `t()`
/// substitutes once, so the brackets cannot be mistaken for a second key.
const FP_MARK = '[[fp]]'

function useTrustSnapshot() {
  return useSyncExternalStore(subscribeIslandTrust, islandTrustSnapshot, islandTrustSnapshot)
}

/// A sentence with `{fp}` in it, drawn with the fingerprint as its own
/// monospace block: sixty-four hex characters in the middle of a line are
/// not something anyone compares by eye.
function SentenceWithFingerprint({ text, fingerprint }: { text: string; fingerprint: string }) {
  const [before, after] = text.split(FP_MARK)
  return (
    <>
      <span>{before}</span>
      <pre className="font-mono text-[0.75rem] leading-snug whitespace-pre my-1.5">{displayFingerprint(fingerprint)}</pre>
      {after && <span>{after}</span>}
    </>
  )
}

/// The sentence for a refusal: the record on file was typed by the person,
/// the NEW value was typed by the person (§3's conflict), or neither.
function changedKey(island: ChangedIsland): string {
  if (island.entered) return 'island.trust.entered'
  return island.typed ? 'island.trust.changed_typed' : 'island.trust.changed'
}

/// §5.2: a changed certificate. Red, at the top, above everything but a
/// modal, and it stays until the person decides. "Not now" folds it to a
/// line rather than removing it: the island is still refused, and a banner
/// that vanished would leave the app silently offline for that island.
function ChangedBanner({ island }: { island: ChangedIsland }) {
  const { t } = useI18n()
  const [folded, setFolded] = useState(false)
  const [busy, setBusy] = useState(false)

  async function accept() {
    setBusy(true)
    // What gets written is the Rust side's call from the refusal it answers:
    // a CA-valid chain over a typed pin records `ca`, a typed value stays
    // typed, anything else is `accepted`.
    const ok = await acceptIslandFingerprint(island.host, island.port, island.new)
    if (!ok) {
      setBusy(false)
      return
    }
    // Reconnect. The simplest correct way on the desktop is a reload: the
    // socket loop, the drains, the token mint and every cached failure are
    // rebuilt from scratch against the new record, and the PIN vault stays
    // unlocked across a reload inside a session (vault_read), so nobody is
    // asked to type anything. Teaching each of those layers to reconnect on
    // its own would be a second copy of their startup, kept in step by hand.
    window.location.reload()
  }

  if (folded) {
    return (
      <button
        type="button"
        onClick={() => setFolded(false)}
        className="pointer-events-auto w-full bg-red-600 text-white text-xs px-4 py-1.5 text-left truncate"
      >
        {t(changedKey(island), { host: island.authority })}
      </button>
    )
  }

  return (
    <div className="pointer-events-auto bg-red-600 text-white px-4 py-3 text-xs shadow-lg">
      <div className="max-w-2xl mx-auto space-y-2">
        <p className="leading-relaxed">{t(changedKey(island), { host: island.authority })}</p>
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 items-start">
          <span className="text-white/80 pt-px">{t('island.trust.on_file')}</span>
          {island.old === 'ca' ? (
            <span>{t('island.trust.via_ca')}</span>
          ) : (
            <pre className="font-mono text-[0.75rem] leading-snug whitespace-pre">{displayFingerprint(island.old)}</pre>
          )}
          {/* ⚠ Not "presented" when the person typed it. §3's refusal is
              raised by prePinIsland with no handshake at all - the island was
              never dialled - so labelling their own keystrokes as what the
              island showed would assert a connection that did not happen. */}
          <span className="text-white/80 pt-px">
            {t(island.entered ? 'island.trust.entered_label' : 'island.trust.presented')}
          </span>
          <pre className="font-mono text-[0.75rem] leading-snug whitespace-pre">{displayFingerprint(island.new)}</pre>
        </div>
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={() => void accept()}
            disabled={busy}
            className="h-8 px-3 rounded-md bg-white text-red-700 font-semibold disabled:opacity-60"
          >
            {t('island.trust.accept')}
          </button>
          <button
            type="button"
            onClick={() => setFolded(true)}
            disabled={busy}
            className="h-8 px-3 rounded-md bg-white/15 hover:bg-white/25 text-white font-medium"
          >
            {t('island.trust.later')}
          </button>
        </div>
      </div>
    </div>
  )
}

/// §5.1: the first connection to an island. One notice, dismissible, not a
/// modal: onboarding must not stop on a dialog most people cannot evaluate,
/// and the careful person typed the fingerprint with the address instead.
function FirstUseNotice({ island }: { island: FirstUseIsland }) {
  const { t } = useI18n()
  return (
    <div className="pointer-events-auto bg-surface text-fg-primary border-b border-line/60 px-4 py-2.5 text-xs shadow-md">
      <div className="max-w-2xl mx-auto flex items-start gap-3">
        <div className="min-w-0 flex-1 leading-relaxed">
          <SentenceWithFingerprint
            text={t('island.trust.first_use', { host: island.authority, fp: FP_MARK })}
            fingerprint={island.fingerprint}
          />
        </div>
        <button
          type="button"
          onClick={() => dismissFirstUse(island.authority)}
          className="flex-none text-fg-dim hover:text-fg-primary px-1 -mr-1"
          aria-label={t('common.close')}
        >
          ×
        </button>
      </div>
    </div>
  )
}

/// Mounted once above every route, the login screen included: a typed
/// fingerprint is refused before there is an account. Draws nothing until
/// the trust layer has something to say, which off the desktop is never.
export function IslandTrustBanner() {
  const snap = useTrustSnapshot()
  const changed = Object.values(snap.changed)
  const firstUse = Object.values(snap.firstUse)
  if (changed.length === 0 && firstUse.length === 0) return null
  return (
    <div className="fixed inset-x-0 top-0 z-[55] flex flex-col pointer-events-none">
      {changed.map((c) => (
        <ChangedBanner key={c.authority} island={c} />
      ))}
      {firstUse.map((f) => (
        <FirstUseNotice key={f.authority} island={f} />
      ))}
    </div>
  )
}

/// §5.3: how this island is trusted, in Settings. On the desktop the answer
/// comes from the store; in a browser, and for an island the desktop has
/// never had to judge (the webview verified it itself), the honest answer is
/// the certificate authority.
export function IslandTrustRow({ apiBase }: { apiBase: string | undefined }) {
  const { t } = useI18n()
  const { toast } = useToast()
  const snap = useTrustSnapshot()
  const [status, setStatus] = useState<TrustStatus | null>(null)

  useEffect(() => {
    if (!apiBase || !isTauri()) {
      setStatus(null)
      return
    }
    let live = true
    let target: { host: string; port: number }
    try {
      target = splitHostPort(apiBase)
    } catch {
      return
    }
    void islandTrustStatus(target.host, target.port).then((s) => {
      if (live) setStatus(s)
    })
    return () => {
      live = false
    }
    // Re-read after an accept or a first use: both change the record.
  }, [apiBase, snap])

  if (!apiBase) return null
  const pinned = status?.mode === 'pinned' && status.fingerprint
  if (!pinned) {
    return <div className="text-xs text-fg-secondary">{t('island.trust.settings.ca')}</div>
  }
  const fp = status.fingerprint!
  const { host, port } = splitHostPort(apiBase)
  // `host[:port]#fp`: what install.sh prints and what the address forms take,
  // ready to hand to somebody.
  const address = `${islandAuthority(host, port)}#${fp}`
  return (
    <div className="space-y-1.5">
      <div className="text-xs text-fg-secondary">{t('island.trust.settings.pinned')}</div>
      <pre className="font-mono text-[0.75rem] leading-snug whitespace-pre text-fg-primary">{displayFingerprint(fp)}</pre>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(address)
            .then(() => toast(t('chat.copied')))
            .catch(() => {})
        }}
        className="text-xs text-accent hover:opacity-80"
      >
        {t('island.trust.copy')}
      </button>
    </div>
  )
}

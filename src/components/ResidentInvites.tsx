import { useEffect, useState } from 'react'
import { Api } from '../lib/api'
import type { WebIdentity } from '../lib/crypto'
import { useI18n } from '../lib/i18n-context'

/// The invites a paying resident may hand out, on the island screen.
///
/// ⚠ DRAWS NOTHING for anybody who is not eligible, and that is deliberate.
/// Only somebody who paid has invites; showing everybody else a counter that
/// reads zero would put a question on screen ("why do I have none") that this
/// row is the wrong place to answer, and it would look like something was
/// taken away from them.
///
/// ⚠ The island answers with the arithmetic already done — granted, used,
/// remaining, and when the next one lands. Nothing here recomputes it from a
/// date: the accrual rule lives on the island so that changing it does not
/// need four client releases, and a client that did its own sum would disagree
/// with the server the moment an operator changed the period.
export function ResidentInvites({ identity }: { identity: WebIdentity | null }) {
  const { t } = useI18n()
  const [state, setState] = useState<Awaited<ReturnType<typeof Api.myInvites>> | null>(null)
  const [minted, setMinted] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!identity) return
    let alive = true
    void (async () => {
      try {
        const r = await Api.myInvites(identity)
        if (alive) setState(r)
      } catch {
        /* an island that predates the feature answers 404; draw nothing */
      }
    })()
    return () => {
      alive = false
    }
  }, [identity?.uin, identity?.apiBase])

  if (!state || !state.enabled || !state.eligible) return null

  const nextLine = state.next_at
    ? t('invites.next', { date: new Date(state.next_at).toLocaleDateString() })
    : t('invites.all')

  async function mint() {
    if (!identity) return
    setBusy(true)
    try {
      const r = await Api.mintInvite(identity)
      setMinted(r.link)
      setState(await Api.myInvites(identity))
    } catch {
      /* the button re-enables; the island already refused for a stated reason */
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">{t('invites.title')}</span>
        <span className="text-sm text-fg-secondary">
          {state.remaining}/{state.total}
        </span>
      </div>
      <p className="text-xs text-fg-dim leading-relaxed">{nextLine}</p>
      {state.remaining > 0 && (
        <button
          onClick={mint}
          disabled={busy}
          className="text-xs text-accent hover:underline disabled:opacity-60"
        >
          {busy ? t('invites.minting') : t('invites.mint')}
        </button>
      )}
      {minted && (
        <div className="space-y-1.5">
          {/* ⚠ Shown ONCE. The island keeps only the hash, so a person who
              closes this without copying has spent an invite on nothing. The
              copy button is the point of the block, not decoration. */}
          <div className="break-all rounded-md bg-field p-2.5 font-mono text-[0.6875rem] leading-relaxed">
            {minted}
          </div>
          <button
            onClick={() => {
              navigator.clipboard?.writeText(minted)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
            className="text-xs text-accent hover:underline"
          >
            {copied ? t('invites.copied') : t('invites.copy')}
          </button>
          <p className="text-xs text-fg-dim leading-relaxed">{t('invites.once')}</p>
        </div>
      )}
    </div>
  )
}

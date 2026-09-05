import { useState } from 'react'
import { Api } from '../lib/api'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import { useToast } from '../lib/toast'

/// One report affordance for every surface that shows other people's things:
/// a profile, a room, a site (founder, 05.09). `targetUin` is 0 when there is
/// nobody to name (a site with no published owner); `context` tells the
/// operator where it happened.
export function ReportButton({ targetUin, context, label, className = '' }: {
  targetUin: number
  context: string
  label: string
  className?: string
}) {
  const { t } = useI18n()
  const { identity } = useIdentity()
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const send = async () => {
    if (!identity || busy || !reason.trim()) return
    setBusy(true)
    try {
      await Api.reportAbuse(identity, targetUin, reason.trim(), context)
      toast(t('report.sent'))
      setOpen(false)
      setReason('')
    } catch {
      toast(t('report.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className || 'text-xs text-fg-dim hover:text-red-500 transition-colors'}>
        {t('report.cta')}
      </button>
      {open && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={() => setOpen(false)}>
          <div className="w-full max-w-sm rounded-2xl bg-surface p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-semibold text-fg-primary">{t('report.title').replace('{name}', label)}</div>
            <p className="text-xs text-fg-dim">{t('report.body')}</p>
            <textarea
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('report.placeholder')}
              className="w-full h-24 rounded-md bg-field p-2 text-sm text-fg-primary outline-none"
            />
            <div className="flex justify-end gap-2">
              <button type="button" className="px-3 h-9 rounded-md text-sm text-fg-secondary hover:bg-field" onClick={() => setOpen(false)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                disabled={busy || !reason.trim()}
                className="px-3 h-9 rounded-md bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-sm font-semibold"
                onClick={() => void send()}
              >
                {t('report.send')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

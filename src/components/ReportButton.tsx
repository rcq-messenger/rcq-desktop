import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { WebIdentity } from '../lib/crypto'
import { Api } from '../lib/api'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import { useToast } from '../lib/toast'

/// One report affordance for every surface that shows other people's things:
/// a profile, a room, a site (founder, 05.09). `targetUin` is 0 when there is
/// nobody to name (a site with no published owner); `context` tells the
/// operator where it happened.
export function ReportButton({ targetUin, context, label, className = '', glyph = false, ident }: {
  targetUin: number
  context: string
  label: string
  className?: string
  /// A flag icon instead of the word, for trays sized for glyphs.
  glyph?: boolean
  /// The identity to file under. Cross-island things belong to THEIR island:
  /// a foreign profile reported to the home island names whoever wears the
  /// same digits there. Defaults to the signed-in identity.
  ident?: WebIdentity | null
}) {
  const { t } = useI18n()
  const { identity: own } = useIdentity()
  const identity = ident ?? own
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
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen(true)
        }}
        className={className || (glyph ? 'flex-none p-1 text-fg-dim hover:text-red-500 transition-colors' : 'text-xs text-fg-dim hover:text-red-500 transition-colors')}
        title={glyph ? t('report.cta') : undefined}
        aria-label={glyph ? t('report.cta') : undefined}
      >
        {glyph ? <FlagGlyph size={15} /> : t('report.cta')}
      </button>
      {/* Portalled: rendered in place this sat inside headers with a
          backdrop-filter, which turns `fixed` into "fixed to the header", and
          the dialog was confined to a 56px strip. Backdrop clicks stop here so
          the row behind the button does not fire. */}
      {open && createPortal(
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
          style={{ animation: 'rcq-fade-in 160ms ease-out' }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            setOpen(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false)
          }}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-surface p-5 space-y-3"
            style={{ animation: 'rcq-pop-in 180ms cubic-bezier(0.2, 0.8, 0.2, 1)' }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-semibold text-fg-primary">{t('report.title', { name: label })}</div>
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
        </div>,
        document.body,
      )}
    </>
  )
}

function FlagGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 22V4" />
      <path d="M4 4h11l-1 4h6l-2 6h-6l1-4H4" />
    </svg>
  )
}

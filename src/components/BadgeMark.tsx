import { useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../lib/i18n-context'

/// The island's mark beside a name: a small seal whose colour says which
/// kind of mark it is. The kinds are strings the island chooses; the ones
/// this client knows get their colour, anything newer is drawn neutral so a
/// kind added on the island before the client learned it is still a mark
/// rather than nothing.
///
/// Clicking the mark explains it: a centred card over a blurred page, the
/// seal large with a glow that breathes in its own colour, the kind, and one
/// sentence on what it was given for (founder, 05.09). The click stays on
/// the seal: a row or link around it keeps its own.
const COLOUR: Record<string, string> = {
  official: 'text-sky-500',
  tester: 'text-amber-500',
  special: 'text-rose-500',
}
const GLOW: Record<string, string> = {
  official: 'rgba(14,165,233,0.45)',
  tester: 'rgba(245,158,11,0.45)',
  special: 'rgba(244,63,94,0.45)',
}

function Seal({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path
        fill="currentColor"
        d="M12 1.6l2.3 2 3-.5 1.2 2.8 2.8 1.2-.5 3 2 2.3-2 2.3.5 3-2.8 1.2-1.2 2.8-3-.5-2.3 2-2.3-2-3 .5-1.2-2.8-2.8-1.2.5-3-2-2.3 2-2.3-.5-3 2.8-1.2L6.7 3.1l3 .5z"
      />
      <path d="M8.2 12.4l2.5 2.5 5.1-5.3" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function BadgeMark({ kind, className = 'h-3.5 w-3.5' }: { kind?: string | null; className?: string }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  if (!kind) return null
  const colour = COLOUR[kind] ?? 'text-fg-dim'
  const label = t(`badge.${kind}`, {}) || kind
  const known = t(`badge.desc.${kind}`, {})
  const description = known && known !== `badge.desc.${kind}` ? known : t('badge.desc.unknown')
  const glow = GLOW[kind] ?? 'rgba(148,163,184,0.4)'
  const onClick = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setOpen(true)
  }
  return (
    <>
      <button type="button" onClick={onClick} className={`flex-none inline-flex ${colour} ${className}`} aria-label={label} title={label}>
        <Seal className="h-full w-full" />
      </button>
      {open && createPortal(
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 backdrop-blur-md p-4"
          // The portal is a DOM escape, not a React one: a click here bubbles
          // through the React tree to whatever row the seal sits in (a chat
          // link, a Join button, an account switch). Stop it at the backdrop,
          // mousedown included, since menus close on document mousedown.
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setOpen(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false)
          }}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
          ref={(el) => el?.focus()}
        >
          <div className="w-full max-w-xs rounded-2xl bg-surface p-7 text-center space-y-4" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
            <div className="relative mx-auto h-32 w-32 flex items-center justify-center">
              <div
                className="absolute inset-0 rounded-full blur-2xl"
                style={{ background: glow, animation: 'rcq-badge-breathe 2.6s ease-in-out infinite alternate' }}
              />
              <Seal className={`relative h-16 w-16 ${colour}`} />
            </div>
            <div className="text-lg font-semibold text-fg-primary">{label}</div>
            <p className="text-sm text-fg-secondary leading-relaxed">{description}</p>
            <style>{`@keyframes rcq-badge-breathe { from { transform: scale(0.86); opacity: 0.55 } to { transform: scale(1.12); opacity: 0.95 } }`}</style>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

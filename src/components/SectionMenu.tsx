// The long-press menu on a chat-list section header.
//
// Founder, 23.08: a long press on a section offers reorder, "ask for a PIN?"
// and "create a new section". Rename and delete are here too, because a typo
// in a section name is otherwise permanent.
//
// This is the desktop client as well as the browser one, so the gesture is
// BOTH: a right-click where there is a mouse, a half-second press where there
// is a finger. `useSectionMenuTrigger` below owns that and hands back the
// props a header spreads onto itself.
//
// ⚠ Rendered through a portal, always. An overlay positioned `fixed` inside an
// element with `backdrop-filter` is positioned against THAT element instead of
// the viewport, which we have now walked into twice (reports, 17.08). The page
// header this menu can open under is exactly such an element.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../lib/i18n-context'
import { MAX_NAME_SCALARS } from '../lib/sections'

export interface SectionMenuTarget {
  id: string
  /// `true` for a section the user made: it can be renamed, deleted and filled.
  user: boolean
  /// The name as it is on screen (localised for a built-in).
  title: string
  pinned: boolean
}

interface Props {
  at: { x: number; y: number }
  target: SectionMenuTarget
  /// Only where a real PIN exists to check against: the Tauri build with a
  /// vault. The browser does not get this item at all, and does not get it
  /// greyed out either (sections design §5): a disabled padlock invites "why
  /// not here" and implies the phones offer something comparable in kind.
  canPin: boolean
  onClose: () => void
  onReorder: () => void
  onTogglePin: () => void
  onCreate: (name: string) => void
  onRename: (name: string) => void
  onDelete: () => void
}

export function SectionMenu({
  at,
  target,
  canPin,
  onClose,
  onReorder,
  onTogglePin,
  onCreate,
  onRename,
  onDelete,
}: Props) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement | null>(null)
  const [mode, setMode] = useState<'menu' | 'create' | 'rename' | 'delete'>('menu')
  const [name, setName] = useState(target.user ? target.title : '')

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Keep the panel on screen: opened near the right edge or near the bottom it
  // would otherwise hang off, and there is nothing to scroll to reach it.
  const W = 232
  const H = 260
  const x = Math.max(8, Math.min(at.x, window.innerWidth - W - 8))
  const y = Math.max(8, Math.min(at.y, window.innerHeight - H - 8))

  const panel = (body: ReactNode) => (
    <div
      ref={ref}
      role="menu"
      style={{ left: x, top: y, width: W }}
      className="rcq-menu fixed z-50 rounded-lg shadow-lg text-sm bg-surface"
      onClick={(e) => e.stopPropagation()}
    >
      {body}
    </div>
  )

  if (mode === 'create' || mode === 'rename') {
    const save = () => {
      const clean = name.trim()
      if (!clean) return
      if (mode === 'create') onCreate(clean)
      else onRename(clean)
      onClose()
    }
    return createPortal(
      panel(
        <div className="p-3 space-y-2">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {mode === 'create' ? t('sections.menu.new') : t('sections.menu.rename')}
          </div>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={MAX_NAME_SCALARS * 2}
            placeholder={t('sections.new.placeholder')}
            className="w-full h-9 px-2 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm"
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
          />
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="flex-1 h-8 rounded-md bg-field text-xs font-medium hover:bg-line/50"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={save}
              className="flex-1 h-8 rounded-md bg-accent hover:bg-accent-dim text-white text-xs font-semibold"
            >
              {mode === 'create' ? t('sections.new.save') : t('sections.rename.save')}
            </button>
          </div>
        </div>,
      ),
      document.body,
    )
  }

  if (mode === 'delete') {
    return createPortal(
      panel(
        <div className="p-3 space-y-2">
          <p className="text-xs text-fg-secondary leading-relaxed">{t('sections.menu.delete.confirm')}</p>
          <div className="flex gap-2">
            <button
              onClick={() => setMode('menu')}
              className="flex-1 h-8 rounded-md bg-field text-xs font-medium hover:bg-line/50"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={() => {
                onDelete()
                onClose()
              }}
              className="flex-1 h-8 rounded-md bg-red-600 hover:bg-red-700 text-white text-xs font-semibold"
            >
              {t('sections.menu.delete.short')}
            </button>
          </div>
        </div>,
      ),
      document.body,
    )
  }

  return createPortal(
    panel(
      <ul className="py-1">
        <Row
          icon={<GripIcon />}
          label={t('sections.menu.reorder')}
          onClick={() => {
            onReorder()
            onClose()
          }}
        />
        {canPin && (
          <li>
            <button
              role="menuitem"
              onClick={() => {
                onTogglePin()
                onClose()
              }}
              className="w-full px-3 py-2 flex items-start gap-2.5 text-left hover:bg-field transition-colors"
            >
              <span className="text-fg-secondary mt-0.5">
                <KeyIcon />
              </span>
              <span className="min-w-0">
                <span className="block">
                  {target.pinned ? t('sections.menu.pin.off') : t('sections.menu.pin')}
                </span>
                {/* The one sentence that is allowed here. Never "protects",
                    never "encrypts": the flag syncs, the gate is local, and
                    the chats themselves are untouched. */}
                <span className="block text-[0.6875rem] leading-snug text-fg-dim mt-0.5">
                  {t('sections.menu.pin.note')}
                </span>
              </span>
            </button>
          </li>
        )}
        <Row
          icon={<PlusIcon />}
          label={t('sections.menu.new')}
          onClick={() => {
            setName('')
            setMode('create')
          }}
        />
        {target.user && (
          <>
            <Row icon={<PencilIcon />} label={t('sections.menu.rename')} onClick={() => setMode('rename')} />
            <Row
              icon={<TrashIcon />}
              label={t('sections.menu.delete')}
              danger
              onClick={() => setMode('delete')}
            />
          </>
        )}
      </ul>,
    ),
    document.body,
  )
}

function Row({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <li>
      <button
        role="menuitem"
        onClick={onClick}
        className={
          'w-full px-3 py-2 flex items-center gap-2.5 text-left hover:bg-field transition-colors ' +
          (danger ? 'text-red-500' : '')
        }
      >
        <span className={danger ? 'text-red-500' : 'text-fg-secondary'}>{icon}</span>
        <span className="flex-1 truncate">{label}</span>
      </button>
    </li>
  )
}

/// Right-click, or a half-second press with a finger.
///
/// Returns the props to spread on the header plus `suppressed()`, which the
/// header's own click handler asks before acting: a long press ends in a
/// `click` event too, and without this the menu would open and the section
/// would collapse under it.
export function useSectionMenuTrigger(open: (x: number, y: number) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fired = useRef(false)
  const start = useRef<{ x: number; y: number } | null>(null)

  const clear = () => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    start.current = null
  }

  return {
    suppressed: () => {
      if (!fired.current) return false
      fired.current = false
      return true
    },
    handlers: {
      onContextMenu: (e: { preventDefault: () => void; clientX: number; clientY: number }) => {
        e.preventDefault()
        open(e.clientX, e.clientY)
      },
      onPointerDown: (e: ReactPointerEvent) => {
        // Mouse users have the right button; a press-and-hold there is how you
        // select text, not how you open a menu.
        if (e.pointerType === 'mouse') return
        start.current = { x: e.clientX, y: e.clientY }
        const { clientX, clientY } = e
        timer.current = setTimeout(() => {
          fired.current = true
          timer.current = null
          open(clientX, clientY)
        }, 500)
      },
      onPointerMove: (e: ReactPointerEvent) => {
        // A scroll that began on the header is a scroll, not a press.
        if (!start.current) return
        if (Math.abs(e.clientX - start.current.x) + Math.abs(e.clientY - start.current.y) > 10) clear()
      },
      onPointerUp: clear,
      onPointerCancel: clear,
    },
  }
}

function GripIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="9" cy="6" r="1.6" />
      <circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" />
      <circle cx="15" cy="18" r="1.6" />
    </svg>
  )
}

/// The same key glyph iOS already uses on Archive. Deliberately not a padlock
/// and not a shield: those read as encryption, and this is a curtain.
export function KeyIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="8" cy="15" r="4" />
      <path d="M10.9 12.1 20 3" />
      <path d="M17 6l2.5 2.5" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M10 4v12M4 10h12" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M6 6l1 14h10l1-14" />
    </svg>
  )
}

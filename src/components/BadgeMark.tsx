import { useI18n } from '../lib/i18n-context'

/// The island's mark beside a name: a small seal whose colour says which
/// kind of mark it is. The kinds are strings the island chooses; the ones
/// this client knows get their colour, anything newer is drawn neutral so a
/// kind added on the island before the client learned it is still a mark
/// rather than nothing.
const COLOUR: Record<string, string> = {
  official: 'text-sky-500',
  tester: 'text-amber-500',
  special: 'text-rose-500',
}

export function BadgeMark({ kind, className = 'h-3.5 w-3.5' }: { kind?: string | null; className?: string }) {
  const { t } = useI18n()
  if (!kind) return null
  const colour = COLOUR[kind] ?? 'text-fg-dim'
  const label = t(`badge.${kind}`, {}) || kind
  return (
    <svg
      viewBox="0 0 24 24"
      className={`flex-none ${colour} ${className}`}
      aria-label={label}
      role="img"
    >
      <title>{label}</title>
      <path
        fill="currentColor"
        d="M12 1.6l2.3 2 3-.5 1.2 2.8 2.8 1.2-.5 3 2 2.3-2 2.3.5 3-2.8 1.2-1.2 2.8-3-.5-2.3 2-2.3-2-3 .5-1.2-2.8-2.8-1.2.5-3-2-2.3 2-2.3-.5-3 2.8-1.2L6.7 3.1l3 .5z"
      />
      <path
        d="M8.2 12.4l2.5 2.5 5.1-5.3"
        fill="none"
        stroke="white"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

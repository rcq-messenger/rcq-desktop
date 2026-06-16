// Status icon — same artwork as iOS, served from /statuses/. The
// PNG basenames match `Resources/Statuses/status_<state>.png` so
// keeping iOS and web aligned is a one-file copy.

import type { UserStatus } from '../lib/api'

interface Props {
  status: UserStatus | 'typing'
  size?: number
  className?: string
  /// Cross-island peer (§5c): presence isn't tracked across islands, so render
  /// the ONLINE flower desaturated to gray ("reachable, presence unknown").
  crossIsland?: boolean
}

const SRC: Record<UserStatus | 'typing', string> = {
  online: '/statuses/status_online.png',
  away: '/statuses/status_away.png',
  dnd: '/statuses/status_dnd.png',
  invisible: '/statuses/status_invisible.png',
  offline: '/statuses/status_offline.png',
  typing: '/statuses/status_typing.png',
}

export function StatusIcon({ status, size = 16, className = '', crossIsland = false }: Props) {
  return (
    <img
      src={crossIsland ? SRC.online : SRC[status]}
      alt={crossIsland ? 'cross-island' : status}
      width={size}
      height={size}
      className={`inline-block flex-none ${className}`}
      style={{ imageRendering: 'auto', filter: crossIsland ? 'grayscale(1)' : undefined }}
    />
  )
}

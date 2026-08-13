// A person's picture, with their status kept on it.
//
// The rule the whole feature rests on: a picture does NOT replace presence.
// This app is built around the status flower, so when someone has a picture the
// flower moves to a badge on the lower-left corner and stays there, the same
// way the Hall of Fame renders it on the site. With no picture nothing changes
// at all: the plain status icon is drawn exactly as before, so every existing
// screen keeps its look for the people who never set one.
//
// Media is fetched from `/media/{id}` and AES-256-GCM decrypted in the browser
// (lib/media.ts), like a group avatar. A miss, a failed decrypt or a slow load
// all fall back to the status icon rather than a broken image.

import { useEffect, useState } from 'react'
import type { UserStatus } from '../lib/api'
import { useIdentity } from '../lib/identity-context'
import { loadEncryptedImage } from '../lib/media'
import { StatusIcon } from './StatusIcon'

interface Props {
  status: UserStatus
  size?: number
  className?: string
  mediaId?: string | null
  mediaKey?: string | null
  /// Cross-island peer: presence isn't tracked across islands and the blob
  /// lives on theirs, so these keep the gray flower.
  crossIsland?: boolean
  /// Set when the status badge itself is actionable (the header, where tapping
  /// the flower opens the status menu). Without it the badge is decoration.
  onStatusClick?: () => void
}

export function PersonAvatar({
  status,
  size = 28,
  className = '',
  mediaId,
  mediaKey,
  crossIsland = false,
  onStatusClick,
}: Props) {
  const { identity } = useIdentity()
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    setUrl(null)
    if (!identity || crossIsland || !mediaId || !mediaKey) return
    let alive = true
    void loadEncryptedImage(identity.apiBase, mediaId, mediaKey).then((u) => {
      if (alive) setUrl(u)
    })
    return () => {
      alive = false
    }
  }, [identity?.apiBase, mediaId, mediaKey, crossIsland])

  if (!url) {
    const icon = <StatusIcon status={status} size={size} className={className} crossIsland={crossIsland} />
    if (!onStatusClick) return icon
    return (
      <button type="button" onClick={onStatusClick} className="flex-none leading-none" aria-label={status}>
        {icon}
      </button>
    )
  }

  // Big enough to read on a 24px row avatar, small enough not to swallow a
  // large profile one.
  const badge = Math.min(26, Math.max(12, Math.round(size * 0.36)))
  // The badge sits ON the picture's lower-left edge and sticks out past it,
  // exactly as Android draws it (Common.kt: offset(x = -badge/4, y = badge/4))
  // and as the site draws it in the Hall of Fame. Pinned flush to the square's
  // corner it landed in the gap the round image never reaches, so it read as
  // half-swallowed and sat too high. Same quarter-badge overhang on both axes.
  const out = -Math.round(badge / 4)
  const pos = { width: badge, height: badge, left: out, bottom: out }
  return (
    <span className={`relative inline-block flex-none ${className}`} style={{ width: size, height: size }}>
      <img
        src={url}
        alt=""
        className="rounded-full object-cover w-full h-full"
        draggable={false}
      />
      {onStatusClick ? (
        <button
          type="button"
          onClick={onStatusClick}
          className="absolute rounded-full bg-bg flex items-center justify-center"
          style={pos}
          aria-label={status}
        >
          <StatusIcon status={status} size={Math.round(badge * 0.86)} />
        </button>
      ) : (
        <span
          className="absolute rounded-full bg-bg flex items-center justify-center"
          style={pos}
        >
          <StatusIcon status={status} size={Math.round(badge * 0.86)} />
        </span>
      )}
    </span>
  )
}

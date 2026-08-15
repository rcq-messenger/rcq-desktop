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
  /// Cross-island peer: presence isn't tracked across islands, so the flower
  /// stays gray.
  ///
  /// It used to suppress the PICTURE too, because the blob lived on their
  /// island and we had neither its id nor its key. §5e changed that from both
  /// ends: the peer deposits the encrypted blob to OUR island under the same
  /// id and hands us the key in a sealed envelope, so when a caller has an
  /// id+key pair for a cross-island contact it resolves from `apiBase` like
  /// any other picture — and keeps resolving while their island is down, which
  /// is the whole reason the picture is deposited rather than pulled.
  crossIsland?: boolean
  /// Set when the status badge itself is actionable (the header, where tapping
  /// the flower opens the status menu). Without it the badge is decoration.
  onStatusClick?: () => void
  /// Draw the person WITHOUT their presence. One screen wants this: a call,
  /// where you are looking at nobody else and their being "online" is the one
  /// thing you already know. Off, this component renders the picture alone —
  /// and nothing at all when there is no picture, so the caller can put its own
  /// fallback there (the phones draw a lettered disc).
  showStatus?: boolean
}

export function PersonAvatar({
  status,
  size = 28,
  className = '',
  mediaId,
  mediaKey,
  crossIsland = false,
  onStatusClick,
  showStatus = true,
}: Props) {
  const { identity } = useIdentity()
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    setUrl(null)
    if (!identity || !mediaId || !mediaKey) return
    let alive = true
    void loadEncryptedImage(identity.apiBase, mediaId, mediaKey).then((u) => {
      if (alive) setUrl(u)
    })
    return () => {
      alive = false
    }
  }, [identity?.apiBase, mediaId, mediaKey])

  if (!url) {
    // Nothing to draw: no picture, and presence deliberately suppressed.
    if (!showStatus) return null
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
      {!showStatus ? null : onStatusClick ? (
        <button
          type="button"
          onClick={onStatusClick}
          className="absolute rounded-full bg-bg flex items-center justify-center"
          style={pos}
          aria-label={status}
        >
          {/* Still gray for a cross-island peer: they now have a face, but
              presence does not cross islands and never claimed to. */}
          <StatusIcon status={status} size={Math.round(badge * 0.86)} crossIsland={crossIsland} />
        </button>
      ) : (
        <span
          className="absolute rounded-full bg-bg flex items-center justify-center"
          style={pos}
        >
          {/* Still gray for a cross-island peer: they now have a face, but
              presence does not cross islands and never claimed to. */}
          <StatusIcon status={status} size={Math.round(badge * 0.86)} crossIsland={crossIsland} />
        </span>
      )}
    </span>
  )
}

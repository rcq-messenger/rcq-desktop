// The sender's picture beside their nick on a group message — and nothing at
// all when they have not set one, so that line stays the plain nick it has
// always been.
//
// Deliberately not `PersonAvatar`: that one falls back to the status icon and
// keeps presence as a badge, which is right in a list of people and wrong here.
// Presence on a bubble would be the sender's status NOW, sitting next to
// something they said hours ago, and a coloured dot on every message is noise
// where the list needs it to be signal.

import { useEffect, useState } from 'react'
import { useIdentity } from '../lib/identity-context'
import { loadEncryptedImage } from '../lib/media'

interface Props {
  mediaId?: string | null
  mediaKey?: string | null
  size?: number
}

export function SenderAvatar({ mediaId, mediaKey, size = 16 }: Props) {
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

  if (!url) return null
  return (
    <img
      src={url}
      alt=""
      className="rounded-full object-cover flex-none"
      style={{ width: size, height: size }}
    />
  )
}

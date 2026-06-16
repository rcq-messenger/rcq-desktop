// Group avatar — mirrors iOS `GroupAvatarView`: shows the custom
// uploaded image when the group has encrypted avatar media, otherwise
// the fallback (a solid accent circle with a white "group of people"
// glyph). Media is fetched from `/media/{id}` and AES-256-GCM decrypted
// in-browser (see lib/media.ts); on miss/loading/error we render the
// glyph so there's never a broken-image state.

import { useEffect, useState } from 'react'
import { useIdentity } from '../lib/identity-context'
import { loadEncryptedImage } from '../lib/media'

interface Props {
  size?: number
  className?: string
  /// Encrypted avatar media (when the owner uploaded a custom image).
  /// Both must be present to attempt a decrypt; otherwise → glyph.
  mediaId?: string | null
  mediaKey?: string | null
}

export function GroupAvatar({ size = 40, className = '', mediaId, mediaKey }: Props) {
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

  if (url) {
    return (
      <img
        src={url}
        alt=""
        className={`rounded-full object-cover flex-none ${className}`}
        style={{ width: size, height: size }}
        draggable={false}
      />
    )
  }

  return (
    <div
      className={`rounded-full bg-accent flex items-center justify-center flex-none ${className}`}
      style={{ width: size, height: size }}
    >
      <svg
        width={size * 0.56}
        height={size * 0.56}
        viewBox="0 0 24 24"
        fill="white"
        aria-hidden="true"
      >
        <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
      </svg>
    </div>
  )
}

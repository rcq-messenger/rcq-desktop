// The sender's picture beside their nick on a group message — and nothing at
// all when they have not set one, so that line stays the plain nick it has
// always been.
//
// Deliberately not `PersonAvatar`: that one falls back to the status icon and
// keeps presence as a badge, which is right in a list of people and wrong here.
// Presence on a bubble would be the sender's status NOW, sitting next to
// something they said hours ago, and a coloured dot on every message is noise
// where the list needs it to be signal.

import { useEffect, useState, useSyncExternalStore } from 'react'
import { useIdentity } from '../lib/identity-context'
import { loadEncryptedAvatar } from '../lib/media'
import { askForProfileKey, peerProfileKey, profileKeysVersion, subscribeProfileKeys } from '../lib/profile-key'

interface Props {
  mediaId?: string | null
  mediaKey?: string | null
  /// Whose face this is, for the profile-key lookup. The island holds no key
  /// for a picture set under the profile-key model, so `mediaKey` arrives null
  /// and the real key is the one its owner sealed to us. Without this the
  /// sender's face on a group bubble simply stopped appearing.
  uin?: number
  /// Enough of them to ASK for the key when we hold none.
  askPeer?: { uin: number; identity_key?: string | null; signing_key?: string | null }
  size?: number
}

export function SenderAvatar({ mediaId, mediaKey, uin, askPeer, size = 16 }: Props) {
  const { identity } = useIdentity()
  const [url, setUrl] = useState<string | null>(null)
  const keysVersion = useSyncExternalStore(subscribeProfileKeys, profileKeysVersion, profileKeysVersion)
  const key = mediaKey ?? (uin != null ? peerProfileKey(uin) : null)

  useEffect(() => {
    setUrl(null)
    if (!identity || !mediaId) return
    if (!key) {
      // No key is "no picture" here, exactly as before — and an ask, so the
      // face turns up on a later paint instead of never.
      if (uin != null && askPeer) void askForProfileKey(identity, askPeer)
      return
    }
    let alive = true
    void loadEncryptedAvatar(identity.apiBase, mediaId, key).then((u) => {
      if (alive) setUrl(u)
    })
    return () => {
      alive = false
    }
  }, [identity?.apiBase, mediaId, key, uin, keysVersion])

  if (!url) {
    // No picture at all: draw nothing, exactly as before, so a thread of people
    // who never set one keeps the plain nick line it has always had.
    if (!mediaId || !key) return null
    // ⚠⚠ A picture that IS coming keeps its place while it decrypts. The blob
    // is fetched and AES-GCM opened in the browser, which is a round trip and a
    // decrypt after the bubble is already on screen, and until this the line
    // drew nothing and then a 16px face: the nick and the island's mark beside
    // it jumped 22.56px to the right the moment it landed (measured), on every
    // message from that sender. That is "галки у ников двигаются" (founder,
    // 12.09). The reservation is the same box the picture will fill, so the
    // face fades into a space that was always its own.
    return <span className="inline-block flex-none" style={{ width: size, height: size }} aria-hidden />
  }
  return (
    <img
      src={url}
      alt=""
      className="rounded-full object-cover flex-none"
      style={{ width: size, height: size }}
    />
  )
}

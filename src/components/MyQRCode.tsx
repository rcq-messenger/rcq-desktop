// "My code" QR. Encodes the universal add-link https://rcq.app/u/<uin>,
// which the iOS/Android apps (and any generic QR scanner) resolve to an
// add-contact action for this UIN. Rendered in Settings so someone can
// scan the web user's code from their phone to add them.

import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { useIdentity } from '../lib/identity-context'
import { useI18n } from '../lib/i18n-context'
import { bytesToB64 } from '../lib/crypto'
import { getDevice } from '../lib/signal-device'
import { buildContactLink } from '../lib/federation'
import { PersonAvatar } from './PersonAvatar'
import type { UserStatus } from '../lib/api'

/// [me] is the caller's own card, used only to put their face in the middle of
/// the code (iOS/Android parity). Optional: with nothing passed, or with no
/// picture set, the middle stays empty exactly as it was.
export function MyQRCode({
  me,
}: {
  me?: { status?: UserStatus; avatar_media_id?: string | null; avatar_media_key?: string | null } | null
}) {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [zoomed, setZoomed] = useState(false)

  useEffect(() => {
    if (!identity) return
    let alive = true
    void (async () => {
      // Federation F1: carry the signing key (sk) and identity key (ik) so a
      // scanner can pin without an extra round trip, while the path stays a bare
      // UIN that pre-F1 scanners still resolve to the flagship add-link. If we
      // can't get the libsignal key, gracefully fall back to the legacy link.
      let sk: string | undefined
      let ik: string | undefined
      try {
        sk = bytesToB64(identity.signingPub)
        ik = (await getDevice(identity)).signalIdentityKeyB64()
      } catch {
        sk = undefined
        ik = undefined
      }
      let host = 'api.rcq.app'
      try {
        host = new URL(identity.apiBase).host
      } catch {
        /* keep flagship default */
      }
      const link = buildContactLink({ uin: identity.uin, host }, sk && ik ? { sk, ik } : undefined)
      try {
        const url = await QRCode.toDataURL(link, { width: 320, margin: 1, errorCorrectionLevel: 'M' })
        if (alive) setDataUrl(url)
      } catch {
        if (alive) setDataUrl(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [identity?.uin])

  if (!identity) return null

  return (
    <div className="flex flex-col items-center gap-3">
      {/* Tap to enlarge, same gesture and same presentation as the link QR on
          the login screen: a 176px code is fine to look at and awkward to scan
          off a screen from arm's length, which is the only reason this code
          exists. */}
      <button
        type="button"
        onClick={() => dataUrl && setZoomed(true)}
        disabled={!dataUrl}
        aria-label={t('settings.qr.zoom')}
        className="bg-white p-3 rounded-xl transition-transform hover:scale-[1.02] active:scale-[0.99] disabled:cursor-default"
      >
        {dataUrl ? (
          <span className="relative block">
            <img src={dataUrl} alt="QR" width={176} height={176} className="block" draggable={false} />
            {/* The face goes in the middle of the code, because the code is
                held up to a stranger and that is who they are looking for.
                ⚠ 34px over 176 is ~3.7% of the AREA; error correction is level
                'M', good for about 15%, so this must not grow much. */}
            {me?.avatar_media_id && (
              <span className="absolute inset-0 flex items-center justify-center">
                <span className="flex rounded-full bg-white p-[3px]">
                  <PersonAvatar
                    status={me.status ?? 'offline'}
                    size={34}
                    mediaId={me.avatar_media_id}
                    mediaKey={me.avatar_media_key}
                  />
                </span>
              </span>
            )}
          </span>
        ) : (
          <div className="w-44 h-44 animate-pulse bg-gray-200 rounded" />
        )}
      </button>
      <div className="text-sm">#{identity.uin}</div>
      <p className="text-xs text-fg-dim text-center max-w-xs">{t('settings.qr.hint')}</p>

      <AnimatePresence>
        {zoomed && dataUrl && (
          <motion.div
            key="qr-zoom"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={() => setZoomed(false)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-md p-6"
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.92, opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={(e) => e.stopPropagation()}
              className="rounded-2xl bg-white p-5 shadow-2xl"
            >
              <div className="relative">
                <img
                  src={dataUrl}
                  alt="QR"
                  className="w-[min(72vw,340px)] h-[min(72vw,340px)]"
                  draggable={false}
                />
                {me?.avatar_media_id && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="flex rounded-full bg-white p-1">
                      <PersonAvatar
                        status={me.status ?? 'offline'}
                        size={64}
                        mediaId={me.avatar_media_id}
                        mediaKey={me.avatar_media_key}
                      />
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

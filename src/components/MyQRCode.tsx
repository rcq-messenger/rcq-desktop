// "My code" QR. Encodes the universal add-link https://rcq.app/u/<uin>,
// which the iOS/Android apps (and any generic QR scanner) resolve to an
// add-contact action for this UIN. Rendered in Settings so someone can
// scan the web user's code from their phone to add them.

import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { useIdentity } from '../lib/identity-context'
import { useI18n } from '../lib/i18n-context'
import { bytesToB64 } from '../lib/crypto'
import { getDevice } from '../lib/signal-device'
import { buildContactLink } from '../lib/federation'

export function MyQRCode() {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const [dataUrl, setDataUrl] = useState<string | null>(null)

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
      <div className="bg-white p-3 rounded-xl">
        {dataUrl ? (
          <img src={dataUrl} alt="QR" width={176} height={176} className="block" draggable={false} />
        ) : (
          <div className="w-44 h-44 animate-pulse bg-gray-200 rounded" />
        )}
      </div>
      <div className="font-mono text-sm">#{identity.uin}</div>
      <p className="text-xs text-fg-dim text-center max-w-xs">{t('settings.qr.hint')}</p>
    </div>
  )
}

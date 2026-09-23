// The two halves of a screenshot on a report, as the screens draw them.
//
// `ReportAttachmentPicker` is the row of picked files with the "+" at the end:
// the new-report form in Settings had it inline, and the reply box on an open
// report had nothing, which is why a person filed a second report to hand over
// one picture (#1039). One component, so the two composers pick, cap and
// preview the same way. The rules it applies live in lib/report-attachments.ts.
//
// `ReportAttachmentList` is what was attached, read back: under the report on
// "My reports" (Android has drawn these since #934; this screen never did) and
// under each of the reporter's own turns. Blobs are fetched and decrypted with
// the key the island hands back to their author only, through the same
// components a chat photo or video uses.

import { useEffect, useState } from 'react'
import { useI18n } from '../lib/i18n-context'
import type { ReportAttachment } from '../lib/media'
import { addPicked, REPORT_ATTACH_ACCEPT, REPORT_MAX_ATTACHMENTS } from '../lib/report-attachments'
import { DecryptedImage } from './DecryptedImage'
import { DecryptedVideo } from './DecryptedVideo'

export function ReportAttachmentPicker({
  files,
  onChange,
  disabled,
}: {
  files: File[]
  onChange: (next: File[]) => void
  disabled?: boolean
}) {
  const { t } = useI18n()
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {files.map((f, i) => (
        <PickedThumb
          key={i}
          file={f}
          disabled={disabled}
          removeLabel={t('report.attach.remove')}
          onRemove={() => onChange(files.filter((_, j) => j !== i))}
        />
      ))}
      {files.length < REPORT_MAX_ATTACHMENTS && !disabled && (
        <label
          className="w-12 h-12 rounded-md bg-field flex items-center justify-center text-accent text-xl cursor-pointer hover:bg-accent/5"
          aria-label={t('report.attach.add')}
          title={t('report.attach.add')}
        >
          +
          <input
            type="file"
            accept={REPORT_ATTACH_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const picked = e.target.files ? Array.from(e.target.files) : []
              if (picked.length) onChange(addPicked(files, picked))
              e.target.value = ''
            }}
          />
        </label>
      )}
    </div>
  )
}

/// One picked file. The preview URL is made once per file and revoked when the
/// file leaves the row: the inline version this replaces minted a fresh object
/// URL on every render of the whole Settings page and never gave one back.
function PickedThumb({
  file,
  disabled,
  removeLabel,
  onRemove,
}: {
  file: File
  disabled?: boolean
  removeLabel: string
  onRemove: () => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  const isImage = file.type.startsWith('image/')
  useEffect(() => {
    if (!isImage) {
      setUrl(null)
      return
    }
    const u = URL.createObjectURL(file)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file, isImage])
  return (
    <div className="relative">
      {isImage && url ? (
        <img src={url} alt="" className="w-12 h-12 rounded-md object-cover" />
      ) : (
        <div className="w-12 h-12 rounded-md bg-field flex items-center justify-center text-fg-secondary text-xs">
          ▶
        </div>
      )}
      {!disabled && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          title={removeLabel}
          className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-black/60 text-white text-[0.625rem] leading-none"
        >
          ×
        </button>
      )}
    </div>
  )
}

/// What was attached, read back. Nothing at all when there is nothing, so a
/// report without pictures looks exactly as it did.
export function ReportAttachmentList({ items }: { items?: ReportAttachment[] | null }) {
  if (!items || items.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((a, i) =>
        a.mime.startsWith('image/') ? (
          <DecryptedImage key={`${a.media_id}-${i}`} mediaId={a.media_id} mediaKey={a.key} />
        ) : a.mime.startsWith('video/') ? (
          <DecryptedVideo key={`${a.media_id}-${i}`} mediaId={a.media_id} mediaKey={a.key} />
        ) : (
          <div
            key={`${a.media_id}-${i}`}
            className="w-12 h-12 rounded-md bg-field flex items-center justify-center text-fg-secondary"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
              <path d="M14 3v6h6" />
            </svg>
          </div>
        ),
      )}
    </div>
  )
}

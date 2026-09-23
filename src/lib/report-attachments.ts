// Screenshots on a bug report: the rules BOTH composers share.
//
// There are two places a person writes to the island's operators: the new
// report form in Settings, and "Write back" on a report that is already open
// (MyReports). Only the first could carry a picture, so somebody who wanted to
// add a screenshot to their own open report filed a second report just for the
// picture (#1039, written from the Windows desktop). This module is the part
// the two composers must agree on, kept free of React and of browser-only
// imports so the console bundle can prove it offline (cli/test/report-attach.mjs).
//
// The wire shape is the one the island already stores on a report and the
// admin queue already decrypts: `{media_id, key, mime, size}`, each blob
// AES-GCM sealed on this device under a key minted for it (lib/media.ts,
// `uploadReportAttachment`). The key rides in the JSON body next to the text,
// never inside the text itself.

import type { ReportAttachment } from './media'

/// The island's cap (`MAX_ATTACHMENTS_PER_REPORT` in routers/reports.py).
/// The same number on a new report and on a turn, so a person never meets two
/// different limits for "attach a screenshot" on two screens.
export const REPORT_MAX_ATTACHMENTS = 3

/// What the picker accepts. Pictures and short recordings, like the phones.
export const REPORT_ATTACH_ACCEPT = 'image/*,video/*'

/// One or more attachments could not be uploaded. Thrown BEFORE anything is
/// sent, so the caller keeps the text and the picked files for a retry.
///
/// ⚠ This replaces a silent drop. The Settings form used to filter failed
/// uploads out and send the text anyway, so the operator got a report that
/// said "see the screenshot" with no screenshot, and the person who attached
/// it had no way to know. A report is the one place where the picture is often
/// the whole message.
export class ReportAttachmentUploadError extends Error {
  readonly failed: number
  constructor(failed: number) {
    super(`report attachment upload failed (${failed})`)
    this.name = 'ReportAttachmentUploadError'
    this.failed = failed
  }
}

/// Add freshly picked files to the ones already chosen, capped. Anything that
/// is not a picture or a video is ignored rather than refused: the file dialog
/// already filters, and a paste can carry text alongside the image.
export function addPicked<T extends { type: string }>(prev: T[], picked: Iterable<T>): T[] {
  const next = [...prev]
  for (const f of picked) {
    if (next.length >= REPORT_MAX_ATTACHMENTS) break
    if (f.type.startsWith('image/') || f.type.startsWith('video/')) next.push(f)
  }
  return next
}

/// The pictures in a paste, if any. Windows people take a screenshot with
/// Win+Shift+S and press Ctrl+V; that lands here as a clipboard file, not as a
/// path anybody could pick in a dialog.
export function filesFromClipboard(data: { files?: ArrayLike<File> | null } | null | undefined): File[] {
  const files = data?.files
  if (!files) return []
  const out: File[] = []
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    if (f && f.type.startsWith('image/')) out.push(f)
  }
  return out
}

/// Upload every file, or none of the result counts. All in parallel (three at
/// most); if any one comes back empty or throws, the whole send stops with
/// `ReportAttachmentUploadError`, because a report that silently lost one of
/// its three screenshots is the report the operator misreads.
export async function uploadAll<T>(
  files: T[],
  upload: (f: T) => Promise<ReportAttachment | null>,
): Promise<ReportAttachment[]> {
  const settled = await Promise.allSettled(files.map((f) => upload(f)))
  const out: ReportAttachment[] = []
  let failed = 0
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value) out.push(s.value)
    else failed++
  }
  if (failed > 0) throw new ReportAttachmentUploadError(failed)
  return out
}

/// The body of `POST /reports/mine/{id}/messages`.
///
/// ⚠ With nothing attached it is `{ body }` and NOTHING else, byte for byte
/// what every build sent before this change. The field is added only when
/// there is something in it, and the caller only gets that far on an island
/// that advertises `report_turn_attachments` (see `canSendTurn`).
export function addTurnBody(
  body: string,
  attachments: ReportAttachment[],
): { body: string; attachments?: ReportAttachment[] } {
  return attachments.length > 0 ? { body, attachments } : { body }
}

/// Whether the island kept what was sent with a turn.
///
/// ⚠⚠ An island that does not know the field does NOT refuse it: FastAPI's
/// models ignore unknown keys, so the text is stored, 201 comes back, and the
/// screenshot is simply gone. The capability flag keeps us from sending in
/// that case; this is the belt to it, read off the island's own answer. A
/// turn that comes back without an `attachments` list, or with fewer than we
/// sent, was not kept.
export function attachmentsKept(sent: number, turn: { attachments?: unknown } | null | undefined): boolean {
  if (sent === 0) return true
  const kept = turn?.attachments
  return Array.isArray(kept) && kept.length >= sent
}

/// May the reply box send? Text alone always could. A screenshot with no text
/// only where the island takes attachments on a turn, because that island is
/// also the one that accepts an empty body when a picture carries the turn.
export function canSendTurn(text: string, files: number, islandTakesAttachments: boolean): boolean {
  if (text.trim().length > 0) return true
  return islandTakesAttachments && files > 0
}

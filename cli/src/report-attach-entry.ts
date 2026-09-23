// Bundle entry: screenshots on a bug report (#1039), for the offline test
// cli/test/report-attach.mjs.
//
// What it proves without an island: the rules both composers share
// (lib/report-attachments.ts), the exact body `addToReport` puts on the wire
// with and without pictures, the capability that gates the button, and that a
// blob sealed by `uploadReportAttachments` opens the way the admin queue opens
// it (web-admin `decryptAttachment`: nonce(12) || ciphertext+tag, raw key).

export {
  addPicked,
  addTurnBody,
  attachmentsKept,
  canSendTurn,
  filesFromClipboard,
  REPORT_MAX_ATTACHMENTS,
  ReportAttachmentUploadError,
  uploadAll,
} from '../../src/lib/report-attachments'
export { uploadReportAttachments } from '../../src/lib/media'
export { Api } from '../../src/lib/api'
export { DEFAULT_CAPABILITIES, loadServerInfo } from '../../src/lib/server-info'

// Gathering what goes into a `.rcqbak`, and putting a restored one back.
//
// The container itself is in `backup.ts`; this file is the mapping between the
// neutral archive record (shared with Android and iOS, see
// RCQ/docs/backup-format.md) and the shapes this client actually keeps: rows
// received live in IndexedDB, rows this device sent live in localStorage per
// thread, and the device-only settings live next to them.

import type { BackupRecord } from './backup'
import { readBackup, writeBackup } from './backup'
import {
  exportAllIncoming,
  mergeRestoredIncoming,
  type IncomingRow,
} from './incoming-store'
import { loadPersisted, storageKey, type OutgoingRow } from './outgoing-store'

const enc = new TextEncoder()
const dec = new TextDecoder()

const OUTGOING_PREFIX = 'rcq.web.outgoing.'
const ALIASES_KEY = 'rcq.web.contacts.aliases'

function incomingToRecord(row: IncomingRow, peer: number | null, group: number | null): BackupRecord {
  return {
    id: row.id,
    peer,
    group,
    from_me: false,
    // In a group the sender matters; in a 1:1 it is the peer and the field is
    // left null so the record reads the same on every client.
    sender: group != null ? row.from : null,
    sent_at: row.at,
    kind: row.kind ?? 'text',
    body: row.text ?? '',
    media_id: row.mediaId ?? null,
    media_key: row.mediaKey ?? null,
    file_name: row.fileName ?? null,
    file_mime: row.fileMime ?? null,
    file_size: row.fileSize ?? null,
    duration_sec: row.durationSec ?? null,
    thumb_b64: row.thumbnailB64 ?? null,
    edited: row.edited ?? false,
    reply_to_id: row.replyTo?.id ?? null,
    reply_to_author: row.replyTo?.authorName ?? null,
    reply_to_snippet: row.replyTo?.snippet ?? null,
  }
}

function outgoingToRecord(row: OutgoingRow, peer: number | null, group: number | null): BackupRecord {
  return {
    id: row.id,
    peer,
    group,
    from_me: true,
    sender: null,
    sent_at: row.sentAt,
    kind: row.kind ?? 'text',
    body: row.text ?? '',
    media_id: row.mediaId ?? null,
    media_key: row.mediaKey ?? null,
    file_name: row.fileName ?? null,
    file_mime: row.fileMime ?? null,
    file_size: row.fileSize ?? null,
  }
}

function recordToIncoming(r: BackupRecord): IncomingRow {
  return {
    id: r.id,
    // A 1:1 record has no explicit sender, so it is the peer of that thread.
    from: r.sender ?? r.peer ?? 0,
    text: r.body,
    at: r.sent_at,
    kind: (r.kind as IncomingRow['kind']) ?? 'text',
    ...(r.media_id ? { mediaId: r.media_id } : {}),
    ...(r.media_key ? { mediaKey: r.media_key } : {}),
    ...(r.thumb_b64 ? { thumbnailB64: r.thumb_b64 } : {}),
    ...(r.duration_sec != null ? { durationSec: r.duration_sec } : {}),
    ...(r.file_name ? { fileName: r.file_name } : {}),
    ...(r.file_mime ? { fileMime: r.file_mime } : {}),
    ...(r.file_size != null ? { fileSize: r.file_size } : {}),
    ...(r.edited ? { edited: true } : {}),
  }
}

/// Every thread this device has sent into, read straight out of localStorage.
function outgoingThreads(): { isGroup: boolean; id: number; rows: OutgoingRow[] }[] {
  const out: { isGroup: boolean; id: number; rows: OutgoingRow[] }[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (!k || !k.startsWith(OUTGOING_PREFIX)) continue
    const rest = k.slice(OUTGOING_PREFIX.length)
    const isGroup = rest.startsWith('group.')
    const id = Number(rest.split('.')[1])
    if (!Number.isFinite(id)) continue
    out.push({ isGroup, id, rows: loadPersisted(storageKey(isGroup, id)) })
  }
  return out
}

export async function exportBackup(uin: number, phrase: string): Promise<Blob> {
  const records: BackupRecord[] = []
  const incoming = exportAllIncoming()
  for (const [k, rows] of Object.entries(incoming.peers)) {
    for (const r of rows) records.push(incomingToRecord(r, Number(k), null))
  }
  for (const [k, rows] of Object.entries(incoming.groups)) {
    for (const r of rows) records.push(incomingToRecord(r, null, Number(k)))
  }
  for (const t of outgoingThreads()) {
    for (const r of t.rows) {
      records.push(outgoingToRecord(r, t.isGroup ? null : t.id, t.isGroup ? t.id : null))
    }
  }
  records.sort((a, b) => a.sent_at - b.sent_at)

  const manifest = {
    app: 'rcq-web',
    uin,
    messages: records.length,
    // The browser never holds the decrypted attachment bytes for the whole
    // history, only for what it has opened, so it does not claim to carry them.
    includes_media: false,
  }
  const local = { aliases: JSON.parse(localStorage.getItem(ALIASES_KEY) ?? '{}') as Record<string, string> }

  return writeBackup(phrase, uin, [
    { name: 'manifest.json', bytes: enc.encode(JSON.stringify(manifest)) },
    { name: 'messages.ndjson', bytes: enc.encode(records.map((r) => JSON.stringify(r)).join('\n') + '\n') },
    { name: 'local.json', bytes: enc.encode(JSON.stringify(local)) },
  ])
}

export interface RestoreOutcome {
  added: number
  skipped: number
}

export async function importBackup(
  file: ArrayBuffer,
  phrase: string,
  ownUin: number,
): Promise<RestoreOutcome> {
  const { header, entries } = await readBackup(file, phrase)
  // Refused on purpose: a history that belongs to another number would show up
  // in this account's chat list as if it were its own.
  if (header.uin !== ownUin) {
    throw new Error(`this archive belongs to #${header.uin}, and you are signed in as #${ownUin}`)
  }

  let added = 0
  let total = 0
  for (const e of entries) {
    if (e.name === 'messages.ndjson') {
      const byPeer = new Map<number, IncomingRow[]>()
      const byGroup = new Map<number, IncomingRow[]>()
      for (const line of dec.decode(e.bytes).split('\n')) {
        if (!line.trim()) continue
        let rec: BackupRecord
        try {
          rec = JSON.parse(line) as BackupRecord
        } catch {
          continue
        }
        total++
        // Only what was received goes back into the incoming store; rows this
        // device sent are rebuilt from the same archive on the client that
        // owns them, and re-adding them here would duplicate your own side.
        if (rec.from_me) continue
        const row = recordToIncoming(rec)
        if (rec.group != null) {
          byGroup.set(rec.group, [...(byGroup.get(rec.group) ?? []), row])
        } else if (rec.peer != null) {
          byPeer.set(rec.peer, [...(byPeer.get(rec.peer) ?? []), row])
        }
      }
      for (const [id, rows] of byPeer) added += mergeRestoredIncoming('peer', id, rows)
      for (const [id, rows] of byGroup) added += mergeRestoredIncoming('group', id, rows)
    } else if (e.name === 'local.json') {
      const obj = JSON.parse(dec.decode(e.bytes)) as { aliases?: Record<string, string> }
      const cur = JSON.parse(localStorage.getItem(ALIASES_KEY) ?? '{}') as Record<string, string>
      // A name chosen on THIS device is never overwritten: the restore adds, it
      // does not correct.
      for (const [k, v] of Object.entries(obj.aliases ?? {})) if (!cur[k]) cur[k] = v
      localStorage.setItem(ALIASES_KEY, JSON.stringify(cur))
      window.dispatchEvent(new StorageEvent('storage', { key: ALIASES_KEY }))
    }
  }
  return { added, skipped: Math.max(0, total - added) }
}

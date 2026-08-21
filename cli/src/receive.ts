// The CLI's half of message-receiver.tsx: queue drain on the ack protocol,
// history append, delivered receipts. Same rules, no React:
//
//  * Drain as OUR device (`?ack=1&dev=N`), never a guessed one — a secondary
//    that drains device 1's queue is served rows it cannot open and its ack
//    then advances a cursor computed over another device's rows (see the
//    warning on myDeviceId).
//  * DURABLE BEFORE ACK. An ack tells the island it may let go of the rows,
//    and the decrypt has already advanced the ratchet — the queued ciphertext
//    can never be opened again. Vouching while the plaintext's only copy is a
//    pending write is how a fan-out copy vanished for good on 2026-08-20, so
//    every row is appended to the history jsonl (fsync-free but synchronous)
//    and printed BEFORE the ack goes out, and only rows that were processed
//    to their end are acked at all.

import fs from 'node:fs'
import { decryptIncoming, myDeviceId, noteInboundFrom, sendV2 } from '../../src/lib/signal-device'
import { Api, peerBundleFrom } from '../../src/lib/api'
import { encryptV1, type CarbonEnvelope, type Envelope, type WebIdentity } from '../../src/lib/crypto'
import { statePath } from './state'
import { err, out, peer } from './style'

/// Envelope kinds that are a MESSAGE (rendered, receipted, kept in history).
/// Everything else is control traffic: receipts, reactions, edits, sender-key
/// plumbing, federation gossip — reported on stderr, never stored in v1.
export const CONTENT_KINDS = new Set(['text', 'photo', 'video', 'file', 'location', 'poll'])

// Where a rendered line goes. Plain stdout for `send`/`watch` (stdout is
// data); interactive mode swaps in a printer that clears the readline prompt,
// writes the line, and redraws the prompt with whatever was being typed.
let emit: (line: string) => void = (line) => process.stdout.write(line)
export function setEmitter(fn: (line: string) => void): void {
  emit = fn
}

export function historyPath(uin: number): string {
  return statePath(`history-${uin}.jsonl`)
}

// Dedup by envelope id, seeded from the history file once per process — the
// island redelivers rows whose ack was lost, and the socket + drain overlap.
const seen = new Set<string>()
let seenLoadedFor: number | null = null

/// Mark an id this process just SENT, so the post-send drain does not echo the
/// self-carbon back onto stdout as if it were data from the peer.
export function markSent(id: string): void {
  seen.add(id)
}

function ensureSeen(uin: number): void {
  if (seenLoadedFor === uin) return
  seenLoadedFor = uin
  try {
    for (const line of fs.readFileSync(historyPath(uin), 'utf8').split('\n')) {
      if (!line) continue
      try {
        const id = (JSON.parse(line) as { envelope?: { id?: string } }).envelope?.id
        if (typeof id === 'string') seen.add(id)
      } catch {
        /* a torn tail line — the row it described was never vouched for */
      }
    }
  } catch {
    /* no history yet */
  }
}

export function stamp(): string {
  return new Date().toTimeString().slice(0, 8)
}

// ── group names ──────────────────────────────────────────────────────────────
//
// A drained group message used to print exactly like a 1:1 line, so a `send`
// that drained the backlog first looked as if the GROUP had answered the
// person being written to ("я отправил сообщение на 911 и получил сообщения
// из группы", 21.08). Every group line now carries the group's name — fetched
// once per process, lazily, on the first group row; before the fetch lands
// (or if it never does) the raw id stands in, which is still a label.
const groupNames = new Map<number, string>()
let groupNamesRequested = false

function groupLabel(identity: WebIdentity, gid: number): string {
  if (!groupNamesRequested) {
    groupNamesRequested = true
    void Api.groups(identity, false)
      .then((gs) => {
        for (const g of gs) groupNames.set(g.id, g.name)
      })
      .catch(() => {
        /* names stay numeric — the label still marks the line as a group's */
      })
  }
  const name = groupNames.get(gid)
  return out.dim(`[${name ?? `group ${gid}`}]`)
}

/// One printable line per envelope. Files/media never dump bytes — kind and
/// size only, per the design doc (the CLI sends/receives originals in v1.5).
function describeEnvelope(env: Envelope): string {
  switch (env.kind) {
    case 'text':
      return env.text
    case 'photo':
      return `<photo${env.caption ? ` "${env.caption}"` : ''}>`
    case 'video':
      return `<video ${env.durationSec}s${env.caption ? ` "${env.caption}"` : ''}>`
    case 'file':
      return `<file ${env.fname} ${env.size} bytes>`
    case 'location':
      return `<location ${env.lat},${env.lng}>`
    case 'poll':
      return `<poll "${env.q}">`
    default:
      return `<${(env as { kind: string }).kind}>`
  }
}

interface HistoryRecord {
  at: string
  from: number
  dev?: number
  host?: string
  /// Set on a carbon's inner envelope: where WE sent it from another device.
  to?: number
  /// The group the row was fanned out for; absent on 1:1 traffic.
  gid?: number
  envelope: Envelope
}

export function appendHistory(uin: number, rec: HistoryRecord): void {
  fs.appendFileSync(historyPath(uin), JSON.stringify(rec) + '\n', { mode: 0o600 })
}

export interface IngestResult {
  /// targetIDs of delivery/read receipts seen (the send command watches for
  /// its own message id here).
  receiptTargets: string[]
  /// UIN of the last PEER whose content message was ingested — interactive
  /// mode's auto-reply target when nobody was picked with /to yet.
  lastPeerFrom?: number
  /// How many content lines were printed. The send command uses it to decide
  /// whether the backlog just interleaved with its one job — that is the
  /// moment to point at the interactive mode.
  contentCount?: number
}

interface Decrypted {
  senderUIN: number
  senderDeviceId?: number
  senderHost?: string
  envelope: Envelope
}

/// File + print one decrypted envelope, and queue the delivered receipt for a
/// 1:1 content message from a peer. Shared by the queue drain and the live
/// socket path so both behave identically.
export async function ingestDecrypted(
  identity: WebIdentity,
  got: Decrypted,
  groupId: number | null | undefined,
  result: IngestResult,
): Promise<void> {
  ensureSeen(identity.uin)
  const env = got.envelope
  if (env.kind === 'carbon') {
    // A message we sent from another device, echoed to our own uin. The
    // origin device re-receives its own carbon — dedup by the inner id.
    if (got.senderUIN !== identity.uin) return
    const c = env as CarbonEnvelope
    const inner = c.env
    const id = (inner as { id?: string }).id
    if (typeof id === 'string') {
      if (seen.has(id)) return
      seen.add(id)
    }
    const dest = c.to != null ? `#${c.to}` : c.gid != null ? `group ${c.gid}` : '?'
    appendHistory(identity.uin, { at: new Date().toISOString(), from: identity.uin, to: c.to ?? undefined, envelope: inner })
    emit(`${out.dim(`[${stamp()}]`)} ${out.green(`me -> ${dest}`)}: ${describeEnvelope(inner)}\n`)
    return
  }
  if (env.kind === 'read' || env.kind === 'delivered') {
    const ids = Array.isArray(env.targetIDs) ? env.targetIDs.filter((t) => typeof t === 'string') : []
    result.receiptTargets.push(...ids)
    // Receipt-by-receipt noise is for debugging; the send command already says
    // "delivered" in its one summary line.
    if (process.env.RCQ_VERBOSE) {
      process.stderr.write(`[${stamp()}] ${env.kind} receipt from #${got.senderUIN}: ${ids.join(', ')}\n`)
    }
    return
  }
  if (!CONTENT_KINDS.has(env.kind)) {
    // Reactions, edits, typing and the rest of the control traffic the CLI
    // cannot apply yet. A line per skipped envelope read as a malfunction
    // ("и почему v1?", 21.08) — it is debugging detail, so it now lives with
    // the rest of the debugging detail.
    if (process.env.RCQ_VERBOSE) {
      process.stderr.write(err.dim(`[${stamp()}] ${env.kind} from #${got.senderUIN} (not supported by the CLI yet)`) + '\n')
    }
    return
  }
  const id = (env as { id?: string }).id
  if (typeof id === 'string') {
    if (seen.has(id)) return
    seen.add(id)
  }
  appendHistory(identity.uin, {
    at: new Date().toISOString(),
    from: got.senderUIN,
    dev: got.senderDeviceId,
    host: got.senderHost,
    gid: groupId ?? undefined,
    envelope: env,
  })
  const gtag = typeof groupId === 'number' ? `${groupLabel(identity, groupId)} ` : ''
  emit(`${out.dim(`[${stamp()}]`)} ${gtag}${peer(got.senderUIN, `#${got.senderUIN}`)}: ${describeEnvelope(env)}\n`)
  result.contentCount = (result.contentCount ?? 0) + 1
  if (got.senderUIN !== identity.uin) result.lastPeerFrom = got.senderUIN
  // Tell the sender it ARRIVED (moves their second tick). 1:1 content from a
  // peer only — a group message has as many recipients as members and one
  // tick cannot stand for all of them. The history append above already
  // landed, which is what makes the vouch honest.
  if (got.senderUIN !== identity.uin && groupId == null && typeof id === 'string') {
    await sendDeliveredReceipt(identity, got.senderUIN, id)
  }
}

/// Ship one delivery receipt, v=2 with a v=1 fallback, exactly like the web.
/// The OUTER type is 'read' on purpose: it is what every client in the field
/// already routes, and what the island already knows not to push. The INNER
/// kind is 'delivered'. Best-effort: a lost receipt costs a tick, never a
/// message.
async function sendDeliveredReceipt(identity: WebIdentity, peerUin: number, targetID: string): Promise<void> {
  const env: Envelope = { kind: 'delivered', targetIDs: [targetID] }
  try {
    const reached = await sendV2(identity, peerUin, env, 'read').catch(() => 0)
    if (reached === 0) {
      const info = await Api.userInfo(identity, peerUin).catch(() => null)
      if (!info?.identity_key || !info.signing_key) return
      await Api.sendSealed(identity, peerUin, encryptV1(env, identity, peerBundleFrom(info)), 'read')
    }
  } catch {
    /* the tick stays where it was */
  }
}

interface QueueRow {
  id: number
  envelope_type: string
  payload: string
  group_id: number | null
  to_device_id?: number | null
}

function fetchWithTimeout(url: string, init: RequestInit, ms = 30_000): Promise<Response> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  return fetch(url, { ...init, signal: ctl.signal }).finally(() => clearTimeout(timer))
}

/// One pass over the offline queue. Returns the receipts seen, or null when
/// the drain could not run (no device id / island unreachable) — nothing was
/// acked in that case, so the next drain redelivers.
export async function drainQueue(identity: WebIdentity): Promise<IngestResult | null> {
  const result: IngestResult = { receiptTargets: [] }
  const myDev = await myDeviceId(identity)
  // ⚠ No id, no drain — never guess (see the warning on myDeviceId).
  if (myDev === null) {
    process.stderr.write('drain skipped: this install has no device id yet\n')
    return null
  }
  let rows: QueueRow[]
  try {
    const res = await fetchWithTimeout(`${identity.apiBase}/messages/queue?ack=1&dev=${myDev}`, {
      headers: { Authorization: `Bearer ${identity.jwt}` },
    })
    if (!res.ok) {
      process.stderr.write(`drain failed: HTTP ${res.status}\n`)
      return null
    }
    rows = (await res.json()) as QueueRow[]
  } catch (e) {
    process.stderr.write(`drain failed: ${e instanceof Error ? e.message : e}\n`)
    return null
  }
  const directIds: number[] = []
  const groupIds: number[] = []
  for (const r of rows) {
    try {
      if (typeof r.to_device_id === 'number' && r.to_device_id !== myDev) {
        // A fan-out copy for a sibling device: encrypted against a ratchet
        // that lives there. No decrypt attempted; acked away below. An island
        // that predates the `dev` filter hands out every copy, so this is not
        // dead code.
      } else if (r.envelope_type === 'gmsg') {
        // Sender-keys group broadcast — the CLI carries no group chains in
        // v1. Terminal for this device (the chain will never appear), so it
        // is acked rather than left to wedge the cursor forever.
        process.stderr.write(err.dim(`[${stamp()}] group ${r.group_id}: <sender-keys broadcast — groups are not in the CLI yet>`) + '\n')
      } else {
        const got = await decryptIncoming(identity, r.payload)
        if (got) {
          // A decrypted envelope proves the sending DEVICE can talk to us —
          // its silence probe stands down (v=1 names no device).
          if (got.senderUIN !== identity.uin) noteInboundFrom(got.senderUIN, got.senderDeviceId)
          await ingestDecrypted(identity, got, r.group_id, result)
        }
      }
      // Processed to its end — including "decrypted to nothing", which is
      // terminal. Only a THROW leaves a row unacked; the cursor then stops in
      // front of it and the island redelivers from there next time.
      ;(typeof r.group_id === 'number' ? groupIds : directIds).push(r.id)
    } catch {
      /* transient failure — leave unacked for redelivery */
    }
  }
  if (directIds.length || groupIds.length) {
    // History is already on disk (synchronous appends above) — the ack may
    // now tell the island to let go. Best-effort like Android: a lost ack
    // redelivers and the id dedup absorbs the repeats. SAME `dev` as the
    // fetch: the cursor is computed over what was handed THAT device.
    await fetchWithTimeout(`${identity.apiBase}/messages/queue/ack?dev=${myDev}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${identity.jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ direct_ids: directIds, group_ids: groupIds }),
    }).catch(() => {})
  }
  return result
}

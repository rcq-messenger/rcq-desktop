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
import { handleSkdm, handleSknack, replayHeldGmsg } from '../../src/lib/sender-key-receive'
import {
  ackLiveGroupRow,
  drainGroupLog,
  GroupLogHttpError,
  islandHasGroupLog,
  type GroupLogRequest,
  type GroupLogRow,
  type StrikeEntry,
  type StrikeStore,
} from '../../src/lib/group-log'
import { foreignHost, groupLabel, isBlocked, isContact, knownName, labelForLine, peerLabel } from './directory'
import { chatLine, when } from './format'
import { openGroupPacket, replayStoredGroupPackets } from './held-groups'
import { tr } from './i18n'
import { appendState, readStateLines, statePath } from './state'
import { err, out, peer } from './style'
import { humanError } from './errors'

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

/// Whether a prompt is listening. The only thing it changes is how a line
/// tells you to go read a room: `/g 21` inside the loop, `rcq log g21` from a
/// script. Pointing somebody at a command that does not exist where they are
/// standing is worse than saying nothing.
let interactive = false
export function setInteractive(on: boolean): void {
  interactive = on
}

export function historyPath(uin: number): string {
  return statePath(historyName(uin))
}

/// The bare name, which is what the sealed state layer keys on.
export function historyName(uin: number): string {
  return `history-${uin}.jsonl`
}

// The one pass over the history file, which answers two questions: which
// envelope ids this account has already handled (the island redelivers rows
// whose ack was lost, and the socket + drain overlap), and which people it has
// already exchanged a message with.
const seen = new Set<string>()
/// Every uin with a 1:1 thread on this account. It is what makes the stranger
/// gate a per-THREAD question rather than one asked forever: whoever you have
/// written to, or heard from, is not somebody you can reach by accident.
const peers = new Set<number>()
/// The half of that we STARTED or answered. Auto-picking a reply target reads
/// this one: hearing from somebody is not the same as having chosen them, and
/// the loop used to point the next typed line at whoever wrote first.
const wroteTo = new Set<number>()
let indexLoadedFor: number | null = null

/// Mark an id this process just SENT, so the post-send drain does not echo the
/// self-carbon back onto stdout as if it were data from the peer.
export function markSent(id: string): void {
  seen.add(id)
}

function ensureHistoryIndex(uin: number): void {
  if (indexLoadedFor === uin) return
  indexLoadedFor = uin
  try {
    for (const line of readStateLines(historyName(uin))) {
      if (!line) continue
      try {
        const rec = JSON.parse(line) as HistoryRecord
        const id = (rec.envelope as { id?: string } | undefined)?.id
        if (typeof id === 'string') seen.add(id)
        notePeers(uin, rec)
      } catch {
        /* a torn tail line — the row it described was never vouched for */
      }
    }
  } catch {
    /* no history yet */
  }
}

/// A GROUP row is deliberately not a thread: sharing a room with somebody is
/// not the same as having written to them, and the gate asks about the latter.
function notePeers(uin: number, rec: HistoryRecord): void {
  if (rec.gid != null) return
  if (typeof rec.from === 'number' && rec.from !== uin) peers.add(rec.from)
  if (typeof rec.to === 'number' && rec.to !== uin) {
    peers.add(rec.to)
    // `from === us` is what a sent row looks like, carbons from the phone
    // included: those are our own words too.
    if (rec.from === uin) wroteTo.add(rec.to)
  }
}

/// Has this account and that uin ever exchanged a 1:1 message?
export function hasThreadWith(myUin: number, peerUin: number): boolean {
  ensureHistoryIndex(myUin)
  return peers.has(peerUin)
}

/// Have WE ever written to them?
export function hasWrittenTo(myUin: number, peerUin: number): boolean {
  ensureHistoryIndex(myUin)
  return wroteTo.has(peerUin)
}

/// Status that must be said but not repeated: a receipt that cannot go out
/// fails once per message on a dead network, and a line each would bury the
/// conversation it is reporting on.
const said = new Set<string>()
function sayOnce(key: string, line: string): void {
  if (said.has(key)) return
  said.add(key)
  process.stderr.write(err.dim(line) + '\n')
}

/// `[Работа]`, or `[group 21]` when this account has never listed its groups.
/// The name comes from the warm snapshot (see directory.ts): the fetch that
/// used to back this ran lazily and un-awaited, so the FIRST group line of
/// every process printed the raw id by construction.
function groupTag(myUin: number, gid: number): string {
  return out.dim(`[${groupLabel(myUin, gid)}]`)
}

/// Rooms, and how much of one belongs on a terminal.
///
/// "ввёл rcq и вижу сообщения группы - а если групп будет десятки?" (founder,
/// 21.08). Both halves of that are right: a room you are reading should print,
/// and thirty rooms you are not should not. So exactly one room is OPEN at a
/// time (`/g`), that one prints line by line like any conversation, and every
/// other room keeps a count and says so at most once a minute. The content is
/// on disk either way: `/log` and `rcq log g21` read it back.
///
/// `'all'` is `rcq watch --groups`: a stream feeding a log or a bridge wants
/// every room, and nothing is reading it at a prompt to be flooded.
let openGroup: number | 'all' | null = null
/// gid -> messages that have arrived without being printed.
const groupUnread = new Map<number, number>()
/// gid -> when its badge was last shown.
const groupAnnounced = new Map<number, number>()
/// A busy room must not narrate itself. One line, then quiet.
const ANNOUNCE_MS = 60_000

/// Point the reader at a room. Its backlog stops being a badge and starts
/// being a conversation.
export function setOpenGroup(gid: number | 'all' | null): void {
  openGroup = gid
  if (typeof gid === 'number') {
    groupUnread.delete(gid)
    groupAnnounced.delete(gid)
  }
}

/// How many messages a room has been holding, for the recap when it opens: a
/// badge that said "+40 new" and then shows eight lines is a badge that lied.
export function unreadIn(gid: number): number {
  return groupUnread.get(gid) ?? 0
}

/// Unread counts per group, for the room list.
export function unreadByGroup(): Map<number, number> {
  return new Map(groupUnread)
}

/// Print the badge for every room holding unread traffic, subject to the
/// once-a-minute rule. Called at the end of a drain and after live delivery,
/// so the same line comes out of `rcq watch`, `rcq send` and the prompt.
///
/// ⚠ stderr, not `emit`. A badge is a count of things that did NOT print: it
/// is status, and stdout is where `rcq watch | ...` reads messages. The old
/// group summary went to stdout and put a line no parser could use in the
/// middle of the data. Interactive mode still shows it: its stderr is routed
/// through the same above-the-prompt printer.
export function announceGroupNews(myUin: number): void {
  const now = Date.now()
  for (const [gid, n] of groupUnread) {
    if (n <= 0) continue
    const last = groupAnnounced.get(gid)
    if (last !== undefined && now - last < ANNOUNCE_MS) continue
    groupAnnounced.set(gid, now)
    const how = interactive ? tr('group.readInteractive', { gid }) : tr('group.readOneShot', { gid })
    const room = groupLabel(myUin, gid)
    process.stderr.write(err.dim(`[${when()}] [${room}] ${tr('group.unread', { n, how })}`) + '\n')
  }
}

/// One peer per process gets the "you do not know this person" line. Every
/// line after that would only be noise: the label already says who they are.
const strangerNoted = new Set<number>()

/// One printable line per envelope. Files/media never dump bytes — kind and
/// size only, per the design doc (the CLI sends/receives originals in v1.5).
export function describeEnvelope(env: Envelope): string {
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

export interface HistoryRecord {
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
  // One envelope per line on a sealed dir, so the file stays append-only.
  appendState(historyName(uin), JSON.stringify(rec))
  // Keep the in-memory index level with the file: the message just written IS
  // the thread, and the gate must not ask about this peer again.
  if (indexLoadedFor === uin) notePeers(uin, rec)
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
  /// The Ed25519 key the seal authenticated. A sender-key chain is only worth
  /// storing when it is BOUND to one, so a stranger cannot hand us a chain in
  /// somebody else's name.
  senderSigningKey?: string
  envelope: Envelope
}

/// File + print one decrypted envelope, and queue the delivered receipt for a
/// 1:1 content message from a peer. Shared by the queue drain and the live
/// socket path so both behave identically.
///
/// `receivedAt` is when the ISLAND took the message, off the queue row. Absent
/// for live traffic, which is happening now. It decides both the printed clock
/// and the history row's stamp: without it a two-day backlog prints, and is
/// filed, as if all of it had been said this second.
export async function ingestDecrypted(
  identity: WebIdentity,
  got: Decrypted,
  groupId: number | null | undefined,
  result: IngestResult,
  receivedAt?: Date,
): Promise<void> {
  ensureHistoryIndex(identity.uin)
  const at = receivedAt ?? new Date()
  const env = got.envelope
  // Their island when it is not ours, undefined otherwise. Read it once here:
  // `got.senderHost` on its own is set for local v=1 senders too (see
  // foreignHost), and every use below turns on the difference.
  const host = foreignHost(identity, got.senderHost)
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
    const dest =
      c.to != null
        ? await labelForLine(identity, c.to)
        : c.gid != null
          ? `[${groupLabel(identity.uin, c.gid)}]`
          : '?'
    // ⚠ The gid rides along. Without it a message we posted to a room from the
    // phone was filed as a 1:1 row addressed to nobody, so the room's own log
    // was missing our half of every conversation in it.
    appendHistory(identity.uin, {
      at: at.toISOString(),
      from: identity.uin,
      to: c.to ?? undefined,
      gid: c.gid ?? undefined,
      envelope: inner,
    })
    emit(chatLine(at, out.green(`me -> ${dest}`), describeEnvelope(inner)) + '\n')
    return
  }
  // ⚠ THE BLOCK IS ENFORCED HERE, AND NOWHERE ELSE IT CAN BE.
  //
  // `/block` writes the flag to the island, and there it does stop contact
  // requests and group adds, which is every path where the island knows who
  // is asking. A MESSAGE is not one of those paths: sealed sender means the
  // island cannot see the sender, so it cannot drop anything on our behalf.
  // Only the party holding the key can, right after the decrypt names them.
  // Android and the web have done exactly this from the start; the console
  // never did, so a blocked person kept printing into the reader's face while
  // the roster said "blocked" next to their name.
  //
  // Content only, and silently: no line, no history row, no delivered
  // receipt (the caller still acks the queue row, so it does not come back).
  // Control frames are deliberately left alone — dropping a group frame from
  // a blocked member desynchronises the room for everybody in it.
  if (CONTENT_KINDS.has(env.kind) && isBlocked(identity.uin, got.senderUIN)) return
  if (env.kind === 'read' || env.kind === 'delivered') {
    const ids = Array.isArray(env.targetIDs) ? env.targetIDs.filter((t) => typeof t === 'string') : []
    result.receiptTargets.push(...ids)
    // Receipt-by-receipt noise is for debugging; the send command already says
    // "delivered" in its one summary line.
    if (process.env.RCQ_VERBOSE) {
      const from = peerLabel(identity.uin, got.senderUIN, host)
      process.stderr.write(`[${when(at)}] ${env.kind} receipt from ${from}: ${ids.join(', ')}\n`)
    }
    return
  }
  // Sender-key plumbing: never rendered, and the reason group messages open at
  // all. SKDM hands us the chain a broadcast is sealed under (bound to the
  // authenticated sender); SKNACK asks us to re-hand ours to somebody who
  // missed it. Both ride the ordinary per-member sealed path, which is why
  // they arrive here rather than in the gmsg branch of the drain.
  if (env.kind === 'skdm') {
    const skdm = env as unknown as { gid: number; kid: string; e: number; i: number; ck: string }
    if (handleSkdm(identity.uin, got.senderUIN, got.senderSigningKey, skdm) && typeof skdm.kid === 'string') {
      // A live broadcast can outrun its own chain (a drain cannot: the island
      // serves skdm rows first). Replay whatever was held for this kid through
      // the normal decrypt path, in arrival order.
      for (const m of await replayHeldGmsg(identity, skdm.kid).catch(() => [])) {
        // Held in MEMORY, so it arrived seconds ago: now is the honest stamp.
        await ingestDecrypted(identity, { senderUIN: m.senderUIN, envelope: m.envelope }, m.gid, result)
      }
      // And the disk half: a broadcast this box could not open days ago, in
      // another process, whose chain has just walked in.
      await replayStored(identity, result)
    }
    return
  }
  if (env.kind === 'sknack') {
    await handleSknack(identity, got.senderUIN, env as unknown as { gid: number; kid: string })
    return
  }
  if (!CONTENT_KINDS.has(env.kind)) {
    // Reactions, edits, typing and the rest of the control traffic the CLI
    // cannot apply yet. A line per skipped envelope read as a malfunction
    // ("и почему v1?", 21.08) — it is debugging detail, so it now lives with
    // the rest of the debugging detail.
    if (process.env.RCQ_VERBOSE) {
      const from = peerLabel(identity.uin, got.senderUIN, host)
      process.stderr.write(err.dim(`[${when(at)}] ${env.kind} from ${from} (not supported by the CLI yet)`) + '\n')
    }
    return
  }
  const id = (env as { id?: string }).id
  if (typeof id === 'string') {
    if (seen.has(id)) return
    seen.add(id)
  }
  appendHistory(identity.uin, {
    at: at.toISOString(),
    from: got.senderUIN,
    dev: got.senderDeviceId,
    host: got.senderHost,
    gid: groupId ?? undefined,
    envelope: env,
  })
  if (typeof groupId === 'number') {
    // The open room reads like any other conversation; every other room keeps
    // a count (see the note above `openGroup`). Either way a group member must
    // never become the interactive auto-reply target: the founder's first run
    // auto-picked a random RCQ Beta poster as "replying to".
    if (openGroup === groupId || openGroup === 'all' || process.env.RCQ_VERBOSE) {
      const from = await labelForLine(identity, got.senderUIN, host)
      emit(chatLine(at, `${groupTag(identity.uin, groupId)} ${peer(got.senderUIN, from)}`, describeEnvelope(env)) + '\n')
      if (got.senderUIN !== identity.uin) result.contentCount = (result.contentCount ?? 0) + 1
      return
    }
    if (got.senderUIN !== identity.uin) {
      groupUnread.set(groupId, (groupUnread.get(groupId) ?? 0) + 1)
    }
    return
  }
  const from = await labelForLine(identity, got.senderUIN, host)
  emit(chatLine(at, peer(got.senderUIN, from), describeEnvelope(env)) + '\n')
  result.contentCount = (result.contentCount ?? 0) + 1
  if (got.senderUIN !== identity.uin) result.lastPeerFrom = got.senderUIN
  // Somebody who is in no list of yours just reached you. Said once per peer,
  // beside their name rather than instead of it: the open mailbox is the
  // design, being unable to tell a contact from a stranger is not.
  // A cross-island peer is never in the island's contacts table (there is no
  // such row to have), so for them "known" is a saved cross-island contact.
  const known = host
    ? knownName(identity.uin, got.senderUIN, host) !== null
    : isContact(identity.uin, got.senderUIN)
  if (got.senderUIN !== identity.uin && !known) {
    if (!strangerNoted.has(got.senderUIN)) {
      strangerNoted.add(got.senderUIN)
      process.stderr.write(err.dim(tr('inbound.stranger', { who: from })) + '\n')
    }
  }
  // Tell the sender it ARRIVED (moves their second tick). 1:1 content from a
  // peer only — a group message has as many recipients as members and one
  // tick cannot stand for all of them. The history append above already
  // landed, which is what makes the vouch honest.
  //
  // ⚠ Same-island only. A cross-island sender's uin belongs to THEIR island;
  // posting a receipt for it here addresses whoever happens to hold that
  // number on ours, which is a stranger being told something about a message
  // they never sent. The right destination needs the federation send path the
  // CLI does not have yet, so the tick simply stays where it is.
  if (
    got.senderUIN !== identity.uin &&
    groupId == null &&
    !host &&
    typeof id === 'string'
  ) {
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
      if (!info?.identity_key || !info.signing_key) {
        // No keys to seal to, so there is no receipt to send. Same one line as
        // a failure, because to the person waiting on a tick it is one.
        sayOnce('receipt', tr('fail.receipt'))
        return
      }
      await Api.sendSealed(identity, peerUin, encryptV1(env, identity, peerBundleFrom(info)), 'read')
    }
  } catch {
    // The peer keeps one tick on a message we are reading right now. Cheap to
    // lose, but not a thing to hide: said once, then the network speaks for
    // itself.
    sayOnce('receipt', tr('fail.receipt'))
  }
}

/// Retry the broadcasts held on disk and file whatever opens. Shared by the
/// two moments it can pay off: the start of a drain (a chain may have arrived
/// while this box was off) and the end of one that carried an SKDM.
async function replayStored(identity: WebIdentity, result: IngestResult): Promise<void> {
  for (const m of await replayStoredGroupPackets(identity).catch(() => [])) {
    // A packet held on disk may be days old: it keeps the time it landed.
    await ingestDecrypted(identity, { senderUIN: m.senderUIN, envelope: m.envelope }, m.gid, result, new Date(m.at))
  }
}

/// One live group broadcast off the socket. Same path as the drain's, so a
/// room reads identically whether the message arrived now or last week.
///
/// `seq` is the row's place in the room's log (Stage 5), on the frame when
/// the island logged the post. After the packet is filed (or held on disk)
/// it is acked like a fetched row, so the next fetch does not re-serve it,
/// and only when it is the next row after what this process has vouched for
/// in that room (group-log.ts); a lost ack costs a re-served row, which the
/// id dedup absorbs.
export async function ingestGroupPacket(
  identity: WebIdentity,
  payloadB64: string,
  gid: number,
  result: IngestResult,
  seq?: number,
): Promise<void> {
  const got = await openGroupPacket(identity, payloadB64, gid)
  if (got) await ingestDecrypted(identity, { senderUIN: got.senderUIN, envelope: got.envelope }, gid, result)
  if (typeof seq === 'number') await ackLiveGroupRow(identity.apiBase, identity.uin, logRequestFor(identity), gid, seq)
}

interface QueueRow {
  id: number
  envelope_type: string
  payload: string
  group_id: number | null
  to_device_id?: number | null
  /// When the ISLAND took the message (ISO 8601). The field has always been on
  /// the row and the CLI never declared it, so a backlog printed and was filed
  /// with the clock of the moment it was read.
  received_at?: string
  // Stage 2 (core-metadata plan): the island now labels each row with its
  // retention/push class and a durable per-mailbox sequence. Read when present;
  // both fall back to the legacy `envelope_type` / `id`. The CURSOR stays on
  // `id` (the ack): `seq` is GAPPY per device (a sibling device consumes
  // numbers this one never sees), so a seq gap is not a missing message.
  cls?: number | null
  seq?: number | null
}

/// The island's stamp for a row, or undefined when it did not send one (an
/// older island): the caller then falls back to now, as it always did.
function rowTime(r: { received_at?: string }): Date | undefined {
  if (!r.received_at) return undefined
  const d = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(r.received_at) ? r.received_at : `${r.received_at}Z`)
  return Number.isNaN(d.getTime()) ? undefined : d
}

/// The queue read gets a longer deadline than the global one in bootstrap.ts
/// (a month of backlog is a big answer), and passing a signal is also what
/// tells that wrapper to keep its hands off this call.
///
/// ⚠ AbortSignal.timeout, not a hand-rolled AbortController: an aborted
/// controller rejects as `AbortError: This operation was aborted`, which is
/// what "drain failed: This operation was aborted" used to be made of. The
/// timeout signal rejects as a TimeoutError, which errors.ts can say out loud.
function fetchWithTimeout(url: string, init: RequestInit, ms = 30_000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) })
}

/// One pass over the offline queue. Returns the receipts seen, or null when
/// the drain could not run (no device id / island unreachable) — nothing was
/// acked in that case, so the next drain redelivers.
export async function drainQueue(identity: WebIdentity): Promise<IngestResult | null> {
  const result: IngestResult = { receiptTargets: [] }
  // Broadcasts still waiting on a chain that may have been handed to us since
  // the last run (a chain that arrives DURING this pass is replayed by the
  // skdm branch of ingestDecrypted, on both the drain and the live socket).
  await replayStored(identity, result)
  const myDev = await myDeviceId(identity)
  // ⚠ No id, no drain — never guess (see the warning on myDeviceId).
  if (myDev === null) {
    process.stderr.write(tr('drain.noDevice') + '\n')
    return null
  }
  let rows: QueueRow[]
  try {
    const res = await fetchWithTimeout(`${identity.apiBase}/messages/queue?ack=1&dev=${myDev}`, {
      headers: { Authorization: `Bearer ${identity.jwt}` },
    })
    if (!res.ok) {
      process.stderr.write(tr('drain.http', { status: res.status }) + '\n')
      return null
    }
    rows = (await res.json()) as QueueRow[]
  } catch (e) {
    process.stderr.write(tr('drain.error', { err: humanError(e) }) + '\n')
    return null
  }
  const directIds: number[] = []
  const groupIds: number[] = []
  for (const r of rows) {
    try {
      await ingestQueueRow(identity, myDev, r, result)
      // Processed to its end — including "decrypted to nothing", which is
      // terminal. Only a THROW leaves a row unacked; the cursor then stops in
      // front of it and the island redelivers from there next time.
      ;(typeof r.group_id === 'number' ? groupIds : directIds).push(r.id)
    } catch (e) {
      // Left UNACKED on purpose, so the island redelivers it. But a row that
      // keeps failing is a message nobody can read and nobody was told about:
      // one line, with the reason, per row.
      process.stderr.write(
        err.dim(tr('drain.row', { id: r.id, err: humanError(e) })) + '\n',
      )
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
    }).catch((e: unknown) => {
      // Harmless once (the island redelivers and the id dedup absorbs it) and
      // worth knowing when it is every time: an ack that never lands is a
      // backlog that never shrinks.
      sayOnce('ack', tr('drain.ackFailed', { err: humanError(e) }))
    })
  }
  // Stage 5: the rooms, from their logs, on an island that keeps them. After
  // the legacy queue: whatever that queue still holds for this account was
  // written before the account's first log fetch, so this order prints the
  // backlog in the order it was said.
  await drainRoomLog(identity, myDev, result)
  // One badge per room instead of its whole feed (see the note on openGroup),
  // and one for both drains: a badge that counts half the backlog is a badge
  // that lied.
  announceGroupNews(identity.uin)
  return result
}

/// One row off the island, legacy queue or room log alike: the dispatch by
/// envelope_type that decides which decoder opens it. Throws only on a
/// TRANSIENT failure, which the caller answers by leaving the row unacked;
/// everything terminal, "decrypted to nothing" included, returns.
async function ingestQueueRow(
  identity: WebIdentity,
  myDev: number,
  r: { envelope_type: string; payload: string; group_id: number | null; to_device_id?: number | null; received_at?: string },
  result: IngestResult,
): Promise<void> {
  const at = rowTime(r)
  if (typeof r.to_device_id === 'number' && r.to_device_id !== myDev) {
    // A fan-out copy for a sibling device: encrypted against a ratchet
    // that lives there. No decrypt attempted; acked away by the caller. An
    // island that predates the `dev` filter hands out every copy, so this is
    // not dead code.
  } else if (r.envelope_type === 'gmsg') {
    // Sender-keys group broadcast: ONE ciphertext for the whole room,
    // opened with the chain its sender distributed. Not a sealed envelope,
    // so it never goes near decryptIncoming.
    //
    // ⚠ A row with no group id cannot be routed to a room and is acked
    // away by the caller; the island has never sent one, and guessing would
    // file the message under a room the sender did not choose.
    if (typeof r.group_id === 'number') {
      // Returns null when the chain has not reached us yet, and in that
      // case the raw packet is now on disk, so the caller's ack is honest.
      const got = await openGroupPacket(identity, r.payload, r.group_id)
      if (got) {
        await ingestDecrypted(identity, { senderUIN: got.senderUIN, envelope: got.envelope }, r.group_id, result, at)
      }
    }
  } else {
    const got = await decryptIncoming(identity, r.payload)
    if (got) {
      // A decrypted envelope proves the sending DEVICE can talk to us:
      // its silence probe stands down (v=1 names no device).
      if (got.senderUIN !== identity.uin) noteInboundFrom(got.senderUIN, got.senderDeviceId)
      await ingestDecrypted(identity, got, r.group_id, result, at)
    }
  }
}

/// The two room-log endpoints, with the same deadline as the queue read.
function logRequestFor(identity: WebIdentity): GroupLogRequest {
  return (path, body) =>
    fetchWithTimeout(`${identity.apiBase}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${identity.jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
}

/// The room-log strike ledger of one account, on disk (see drainRoomLog).
function strikeFile(uin: number): StrikeStore {
  const path = statePath(`group-log-strikes-${uin}.json`)
  return {
    read: () => {
      try {
        const raw = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, Partial<StrikeEntry>>
        const out: Record<string, StrikeEntry> = {}
        for (const [k, v] of Object.entries(raw)) {
          if (v && typeof v.sig === 'string' && typeof v.n === 'number') out[k] = { sig: v.sig, n: v.n }
        }
        return out
      } catch {
        return {}
      }
    },
    write: (strikes) => {
      try {
        fs.writeFileSync(path, JSON.stringify(strikes), { mode: 0o600 })
      } catch {
        /* an unwritable state dir is already being shouted about elsewhere */
      }
    },
  }
}

/// Stage 5 (core-metadata plan): on an island that keeps one log per room,
/// drain the rooms from their logs, next to the legacy queue. The rows carry
/// the same envelope types and payloads the legacy group rows carry, so they
/// go through the same dispatch, and the same rule holds for the ack: history
/// is appended synchronously above, a held broadcast is on disk, so the ack
/// may go out, per room over the contiguous prefix of what was processed
/// (see group-log.ts). An island without the capability is never asked: the
/// first fetch is also what marks this device a "log reader" there.
///
/// The strike ledger lives in a file: `rcq send` is a new process every time,
/// and a row that failed the same way on three RUNS must count as three
/// drains, or a v=2 row this box cannot open would pin the room on every
/// cron tick forever.
async function drainRoomLog(identity: WebIdentity, myDev: number, result: IngestResult): Promise<void> {
  if (!(await islandHasGroupLog(identity.apiBase))) return
  try {
    await drainGroupLog(
      identity.apiBase,
      identity.uin,
      logRequestFor(identity),
      async (row: GroupLogRow) => {
        try {
          await ingestQueueRow(
            identity,
            myDev,
            { envelope_type: row.envelope_type, payload: row.payload, group_id: row.gid, received_at: row.received_at },
            result,
          )
        } catch (e) {
          // Left unacked on purpose (the island re-serves it), and said out
          // loud, the same as a queue row: a row that keeps failing is a
          // message nobody can read and nobody was told about.
          process.stderr.write(err.dim(tr('drain.row', { id: `g${row.gid}/${row.seq}`, err: humanError(e) })) + '\n')
          throw e
        }
      },
      undefined,
      strikeFile(identity.uin),
    )
  } catch (e) {
    // Nothing was acked for the page that failed; the next drain re-serves it.
    if (e instanceof GroupLogHttpError) process.stderr.write(tr('drain.logHttp', { status: e.status }) + '\n')
    else process.stderr.write(tr('drain.logError', { err: humanError(e) }) + '\n')
  }
}

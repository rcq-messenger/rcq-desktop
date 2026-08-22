// rcq — console client, v1: scriptable plumbing (register/restore, contacts,
// 1:1 text both ways, receipts, queue drain, watch). See cli/README.md and
// docs/console-client-design.md.
//
// Output discipline: stdout carries DATA only (messages, the phrase, lists);
// status and log lines go to stderr. Exit codes: 0 ok, 1 error, 2 usage.

import './bootstrap'
import fs from 'node:fs'
import readline from 'node:readline'
import {
  createNewAccount,
  currentRecoveryPhrase,
  DEFAULT_API_BASE,
  loadStoredIdentity,
  mintSessionToken,
  persistIdentity,
  recoverFromPhrase,
  suggestNickname,
} from '../../src/lib/auth'
import { Api, setTokenRefresher, type Contact } from '../../src/lib/api'
import { getDevice, myDeviceId, setProvisionPolicy } from '../../src/lib/signal-device'
import type { WebIdentity } from '../../src/lib/crypto'
import { idbGet } from '../shims/signal-persist'
import {
  cachedContacts,
  cachedPending,
  groupById,
  groupSize,
  initDirectory,
  isContact,
  knownName,
  lookupUser,
  peerLabel,
  primeDirectory,
  refreshDirectory,
} from './directory'
import {
  advertiseSenderKeys,
  describeGroupError,
  listGroups,
  rosterFor,
  ruleRefusal,
  sendGroupText,
} from './groups'
import {
  drainQueue,
  hasThreadWith,
  historyPath,
  ingestDecrypted,
  ingestGroupPacket,
  setOpenGroup,
  type IngestResult,
} from './receive'
import { runInteractive } from './interactive'
import { logRowData, parseThread, readLog, type Thread } from './log'
import { cancelRequest, describeRequestFrame, loadRequests, respondTo, sendRequest } from './requests'
import { sendText } from './send'
import { isYes, strangerCheck } from './stranger'
import { RcqSocket } from './socket'
import { acquireStateLock } from './state'
import { decryptIncoming, noteInboundFrom } from '../../src/lib/signal-device'
import { currentLang, setLang, tr } from './i18n'
import { err, out } from './style'
import { noteUpdateIfAny } from './update-check'
import { CLI_VERSION } from './version'

// ★ Before anything can provision: a CLI on a server must never steal the
// account's primary slot from the phone (docs/console-client-design.md; the
// 2026-08-20 live test showed what a surprise re-claim does to peers'
// sessions). The web keeps its 'auto' default untouched.
setProvisionPolicy('secondary')

// A 401 mid-command mints a fresh token from the signing key and retries once
// — the same path that keeps a 30-day-old web session alive.
setTokenRefresher(async (id) => (await mintSessionToken(id)).token)

// ⚠ The order of the usage text is the pitch. `rcq` with no arguments IS the
// client (the live conversation), and everything under "for scripts" is
// plumbing for pipes and cron. The first printed usage led with a wall of
// subcommands, and the founder's own first session went send, then watch,
// then confusion before discovering the bare command ("другие команды вводят
// в заблуждение", 21.08). The text itself lives in i18n.ts, both languages.
const usage = (): string => tr('usage', { version: CLI_VERSION })

function die(msg: string, code = 1): never {
  process.stderr.write(`rcq: ${msg}\n`)
  process.exit(code)
}

function usageDie(msg?: string): never {
  if (msg) process.stderr.write(`rcq: ${msg}\n`)
  process.stderr.write(usage())
  process.exit(2)
}

/// Flags that stand alone, with no value after them. Everything else is
/// `--flag value`, and a value flag with nothing behind it stays a usage error.
const BOOL_FLAGS = new Set(['--yes', '--groups'])

/// Pull `--flag value` pairs out of argv; what remains are positionals.
function parseArgs(argv: string[]): { pos: string[]; opts: Map<string, string>; flags: Set<string> } {
  const pos: string[] = []
  const opts = new Map<string, string>()
  const flags = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      if (BOOL_FLAGS.has(a)) {
        flags.add(a)
        continue
      }
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) usageDie(tr('args.flagNeedsValue', { flag: a }))
      opts.set(a, v)
      i++
    } else {
      pos.push(a)
    }
  }
  return { pos, opts, flags }
}

function requireIdentity(): WebIdentity {
  const id = loadStoredIdentity()
  if (!id) die(tr('err.noAccount'))
  // ⚠ Before any store is read: this scopes every local key to the account and
  // warms the names off the last snapshot (see directory.ts).
  initDirectory(id.uin)
  return id
}

/// Seconds until a jwt expires, or -1 for anything unreadable. No signature
/// check — the island does that; this only decides whether to mint.
function jwtTtl(jwt: string): number {
  try {
    const body = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString()) as { exp?: number }
    return typeof body.exp === 'number' ? body.exp - Math.floor(Date.now() / 1000) : -1
  } catch {
    return -1
  }
}

/// The stored identity with a usable token. Minted not only when absent but
/// when expired or close to it: register persists a 30-day token, and a CLI
/// that only ever checked for presence worked perfectly for a month and then
/// rotted — the socket died 4401, drains logged 401, sends fell to v=1.
async function withToken(id: WebIdentity): Promise<WebIdentity> {
  if (id.jwt && jwtTtl(id.jwt) > 3600) return id
  const mint = await mintSessionToken(id)
  if (mint.dead) die(tr('err.sessionRefused'))
  if (!mint.token) {
    // Unreachable island but a token that is formally still alive: let the
    // command try with it rather than dying at the door.
    if (id.jwt && jwtTtl(id.jwt) > 0) return id
    die(tr('err.mintFailed'))
  }
  const fresh = { ...id, jwt: mint.token }
  persistIdentity(fresh)
  return fresh
}

function printPhraseBlock(uin: number): void {
  const phrase = currentRecoveryPhrase()
  process.stdout.write(`uin: ${uin}\n`)
  if (phrase) {
    process.stdout.write(`${tr('label.phrase')}: ${phrase.join(' ')}\n`)
    process.stderr.write(tr('phrase.keep'))
  }
}

async function cmdRegister(opts: Map<string, string>): Promise<void> {
  if (loadStoredIdentity()) die(tr('err.accountExists'))
  const nick = opts.get('--nick') ?? suggestNickname()
  const island = (opts.get('--island') ?? DEFAULT_API_BASE).replace(/\/+$/, '')
  const identity = await createNewAccount(nick, island)
  initDirectory(identity.uin)
  printPhraseBlock(identity.uin)
}

async function cmdRestore(pos: string[], opts: Map<string, string>): Promise<void> {
  const phrase = pos[0]
  if (!phrase) usageDie(tr('restore.needsPhrase'))
  const island = (opts.get('--island') ?? DEFAULT_API_BASE).replace(/\/+$/, '')
  const identity = await recoverFromPhrase(phrase, island)
  initDirectory(identity.uin)
  process.stdout.write(`uin: ${identity.uin}\n`)
  process.stderr.write(tr('restore.done') + '\n')
}

async function cmdWhoami(): Promise<void> {
  const id = requireIdentity()
  // Read the persisted device blob directly — whoami must work offline, and
  // getDevice() would try to provision.
  const blob = await idbGet<{ deviceId: number }>(`signal-device:${id.uin}`)
  // The nickname lives on the island, not in the identity — fetched
  // best-effort with the token already on disk, skipped cleanly offline
  // (whoami must never mint or hang; 'rcq nick' is where renames happen).
  let nick: string | null = null
  if (id.jwt) nick = await Api.myInfo(id).then((m) => m.nickname ?? null).catch(() => null)
  // Labels localize, VALUES never do: scripts read the right-hand side.
  process.stdout.write(
    `uin: ${id.uin}\n${nick ? `${tr('label.nickname')}: ${nick}\n` : ''}${tr('label.island')}: ${id.apiBase}\n${tr('label.device')}: ${blob ? blob.deviceId : '-'}\n`,
  )
}

/// Rename this account on the island. One field, not a profile editor — the
/// rest of the profile belongs to the visual clients.
async function cmdNick(pos: string[]): Promise<void> {
  const name = pos[0]?.trim()
  if (!name) usageDie(tr('nick.needsName'))
  const id = await withToken(requireIdentity())
  await Api.updateProfile(id, { nickname: name })
  process.stderr.write(tr('nick.done', { name }) + '\n')
}

async function cmdContacts(): Promise<void> {
  const id = await withToken(requireIdentity())
  let list: Contact[]
  try {
    list = await refreshDirectory(id)
  } catch (e) {
    // The roster is on disk from the last run that reached the island. A list
    // a few hours old beats a stack trace, and the note says which one this is
    // so nobody mistakes a cached row for a live one.
    list = cachedContacts(id.uin)
    process.stderr.write(err.dim(tr('fail.contacts', { err: e instanceof Error ? e.message : String(e) })) + '\n')
  }
  for (const c of list) {
    process.stdout.write(`${c.uin}\t${c.nickname}\t${c.status}${c.blocked ? '\tblocked' : ''}\n`)
  }
}

/// "Who is #396?" is the question the CLI could not answer, which is what made
/// warning about a stranger AFTER the message had gone useless. One row of
/// data on stdout (same shape as `contacts`), the reading of it on stderr.
async function cmdWho(pos: string[]): Promise<void> {
  const uin = Number(pos[0])
  if (!Number.isInteger(uin) || uin <= 0) usageDie(tr('who.needsUin'))
  const id = await withToken(requireIdentity())
  await primeDirectory(id)
  const got = await lookupUser(id, uin)
  if (got.state === 'missing') die(tr('stranger.missing', { uin }))
  const contact = isContact(id.uin, uin)
  const name = got.state === 'known' ? got.info.nickname : (knownName(id.uin, uin) ?? '')
  const status = got.state === 'known' ? got.info.status : ''
  process.stdout.write(`${uin}\t${name}\t${status}\t${contact ? 'contact' : 'stranger'}\n`)
  const notes = [
    contact ? tr('who.contact') : tr('who.stranger'),
    hasThreadWith(id.uin, uin) ? tr('who.thread') : tr('who.noThread'),
  ]
  if (got.state === 'unknown') notes.push(tr('who.unreachable', { uin }))
  process.stderr.write(err.dim(notes.join('; ')) + '\n')
}

async function cmdAdd(pos: string[]): Promise<void> {
  const uin = Number(pos[0])
  if (!Number.isInteger(uin) || uin <= 0) usageDie(tr('add.needsUin'))
  const id = await withToken(requireIdentity())
  // A request to a number nobody holds is a typo, and the island answers 404
  // to the request itself with nothing a person can read.
  if ((await lookupUser(id, uin)).state === 'missing') die(tr('stranger.missing', { uin }))
  const state = await sendRequest(id, uin)
  const who = peerLabel(id.uin, uin)
  // ⚠ The island auto-accepts when they had already asked for us, and answers
  // `state: "accepted"`. The old command threw the body away and said "request
  // sent", so the one case where adding WORKED read exactly like the case
  // where somebody now has to answer.
  process.stderr.write(
    (state === 'accepted' ? tr('add.mutual', { who }) : state === 'already' ? tr('add.already', { who }) : tr('add.sent', { who })) + '\n',
  )
  // stdout is the machine contract: one word for what actually happened.
  process.stdout.write(`${state}\n`)
}

/// Requests in both directions, one row each. `in`/`out` first so a script can
/// grep a side without parsing the rest.
async function cmdRequests(): Promise<void> {
  const id = await withToken(requireIdentity())
  const { incoming, outgoing } = await loadRequests(id)
  for (const r of incoming) process.stdout.write(`in\t${r.from_uin}\t${r.nickname}\tpending\n`)
  for (const r of outgoing) process.stdout.write(`out\t${r.to_uin}\t${r.nickname}\t${r.state}\n`)
  if (incoming.length === 0 && outgoing.length === 0) process.stderr.write(tr('req.none') + '\n')
}

async function cmdRespond(pos: string[], accept: boolean): Promise<void> {
  const uin = Number(pos[0])
  if (!Number.isInteger(uin) || uin <= 0) usageDie(tr(accept ? 'accept.needsUin' : 'decline.needsUin'))
  const id = await withToken(requireIdentity())
  const res = await respondTo(id, uin, accept)
  if (!res.ok) die(res.reason)
  const who = peerLabel(id.uin, uin)
  process.stderr.write((res.answer === 'accepted' ? tr('req.youAccepted', { who }) : tr('req.youDeclined', { who })) + '\n')
  process.stdout.write(`${res.answer}\n`)
}

/// Withdraw a request we sent, or dismiss one that was declined.
async function cmdCancel(pos: string[]): Promise<void> {
  const uin = Number(pos[0])
  if (!Number.isInteger(uin) || uin <= 0) usageDie(tr('cancel.needsUin'))
  const id = await withToken(requireIdentity())
  await cancelRequest(id, uin)
  process.stderr.write(tr('req.cancelled', { who: peerLabel(id.uin, uin) }) + '\n')
}

/// Look somebody up by name. Same row shape as `contacts`, because it answers
/// the same question one step earlier: you cannot write to a number you have
/// no way of finding.
async function cmdFind(pos: string[]): Promise<void> {
  const q = pos[0]?.trim()
  if (!q) usageDie(tr('find.needsQuery'))
  const id = await withToken(requireIdentity())
  const found = await Api.searchUsers(id, q)
  for (const u of found) process.stdout.write(`${u.uin}\t${u.nickname}\t${u.status}\n`)
  if (found.length === 0) process.stderr.write(tr('find.none', { q }) + '\n')
}

async function cmdBlock(pos: string[], on: boolean): Promise<void> {
  const uin = Number(pos[0])
  if (!Number.isInteger(uin) || uin <= 0) usageDie(tr('block.needsUin'))
  const id = await withToken(requireIdentity())
  await Api.blockContact(id, uin, on)
  const who = peerLabel(id.uin, uin)
  process.stderr.write((on ? tr('block.done', { who }) : tr('block.undone', { who })) + '\n')
  await refreshDirectory(id).catch(() => null)
}

/// Drop a contact on both sides. Asks first on a TTY, wants `--yes` from a
/// script: it is mutual and there is no undo except asking to be added back.
async function cmdRemove(pos: string[], flags: Set<string>): Promise<void> {
  const uin = Number(pos[0])
  if (!Number.isInteger(uin) || uin <= 0) usageDie(tr('remove.needsUin'))
  const id = await withToken(requireIdentity())
  await primeDirectory(id)
  const who = peerLabel(id.uin, uin)
  if (!flags.has('--yes')) {
    if (!process.stdin.isTTY || !process.stderr.isTTY) die(tr('remove.needsYes', { who }))
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    const answer = await new Promise<string>((r) => rl.question(tr('remove.confirm', { who }), r))
    rl.close()
    if (!isYes(answer)) die(tr('remove.cancelled'), 0)
  }
  await Api.removeContact(id, uin)
  process.stderr.write(tr('remove.done', { who }) + '\n')
  await refreshDirectory(id).catch(() => null)
}

/// The rooms this account is in. Rules ride along as raw tokens (`owner_only`,
/// `slowmode=30`, `no_links`) so a script can act on them; the reading of them
/// is the interactive `/g` list's job.
async function cmdGroups(): Promise<void> {
  const id = await withToken(requireIdentity())
  await primeDirectory(id)
  for (const g of listGroups(id.uin)) {
    const rules: string[] = []
    if (g.post_policy === 'owner_only') rules.push('owner_only')
    if ((g.slowmode_sec ?? 0) > 0) rules.push(`slowmode=${g.slowmode_sec}`)
    if (g.links_allowed === false) rules.push('no_links')
    if (g.files_allowed === false) rules.push('no_files')
    process.stdout.write(`${g.id}\t${g.name}\t${groupSize(g)}\t${rules.join(',')}\n`)
  }
}

/// Join an open group by id. A closed one refuses, and says so rather than
/// handing over a 403.
async function cmdJoin(pos: string[]): Promise<void> {
  const gid = Number((pos[0] ?? '').replace(/^g/i, ''))
  if (!Number.isInteger(gid) || gid <= 0) usageDie(tr('join.needsId'))
  const id = await withToken(requireIdentity())
  const preview = await Api.groupPreview(id, gid).catch(() => null)
  if (!preview) die(tr('join.noSuchGroup', { gid }))
  if (preview.is_closed) die(tr('join.closed', { name: preview.name }))
  const group = await Api.joinGroup(id, gid).catch((e: unknown) => die(tr('join.failed', { err: describeGroupError(e) })))
  await refreshDirectory(id).catch(() => null)
  process.stdout.write(`${group.id}\t${group.name}\n`)
  process.stderr.write(tr('join.done', { name: group.name }) + '\n')
}

/// What was already said, back out of the history file. Offline, instant, and
/// the only way to read a room the console kept a count for.
async function cmdLog(pos: string[]): Promise<void> {
  const id = requireIdentity()
  // ⚠ The FIRST positional is always the thread, never a count. `rcq log 396`
  // has to mean the conversation with #396: a bare number is a uin everywhere
  // else in this CLI, and one command reading it as "the last 396 lines" is
  // the kind of inconsistency that gets somebody the wrong file.
  let thread: Thread = null
  if (pos.length > 0) {
    thread = parseThread(pos[0])
    if (!thread) usageDie(tr('log.badThread', { what: pos[0] }))
  }
  const n = pos.length > 1 && Number(pos[1]) > 0 ? Number(pos[1]) : 20
  const rows = readLog(id.uin, thread, n)
  for (const r of rows) process.stdout.write(logRowData(r) + '\n')
  if (rows.length === 0) process.stderr.write(tr('log.empty') + '\n')
}

/// The one-shot half of the stranger gate; the interactive loop runs the same
/// check at its own prompt. False means the message must not go out.
///
/// A script cannot be asked anything, so it must say `--yes` up front. That is
/// deliberately a behaviour change for `rcq send <stranger>`: the old command
/// sent first and noted "not in your contacts" afterwards, which is a receipt
/// and not a decision.
async function strangerGate(identity: WebIdentity, uin: number, assumeYes: boolean): Promise<boolean> {
  const check = await strangerCheck(identity, uin)
  if (!check) return true
  for (const line of check.lines) process.stderr.write(err.yellow(line) + '\n')
  // Nobody is there. Sending would fail a second later inside the key lookup,
  // with an error about bundles that answers nothing.
  if (check.missing) return false
  if (assumeYes) return true
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    process.stderr.write(err.yellow(tr('stranger.needsYes', { who: check.label })) + '\n')
    return false
  }
  // Output on stderr: the question is status, and stdout stays data even here.
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  const answer = await new Promise<string>((r) => rl.question(tr('stranger.confirm', { who: check.label }), r))
  rl.close()
  return isYes(answer)
}

/// `rcq send g21 "text"`: one post into a room, for cron and pipes. No
/// receipts to wait for (a room has as many recipients as members and one tick
/// cannot stand for all of them), so this returns as soon as the fan-out is
/// away.
async function cmdSendGroup(gid: number, text: string): Promise<void> {
  const identity = await withToken(requireIdentity())
  // The POST itself is v=1 all the way (per-member seals and one broadcast, no
  // libsignal session), but the drain below needs this install's device id.
  await getDevice(identity).catch((e) => {
    process.stderr.write(tr('provision.v1only', { err: e instanceof Error ? e.message : String(e) }) + '\n')
  })
  await primeDirectory(identity)
  const base = groupById(identity.uin, gid)
  if (!base) die(tr('group.notMember', { gid }))
  const group = await rosterFor(identity, base).catch((e: unknown) => die(e instanceof Error ? e.message : String(e)))
  const refusal = ruleRefusal(identity, group, text)
  if (refusal) die(refusal)
  advertiseSenderKeys(identity)
  await drainQueue(identity)
  let sent: { id: string; mode: string }
  try {
    sent = await sendGroupText(identity, group, text)
  } catch (e) {
    die(tr('send.failed', { err: describeGroupError(e) }))
  }
  if (process.env.RCQ_VERBOSE) process.stderr.write(`mode: ${sent.mode}\n`)
  const word = tr('word.sent')
  process.stdout.write(process.stdout.isTTY ? `${out.green('✓')} ${word}\n` : `${word}\n`)
}

async function cmdSend(pos: string[], flags: Set<string>): Promise<void> {
  const target = pos[0] ?? ''
  const text = pos[1]
  // A room is `g<id>`; anything else is a uin. Unambiguous in both directions,
  // and the same spelling `rcq log g21` uses.
  if (/^g\d+$/i.test(target) && text) return cmdSendGroup(Number(target.slice(1)), text)
  const uin = Number(target)
  if (!Number.isInteger(uin) || uin <= 0 || !text) usageDie(tr('send.needsArgs'))
  const identity = await withToken(requireIdentity())
  await getDevice(identity).catch((e) => {
    // v=1 still works without a libsignal device; say so rather than dying.
    process.stderr.write(tr('provision.v1only', { err: e instanceof Error ? e.message : String(e) }) + '\n')
  })
  // The roster, for the gate below and for the names on every line the drain
  // is about to print. Replaces the contacts fetch this command already paid
  // for, and persists it, so the next run starts warm.
  await primeDirectory(identity)
  // The drain below opens group broadcasts, so the account may say so.
  advertiseSenderKeys(identity)
  // The island's mailbox is open by design (UIN culture: anyone can write
  // first, the recipient decides what to do with strangers). What is not by
  // design is doing it by accident: a typo'd uin is one keystroke.
  if (!(await strangerGate(identity, uin, flags.has('--yes')))) die(tr('stranger.cancelled'))
  const backlog = await drainQueue(identity)
  let sent: { id: string; mode: string }
  try {
    sent = await sendText(identity, uin, text)
  } catch (e) {
    die(tr('send.failed', { err: e instanceof Error ? e.message : String(e) }))
  }
  // One more drain to pick up an instant receipt from a peer that is online.
  await new Promise((r) => setTimeout(r, 2000))
  const drained = await drainQueue(identity)
  const delivered = drained?.receiptTargets.includes(sent.id) ?? false
  // `delivered` / `sent`, one word — the machine contract. The transport mode
  // and device count are protocol detail ("ненормально что показывает скольким
  // девайсам", 21.08): verbose-only, and on stderr where detail lives.
  if (process.env.RCQ_VERBOSE) process.stderr.write(`mode: ${sent.mode}\n`)
  const word = delivered ? tr('word.delivered') : tr('word.sent')
  process.stdout.write(process.stdout.isTTY ? `${out.green('✓')} ${word}\n` : `${word}\n`)
  // The backlog just interleaved with the one thing this command was asked to
  // do — which is exactly the confusion the interactive mode does not have.
  if (((backlog?.contentCount ?? 0) + (drained?.contentCount ?? 0)) > 0 && process.stdout.isTTY) {
    process.stderr.write(err.dim(tr('send.tip')) + '\n')
  }
}

async function cmdWatch(flags: Set<string>): Promise<void> {
  const identity = await withToken(requireIdentity())
  // A stream feeding a log or a bridge wants the rooms too, and there is no
  // prompt here to flood. Off by default: `watch` on a screen is a 1:1 surface
  // and thirty rooms would bury it, same rule as the interactive badges.
  if (flags.has('--groups')) setOpenGroup('all')
  await getDevice(identity).catch((e) => {
    process.stderr.write(tr('provision.v1receive', { err: e instanceof Error ? e.message : String(e) }) + '\n')
  })
  // Correct the live-frame device filter from the saved blob even when the
  // provision above failed: until then currentDeviceId() answers 1 (the
  // phone's id) and frames for OUR device would be dropped on the floor.
  await myDeviceId(identity).catch(() => null)
  // Names before the first line, not after it (see directory.ts).
  await primeDirectory(identity)
  // This stream opens group broadcasts, so the account may say so (see the
  // warning on advertiseSenderKeys).
  advertiseSenderKeys(identity)
  // The backlog first, socket second — and keep draining on a timer while no
  // socket is open. A connect-only drain delivers nothing, forever, on a
  // network that answers every HTTPS request and kills every WebSocket.
  await drainQueue(identity)
  const liveOut: IngestResult = { receiptTargets: [] }
  // No device to open it with yet: the same envelope sits in the queue, and
  // the reconnect drain delivers it. Said out loud all the same: a silent
  // catch here is a message that never appeared and never will be mentioned.
  const liveFailed = (e: unknown): void => {
    process.stderr.write(err.dim(tr('fail.live', { err: e instanceof Error ? e.message : String(e) })) + '\n')
  }
  const sock = new RcqSocket(identity, {
    onSealed: (frame) => {
      void (async () => {
        const got = await decryptIncoming(identity, frame.payload)
        if (!got) return
        if (got.senderUIN !== identity.uin) noteInboundFrom(got.senderUIN, got.senderDeviceId)
        await ingestDecrypted(identity, got, frame.group_id, liveOut)
      })().catch(liveFailed)
    },
    onGroup: (frame) => {
      void ingestGroupPacket(identity, frame.payload, frame.group_id, liveOut).catch(liveFailed)
    },
    onControl: (frame) => {
      const line = describeRequestFrame(identity, frame)
      if (line) process.stderr.write(err.yellow(line) + '\n')
    },
    onOpen: () => {
      // Every (re)connect drains: whatever queued while the socket was down
      // is covered by nothing else. The id dedup absorbs the overlap.
      void drainQueue(identity)
    },
    onAuthRejected: () => {
      die(tr('err.sessionRejected'))
    },
  })
  sock.start()
  const poll = setInterval(() => {
    if (!sock.isOpen) void drainQueue(identity)
  }, 30_000)
  process.stderr.write(tr('watch.hello', { uin: identity.uin }) + '\n')
  const waiting = cachedPending(identity.uin)
  if (waiting.length > 0) process.stderr.write(err.yellow(tr('req.waiting', { n: waiting.length })) + '\n')
  void noteUpdateIfAny()
  const bye = (): void => {
    clearInterval(poll)
    sock.stop()
    process.stderr.write('\n' + tr('bye') + '\n')
    process.exit(0)
  }
  process.on('SIGINT', bye)
  // A person at a TTY who types into watch is trying to ANSWER — the founder
  // did exactly that ("rcq send 911 ... не работает в режиме ws"). watch stays
  // read-only (it is the scriptable stream), but it now says where the
  // conversation lives instead of eating the line. The readline also swallows
  // Ctrl+C/Ctrl+D into events, so both are wired back to the same exit.
  if (process.stdin.isTTY && process.stderr.isTTY) {
    process.stderr.write(err.dim(tr('watch.readonly')) + '\n')
    const rl = readline.createInterface({ input: process.stdin })
    rl.on('line', (l) => {
      if (l.trim()) process.stderr.write(err.dim(tr('watch.readonlyTyped')) + '\n')
    })
    rl.on('SIGINT', bye)
    rl.on('close', bye)
  }
}

/// `rcq lang` prints the active language (stdout, one word, scriptable) plus
/// its usage; `rcq lang en|ru` remembers the choice in the state dir. Works
/// with no account and no lock: it never touches the ratchet.
function cmdLang(pos: string[]): void {
  const pick = pos[0]
  if (pick === undefined) {
    process.stdout.write(`${currentLang()}\n`)
    process.stderr.write(tr('lang.usage') + '\n')
    return
  }
  if (pick !== 'en' && pick !== 'ru') usageDie(tr('lang.invalid', { arg: pick }))
  setLang(pick)
  process.stderr.write(tr('lang.set', { lang: pick }) + '\n')
}

async function cmdExport(): Promise<void> {
  const id = requireIdentity()
  const file = historyPath(id.uin)
  let lines = 0
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length
  } catch {
    /* no history yet */
  }
  process.stdout.write(`${file}\t${lines} messages\n`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  // An EMPTY first argument is not a command (`rcq "$CMD"` with CMD unset is
  // an ordinary shell shape). Normalised here so the keep-alive check at the
  // bottom of this file, which reads process.argv directly, cannot disagree
  // with this one about whether interactive mode was entered.
  const cmd = argv[0] === '' ? undefined : argv[0]
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(usage())
    process.exit(0)
  }
  if (cmd === '--version' || cmd === '-V' || cmd === 'version') {
    // Version on stdout (the machine contract), update notice on stderr.
    // Forced: someone asking for the version explicitly wants the answer
    // fresh, cache or no cache.
    process.stdout.write(`rcq v${CLI_VERSION}\n`)
    await noteUpdateIfAny(true)
    process.exit(0)
  }
  // No command on a TTY is the interactive mode (the founder's daily spell);
  // no command on a PIPE is still an error — a script that forgot its verb
  // must not hang on a hidden prompt.
  if (!cmd) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) usageDie(tr('args.noCommand'))
    acquireStateLock()
    // Fire-and-forget: the daily driver is where an update notice earns its
    // keep, and it must never delay the prompt.
    void noteUpdateIfAny()
    return runInteractive(await withToken(requireIdentity()))
  }
  // One process per state dir for anything that can touch the ratchet store —
  // see acquireStateLock. whoami/export/log are read-only peeks and lang only
  // writes its own one-word file (atomic rename): all four stay lock-free.
  if (cmd !== 'whoami' && cmd !== 'export' && cmd !== 'lang' && cmd !== 'log') acquireStateLock()
  const { pos, opts, flags } = parseArgs(argv.slice(1))
  switch (cmd) {
    case 'register':
      return cmdRegister(opts)
    case 'restore':
      return cmdRestore(pos, opts)
    case 'whoami':
      return cmdWhoami()
    case 'nick':
      return cmdNick(pos)
    case 'contacts':
      return cmdContacts()
    case 'who':
      return cmdWho(pos)
    case 'find':
      return cmdFind(pos)
    case 'add':
      return cmdAdd(pos)
    case 'requests':
      return cmdRequests()
    case 'accept':
      return cmdRespond(pos, true)
    case 'decline':
      return cmdRespond(pos, false)
    case 'cancel':
      return cmdCancel(pos)
    case 'block':
      return cmdBlock(pos, true)
    case 'unblock':
      return cmdBlock(pos, false)
    case 'remove':
      return cmdRemove(pos, flags)
    case 'groups':
      return cmdGroups()
    case 'join':
      return cmdJoin(pos)
    case 'log':
      return cmdLog(pos)
    case 'send':
      return cmdSend(pos, flags)
    case 'watch':
      return cmdWatch(flags)
    case 'export':
      return cmdExport()
    case 'lang':
      return cmdLang(pos)
    default:
      usageDie(tr('args.unknownCmd', { cmd }))
  }
}

main().then(
  () => {
    // `watch` and the no-arg interactive mode stay alive on their socket;
    // every other command is done when its promise settles.
    const cmd = process.argv[2] || undefined
    if (cmd !== undefined && cmd !== 'watch') process.exit(0)
  },
  (e) => die(e instanceof Error ? e.message : String(e)),
)

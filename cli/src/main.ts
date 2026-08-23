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
  noteVaultChanged,
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
import { canonical } from './aliases'
import {
  clearProxyUrl,
  normalizeProxyUrl,
  probeEnvIgnored,
  probeThroughProxy,
  readProxyConfig,
  readProxyUrl,
  redactProxyUrl,
  runProbe,
  saveProxyUrl,
} from './env-proxy'
import {
  activeProxyLabel,
  describeRoute,
  describeRung,
  ensureRoute,
  lastWalk,
  noteRouteTrouble,
  walkLadder,
} from './routes'
import {
  effectiveSources,
  frontHost,
  probeUrl,
  refresh as refreshRelayConfig,
  relays as relayList,
  usingRemote,
  version as relayConfigVersion,
} from './relay-config'
import { buildSingBox, DEFAULT_LOCAL_PORT, fetchBridges, findSingBox } from './singbox'
import { currentLang, LANG_CODES, normalizeLang, setLang, tr } from './i18n'
import { err, out } from './style'
import { noteUpdateIfAny } from './update-check'
import { CLI_VERSION } from './version'
import { humanError, isTransportFailure } from './errors'

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
const usage = (): string => tr('usage', { version: CLI_VERSION, codes: LANG_CODES })

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
const BOOL_FLAGS = new Set([
  '--yes',
  '--groups',
  '--test',
  '--no-test',
  // rcq routes
  '--probe',
  '--refresh',
  '--singbox',
  '--bridges',
  '--onion',
  '--no-onion',
])

/// Commands that never name the island, so the route ladder is not engaged
/// for them. `routes` engages its own (and may be asked to walk it);
/// `proxy`/`__probe` deliberately run outside the proxy they configure.
const ROUTE_FREE = new Set(['lang', 'log', 'export', 'proxy', '__probe', 'routes'])

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
  // The proxy line is printed only when there is one, and REDACTED: it is the
  // answer to "am I actually behind Tor right now", and it must not be the
  // reason a proxy password ends up in a screenshot.
  const proxy = readProxyUrl()
  process.stdout.write(
    `uin: ${id.uin}\n${nick ? `${tr('label.nickname')}: ${nick}\n` : ''}${tr('label.island')}: ${id.apiBase}\n${tr('label.device')}: ${blob ? blob.deviceId : '-'}\n${proxy ? `${tr('label.proxy')}: ${redactProxyUrl(proxy)}\n` : ''}`,
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
    process.stderr.write(err.dim(tr('fail.contacts', { err: humanError(e) })) + '\n')
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
  const groups = listGroups(id.uin)
  for (const g of groups) {
    const rules: string[] = []
    if (g.post_policy === 'owner_only') rules.push('owner_only')
    if ((g.slowmode_sec ?? 0) > 0) rules.push(`slowmode=${g.slowmode_sec}`)
    if (g.links_allowed === false) rules.push('no_links')
    if (g.files_allowed === false) rules.push('no_files')
    process.stdout.write(`${g.id}\t${g.name}\t${groupSize(g)}\t${rules.join(',')}\n`)
  }
  // A room can now be left from here (the founder called being unable to a
  // trap). The list itself is machine data on stdout; the how-to is status.
  if (groups.length > 0) process.stderr.write(err.dim(tr('groups.leaveHint')) + '\n')
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

/// Leave a room. The console could join and never leave, which the founder
/// called a trap: leaving is removing yourself from the roster (the same call
/// the web's group menu makes). A failure is said, not swallowed.
async function cmdLeave(pos: string[]): Promise<void> {
  const gid = Number((pos[0] ?? '').replace(/^g/i, ''))
  if (!Number.isInteger(gid) || gid <= 0) usageDie(tr('leave.needsId'))
  const id = await withToken(requireIdentity())
  await primeDirectory(id)
  const base = groupById(id.uin, gid)
  if (!base) die(tr('group.notMember', { gid }))
  try {
    await Api.removeGroupMember(id, gid, id.uin)
  } catch (e) {
    die(tr('leave.failed', { err: describeGroupError(e) }))
  }
  await refreshDirectory(id).catch(() => null)
  process.stdout.write(`${gid}\tleft\n`)
  process.stderr.write(tr('leave.done', { name: base.name }) + '\n')
}

/// Make a room and, optionally, seed it with people by uin. Prints the new id
/// on stdout so a script can pipe it straight into `rcq invite` or `rcq send`.
async function cmdCreate(pos: string[]): Promise<void> {
  const name = pos[0]?.trim()
  if (!name) usageDie(tr('create.needsName'))
  const members = pos.slice(1).map(Number).filter((n) => Number.isInteger(n) && n > 0)
  const id = await withToken(requireIdentity())
  let group
  try {
    group = await Api.createGroup(id, name, members)
  } catch (e) {
    die(tr('create.failed', { err: describeGroupError(e) }))
  }
  await refreshDirectory(id).catch(() => null)
  process.stdout.write(`${group.id}\t${group.name}\n`)
  process.stderr.write(tr('create.done', { name: group.name }) + '\n')
}

/// Add somebody to a room you are in.
async function cmdInvite(pos: string[]): Promise<void> {
  const gid = Number((pos[0] ?? '').replace(/^g/i, ''))
  const uin = Number(pos[1])
  if (!Number.isInteger(gid) || gid <= 0 || !Number.isInteger(uin) || uin <= 0) usageDie(tr('invite.needsArgs'))
  const id = await withToken(requireIdentity())
  await primeDirectory(id)
  const base = groupById(id.uin, gid)
  if (!base) die(tr('group.notMember', { gid }))
  try {
    await Api.addGroupMember(id, gid, uin)
  } catch (e) {
    die(tr('invite.failed', { who: peerLabel(id.uin, uin), err: describeGroupError(e) }))
  }
  await refreshDirectory(id).catch(() => null)
  process.stdout.write(`${uin}\tadded\n`)
  process.stderr.write(tr('invite.done', { who: peerLabel(id.uin, uin), name: base.name }) + '\n')
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
    process.stderr.write(tr('provision.v1only', { err: humanError(e) }) + '\n')
  })
  await primeDirectory(identity)
  const base = groupById(identity.uin, gid)
  if (!base) die(tr('group.notMember', { gid }))
  const group = await rosterFor(identity, base).catch((e: unknown) => die(humanError(e)))
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
    process.stderr.write(tr('provision.v1only', { err: humanError(e) }) + '\n')
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
    die(tr('send.failed', { err: humanError(e) }))
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
    process.stderr.write(tr('provision.v1receive', { err: humanError(e) }) + '\n')
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
    process.stderr.write(err.dim(tr('fail.live', { err: humanError(e) })) + '\n')
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
      void ingestGroupPacket(identity, frame.payload, frame.group_id, liveOut, frame.seq).catch(liveFailed)
    },
    onControl: (frame) => {
      if (noteVaultChanged(identity.uin, frame)) return
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
  const arg = pos[0]
  if (arg === undefined) {
    process.stdout.write(`${currentLang()}\n`)
    process.stderr.write(tr('lang.usage', { codes: LANG_CODES }) + '\n')
    return
  }
  const pick = normalizeLang(arg)
  if (!pick) usageDie(tr('lang.invalid', { arg, codes: LANG_CODES }))
  setLang(pick)
  process.stderr.write(tr('lang.set', { lang: pick }) + '\n')
}

/// Where a probe should knock: --island wins, then the island this account
/// already talks to, then the default. Deliberately NOT requireIdentity() -
/// checking a proxy BEFORE there is an account is the whole throwaway recipe.
function probeIsland(opts: Map<string, string>): string {
  const flag = opts.get('--island')?.trim()
  if (flag) return flag.replace(/\/+$/, '')
  return loadStoredIdentity()?.apiBase ?? DEFAULT_API_BASE
}

/// host:port of a proxy address, for the messages that name it.
function proxyAddr(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname}:${u.port}`
  } catch {
    return url
  }
}

/// Prove that the proxy really carries RCQ's traffic, and say so in one
/// sentence, BEFORE anybody discovers it inside a socket reconnect loop.
///
/// Two runs, each in a child process that was STARTED with the proxy in its
/// environment (the only moment it can take effect at all - see env-proxy.ts):
///   1. a control run through an address nothing can ever be listening on,
///      asking a server on this machine's own loopback. It MUST fail. If it
///      succeeds, this Node ignores the proxy environment altogether
///      (NODE_USE_ENV_PROXY is Node 24+), and a green answer from run 2 would
///      have meant nothing. ⚠ That control run used to knock on the ISLAND,
///      which meant the detector announced the problem by sending the island
///      the one unproxied packet the proxy exists to prevent - and blamed the
///      proxy whenever the island was blocked. It now touches nothing outside
///      the machine.
///   2. the real one, against the island's /health.
/// stdout gets one machine line; stderr gets the sentence.
///
/// Three verdicts, because they are three different situations: `ok`, `fail`
/// (this proxy did not carry the traffic - Tor may simply not be up yet, so
/// the setting is kept), and `unsupported` (this RUNTIME cannot carry it, and
/// nothing the person does to the proxy will change that).
type ProxyVerdict = 'ok' | 'fail' | 'unsupported'

async function runProxyTest(url: string, island: string): Promise<ProxyVerdict> {
  process.stderr.write(err.dim(tr('proxy.testing', { url: redactProxyUrl(url), island })) + '\n')
  if (await probeEnvIgnored()) {
    process.stdout.write('fail\tproxy-env-ignored\n')
    process.stderr.write(err.yellow(tr('proxy.ignored', { version: process.version })) + '\n')
    process.stderr.write(err.yellow(tr('proxy.refusedUnsupported')) + '\n')
    return 'unsupported'
  }
  const r = await probeThroughProxy(url, island)
  if (r.ok) {
    process.stdout.write(`ok\t${r.ms ?? 0}\t${r.island ?? '-'}\n`)
    process.stderr.write(err.green(tr('proxy.ok', { island, ms: r.ms ?? 0 })) + '\n')
    process.stderr.write(err.dim(tr('proxy.caveat')) + '\n')
    return 'ok'
  }
  const addr = proxyAddr(url)
  const say = (): string => {
    switch (r.reason) {
      case 'refused':
        return tr('proxy.failRefused', { addr: r.detail || addr })
      case 'notSocks':
        return tr('proxy.failNotSocks', { addr })
      case 'notHttp':
        return tr('proxy.failNotHttp', { addr })
      case 'timeout':
        return tr('proxy.failTimeout', { ms: r.ms ?? 0, island })
      case 'status':
        return tr('proxy.failStatus', { island, status: r.status ?? 0 })
      default:
        return tr('proxy.failOther', { island, detail: r.detail || '?' })
    }
  }
  process.stdout.write(`fail\t${r.reason ?? 'other'}\t${r.detail ?? ''}\n`)
  process.stderr.write(err.yellow(say()) + '\n')
  return 'fail'
}

/// `rcq proxy` - push every RCQ connection through a proxy the user runs
/// themselves (Tor, i2pd, an `ssh -D` tunnel). Same idea and same vocabulary
/// as LOCAL_PROXY on the phones (RCQ/docs/proxy-design.md).
///
/// Lock-free like `lang`, and the one command that deliberately runs OUTSIDE
/// the proxy it configures (engageProxy skips it): a proxy that is down must
/// never be able to take `rcq proxy clear` down with it.
async function cmdProxy(pos: string[], opts: Map<string, string>, flags: Set<string>): Promise<void> {
  // Subcommands are NOT run through canonical() - `set` and `show` are their
  // own little namespace, and the top-level table would turn `s` into `send`.
  const sub = pos[0]
  const cfg = readProxyConfig()
  const saved = cfg && 'url' in cfg ? cfg.url : null
  // A stored value we cannot carry is NOT "no proxy". Every other command
  // refuses to run on one (env-proxy.ts, engageProxy); this one is where the
  // person is told what to fix, because it is the only command that still runs.
  if (cfg && 'invalid' in cfg) {
    process.stderr.write(
      err.yellow(
        tr(cfg.error === 'scheme' ? 'proxy.scheme' : 'proxy.syntax', { scheme: cfg.detail, arg: cfg.detail }),
      ) + '\n',
    )
  }
  switch (sub) {
    case undefined:
    case 'show': {
      // stdout is data: the address, or the bare ASCII token `none`.
      process.stdout.write(`${saved ? redactProxyUrl(saved) : 'none'}\n`)
      process.stderr.write((saved ? tr('proxy.on') : tr('proxy.off')) + '\n')
      if (flags.has('--test')) {
        if (!saved) process.exit(1)
        if ((await runProxyTest(saved, probeIsland(opts))) !== 'ok') process.exit(1)
        return
      }
      process.stderr.write(err.dim(tr('proxy.usage')) + '\n')
      return
    }
    case 'set': {
      const raw = pos[1]
      if (!raw) usageDie(tr('proxy.needsUrl'))
      const parsed = normalizeProxyUrl(raw)
      if ('error' in parsed) {
        die(parsed.error === 'scheme' ? tr('proxy.scheme', { scheme: parsed.detail }) : tr('proxy.syntax', { arg: raw }))
      }
      saveProxyUrl(parsed.url)
      process.stdout.write(`${redactProxyUrl(parsed.url)}\n`)
      process.stderr.write(err.green(tr('proxy.set', { url: redactProxyUrl(parsed.url) })) + '\n')
      // Checked right here unless a script says not to: a proxy saved and
      // never tried is a proxy whose first news is a reconnect loop. The
      // setting is KEPT either way (Tor may simply not be up yet), so a proxy
      // that merely did not answer never exits non-zero.
      //
      // ⚠ `unsupported` is the exception, and it is not a bad moment: this
      // runtime reads none of the variables, so nothing done to the proxy will
      // help. It used to exit 0 with one yellow line, which is how somebody
      // could go on to register a throwaway account from their real address
      // believing they were on Tor. The setting stays saved (it becomes real
      // on Node 24), the exit code does not pretend.
      if (!flags.has('--no-test')) {
        if ((await runProxyTest(parsed.url, probeIsland(opts))) === 'unsupported') process.exit(1)
      }
      return
    }
    case 'clear':
    case 'off': {
      process.stderr.write((clearProxyUrl() ? tr('proxy.cleared') : tr('proxy.nothingToClear')) + '\n')
      return
    }
    case 'test': {
      const url = pos[1] ? normalizeProxyUrl(pos[1]) : saved ? { url: saved } : null
      if (!url) {
        process.stdout.write('none\n')
        die(tr('proxy.off'))
      }
      if ('error' in url) {
        die(url.error === 'scheme' ? tr('proxy.scheme', { scheme: url.detail }) : tr('proxy.syntax', { arg: pos[1] }))
      }
      if ((await runProxyTest(url.url, probeIsland(opts))) !== 'ok') process.exit(1)
      return
    }
    default:
      usageDie(tr('proxy.usage'))
  }
}

/// `rcq routes` - which roads to the island this client has, which one it is
/// on, and what happened the last time it looked.
///
/// Lock-free on purpose: the answer to "why is my `rcq watch` not connecting"
/// has to be available WHILE that watch is running, and it touches nothing but
/// its own small file.
async function cmdRoutes(opts: Map<string, string>, flags: Set<string>): Promise<void> {
  const island = probeIsland(opts)
  if (flags.has('--singbox')) return cmdSingBox(island, opts, flags)

  if (flags.has('--refresh')) {
    // The fetch itself has to ride the current route: a blocked user cannot
    // reach the mirrors any other way.
    await ensureRoute(island)
    const r = await refreshRelayConfig()
    for (const t of r.tried) {
      process.stderr.write(err.dim(`  ${t.source.kind.padEnd(8)} ${t.source.value}  ${t.outcome}`) + '\n')
    }
    process.stderr.write(
      (r.from
        ? err.green(tr('routes.refreshOk', { version: r.version ?? '?' }))
        : err.yellow(tr('routes.refreshFail'))) + '\n',
    )
  }

  if (flags.has('--probe')) await walkLadder(island)
  const route = await ensureRoute(island)
  const walk = lastWalk()

  // stdout is the machine contract: the rung, one bare token.
  process.stdout.write(`${route.rung}\n`)

  const lines: string[] = []
  lines.push(`${tr('label.island')}: ${island}`)
  lines.push(`${tr('label.route')}: ${describeRoute(route)}`)
  // Both halves redacted: the second one is the CONFIGURED proxy printed when
  // this run is not behind it, and it comes straight off the 0600 file where
  // the password lives.
  const configured = readProxyUrl()
  lines.push(
    `${tr('label.proxy')}: ${activeProxyLabel() ?? (configured ? redactProxyUrl(configured) : 'none')}`,
  )
  lines.push(`${tr('label.front')}: ${frontHost()}`)
  const v = relayConfigVersion()
  lines.push(
    `${tr('label.relays')}: ${relayList().length} (${
      usingRemote() && v !== null ? tr('routes.signedConfig', { version: v }) : tr('routes.bundledSeed')
    })`,
  )
  lines.push(`${tr('label.sources')}: ${effectiveSources().map((s) => s.value).join(' ')}`)
  lines.push(`${tr('label.probe')}: ${probeUrl()}`)
  process.stderr.write(lines.join('\n') + '\n')

  if (walk) {
    process.stderr.write(`\n${tr('routes.lastWalk')} ${new Date(walk.at).toISOString()}\n`)
    for (const r of walk.rungs) process.stderr.write(describeRung(r) + '\n')
  } else {
    process.stderr.write(`\n${tr('routes.neverWalked')}\n`)
  }

  // The honest part, said every time and not only when something is broken.
  process.stderr.write('\n' + err.dim(tr('routes.noEmbeddedTransport')) + '\n')
  const sb = findSingBox()
  process.stderr.write(err.dim(`${tr('label.singbox')}: ${sb ?? tr('routes.singboxMissing')}`) + '\n')
  process.stderr.write(err.dim(tr('routes.usage')) + '\n')
}

/// `rcq routes --singbox` - write the config for a sing-box the user installs
/// themselves, then tell them the two commands that put it to work.
async function cmdSingBox(island: string, opts: Map<string, string>, flags: Set<string>): Promise<void> {
  const port = Number(opts.get('--port') ?? DEFAULT_LOCAL_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) usageDie(tr('routes.badPort'))
  const onion = flags.has('--onion') ? true : flags.has('--no-onion') ? false : undefined
  let community: Awaited<ReturnType<typeof fetchBridges>> = []
  if (flags.has('--bridges')) {
    await ensureRoute(island)
    community = await fetchBridges(island)
  }
  const built = await buildSingBox({ port, onion, community })
  const text = JSON.stringify(built.config, null, 2) + '\n'
  // 0600: the config carries every relay's uuid and password, which is the
  // whole credential set of the pool this machine can reach.
  const outFile = opts.get('--out')
  if (outFile) {
    fs.writeFileSync(outFile, text, { mode: 0o600 })
    // ⚠ And again, explicitly: `mode` is honoured only when the call CREATES
    // the file (verified locally - an existing 0644 file stays 0644 through a
    // writeFileSync with mode 0o600). Rewriting a config that a hand, an
    // editor or an earlier `rcq routes --singbox > file` under umask 022 had
    // already made left every relay uuid, Reality key and Hysteria2 password
    // world-readable on a shared box.
    try {
      fs.chmodSync(outFile, 0o600)
    } catch {
      /* Windows and some network filesystems have no mode to set */
    }
    process.stdout.write(`${outFile}\n`)
  } else {
    process.stdout.write(text)
  }
  const shape =
    built.shape === 'onion'
      ? tr('routes.shapeOnion', { entry: built.entry ?? '?' })
      : built.shape === 'onion-degraded'
        ? tr('routes.shapeOnionDegraded')
        : tr('routes.shapeSingleHop')
  process.stderr.write(
    `${shape}\n${tr('routes.relayCounts', { trusted: built.trustedCount, community: built.communityCount })}\n`,
  )
  // Said out loud rather than implied: behind a proxy the entry is picked
  // without a probe, because the probe is a raw socket that would have gone
  // around the proxy (singbox.ts selectEntry).
  if (built.entryProbed === false) process.stderr.write(err.dim(tr('routes.entryUnprobed')) + '\n')
  if (flags.has('--bridges') && !community.length) process.stderr.write(err.yellow(tr('routes.noBridges')) + '\n')
  const sb = findSingBox()
  process.stderr.write(
    (sb ? err.dim(`${tr('label.singbox')}: ${sb}`) : err.yellow(tr('routes.singboxMissing'))) + '\n',
  )
  process.stderr.write(err.dim(tr('routes.singboxHowto', { file: outFile ?? 'singbox.json', port })) + '\n')
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
  if (cmd === '--help' || cmd === '-h' || (cmd !== undefined && canonical(cmd) === 'help')) {
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
    const id = requireIdentity()
    await ensureRoute(id.apiBase)
    return runInteractive(await withToken(id))
  }
  // The short form and the full one are the same command (see aliases.ts), so
  // resolve once and drive the lock check, the switch and the unknown-command
  // line off the canonical verb.
  const verb = canonical(cmd)
  // One process per state dir for anything that can touch the ratchet store —
  // see acquireStateLock. whoami/export/log are read-only peeks and lang only
  // writes its own one-word file (atomic rename): all four stay lock-free.
  // `proxy` and its probe child join them: the proxy config is its own
  // small file (atomic rename), and the child must not deadlock against a
  // parent that is holding the dir.
  // `routes` joins them for a sharper reason than tidiness: "why is my watch
  // not connecting" has to be answerable WHILE that watch holds the dir.
  const LOCK_FREE = new Set(['whoami', 'export', 'lang', 'log', 'proxy', '__probe', 'routes'])
  if (!LOCK_FREE.has(verb)) acquireStateLock()
  const { pos, opts, flags } = parseArgs(argv.slice(1))
  // Bring the route up before anything names the island. Cheap: a decision
  // younger than half an hour is re-engaged without a probe, so the common
  // case costs nothing and only a stale or blocked one pays for a walk.
  // `routes` does its own; `lang`, `log`, `export` and the proxy pair never
  // touch the network at all.
  if (!ROUTE_FREE.has(verb)) await ensureRoute(probeIsland(opts))
  switch (verb) {
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
    case 'leave':
      return cmdLeave(pos)
    case 'create':
      return cmdCreate(pos)
    case 'invite':
      return cmdInvite(pos)
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
    case 'proxy':
      return cmdProxy(pos, opts, flags)
    case 'routes':
      return cmdRoutes(opts, flags)
    // Not in the usage text: the child half of `rcq proxy test`, started by
    // probeThroughProxy with the proxy env already in place. It prints one
    // JSON line and nothing else.
    case '__probe':
      return runProbe(probeIsland(opts))
    default:
      usageDie(tr('args.unknownCmd', { cmd }))
  }
}

main().then(
  () => {
    // `watch` and the no-arg interactive mode stay alive on their socket;
    // every other command is done when its promise settles. Resolve the alias
    // first, or `rcq wt` would fall through this guard and kill its own socket.
    const raw = process.argv[2]
    const verb = raw ? canonical(raw) : undefined
    if (verb !== undefined && verb !== 'watch') process.exit(0)
  },
  (e) => {
    // A road that carried nothing is not a road to keep. Forgetting the sticky
    // decision costs one ladder walk on the next command and buys a client
    // that notices a network which started blocking mid-day, instead of
    // retrying the same dead route for half an hour. An island that ANSWERED,
    // even with a refusal, leaves the decision alone.
    if (isTransportFailure(e)) noteRouteTrouble()
    die(humanError(e))
  },
)

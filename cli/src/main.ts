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
import { Api, setTokenRefresher } from '../../src/lib/api'
import { getDevice, myDeviceId, setProvisionPolicy } from '../../src/lib/signal-device'
import type { WebIdentity } from '../../src/lib/crypto'
import { idbGet } from '../shims/signal-persist'
import { drainQueue, historyPath, ingestDecrypted, type IngestResult } from './receive'
import { runInteractive } from './interactive'
import { sendText } from './send'
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

/// Pull `--flag value` pairs out of argv; what remains are positionals.
function parseArgs(argv: string[]): { pos: string[]; opts: Map<string, string> } {
  const pos: string[] = []
  const opts = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) usageDie(tr('args.flagNeedsValue', { flag: a }))
      opts.set(a, v)
      i++
    } else {
      pos.push(a)
    }
  }
  return { pos, opts }
}

function requireIdentity(): WebIdentity {
  const id = loadStoredIdentity()
  if (!id) die(tr('err.noAccount'))
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
  printPhraseBlock(identity.uin)
}

async function cmdRestore(pos: string[], opts: Map<string, string>): Promise<void> {
  const phrase = pos[0]
  if (!phrase) usageDie(tr('restore.needsPhrase'))
  const island = (opts.get('--island') ?? DEFAULT_API_BASE).replace(/\/+$/, '')
  const identity = await recoverFromPhrase(phrase, island)
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
  const list = await Api.contacts(id)
  for (const c of list) {
    process.stdout.write(`${c.uin}\t${c.nickname}\t${c.status}${c.blocked ? '\tblocked' : ''}\n`)
  }
}

async function cmdAdd(pos: string[]): Promise<void> {
  const uin = Number(pos[0])
  if (!Number.isInteger(uin) || uin <= 0) usageDie(tr('add.needsUin'))
  const id = await withToken(requireIdentity())
  await Api.sendContactRequest(id, uin)
  process.stderr.write(tr('add.sent', { uin }) + '\n')
}

async function cmdSend(pos: string[]): Promise<void> {
  const uin = Number(pos[0])
  const text = pos[1]
  if (!Number.isInteger(uin) || uin <= 0 || !text) usageDie(tr('send.needsArgs'))
  const identity = await withToken(requireIdentity())
  await getDevice(identity).catch((e) => {
    // v=1 still works without a libsignal device; say so rather than dying.
    process.stderr.write(tr('provision.v1only', { err: e instanceof Error ? e.message : String(e) }) + '\n')
  })
  // The island's mailbox is open by design (UIN culture: anyone can write
  // first, the recipient decides what to do with strangers) — but writing to
  // somebody you never added deserves a heads-up, because a typo'd uin
  // otherwise sends a message to a random person in silence. Best-effort: an
  // unreachable contacts list must not block the send.
  const known = await Api.contacts(identity)
    .then((l) => l.some((c) => c.uin === uin))
    .catch(() => true)
  if (!known) process.stderr.write(err.yellow(tr('send.notContact', { uin }) + '\n'))
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

async function cmdWatch(): Promise<void> {
  const identity = await withToken(requireIdentity())
  await getDevice(identity).catch((e) => {
    process.stderr.write(tr('provision.v1receive', { err: e instanceof Error ? e.message : String(e) }) + '\n')
  })
  // Correct the live-frame device filter from the saved blob even when the
  // provision above failed: until then currentDeviceId() answers 1 (the
  // phone's id) and frames for OUR device would be dropped on the floor.
  await myDeviceId(identity).catch(() => null)
  // The backlog first, socket second — and keep draining on a timer while no
  // socket is open. A connect-only drain delivers nothing, forever, on a
  // network that answers every HTTPS request and kills every WebSocket.
  await drainQueue(identity)
  const liveOut: IngestResult = { receiptTargets: [] }
  const sock = new RcqSocket(
    identity,
    (frame) => {
      void (async () => {
        const got = await decryptIncoming(identity, frame.payload)
        if (!got) return
        if (got.senderUIN !== identity.uin) noteInboundFrom(got.senderUIN, got.senderDeviceId)
        await ingestDecrypted(identity, got, frame.group_id, liveOut)
      })().catch(() => {
        // No device to open it with yet — the same envelope sits in the
        // queue, and the reconnect drain delivers it.
      })
    },
    () => {
      // Every (re)connect drains: whatever queued while the socket was down
      // is covered by nothing else. The id dedup absorbs the overlap.
      void drainQueue(identity)
    },
    () => {
      die(tr('err.sessionRejected'))
    },
  )
  sock.start()
  const poll = setInterval(() => {
    if (!sock.isOpen) void drainQueue(identity)
  }, 30_000)
  process.stderr.write(tr('watch.hello', { uin: identity.uin }) + '\n')
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
  // see acquireStateLock. whoami/export are read-only peeks and lang only
  // writes its own one-word file (atomic rename): all three stay lock-free.
  if (cmd !== 'whoami' && cmd !== 'export' && cmd !== 'lang') acquireStateLock()
  const { pos, opts } = parseArgs(argv.slice(1))
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
    case 'add':
      return cmdAdd(pos)
    case 'send':
      return cmdSend(pos)
    case 'watch':
      return cmdWatch()
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

// rcq — console client, v1: scriptable plumbing (register/restore, contacts,
// 1:1 text both ways, receipts, queue drain, watch). See cli/README.md and
// docs/console-client-design.md.
//
// Output discipline: stdout carries DATA only (messages, the phrase, lists);
// status and log lines go to stderr. Exit codes: 0 ok, 1 error, 2 usage.

import './bootstrap'
import fs from 'node:fs'
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
import { getDevice, myDeviceId, PartialFanOutError, sendV2, setProvisionPolicy } from '../../src/lib/signal-device'
import { bytesToB64, encryptV1, type CarbonEnvelope, type Envelope, type TextEnvelope, type WebIdentity } from '../../src/lib/crypto'
import { peerBundleFrom } from '../../src/lib/api'
import { idbGet } from '../shims/signal-persist'
import { drainQueue, historyPath, ingestDecrypted, markSent, type IngestResult } from './receive'
import { RcqSocket } from './socket'
import { acquireStateLock } from './state'
import { decryptIncoming, noteInboundFrom } from '../../src/lib/signal-device'

// ★ Before anything can provision: a CLI on a server must never steal the
// account's primary slot from the phone (docs/console-client-design.md; the
// 2026-08-20 live test showed what a surprise re-claim does to peers'
// sessions). The web keeps its 'auto' default untouched.
setProvisionPolicy('secondary')

// A 401 mid-command mints a fresh token from the signing key and retries once
// — the same path that keeps a 30-day-old web session alive.
setTokenRefresher(async (id) => (await mintSessionToken(id)).token)

const USAGE = `rcq — RCQ console client (v1)

usage:
  rcq register [--nick NAME] [--island URL]   create an account, print UIN + recovery phrase
  rcq restore "<24 words>" [--island URL]     restore an account from its phrase
  rcq whoami                                  print uin, island, device id
  rcq contacts                                list contacts (uin, nickname, status)
  rcq add <uin>                               send a contact request
  rcq send <uin> "text"                       drain, send one message, drain, exit
  rcq watch                                   stay connected, print incoming messages
  rcq export                                  print the history file path and line count
  rcq --help                                  this text

state lives in $RCQ_CLI_HOME (default ~/.config/rcq), chmod 0600/0700.
`

function die(msg: string, code = 1): never {
  process.stderr.write(`rcq: ${msg}\n`)
  process.exit(code)
}

function usageDie(msg?: string): never {
  if (msg) process.stderr.write(`rcq: ${msg}\n`)
  process.stderr.write(USAGE)
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
      if (v === undefined || v.startsWith('--')) usageDie(`${a} needs a value`)
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
  if (!id) die("no account here — run 'rcq register' or 'rcq restore' first")
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
  if (mint.dead) die('the island refused this session (revoked or account gone)')
  if (!mint.token) {
    // Unreachable island but a token that is formally still alive: let the
    // command try with it rather than dying at the door.
    if (id.jwt && jwtTtl(id.jwt) > 0) return id
    die('could not mint a session token (island unreachable?)')
  }
  const fresh = { ...id, jwt: mint.token }
  persistIdentity(fresh)
  return fresh
}

function printPhraseBlock(uin: number): void {
  const phrase = currentRecoveryPhrase()
  process.stdout.write(`uin: ${uin}\n`)
  if (phrase) {
    process.stdout.write(`phrase: ${phrase.join(' ')}\n`)
    process.stderr.write(
      '\nKEEP THIS PHRASE. It recreates the account on any device, forever.\n' +
        'Anyone who has it IS this account. It is stored in the state dir —\n' +
        'delete it there after writing it down if this box is not trusted.\n',
    )
  }
}

async function cmdRegister(opts: Map<string, string>): Promise<void> {
  if (loadStoredIdentity()) die("an account already lives here — 'rcq whoami'. Use RCQ_CLI_HOME for a second one")
  const nick = opts.get('--nick') ?? suggestNickname()
  const island = (opts.get('--island') ?? DEFAULT_API_BASE).replace(/\/+$/, '')
  const identity = await createNewAccount(nick, island)
  printPhraseBlock(identity.uin)
}

async function cmdRestore(pos: string[], opts: Map<string, string>): Promise<void> {
  const phrase = pos[0]
  if (!phrase) usageDie('restore needs the quoted 24-word phrase')
  const island = (opts.get('--island') ?? DEFAULT_API_BASE).replace(/\/+$/, '')
  const identity = await recoverFromPhrase(phrase, island)
  process.stdout.write(`uin: ${identity.uin}\n`)
  process.stderr.write('restored. The libsignal device registers on the first send/watch.\n')
}

async function cmdWhoami(): Promise<void> {
  const id = requireIdentity()
  // Read the persisted device blob directly — whoami must work offline, and
  // getDevice() would try to provision.
  const blob = await idbGet<{ deviceId: number }>(`signal-device:${id.uin}`)
  process.stdout.write(`uin: ${id.uin}\nisland: ${id.apiBase}\ndevice: ${blob ? blob.deviceId : '-'}\n`)
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
  if (!Number.isInteger(uin) || uin <= 0) usageDie('add needs a numeric UIN')
  const id = await withToken(requireIdentity())
  await Api.sendContactRequest(id, uin)
  process.stderr.write(`contact request sent to #${uin}\n`)
}

/// Deposit a self-carbon so the phone/desktop show this message as ours —
/// mirrors Chat.tsx sendMessageCarbon: v=1 sealed to our OWN account key,
/// outer type 'carbon' (non-pushable — our phone must not ring for a message
/// we just typed). Best-effort: the message already went out.
async function sendMessageCarbon(identity: WebIdentity, peerUin: number, inner: Envelope): Promise<void> {
  try {
    const carbon: CarbonEnvelope = { kind: 'carbon', to: peerUin, gid: null, env: inner }
    const selfBundle = peerBundleFrom({
      uin: identity.uin,
      identity_key: bytesToB64(identity.identityPub),
      signing_key: bytesToB64(identity.signingPub),
    })
    await Api.sendSealed(identity, identity.uin, encryptV1(carbon, identity, selfBundle), 'carbon')
  } catch {
    /* best-effort multi-device echo */
  }
}

async function cmdSend(pos: string[]): Promise<void> {
  const uin = Number(pos[0])
  const text = pos[1]
  if (!Number.isInteger(uin) || uin <= 0 || !text) usageDie('send needs <uin> and "text"')
  const identity = await withToken(requireIdentity())
  await getDevice(identity).catch((e) => {
    // v=1 still works without a libsignal device; say so rather than dying.
    process.stderr.write(`provision failed (${e instanceof Error ? e.message : e}) — v=1 only\n`)
  })
  await drainQueue(identity)
  const env: TextEnvelope = { kind: 'text', id: crypto.randomUUID().toUpperCase(), text }
  // Prefer v=2 (one ciphertext per device of the peer). reached === 0 means
  // the peer published no libsignal bundle — fall back to v=1 ECIES. A
  // PARTIAL fan-out is a failed send, not a smaller number: the v=1 copy
  // would reach the device that already has the message and still not the
  // one that missed it (Chat.tsx, same rule).
  let mode: string
  try {
    const reached = await sendV2(identity, uin, env, 'message').catch((e) => {
      if (e instanceof PartialFanOutError) throw e
      return 0
    })
    if (reached > 0) {
      mode = `v2 devices=${reached}`
    } else {
      const info = await Api.userInfo(identity, uin)
      await Api.sendSealed(identity, uin, encryptV1(env, identity, peerBundleFrom(info)), 'message')
      mode = 'v1'
    }
  } catch (e) {
    die(`send failed: ${e instanceof Error ? e.message : e}`)
  }
  await sendMessageCarbon(identity, uin, env)
  // Our own id is "seen" from here on: the drain below would otherwise pull
  // the self-carbon back and echo the typed text onto stdout as peer data.
  markSent(env.id)
  // One more drain to pick up an instant receipt from a peer that is online.
  await new Promise((r) => setTimeout(r, 2000))
  const drained = await drainQueue(identity)
  const delivered = drained?.receiptTargets.includes(env.id) ?? false
  process.stdout.write(`sent ${mode}${delivered ? ' delivered' : ''}\n`)
}

async function cmdWatch(): Promise<void> {
  const identity = await withToken(requireIdentity())
  await getDevice(identity).catch((e) => {
    process.stderr.write(`provision failed (${e instanceof Error ? e.message : e}) — v=1 receive only\n`)
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
      die('the island rejected this session (unlinked or revoked)')
    },
  )
  sock.start()
  const poll = setInterval(() => {
    if (!sock.isOpen) void drainQueue(identity)
  }, 30_000)
  process.stderr.write(`watching as #${identity.uin} (Ctrl+C to stop)\n`)
  process.on('SIGINT', () => {
    clearInterval(poll)
    sock.stop()
    process.stderr.write('\nbye\n')
    process.exit(0)
  })
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
  const cmd = argv[0]
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(USAGE)
    process.exit(0)
  }
  // No command is an error path: usage goes to stderr, stdout stays data-only.
  if (!cmd) usageDie('no command')
  // One process per state dir for anything that can touch the ratchet store —
  // see acquireStateLock. whoami/export are read-only peeks and stay lock-free.
  if (cmd !== 'whoami' && cmd !== 'export') acquireStateLock()
  const { pos, opts } = parseArgs(argv.slice(1))
  switch (cmd) {
    case 'register':
      return cmdRegister(opts)
    case 'restore':
      return cmdRestore(pos, opts)
    case 'whoami':
      return cmdWhoami()
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
    default:
      usageDie(`unknown command '${cmd}'`)
  }
}

main().then(
  () => {
    // `watch` keeps the loop alive via its socket; every other command is
    // done when its promise settles.
    if (process.argv[2] !== 'watch') process.exit(0)
  },
  (e) => die(e instanceof Error ? e.message : String(e)),
)

// Where the CLI keeps everything: identity (localstorage.json), libsignal
// device state (signal-<uin>.json), received history (history-<uin>.jsonl).
// RCQ_CLI_HOME overrides the default so tests and multi-account setups can
// point at another tree without touching ~/.config/rcq.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { checkPasses, deriveKey, makeMeta, newSalt, open as sealOpen, seal, type VaultMeta } from './seal'
// Circular on purpose (i18n reads its saved choice through statePath); both
// sides only touch each other inside function bodies, never at module init.
import { tr } from './i18n'

let _dir: string | null = null

export function stateDir(): string {
  if (_dir) return _dir
  const dir = process.env.RCQ_CLI_HOME || path.join(os.homedir(), '.config', 'rcq')
  fs.mkdirSync(dir, { recursive: true })
  // mkdir's mode argument is filtered through the umask; chmod is not.
  fs.chmodSync(dir, 0o700)
  _dir = dir
  return dir
}

export function statePath(name: string): string {
  return path.join(stateDir(), name)
}

/// One rcq process per state dir. The libsignal ratchet is a whole-file
/// last-writer-wins JSON: `rcq watch` in one terminal and `rcq send` in
/// another would each cache a device in memory and silently revert each
/// other's chain advances — the peer then rejects the reused counter and the
/// message is gone (exactly the loss class of the 2026-08-20 postmortems).
/// A plain pid lockfile, checked for liveness so a crashed run does not brick
/// the dir. Released on exit; failing fast beats corrupting a ratchet.
export function acquireStateLock(): void {
  const lock = statePath('.lock')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600)
      fs.writeSync(fd, String(process.pid))
      fs.closeSync(fd)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      let pid = NaN
      try {
        pid = Number(fs.readFileSync(lock, 'utf8'))
      } catch {
        /* holder vanished between open and read — retry takes it */
      }
      let alive = false
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0)
          alive = true
        } catch {
          alive = false
        }
      }
      if (alive) {
        process.stderr.write(tr('lock.busy', { pid, dir: stateDir() }) + '\n')
        process.exit(1)
      }
      try {
        fs.unlinkSync(lock)
      } catch {
        /* raced another cleanup */
      }
    }
  }
  lockFile = lock
  process.on('exit', releaseStateLock)
}

let lockFile: string | null = null

/// Let go of the lock before the process replaces its own image. ⚠ An exec
/// runs no 'exit' hook (verified: the handler above never fires across
/// process.execve), and the new image has the SAME pid, so it would find the
/// file, see itself alive in it, and refuse to start.
export function releaseStateLock(): void {
  const lock = lockFile
  if (!lock) return
  lockFile = null
  try {
    if (Number(fs.readFileSync(lock, 'utf8')) === process.pid) fs.unlinkSync(lock)
  } catch {
    /* already gone */
  }
}

// tmp + rename: the identity and the libsignal ratchet live in these files,
// and a write torn by a crash is an account (or every peer session) gone.
// 0600 — same trust level as ssh keys (design doc: plaintext-at-rest + file
// permissions for v1; passphrase sealing is a v1.5 flag).
export function writeFileAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, data, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

// ── state at rest ────────────────────────────────────────────────────────
//
// The dir is either PLAIN (what every install has been until now: 0600 files
// and file permissions as the whole defence) or SEALED (`rcq lock`: every
// file below written through AES-256-GCM under a key scrypt'd from a
// passphrase that lives nowhere but in the head of the person typing it).
//
// ⚠ The two modes are one code path on purpose. Every caller reads and writes
// through the three functions here, so a file cannot be sealed on write and
// read raw somewhere else — which is precisely how half-encrypted stores end
// up leaking the half nobody thought about.

const VAULT_FILE = 'vault.json'
/// Never sealed, and each for a reason: the vault's own header, the process
/// lock (read by a process that has no key yet), the language and the update
/// cache (both wanted before anyone types a passphrase), and everything the
/// route ladder needs to reach an island at all. None of it says who you are
/// or who you talk to; sealing the route config would mean a blocked network
/// could not even be climbed until after the passphrase, which is backwards.
/// The island pins and their PEMs are of the same kind: a pin is a statement
/// about an island, not a secret, and Node reads the bundle before any of
/// our code runs.
const NEVER_SEALED = new Set([
  VAULT_FILE,
  '.lock',
  'lang',
  'update-check.json',
  'routes.json',
  'proxy.json',
  'island-pins.json',
  'island-certs',
])
const NEVER_SEALED_PREFIX = ['relay-config', 'singbox', 'routes']

/// Every file in the dir that a seal applies to.
export function sealableFiles(): string[] {
  let names: string[]
  try {
    names = fs.readdirSync(stateDir())
  } catch {
    return []
  }
  return names.filter(
    (n) =>
      !NEVER_SEALED.has(n) &&
      !n.startsWith('.') &&
      !n.endsWith('.tmp') &&
      !/\.tmp-\d+$/.test(n) &&
      !NEVER_SEALED_PREFIX.some((p) => n.startsWith(p)),
  )
}
let _key: Buffer | null = null
let _meta: VaultMeta | null | undefined

function meta(): VaultMeta | null {
  if (_meta !== undefined) return _meta
  try {
    _meta = JSON.parse(fs.readFileSync(statePath(VAULT_FILE), 'utf8')) as VaultMeta
  } catch {
    _meta = null
  }
  return _meta
}

/// Is this state dir sealed? Cheap and side-effect free: every command asks it
/// before touching anything.
export function isSealed(): boolean {
  return meta() !== null
}

/// Is the key in hand for this process?
export function isUnlocked(): boolean {
  return _key !== null
}

/// Turn a passphrase into the key for THIS dir, or null when it is wrong.
export function unlockWith(passphrase: string): boolean {
  const m = meta()
  if (!m) return true // nothing to unlock
  const key = deriveKey(passphrase, Buffer.from(m.salt, 'base64'), m)
  if (!checkPasses(key, m)) return false
  _key = key
  return true
}

/// Seal an unsealed dir under `passphrase`, rewriting every state file. The
/// caller has already confirmed the passphrase and warned about losing it.
export function sealDir(passphrase: string, files: string[]): void {
  if (isSealed()) throw new Error('already sealed')
  const salt = newSalt()
  const key = deriveKey(passphrase, salt)
  for (const name of files) {
    const file = statePath(name)
    let raw: Buffer
    try {
      raw = fs.readFileSync(file)
    } catch {
      continue
    }
    // ⚠ A JSONL file is sealed LINE BY LINE, not as one blob. It is appended
    // to from a live socket, one message at a time, and a whole-file envelope
    // would mean rewriting (and re-encrypting) the entire history on every
    // incoming message. `appendState` and `readStateLines` speak the same
    // per-line shape, so the two halves have to agree here.
    if (name.endsWith('.jsonl')) {
      const lines = raw.toString('utf8').split('\n').filter(Boolean)
      writeFileAtomic(file, lines.map((line) => seal(key, line).toString('base64')).join('\n') + (lines.length ? '\n' : ''))
    } else {
      writeFileAtomic(file, seal(key, raw))
    }
  }
  writeFileAtomic(statePath(VAULT_FILE), JSON.stringify(makeMeta(key, salt), null, 1))
  _meta = undefined
  _key = key
}

/// The reverse, for somebody who decides the passphrase is not worth it.
export function unsealDir(files: string[]): void {
  const key = _key
  if (!key) throw new Error('locked')
  for (const name of files) {
    const file = statePath(name)
    let raw: Buffer
    try {
      raw = fs.readFileSync(file)
    } catch {
      continue
    }
    if (name.endsWith('.jsonl')) {
      const out: string[] = []
      for (const line of raw.toString('utf8').split('\n').filter(Boolean)) {
        const plain = sealOpen(key, Buffer.from(line, 'base64'))
        if (plain) out.push(plain.toString('utf8'))
      }
      writeFileAtomic(file, out.join('\n') + (out.length ? '\n' : ''))
      continue
    }
    const plain = sealOpen(key, raw)
    if (plain) writeFileAtomic(file, plain)
  }
  try {
    fs.unlinkSync(statePath(VAULT_FILE))
  } catch {
    /* already gone */
  }
  _meta = undefined
  _key = null
}

/// Read one state file as text. Null when it does not exist. Throws when the
/// dir is sealed and this process has no key: a caller that treated that as
/// "empty" would quietly start a second account over the top of the first.
export function readState(name: string): string | null {
  let raw: Buffer
  try {
    raw = fs.readFileSync(statePath(name))
  } catch {
    return null
  }
  if (!isSealed()) return raw.toString('utf8')
  if (!_key) throw new Error('state is sealed and this process is locked')
  const plain = sealOpen(_key, raw)
  if (plain === null) throw new Error(`unreadable sealed file: ${name}`)
  return plain.toString('utf8')
}

export function writeState(name: string, data: string): void {
  const file = statePath(name)
  if (!isSealed()) {
    writeFileAtomic(file, data)
    return
  }
  if (!_key) throw new Error('state is sealed and this process is locked')
  writeFileAtomic(file, seal(_key, data))
}

/// Append one line to a JSONL state file.
///
/// ⚠ Sealed, this is one envelope PER LINE, each with its own nonce, so the
/// file stays append-only: the history is written a line at a time from a live
/// socket and rewriting the whole thing on every message would be both slow
/// and a torn-write hazard. The cost is that line lengths are visible to
/// somebody holding the disk, which says how long a message was and nothing
/// about who or what.
export function appendState(name: string, line: string): void {
  const file = statePath(name)
  if (!isSealed()) {
    fs.appendFileSync(file, line + '\n', { mode: 0o600 })
    return
  }
  if (!_key) throw new Error('state is sealed and this process is locked')
  fs.appendFileSync(file, seal(_key, line).toString('base64') + '\n', { mode: 0o600 })
}

/// Read a JSONL state file as lines, sealed or not. Unreadable lines are
/// skipped rather than fatal: one bad line in a history file is a lost message,
/// while throwing would cost the whole conversation.
export function readStateLines(name: string): string[] {
  let text: string
  try {
    text = fs.readFileSync(statePath(name), 'utf8')
  } catch {
    return []
  }
  const lines = text.split('\n').filter(Boolean)
  if (!isSealed()) return lines
  if (!_key) throw new Error('state is sealed and this process is locked')
  const out: string[] = []
  for (const line of lines) {
    const plain = sealOpen(_key, Buffer.from(line, 'base64'))
    if (plain) out.push(plain.toString('utf8'))
  }
  return out
}

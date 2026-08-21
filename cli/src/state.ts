// Where the CLI keeps everything: identity (localstorage.json), libsignal
// device state (signal-<uin>.json), received history (history-<uin>.jsonl).
// RCQ_CLI_HOME overrides the default so tests and multi-account setups can
// point at another tree without touching ~/.config/rcq.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
  const release = () => {
    try {
      if (Number(fs.readFileSync(lock, 'utf8')) === process.pid) fs.unlinkSync(lock)
    } catch {
      /* already gone */
    }
  }
  process.on('exit', release)
}

// tmp + rename: the identity and the libsignal ratchet live in these files,
// and a write torn by a crash is an account (or every peer session) gone.
// 0600 — same trust level as ssh keys (design doc: plaintext-at-rest + file
// permissions for v1; passphrase sealing is a v1.5 flag).
export function writeFileAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, data, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

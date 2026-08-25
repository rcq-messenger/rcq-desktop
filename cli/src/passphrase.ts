// Asking for the passphrase that opens the state dir.
//
// Three ways in, in this order: the environment (so cron and scripts keep
// working unattended), a file named by the environment (so the passphrase is
// not in the process table or a shell history), and finally a prompt on the
// terminal with the echo off.
//
// ⚠ There is no fourth. Nothing is cached to disk, nothing is kept in a
// keyring, and no agent holds it between commands: the whole point of sealing
// the dir is that the key exists only while a process that was given the
// passphrase is running.

import fs from 'node:fs'
import readline from 'node:readline'

import { tr } from './i18n'
import { err } from './style'

/// From the environment, or null. `RCQ_PASSPHRASE_FILE` is the better of the
/// two: an environment variable is readable by anything that can list this
/// process, a file is not.
export function passphraseFromEnv(): string | null {
  const file = process.env.RCQ_PASSPHRASE_FILE?.trim()
  if (file) {
    try {
      return fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '')
    } catch {
      return null
    }
  }
  const value = process.env.RCQ_PASSPHRASE
  return value ? value : null
}

/// Read one line from the terminal without echoing it.
///
/// ⚠ stderr, not stdout: stdout is the machine contract of every command here,
/// and a prompt written into it would end up inside somebody's pipe.
export async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error(tr('seal.needTty'))
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true })
  const out = process.stderr
  // Swallow the echo of everything typed after the prompt itself.
  let muted = false
  const write = out.write.bind(out)
  ;(out as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    if (muted) return true
    return write(chunk)
  }
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(err.dim(label) + ' ', (a) => resolve(a))
      muted = true
    })
    return answer
  } finally {
    muted = false
    ;(out as unknown as { write: unknown }).write = write
    rl.close()
    write('\n')
  }
}

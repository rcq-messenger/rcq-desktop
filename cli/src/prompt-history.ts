// Up-arrow, across restarts.
//
// readline recalls the lines of THIS session and forgets them on exit, so
// somebody who lives in the client retypes `/g Работа` and `/to 396` every
// morning. A file is the obvious fix and the obvious hazard: what is typed at
// a chat prompt is mostly what is SAID at it, and a second plaintext copy of
// your messages, in a file nobody mentioned, is not a feature.
//
// So only COMMANDS are kept. Slash lines are what up-arrow is really for, and
// message bodies stay in exactly one place on disk (`history-<uin>.jsonl`,
// which `rcq export` names out loud). Inside a session readline still recalls
// everything, which is where retyping a sentence actually matters.

import fs from 'node:fs'
import { statePath, writeFileAtomic } from './state'

const FILE = 'prompt-history'
const CAP = 200

/// Oldest first on disk (the order it is read in), newest first in memory,
/// which is the order readline's `history` option wants.
export function loadPromptHistory(): string[] {
  try {
    return fs.readFileSync(statePath(FILE), 'utf8').split('\n').filter(Boolean).slice(-CAP).reverse()
  } catch {
    return [] // never used before, or an unreadable state dir
  }
}

/// Remember one command. Repeats collapse: ten `/contacts` in a row should be
/// one press of up-arrow away, not ten.
export function rememberCommand(line: string): void {
  const cmd = line.trim()
  if (!cmd.startsWith('/')) return
  const kept = loadPromptHistory().reverse().filter((l) => l !== cmd)
  kept.push(cmd)
  try {
    writeFileAtomic(statePath(FILE), kept.slice(-CAP).join('\n') + '\n')
  } catch {
    /* a convenience, never a reason to fail the line it came with */
  }
}

// `rcq` with no arguments: a live conversation loop. The founder's first
// personal run (2026-08-20) named the gap — typing a message must not mean
// re-running a process and re-dialing a socket. So: receive exactly like
// `watch` (backlog drain, live socket, 30s poll while the socket is down),
// with a readline prompt on top that sends to the active peer in-process.
//
// Output discipline is deliberately RELAXED here: this is a UI on a TTY, not
// a pipe — incoming lines and status share the screen, printed above the
// prompt. `rcq send`/`rcq watch` keep the strict stdout-is-data contract.

import readline from 'node:readline'
import { Api, type Contact, type RCQGroup } from '../../src/lib/api'
import type { WebIdentity } from '../../src/lib/crypto'
import { decryptIncoming, getDevice, myDeviceId, noteInboundFrom } from '../../src/lib/signal-device'
import {
  cachedContacts,
  cachedPending,
  findGroup,
  foreignHost,
  groupById,
  groupLabel,
  isContact,
  knownName,
  lookupUser,
  peerLabel,
  primeDirectory,
  refreshDirectory,
} from './directory'
import { chatLine, columns, displayRows, idColumn, noteLine, pad, snippet, stripAnsi, when } from './format'
import {
  advertiseSenderKeys,
  describeGroup,
  describeGroupError,
  listGroups,
  rosterFor,
  ruleRefusal,
  sendGroupText,
} from './groups'
import { canonical } from './aliases'
import { currentLang, LANG_CODES, normalizeLang, setLang, tr } from './i18n'
import { logRowHuman, readLog, recentThreads, threadTag, type Thread } from './log'
import { loadPromptHistory, rememberCommand } from './prompt-history'
import {
  announceGroupNews,
  describeEnvelope,
  drainQueue,
  hasThreadWith,
  hasWrittenTo,
  historyPath,
  ingestDecrypted,
  ingestGroupPacket,
  setEmitter,
  setInteractive,
  setOpenGroup,
  unreadByGroup,
  unreadIn,
  type IngestResult,
} from './receive'
import { cancelRequest, describeRequestFrame, loadRequests, respondTo, sendRequest } from './requests'
import { sendText } from './send'
import { RcqSocket } from './socket'
import { isYes, strangerCheck } from './stranger'
import { out } from './style'
import { humanError } from './errors'

/// Who the next typed line goes to. A room is a destination like a person is:
/// the whole reason `/g` exists is that the prompt used to be able to point at
/// exactly one kind of thing.
type Target = { kind: 'peer'; uin: number } | { kind: 'group'; gid: number }

/// How many lines of a thread are replayed when you walk into it. Enough to
/// remember where you left off, not so many that switching is a wall of text.
const RECAP_LINES = 8
/// Except when a room has been counting: then the recap covers what the badge
/// promised, up to here. Past this, `/log 200` is the honest answer.
const RECAP_CAP = 50
/// Conversations on the opening screen, and the default for `/recent`.
const RECENT_LINES = 6
/// How long a sent message waits for its tick before the loop forgets it. The
/// map used to be forever, so one stalled send leaked an entry for the life of
/// the process and a receipt that came back an hour later still printed.
const RECEIPT_WAIT_MS = 10 * 60 * 1000

export async function runInteractive(identity: WebIdentity): Promise<void> {
  setInteractive(true)
  await getDevice(identity).catch((e) => {
    process.stderr.write(tr('provision.v1only', { err: humanError(e) }) + '\n')
  })
  // Correct the live-frame device filter from the saved blob even when the
  // provision above failed (same reason as watch: until then currentDeviceId
  // answers 1 and frames for OUR device would be dropped).
  await myDeviceId(identity).catch(() => null)
  // This loop opens group broadcasts, so the account may say so (see the
  // warning on advertiseSenderKeys).
  advertiseSenderKeys(identity)

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'rcq> ',
    // Up-arrow reaches past this session's start. Commands only: see
    // prompt-history.ts for why a chat prompt must not write down everything
    // typed at it.
    history: loadPromptHistory(),
    historySize: 200,
    removeHistoryDuplicates: true,
  })

  let active: Target | null = null
  /// A message that has gone out and is waiting for its tick: envelope id ->
  /// who it went to and enough of it to name it, so two messages to the same
  /// person do not produce two identical "delivered" lines.
  const pendingSent = new Map<string, { uin: number; text: string; at: number }>()
  /// Receipts that arrived for ids nobody registered YET: an online peer's
  /// delivered receipt rides the live socket and can land while sendText is
  /// still awaiting its carbon POST — before handleLine ever learns the id.
  /// Checked when the send resolves; bounded, it only ever holds noise plus
  /// the race window.
  const earlyReceipts = new Set<string>()
  /// The last line the network refused, kept whole for `/retry`. Nothing typed
  /// should ever be lost to a dropped connection.
  let lastFailed: { to: Target; text: string } | null = null

  /// Print lines ABOVE the prompt: wipe the input area, write, redraw the
  /// prompt together with whatever was mid-typing.
  ///
  /// ⚠ The input area is not one row. A line long enough to wrap occupies
  /// several, and clearing exactly one of them left the rest on screen with a
  /// message printed through the middle of it. The cursor also sits wherever
  /// the person is editing, which may be any of those rows, so it walks back to
  /// the first one before the wipe.
  ///
  /// A block is cleared and redrawn ONCE: `/log 50` printed row by row is fifty
  /// clears and fifty redraws, and it flickers like it.
  const printBlock = (lines: string[]): void => {
    if (lines.length === 0) return
    const cols = process.stdout.columns ?? 0
    if (cols > 0) {
      const above = displayRows(stripAnsi(rl.getPrompt()) + rl.line.slice(0, rl.cursor), cols) - 1
      if (above > 0) readline.moveCursor(process.stdout, 0, -above)
      readline.cursorTo(process.stdout, 0)
      readline.clearScreenDown(process.stdout)
    } else {
      readline.cursorTo(process.stdout, 0)
      readline.clearLine(process.stdout, 0)
    }
    for (const line of lines) process.stdout.write(line.endsWith('\n') ? line : line + '\n')
    rl.prompt(true)
  }
  const printAbove = (line: string): void => printBlock([line])
  setEmitter(printAbove)

  // Status lines ([ws] connected, drain failures) are stderr writes scattered
  // across socket.ts/receive.ts and the reused src/lib console (bootstrap
  // points it at stderr). On a TTY they land on the same screen and would
  // tear the input row — route them through the same above-the-prompt path.
  // Restored on shutdown so the exit message behaves like a plain write.
  const rawStderr = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === 'string') {
      printAbove(chunk)
      return true
    }
    return (rawStderr as (...a: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stderr.write

  /// Ask a question on the prompt line. Incoming messages keep printing above
  /// it while it waits: readline redraws whatever prompt is current, and during
  /// a question that IS the question.
  const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res))

  /// Peers whose "you do not know this person" block has already been shown.
  /// The warning belongs before the first message, not before every one.
  const warned = new Set<number>()

  const label = (t: Target): string =>
    t.kind === 'peer' ? peerLabel(identity.uin, t.uin) : `[${groupLabel(identity.uin, t.gid)}]`

  /// The last few lines of wherever we just walked in. A terminal keeps no
  /// scrollback across restarts and the file was always there (see log.ts).
  const recap = (thread: Thread, lines = RECAP_LINES): void => {
    printBlock(readLog(identity.uin, thread, lines).map((r) => logRowHuman(identity, r)))
  }

  /// The conversations with the most recent traffic: the screen a chat client
  /// opens on. This one opened on an empty prompt, so the first move of every
  /// session was remembering a number.
  const printRecent = (n = RECENT_LINES): void => {
    const rows = recentThreads(identity.uin, n)
    if (rows.length === 0) {
      printAbove(out.dim(tr('recent.none')))
      return
    }
    const unread = unreadByGroup()
    const width = columns()
    const tagW = idColumn(rows.map((r) => threadTag(r.thread)))
    printBlock(
      rows.map((r) => {
        const t = r.thread as Exclude<Thread, null>
        const here =
          active !== null &&
          (t.kind === 'peer' ? active.kind === 'peer' && active.uin === t.uin : active.kind === 'group' && active.gid === t.gid)
        const held = t.kind === 'group' ? (unread.get(t.gid) ?? 0) : 0
        // The row already opens with `#396` in its own column, so the full
        // `Vasya (#396)` label printed the number twice and spent a third of
        // the name column doing it: with a 9-digit uin, a long nickname was
        // truncated to make room for digits already on the line.
        //
        // ⚠ EXCEPT across islands. The host rides along there, because the tag
        // column is a bare `#500`, which is the local #500 as far as anyone
        // reading can tell, and `/to 500` would reach exactly that person.
        const host = t.kind === 'peer' ? foreignHost(identity, r.host) : undefined
        const name =
          t.kind === 'peer'
            ? host
              ? peerLabel(identity.uin, t.uin, host)
              : (knownName(identity.uin, t.uin) ?? `#${t.uin}`)
            : `[${groupLabel(identity.uin, t.gid)}]`
        const stamp = when(r.at)
        const badge = held > 0 ? `+${held} ` : ''
        const said = `${r.from === identity.uin ? `${tr('recent.you')} ` : ''}${badge}${describeEnvelope(r.envelope)}`
        // One row, whatever the terminal is: a list that wraps is not a list.
        // A column of slack, because a row filling the width exactly still
        // pushes the terminal onto the next one.
        const room = Math.max(12, width - 1 - (2 + tagW + 1 + 22 + 1 + stamp.length + 2))
        return `${here ? '* ' : '  '}${threadTag(t).padEnd(tagW)} ${pad(name, 22)} ${out.dim(stamp)}  ${held > 0 ? out.yellow(snippet(said, room)) : out.dim(snippet(said, room))}`
      }),
    )
  }

  const switchTo = (t: Target, withRecap = true): void => {
    active = t
    // A badge that said "+40 new" and then showed eight lines would be a badge
    // that lied, so the recap covers at least what was counted.
    const held = t.kind === 'group' ? unreadIn(t.gid) : 0
    // A room is OPEN, not merely selected: its messages start printing instead
    // of counting, and its badge is cleared.
    setOpenGroup(t.kind === 'group' ? t.gid : null)
    if (withRecap) {
      recap(
        t.kind === 'peer' ? { kind: 'peer', uin: t.uin } : { kind: 'group', gid: t.gid },
        Math.min(Math.max(held, RECAP_LINES), RECAP_CAP),
      )
    }
    // The prompt carries the name for the same reason every line does: `#396>`
    // is a number you have to remember the owner of.
    rl.setPrompt(`${label(t)}> `)
    rl.prompt(true)
  }

  /// Fold one ingest result into the UI: delivered notes for our own sends,
  /// the room badges, and the auto-pick of the first peer who writes when
  /// nobody is active.
  const absorb = (res: IngestResult | null): void => {
    if (!res) return
    for (const id of res.receiptTargets.splice(0)) {
      const held = pendingSent.get(id)
      if (held === undefined) {
        if (earlyReceipts.size > 500) earlyReceipts.clear() // cosmetic notes only
        earlyReceipts.add(id)
        continue
      }
      pendingSent.delete(id)
      printAbove(noteLine(out.green(tr('interactive.delivered', { who: peerLabel(identity.uin, held.uin), text: snippet(held.text) }))))
    }
    // A tick that never comes is a message the peer has not picked up yet, not
    // an event: the entry is simply forgotten, and the peer keeps one tick.
    const stale = Date.now() - RECEIPT_WAIT_MS
    for (const [id, held] of pendingSent) if (held.at < stale) pendingSent.delete(id)
    announceGroupNews(identity.uin)
    if (res.lastPeerFrom !== undefined) {
      const from = res.lastPeerFrom
      res.lastPeerFrom = undefined // the live result object is long-lived
      if (active !== null) return
      const who = peerLabel(identity.uin, from)
      // Auto-pick is a convenience for a conversation you are already in. It
      // used to hand the next line typed to whoever wrote first, stranger
      // included, which is one careless Enter away from answering a spammer.
      if (isContact(identity.uin, from) || hasWrittenTo(identity.uin, from)) {
        switchTo({ kind: 'peer', uin: from }, false)
        printAbove(out.dim(tr('interactive.replyingTo', { who })))
      } else {
        printAbove(out.dim(tr('interactive.notPicked', { who, uin: from })))
      }
    }
  }

  // `let` and nullable: a Ctrl+C during the initial backlog drain reaches
  // shutdown before the timer below ever exists.
  let poll: ReturnType<typeof setInterval> | null = null
  let closing = false
  /// Lines handed to the network and not yet answered for. Leaving in the
  /// middle of one used to kill the process mid-POST: the message was neither
  /// sent nor kept, and nothing said so.
  let inFlight = 0
  const shutdown = (): void => {
    if (closing) return
    closing = true
    if (poll) clearInterval(poll)
    sock.stop()
    void (async () => {
      if (inFlight > 0) {
        printAbove(out.dim(tr('exit.finishing')))
        // Bounded: a send against a dead island can sit for the whole fetch
        // timeout, and holding the terminal hostage is its own paper cut. A
        // second Ctrl+C leaves immediately (see the SIGINT handler).
        await Promise.race([chain.catch(() => {}), new Promise((r) => setTimeout(r, 5000))])
      }
      process.stderr.write = rawStderr
      rl.close()
      // The leading newline is the prompt's: closing readline leaves the cursor
      // sitting after it, and the goodbye landed on the same row as the last
      // thing typed.
      rawStderr('\n' + tr('bye') + '\n')
      process.exit(0)
    })()
  }

  const liveOut: IngestResult = { receiptTargets: [] }
  /// The same "a live message could not be opened" note for both live paths.
  const liveFailed = (e: unknown): void => {
    // No device to open it with yet: the same envelope sits in the queue, and
    // the reconnect drain delivers it. Printed all the same: a message that
    // silently never appears is the worst thing a chat client can do.
    printAbove(out.dim(tr('fail.live', { err: humanError(e) })))
  }
  const sock = new RcqSocket(identity, {
    onSealed: (frame) => {
      void (async () => {
        const got = await decryptIncoming(identity, frame.payload)
        if (!got) return
        if (got.senderUIN !== identity.uin) noteInboundFrom(got.senderUIN, got.senderDeviceId)
        await ingestDecrypted(identity, got, frame.group_id, liveOut)
        absorb(liveOut)
      })().catch(liveFailed)
    },
    onGroup: (frame) => {
      void (async () => {
        await ingestGroupPacket(identity, frame.payload, frame.group_id, liveOut, frame.seq)
        absorb(liveOut)
      })().catch(liveFailed)
    },
    onControl: (frame) => {
      // Somebody asked to be let in, or answered our asking. Not an envelope:
      // the island writes these itself, and they used to be dropped whole.
      const line = describeRequestFrame(identity, frame)
      if (line) printAbove(out.yellow(line))
    },
    onOpen: () => {
      void drainQueue(identity).then(absorb)
    },
    onAuthRejected: () => {
      process.stderr.write = rawStderr
      rawStderr(`rcq: ${tr('err.sessionRejected')}\n`)
      process.exit(1)
    },
  })

  /// The rooms this account is in, with what is waiting in each.
  function printGroups(): void {
    const groups = listGroups(identity.uin)
    if (groups.length === 0) {
      printAbove(tr('interactive.noGroups'))
      return
    }
    const unread = unreadByGroup()
    const tagW = idColumn(groups.map((g) => `g${g.id}`))
    const width = columns()
    printBlock(
      groups.map((g) => {
        const mark = active?.kind === 'group' && active.gid === g.id ? '* ' : '  '
        const n = unread.get(g.id) ?? 0
        // Same columns as /recent and /contacts: three lists that line up read
        // as one client, three that do not read as three.
        const badge = n > 0 ? `+${n} ` : ''
        const rest = snippet(`${badge}${describeGroup(identity, g)}`, Math.max(12, width - 1 - (2 + tagW + 1 + 22 + 1)))
        return `${mark}${`g${g.id}`.padEnd(tagW)} ${pad(g.name, 22)} ${n > 0 ? out.yellow(rest) : out.dim(rest)}`
      }),
    )
  }

  /// Open a room, or list them when nothing was named.
  async function openGroup(arg: string): Promise<void> {
    if (!arg) {
      printGroups()
      return
    }
    const g = findGroup(identity.uin, arg)
    if (!g) {
      printAbove(out.yellow(tr('group.unknown', { what: arg })))
      printGroups()
      return
    }
    // What the room IS, then what was last said in it: a header under the
    // recap reads as a footnote to somebody else's conversation.
    printAbove(out.dim(`[${g.name}] ${describeGroup(identity, g)}`))
    switchTo({ kind: 'group', gid: g.id })
    // The roster in the background: the first line typed should not pay for it,
    // and a stale one is how a new member ends up unable to read the room.
    void rosterFor(identity, g).catch(() => null)
  }

  /// A line the network would not take. The text is on screen already (it is
  /// echoed before the send) and now it is held for `/retry` as well: a dropped
  /// connection must never cost what somebody typed.
  const sendFailed = (to: Target, text: string, why: string): void => {
    lastFailed = { to, text }
    printBlock([noteLine(out.red(tr('send.failedTo', { who: label(to), err: why }))), out.dim(tr('send.retryHint'))])
  }

  /// Post one line into the active room.
  async function sendToGroup(gid: number, text: string): Promise<void> {
    const base = groupById(identity.uin, gid)
    if (!base) {
      printAbove(out.yellow(tr('group.unknown', { what: `g${gid}` })))
      return
    }
    let group: RCQGroup
    try {
      group = await rosterFor(identity, base)
    } catch (e) {
      // Already a whole sentence about the message, not about the fetch.
      printAbove(out.red(humanError(e)))
      printAbove(out.dim(tr('send.kept', { text })))
      return
    }
    // The room's own rules, before the island answers with a status code,
    // and before the echo, so a refused line is never shown as one that went.
    const refusal = ruleRefusal(identity, group, text)
    if (refusal) {
      printAbove(out.yellow(refusal))
      printAbove(out.dim(tr('send.kept', { text })))
      return
    }
    printAbove(chatLine(undefined, out.green(`me -> [${group.name}]`), text))
    let sent: { id: string; mode: string }
    try {
      sent = await sendGroupText(identity, group, text)
    } catch (e) {
      sendFailed({ kind: 'group', gid }, text, describeGroupError(e))
      return
    }
    // A room has as many recipients as members, so there is no tick to wait
    // for. The mode (one broadcast, N seals) is protocol detail.
    if (process.env.RCQ_VERBOSE) printAbove(out.dim(`(${sent.mode})`))
  }

  /// Send one line to a person.
  ///
  /// ⚠ The echo comes FIRST. The loop used to await the send and print
  /// afterwards, so on a slow network the typed text left the input row and
  /// nothing at all appeared for up to thirty seconds, and if the send threw,
  /// the text was simply gone.
  async function sendToPeer(to: number, text: string, gated = true): Promise<void> {
    // The gate, at the one moment it means anything: the first message of a
    // thread with somebody who is neither a contact nor anybody this account
    // has ever exchanged a word with. Everything after that goes straight out.
    // `/retry` does not ask again: the question was answered a moment ago.
    if (gated && !(await confirmFirstMessage(to, text))) return
    const who = peerLabel(identity.uin, to)
    printAbove(chatLine(undefined, out.green(`me -> ${who}`), text))
    let sent: { id: string; mode: string }
    try {
      sent = await sendText(identity, to, text)
    } catch (e) {
      sendFailed({ kind: 'peer', uin: to }, text, humanError(e))
      return
    }
    if (process.env.RCQ_VERBOSE) printAbove(out.dim(`(${sent.mode})`))
    if (earlyReceipts.delete(sent.id)) {
      // The receipt outran us (see earlyReceipts): settle it now.
      printAbove(noteLine(out.green(tr('interactive.delivered', { who, text: snippet(text) }))))
    } else {
      pendingSent.set(sent.id, { uin: to, text, at: Date.now() })
    }
  }

  async function printRequests(): Promise<void> {
    let lists
    try {
      lists = await loadRequests(identity)
    } catch (e) {
      printAbove(out.red(tr('fail.command', { cmd: '/requests', err: humanError(e) })))
      return
    }
    if (lists.incoming.length === 0 && lists.outgoing.length === 0) {
      printAbove(tr('req.none'))
      return
    }
    printBlock([
      ...lists.incoming.map(
        (r) => `  ${out.yellow('<-')} ${peerLabel(identity.uin, r.from_uin)}  ${out.dim(tr('req.answerHint', { uin: r.from_uin }))}`,
      ),
      ...lists.outgoing.map(
        (r) =>
          `  ${out.dim('->')} ${peerLabel(identity.uin, r.to_uin)}  ${out.dim(r.state === 'declined' ? tr('req.stateDeclined') : tr('req.statePending'))}`,
      ),
    ])
  }

  async function answerRequest(arg: string, accept: boolean): Promise<void> {
    const uin = Number(arg)
    if (!Number.isInteger(uin) || uin <= 0) {
      printAbove(tr(accept ? 'interactive.usageAccept' : 'interactive.usageDecline'))
      return
    }
    let res
    try {
      res = await respondTo(identity, uin, accept)
    } catch (e) {
      printAbove(out.red(tr('fail.command', { cmd: accept ? '/accept' : '/decline', err: humanError(e) })))
      return
    }
    if (!res.ok) {
      printAbove(out.yellow(res.reason))
      return
    }
    const who = peerLabel(identity.uin, uin)
    printAbove(out.dim(res.answer === 'accepted' ? tr('req.youAccepted', { who }) : tr('req.youDeclined', { who })))
    if (res.answer === 'accepted') await refreshDirectory(identity).catch(() => null)
  }

  async function handleLine(raw: string): Promise<void> {
    const line = raw.trim()
    if (!line) return
    if (line.startsWith('/')) {
      const word = line.split(/\s+/, 1)[0].toLowerCase()
      const arg = line.slice(word.length).trim()
      // The alias table resolves `/req` and `/requests` to the same verb, so
      // the switch below cases on canonical names; `word` is kept for the
      // "unknown command" line, which should echo what was actually typed.
      return runCommand(canonical(word.slice(1)), arg, word)
    }
    // Muscle memory from the one-shot commands: `rcq send 911 hi` typed INTO
    // rcq would go out as literal text starting with the word "rcq". Catch it
    // — the founder typed exactly this into watch on day one.
    if (/^rcq(\s|$)/.test(line)) {
      printAbove(out.dim(tr('interactive.insideRcq')))
      return
    }
    if (active === null) {
      printAbove(tr('interactive.noActive'))
      return
    }
    if (active.kind === 'group') return sendToGroup(active.gid, line)
    return sendToPeer(active.uin, line)
  }

  /// Everything behind a slash, keyed on the CANONICAL verb (see aliases.ts):
  /// the caller has already resolved `/req` and `/requests` to `requests`.
  /// `typed` is the literal `/word` for the one line that echoes it back.
  async function runCommand(verb: string, arg: string, typed: string): Promise<void> {
    switch (verb) {
      case 'quit':
        shutdown()
        return
      case 'help':
        printAbove(tr('interactive.help'))
        return
      case 'contacts': {
        let list: Contact[]
        try {
          list = await refreshDirectory(identity)
        } catch (e) {
          // Offline is not an error worth a stack trace: the roster from the last
          // run is on disk and is what the labels are using anyway.
          list = cachedContacts(identity.uin)
          printAbove(out.dim(tr('fail.contacts', { err: humanError(e) })))
        }
        if (list.length === 0) {
          printAbove(tr('interactive.noContacts'))
          return
        }
        const tagW = idColumn(list.map((c) => `#${c.uin}`))
        printBlock(
          list.map((c) => {
            const mark = active?.kind === 'peer' && active.uin === c.uin ? '* ' : '  '
            return `${mark}${`#${c.uin}`.padEnd(tagW)} ${pad(c.nickname, 22)} ${out.dim(c.status)}${c.blocked ? `  ${out.yellow('blocked')}` : ''}`
          }),
        )
        return
      }
      case 'groups':
        return openGroup(arg)
      case 'log': {
        const n = Number(arg) > 0 ? Number(arg) : 20
        const thread: Thread = active
          ? active.kind === 'peer'
            ? { kind: 'peer', uin: active.uin }
            : { kind: 'group', gid: active.gid }
          : null
        const rows = readLog(identity.uin, thread, n)
        if (rows.length === 0) {
          printAbove(tr('log.empty'))
          return
        }
        printBlock(rows.map((r) => logRowHuman(identity, r)))
        return
      }
      case 'recent':
        printRecent(Number(arg) > 0 ? Number(arg) : RECENT_LINES)
        return
      case 'retry': {
        const held = lastFailed
        if (!held) {
          printAbove(out.dim(tr('retry.nothing')))
          return
        }
        lastFailed = null
        // Straight back out, no second stranger question: it was answered when
        // the line was first typed, and the send is what failed.
        return held.to.kind === 'peer' ? sendToPeer(held.to.uin, held.text, false) : sendToGroup(held.to.gid, held.text)
      }
      case 'requests':
        return printRequests()
      case 'accept':
        return answerRequest(arg, true)
      case 'decline':
        return answerRequest(arg, false)
      case 'cancel': {
        const uin = Number(arg)
        if (!Number.isInteger(uin) || uin <= 0) {
          printAbove(tr('interactive.usageCancel'))
          return
        }
        try {
          await cancelRequest(identity, uin)
        } catch (e) {
          printAbove(out.red(tr('fail.command', { cmd: '/cancel', err: humanError(e) })))
          return
        }
        printAbove(out.dim(tr('req.cancelled', { who: peerLabel(identity.uin, uin) })))
        return
      }
      case 'find': {
        if (!arg) {
          printAbove(tr('interactive.usageFind'))
          return
        }
        let found
        try {
          found = await Api.searchUsers(identity, arg)
        } catch (e) {
          printAbove(out.red(tr('fail.command', { cmd: '/find', err: humanError(e) })))
          return
        }
        if (found.length === 0) {
          printAbove(tr('find.none', { q: arg }))
          return
        }
        const w = idColumn(found.map((u) => `#${u.uin}`))
        printBlock(found.map((u) => `  ${`#${u.uin}`.padEnd(w)} ${pad(u.nickname, 22)} ${out.dim(u.status)}`))
        return
      }
      case 'who': {
        const uin = Number(arg)
        if (!Number.isInteger(uin) || uin <= 0) {
          printAbove(tr('interactive.usageWho'))
          return
        }
        const got = await lookupUser(identity, uin)
        if (got.state === 'missing') {
          printAbove(out.yellow(tr('stranger.missing', { uin })))
          return
        }
        const notes = [
          isContact(identity.uin, uin) ? tr('who.contact') : tr('who.stranger'),
          hasThreadWith(identity.uin, uin) ? tr('who.thread') : tr('who.noThread'),
        ]
        if (got.state === 'unknown') notes.push(tr('who.unreachable', { uin }))
        printAbove(`${peerLabel(identity.uin, uin)}  ${out.dim(notes.join('; '))}`)
        return
      }
      case 'to': {
        const uin = Number(arg)
        if (!Number.isInteger(uin) || uin <= 0) {
          printAbove(tr('interactive.usageTo'))
          return
        }
        // Picking somebody is where the warning belongs: before a line is typed,
        // not after it has been sent. Switching still costs nothing, so the
        // question itself waits for the first message.
        const check = await strangerCheck(identity, uin)
        if (check) {
          warned.add(uin)
          for (const l of check.lines) printAbove(out.yellow(l))
          // A prompt pointed at a uin nobody holds can only produce a failed
          // send with an error about key bundles.
          if (check.missing) return
          printAbove(out.dim(tr('stranger.willAsk')))
        }
        // No "now talking to X" line: the prompt itself becomes their name, and
        // saying it twice is one more line between you and the conversation.
        switchTo({ kind: 'peer', uin })
        return
      }
      case 'nick': {
        if (!arg) {
          printAbove(tr('interactive.usageNick'))
          return
        }
        try {
          await Api.updateProfile(identity, { nickname: arg })
        } catch (e) {
          printAbove(out.red(tr('fail.command', { cmd: '/nick', err: humanError(e) })))
          return
        }
        printAbove(out.dim(tr('nick.done', { name: arg })))
        return
      }
      case 'add': {
        const uin = Number(arg)
        if (!Number.isInteger(uin) || uin <= 0) {
          printAbove(tr('interactive.usageAdd'))
          return
        }
        if ((await lookupUser(identity, uin)).state === 'missing') {
          printAbove(out.yellow(tr('stranger.missing', { uin })))
          return
        }
        let state
        try {
          state = await sendRequest(identity, uin)
        } catch (e) {
          printAbove(out.red(tr('fail.command', { cmd: '/add', err: humanError(e) })))
          return
        }
        const who = peerLabel(identity.uin, uin)
        // The island auto-accepts when they had already asked for us. Reporting
        // that as "request sent" hid the one case where adding just worked.
        printAbove(
          out.dim(
            state === 'accepted' ? tr('add.mutual', { who }) : state === 'already' ? tr('add.already', { who }) : tr('add.sent', { who }),
          ),
        )
        if (state !== 'pending') await refreshDirectory(identity).catch(() => null)
        return
      }
      case 'block':
      case 'unblock': {
        const uin = Number(arg)
        if (!Number.isInteger(uin) || uin <= 0) {
          printAbove(tr('interactive.usageBlock'))
          return
        }
        const on = verb === 'block'
        try {
          await Api.blockContact(identity, uin, on)
        } catch (e) {
          printAbove(out.red(tr('fail.command', { cmd: typed, err: humanError(e) })))
          return
        }
        const who = peerLabel(identity.uin, uin)
        printAbove(out.dim(on ? tr('block.done', { who }) : tr('block.undone', { who })))
        await refreshDirectory(identity).catch(() => null)
        return
      }
      case 'remove': {
        const uin = Number(arg)
        if (!Number.isInteger(uin) || uin <= 0) {
          printAbove(tr('interactive.usageRemove'))
          return
        }
        const who = peerLabel(identity.uin, uin)
        // Mutual, and there is no undo but asking again: worth one question.
        if (!isYes(await ask(tr('remove.confirm', { who })))) return
        try {
          await Api.removeContact(identity, uin)
        } catch (e) {
          printAbove(out.red(tr('fail.command', { cmd: '/remove', err: humanError(e) })))
          return
        }
        printAbove(out.dim(tr('remove.done', { who })))
        await refreshDirectory(identity).catch(() => null)
        return
      }
      // ⚠ The four below are not conveniences. One rcq holds the state lock for
      // its dir (see state.ts), so while this prompt is open `rcq whoami` in
      // another terminal REFUSES to run: a verb with no slash of its own is a
      // verb nobody can reach without quitting the conversation first.
      case 'whoami': {
        const dev = await myDeviceId(identity).catch(() => null)
        const nick = await Api.myInfo(identity)
          .then((m) => m.nickname ?? null)
          .catch(() => null)
        printBlock([
          `  ${tr('label.nickname')}: ${nick ?? '-'}  ${out.dim(`#${identity.uin}`)}`,
          `  ${tr('label.island')}: ${identity.apiBase}`,
          `  ${tr('label.device')}: ${dev ?? '-'}`,
        ])
        return
      }
      case 'join': {
        const gid = Number(arg.replace(/^g/i, ''))
        if (!Number.isInteger(gid) || gid <= 0) {
          printAbove(tr('join.needsId'))
          return
        }
        const preview = await Api.groupPreview(identity, gid).catch(() => null)
        if (!preview) {
          printAbove(out.yellow(tr('join.noSuchGroup', { gid })))
          return
        }
        if (preview.is_closed) {
          printAbove(out.yellow(tr('join.closed', { name: preview.name })))
          return
        }
        let group: RCQGroup
        try {
          group = await Api.joinGroup(identity, gid)
        } catch (e) {
          printAbove(out.red(tr('join.failed', { err: describeGroupError(e) })))
          return
        }
        await refreshDirectory(identity).catch(() => null)
        printAbove(out.dim(tr('join.done', { name: group.name })))
        // Straight in: joining a room and then having to type /g for it is one
        // step nobody wants.
        return openGroup(String(group.id))
      }
      // Leaving used to be impossible from the console - the founder called it a
      // trap. `/leave` steps out of the room you name, or the one you are in.
      case 'leave': {
        const g = arg ? findGroup(identity.uin, arg) : active?.kind === 'group' ? groupById(identity.uin, active.gid) : null
        if (!g) {
          printAbove(out.yellow(tr('leave.needsId')))
          return
        }
        try {
          await Api.removeGroupMember(identity, g.id, identity.uin)
        } catch (e) {
          // Not swallowed: the whole point of this verb is that leaving works or
          // says why it did not.
          printAbove(out.red(tr('leave.failed', { err: describeGroupError(e) })))
          return
        }
        // Standing in the room we just left: step back to the bare prompt.
        if (active?.kind === 'group' && active.gid === g.id) {
          active = null
          setOpenGroup(null)
          rl.setPrompt('rcq> ')
          rl.prompt(true)
        }
        await refreshDirectory(identity).catch(() => null)
        printAbove(out.dim(tr('leave.done', { name: g.name })))
        return
      }
      case 'create': {
        if (!arg) {
          printAbove(tr('interactive.usageCreate'))
          return
        }
        let group: RCQGroup
        try {
          group = await Api.createGroup(identity, arg, [])
        } catch (e) {
          printAbove(out.red(tr('create.failed', { err: describeGroupError(e) })))
          return
        }
        await refreshDirectory(identity).catch(() => null)
        printAbove(out.dim(tr('create.done', { name: group.name })))
        return openGroup(String(group.id))
      }
      case 'invite': {
        // `/invite <uin>` into the active room, or `/invite g<id> <uin>` for any.
        const parts = arg.split(/\s+/).filter(Boolean)
        let gid: number | null = null
        let uinTok: string | undefined
        if (parts.length >= 2) {
          gid = Number(parts[0].replace(/^g/i, ''))
          uinTok = parts[1]
        } else if (parts.length === 1 && active?.kind === 'group') {
          gid = active.gid
          uinTok = parts[0]
        }
        const uin = Number(uinTok)
        if (!gid || !Number.isInteger(gid) || gid <= 0 || !Number.isInteger(uin) || uin <= 0) {
          printAbove(tr('interactive.usageInvite'))
          return
        }
        const base = groupById(identity.uin, gid)
        if (!base) {
          printAbove(out.yellow(tr('group.notMember', { gid })))
          return
        }
        try {
          await Api.addGroupMember(identity, gid, uin)
        } catch (e) {
          printAbove(out.red(tr('invite.failed', { who: peerLabel(identity.uin, uin), err: describeGroupError(e) })))
          return
        }
        await refreshDirectory(identity).catch(() => null)
        printAbove(out.dim(tr('invite.done', { who: peerLabel(identity.uin, uin), name: base.name })))
        return
      }
      case 'export':
        printAbove(out.dim(tr('export.at', { file: historyPath(identity.uin) })))
        return
      case 'lang': {
        if (!arg) {
          printBlock([`  ${currentLang()}`, out.dim(tr('lang.usage', { codes: LANG_CODES }))])
          return
        }
        const pick = normalizeLang(arg)
        if (!pick) {
          printAbove(out.yellow(tr('lang.invalid', { arg, codes: LANG_CODES })))
          return
        }
        setLang(pick)
        printAbove(out.dim(tr('lang.set', { lang: pick })))
        return
      }
      default:
        printAbove(tr('interactive.unknownSlash', { cmd: typed }))
    }
  }

  /// Warn, then ask, then remember the answer for the rest of the thread. A
  /// refusal prints the text back rather than swallowing it.
  async function confirmFirstMessage(to: number, text: string): Promise<boolean> {
    const check = await strangerCheck(identity, to)
    if (!check) return true
    if (!warned.has(to)) {
      warned.add(to)
      for (const l of check.lines) printAbove(out.yellow(l))
    }
    if (check.missing) return false
    if (isYes(await ask(tr('stranger.confirm', { who: check.label })))) return true
    printAbove(out.dim(tr('send.kept', { text })))
    return false
  }

  // Lines are handled strictly one after another: two concurrent sendText
  // calls would race the in-memory ratchet advance for the same peer.
  let chain: Promise<void> = Promise.resolve()
  rl.on('line', (raw) => {
    rememberCommand(raw)
    // Only a MESSAGE is "still going out". Counting every line counted the
    // `/quit` that triggers the shutdown as well, so every clean exit claimed
    // to be finishing a message nobody had sent.
    const typed = raw.trim()
    // Leaving does NOT queue. Every other line waits its turn because the
    // ratchet cannot be advanced twice at once, but `/quit` behind three
    // stalled sends meant forty-six seconds of a terminal that had accepted
    // the word "quit" and gone blank. Ctrl+C never queued; typing the verb
    // should not be the slower way out. shutdown() reports what is genuinely
    // still in flight and gives it five seconds.
    if (typed.startsWith('/') && canonical(typed.slice(1).split(/\s+/, 1)[0].toLowerCase()) === 'quit') {
      shutdown()
      return
    }
    const isMessage = typed.length > 0 && !typed.startsWith('/') && !/^rcq(\s|$)/.test(typed)
    // A line typed while the one before it is still on the wire. readline has
    // already taken it off the input row, and its echo cannot print until the
    // chain reaches it, which on a dead connection was forty seconds of a
    // prompt that looked idle and had in fact swallowed two sentences.
    if (isMessage && inFlight > 0) printAbove(out.dim(tr('send.queued', { text: snippet(typed) })))
    if (isMessage) inFlight++
    chain = chain
      .then(() => handleLine(raw))
      .catch((e) => printAbove(`rcq: ${humanError(e)}`))
      .finally(() => {
        if (isMessage) inFlight--
      })
  })
  // readline swallows the signal into this event. Ctrl+C on a line you are
  // still typing throws the LINE away, which is what it does in every shell;
  // it used to end the session, so an abandoned sentence cost the whole run.
  // On an empty line it leaves, and a second one during the wind-down goes now.
  rl.on('SIGINT', () => {
    if (closing) process.exit(0)
    if (rl.line.length > 0) {
      rl.write(null, { ctrl: true, name: 'u' }) // kill to the start of the line
      rl.write(null, { ctrl: true, name: 'k' }) // and the rest of it
      return
    }
    shutdown()
  })
  rl.on('close', shutdown) // Ctrl+D

  process.stderr.write(tr('interactive.hello', { uin: identity.uin }) + '\n')
  // Names before the backlog prints, not after: the drain is where the first
  // lines of the session come from (see directory.ts).
  await primeDirectory(identity)
  // Where you left off, the way any chat client opens. Before the drain, so
  // whatever arrived while this box was away prints UNDER the list of threads
  // it belongs to rather than being buried by it.
  printRecent()
  // Somebody is waiting on an answer from this account. Said at the door, not
  // discovered a week later.
  const pending = cachedPending(identity.uin)
  if (pending.length > 0) process.stderr.write(out.yellow(tr('req.waiting', { n: pending.length })) + '\n')
  // The backlog first (its lines print above the still-empty prompt), socket
  // second, and keep draining on a timer while no socket is open — same
  // network reality as watch: HTTPS may answer while every WebSocket dies.
  absorb(await drainQueue(identity))
  sock.start()
  poll = setInterval(() => {
    if (!sock.isOpen) void drainQueue(identity).then(absorb)
  }, 30_000)
  rl.prompt()
}

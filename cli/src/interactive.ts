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
  groupById,
  groupLabel,
  isContact,
  lookupUser,
  peerLabel,
  primeDirectory,
  refreshDirectory,
} from './directory'
import {
  advertiseSenderKeys,
  describeGroup,
  describeGroupError,
  listGroups,
  rosterFor,
  ruleRefusal,
  sendGroupText,
} from './groups'
import { tr } from './i18n'
import { logRowHuman, readLog, type Thread } from './log'
import {
  announceGroupNews,
  drainQueue,
  hasThreadWith,
  hasWrittenTo,
  ingestDecrypted,
  ingestGroupPacket,
  setEmitter,
  setInteractive,
  setOpenGroup,
  stamp,
  unreadByGroup,
  unreadIn,
  type IngestResult,
} from './receive'
import { cancelRequest, describeRequestFrame, loadRequests, respondTo, sendRequest } from './requests'
import { sendText } from './send'
import { RcqSocket } from './socket'
import { isYes, strangerCheck } from './stranger'
import { out } from './style'

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

export async function runInteractive(identity: WebIdentity): Promise<void> {
  setInteractive(true)
  await getDevice(identity).catch((e) => {
    process.stderr.write(tr('provision.v1only', { err: e instanceof Error ? e.message : String(e) }) + '\n')
  })
  // Correct the live-frame device filter from the saved blob even when the
  // provision above failed (same reason as watch: until then currentDeviceId
  // answers 1 and frames for OUR device would be dropped).
  await myDeviceId(identity).catch(() => null)
  // This loop opens group broadcasts, so the account may say so (see the
  // warning on advertiseSenderKeys).
  advertiseSenderKeys(identity)

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'rcq> ' })

  let active: Target | null = null
  /// envelope id -> peer uin, for the one-time "delivered" note per message.
  const pendingSent = new Map<string, number>()
  /// Receipts that arrived for ids nobody registered YET: an online peer's
  /// delivered receipt rides the live socket and can land while sendText is
  /// still awaiting its carbon POST — before handleLine ever learns the id.
  /// Checked when the send resolves; bounded, it only ever holds noise plus
  /// the race window.
  const earlyReceipts = new Set<string>()

  /// Print a line ABOVE the prompt: clear the input row, write, redraw the
  /// prompt together with whatever was mid-typing.
  const printAbove = (line: string): void => {
    readline.cursorTo(process.stdout, 0)
    readline.clearLine(process.stdout, 0)
    process.stdout.write(line.endsWith('\n') ? line : line + '\n')
    rl.prompt(true)
  }
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
    for (const r of readLog(identity.uin, thread, lines)) printAbove(logRowHuman(identity, r))
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
      const uin = pendingSent.get(id)
      if (uin === undefined) {
        if (earlyReceipts.size > 500) earlyReceipts.clear() // cosmetic notes only
        earlyReceipts.add(id)
        continue
      }
      pendingSent.delete(id)
      const who = peerLabel(identity.uin, uin)
      printAbove(`${out.dim(`[${stamp()}]`)} ${out.green(tr('interactive.delivered', { who }))}`)
    }
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
  const shutdown = (): void => {
    if (closing) return
    closing = true
    if (poll) clearInterval(poll)
    sock.stop()
    process.stderr.write = rawStderr
    rl.close()
    rawStderr(tr('bye') + '\n')
    process.exit(0)
  }

  const liveOut: IngestResult = { receiptTargets: [] }
  /// The same "a live message could not be opened" note for both live paths.
  const liveFailed = (e: unknown): void => {
    // No device to open it with yet: the same envelope sits in the queue, and
    // the reconnect drain delivers it. Printed all the same: a message that
    // silently never appears is the worst thing a chat client can do.
    printAbove(out.dim(tr('fail.live', { err: e instanceof Error ? e.message : String(e) })))
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
        await ingestGroupPacket(identity, frame.payload, frame.group_id, liveOut)
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
    for (const g of groups) {
      const mark = active?.kind === 'group' && active.gid === g.id ? '* ' : '  '
      const n = unread.get(g.id) ?? 0
      const badge = n > 0 ? out.yellow(` +${n}`) : ''
      printAbove(`${mark}g${g.id}  ${g.name}${badge}  ${out.dim(describeGroup(identity, g))}`)
    }
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
      printAbove(out.red(e instanceof Error ? e.message : String(e)))
      printAbove(out.dim(tr('send.kept', { text })))
      return
    }
    // The room's own rules, before the island answers with a status code.
    const refusal = ruleRefusal(identity, group, text)
    if (refusal) {
      printAbove(out.yellow(refusal))
      printAbove(out.dim(tr('send.kept', { text })))
      return
    }
    let sent: { id: string; mode: string }
    try {
      sent = await sendGroupText(identity, group, text)
    } catch (e) {
      printAbove(out.red(tr('send.failed', { err: describeGroupError(e) })))
      printAbove(out.dim(tr('send.kept', { text })))
      return
    }
    printAbove(
      `${out.dim(`[${stamp()}]`)} ${out.green(`me -> [${group.name}]`)}: ${text}${process.env.RCQ_VERBOSE ? out.dim(` (${sent.mode})`) : ''}`,
    )
  }

  async function printRequests(): Promise<void> {
    let lists
    try {
      lists = await loadRequests(identity)
    } catch (e) {
      printAbove(out.red(tr('fail.command', { cmd: '/requests', err: e instanceof Error ? e.message : String(e) })))
      return
    }
    if (lists.incoming.length === 0 && lists.outgoing.length === 0) {
      printAbove(tr('req.none'))
      return
    }
    for (const r of lists.incoming) {
      printAbove(`  ${out.yellow('<-')} ${peerLabel(identity.uin, r.from_uin)}  ${out.dim(tr('req.answerHint', { uin: r.from_uin }))}`)
    }
    for (const r of lists.outgoing) {
      const state = r.state === 'declined' ? tr('req.stateDeclined') : tr('req.statePending')
      printAbove(`  ${out.dim('->')} ${peerLabel(identity.uin, r.to_uin)}  ${out.dim(state)}`)
    }
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
      printAbove(out.red(tr('fail.command', { cmd: accept ? '/accept' : '/decline', err: e instanceof Error ? e.message : String(e) })))
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
      const cmd = line.split(/\s+/, 1)[0].toLowerCase()
      const arg = line.slice(cmd.length).trim()
      return runCommand(cmd, arg)
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
    const to = active.uin
    // The gate, at the one moment it means anything: the first message of a
    // thread with somebody who is neither a contact nor anybody this account
    // has ever exchanged a word with. Everything after that goes straight out.
    if (!(await confirmFirstMessage(to, line))) return
    const who = peerLabel(identity.uin, to)
    let sent: { id: string; mode: string }
    try {
      sent = await sendText(identity, to, line)
    } catch (e) {
      // The text is gone from the input line, so it is printed back: a failed
      // send must not also cost what was typed.
      printAbove(out.red(tr('send.failed', { err: e instanceof Error ? e.message : String(e) })))
      printAbove(out.dim(tr('send.kept', { text: line })))
      return
    }
    printAbove(`${out.dim(`[${stamp()}]`)} ${out.green(`me -> ${who}`)}: ${line}${process.env.RCQ_VERBOSE ? out.dim(` (${sent.mode})`) : ''}`)
    if (earlyReceipts.delete(sent.id)) {
      // The receipt outran us (see earlyReceipts) — settle it now.
      printAbove(`${out.dim(`[${stamp()}]`)} ${out.green(tr('interactive.delivered', { who }))}`)
    } else {
      pendingSent.set(sent.id, to)
    }
  }

  /// Everything behind a slash. One switch rather than a chain of prefix
  /// tests: there are enough of these now that the chain was the hard part to
  /// read, and a verb that takes no argument must not swallow one.
  async function runCommand(cmd: string, arg: string): Promise<void> {
    switch (cmd) {
      case '/quit':
      case '/q':
      case '/exit':
        shutdown()
        return
      case '/help':
      case '/?':
        printAbove(tr('interactive.help'))
        return
      case '/contacts': {
        let list: Contact[]
        try {
          list = await refreshDirectory(identity)
        } catch (e) {
          // Offline is not an error worth a stack trace: the roster from the last
          // run is on disk and is what the labels are using anyway.
          list = cachedContacts(identity.uin)
          printAbove(out.dim(tr('fail.contacts', { err: e instanceof Error ? e.message : String(e) })))
        }
        if (list.length === 0) {
          printAbove(tr('interactive.noContacts'))
          return
        }
        for (const c of list) {
          const mark = active?.kind === 'peer' && active.uin === c.uin ? '* ' : '  '
          printAbove(`${mark}#${c.uin}  ${c.nickname}  ${c.status}${c.blocked ? `  ${out.yellow('blocked')}` : ''}`)
        }
        return
      }
      case '/g':
      case '/groups':
        return openGroup(arg)
      case '/log': {
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
        for (const r of rows) printAbove(logRowHuman(identity, r))
        return
      }
      case '/requests':
        return printRequests()
      case '/accept':
        return answerRequest(arg, true)
      case '/decline':
        return answerRequest(arg, false)
      case '/cancel': {
        const uin = Number(arg)
        if (!Number.isInteger(uin) || uin <= 0) {
          printAbove(tr('interactive.usageCancel'))
          return
        }
        try {
          await cancelRequest(identity, uin)
        } catch (e) {
          printAbove(out.red(tr('fail.command', { cmd: '/cancel', err: e instanceof Error ? e.message : String(e) })))
          return
        }
        printAbove(out.dim(tr('req.cancelled', { who: peerLabel(identity.uin, uin) })))
        return
      }
      case '/find': {
        if (!arg) {
          printAbove(tr('interactive.usageFind'))
          return
        }
        let found
        try {
          found = await Api.searchUsers(identity, arg)
        } catch (e) {
          printAbove(out.red(tr('fail.command', { cmd: '/find', err: e instanceof Error ? e.message : String(e) })))
          return
        }
        if (found.length === 0) {
          printAbove(tr('find.none', { q: arg }))
          return
        }
        for (const u of found) printAbove(`  #${u.uin}  ${u.nickname}  ${out.dim(u.status)}`)
        return
      }
      case '/who': {
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
      case '/to': {
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
      case '/nick': {
        if (!arg) {
          printAbove(tr('interactive.usageNick'))
          return
        }
        try {
          await Api.updateProfile(identity, { nickname: arg })
        } catch (e) {
          printAbove(out.red(tr('fail.command', { cmd: '/nick', err: e instanceof Error ? e.message : String(e) })))
          return
        }
        printAbove(out.dim(tr('nick.done', { name: arg })))
        return
      }
      case '/add': {
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
          printAbove(out.red(tr('fail.command', { cmd: '/add', err: e instanceof Error ? e.message : String(e) })))
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
      case '/block':
      case '/unblock': {
        const uin = Number(arg)
        if (!Number.isInteger(uin) || uin <= 0) {
          printAbove(tr('interactive.usageBlock'))
          return
        }
        const on = cmd === '/block'
        try {
          await Api.blockContact(identity, uin, on)
        } catch (e) {
          printAbove(out.red(tr('fail.command', { cmd, err: e instanceof Error ? e.message : String(e) })))
          return
        }
        const who = peerLabel(identity.uin, uin)
        printAbove(out.dim(on ? tr('block.done', { who }) : tr('block.undone', { who })))
        await refreshDirectory(identity).catch(() => null)
        return
      }
      case '/remove': {
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
          printAbove(out.red(tr('fail.command', { cmd: '/remove', err: e instanceof Error ? e.message : String(e) })))
          return
        }
        printAbove(out.dim(tr('remove.done', { who })))
        await refreshDirectory(identity).catch(() => null)
        return
      }
      default:
        printAbove(tr('interactive.unknownSlash', { cmd }))
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
    chain = chain
      .then(() => handleLine(raw))
      .catch((e) => printAbove(`rcq: ${e instanceof Error ? e.message : e}`))
  })
  rl.on('SIGINT', shutdown) // readline swallows the signal into this event
  rl.on('close', shutdown) // Ctrl+D

  process.stderr.write(tr('interactive.hello', { uin: identity.uin }) + '\n')
  // Names before the backlog prints, not after: the drain is where the first
  // lines of the session come from (see directory.ts).
  await primeDirectory(identity)
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

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
import { Api, type Contact } from '../../src/lib/api'
import type { WebIdentity } from '../../src/lib/crypto'
import { decryptIncoming, getDevice, myDeviceId, noteInboundFrom } from '../../src/lib/signal-device'
import {
  cachedContacts,
  isContact,
  lookupUser,
  peerLabel,
  primeDirectory,
  refreshDirectory,
} from './directory'
import { tr } from './i18n'
import {
  drainQueue,
  hasThreadWith,
  hasWrittenTo,
  ingestDecrypted,
  setEmitter,
  stamp,
  type IngestResult,
} from './receive'
import { sendText } from './send'
import { RcqSocket } from './socket'
import { isYes, strangerCheck } from './stranger'
import { out } from './style'

export async function runInteractive(identity: WebIdentity): Promise<void> {
  await getDevice(identity).catch((e) => {
    process.stderr.write(tr('provision.v1only', { err: e instanceof Error ? e.message : String(e) }) + '\n')
  })
  // Correct the live-frame device filter from the saved blob even when the
  // provision above failed (same reason as watch: until then currentDeviceId
  // answers 1 and frames for OUR device would be dropped).
  await myDeviceId(identity).catch(() => null)

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'rcq> ' })

  let active: number | null = null
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

  const switchTo = (uin: number): void => {
    active = uin
    // The prompt carries the name for the same reason every line does: `#396>`
    // is a number you have to remember the owner of.
    rl.setPrompt(`${peerLabel(identity.uin, uin)}> `)
    rl.prompt(true)
  }

  /// Fold one ingest result into the UI: delivered notes for our own sends,
  /// and the auto-pick of the first peer who writes when nobody is active.
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
    if (res.lastPeerFrom !== undefined) {
      const from = res.lastPeerFrom
      res.lastPeerFrom = undefined // the live result object is long-lived
      if (active !== null) return
      const who = peerLabel(identity.uin, from)
      // Auto-pick is a convenience for a conversation you are already in. It
      // used to hand the next line typed to whoever wrote first, stranger
      // included, which is one careless Enter away from answering a spammer.
      if (isContact(identity.uin, from) || hasWrittenTo(identity.uin, from)) {
        switchTo(from)
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
  const sock = new RcqSocket(
    identity,
    (frame) => {
      void (async () => {
        const got = await decryptIncoming(identity, frame.payload)
        if (!got) return
        if (got.senderUIN !== identity.uin) noteInboundFrom(got.senderUIN, got.senderDeviceId)
        await ingestDecrypted(identity, got, frame.group_id, liveOut)
        absorb(liveOut)
      })().catch((e: unknown) => {
        // No device to open it with yet: the same envelope sits in the queue,
        // and the reconnect drain delivers it. Printed all the same: a message
        // that silently never appears is the worst thing a chat client can do.
        printAbove(out.dim(tr('fail.live', { err: e instanceof Error ? e.message : String(e) })))
      })
    },
    () => {
      void drainQueue(identity).then(absorb)
    },
    () => {
      process.stderr.write = rawStderr
      rawStderr(`rcq: ${tr('err.sessionRejected')}\n`)
      process.exit(1)
    },
  )

  async function handleLine(raw: string): Promise<void> {
    const line = raw.trim()
    if (!line) return
    if (line === '/quit' || line === '/q' || line === '/exit') {
      shutdown()
      return
    }
    if (line === '/help' || line === '/?') {
      printAbove(tr('interactive.help'))
      return
    }
    if (line === '/contacts') {
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
        const mark = active === c.uin ? '* ' : '  '
        printAbove(`${mark}#${c.uin}  ${c.nickname}  ${c.status}${c.blocked ? '  blocked' : ''}`)
      }
      return
    }
    if (line === '/who' || line.startsWith('/who ')) {
      const uin = Number(line.slice(4).trim())
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
    if (line === '/to' || line.startsWith('/to ')) {
      const uin = Number(line.slice(3).trim())
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
      switchTo(uin)
      return
    }
    if (line === '/nick' || line.startsWith('/nick ')) {
      const name = line.slice(5).trim()
      if (!name) {
        printAbove(tr('interactive.usageNick'))
        return
      }
      try {
        await Api.updateProfile(identity, { nickname: name })
      } catch (e) {
        printAbove(out.red(tr('fail.command', { cmd: '/nick', err: e instanceof Error ? e.message : String(e) })))
        return
      }
      printAbove(out.dim(tr('nick.done', { name })))
      return
    }
    if (line === '/add' || line.startsWith('/add ')) {
      const uin = Number(line.slice(4).trim())
      if (!Number.isInteger(uin) || uin <= 0) {
        printAbove(tr('interactive.usageAdd'))
        return
      }
      if ((await lookupUser(identity, uin)).state === 'missing') {
        printAbove(out.yellow(tr('stranger.missing', { uin })))
        return
      }
      try {
        await Api.sendContactRequest(identity, uin)
      } catch (e) {
        printAbove(out.red(tr('fail.command', { cmd: '/add', err: e instanceof Error ? e.message : String(e) })))
        return
      }
      printAbove(out.dim(tr('add.sent', { who: peerLabel(identity.uin, uin) })))
      return
    }
    if (line.startsWith('/')) {
      printAbove(tr('interactive.unknownSlash', { cmd: line.split(' ')[0] }))
      return
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
    const to = active
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

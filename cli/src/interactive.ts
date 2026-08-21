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
import { Api } from '../../src/lib/api'
import type { WebIdentity } from '../../src/lib/crypto'
import { decryptIncoming, getDevice, myDeviceId, noteInboundFrom } from '../../src/lib/signal-device'
import { tr } from './i18n'
import { drainQueue, ingestDecrypted, setEmitter, stamp, type IngestResult } from './receive'
import { sendText } from './send'
import { RcqSocket } from './socket'
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

  const switchTo = (uin: number): void => {
    active = uin
    rl.setPrompt(`#${uin}> `)
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
      printAbove(`${out.dim(`[${stamp()}]`)} ${out.green(tr('interactive.delivered', { uin }))}`)
    }
    if (res.lastPeerFrom !== undefined) {
      if (active === null) {
        switchTo(res.lastPeerFrom)
        printAbove(out.dim(tr('interactive.replyingTo', { uin: res.lastPeerFrom })))
      }
      res.lastPeerFrom = undefined // the live result object is long-lived
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
      })().catch(() => {
        // No device to open it with yet — the same envelope sits in the
        // queue, and the reconnect drain delivers it.
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
      const list = await Api.contacts(identity)
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
    if (line === '/to' || line.startsWith('/to ')) {
      const uin = Number(line.slice(3).trim())
      if (!Number.isInteger(uin) || uin <= 0) {
        printAbove(tr('interactive.usageTo'))
        return
      }
      switchTo(uin)
      return
    }
    if (line === '/nick' || line.startsWith('/nick ')) {
      const name = line.slice(5).trim()
      if (!name) {
        printAbove(tr('interactive.usageNick'))
        return
      }
      await Api.updateProfile(identity, { nickname: name })
      printAbove(out.dim(tr('nick.done', { name })))
      return
    }
    if (line === '/add' || line.startsWith('/add ')) {
      const uin = Number(line.slice(4).trim())
      if (!Number.isInteger(uin) || uin <= 0) {
        printAbove(tr('interactive.usageAdd'))
        return
      }
      await Api.sendContactRequest(identity, uin)
      printAbove(out.dim(tr('add.sent', { uin })))
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
    const { id, mode } = await sendText(identity, to, line)
    printAbove(`${out.dim(`[${stamp()}]`)} ${out.green(`me -> #${to}`)}: ${line}${process.env.RCQ_VERBOSE ? out.dim(` (${mode})`) : ''}`)
    if (earlyReceipts.delete(id)) {
      // The receipt outran us (see earlyReceipts) — settle it now.
      printAbove(`${out.dim(`[${stamp()}]`)} ${out.green(tr('interactive.delivered', { uin: to }))}`)
    } else {
      pendingSent.set(id, to)
    }
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

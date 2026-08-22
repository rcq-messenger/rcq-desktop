// Globals the reused src/lib modules assume a browser for. Imported FIRST by
// main.ts: auth.ts reads localStorage the moment a command touches an account,
// so the shim has to exist before any of that runs. document/window are NOT
// shimmed on purpose — a code path that needs them is a code path the CLI must
// not have imported.

import fs from 'node:fs'
import { Console } from 'node:console'
import { statePath, writeFileAtomic } from './state'

// Everything the reused src/lib modules say via console.* (silence-probe
// traces, decrypt warnings) is STATUS, not data — and under Node console.log/
// debug write to stdout, which this CLI reserves for data alone. One shared
// Console pointed at stderr keeps the discipline without touching src/lib.
//
// And by default that status is QUIET: "fresh X3DH with 911:1" is protocol
// internals nobody chatting from a terminal asked to see (founder, first
// session with the tool). RCQ_VERBOSE=1 brings it all back; errors always
// come through.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr })
if (!process.env.RCQ_VERBOSE) {
  console.debug = () => {}
  console.log = () => {}
  console.warn = () => {}
  console.info = () => {}
}

// localStorage backed by one JSON file, written synchronously on every set.
// The data is a handful of small rows (identity, install id, accounts list);
// a torn write here is an account lost, so correctness over speed.
class FileStorage {
  private data: Record<string, string>
  constructor(private file: string) {
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>
    } catch {
      this.data = {}
    }
  }
  private flush(): void {
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 1))
  }
  getItem(k: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k] : null
  }
  setItem(k: string, v: string): void {
    this.data[k] = String(v)
    this.flush()
  }
  removeItem(k: string): void {
    delete this.data[k]
    this.flush()
  }
  key(i: number): string | null {
    const ks = Object.keys(this.data)
    return i >= 0 && i < ks.length ? ks[i] : null
  }
  get length(): number {
    return Object.keys(this.data).length
  }
  clear(): void {
    this.data = {}
    this.flush()
  }
}

;(globalThis as { localStorage?: unknown }).localStorage = new FileStorage(statePath('localstorage.json'))

// ⚠ Node's fetch has NO timeout, and neither does the shared api.ts request()
// that every send, drain and lookup goes through. A connection that opens and
// then goes quiet (a laptop that slept, a relay that died mid-request, the
// flaky transport this whole project exists for) hangs the call for as long
// as the kernel keeps the socket. Measured against prod on 2026-08-22: a
// single send sat for 41 seconds and only returned when the WebSocket beside
// it gave up with 1006.
//
// In the conversation loop that is worse than an error. Lines are handed to
// the network strictly one at a time (the ratchet cannot be advanced twice at
// once), so everything typed behind the stuck one waits with it, silently.
// A deadline turns an indefinite hang into a sentence somebody can act on.
//
// Callers that already manage a signal keep theirs: receive.ts drains with a
// longer one of its own, and overriding it here would shorten the queue read.
const FETCH_DEADLINE_MS = Number(process.env.RCQ_TIMEOUT_MS) > 0 ? Number(process.env.RCQ_TIMEOUT_MS) : 20_000
const bareFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  init?.signal
    ? bareFetch(input, init)
    : bareFetch(input, { ...init, signal: AbortSignal.timeout(FETCH_DEADLINE_MS) })) as typeof fetch

// Node 22+ ships a global navigator (userAgent included) with no `locks` —
// withProvisionLock in signal-device.ts already falls back to running
// unlocked, which is right for a single-process CLI. Only fill the gap on a
// runtime without one.
if (!(globalThis as { navigator?: unknown }).navigator) {
  ;(globalThis as { navigator?: unknown }).navigator = { userAgent: 'rcq-cli' }
}

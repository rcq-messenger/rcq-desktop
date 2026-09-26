// A browser out of /auth/refresh budget, and what it says about it (#1041).
//
// A phone reloading the web page a few dozen times in an hour spent the
// island's refresh budget for its address (two mints per load, one of them the
// start-up probe answering itself). The island then said 429 with a
// retry_after, the mint threw that number away, and every call went out with
// no token and came back 401, which the app printed as "Остров это не принял"
// under the chat, the profile and the group, for an hour.
//
// This runs the REAL `mintSessionToken` (src/lib/auth.ts), `request` via
// `Api.userInfo` (src/lib/api.ts) and `humanError` (src/lib/human-error.ts)
// against a scripted fetch: the 429 carries its wait back, and a 401 for a
// call that had no token to send reads as "still signing in", while a 401 for
// a token the island refused still reads as a refusal.
//
// Run: npm run cli:test

import assert from 'node:assert/strict'
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rcq-session-mint-')), 'mint.mjs')
await build({
  stdin: {
    contents: `
      export { mintSessionToken } from './src/lib/auth'
      export { Api, ApiError, NoSessionError } from './src/lib/api'
      export { humanError } from './src/lib/human-error'
    `,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  define: { 'import.meta.env': '{}' },
  logLevel: 'error',
  plugins: [
    {
      // IndexedDB -> a map. Nothing on this path reads it back.
      name: 'memory-idb',
      setup(b) {
        b.onResolve({ filter: /^\.\/signal-persist$/ }, () => ({ path: 'signal-persist', namespace: 'mem' }))
        b.onLoad({ filter: /.*/, namespace: 'mem' }, () => ({
          loader: 'ts',
          contents: `
            const m = new Map<string, unknown>()
            export async function idbGet<T>(k: string): Promise<T | undefined> { return m.get(k) as T | undefined }
            export async function idbGetFlat<T>(k: string): Promise<T | undefined> { return m.get(k) as T | undefined }
            export async function idbSet(k: string, v: unknown): Promise<void> { m.set(k, v) }
            export async function idbDel(k: string): Promise<void> { m.delete(k) }
            export async function idbKeys(): Promise<string[]> { return [...m.keys()] }
            export async function idbClearAll(): Promise<void> { m.clear() }
            export async function idbCarryKey(): Promise<boolean> { return false }
          `,
        }))
      },
    },
  ],
})

const bus = new EventTarget()
globalThis.window = globalThis
globalThis.addEventListener = bus.addEventListener.bind(bus)
globalThis.removeEventListener = bus.removeEventListener.bind(bus)
globalThis.dispatchEvent = bus.dispatchEvent.bind(bus)
const ls = new Map()
globalThis.localStorage = {
  get length() { return ls.size },
  key: (i) => [...ls.keys()][i] ?? null,
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => void ls.set(k, String(v)),
  removeItem: (k) => void ls.delete(k),
  clear: () => ls.clear(),
}

// The island, one scripted answer per path.
let answers = {}
const asked = []
globalThis.fetch = async (url) => {
  const p = new URL(String(url)).pathname
  asked.push(p)
  const a = answers[p] ?? { status: 500, body: '' }
  return new Response(a.body, { status: a.status, headers: a.headers ?? { 'Content-Type': 'application/json' } })
}

const M = await import(out)

// A tokenless account: the keys are enough to mint, the jwt is empty.
const signingPriv = new Uint8Array(32).fill(7)
const { ed25519 } = await import('@noble/curves/ed25519')
const id = {
  uin: 495,
  jwt: '',
  apiBase: 'https://island.test',
  identityPriv: new Uint8Array(32),
  identityPub: new Uint8Array(32),
  signingPriv,
  signingPub: ed25519.getPublicKey(signingPriv),
}
const t = (k) => k

let n = 0
const check = async (label, fn) => {
  await fn()
  n++
  console.log('  ok   ' + label)
}

console.log('SESSION MINT')

const challenge = { status: 200, body: JSON.stringify({ challenge: 'c1' }) }
const limited = (extra = {}) => ({
  status: 429,
  body: JSON.stringify({ detail: { code: 'rate_limited', retry_after: 1234 } }),
  ...extra,
})

await check('a 429 on /auth/refresh carries the island\'s wait back', async () => {
  answers = { '/auth/recover/challenge': challenge, '/auth/refresh': limited() }
  const mint = await M.mintSessionToken(id)
  assert.equal(mint.token, null)
  assert.equal(mint.dead, false, 'a spent budget says nothing about the account')
  assert.equal(mint.retryAfterS, 1234)
})

await check('a Retry-After header, when a proxy lets it through, is read first', async () => {
  answers = {
    '/auth/recover/challenge': challenge,
    '/auth/refresh': limited({ headers: { 'Content-Type': 'application/json', 'Retry-After': '90' } }),
  }
  const mint = await M.mintSessionToken(id)
  assert.equal(mint.retryAfterS, 90)
})

await check('a 429 with no number is an ordinary miss (the caller\'s own backoff applies)', async () => {
  answers = { '/auth/recover/challenge': challenge, '/auth/refresh': { status: 429, body: 'slow down' } }
  const mint = await M.mintSessionToken(id)
  assert.equal(mint.token, null)
  assert.equal(mint.retryAfterS, undefined)
})

await check('a working mint is unchanged', async () => {
  answers = {
    '/auth/recover/challenge': challenge,
    '/auth/refresh': { status: 200, body: JSON.stringify({ uin: 495, token: 'tok' }) },
  }
  const mint = await M.mintSessionToken(id)
  assert.equal(mint.token, 'tok')
  assert.equal(mint.retryAfterS, undefined)
})

const userInfo401 = { status: 401, body: JSON.stringify({ detail: 'missing token' }) }

await check('a call made with NO token, answered 401, reads as "still signing in"', async () => {
  answers = { '/users/777/info': userInfo401 }
  const err = await M.Api.userInfo(id, 777).then(() => null, (e) => e)
  assert.ok(err instanceof M.NoSessionError, 'a NoSessionError')
  assert.ok(err instanceof M.ApiError, 'still an ApiError with its status, for callers that branch on it')
  assert.equal(err.status, 401)
  assert.equal(M.humanError(err, t), 'err.no_session')
})

await check('a token the island REFUSED still reads as a refusal', async () => {
  answers = { '/users/777/info': { status: 401, body: JSON.stringify({ detail: 'device revoked' }) } }
  const err = await M.Api.userInfo({ ...id, jwt: 'refused' }, 777).then(() => null, (e) => e)
  assert.ok(err instanceof M.ApiError)
  assert.ok(!(err instanceof M.NoSessionError))
  assert.equal(M.humanError(err, t), 'err.not_allowed')
})

await check('a 403 is a refusal whatever the token', async () => {
  answers = { '/users/777/info': { status: 403, body: JSON.stringify({ detail: { code: 'blocked' } }) } }
  const err = await M.Api.userInfo(id, 777).then(() => null, (e) => e)
  assert.ok(!(err instanceof M.NoSessionError))
  assert.equal(M.humanError(err, t), 'err.not_allowed')
})

console.log(`\nSESSION MINT: ${n}/${n} ok`)

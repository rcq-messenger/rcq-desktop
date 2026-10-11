// The failover line on the home screen, offline.
//
// Why this gets a test of its own: the phones say "your island is not
// answering, messages are arriving through your backup island" and the web
// said nothing, so a failover here was silent. The line is a claim about two
// islands at once, and each half has a way to be untrue:
//   * a backup that is down too is not where mail is arriving from;
//   * a browser with no network fails the primary probe exactly the way a dead
//     island does;
//   * an open socket, or a primary that answers /health while sockets die,
//     means the primary is delivering and the backup pass is the usual copy;
//   * a probe that was not asked is not a "no";
//   * on the desktop the front layer routes direct while it decides, so a
//     probe that only follows that routing calls an island answering through
//     the front down. The flagship is asked through its front explicitly.
// And it belongs to one account: two accounts can hold the same number on two
// islands, and a line raised for one must never show on the other.
// Everything here is production code from src/lib/backup-failover.ts.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'
import {
  failoverAccount,
  failoverVerdict,
  frontBaseFor,
  installFrontRouting,
  isReceivingViaBackup,
  primaryAnswers,
  setFrontHost,
  setReceivingViaBackup,
  subscribeFailover,
} from '../dist/backup-failover.mjs'

let n = 0
const check = async (label, fn) => {
  await fn()
  n++
  console.log('  ok  ' + label)
}

const down = { backupAnswered: true, online: true, socketUp: false, primaryAnswered: false }

await check('the primary silent, the socket down, a backup answering: the line is up', () => {
  assert.equal(failoverVerdict(down), true)
})

await check('no backup answered: nothing is arriving through it, so no line', () => {
  assert.equal(failoverVerdict({ ...down, backupAnswered: false }), false)
})

await check('offline: the probe failing says nothing about the island', () => {
  assert.equal(failoverVerdict({ ...down, online: false }), false)
})

await check('the socket is open: the primary is delivering', () => {
  assert.equal(failoverVerdict({ ...down, socketUp: true }), false)
})

await check('the primary answers /health while its socket is down: the HTTP poll delivers', () => {
  assert.equal(failoverVerdict({ ...down, primaryAnswered: true }), false)
})

await check('a probe that was not asked is not a "no"', () => {
  assert.equal(failoverVerdict({ ...down, primaryAnswered: null }), false)
})

const flagship = { apiBase: 'https://api.rcq.app', uin: 1234 }
const selfHost = { apiBase: 'https://chat.example.org', uin: 1234 }

await check('the same number on another island is another account', () => {
  assert.notEqual(failoverAccount(flagship), failoverAccount(selfHost))
  setReceivingViaBackup(failoverAccount(flagship), true)
  assert.equal(isReceivingViaBackup(flagship), true)
  assert.equal(isReceivingViaBackup(selfHost), false, 'the line of the account just left')
  assert.equal(isReceivingViaBackup(null), false)
})

await check('a verdict for the next account replaces the old one: switching back finds no stale line', () => {
  setReceivingViaBackup(failoverAccount(flagship), true)
  setReceivingViaBackup(failoverAccount(selfHost), false)
  assert.equal(isReceivingViaBackup(flagship), false)
  assert.equal(isReceivingViaBackup(selfHost), false)
})

await check('listeners hear a change and nothing else', () => {
  let heard = 0
  const off = subscribeFailover(() => heard++)
  setReceivingViaBackup(failoverAccount(flagship), true)
  setReceivingViaBackup(failoverAccount(flagship), true)
  assert.equal(heard, 1, 'the same verdict twice is one change')
  setReceivingViaBackup(failoverAccount(flagship), false)
  assert.equal(heard, 2)
  off()
  setReceivingViaBackup(failoverAccount(flagship), true)
  assert.equal(heard, 2, 'unsubscribed')
})

// The probe itself, against a stubbed network. `window` is this process, so
// installFrontRouting wraps the same `fetch` the probe calls, as in the
// desktop webview. Nothing here leaves the machine.
const asked = []
let answering = new Set()
globalThis.window = globalThis
globalThis.fetch = async (input) => {
  const url = String(input)
  asked.push(url)
  if ([...answering].some((base) => url.startsWith(base + '/'))) return new Response('ok')
  throw new TypeError('blocked')
}
const probe = async (apiBase, answers) => {
  asked.length = 0
  answering = new Set(answers)
  return primaryAnswers(apiBase, 200)
}

await check('web (no front layer): the flagship is asked directly, and only there', async () => {
  assert.equal(frontBaseFor('https://api.rcq.app'), null)
  assert.equal(await probe('https://api.rcq.app', ['https://cdn.rcq.app']), false)
  assert.deepEqual(asked, ['https://api.rcq.app/health'])
  assert.equal(await probe('https://api.rcq.app', ['https://api.rcq.app']), true)
})

installFrontRouting()

await check('desktop, front still deciding: an island answering through the front is not down', async () => {
  assert.equal(frontBaseFor('https://api.rcq.app/'), 'https://cdn.rcq.app')
  assert.equal(await probe('https://api.rcq.app', ['https://cdn.rcq.app']), true)
  assert.deepEqual(asked.sort(), ['https://api.rcq.app/health', 'https://cdn.rcq.app/health'])
})

await check('desktop, the direct road answering alone is enough', async () => {
  assert.equal(await probe('https://api.rcq.app', ['https://api.rcq.app']), true)
})

await check('desktop, neither road answers: the island is down', async () => {
  assert.equal(await probe('https://api.rcq.app', []), false)
})

await check('another island never goes to the front: it proxies the flagship only', async () => {
  assert.equal(frontBaseFor('https://chat.example.org'), null)
  assert.equal(await probe('https://chat.example.org', ['https://cdn.rcq.app']), false)
  assert.deepEqual(asked, ['https://chat.example.org/health'])
})

await check('a front moved by the signed config is the one asked', async () => {
  setFrontHost('https://edge.example.net')
  assert.equal(frontBaseFor('https://api.rcq.app'), 'https://edge.example.net')
  assert.equal(await probe('https://api.rcq.app', ['https://edge.example.net']), true)
  assert.ok(asked.includes('https://edge.example.net/health'))
})

console.log(`backup-failover: ${n} checks passed`)

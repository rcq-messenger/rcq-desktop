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
//   * a probe that was not asked is not a "no".
// And it belongs to one account: two accounts can hold the same number on two
// islands, and a line raised for one must never show on the other.
// Everything here is production code from src/lib/backup-failover.ts.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'
import {
  failoverAccount,
  failoverVerdict,
  isReceivingViaBackup,
  setReceivingViaBackup,
  subscribeFailover,
} from '../dist/backup-failover.mjs'

let n = 0
const check = (label, fn) => {
  fn()
  n++
  console.log('  ok  ' + label)
}

const down = { backupAnswered: true, online: true, socketUp: false, primaryAnswered: false }

check('the primary silent, the socket down, a backup answering: the line is up', () => {
  assert.equal(failoverVerdict(down), true)
})

check('no backup answered: nothing is arriving through it, so no line', () => {
  assert.equal(failoverVerdict({ ...down, backupAnswered: false }), false)
})

check('offline: the probe failing says nothing about the island', () => {
  assert.equal(failoverVerdict({ ...down, online: false }), false)
})

check('the socket is open: the primary is delivering', () => {
  assert.equal(failoverVerdict({ ...down, socketUp: true }), false)
})

check('the primary answers /health while its socket is down: the HTTP poll delivers', () => {
  assert.equal(failoverVerdict({ ...down, primaryAnswered: true }), false)
})

check('a probe that was not asked is not a "no"', () => {
  assert.equal(failoverVerdict({ ...down, primaryAnswered: null }), false)
})

const flagship = { apiBase: 'https://api.rcq.app', uin: 1234 }
const selfHost = { apiBase: 'https://chat.example.org', uin: 1234 }

check('the same number on another island is another account', () => {
  assert.notEqual(failoverAccount(flagship), failoverAccount(selfHost))
  setReceivingViaBackup(failoverAccount(flagship), true)
  assert.equal(isReceivingViaBackup(flagship), true)
  assert.equal(isReceivingViaBackup(selfHost), false, 'the line of the account just left')
  assert.equal(isReceivingViaBackup(null), false)
})

check('a verdict for the next account replaces the old one: switching back finds no stale line', () => {
  setReceivingViaBackup(failoverAccount(flagship), true)
  setReceivingViaBackup(failoverAccount(selfHost), false)
  assert.equal(isReceivingViaBackup(flagship), false)
  assert.equal(isReceivingViaBackup(selfHost), false)
})

check('listeners hear a change and nothing else', () => {
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

console.log(`backup-failover: ${n} checks passed`)

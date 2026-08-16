// Local-only check that the desktop PIN really seals the conversations.
//
// The UI path (lock screen → vault → key) is checked by hand on a test build;
// this covers the part that is easy to get wrong and impossible to see: that
// what LANDS ON THE DISK is ciphertext, that a wrong key opens nothing, and
// that switching the PIN off gives the history back rather than losing it.
//
// NOT part of any build. Run: cd web-chat && node test_pin_seal_local.mjs
//
// It bundles the two modules under test with esbuild (they are TS and import
// each other), against a fake localStorage — no browser, no IndexedDB, and
// nothing in this repo is modified.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let fails = 0
function check(name, cond) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) fails++
}

// ── fake browser surface ─────────────────────────────────────────────────────
const store = new Map()
globalThis.localStorage = {
  get length() {
    return store.size
  },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
}

// ── build the modules under test ─────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'rcq-pin-seal-'))
const entry = join(dir, 'entry.ts')
writeFileSync(
  entry,
  `export * from '${process.cwd()}/src/lib/pin-seal'
   export * from '${process.cwd()}/src/lib/outgoing-store'`,
)
const outfile = join(dir, 'bundle.mjs')
execFileSync('node_modules/.bin/esbuild', [
  entry,
  '--bundle',
  '--format=esm',
  '--platform=neutral',
  '--external:react',
  `--outfile=${outfile}`,
])
const m = await import(outfile)

const KEY = 'rcq.web.673351447.outgoing.peer.4242'
const MARKER = 'PINSEALMARKER-7788'

console.log('sealing')
{
  const k1 = m.newHistoryKeyB64()
  await m.setHistoryKey(k1)
  const blob = await m.sealText(MARKER)
  check('a sealed blob is tagged and carries no plaintext', !!blob && blob.startsWith('p1:') && !blob.includes(MARKER))
  check('it opens back to the same text', (await m.openText(blob)) === MARKER)

  // A different PIN means a different key: AES-GCM fails authentication rather
  // than handing back plausible garbage.
  await m.setHistoryKey(m.newHistoryKeyB64())
  check('another key opens nothing', (await m.openText(blob)) === null)

  await m.setHistoryKey(null)
  check('with no PIN there is nothing to seal with', (await m.sealText(MARKER)) === null)
  check('and nothing claims to be active', m.pinSealActive() === false)
}

console.log('the received history and the picture cache')
{
  await m.setHistoryKey(m.newHistoryKeyB64())
  const history = { peers: { 4242: [{ id: 'b1', from: 4242, text: MARKER, at: 3 }] }, groups: {} }
  const sealed = await m.sealValue(history)
  check('a history blob is sealed as bytes, not as an object', m.isSealedValue(sealed))
  const asText = JSON.stringify(sealed, (_k, v) => (v instanceof Uint8Array ? [...v] : v))
  check('nothing in it spells the message out', !asText.includes(MARKER))
  const back = await m.openValue(sealed)
  check('it opens back to the same history', back?.peers?.[4242]?.[0]?.text === MARKER)

  // What a history written before the PIN looks like: a plain object. It has
  // to keep opening, or switching the PIN on would read as losing everything.
  check('an unsealed blob is returned as it is', (await m.openValue(history)) === history)

  const bytes = new TextEncoder().encode(MARKER).buffer
  const sealedBuf = await m.sealBuffer(bytes)
  check('a cached picture is sealed too', m.isSealedValue(sealedBuf))
  const opened = await m.openBuffer(sealedBuf)
  check('and comes back byte for byte', new TextDecoder().decode(opened) === MARKER)

  await m.setHistoryKey(m.newHistoryKeyB64())
  check('another key opens no history', (await m.openValue(sealed)) === undefined)
  check('and no picture', (await m.openBuffer(sealedBuf)) === null)
}

console.log('the outgoing log')
{
  await m.setHistoryKey(null)
  // As it is today: a browser, or a desktop with no PIN.
  m.savePersisted(KEY, [{ id: 'a1', text: MARKER, sentAt: 1, state: 'sent' }])
  check('without a PIN the log is plain JSON, as it always was', localStorage.getItem(KEY).includes(MARKER))

  // The PIN goes on: what was already there is sealed in place.
  const key = m.newHistoryKeyB64()
  await m.setHistoryKey(key)
  await m.adoptSealedOutgoing()
  const onDisk = localStorage.getItem(KEY)
  check('switching the PIN on seals what was already written', onDisk.startsWith('p1:') && !onDisk.includes(MARKER))
  check('and the log still reads back in full', m.loadPersisted(KEY)[0]?.text === MARKER)

  // A write while sealed must not put the words back on the disk.
  m.savePersisted(KEY, [
    { id: 'a1', text: MARKER, sentAt: 1, state: 'sent' },
    { id: 'a2', text: 'SECOND-' + MARKER, sentAt: 2, state: 'sent' },
  ])
  await new Promise((r) => setTimeout(r, 50)) // the disk write is async by necessity
  const after = localStorage.getItem(KEY)
  check('a new message is sealed too', after.startsWith('p1:') && !after.includes(MARKER))
  check('and is readable immediately, without waiting for the disk', m.loadPersisted(KEY).length === 2)

  // A row written by a session whose key is gone: the thread reads empty and
  // the blob is left alone rather than overwritten with nothing.
  const sealedBlob = localStorage.getItem(KEY)
  await m.setHistoryKey(m.newHistoryKeyB64())
  await m.adoptSealedOutgoing()
  check('a log from another PIN reads empty', m.loadPersisted(KEY).length === 0)
  check('and is not destroyed', localStorage.getItem(KEY) === sealedBlob)

  // Switching the PIN off hands the history back.
  await m.setHistoryKey(key)
  await m.adoptSealedOutgoing()
  await m.releaseSealedOutgoing()
  const plain = localStorage.getItem(KEY)
  check('turning the PIN off puts the log back in the clear', plain.includes(MARKER) && !plain.startsWith('p1:'))
  check('and it is the whole log, both rows', m.loadPersisted(KEY).length === 2)
}

rmSync(dir, { recursive: true, force: true })
console.log(fails ? `\n${fails} FAILED` : '\nall good')
process.exit(fails ? 1 : 0)

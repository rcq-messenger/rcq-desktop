// State at rest: sealing a dir, opening it, refusing the wrong passphrase, and
// coming back out again.
//
// The point of the test is not the cipher (Node's) but the LAYER: that a
// sealed dir is unreadable on disk, that every shape the CLI stores (a whole
// file, an appended JSONL) survives a round trip, and that a wrong passphrase
// fails loudly instead of handing back something that parses to nothing.

import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rcq-seal-'))
process.env.RCQ_CLI_HOME = home

const state = await import('../dist/seal.mjs')

// 1. plain dir behaves exactly as it always has
state.writeState('localstorage.json', JSON.stringify({ uin: 500 }))
assert.equal(state.isSealed(), false)
assert.equal(JSON.parse(state.readState('localstorage.json')).uin, 500)
assert.ok(fs.readFileSync(path.join(home, 'localstorage.json'), 'utf8').includes('500'))

state.appendState('history-500.jsonl', JSON.stringify({ text: 'hello' }))
state.appendState('history-500.jsonl', JSON.stringify({ text: 'again' }))
assert.deepEqual(
  state.readStateLines('history-500.jsonl').map((l) => JSON.parse(l).text),
  ['hello', 'again'],
)

// 2. seal it
state.sealDir('correct horse battery', state.sealableFiles())
assert.equal(state.isSealed(), true)
const raw = fs.readFileSync(path.join(home, 'localstorage.json'))
assert.ok(!raw.toString('utf8').includes('500'), 'identity must not be readable on disk')
const rawHistory = fs.readFileSync(path.join(home, 'history-500.jsonl'), 'utf8')
assert.ok(!rawHistory.includes('hello'), 'history must not be readable on disk')

// 3. the same process still reads through
assert.equal(JSON.parse(state.readState('localstorage.json')).uin, 500)
assert.deepEqual(
  state.readStateLines('history-500.jsonl').map((l) => JSON.parse(l).text),
  ['hello', 'again'],
)

// 4. appending to a sealed history keeps it append-only and readable
state.appendState('history-500.jsonl', JSON.stringify({ text: 'third' }))
assert.deepEqual(
  state.readStateLines('history-500.jsonl').map((l) => JSON.parse(l).text),
  ['hello', 'again', 'third'],
)
assert.equal(fs.readFileSync(path.join(home, 'history-500.jsonl'), 'utf8').split('\n').filter(Boolean).length, 3)

// 5. a SEPARATE process without the key must refuse, not read empty. A second
// import in this one would hand back the module that already holds the key,
// which is the opposite of what is being proven here.
const url = new URL('../dist/seal.mjs', import.meta.url).href
const script = `
  const s = await import(${JSON.stringify(url)})
  const assert = await import('node:assert')
  assert.default.equal(s.isSealed(), true)
  assert.default.equal(s.isUnlocked(), false)
  assert.default.throws(() => s.readState('localstorage.json'), /sealed/)
  assert.default.equal(s.unlockWith('wrong one'), false)
  assert.default.equal(s.unlockWith('correct horse battery'), true)
  assert.default.equal(JSON.parse(s.readState('localstorage.json')).uin, 500)
  s.unsealDir(s.sealableFiles())
  assert.default.equal(s.isSealed(), false)
`
execFileSync(process.execPath, ['--input-type=module', '-e', script], {
  env: { ...process.env, RCQ_CLI_HOME: home },
  stdio: 'inherit',
})

// 6. and it really is back out, from this process's point of view too
assert.ok(fs.readFileSync(path.join(home, 'localstorage.json'), 'utf8').includes('500'))

fs.rmSync(home, { recursive: true, force: true })
console.log('seal: ok')

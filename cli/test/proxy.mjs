// Fully-offline proof that `rcq proxy` really moves RCQ's traffic.
//
// Nothing leaves the machine: a SOCKS5 server and an "island" are started on
// loopback, and the SOCKS server REFUSES every target that is not 127.0.0.1
// while still logging it - which is how the update check is caught in the act
// of going through the proxy instead of around it.
//
// Run: npm run cli:test   (builds first - this drives the BUILT bundle)

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RCQ = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist', 'rcq.mjs')
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rcq-proxy-test-'))

/// Every host:port the client asked the proxy to reach.
const seen = []

/// SOCKS5 CONNECT, the subset undici speaks: no auth, IPv4 or a name, and a
/// success reply only for loopback so a test can never touch the internet.
function startSocks() {
  const srv = net.createServer((c) => {
    c.once('data', () => {
      c.write(Buffer.from([0x05, 0x00]))
      c.once('data', (r) => {
        const atyp = r[3]
        let host, off
        if (atyp === 1) {
          host = `${r[4]}.${r[5]}.${r[6]}.${r[7]}`
          off = 8
        } else if (atyp === 3) {
          host = r.slice(5, 5 + r[4]).toString()
          off = 5 + r[4]
        } else {
          return c.end()
        }
        const port = r.readUInt16BE(off)
        seen.push(`${host}:${port}`)
        if (host !== '127.0.0.1') {
          c.write(Buffer.concat([Buffer.from([0x05, 0x05, 0x00, 0x01]), Buffer.alloc(6)]))
          return c.end()
        }
        const up = net.connect(port, host, () => {
          c.write(Buffer.concat([Buffer.from([0x05, 0x00, 0x00, 0x01]), Buffer.alloc(6)]))
          up.pipe(c)
          c.pipe(up)
        })
        up.on('error', () => c.end())
      })
    })
    c.on('error', () => {})
  })
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res(srv)))
}

/// How many times the island itself was asked anything. The control run of
/// `rcq proxy test` must never be one of them: it used to knock on the island
/// through a dead proxy, which on a runtime that ignores the proxy environment
/// is the detector announcing the leak BY LEAKING.
let islandHits = 0

function startIsland() {
  const srv = http.createServer((req, res) => {
    islandHits++
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, app: 'RCQ', version: 'test-island' }))
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)))
}

const socks = await startSocks()
const island = await startIsland()
const SOCKS_URL = `socks5://127.0.0.1:${socks.address().port}`
const ISLAND = `http://127.0.0.1:${island.address().port}`

/// One rcq run in the throwaway home. `extra` lands in the environment.
///
/// ⚠ Never spawnSync: the SOCKS server and the island live in THIS process,
/// and a blocked event loop cannot answer a handshake. The first draft of
/// this test failed with "SOCKS5 authentication timeout" for exactly that
/// reason, which is a test bug that reads like a product bug.
function rcq(args, extra = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [RCQ, ...args], {
      env: { ...process.env, RCQ_CLI_HOME: HOME, NO_COLOR: '1', ...extra },
    })
    let out = '', err = ''
    c.stdout.on('data', (b) => (out += b))
    c.stderr.on('data', (b) => (err += b))
    c.on('close', (code) => resolve({ code, out, err }))
  })
}

// -- the config verb ------------------------------------------------------
assert.equal((await rcq(['proxy'])).out.trim(), 'none', 'a fresh home has no proxy')

// ⚠ Schemes node cannot carry are refused BEFORE they are stored: node throws
// on an unknown proxy scheme before any user code runs, so a stored socks5h
// would break every later command, including the one that clears it.
assert.equal((await rcq(['proxy', 'set', 'socks5h://127.0.0.1:9050'])).code, 1, 'socks5h is refused')
assert.equal((await rcq(['proxy', 'set', 'nonsense'])).code, 1, 'a non-address is refused')
assert.equal((await rcq(['proxy'])).out.trim(), 'none', 'nothing was stored by the refusals')

// Presets, a bare host:port, and the stored form.
assert.equal((await rcq(['proxy', 'set', 'tor', '--no-test'])).out.trim(), 'socks5://127.0.0.1:9050')
assert.equal((await rcq(['proxy', 'set', '10.0.0.1:1080', '--no-test'])).out.trim(), 'socks5://10.0.0.1:1080')
// A password never reaches a terminal, only the 0600 file.
assert.equal((await rcq(['proxy', 'set', 'socks5://bob:hunter2@10.0.0.1:1080', '--no-test'])).out.trim(), 'socks5://bob:***@10.0.0.1:1080')
assert.match(fs.readFileSync(path.join(HOME, 'proxy.json'), 'utf8'), /hunter2/, 'the file keeps the real one')

// A dead proxy must never be able to strand the person who set it: `clear`
// runs OUTSIDE the proxy it configures.
assert.equal((await rcq(['proxy', 'set', 'socks5://127.0.0.1:1', '--no-test'])).code, 0)
assert.equal((await rcq(['proxy', 'clear'])).code, 0, 'clear works while the proxy is dead')
assert.equal((await rcq(['proxy'])).out.trim(), 'none')

// -- the probe ------------------------------------------------------------
const good = await rcq(['proxy', 'test', SOCKS_URL, '--island', ISLAND])
assert.equal(good.code, 0, `probe should pass: ${good.err}`)
assert.match(good.out, /^ok\t\d+\ttest-island\n$/, `probe stdout: ${JSON.stringify(good.out)}`)
assert.ok(seen.includes(`127.0.0.1:${island.address().port}`), 'the probe really went through the proxy')
assert.equal(islandHits, 1, 'exactly one request reached the island: the control run went to loopback')

const dead = await rcq(['proxy', 'test', 'socks5://127.0.0.1:1', '--island', ISLAND])
assert.equal(dead.code, 1, 'a dead proxy fails the probe')
assert.match(dead.out, /^fail\trefused\t/, `probe stdout: ${JSON.stringify(dead.out)}`)

// -- engaging it: every later command, including the update check ---------
assert.equal((await rcq(['proxy', 'set', SOCKS_URL, '--no-test'])).code, 0)
seen.length = 0
const ver = await rcq(['--version'])
assert.equal(ver.code, 0)
assert.match(ver.out, /^rcq v/, 'the version still prints')
// ★ The point of the whole exercise: the FIRST packet of a session used to go
// to api.github.com direct, which on the network this feature exists for is
// blocked. It now goes through the proxy (and our proxy refuses it, so this
// test still touches nothing).
assert.ok(
  seen.some((s) => s.startsWith('api.github.com:')),
  `the update check must ride the proxy, saw: ${JSON.stringify(seen)}`,
)

// A failed check is REMEMBERED, so a blocked box does not open a doomed
// connection to GitHub on every single command. (`--version` itself always
// forces a fresh ask - somebody typing it wants the real answer - so what is
// checked here is the stamp the quiet callers read.)
const cache = JSON.parse(fs.readFileSync(path.join(HOME, 'update-check.json'), 'utf8'))
assert.equal(typeof cache.failedAt, 'number', 'the failed update check is remembered')

// And it can be turned off outright.
fs.rmSync(path.join(HOME, 'update-check.json'), { force: true })
seen.length = 0
await rcq(['--version'], { RCQ_NO_UPDATE_CHECK: '1' })
assert.deepEqual(seen, [], 'RCQ_NO_UPDATE_CHECK asks nobody anything')

// RCQ_PROXY overrides the file for one command, 'off' included.
seen.length = 0
await rcq(['--version'], { RCQ_PROXY: 'off', RCQ_NO_UPDATE_CHECK: '1' })
assert.deepEqual(seen, [], 'RCQ_PROXY=off does not touch the proxy')

// -- somebody else's exported proxy ---------------------------------------
// ⚠ NODE_USE_ENV_PROXY set in the shell used to mean "somebody is driving,
// stay out of it", and the ordinary shape of that is a corporate
// `HTTPS_PROXY=http://proxy.corp:3128` in a profile: a user who then pointed
// RCQ at Tor rode the corporate proxy instead, with `rcq routes` and `whoami`
// both reporting Tor. The configured proxy wins for RCQ's own traffic.
assert.equal((await rcq(['proxy', 'set', SOCKS_URL, '--no-test'])).code, 0)
seen.length = 0
const corp = await rcq(['--version'], {
  NODE_USE_ENV_PROXY: '1',
  HTTP_PROXY: 'http://127.0.0.1:9',
  http_proxy: 'http://127.0.0.1:9',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  https_proxy: 'http://127.0.0.1:9',
})
assert.equal(corp.code, 0)
assert.ok(
  seen.some((s) => s.startsWith('api.github.com:')),
  `the configured proxy beats an unrelated exported one, saw: ${JSON.stringify(seen)}`,
)

// The environment that names the SAME proxy is honoured as it stands, with no
// second exec: what matters is that the bytes really ride it.
seen.length = 0
const same = await rcq(['--version'], {
  NODE_USE_ENV_PROXY: '1',
  HTTP_PROXY: SOCKS_URL,
  http_proxy: SOCKS_URL,
  HTTPS_PROXY: SOCKS_URL,
  https_proxy: SOCKS_URL,
})
assert.equal(same.code, 0)
assert.ok(seen.some((s) => s.startsWith('api.github.com:')), 'and an identical exported proxy still carries it')

// -- failing CLOSED -------------------------------------------------------
// ⚠ A proxy value we cannot carry is NOT "no proxy". It used to be: an
// RCQ_PROXY that did not parse (socks5h://, the spelling `rcq proxy set`
// refuses to your face) returned null, the command ran DIRECT, and exited 0 -
// so the message went out over the real address of somebody who had just asked
// for a proxy, with nothing on stderr.
assert.equal((await rcq(['proxy', 'clear'])).code, 0)
const badEnv = await rcq(['--version'], { RCQ_PROXY: 'socks5h://127.0.0.1:9050', RCQ_NO_UPDATE_CHECK: '1' })
assert.equal(badEnv.code, 1, 'an RCQ_PROXY this runtime cannot carry refuses the command')
assert.match(badEnv.err, /socks5h/, 'and the refusal names the value')

// The same for a hand-edited or corrupted proxy.json - with `rcq proxy` itself
// still running, or there would be no way to fix the file from the client.
fs.writeFileSync(path.join(HOME, 'proxy.json'), JSON.stringify({ url: 'socks5h://127.0.0.1:9050' }))
const badFile = await rcq(['--version'], { RCQ_NO_UPDATE_CHECK: '1' })
assert.equal(badFile.code, 1, 'a stored value this runtime cannot carry refuses the command')
const rescue = await rcq(['proxy'])
assert.equal(rescue.code, 0, '`rcq proxy` still runs on a broken file')
assert.match(rescue.err, /socks5h/, 'and says what is wrong with it')
assert.equal((await rcq(['proxy', 'clear'])).code, 0, 'and it can be cleared')

socks.close()
island.close()
fs.rmSync(HOME, { recursive: true, force: true })
console.error('proxy: config, probe and engage ok')

// An island trusted by its fingerprint, driven end to end against a
// self-signed https stub on loopback (docs/island-fingerprint-design.md §7.4).
//
// Nothing leaves the machine: the "island" is an https server in this
// process under a certificate openssl mints here, and every rcq run is the
// BUILT bundle in a throwaway RCQ_CLI_HOME. What is proved, in order: a first
// use pins and says so once, the next run is silent and its request goes
// through (the anchor rode the startup exec), a swapped certificate is
// refused with both fingerprints and nothing is sent, `island trust` with the
// presented fingerprint needs --replace against a record that disagrees and
// then lets the command through, a typed fingerprint that the island does not
// present is refused at the connect, a fragment that is not a fingerprint and
// a fragment on the flagship are address errors, a typed pin needs no first
// use, a certificate Node could not anchor is not pinned at all, and an
// island that does not answer at all is refused while a pin is on file.
//
// Run: npm run cli:test   (builds first - this drives the BUILT bundle)

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RCQ = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist', 'rcq.mjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rcq-trust-test-'))

/// One self-signed P-256 certificate with the SAN given, the way install.sh
/// makes one. Returns the PEM pair and the canonical fingerprint (sha256 of
/// the DER), computed here independently of the code under test.
function mintCert(name, san) {
  const key = path.join(TMP, `${name}.key`)
  const crt = path.join(TMP, `${name}.crt`)
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', key, '-out', crt, '-days', '3650', '-subj', '/CN=rcq-test-island',
    '-addext', `subjectAltName=${san}`,
  ], { stdio: 'ignore' })
  const pem = fs.readFileSync(crt, 'utf8')
  const fp = crypto.createHash('sha256').update(new crypto.X509Certificate(pem).raw).digest('hex')
  return { key: fs.readFileSync(key, 'utf8'), cert: pem, fp }
}

const certA = mintCert('a', 'DNS:localhost,IP:127.0.0.1')
const certB = mintCert('b', 'DNS:localhost,IP:127.0.0.1')
// The SAN names somebody else: the phones would pin it, Node cannot anchor it.
const certC = mintCert('c', 'DNS:nope.example')
assert.notEqual(certA.fp, certB.fp)

/// Every HTTP request the stub answered: the proof that a refusal sent
/// nothing, and that an accepted island really was asked.
const hits = []

/// The endpoints the cheapest commands need: register (a challenge the island
/// does not know, then the account), whoami (the profile), health.
function startIsland(cert, port = 0) {
  const srv = https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
    hits.push(`${req.method} ${req.url}`)
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.url === '/health') return json(200, { ok: true, app: 'RCQ', version: 'test-island' })
    if (req.url === '/auth/register/challenge') return json(404, { detail: 'not here' })
    if (req.url === '/auth/register') return json(200, { uin: 4242, token: 'stub-jwt' })
    if (req.url === '/users/4242/info') return json(200, { uin: 4242, nickname: 'stubby', status: 'online' })
    json(404, { detail: 'nope' })
  })
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)))
}

/// One rcq run in `home`. ⚠ spawn, never spawnSync: the island lives in THIS
/// process and a blocked event loop cannot answer a handshake.
function rcq(home, args, extra = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [RCQ, ...args], {
      env: { ...process.env, RCQ_CLI_HOME: home, NO_COLOR: '1', RCQ_NO_UPDATE_CHECK: '1', ...extra },
    })
    let out = '', err = ''
    c.stdout.on('data', (b) => (out += b))
    c.stderr.on('data', (b) => (err += b))
    c.on('close', (code) => resolve({ code, out, err }))
  })
}

const pins = (home) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'island-pins.json'), 'utf8'))
  } catch {
    return {}
  }
}
const pemOf = (home, key) => path.join(home, 'island-certs', `${key.replace(/:/g, '_')}.pem`)
const fresh = (name) => fs.mkdtempSync(path.join(TMP, `${name}-`))

let island = await startIsland(certA)
const PORT = island.address().port
const HOST = `127.0.0.1:${PORT}`
const ZEROS = '0'.repeat(64)

// -- first use: pin, say so once, and the request goes through -----------
const home1 = fresh('home1')
const first = await rcq(home1, ['register', '--island', HOST, '--nick', 'tester'])
assert.equal(first.code, 0, `register should pass: ${first.err}`)
assert.match(first.out, /^uin: 4242$/m, 'the stub account was registered')
assert.ok(first.err.includes('first connection') && first.err.includes(certA.fp), `first use is said, with the fingerprint: ${first.err}`)
assert.ok(hits.includes('POST /auth/register'), 'the register request reached the island')
assert.deepEqual(pins(home1)[HOST], { ...pins(home1)[HOST], mode: 'pinned', fp: certA.fp, source: 'tofu' })
assert.ok(fs.existsSync(pemOf(home1, HOST)), 'the PEM is under island-certs/')

hits.length = 0
const second = await rcq(home1, ['whoami'])
assert.equal(second.code, 0, `whoami should pass: ${second.err}`)
assert.match(second.out, /^nickname: stubby$/m, 'the profile request went through under the pinned anchor')
assert.match(second.out, new RegExp(`^trust: fingerprint ${certA.fp}$`, 'm'), 'whoami shows how the island is trusted')
assert.ok(!second.err.includes('first connection'), `the second run is silent: ${second.err}`)
assert.ok(fs.existsSync(path.join(home1, 'island-certs', 'bundle.pem')), 'the startup exec wrote the bundle')
assert.deepEqual(hits, ['GET /users/4242/info'])

const asJson = await rcq(home1, ['whoami', '--json'])
assert.equal(asJson.code, 0)
assert.deepEqual(JSON.parse(asJson.out).trust, { ...JSON.parse(asJson.out).trust, mode: 'pinned', fp: certA.fp, source: 'tofu' })

// -- a swapped certificate is refused, with both fingerprints, and nothing
// is sent -------------------------------------------------------------
await new Promise((r) => island.close(r))
island = await startIsland(certB, PORT)
hits.length = 0
const swapped = await rcq(home1, ['whoami'])
assert.equal(swapped.code, 1, 'a changed certificate stops the command')
assert.ok(swapped.err.includes(certA.fp) && swapped.err.includes(certB.fp), `both fingerprints are printed: ${swapped.err}`)
assert.ok(swapped.err.includes(`rcq island trust ${HOST} ${certB.fp} --replace`), 'and the command that accepts it')
assert.deepEqual(hits, [], 'no request was sent to the refused island')
assert.equal(pins(home1)[HOST].fp, certA.fp, 'the record is untouched')

// -- accepting it: `island trust` refuses to overwrite silently, --replace
// is the accept, and the next command goes through --------------------
const noReplace = await rcq(home1, ['island', 'trust', HOST, certB.fp])
assert.equal(noReplace.code, 1, 'a record that disagrees is not overwritten without --replace')
assert.ok(noReplace.err.includes(certA.fp) && noReplace.err.includes(certB.fp), 'and both values are shown')
assert.equal(pins(home1)[HOST].fp, certA.fp)
// openssl's own spelling of the fingerprint is accepted.
const colons = certB.fp.toUpperCase().match(/.{2}/g).join(':')
const replace = await rcq(home1, ['island', 'trust', HOST, colons, '--replace'])
assert.equal(replace.code, 0, `--replace should pass: ${replace.err}`)
assert.equal(replace.out.trim(), `${HOST}#${certB.fp}`, 'stdout is the address to hand out')
assert.deepEqual(pins(home1)[HOST], { ...pins(home1)[HOST], mode: 'pinned', fp: certB.fp, source: 'typed' })
assert.ok(!fs.existsSync(pemOf(home1, HOST)), 'the old anchor went with the old pin')
hits.length = 0
const accepted = await rcq(home1, ['whoami'])
assert.equal(accepted.code, 0, `whoami after --replace should pass: ${accepted.err}`)
assert.match(accepted.out, /^nickname: stubby$/m)
assert.ok(!accepted.err.includes('first connection'), 'a typed pin is no first use')
assert.ok(fs.existsSync(pemOf(home1, HOST)), 'the new anchor was written at the matching connect')
assert.deepEqual(hits, ['GET /users/4242/info'])

// `island fingerprint` shows it, on stdout as data.
const show = await rcq(home1, ['island', 'fingerprint'])
assert.equal(show.code, 0, show.err)
assert.equal(show.out.trim(), `${HOST}#${certB.fp}`)
const showJson = await rcq(home1, ['island', 'fingerprint', HOST, '--json'])
assert.equal(showJson.code, 0)
assert.equal(JSON.parse(showJson.out).trust.fp, certB.fp)

// -- a typed fingerprint the island does not present is refused ---------
assert.equal((await rcq(home1, ['island', 'trust', HOST, ZEROS, '--replace'])).code, 0)
hits.length = 0
const wrongTyped = await rcq(home1, ['whoami'])
assert.equal(wrongTyped.code, 1, 'the island does not match what was typed')
assert.ok(wrongTyped.err.includes('you entered') && wrongTyped.err.includes(ZEROS) && wrongTyped.err.includes(certB.fp), wrongTyped.err)
assert.deepEqual(hits, [], 'nothing was sent')

// -- address errors: not a fingerprint, and a fragment on the flagship ---
const notFp = await rcq(home1, ['island', 'trust', HOST, 'zz'])
assert.equal(notFp.code, 2, 'a value that is not a fingerprint is a usage error')
assert.match(notFp.err, /not a fingerprint/)
const home2 = fresh('home2')
hits.length = 0
const badFrag = await rcq(home2, ['register', '--island', `${HOST}#k=abc`])
assert.equal(badFrag.code, 2, 'a group key pasted as a fragment is an address error')
assert.match(badFrag.err, /not a fingerprint/)
assert.deepEqual(hits, [], 'and nothing was dialled')
assert.deepEqual(pins(home2), {}, 'and nothing was pinned')
const caOnly = await rcq(home2, ['register', '--island', `api.rcq.app#${certB.fp}`])
assert.equal(caOnly.code, 2, 'a fragment on the flagship is an address error')
assert.match(caOnly.err, /certificate authority/)
assert.equal((await rcq(home2, ['island', 'trust', 'api.rcq.app', certB.fp])).code, 2)

// -- the careful path: register on host#fp, no first use ----------------
const typed = await rcq(home2, ['register', '--island', `${HOST}#${certB.fp}`, '--nick', 'careful'])
assert.equal(typed.code, 0, `typed register should pass: ${typed.err}`)
assert.match(typed.out, /^uin: 4242$/m)
assert.ok(!typed.err.includes('first connection'), `no first-use notice on the careful path: ${typed.err}`)
assert.deepEqual(pins(home2)[HOST], { ...pins(home2)[HOST], mode: 'pinned', fp: certB.fp, source: 'typed' })
assert.ok(fs.existsSync(pemOf(home2, HOST)))
// A fragment equal to what is on file is a no-op; a different one is a
// refusal at the form, nothing dialled.
assert.equal((await rcq(home2, ['island', 'fingerprint', `${HOST}#${certB.fp}`])).code, 0)
hits.length = 0
const disagree = await rcq(home2, ['island', 'fingerprint', `${HOST}#${certA.fp}`])
assert.equal(disagree.code, 1, 'a fragment against a record that disagrees is refused')
assert.ok(disagree.err.includes(certB.fp) && disagree.err.includes(certA.fp), disagree.err)
assert.deepEqual(hits, [])
assert.equal(pins(home2)[HOST].fp, certB.fp, 'and the record is untouched')
// forget: record and anchor both go.
assert.equal((await rcq(home2, ['island', 'forget', HOST])).code, 0)
assert.deepEqual(pins(home2), {})
assert.ok(!fs.existsSync(pemOf(home2, HOST)))

// A wrong typed fingerprint on a fresh home: refused at the first connect,
// nothing registered.
const home3 = fresh('home3')
hits.length = 0
const wrongFresh = await rcq(home3, ['register', '--island', `${HOST}#${ZEROS}`])
assert.equal(wrongFresh.code, 1)
assert.ok(wrongFresh.err.includes('you entered'), wrongFresh.err)
assert.deepEqual(hits, [], 'nothing was sent to an island that does not match the typed fingerprint')
assert.ok(!fs.existsSync(path.join(home3, 'localstorage.json')) || !fs.readFileSync(path.join(home3, 'localstorage.json'), 'utf8').includes('4242'))

// -- a certificate Node cannot anchor is not pinned -----------------------
const other = await startIsland(certC)
const OTHER = `127.0.0.1:${other.address().port}`
const home4 = fresh('home4')
hits.length = 0
const unpinnable = await rcq(home4, ['register', '--island', OTHER])
assert.equal(unpinnable.code, 1, 'a SAN that does not name the host cannot be an anchor here')
assert.match(unpinnable.err, /ERR_TLS_CERT_ALTNAME_INVALID/, `the error is named: ${unpinnable.err}`)
assert.deepEqual(pins(home4), {}, 'nothing was pinned')
assert.ok(!fs.existsSync(pemOf(home4, OTHER)))
assert.deepEqual(hits, [])

// -- the island does not answer, and a pin is the only thing that would have
// judged the connection: refused, not waved through ---------------------
// home1 carries a typed pin for HOST. Node validates the command's own fetch
// against the platform roots plus our anchors and never against the record,
// so a probe that gives up must not be a way past the pin.
await new Promise((r) => island.close(r))
hits.length = 0
const gone = await rcq(home1, ['whoami'])
assert.equal(gone.code, 1, `a pinned island that does not answer stops the command: ${gone.err}`)
assert.ok(gone.err.includes('Nothing was sent'), `and says why: ${gone.err}`)
assert.deepEqual(hits, [], 'nothing was sent')

other.close()
fs.rmSync(TMP, { recursive: true, force: true })
console.error('island-trust: first use, refusal, --replace, typed pin, address errors, unpinnable, no answer ok')

// The backup auto-pick rule, offline (#988).
//
// Why this gets a test of its own: the auto-pick took the first catalogue
// island that answered /health. The catalogue lists the flagship, the flagship
// now sells entry, and an account on is2 that switched the backup on was sent
// to register there and shown `{"detail":{"code":"entry_required"}}`. The rule
// that replaced it is the same on Android, iOS and here:
//   * R1 an island is SILENT on a redirect, a timeout, a network error, a
//     non-2xx answer or an unreadable /server/info (over 64 KB, not UTF-8, not
//     strict JSON, not an object).
//   * R2 OPEN when registration_policy is "open" or absent and closed_island is
//     not true; SHUT otherwise, a malformed field and a JSON null included.
//     Price is ignored.
//   * R3 one island at a time in catalogue order, stop at the first copy. OPEN
//     registers (recover-first); a door refusal moves on WITHOUT a second
//     recover. SHUT only recovers, once. SILENT gets nothing.
//   * R4 the relay pass runs only when every island was SILENT, a catalogue
//     that did not arrive or verify included; a verified empty list is not.
//   * R5 nothing answered: NO_ISLAND_REACHABLE; answered, or a verified list
//     with nobody left: NO_OPEN_ISLAND.
// Everything here is production code from src/lib/backup-pick.ts.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'
import {
  INFO_BODY_CAP,
  NO_ISLAND_REACHABLE,
  NO_OPEN_ISLAND,
  detailCodeOf,
  doorOf,
  doorRefusalOf,
  hostVerdict,
  infoVerdict,
  pickBackupIsland,
  probePassed,
  readCappedText,
} from '../dist/backup-pick.mjs'

let n = 0
const check = async (label, fn) => {
  await fn()
  n++
  console.log('  ok  ' + label)
}

// The two live answers seen on 15.09 (GET /server/info, capabilities).
const FLAGSHIP = { registration_policy: 'paid', entry_price_cents: 1500, entry_url: 'https://rcq.app/residency', closed_island: false }
const IS2 = { registration_policy: 'open', entry_price_cents: 0, entry_url: '', closed_island: false }

const HEALTH = { status: 200, redirect: false }
const info = (doc) => ({ status: 200, redirect: false, body: JSON.stringify(doc) })

/// What registerOnIsland throws on a refusal: the body as message, plus status and body.
function refusal(status, code) {
  const body = JSON.stringify({ detail: { code } })
  return Object.assign(new Error(body), { status, body })
}

// ---------------------------------------------------------------- R2: the door

await check('door: the live flagship is shut, the live is2 is open', () => {
  assert.equal(doorOf(FLAGSHIP), 'shut')
  assert.equal(doorOf(IS2), 'open')
})

await check('door: policy "open" or absent is open', () => {
  assert.equal(doorOf({ registration_policy: 'open' }), 'open')
  assert.equal(doorOf({}), 'open')
  assert.equal(doorOf({ closed_island: false }), 'open')
  assert.equal(doorOf(undefined), 'open', 'no capabilities at all: an island older than them')
})

await check('door: paid, invite and any other policy are shut', () => {
  assert.equal(doorOf({ registration_policy: 'paid' }), 'shut')
  assert.equal(doorOf({ registration_policy: 'invite' }), 'shut')
  assert.equal(doorOf({ registration_policy: 'closed' }), 'shut')
  assert.equal(doorOf({ registration_policy: 'Open' }), 'shut')
  assert.equal(doorOf({ registration_policy: '' }), 'shut')
})

await check('door: closed_island true is shut even with the policy open', () => {
  assert.equal(doorOf({ registration_policy: 'open', closed_island: true }), 'shut')
  assert.equal(doorOf({ closed_island: true }), 'shut')
})

await check('door: a present field of the wrong type is shut', () => {
  assert.equal(doorOf({ registration_policy: 1 }), 'shut')
  assert.equal(doorOf({ registration_policy: ['open'] }), 'shut')
  assert.equal(doorOf({ closed_island: 'false' }), 'shut')
  assert.equal(doorOf({ closed_island: 0 }), 'shut')
  assert.equal(doorOf('open'), 'shut', 'capabilities as a string')
  assert.equal(doorOf([]), 'shut', 'capabilities as an array')
})

await check('door (D1): a JSON null is malformed, so shut; only a missing field is absent', () => {
  // Straight from the wire, so the null is a real JSON null and not a JS default.
  assert.equal(infoVerdict('{"capabilities":null}'), 'shut', 'capabilities: null')
  assert.equal(infoVerdict('{"capabilities":{"registration_policy":null}}'), 'shut', 'registration_policy: null')
  assert.equal(infoVerdict('{"capabilities":{"closed_island":null}}'), 'shut', 'closed_island: null')
  assert.equal(infoVerdict('{"capabilities":{"registration_policy":"open","closed_island":null}}'), 'shut')
  assert.equal(infoVerdict('{"capabilities":{"registration_policy":null,"closed_island":false}}'), 'shut')
  assert.equal(doorOf(null), 'shut')
  assert.equal(doorOf({ registration_policy: null }), 'shut')
  assert.equal(doorOf({ closed_island: null }), 'shut')
  // Missing altogether is absent, and absent is open.
  assert.equal(infoVerdict('{"name":"old island"}'), 'open', 'capabilities missing')
  assert.equal(infoVerdict('{"capabilities":{}}'), 'open', 'both fields missing')
  assert.equal(infoVerdict('{"capabilities":{"closed_island":false}}'), 'open', 'policy missing')
  assert.equal(infoVerdict('{"capabilities":{"registration_policy":"open"}}'), 'open', 'closed_island missing')
})

await check('door: the entry price is not part of the rule', () => {
  assert.equal(doorOf({ registration_policy: 'open', entry_price_cents: 1500 }), 'open')
  assert.equal(doorOf({ entry_price_cents: 1 }), 'open')
  assert.equal(doorOf({ entry_price_cents: 'lots' }), 'open')
  assert.equal(doorOf({ registration_policy: 'paid', entry_price_cents: 0 }), 'shut')
})

// ------------------------------------------------------------- R1: the probe

await check('probe: both answers readable gives the door', () => {
  assert.equal(hostVerdict(HEALTH, info({ name: 'is2', capabilities: IS2 })), 'open')
  assert.equal(hostVerdict(HEALTH, info({ name: 'RCQ', capabilities: FLAGSHIP })), 'shut')
  assert.equal(hostVerdict({ status: 204, redirect: false }, info({})), 'open')
})

await check('probe: a redirect on either GET is silent', () => {
  const opaque = { status: 0, redirect: true }
  assert.equal(hostVerdict(opaque, info({ capabilities: IS2 })), 'silent')
  assert.equal(hostVerdict(HEALTH, { ...opaque, body: JSON.stringify({ capabilities: IS2 }) }), 'silent')
  assert.equal(hostVerdict({ status: 301, redirect: false }, info({ capabilities: IS2 })), 'silent')
  assert.equal(hostVerdict(HEALTH, { status: 302, redirect: false, body: '{}' }), 'silent')
  assert.equal(hostVerdict({ status: 200, redirect: true }, info({ capabilities: IS2 })), 'silent', 'followed anyway')
})

await check('probe: timeout, network error or a non-2xx /health is silent', () => {
  assert.equal(hostVerdict(null, info({ capabilities: IS2 })), 'silent')
  assert.equal(hostVerdict(undefined, info({ capabilities: IS2 })), 'silent')
  assert.equal(hostVerdict({ status: 503, redirect: false }, info({ capabilities: IS2 })), 'silent')
  assert.equal(hostVerdict({ status: 0, redirect: false }, info({ capabilities: IS2 })), 'silent')
})

await check('probe (D3): /health decides alone whether /server/info is worth asking', () => {
  assert.equal(probePassed(HEALTH), true)
  assert.equal(probePassed({ status: 204, redirect: false }), true)
  assert.equal(probePassed(null), false, 'timeout')
  assert.equal(probePassed({ status: 503, redirect: false }), false)
  assert.equal(probePassed({ status: 0, redirect: true }), false)
  assert.equal(probePassed({ status: 200, redirect: true }), false)
  // A /server/info that was never asked reads as SILENT.
  assert.equal(hostVerdict(HEALTH, null), 'silent')
  assert.equal(hostVerdict(HEALTH, undefined), 'silent')
})

await check('probe: unreadable or unparseable /server/info is silent, not shut', () => {
  assert.equal(hostVerdict(HEALTH, null), 'silent', 'timeout')
  assert.equal(hostVerdict(HEALTH, { status: 404, redirect: false, body: '{"detail":"Not Found"}' }), 'silent')
  assert.equal(hostVerdict(HEALTH, { status: 500, redirect: false, body: '{}' }), 'silent')
  assert.equal(hostVerdict(HEALTH, { status: 200, redirect: false, body: null }), 'silent', 'over the cap')
  assert.equal(hostVerdict(HEALTH, { status: 200, redirect: false }), 'silent', 'body never read')
  assert.equal(hostVerdict(HEALTH, { status: 200, redirect: false, body: '<html>captive portal</html>' }), 'silent')
  assert.equal(hostVerdict(HEALTH, { status: 200, redirect: false, body: '' }), 'silent')
  assert.equal(infoVerdict('[]'), 'silent')
  assert.equal(infoVerdict('null'), 'silent')
  assert.equal(infoVerdict('"open"'), 'silent')
})

await check('probe (D5): only strict JSON parses; what a lenient parser would accept is silent', () => {
  assert.equal(infoVerdict('{capabilities: {}}'), 'silent', 'unquoted key')
  assert.equal(infoVerdict("{'capabilities': {}}"), 'silent', 'single quotes')
  assert.equal(infoVerdict('{"capabilities": {},}'), 'silent', 'trailing comma')
  assert.equal(infoVerdict('{"capabilities": {"registration_policy": "open"}} trailing'), 'silent', 'garbage after the object')
  assert.equal(infoVerdict('// note\n{"capabilities": {}}'), 'silent', 'comment')
  assert.equal(infoVerdict('{"capabilities": {"closed_island": NaN}}'), 'silent', 'NaN')
  assert.equal(infoVerdict('{"capabilities": {"registration_policy": "open"}'), 'silent', 'cut off')
})

await check('probe (D5): the /server/info body is refused past 64 KB, never cut down and parsed', async () => {
  assert.equal(INFO_BODY_CAP, 64 * 1024)
  const atCap = 'x'.repeat(INFO_BODY_CAP)
  assert.equal(await readCappedText(new Response(atCap)), atCap)
  assert.equal(await readCappedText(new Response(atCap + 'x')), null)
  // A valid, OPEN answer whose first 64 KB would parse on their own once cut:
  // the whole body is refused, so the island is SILENT, not OPEN.
  const doc = '{"capabilities":{"registration_policy":"open"}}'
  const padded = doc + ' '.repeat(INFO_BODY_CAP + 1 - doc.length)
  assert.equal(new TextEncoder().encode(padded).byteLength, INFO_BODY_CAP + 1)
  const readPadded = await readCappedText(new Response(padded))
  assert.equal(readPadded, null)
  assert.equal(hostVerdict(HEALTH, { status: 200, redirect: false, body: readPadded }), 'silent')
  // Streamed without a length: refused once the bytes pass the cap.
  const chunk = new Uint8Array(30 * 1024).fill(0x20)
  let sent = 0
  const stream = new ReadableStream({
    pull(c) {
      if (sent++ < 3) c.enqueue(chunk)
      else c.close()
    },
  })
  assert.equal(await readCappedText(new Response(stream)), null)
  // A declared length past the cap is refused before reading.
  assert.equal(await readCappedText(new Response('{}', { headers: { 'content-length': String(INFO_BODY_CAP + 1) } })), null)
  // Not UTF-8 is unreadable, even inside otherwise valid JSON.
  assert.equal(await readCappedText(new Response(new Uint8Array([0xff, 0xfe, 0xfd]))), null)
  const bad = new Uint8Array([...new TextEncoder().encode('{"name":"'), 0xc3, 0x28, ...new TextEncoder().encode('"}')])
  assert.equal(await readCappedText(new Response(bad)), null)
  assert.equal(await readCappedText(new Response('{"capabilities":{}}')), '{"capabilities":{}}')
  // A body that breaks off mid-stream (the overall deadline aborting it) is unreadable.
  const broken = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"capabilities":'))
      c.error(new Error('aborted'))
    },
  })
  assert.equal(await readCappedText(new Response(broken)), null)
})

// ----------------------------------------------------- R3: door refusals read

await check('refusal (D9): exactly a 403 with detail as an object and a door code', () => {
  assert.equal(doorRefusalOf(refusal(403, 'entry_required')), 'entry')
  assert.equal(doorRefusalOf(refusal(403, 'invite_required')), 'invite')
  assert.equal(doorRefusalOf(refusal(403, 'invite_invalid')), 'invite')
  assert.equal(doorRefusalOf(refusal(403, 'key_proof_required')), null)
  assert.equal(doorRefusalOf(refusal(429, 'entry_required')), null, 'only a 403 is the door')
  assert.equal(doorRefusalOf(refusal(502, 'entry_required')), null)
  assert.equal(doorRefusalOf(new TypeError('Failed to fetch')), null)
  assert.equal(doorRefusalOf(null), null)
  assert.equal(doorRefusalOf('entry_required'), null)
})

await check('refusal (D9): a bare-string detail or a missing status is not a door', () => {
  const bareString = JSON.stringify({ detail: 'entry_required' })
  assert.equal(doorRefusalOf(Object.assign(new Error(bareString), { status: 403, body: bareString })), null, 'detail as a string')
  assert.equal(doorRefusalOf(new Error('{"detail":{"code":"entry_required"}}')), null, 'no status on the error')
  assert.equal(
    doorRefusalOf(Object.assign(new Error('x'), { status: '403', body: '{"detail":{"code":"entry_required"}}' })),
    null,
    'status as a string',
  )
  assert.equal(doorRefusalOf(Object.assign(new Error(''), { status: 403, code: 'entry_required' })), null, 'a code property with no body')
  assert.equal(doorRefusalOf(Object.assign(new Error(''), { status: 403, body: '<html>403</html>' })), null, 'not JSON')
  assert.equal(doorRefusalOf(Object.assign(new Error(''), { status: 403, body: '{"detail":{"code":1}}' })), null, 'code not a string')
  assert.equal(doorRefusalOf(Object.assign(new Error(''), { status: 403, body: '{"code":"entry_required"}' })), null, 'no detail')
  // The body may ride as the message, as it does on registerOnIsland's error.
  assert.equal(doorRefusalOf(Object.assign(new Error('{"detail":{"code":"invite_required"}}'), { status: 403 })), 'invite')
})

await check('refusal: detailCodeOf reads only an object detail', () => {
  assert.equal(detailCodeOf('{"detail":{"code":"entry_required"}}'), 'entry_required')
  assert.equal(detailCodeOf('{"detail":"Not Found"}'), null)
  assert.equal(detailCodeOf('{"detail":["entry_required"]}'), null)
  assert.equal(detailCodeOf('<html>502</html>'), null)
  assert.equal(detailCodeOf('null'), null)
})

// ------------------------------------------------------------ R3-R5: the pick

/// A fake network per pass: the candidate list (an Error = the catalogue threw,
/// null = did not verify), a verdict per host (absent = silent, an Error = the
/// probe threw), scripted register and recover outcomes per host. A recover
/// outcome of null or absent means "this account has no copy there". Every
/// network call lands in one ordered log, so the order is part of the proof.
function world({ direct = {}, relay = null }) {
  const log = { calls: [], probed: [], registered: [], recovered: [], tried: [], catalogues: [] }
  const net = (pass, s) => ({
    candidates: async () => {
      log.catalogues.push(pass)
      const c = s.candidates
      if (c instanceof Error) throw c
      return c === undefined ? Object.keys(s.verdicts ?? {}) : c
    },
    probe: async (h) => {
      log.probed.push(`${pass}:${h}`)
      log.calls.push(`probe ${pass}:${h}`)
      const v = s.verdicts?.[h]
      if (v instanceof Error) throw v
      return v ?? 'silent'
    },
    register: async (h) => {
      log.registered.push(`${pass}:${h}`)
      log.calls.push(`register ${pass}:${h}`)
      const o = s.registers?.[h]
      if (o instanceof Error) throw o
      return { host: h, uin: o ?? 1 }
    },
    recover: async (h) => {
      log.recovered.push(`${pass}:${h}`)
      log.calls.push(`recover ${pass}:${h}`)
      const o = s.recovers?.[h]
      if (o instanceof Error) throw o
      return o == null ? null : { host: h, uin: o }
    },
  })
  return {
    log,
    deps: {
      direct: net('direct', direct),
      relay: relay ? net('relay', relay) : null,
      onTrying: (h, pass) => log.tried.push(`${pass}:${h}`),
    },
  }
}

await check('#988 as reported: account on is2, flagship shut, no copy there', async () => {
  const w = world({ direct: { verdicts: { 'api.rcq.app': 'shut' } } })
  await assert.rejects(pickBackupIsland(w.deps), { message: NO_OPEN_ISLAND })
  assert.deepEqual(w.log.recovered, ['direct:api.rcq.app'])
  assert.deepEqual(w.log.registered, [], 'never register on a shut island')
})

await check('shut island with an existing copy: adopted, never registered on', async () => {
  const w = world({ direct: { verdicts: { 'api.rcq.app': 'shut', 'x.example': 'open' }, recovers: { 'api.rcq.app': 42 } } })
  const r = await pickBackupIsland(w.deps)
  assert.equal(r.host, 'api.rcq.app')
  assert.equal(r.action, 'recover')
  assert.equal(r.result.uin, 42)
  assert.deepEqual(w.log.registered, [])
  assert.deepEqual(w.log.tried, ['direct:api.rcq.app'])
  assert.deepEqual(w.log.probed, ['direct:api.rcq.app'], 'the next island is not even probed once a copy was obtained')
})

await check('shut island without a copy is passed for the next open one in catalogue order', async () => {
  const w = world({ direct: { verdicts: { 'api.rcq.app': 'shut', 'is3.example': 'open' }, registers: { 'is3.example': 9 } } })
  const r = await pickBackupIsland(w.deps)
  assert.equal(r.host, 'is3.example')
  assert.equal(r.action, 'register')
  assert.deepEqual(w.log.recovered, ['direct:api.rcq.app'])
  assert.deepEqual(w.log.registered, ['direct:is3.example'])
})

await check('D3: one island at a time, probe then act, stop at the first backup', async () => {
  const w = world({
    direct: {
      candidates: ['a.example', 'b.example', 'c.example', 'd.example', 'e.example'],
      verdicts: { 'a.example': 'silent', 'b.example': 'shut', 'c.example': 'open', 'd.example': 'open', 'e.example': 'open' },
      registers: { 'c.example': new TypeError('Failed to fetch'), 'd.example': 4 },
    },
  })
  const r = await pickBackupIsland(w.deps)
  assert.equal(r.host, 'd.example')
  assert.deepEqual(w.log.calls, [
    'probe direct:a.example',
    'probe direct:b.example',
    'recover direct:b.example',
    'probe direct:c.example',
    'register direct:c.example',
    'probe direct:d.example',
    'register direct:d.example',
  ])
  assert.ok(!w.log.probed.includes('direct:e.example'), 'nothing after the backup is probed')
})

await check('D3: a slow island is waited on, not raced; catalogue order decides', async () => {
  let inFlight = 0
  let most = 0
  const net = {
    candidates: async () => ['slow.example', 'fast.example'],
    probe: async (h) => {
      inFlight++
      most = Math.max(most, inFlight)
      await new Promise((ok) => setTimeout(ok, h === 'slow.example' ? 30 : 1))
      inFlight--
      return 'open'
    },
    register: async (h) => ({ host: h }),
    recover: async () => null,
  }
  const r = await pickBackupIsland({ direct: net })
  assert.equal(r.host, 'slow.example')
  assert.equal(most, 1, 'never two probes at once')
})

await check('D4: a 403 door refusal on an open island moves on without a second recover', async () => {
  const w = world({
    direct: {
      verdicts: { 'a.example': 'open', 'b.example': 'open' },
      registers: { 'a.example': refusal(403, 'entry_required'), 'b.example': 5 },
      recovers: { 'a.example': 77 },
    },
  })
  const r = await pickBackupIsland(w.deps)
  assert.equal(r.host, 'b.example')
  assert.equal(r.action, 'register')
  assert.deepEqual(w.log.registered, ['direct:a.example', 'direct:b.example'])
  assert.deepEqual(w.log.recovered, [], 'register already ran recover-first on a.example; it is not asked again')
})

await check('D4: a shut island still gets exactly one recover-only call', async () => {
  const w = world({
    direct: {
      verdicts: { 'a.example': 'shut', 'b.example': 'open' },
      registers: { 'b.example': refusal(403, 'invite_required') },
    },
  })
  await assert.rejects(pickBackupIsland(w.deps), { message: NO_OPEN_ISLAND })
  assert.deepEqual(w.log.calls, ['probe direct:a.example', 'recover direct:a.example', 'probe direct:b.example', 'register direct:b.example'])
})

await check('silent islands get neither recover nor register', async () => {
  const w = world({ direct: { verdicts: { 'down.example': 'silent', 'thrown.example': new Error('probe'), 'up.example': 'open' } } })
  const r = await pickBackupIsland(w.deps)
  assert.equal(r.host, 'up.example')
  assert.deepEqual(w.log.recovered, [])
  assert.deepEqual(w.log.registered, ['direct:up.example'])
  assert.deepEqual(w.log.tried, ['direct:up.example'])
})

await check('catalogue order wins', async () => {
  const w = world({ direct: { verdicts: { 'a.example': 'open', 'b.example': 'open' } } })
  const r = await pickBackupIsland(w.deps)
  assert.equal(r.host, 'a.example')
  assert.deepEqual(w.log.tried, ['direct:a.example'])
})

await check('a failure that is not the door moves on, each island once', async () => {
  const w = world({
    direct: {
      verdicts: { 'a.example': 'open', 'b.example': 'shut', 'c.example': 'open' },
      registers: { 'a.example': new TypeError('Failed to fetch'), 'c.example': 3 },
      recovers: { 'b.example': new Error('recover challenge: HTTP 503') },
    },
  })
  const r = await pickBackupIsland(w.deps)
  assert.equal(r.host, 'c.example')
  assert.deepEqual(w.log.recovered, ['direct:b.example'], 'no recover after a failed register on an open island')
})

await check('answered but no copy anywhere: NO_OPEN_ISLAND, no relay pass, each island once', async () => {
  const w = world({
    direct: {
      // A duplicated catalogue entry must not buy a second attempt.
      candidates: ['a.example', 'b.example', 'c.example', 'a.example'],
      verdicts: { 'a.example': 'open', 'b.example': 'shut', 'c.example': 'silent' },
      registers: { 'a.example': refusal(403, 'entry_required') },
    },
    relay: { verdicts: { 'c.example': 'open' } },
  })
  await assert.rejects(pickBackupIsland(w.deps), { message: NO_OPEN_ISLAND })
  assert.deepEqual(w.log.probed, ['direct:a.example', 'direct:b.example', 'direct:c.example'])
  assert.deepEqual(w.log.registered, ['direct:a.example'])
  assert.deepEqual(w.log.recovered, ['direct:b.example'])
  assert.deepEqual(w.log.catalogues, ['direct'], 'the relay pass never ran')
})

await check('all silent: the relay pass runs once with the same rule', async () => {
  const w = world({
    direct: { candidates: ['a.example', 'b.example'], verdicts: {} },
    relay: { candidates: ['a.example', 'b.example'], verdicts: { 'a.example': 'shut', 'b.example': 'open' }, registers: { 'b.example': 11 } },
  })
  const r = await pickBackupIsland(w.deps)
  assert.equal(r.host, 'b.example')
  assert.equal(r.pass, 'relay')
  assert.deepEqual(w.log.probed, ['direct:a.example', 'direct:b.example', 'relay:a.example', 'relay:b.example'])
  assert.deepEqual(w.log.registered, ['relay:b.example'], 'never register on the shut one through the relay either')
  assert.deepEqual(w.log.recovered, ['relay:a.example'])
})

await check('all silent on both passes: NO_ISLAND_REACHABLE', async () => {
  const w = world({ direct: { verdicts: { 'a.example': 'silent' } }, relay: { verdicts: { 'a.example': new Error('tunnel') } } })
  await assert.rejects(pickBackupIsland(w.deps), { message: NO_ISLAND_REACHABLE })
  assert.deepEqual(w.log.registered, [])
  assert.deepEqual(w.log.recovered, [])
})

await check('all silent, relay pass answers but yields nothing: NO_OPEN_ISLAND', async () => {
  const w = world({ direct: { candidates: ['a.example'] }, relay: { verdicts: { 'a.example': 'shut' } } })
  await assert.rejects(pickBackupIsland(w.deps), { message: NO_OPEN_ISLAND })
})

await check('all silent and no relay pass on this client: NO_ISLAND_REACHABLE', async () => {
  const w = world({ direct: { verdicts: { 'a.example': 'silent', 'b.example': 'silent' } } })
  await assert.rejects(pickBackupIsland(w.deps), { message: NO_ISLAND_REACHABLE })
})

// ------------------------------------------------- D2: catalogue vs candidates

await check('D2: a catalogue that throws counts as all silent, and the relay pass runs', async () => {
  const w = world({
    direct: { candidates: new Error('no catalogue') },
    relay: { verdicts: { 'a.example': 'open' }, registers: { 'a.example': 8 } },
  })
  const r = await pickBackupIsland(w.deps)
  assert.equal(r.host, 'a.example')
  assert.equal(r.pass, 'relay')
  assert.deepEqual(w.log.catalogues, ['direct', 'relay'])
  assert.deepEqual(w.log.probed, ['relay:a.example'])
})

await check('D2: a catalogue that did not verify (null) counts as all silent too', async () => {
  const w = world({ direct: { candidates: null }, relay: { candidates: null } })
  await assert.rejects(pickBackupIsland(w.deps), { message: NO_ISLAND_REACHABLE })
  assert.deepEqual(w.log.catalogues, ['direct', 'relay'])
})

await check('D2: no catalogue and no relay pass on this client: NO_ISLAND_REACHABLE', async () => {
  const w = world({ direct: { candidates: new Error('no catalogue') } })
  await assert.rejects(pickBackupIsland(w.deps), { message: NO_ISLAND_REACHABLE })
  assert.deepEqual(w.log.probed, [])
})

await check('D2: a verified catalogue with no candidate left is NO_OPEN_ISLAND, no relay pass', async () => {
  const w = world({ direct: { candidates: [] }, relay: { verdicts: { 'a.example': 'open' } } })
  await assert.rejects(pickBackupIsland(w.deps), { message: NO_OPEN_ISLAND })
  assert.deepEqual(w.log.catalogues, ['direct'], 'the relays are not brought up for an empty list')
  assert.deepEqual(w.log.probed, [])
  const bare = world({ direct: { candidates: [] } })
  await assert.rejects(pickBackupIsland(bare.deps), { message: NO_OPEN_ISLAND })
})

await check('D2: the relay pass with a verified but empty list is NO_OPEN_ISLAND too', async () => {
  const w = world({ direct: { candidates: ['a.example'] }, relay: { candidates: [] } })
  await assert.rejects(pickBackupIsland(w.deps), { message: NO_OPEN_ISLAND })
})

console.log(`backup-pick: ${n} checks passed`)

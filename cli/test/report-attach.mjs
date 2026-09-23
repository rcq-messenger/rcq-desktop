// Screenshots on a report turn (#1039), offline.
//
// "Write back" on an open report could only carry text, so a person on the
// Windows desktop filed a new report just to hand over one picture. The fix
// shares the new-report form's attachment path with the reply box. What this
// file pins down:
//   * the shared rules (cap, what counts as a picture, all-or-nothing upload);
//   * the wire: with nothing attached `addToReport` sends `{"body": ...}` and
//     not one byte more, so an island that predates the field sees exactly
//     what it saw before;
//   * the gate: `report_turn_attachments` is off unless the island says a
//     literal `true`, because an island without it silently DROPS the field
//     (FastAPI ignores unknown keys) and answers 201 as if it had kept it;
//   * the belt: a turn that comes back without the pictures reads as dropped;
//   * the format: a blob sealed by `uploadReportAttachments` opens exactly the
//     way the admin queue opens it (web-admin/src/api.ts `decryptAttachment`).
//
// ⚠ No island is touched: every fetch here is a stub.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'
import {
  addPicked,
  addTurnBody,
  attachmentsKept,
  canSendTurn,
  filesFromClipboard,
  REPORT_MAX_ATTACHMENTS,
  ReportAttachmentUploadError,
  uploadAll,
  uploadReportAttachments,
  Api,
  DEFAULT_CAPABILITIES,
  loadServerInfo,
} from '../dist/report-attach.mjs'

let passed = 0
let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
    passed++
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e && e.message ? e.message : e}`)
    failed++
  }
}

const f = (type, name = 'x') => ({ type, name })
const att = (id) => ({ media_id: id, key: 'k', mime: 'image/jpeg', size: 1 })

console.log('REPORT ATTACH')

// ── shared rules ──────────────────────────────────────────────────────────
await check('the cap is the island\'s three', () => {
  assert.equal(REPORT_MAX_ATTACHMENTS, 3)
})
await check('addPicked caps at three and keeps order', () => {
  const a = f('image/png', 'a'), b = f('image/jpeg', 'b'), c = f('video/mp4', 'c'), d = f('image/png', 'd')
  assert.deepEqual(addPicked([a], [b, c, d]).map((x) => x.name), ['a', 'b', 'c'])
  assert.deepEqual(addPicked([a, b, c], [d]).map((x) => x.name), ['a', 'b', 'c'])
})
await check('addPicked ignores what is not a picture or a video', () => {
  assert.deepEqual(addPicked([], [f('text/plain'), f('application/pdf'), f('image/webp', 'w')]).map((x) => x.name), ['w'])
})
await check('a paste yields only its pictures, and nothing is not an error', () => {
  const png = new File([new Uint8Array([1])], 'image.png', { type: 'image/png' })
  const txt = new File([new Uint8Array([1])], 'a.txt', { type: 'text/plain' })
  assert.deepEqual(filesFromClipboard({ files: [png, txt] }).map((x) => x.name), ['image.png'])
  assert.deepEqual(filesFromClipboard(null), [])
  assert.deepEqual(filesFromClipboard({ files: null }), [])
})

// ── all or nothing ────────────────────────────────────────────────────────
await check('uploadAll returns every descriptor when every upload lands', async () => {
  const out = await uploadAll([1, 2], async (n) => att(`m${n}`))
  assert.deepEqual(out.map((x) => x.media_id), ['m1', 'm2'])
})
await check('uploadAll with nothing picked asks nobody', async () => {
  let calls = 0
  assert.deepEqual(await uploadAll([], async () => { calls++; return att('x') }), [])
  assert.equal(calls, 0)
})
await check('one upload answering null stops the whole send (no silent drop)', async () => {
  await assert.rejects(
    uploadAll([1, 2, 3], async (n) => (n === 2 ? null : att(`m${n}`))),
    (e) => e instanceof ReportAttachmentUploadError && e.failed === 1,
  )
})
await check('one upload throwing stops the whole send too', async () => {
  await assert.rejects(
    uploadAll([1, 2], async (n) => { if (n === 1) throw new TypeError('Failed to fetch'); return att('m2') }),
    (e) => e instanceof ReportAttachmentUploadError && e.failed === 1,
  )
})

// ── what may be sent ──────────────────────────────────────────────────────
await check('text alone may always be sent, on any island', () => {
  assert.equal(canSendTurn('still happens', 0, false), true)
  assert.equal(canSendTurn('still happens', 2, false), true)
})
await check('a picture with no text only where the island takes attachments', () => {
  assert.equal(canSendTurn('', 1, false), false)
  assert.equal(canSendTurn('   ', 1, true), true)
  assert.equal(canSendTurn('   ', 0, true), false)
})

// ── the wire ──────────────────────────────────────────────────────────────
await check('no attachments: the body is {"body"} and nothing else', () => {
  assert.equal(JSON.stringify(addTurnBody('x', [])), '{"body":"x"}')
})
await check('with attachments: the same four fields the report itself carries', () => {
  const a = { media_id: 'm1', key: 'K', mime: 'image/jpeg', size: 10 }
  assert.deepEqual(addTurnBody('', [a]), { body: '', attachments: [a] })
})

const realFetch = globalThis.fetch
const ident = { apiBase: 'https://island.test', jwt: 'jwt', uin: 495 }
async function capture(fn, reply) {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: init?.method, body: init?.body, headers: init?.headers })
    return reply(url, init)
  }
  try {
    const out = await fn()
    return { seen, out }
  } finally {
    globalThis.fetch = realFetch
  }
}
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })

await check('Api.addToReport without pictures sends byte-for-byte what old builds sent', async () => {
  const { seen, out } = await capture(
    () => Api.addToReport(ident, 1038, 'still happens'),
    () => json(201, { id: 7, from_admin: false, body: 'still happens', created_at: '2026-09-23T06:44:00Z' }),
  )
  assert.equal(seen.length, 1)
  assert.equal(seen[0].method, 'POST')
  assert.equal(seen[0].url, 'https://island.test/reports/mine/1038/messages')
  assert.equal(seen[0].body, '{"body":"still happens"}')
  assert.equal(out.id, 7)
})
await check('Api.addToReport with a picture carries it next to the text', async () => {
  const a = { media_id: 'm1', key: 'K', mime: 'image/jpeg', size: 10 }
  const { seen } = await capture(
    () => Api.addToReport(ident, 1038, '', [a]),
    () => json(201, { id: 8, from_admin: false, body: '', created_at: '2026-09-23T06:44:00Z', attachments: [a] }),
  )
  assert.deepEqual(JSON.parse(seen[0].body), { body: '', attachments: [a] })
})

// ── the belt: an island that dropped the pictures ─────────────────────────
await check('a turn back WITHOUT the field (island predates it) reads as dropped', () => {
  assert.equal(attachmentsKept(1, { id: 1, body: 'x' }), false)
})
await check('a turn back with fewer pictures than sent reads as dropped', () => {
  assert.equal(attachmentsKept(2, { attachments: [att('a')] }), false)
  assert.equal(attachmentsKept(1, { attachments: [] }), false)
})
await check('a turn back with all of them, or nothing sent, is kept', () => {
  assert.equal(attachmentsKept(1, { attachments: [att('a')] }), true)
  assert.equal(attachmentsKept(0, { id: 1 }), true)
  assert.equal(attachmentsKept(0, null), true)
})

// ── the gate ──────────────────────────────────────────────────────────────
await check('the capability defaults OFF', () => {
  assert.equal(DEFAULT_CAPABILITIES.report_turn_attachments, false)
})
for (const [label, caps, want] of [
  ['absent (every island today)', {}, false],
  ['a literal true', { report_turn_attachments: true }, true],
  ['explicit false', { report_turn_attachments: false }, false],
  ['a truthy string is not true', { report_turn_attachments: 'yes' }, false],
]) {
  await check(`/server/info ${label} -> ${want}`, async () => {
    const { out } = await capture(
      () => loadServerInfo('https://island.test'),
      () => json(200, { name: 'I', capabilities: caps }),
    )
    assert.equal(out.capabilities.report_turn_attachments, want)
  })
}

// ── the format the admin queue opens ──────────────────────────────────────
// Mirrors web-admin/src/api.ts `decryptAttachment` line for line: GET the
// blob, first 12 bytes are the nonce, the rest is ciphertext+tag, the key is
// the raw 32 bytes in base64.
async function adminDecrypt(sealed, keyB64) {
  const iv = sealed.slice(0, 12)
  const cipher = sealed.slice(12)
  const rawKey = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt'])
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher))
}

await check('a sealed upload opens the way the admin queue opens it', async () => {
  const plain = new Uint8Array(4096).map((_, i) => (i * 7) & 0xff)
  const file = new File([plain], 'clip.mp4', { type: 'video/mp4' })
  let sealed = null
  const { seen, out } = await capture(
    () => uploadReportAttachments('https://island.test', [file]),
    async (url, init) => {
      const blob = init.body.get('blob')
      sealed = new Uint8Array(await blob.arrayBuffer())
      return json(201, { media_id: 'abc123', size: sealed.length })
    },
  )
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, 'https://island.test/media/upload')
  assert.equal(seen[0].method, 'POST')
  assert.equal(out.length, 1)
  assert.equal(out[0].media_id, 'abc123')
  assert.equal(out[0].mime, 'video/mp4')
  assert.equal(out[0].size, plain.byteLength)
  // The island only ever holds ciphertext: the upload is not the plaintext.
  assert.notDeepEqual(sealed.slice(12, 12 + plain.length), plain)
  assert.deepEqual(await adminDecrypt(sealed, out[0].key), plain)
})
await check('an upload the island refuses stops the send before any turn', async () => {
  const file = new File([new Uint8Array(8)], 'clip.mp4', { type: 'video/mp4' })
  const { seen } = await capture(
    () => uploadReportAttachments('https://island.test', [file]).then(
      () => assert.fail('should have thrown'),
      (e) => assert.ok(e instanceof ReportAttachmentUploadError),
    ),
    () => json(500, { detail: 'boom' }),
  )
  // One request, and it was the upload: nothing reached /reports.
  assert.equal(seen.length, 1)
  assert.match(seen[0].url, /\/media\/upload$/)
})

console.log(`\nREPORT ATTACH: ${passed}/${passed + failed} ok`)
if (failed) process.exit(1)

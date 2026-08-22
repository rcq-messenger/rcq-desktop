#!/usr/bin/env node
// Bundle the CLI from the SAME src/lib the web ships — reuse, not a rewrite.
// Three swaps, all node-vs-browser plumbing, none of them protocol:
//   * './signalwasm/signal_wasm.js' -> shims/signal-wasm-node.ts, which
//     require()s the nodejs-target build of the same crate at runtime. The
//     glue is deliberately NOT inlined: wasm-bindgen's node glue reads
//     signal_wasm_bg.wasm relative to its own __dirname, so pkg-node/ is
//     copied next to the bundle instead.
//   * src/lib/signal-persist.ts (IndexedDB) -> file-backed KV.
//   * src/lib/client-name.ts (user agent) -> static 'Console · <os>'.
// import.meta.env is a Vite-ism; defined to {} so auth.ts's optional
// VITE_API_BASE read resolves to undefined instead of throwing.

import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))) // repo root
const cli = path.join(root, 'cli')
const dist = path.join(cli, 'dist')

const shims = {
  'signal-persist': path.join(cli, 'shims', 'signal-persist.ts'),
  'client-name': path.join(cli, 'shims', 'client-name.ts'),
}

const nodeShims = {
  name: 'rcq-node-shims',
  setup(b) {
    b.onResolve({ filter: /signalwasm\/signal_wasm\.js$/ }, () => ({
      path: path.join(cli, 'shims', 'signal-wasm-node.ts'),
    }))
    // Only imports coming FROM src/lib are redirected — the shims must not
    // shim themselves, and cli code imports them by their real path.
    b.onResolve({ filter: /^\.\/(signal-persist|client-name)$/ }, (args) => {
      if (!args.importer.includes(`${path.sep}src${path.sep}lib${path.sep}`)) return null
      return { path: shims[args.path.slice(2)] }
    })
  },
}

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  plugins: [nodeShims],
  define: { 'import.meta.env': '{}' },
  absWorkingDir: root,
  logLevel: 'warning',
}

await build({ ...common, entryPoints: [path.join(cli, 'src', 'main.ts')], outfile: path.join(dist, 'rcq.mjs') })
await build({ ...common, entryPoints: [path.join(cli, 'src', 'crypto-entry.ts')], outfile: path.join(dist, 'crypto-v2.mjs') })
await build({ ...common, entryPoints: [path.join(cli, 'src', 'group-entry.ts')], outfile: path.join(dist, 'group-v1.mjs') })
await build({ ...common, entryPoints: [path.join(cli, 'src', 'blind-token-entry.ts')], outfile: path.join(dist, 'blind-token.mjs') })

// The node glue + its .wasm, next to the bundles (see the header comment).
fs.cpSync(path.join(root, 'crypto-wasm-spike', 'signal-wasm', 'pkg-node'), path.join(dist, 'pkg-node'), {
  recursive: true,
})

console.error(`built ${path.relative(process.cwd(), path.join(dist, 'rcq.mjs'))}`)

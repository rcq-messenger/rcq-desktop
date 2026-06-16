import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'

// chat.rcq.app — web client. Built with the same Vite/React/TS
// stack as the rcq.app landing so configs can be cross-referenced.
// Output goes to dist/, deployed to /var/www/chat on the droplet
// (see deploy/Caddyfile + deploy/deploy-chat.sh).
//
// wasm(): load the vendored libsignal v0.93.1 WASM (src/lib/signalwasm/)
// used by the v=2 (Double Ratchet) crypto path. We deliberately do NOT add
// vite-plugin-top-level-await: it transforms EVERY module in the bundle
// (~+150 KB raw to the main app for boilerplate) and we don't need it —
// the WASM is instantiated via an explicit `await init()` inside a function
// (crypto-v2.ts ensureWasm()), never at module top level.
export default defineConfig({
  plugins: [react(), wasm()],
  build: {
    target: 'es2020',
    sourcemap: false,
    cssMinify: true,
  },
  server: {
    // Local dev: point at production backend so QR-link from a
    // device works against the same data the iOS app sees. Override
    // via VITE_API_BASE in .env.local for local backend.
    port: 5174,
  },
})

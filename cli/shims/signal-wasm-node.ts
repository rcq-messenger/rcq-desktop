// crypto-v2.ts imports the BROWSER wasm-bindgen glue ('./signalwasm/
// signal_wasm.js'), whose default export fetches and instantiates the .wasm
// asynchronously. The nodejs-target build of the same crate
// (crypto-wasm-spike/signal-wasm/pkg-node — the one v2-roundtrip.mjs proved
// under Node) is CJS and instantiates at require() time, reading
// signal_wasm_bg.wasm from disk next to its own __dirname. That is why
// build.mjs copies pkg-node/ into dist/ and this wrapper requires it at
// runtime instead of letting esbuild inline glue that would then look for the
// .wasm in the wrong place.

import { createRequire } from 'node:module'

const req = createRequire(import.meta.url)
// Resolved relative to the BUNDLE (dist/rcq.mjs), not this source file.
const wasm = req('./pkg-node/signal_wasm.js')

export const WasmPrivateKey = wasm.WasmPrivateKey
export const WasmPublicKey = wasm.WasmPublicKey
export const WasmIdentityKeyPair = wasm.WasmIdentityKeyPair
export const WasmProtocolAddress = wasm.WasmProtocolAddress
export const WasmInMemIdentityKeyStore = wasm.WasmInMemIdentityKeyStore
export const WasmInMemSessionStore = wasm.WasmInMemSessionStore
export const WasmInMemPreKeyStore = wasm.WasmInMemPreKeyStore
export const WasmInMemSignedPreKeyStore = wasm.WasmInMemSignedPreKeyStore
export const WasmInMemKyberPreKeyStore = wasm.WasmInMemKyberPreKeyStore
export const generatePreKeys = wasm.generatePreKeys
export const generateSignedPreKey = wasm.generateSignedPreKey
export const generateKyberPreKey = wasm.generateKyberPreKey
export const generateRegistrationId = wasm.generateRegistrationId
export const processPreKeyBundle = wasm.processPreKeyBundle
export const encryptMessage = wasm.encryptMessage
export const decryptMessage = wasm.decryptMessage
// Safety numbers. Present in the crate but never re-exported here, because
// until now no client of this shim asked for one.
export const generateSafetyNumber = wasm.generateSafetyNumber

// The browser default export resolves when instantiation finishes; here that
// already happened inside require(), so only the shape has to match.
export default function init(): Promise<void> {
  return Promise.resolve()
}

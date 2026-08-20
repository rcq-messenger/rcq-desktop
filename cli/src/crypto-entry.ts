// Second bundle entry: the v=2 codec alone, for the fully-offline round-trip
// test (cli/test/roundtrip.mjs). Proves the WASM alias + node shims without
// touching an island.

export * from '../../src/lib/crypto-v2'
export { bytesToB64, b64ToBytes } from '../../src/lib/crypto'

// Sixth bundle entry: the circumvention pieces alone, for the offline test
// (cli/test/routes.mjs). Same purpose as group-entry.ts and vault-entry.ts -
// the pieces that can be proven without a network or an island are proven
// without one, against the BUILT bundle rather than the sources.
//
// What is NOT here, deliberately: `walkLadder` and `ensureRoute`. They engage
// a global fetch and probe real hosts; the honest place to exercise those is a
// censored network, and a test that pretended otherwise would only be testing
// its own stubs.

export {
  buildDnsQuery,
  canonical,
  parseDnsTxt,
  parseJson,
  relays,
  resetForTest,
  verifyAndParse,
} from './relay-config'
export { buildSingBox, fetchBridges } from './singbox'
export { installRouting, loadRoutesState, saveRoutesState, setFrontEngagedForTest } from './routes'

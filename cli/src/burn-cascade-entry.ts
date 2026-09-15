// Bundle entry: the burn cascade's state machine and the order of a burn
// (spec 2026-09-15, F2), for the offline test (cli/test/burn-cascade.mjs). The
// transport and every side effect are injected, so both are proven against the
// BUILT bundle with a fake island, without a browser and without a network,
// like crossisland-gate-entry.ts.

export {
  BURN_CONCURRENCY,
  BURN_DEADLINE_MS,
  MAX_DELETES_PER_ISLAND,
  accountBurnedSignsOut,
  burnResultOk,
  isBurning,
  mergeBurnTargets,
  runRemote,
  sameKeySiblings,
  setBurning,
  setDeletingHome,
} from '../../src/lib/burn-cascade'
export { createBurnFlow } from '../../src/lib/burn-flow'

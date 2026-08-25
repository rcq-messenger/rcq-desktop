// Seventh bundle entry: the state layer alone, for the offline test
// (cli/test/seal.mjs). Same reason as routes-entry.ts — what can be proven
// without a network is proven against the BUILT bundle rather than the
// sources, so the test exercises the code that actually ships.

export {
  appendState,
  isSealed,
  isUnlocked,
  readState,
  readStateLines,
  sealDir,
  sealableFiles,
  stateDir,
  unlockWith,
  unsealDir,
  writeState,
} from './state'

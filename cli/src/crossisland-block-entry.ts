// Bundle entry: the rules behind blocking a sender on another island (reports
// 1064, 1065), for the offline test (cli/test/crossisland-block.mjs). Same
// purpose as member-name-entry.ts: pure, so proven against the BUILT bundle,
// without a browser or an island.

export {
  MAX_TOMBSTONES,
  ackBlockScope,
  ackDecisionAt,
  ackKeys,
  ackStamp,
  activeBlocks,
  addressBlocked,
  blockingEntries,
  decideBlock,
  liftsFor,
  normalizeBlocks,
  senderBlocked,
} from '../../src/lib/crossisland-block-rules'
export { crossIslandGateVerdict } from '../../src/lib/crossisland-gate'

// Bundle entry: the cross-island consent gate (#985(1), the pinned-key check)
// and what a proven UIN move carries (#986(a)), for the offline test
// (cli/test/crossisland-gate.mjs). Same purpose as member-name-entry.ts: both
// are pure, so they are proven against the BUILT bundle, without a browser.

export {
  CONTENT_KINDS,
  FOREIGN_ROOM_DROP,
  carbonIsOwn,
  crossIslandGateVerdict,
  foreignRoomBroadcastDropped,
  isContentKind,
  sameSigningKey,
} from '../../src/lib/crossisland-gate'
export { copyScopedKeys, rekeySenderKeyMaps } from '../../src/lib/move-carry'

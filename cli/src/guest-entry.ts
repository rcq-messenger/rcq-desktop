// Bundle entry: guest copies through a paid or invite door (spec 2026-09-15),
// for the offline tests cli/test/guest-proof.mjs (the `rcq-guest-v1` bytes
// against the server's fixture) and cli/test/guest-path.mjs (the path decision,
// the error mapping, the group-frame drop, and both join paths run against a
// fake island, without a browser and without a network). Same purpose as
// burn-cascade-entry.ts: production code, proven against the BUILT bundle.

export { ed25519 } from '@noble/curves/ed25519'
export {
  GUEST_PROOF_PREFIX,
  GUEST_PROOF_VERSION,
  canonicalGuestHost,
  canonicalKeyB64,
  decodeKey32,
  guestProofBytes,
} from '../../src/lib/guest-proof'
export {
  GUEST_NICKNAME_PLACEHOLDER,
  cardIsStale,
  decideGuestPath,
  groupAddErrorKey,
  guestAddBody,
  guestAttemptVerdict,
  guestJoinBody,
  guestJoinErrorKey,
  guestProfileBody,
  guestRefusalOf,
  guestSettleErrorKey,
  hideAddInRoom,
  lastResidentLeave,
  leaveWarnAfterFetch,
  leaveWarningVerdict,
  legacyGuestRegisterBody,
  legacyNicknameRepairBody,
  memberMarkOf,
  memberProfileHref,
  nameCarriesNumber,
  neutralGuestNickname,
  peerProfileActions,
  profileAddMode,
  profileMarkOf,
  rosterSelfIsGuest,
  rotatedElsewhereRefusal,
  transferGuestErrorKey,
} from '../../src/lib/guest-path'
export {
  GuestJoinError,
  guestCredentialsFor,
  recoverGuestCopy,
  registerGuestLegacy,
  registerGuestOnIsland,
} from '../../src/lib/guest-register'
export { GROUP_FRAME_DROP, groupFrameDropped } from '../../src/lib/crossisland-gate'
// The codec's own list of kind names, so the drop list can be held to the WIRE
// rather than to the prose of the spec (E3).
export { WIRE_KINDS } from '../../src/lib/crypto'
export { doorRefusalOf } from '../../src/lib/backup-pick'
export { GUEST_COPY_NOT_BACKUP, IDENTITY_ROTATED, isIdentityRotated } from '../../src/lib/multihome'
export { ROTATED_ELSEWHERE_EVENT, announceRotatedElsewhere, rotatedUinOf } from '../../src/lib/rotated-signal'
// Every dictionary the app ships, so the test can prove each sentence key the
// mappers return exists in all of them.
export { en } from '../../src/i18n/en'
export { ru } from '../../src/i18n/ru'
export { es } from '../../src/i18n/es'
export { pt } from '../../src/i18n/pt'
export { tr } from '../../src/i18n/tr'
export { uk } from '../../src/i18n/uk'
export { zh } from '../../src/i18n/zh'

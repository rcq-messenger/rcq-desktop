// Fifth bundle entry: the vault client alone, for the fully-offline test
// (cli/test/vault.mjs). Same purpose as group-entry.ts: prove the wiring
// against an in-memory island written to the server's contract
// (rcq-server-ref, test_stage4_vault_local.py) without touching a real one.

export { newTestIdentity } from './group-entry'
export { slotId, seal, open, readSlot, writeSlot, deleteSlot, listSlots, jsonBytes, bytesJson, VaultError, VAULT_CONTACTS } from '../../src/lib/vault'
export { foldServerList } from '../../src/lib/contacts-vault'
// Cross-island contacts (federation Layer B). The merge is the only copy of
// these rows in existence, so it is pure and tested here: cli/test/crossisland.mjs.
export { mergeCrossIsland, canonState } from '../../src/lib/crossisland-vault'
// The sections slot (founder item 1, 23.08). Pure by construction, so the
// merge is tested here rather than in a browser: cli/test/sections.mjs.
export {
  addMembers,
  clampName,
  createSection,
  decode as decodeSections,
  deleteSection,
  dropExpired,
  emptyTree,
  encode as encodeSections,
  forgetMember,
  groupKey,
  memberIndex,
  membersOf,
  merge as mergeSections,
  newSectionId,
  orderedSections,
  orderOf,
  peerKey,
  removeMemberFrom,
  renameSection,
  sameContent,
  SectionsError,
  setOrder,
  setPinned,
  totalMembers,
  userSections,
  MAX_MEMBERS_PER_SECTION,
  MAX_SECTIONS,
} from '../../src/lib/sections'
export { ApiError } from '../../src/lib/api'

// Guest cards (closed islands). The digest here MUST equal the island's
// `models/guest_card.hash_card`, or a card registered by a client opens
// nothing. cli/test/guest-card.mjs pins it against the Python.
export { hashCard, newCard } from '../../src/lib/guest-card'

// The contact link, so the guest-card test can prove the card lands in the
// fragment and never in the query. Same bundle as hashCard, so one import.
export { buildContactLink, parseContactLink } from '../../src/lib/federation'

export { mergeCards } from '../../src/lib/guestcard-vault'

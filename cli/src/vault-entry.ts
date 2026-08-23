// Fifth bundle entry: the vault client alone, for the fully-offline test
// (cli/test/vault.mjs). Same purpose as group-entry.ts: prove the wiring
// against an in-memory island written to the server's contract
// (rcq-server-ref, test_stage4_vault_local.py) without touching a real one.

export { newTestIdentity } from './group-entry'
export { slotId, seal, open, readSlot, writeSlot, deleteSlot, listSlots, jsonBytes, bytesJson, VaultError, VAULT_CONTACTS } from '../../src/lib/vault'
export { foldServerList } from '../../src/lib/contacts-vault'
export { ApiError } from '../../src/lib/api'

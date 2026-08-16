// The desktop PIN, page side. The vault itself is in src-tauri/src/vault.rs.
//
// The division of labour: Rust owns the file and the key, this module owns
// WHAT goes in — the account rows that normally sit in localStorage. While a
// PIN is set, those rows never touch the webview's storage at all; they are
// held in memory for the life of the window and written back to the vault,
// sealed, whenever they change.
//
// ⚠ Desktop only, and deliberately. In a browser tab there is nowhere to put
// a secret that the page itself cannot reach, so a PIN there would protect
// nothing and claim to protect everything (docs/web-storage-inventory.md).

import { isTauri } from './desktop'

export interface VaultState {
  exists: boolean
  unlocked: boolean
  failures: number
  cooldown: number
}

/// Does this build even have a vault? Only the Tauri shell does.
export function vaultSupported(): boolean {
  return isTauri()
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

export async function vaultState(): Promise<VaultState> {
  if (!isTauri()) return { exists: false, unlocked: false, failures: 0, cooldown: 0 }
  try {
    return await call<VaultState>('vault_state')
  } catch {
    return { exists: false, unlocked: false, failures: 0, cooldown: 0 }
  }
}

/// Set a PIN: seal `plaintext` and leave the session unlocked.
export async function vaultCreate(pin: string, plaintext: string): Promise<void> {
  await call<void>('vault_create', { pin, plaintext })
}

/// Type the PIN. Returns the payload, or throws a coded string:
/// `wrong_pin`, `locked_out:<seconds>`, `no_vault`, `corrupt_vault`.
export async function vaultUnlock(pin: string): Promise<string> {
  return call<string>('vault_unlock', { pin })
}

/// Re-seal after a change. No PIN — the session is already unlocked.
export async function vaultWrite(plaintext: string): Promise<void> {
  await call<void>('vault_write', { plaintext })
}

/// Forget the key. The next start (or the next unlock) asks for the PIN again.
export async function vaultLock(): Promise<void> {
  try {
    await call<void>('vault_lock')
  } catch {
    /* not desktop, or already locked */
  }
}

/// Turn the PIN off, handing back what was inside.
export async function vaultRemove(pin: string): Promise<string> {
  return call<string>('vault_remove', { pin })
}

/// Whether calls must ride the relay, and why the default is on.
///
/// ⚠ WebRTC opens its own sockets, outside everything else this app routes. A
/// direct call therefore hands the other side your real address before a word
/// is spoken, and no privacy setting elsewhere can prevent it. Relaying costs
/// bandwidth and a little latency; being findable costs more.
///
/// ★ It became a SETTING because it was previously forced, silently: the web
/// and desktop clients demanded relay-only whenever a relay could be reached,
/// with no way to trade the address for a better line. The phones have had the
/// choice since 0.108 and this is the same one, worded the same way.
///
/// Device-local (not per account, not on the island): it is a property of the
/// machine you are calling from.

import { scopedKey } from './account-scope'

const KEY = 'rcq.call.alwaysRelay'

export function alwaysRelay(): boolean {
  // Default ON, so a fresh browser is private before anyone touches settings.
  return localStorage.getItem(KEY) !== '0'
}

export function setAlwaysRelay(on: boolean): void {
  localStorage.setItem(KEY, on ? '1' : '0')
}

/// ── who may call me ─────────────────────────────────────────────────────────
///
/// A device-local MIRROR of the island's `call_policy`, kept for the one
/// question a client has to answer on its own: may this number leave me a
/// missed-call marker (§5d `call_missed`)?
///
/// ⚠⚠ A mirror, never the source of truth. The island is what actually
/// enforces `call_policy`, and it does so on the websocket `call_offer` path
/// (`_caller_allowed` in `routers/ws.py`), which a marker never goes near,
/// because a marker is an ordinary sealed deposit that any number can compose.
/// So the receiver asks the same question here. Stale in the permissive
/// direction costs one row the island would have refused; the enforcement that
/// matters is still the island's, on the path a real call takes.
///
/// Unscoped historically (it predates `account-scope`), so it is read through
/// the account scope now and falls back to the flat key one last time for a
/// browser that wrote the old one.
const POLICY_KEY = () => scopedKey('privacy.callPolicy')
const LEGACY_POLICY_KEY = 'rcq.privacy.callPolicy'

export type CallPolicy = 'everyone' | 'contacts' | 'nobody'

function coercePolicy(raw: string | null | undefined): CallPolicy | null {
  return raw === 'everyone' || raw === 'contacts' || raw === 'nobody' ? raw : null
}

/// Defaults to "everyone", matching the island's default for a fresh account.
export function myCallPolicy(): CallPolicy {
  return (
    coercePolicy(localStorage.getItem(POLICY_KEY())) ??
    coercePolicy(localStorage.getItem(LEGACY_POLICY_KEY)) ??
    'everyone'
  )
}

export function setMyCallPolicy(policy: CallPolicy): void {
  localStorage.setItem(POLICY_KEY(), policy)
}

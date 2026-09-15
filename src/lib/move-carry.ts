// What a UIN move carries from the old number to the new one, on its own.
//
// Pure: storage is passed in, nothing here reads a global, so both halves are
// proven offline against the built bundle (cli/test/crossisland-gate.mjs).
//
// ⚠⚠ Called ONLY once the island has proven the move: the migrate response
// (took a number, or switched to one already held) or `moved_from` answered
// by /auth/refresh. Never on a socket frame. A frame can say "you moved" but
// it proves nothing about where to, and copying one account's local state into
// another number's namespace on its say-so is the shape of the 08.31 leak.

/// The slice of `Storage` this needs. `localStorage` satisfies it; the test
/// passes a Map-backed stub.
export interface KeyValueStore {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function validUin(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0
}

/// #986(a) on web/desktop: copy every `rcq.web.<old>.*` key to
/// `rcq.web.<new>.*`.
///
/// Every local store is scoped by UIN (account-scope.ts), and a move used to
/// save the new {uin, jwt} and reload. After the reload the visited islands,
/// the foreign-group aliases, the backup islands, the cross-island contacts and
/// the message requests were all read under the new number, where nothing had
/// ever been written. With no visited islands the guest poll returns at once,
/// so the group on the other island was never drained again and vanished.
///
/// COPIES, and never overwrites a key the new number already holds: the same
/// rule migrateFlatDataInto follows, for the same reason. A target that exists
/// is newer than a copy of the old world, and the originals staying put means a
/// copy that went wrong has lost nothing. Returns how many keys were written.
///
/// The keys are collected first and written after: writing while walking
/// `key(i)` would shift the indices under the loop.
export function copyScopedKeys(storage: KeyValueStore, oldUin: number, newUin: number): number {
  if (!validUin(oldUin) || !validUin(newUin) || oldUin === newUin) return 0
  // The trailing dot is load-bearing: `rcq.web.12.` must not match `rcq.web.123.`.
  const from = `rcq.web.${oldUin}.`
  const to = `rcq.web.${newUin}.`
  const found: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i)
    if (k && k.startsWith(from)) found.push(k)
  }
  let written = 0
  for (const k of found) {
    const v = storage.getItem(k)
    if (v == null) continue
    const target = to + k.slice(from.length)
    if (storage.getItem(target) != null) continue
    storage.setItem(target, v)
    written++
  }
  return written
}

/// The on-disk shape of sender-key-store.ts (v3), as far as re-keying needs it.
export interface SenderKeyMaps {
  out: Record<string, unknown>
  in: Record<string, unknown>
  owned: string[]
}

function rekeyRecord(map: Record<string, unknown>, from: string, to: string): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  // Entries that already belong to the new number stay exactly as they are,
  // and win over a moved copy: they were written by this account after the
  // move, which makes them newer.
  for (const [k, v] of Object.entries(map)) {
    if (!k.startsWith(from)) next[k] = v
  }
  for (const [k, v] of Object.entries(map)) {
    if (!k.startsWith(from)) continue
    const target = to + k.slice(from.length)
    if (!(target in next)) next[target] = v
  }
  return next
}

/// Inbound chains and own kids filed under `<old>:` move to `<new>:`; own
/// OUTBOUND chains under `<old>:` are dropped.
///
/// Inbound chains are keyed by the account's own number, including for rooms
/// on another island (the chains arrive through the guest drains but are filed
/// under the home account). After a move every broadcast then named a kid this
/// account "did not know", was held, and asked for a re-send the senders never
/// make on their own, because on their island our guest number did not change.
/// Rooms stayed dark for hours.
///
/// ⚠⚠ The own outbound chains are the exception, and carrying them would put
/// words in a dead number's mouth. Every member bound our kid to the number
/// that sent its key message, which is the OLD one, and names the author of a
/// broadcast from that binding, not from anything in the broadcast. A carried
/// chain keeps its kid (a rotation happens only when a member leaves), so the
/// first post after the move would show up everywhere as written by the number
/// we just gave back to stock, and by whoever buys it next. Dropped, the next
/// post rotates a fresh kid and sends its key message as the new number. The
/// island does not touch sender keys on a move, so nothing else would. (Rooms
/// on another island are not affected either way: there we post under our
/// guest number, whose chains are filed under that number.) Android's
/// rekeyAccount drops them for the same reason.
///
/// MOVED rather than copied, unlike the scoped keys above. These maps are not
/// namespaced storage but one shared object, and `ownsKid` answers per number:
/// left under the old number they would make whoever holds that number in this
/// browser next read this account's kids as their own echo and drop them, the
/// 2026-08-21 bug. The chains were accepted from signed key messages bound to
/// their senders' keys, so moving them grants no trust they did not have.
export function rekeySenderKeyMaps(store: SenderKeyMaps, oldUin: number, newUin: number): SenderKeyMaps {
  if (!validUin(oldUin) || !validUin(newUin) || oldUin === newUin) return store
  const from = `${oldUin}:`
  const to = `${newUin}:`
  const owned: string[] = []
  const seen = new Set<string>()
  for (const k of store.owned) {
    const moved = k.startsWith(from) ? to + k.slice(from.length) : k
    if (seen.has(moved)) continue
    seen.add(moved)
    owned.push(moved)
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(store.out)) {
    if (!k.startsWith(from)) out[k] = v
  }
  return {
    out,
    in: rekeyRecord(store.in, from, to),
    owned,
  }
}

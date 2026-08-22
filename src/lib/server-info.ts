// What an island says about itself: its name, its house rules, and which
// optional surfaces it runs (GET /server/info, unauthenticated).
//
// The phones have read this since islands existed; the web never asked at all.
// So an operator could type an island name and a rules text into the admin
// panel and see neither of them anywhere in a browser or on the desktop, and a
// self-hoster who closed the report desk still had both report entries staring
// at their members — a form that answers 403 and a screen that stays empty.
//
// ⚠ ASK FOR EVERY ISLAND, including our own. Android skipped the request for
// the default host and that is exactly how the flagship's own name and rules
// became unreachable (its BRANDING bug): the flagship is an island too, with
// the same two fields in the same admin panel.
//
// React-free on purpose: the key-lookup path (signal-device.ts) reads the
// capabilities too, and that module is bundled into the CLI, which must not
// drag React along. The hooks live in use-server-info.ts.

/// Optional surfaces an island may switch off. Defaults are PERMISSIVE, on
/// purpose and in two directions: an older island that predates a flag keeps
/// the surface visible, and so does a live island whose /server/info has not
/// landed yet. Hiding first and asking later would blink a menu on every open.
///
/// ⚠ `envelope_class` defaults to FALSE, as `uin_shop` and `hall_of_fame` do
/// below, though for a different reason: those two are surfaces that exist on
/// the flagship and nowhere else, while this one is not a
/// surface but a wire ability: the island understands `cls` and the `ring`
/// flag on a sealed deposit (core-metadata plan, Stage 2). The flag was born
/// together with `ring`, so an island that omits it is an island that does not
/// know `ring`, and assuming otherwise would leave a cross-island call silent
/// on a closed phone. The call path (`crossisland-call.ts`) reads it to decide
/// whether the quieter Stage 2 deposit will actually wake the peer.
///
/// ⚠ `anon_keys` and `deposit_auth` default to FALSE for the same reason: they
/// are wire abilities, not surfaces. `anon_keys` says the island serves the
/// three key lookups (`/keys/{uin}/devices`, `/keys/{uin}/bundle`,
/// `/keys/{uin}/devices/{id}/bundle`) without a session token (core-metadata
/// plan, Stage 3); `deposit_auth` says it issues the anonymous deposit tokens a
/// bundle fetch then pays with. Only when BOTH are true does the key-lookup
/// path (signal-device.ts) stop naming itself; an island that lacks either
/// still gets the legacy authenticated request, never a half-anonymous one.
///
/// ⚠ `hood` and `stories` used to live here. Both surfaces were deleted from
/// the server (routers, tables and flags), so no island answers with them any
/// more and no client has anything left to gate. An unknown key in the
/// capabilities object is ignored by `normalize` below, so an island that has
/// not been updated yet is harmless: it sends two booleans nobody reads.
export interface ServerCapabilities {
  uin_shop: boolean
  hall_of_fame: boolean
  registration_policy: string
  nearby: boolean
  random_chat: boolean
  reports: boolean
  max_accounts_per_device: number
  envelope_class: boolean
  anon_keys: boolean
  deposit_auth: boolean
}

export interface ServerInfo {
  name: string
  welcome: string
  capabilities: ServerCapabilities
}

/// Mirrors Android's `ServerCapabilities` defaults (net/RcqApi.kt) field for
/// field. uin_shop and hall_of_fame default OFF because a self-host island that
/// says nothing runs neither; everything else defaults ON, except
/// `envelope_class`, `anon_keys` and `deposit_auth` (see the interface
/// comment: absent means the island predates that stage).
export const DEFAULT_CAPABILITIES: ServerCapabilities = {
  uin_shop: false,
  hall_of_fame: false,
  registration_policy: 'open',
  nearby: true,
  random_chat: true,
  reports: true,
  max_accounts_per_device: 5,
  envelope_class: false,
  anon_keys: false,
  deposit_auth: false,
}

/// One in-flight request per island, and one answer kept for the run. This is
/// read by every settings render and it is a network call on a screen people
/// scroll; without the cache, opening settings twice asks twice.
const cache = new Map<string, Promise<ServerInfo | null>>()

/// The flags that are plain on/off, as opposed to the policy string and the
/// account cap. Spelled out so the fallback below is typed as a boolean.
type BoolCapability =
  | 'uin_shop'
  | 'hall_of_fame'
  | 'nearby'
  | 'random_chat'
  | 'reports'
  | 'envelope_class'
  | 'anon_keys'
  | 'deposit_auth'

function normalize(raw: unknown): ServerInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const caps = (o.capabilities ?? {}) as Record<string, unknown>
  const bool = (k: BoolCapability): boolean =>
    typeof caps[k] === 'boolean' ? (caps[k] as boolean) : DEFAULT_CAPABILITIES[k]
  return {
    name: typeof o.name === 'string' ? o.name : '',
    welcome: typeof o.welcome === 'string' ? o.welcome : '',
    capabilities: {
      uin_shop: bool('uin_shop'),
      hall_of_fame: bool('hall_of_fame'),
      registration_policy:
        typeof caps.registration_policy === 'string'
          ? caps.registration_policy
          : DEFAULT_CAPABILITIES.registration_policy,
      nearby: bool('nearby'),
      random_chat: bool('random_chat'),
      reports: bool('reports'),
      max_accounts_per_device:
        typeof caps.max_accounts_per_device === 'number'
          ? caps.max_accounts_per_device
          : DEFAULT_CAPABILITIES.max_accounts_per_device,
      envelope_class: bool('envelope_class'),
      anon_keys: bool('anon_keys'),
      deposit_auth: bool('deposit_auth'),
    },
  }
}

/// One uncached GET /server/info, the request `fetchServerInfo` wraps in its
/// run-long cache. Exposed for callers that keep their own, shorter-lived
/// memory of the answer (the cross-island call path, which must re-ask an
/// island that said "no" a few minutes later in case it has been upgraded),
/// so that the shape of the answer is parsed in exactly one place. `init` is
/// for an abort signal; the GET itself stays unauthenticated plain `fetch`.
export async function loadServerInfo(apiBase: string, init?: RequestInit): Promise<ServerInfo | null> {
  try {
    const res = await fetch(`${apiBase}/server/info`, init)
    if (!res.ok) return null
    return normalize(await res.json())
  } catch {
    return null
  }
}

/// Ask an island who it is. Never throws and never signs anybody out: this is
/// an unauthenticated GET made with plain `fetch`, deliberately NOT the authed
/// `request()` helper, whose 401 path ends the session. An island that is down,
/// blocked or older than the endpoint simply answers `null` and every caller
/// falls back to the permissive defaults.
export function fetchServerInfo(apiBase: string): Promise<ServerInfo | null> {
  const hit = cache.get(apiBase)
  if (hit) return hit
  const p = loadServerInfo(apiBase)
  cache.set(apiBase, p)
  // A failure is not worth remembering for the whole run — the island may be
  // one reconnect away — but a success is.
  void p.then((info) => {
    if (!info) cache.delete(apiBase)
  })
  return p
}

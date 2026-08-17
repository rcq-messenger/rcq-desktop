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

import { useEffect, useState } from 'react'

/// Optional surfaces an island may switch off. Defaults are PERMISSIVE, on
/// purpose and in two directions: an older island that predates a flag keeps
/// the surface visible, and so does a live island whose /server/info has not
/// landed yet. Hiding first and asking later would blink a menu on every open.
export interface ServerCapabilities {
  uin_shop: boolean
  hall_of_fame: boolean
  registration_policy: string
  nearby: boolean
  random_chat: boolean
  hood: boolean
  stories: boolean
  reports: boolean
  max_accounts_per_device: number
}

export interface ServerInfo {
  name: string
  welcome: string
  capabilities: ServerCapabilities
}

/// Mirrors Android's `ServerCapabilities` defaults (net/RcqApi.kt) field for
/// field. uin_shop and hall_of_fame default OFF because a self-host island that
/// says nothing runs neither; everything else defaults ON.
export const DEFAULT_CAPABILITIES: ServerCapabilities = {
  uin_shop: false,
  hall_of_fame: false,
  registration_policy: 'open',
  nearby: true,
  random_chat: true,
  hood: true,
  stories: true,
  reports: true,
  max_accounts_per_device: 5,
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
  | 'hood'
  | 'stories'
  | 'reports'

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
      hood: bool('hood'),
      stories: bool('stories'),
      reports: bool('reports'),
      max_accounts_per_device:
        typeof caps.max_accounts_per_device === 'number'
          ? caps.max_accounts_per_device
          : DEFAULT_CAPABILITIES.max_accounts_per_device,
    },
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
  const p = (async () => {
    try {
      const res = await fetch(`${apiBase}/server/info`)
      if (!res.ok) return null
      return normalize(await res.json())
    } catch {
      return null
    }
  })()
  cache.set(apiBase, p)
  // A failure is not worth remembering for the whole run — the island may be
  // one reconnect away — but a success is.
  void p.then((info) => {
    if (!info) cache.delete(apiBase)
  })
  return p
}

/// `null` while the answer is in flight or the island did not give one.
export function useServerInfo(apiBase: string | undefined): ServerInfo | null {
  const [info, setInfo] = useState<ServerInfo | null>(null)
  useEffect(() => {
    if (!apiBase) {
      setInfo(null)
      return
    }
    let live = true
    void fetchServerInfo(apiBase).then((v) => {
      if (live) setInfo(v)
    })
    return () => {
      live = false
    }
  }, [apiBase])
  return info
}

/// The capabilities with every gap filled, so a caller can write
/// `caps.reports` without repeating the permissive-default reasoning.
export function useServerCapabilities(apiBase: string | undefined): ServerCapabilities {
  return useServerInfo(apiBase)?.capabilities ?? DEFAULT_CAPABILITIES
}

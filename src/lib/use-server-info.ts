// The React side of server-info.ts: a hook per screen that needs an island's
// name, rules or capabilities. Kept apart from the fetch and the parsing so
// that a non-React caller (the key-lookup path, which the CLI bundles) can
// read the same answer without pulling React into a node bundle.

import { useEffect, useState } from 'react'
import { islandCard, type IslandCard } from './island-card'
import { DEFAULT_CAPABILITIES, fetchServerInfo, type ServerCapabilities, type ServerInfo } from './server-info'

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

/// How an island should be DRAWN: its name and which logo it is on, complete on
/// the first frame and corrected when the island answers.
///
/// Two sources, in this order, and both are needed. The persisted card
/// (`island-card.ts`) is what makes a login screen and an account list complete
/// on their first paint instead of after a round trip. The live fetch is what
/// makes them right: without it a name typed in the admin panel five minutes
/// ago would not appear until the page was reloaded twice, which is exactly the
/// half-fix the raw cache read shipped as for one afternoon.
export function useIslandCard(apiBase: string | undefined): IslandCard {
  const live = useServerInfo(apiBase)
  const cached = islandCard(apiBase)
  return {
    name: live?.name || cached?.name || '',
    logoVersion: live?.logoVersion ?? cached?.logoVersion ?? '',
  }
}

// The React side of server-info.ts: a hook per screen that needs an island's
// name, rules or capabilities. Kept apart from the fetch and the parsing so
// that a non-React caller (the key-lookup path, which the CLI bundles) can
// read the same answer without pulling React into a node bundle.

import { useEffect, useState } from 'react'
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

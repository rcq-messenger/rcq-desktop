// Host-aware default landing route. The same SPA build serves both
// chat.rcq.app and market.rcq.app; on the market subdomain a logged-in
// visitor boots straight into the UIN market, everywhere else into the
// contact list.

export function isMarketHost(): boolean {
  return typeof window !== 'undefined' && window.location.hostname.startsWith('market.')
}

export function defaultHome(): string {
  // On market.rcq.app the market lives at the ROOT ('/'), not '/market' —
  // that subdomain IS the market (no chat surface, no /market path).
  return isMarketHost() ? '/' : '/contacts'
}

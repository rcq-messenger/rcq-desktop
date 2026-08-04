// Where a signed-in visitor lands.
//
// This used to be host-aware: the same build served chat.rcq.app and
// market.rcq.app, and the market subdomain booted straight into the shop. That
// arrangement is gone — two hosts meant two ORIGINS, and localStorage is
// per-origin, so an account signed in on both had two independent copies of
// its identity and signing out of one left the other running. The market is a
// screen of the app now (`/market`), and market.rcq.app only forwards here
// (see main.tsx).

export function defaultHome(): string {
  return '/contacts'
}

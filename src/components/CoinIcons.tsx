// The two coins we can actually take, drawn rather than fetched.
//
// ⚠ Inline SVG on purpose. A payment picker is the last place to load an image
// from somebody else's server: a remote icon is a request that says "this
// person is about to pay, from this address, right now", which is exactly the
// kind of thing the rest of this app spends its effort not emitting. These are
// a few hundred bytes each and they ship in the bundle.
//
// They are geometric renditions in each coin's own colour, enough to be
// recognised at 20px next to the name, and they take `className` so the caller
// sizes them.

export function UsdtIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#26A17B" />
      {/* The ₮: a bar across the top, a stem down the middle, and the ellipse
          that makes it Tether's mark rather than a letter T. */}
      <path
        fill="#fff"
        d="M13.42 10.62v-1.6h3.66V6.58H6.93v2.44h3.66v1.6C7.6 10.76 5.36 11.35 5.36 12.06
           c0 .7 2.24 1.3 5.23 1.44v4.62h2.83v-4.62c2.98-.14 5.22-.74 5.22-1.44
           c0-.71-2.24-1.3-5.22-1.44Zm0 2.44v-.01c-.08 0-.47.03-1.35.03-.7 0-1.2-.02-1.38-.03v.01
           c-2.4-.11-4.19-.53-4.19-1.03 0-.5 1.79-.92 4.19-1.03v1.63c.18.01.7.04 1.39.04
           .84 0 1.26-.03 1.34-.04v-1.63c2.39.11 4.18.53 4.18 1.03 0 .5-1.79.92-4.18 1.03Z"
      />
    </svg>
  )
}

export function TonIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#0098EA" />
      {/* The gem: two faces meeting at a point, the shape TON uses. */}
      <path
        fill="#fff"
        d="M16.94 6.5H7.06c-1.02 0-1.67 1.1-1.16 1.99l5.22 9.06c.22.39.78.39 1 0l5.22-9.06
           c.51-.89-.14-1.99-1.16-1.99h-.24Zm-5.42 8.4L10.4 12.6 8.06 8.68a.29.29 0 0 1 .25-.44h3.21v6.66Z
           m4.16-6.22-2.34 3.92-1.12 2.3V8.24h3.21c.24 0 .38.24.25.44Z"
      />
    </svg>
  )
}

/// Pick the mark for a chain id the till reports (`tron`, `ton`). Unknown ids
/// get nothing rather than a wrong coin's colours.
export function CoinIcon({ chain, className }: { chain: string; className?: string }) {
  if (chain === 'tron') return <UsdtIcon className={className} />
  if (chain === 'ton') return <TonIcon className={className} />
  return null
}

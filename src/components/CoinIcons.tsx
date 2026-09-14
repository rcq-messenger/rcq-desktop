// The coins we can actually take, drawn rather than fetched.
//
// ⚠ TWO COPIES: this file and RCQ/web/src/components/CoinIcons.tsx. The site
// and the chat app are separate builds with nothing shared between them, so
// the marks are duplicated rather than imported. Keep both in sync: a coin
// that looks different on rcq.app and in the app reads as a different coin.
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

/// Polygon, switched on 13.09 for entry, numbers and the relay pools. The
/// token is USDT or USDC, but the button says which CHAIN it is paid on,
/// because that is the choice the buyer is making and the one they can get
/// wrong: the same dollars on the wrong network are gone. Hence the chain's
/// own purple and its hexagon rather than a second green Tether mark, which
/// would sit one row under the TRON one and differ by nothing but a word.
export function PolygonIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#8247E5" />
      <path
        d="M12 5.6l5.2 3v6l-5.2 3-5.2-3v-6l5.2-3z"
        fill="none"
        stroke="#fff"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M12 9.2l2.6 1.5v3L12 15.2l-2.6-1.5v-3L12 9.2z" fill="#fff" />
    </svg>
  )
}

/// Bitcoin, which only the relay-pool checkout on rcq.app offers, and only for
/// totals of $100 or more. Entry and numbers refuse it at the till, so in the
/// chat app this case is never reached; it is here so the two copies stay one
/// file.
export function BtcIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#F7931A" />
      {/* The ₿: a B with two strokes through the top and the bottom, leaning
          the way the mark leans. The counters are cut with evenodd; the
          strokes are a separate path so they do not cut the B where they
          meet it. */}
      <g fill="#fff" transform="rotate(14 12 12) translate(-0.75 0.5)">
        <path
          fillRule="evenodd"
          d="M9 6.5h4c1.8 0 3 1 3 2.6 0 1-.5 1.7-1.3 2.1 1.1.4 1.8 1.2 1.8 2.5 0 1.8-1.3 2.8-3.3 2.8H9Z
             M10.9 8.1v2.9h1.9c.9 0 1.5-.5 1.5-1.45 0-.95-.6-1.45-1.5-1.45Z
             M10.9 12.5v2.4h2.2c1 0 1.7-.55 1.7-1.2 0-.65-.7-1.2-1.7-1.2Z"
        />
        <path d="M10.4 4.8h1.1v1.7h-1.1Zm2.2 0h1.1v1.7h-1.1ZM10.4 16.5h1.1v1.7h-1.1Zm2.2 0h1.1v1.7h-1.1Z" />
      </g>
    </svg>
  )
}

/// Pick the mark for a chain id the till reports (`tron`, `ton`, `polygon`,
/// `btc`). Unknown ids get nothing rather than a wrong coin's colours.
export function CoinIcon({ chain, className }: { chain: string; className?: string }) {
  if (chain === 'tron') return <UsdtIcon className={className} />
  if (chain === 'ton') return <TonIcon className={className} />
  if (chain === 'polygon') return <PolygonIcon className={className} />
  if (chain === 'btc') return <BtcIcon className={className} />
  return null
}

import { useEffect, useState } from 'react'

/// Two pieces of text that take turns in one line.
///
/// Used where a line has room for one thing and two things worth saying: the
/// chat header (the number and when they were last around) and the contact row
/// (when they were last around and the status message they left).
///
/// ⚠⚠ The two halves must not fade AT THE SAME TIME. Stacked in one grid cell
/// and animated together, they each sit at half opacity for half a second, and
/// because the second child paints ABOVE the first, its fade-out lingers over
/// the arriving text. That reads as a lag in one direction only, which is
/// exactly how it was reported on web and desktop. So the outgoing half always
/// goes first and the incoming one waits for it, and the swap looks the same
/// both ways.
///
/// ⚠ Both children stay mounted in the one cell, so the line's box never
/// changes size mid-swap and nothing above it moves.
export function AltText({
  a,
  b,
  periodMs = 4000,
  fadeMs = 500,
  className = '',
}: {
  a: React.ReactNode
  b: React.ReactNode
  periodMs?: number
  fadeMs?: number
  className?: string
}) {
  const [alt, setAlt] = useState(false)
  useEffect(() => {
    const id = setInterval(() => setAlt((v) => !v), periodMs)
    return () => clearInterval(id)
  }, [periodMs])
  return (
    <span className={'grid min-w-0 ' + className}>
      <span
        className="col-start-1 row-start-1 truncate transition-opacity"
        style={{
          opacity: alt ? 0 : 1,
          transitionDuration: `${fadeMs}ms`,
          transitionDelay: alt ? '0ms' : `${fadeMs}ms`,
        }}
      >
        {a}
      </span>
      <span
        className="col-start-1 row-start-1 truncate transition-opacity"
        style={{
          opacity: alt ? 1 : 0,
          transitionDuration: `${fadeMs}ms`,
          transitionDelay: alt ? `${fadeMs}ms` : '0ms',
        }}
      >
        {b}
      </span>
    </span>
  )
}

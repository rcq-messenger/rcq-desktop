// Brand mark. Single img referencing /logo.png in public/. Sized via
// the `size` prop so headers, login splash and favicon-shaped slots
// can share one component.

interface Props {
  size?: number
  className?: string
  /// Spin the mark — our brand mark, continuously. Matches iOS
  /// (`LogoMark(spinning:)`): a linear 360° rotation every 30s, always
  /// on (not a busy-only indicator).
  spin?: boolean
}

export function Logo({ size = 48, className = '', spin = false }: Props) {
  return (
    <img
      src="/logo.png"
      alt="RCQ"
      width={size}
      height={size}
      className={`${spin ? 'animate-spin' : ''} ${className}`.trim()}
      // iOS uses linear 30s/rotation, autoreverses off. animate-spin is
      // linear 360° infinite; we just slow it to 30s to match.
      style={{ display: 'block', ...(spin ? { animationDuration: '30s' } : {}) }}
    />
  )
}

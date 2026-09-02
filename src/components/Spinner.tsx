/**
 * The one loading indicator (megalist B7). Pages used to greet a slow fetch
 * with a small grey "Загружаем…" line pinned to the top of the content area,
 * which read as a stuck header rather than as progress. Every page-level
 * pending state now shows THIS spinner, centered — the same ring the PIN
 * gate's unlock overlay draws, so waiting looks identical everywhere.
 */
export function Spinner({ size = 28, label }: { size?: number; label?: string }) {
  return (
    <span
      role="status"
      // A bare role=status ring is silent to a screen reader; a page that
      // replaced a "Loading…" line with this ring hands the word in here.
      aria-label={label}
      className="block rounded-full border-2 border-line border-t-accent animate-spin"
      style={{ width: size, height: size }}
    />
  )
}

/** A page/section pending state: the spinner, centered in generous air. */
export function CenteredLoader({ className = 'py-16', label }: { className?: string; label?: string }) {
  return (
    <div className={`flex justify-center items-center ${className}`}>
      <Spinner label={label} />
    </div>
  )
}

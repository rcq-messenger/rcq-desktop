/// The mark beside a settings heading (founder, 02.09: "у категорий слева от
/// названия должна быть соответствующая иконка").
///
/// Hand-drawn rather than pulled from an icon set: the app ships no icon
/// dependency, every other glyph here is a 24-box stroke path, and eighteen
/// small paths weigh less than any library's tree-shaken import. They inherit
/// `currentColor`, so a heading's colour carries its icon with it.

const PATHS: Record<string, React.ReactNode> = {
  // A person.
  profile: <><circle cx="12" cy="8" r="3.4" /><path d="M5.5 20a6.5 6.5 0 0 1 13 0" /></>,
  // A card with a number on it.
  account: <><rect x="3" y="5.5" width="18" height="13" rx="2.2" /><path d="M7 10.5h4M7 14h7" /></>,
  // The corners of a QR code.
  qr: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><path d="M14 14h2.5v2.5M20 14v6h-6" /></>,
  // A server: where the account lives.
  island: <><rect x="3" y="4.5" width="18" height="6" rx="2" /><rect x="3" y="13.5" width="18" height="6" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>,
  // A phone beside a laptop.
  devices: <><rect x="3" y="6" width="9" height="12" rx="2" /><path d="M15 8h6v7h-6zM14 19h8" /></>,
  // One account, two islands.
  multihome: <><circle cx="6.5" cy="12" r="2.5" /><circle cx="17.5" cy="12" r="2.5" /><path d="M9 12h6" /></>,
  // An eye with a line through it.
  privacy: <><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z" /><path d="M4 4l16 16" /></>,
  // A globe.
  language: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17" /></>,
  // Half a circle filled: light and dark.
  theme: <><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17Z" fill="currentColor" stroke="none" /></>,
  // Two letters, one larger.
  textsize: <><path d="M3 18l4.5-11L12 18M4.6 14.5h5.8" /><path d="M14 18l3.2-7.5L20.4 18M14.9 15.7h4.6" /></>,
  // A screen with a slider.
  display: <><rect x="3" y="4.5" width="18" height="12" rx="2" /><path d="M8 20h8M12 16.5V20" /></>,
  // A speaker.
  sound: <><path d="M5 9.5h3l4-3.5v12l-4-3.5H5z" /><path d="M16 9.2a4 4 0 0 1 0 5.6" /></>,
  // A star: the hall of fame.
  hof: <><path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 9.7l5.4-.8z" /></>,
  // A bug.
  report: <><rect x="8" y="8" width="8" height="11" rx="4" /><path d="M4.5 11h3.5M16 11h3.5M4.5 17h3.5M16 17h3.5M9.5 6l1.5 2M14.5 6L13 8" /></>,
  // A shield: getting through.
  bypass: <><path d="M12 3.5l7 2.6v6c0 4.2-2.9 7-7 8.4-4.1-1.4-7-4.2-7-8.4v-6z" /></>,
  // An i in a circle.
  about: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5M12 7.8h.01" /></>,
  // A door with an arrow out of it.
  session: <><path d="M14 4.5H6.5a1.5 1.5 0 0 0-1.5 1.5v12a1.5 1.5 0 0 0 1.5 1.5H14" /><path d="M17.5 8.5 21 12l-3.5 3.5M10 12h11" /></>,
  // A bin.
  danger: <><path d="M5 7h14M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7" /><path d="M6.5 7l.8 12a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5l.8-12" /></>,
  // The categories on the front page of Settings (founder, 02.09). Some reuse
  // a section's drawing; those that have no section of their own get theirs.
  appearance: <><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17Z" fill="currentColor" stroke="none" /></>,
  community: <><circle cx="9" cy="9.5" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><circle cx="17" cy="8" r="2.2" /><path d="M15 14.6a4.6 4.6 0 0 1 5.5 3.4" /></>,
}

export function SettingsSectionIcon({ name, size = 14 }: { name: string; size?: number }) {
  const d = PATHS[name]
  // A heading whose key is not in the table keeps its old shape rather than
  // reserving an empty square beside it.
  if (!d) return null
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-none opacity-80"
      aria-hidden
    >
      {d}
    </svg>
  )
}

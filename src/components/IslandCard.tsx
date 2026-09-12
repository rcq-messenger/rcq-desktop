// One island in the picker's deck, the card the phones draw (IslandCard on
// Android, IslandCardView on iOS): painting, name, `host · region · people`,
// the door line, two lines of the operator's blurb.
//
// ⚠⚠ EVERY SLOT ON THIS CARD IS RESERVED, in `rem`, whether the island has
// filled it or not. The deck shows the neighbours' edges, so every card has
// to measure the same or the modal jumps when paging from is2 (long blurb,
// closed) to the flagship (open, priced) to an island that has not answered
// (Android #736: "the sheet twitches up and down"). The door line arrives
// asynchronously and the rules button appears only when the island wrote
// some; both have their slot drawn empty until then, and the rules slot has a
// mirror on the other side so the name stays centred.
//
// The island is asked ONE question (/server/info) and every line reads off
// that answer: the name it calls itself (beats the catalogue's, which is a
// file edited by hand; founder, 24.08: "why does it say RCQ (default) when we
// have a server name"), the door, the headcount, the rules. Asked only for a
// card the person is on or next to (`near`), like Android's islandDoor: the
// deck must not hand this device's address to every island in the catalogue
// the moment it opens. `fetchServerInfo` keeps the answer for the run, so
// paging back and forth is free.
//
// A REMEMBERED island (remembered-islands.ts) is the same card with the
// catalogue's slots filled from what this profile knows: a "remembered"
// caption where the region goes, a lock on the host line when a gateway key
// is on file for it, and a Forget link where the blurb would be (a private
// island rarely has one). Forget is withheld while an account in the roster
// still lives there: forgetting the island under a signed-in account would
// be a list that disagrees with the switcher.

import { useI18n } from '../lib/i18n-context'
import { islandCard } from '../lib/island-card'
import { islandLabel } from '../lib/island-choice'
import { gatewayKeyOnFile } from '../lib/island-gate'
import { formatUsd, type ServerInfo } from '../lib/server-info'
import { useServerInfo } from '../lib/use-server-info'
import { IslandArt } from './IslandArt'

export interface DeckIsland {
  /// `https://host[:port]`.
  base: string
  /// The catalogue's name and blurb for a catalogue island; the last known
  /// name for a remembered one.
  name?: string
  description?: string
  region?: string
  /// An island this profile reached that the catalogue does not list.
  remembered?: boolean
}

export function IslandCard({
  island,
  active,
  near,
  artHeight,
  canForget,
  onForget,
  onRules,
}: {
  island: DeckIsland
  /// The island in force when the picker opened; drawn with a tick.
  active: boolean
  near: boolean
  /// The painting's height, from the deck: taller where the page is narrower.
  artHeight?: number
  canForget: boolean
  onForget: (base: string) => void
  onRules: (name: string, text: string) => void
}) {
  const { t } = useI18n()
  const base = island.base
  const info = useServerInfo(near ? base : undefined)
  const name = info?.name.trim() || islandCard(base)?.name || island.name || islandLabel(base)
  const people = info?.capabilities.user_count ?? 0
  const rules = info?.welcome.trim() ?? ''
  const keyed = island.remembered === true && gatewayKeyOnFile(base)
  const caption = island.remembered ? t('island.remembered') : island.region

  return (
    <div className="flex flex-col items-center text-center px-2 select-none">
      <IslandArt base={base} name={name} near={near} height={artHeight} />
      <div className="mt-2 w-full flex items-center justify-center min-h-[1.5rem]">
        <span className="w-6 flex-none" aria-hidden />
        <span className="min-w-0 text-sm font-medium truncate">{name}</span>
        <span className="w-6 flex-none flex justify-center">
          {rules && <IslandRulesButton name={name} text={rules} onOpen={onRules} />}
        </span>
      </div>
      <div className="mt-0.5 w-full text-xs text-fg-dim truncate min-h-[1.25rem] leading-5">
        {islandLabel(base)}
        {caption ? (
          <>
            {' · '}
            <span className="text-[0.625rem] uppercase">{caption}</span>
          </>
        ) : null}
        {keyed && <LockMark title={t('island.gateway_key_on_file')} />}
        {active && <span className="text-accent"> · ✓</span>}
        {people > 0 && <CrowdMark n={people} />}
      </div>
      <div className="mt-1.5 w-full min-h-[1rem] leading-4">
        <IslandEntryLine info={info} />
      </div>
      <div className="mt-1 w-full min-h-[2rem] leading-4 text-[0.6875rem] text-fg-secondary">
        {island.remembered ? (
          canForget && (
            <button
              type="button"
              onClick={() => onForget(base)}
              className="text-accent hover:underline"
            >
              {t('island.forget')}
            </button>
          )
        ) : island.description ? (
          // ⚠ Not `block` beside the clamp: `display:block` wins over the
          // clamp's `-webkit-box` and the blurb runs to four lines.
          <div className="line-clamp-2">{island.description}</div>
        ) : null}
      </div>
    </div>
  )
}

/// The island's house rules, one click from the card that would join it
/// (founder, 07.09: "a good idea, so you can look before joining"). The same
/// words its own Settings page shows to the people already living there.
///
/// ⚠ Drawn ONLY when the operator actually wrote some: the card leaves the
/// slot empty otherwise. A blank welcome is the ordinary case, and a button
/// that opens an empty page is worse than no button at all.
function IslandRulesButton({
  name,
  text,
  onOpen,
}: {
  name: string
  text: string
  onOpen: (name: string, text: string) => void
}) {
  const { t } = useI18n()
  return (
    <button
      type="button"
      onClick={() => onOpen(name, text)}
      title={t('island.rules.title')}
      aria-label={t('island.rules.title')}
      className="text-fg-dim hover:text-accent transition-colors"
    >
      {/* A sheet of paper with lines on it: hand-drawn like every other glyph
          in this tree, which ships no icon dependency. */}
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 3.5h9L19 8v12.5H6z" />
        <path d="M14 3.5V8h5M9 12h6M9 16h4" />
      </svg>
    </button>
  )
}

/// The headcount, with a GLYPH in front of it.
///
/// ⚠ "$15 once · 2,649" reads as two prices (founder, 09.09: "what is 2649?").
/// The little two-person mark says which number is money and which is people,
/// in every language and without spending a word on it. On the host line, as
/// Android draws it, never a row of its own: every line on the card is
/// measured (see the file comment).
function CrowdMark({ n }: { n: number }) {
  return (
    <>
      {' · '}
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="currentColor"
        className="inline-block align-[-0.1em]"
        aria-hidden
      >
        <circle cx="9" cy="7.5" r="3.5" />
        <path d="M2 20c0-3.6 3.1-5.5 7-5.5s7 1.9 7 5.5z" />
        <circle cx="17.5" cy="8.5" r="2.8" />
        <path d="M17.5 13.2c3.3 0 4.5 2.2 4.5 4.6h-5.2c0-1.9-.6-3.4-1.6-4.4a7.6 7.6 0 0 1 2.3-.2z" />
      </svg>
      {' '}
      {n.toLocaleString()}
    </>
  )
}

/// A gateway key is on file for this island (desktop only). The glyph is all
/// the card ever shows of it: the key itself is never rendered.
function LockMark({ title }: { title: string }) {
  return (
    <>
      {' · '}
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="inline-block align-[-0.05em]"
        aria-label={title}
        role="img"
      >
        <title>{title}</title>
        <rect x="4" y="10" width="16" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </svg>
    </>
  )
}

/// Whether an island lets you in at all, and what it charges, under its name
/// on the card.
///
/// ⚠ Asked of the ISLAND, not of the catalogue. servers.json is a file we
/// maintain by hand and it would be stale the day after an operator changed
/// their price, and a wrong price is worse than no price. The island answers
/// for itself on /server/info, the one question the card asks.
///
/// ⚠⚠ TWO flags decide "closed", the same pair the create form reads (see
/// Login.tsx). `registration_policy` is what the door actually enforces;
/// `closed_island` also withholds the residents' envelope key. An operator can
/// set either alone, and this line used to read only the second, so an
/// invite-only island that had not been marked closed advertised itself as an
/// ordinary island and then refused the person at the last step.
///
/// ⚠ Silence until the island speaks for itself: `info` is null while the
/// answer is in flight or the island gave none, and printing the permissive
/// defaults then would promise a door we never knocked on (founder, 07.09:
/// the picker must say which islands are closed).
function IslandEntryLine({ info }: { info: ServerInfo | null }) {
  const { t } = useI18n()
  if (!info) return null
  const caps = info.capabilities
  // ⚠ "paid" belongs here. The server has three policies (open, invite,
  // paid) and this line listed two, so an island that charges for entry
  // without also sealing its directory was drawn as open and then refused
  // the registration it had just invited.
  const closed = caps.closed_island || caps.registration_policy !== 'open'
  if (!closed) {
    // Dim, unlike the closed line: this is the ordinary answer, and the card
    // should not shout it.
    return <span className="block text-[0.6875rem] text-fg-dim truncate">{t('island.entry.open')}</span>
  }
  const cents = caps.entry_price_cents ?? 0
  // Where the island sells entry, in its own words. `entry_url` is the
  // operator's setting, so a self-hoster sends people to their own shop and we
  // send people to ours; an island that set a price and no address gets the
  // line without a link rather than a link to somewhere we made up.
  const url = (caps.entry_url || '').trim()
  const line = cents > 0
    ? t('island.entry.price', { price: formatUsd(cents) })
    : caps.closed_island
      ? t('island.entry.closed')
      : t('island.entry.invite')
  if (!url || !/^https:\/\//i.test(url)) {
    return <span className="block text-[0.6875rem] text-accent truncate">{line}</span>
  }
  // A plain anchor, deliberately: on the desktop `installExternalLinkHandler`
  // (lib/desktop.ts) hands every http(s) link to the system browser, and this
  // is not a store build, so the operator's shop may be pointed at.
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="block text-[0.6875rem] text-accent truncate hover:underline"
    >
      {line} · {t('island.entry.buy')}
    </a>
  )
}

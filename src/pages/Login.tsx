// Entry point. Web is its own account model: a visitor creates a
// fresh in-browser account (its own UIN + keys). The old "Link from
// iOS" blob-paste flow was removed — it predated recovery phrases,
// only ever worked for iOS, and depended on an iOS QR screen that's
// disabled. Proper phone<->web linking (web as a secondary device) is
// a separate future feature; until then web is a standalone account.

import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { LanguagePicker } from '../components/LanguagePicker'
import { ThemeToggle } from '../components/ThemeToggle'
import { Logo } from '../components/Logo'
import {
  RecoverError,
  activateStoredIdentity,
  addAccountOrigin,
  adoptLinkBlob,
  createNewAccount,
  currentRecoveryPhrase,
  listStoredIdentities,
  parseLinkBlob,
  recoverFromPhrase,
  suggestNickname,
} from '../lib/auth'
import { flushVaultWriter } from '../lib/pin-gate'
import { isTauri } from '../lib/desktop'
import { defaultHome } from '../lib/routing'
import { clientLabel } from '../lib/client-name'
import { bytesToB64, newLinkEphemeral, openLinkSeal, type WebIdentity } from '../lib/crypto'
import { IslandPickerModal } from '../components/IslandPickerModal'
import { EntryCheckout } from '../components/EntryCheckout'
import { Till, forgetEntryInvoice, listEntryInvoices } from '../lib/till'
import { ApiError, parseErrorCode } from '../lib/api'
import { useServerCapabilities } from '../lib/use-server-info'
import { formatUsd } from '../lib/server-info'
import { islandLabel, rememberIsland, rememberedIsland, type IslandAddress } from '../lib/island-choice'
import { rememberReachedIsland } from '../lib/remembered-islands'
import { engageIslandEagerly, prePinIsland } from '../lib/island-trust'
import { IslandAvatar } from '../components/IslandAvatar'
import { useIslandCard } from '../lib/use-server-info'
import { useI18n } from '../lib/i18n-context'
import { useToast } from '../lib/toast'
import { showTransitionVeil } from '../lib/transition-veil'

// The login copy talks about "this browser"; in the desktop app the same
// screens are about a computer. Keys with a platform difference have a
// `.desktop` twin, and isTauri() never changes at runtime.
const dk = isTauri() ? '.desktop' : ''

export function Login() {
  const { t } = useI18n()

  // "Add account" in Settings clears the ACTIVE slot and lands here, with the
  // other accounts still in the roster. Until this existed there was no way
  // back: the only exits from this screen were creating or linking an account,
  // so a mistap forced you to make one. Any stored identity means we got here
  // from a signed-in session, so offer to go back to it.
  const [stored] = useState(() => listStoredIdentities())
  // ⚠ Where "cancel" lands is NOT the head of the roster. The head means "last
  // account switched into", and an account reaches the active slot by routes
  // that leave the order alone (created, recovered by phrase, linked from a
  // phone), so reading it as "the one you were on" was right most of the time
  // and wrong the rest — the founder's "sometimes returns me to a different
  // one" (07.09). `addAccountOrigin` is the account this tab actually left,
  // stamped by openLoginScreen on the way here.
  //
  // The head stays as the FALLBACK, for the other way onto this screen: a
  // session the island ended drops the active slot without passing through
  // "add account", and the way back to the remaining accounts should not
  // disappear because there is no stamp to read.
  const [resume] = useState(() => {
    const from = addAccountOrigin()
    return (from == null ? undefined : stored.find((a) => a.uin === from)) ?? stored[0]
  })

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-surface-dim px-4 py-6">
      {/* Floated out of flow so the form stays vertically CENTERED on
          mobile (the picker used to take a row at the top and push the
          content down). */}
      <div className="absolute top-4 right-4 z-10 flex items-center gap-1.5">
        <ThemeToggle />
        <LanguagePicker />
      </div>

      {/* The way back to the account you already have. It sat at the BOTTOM of
          the form, under the create/recover switch, where a person adding a
          second account had to read past the whole form to find out they could
          simply leave. A corner is where a way out belongs (founder, 07.09). */}
      {resume && (
        <div className="absolute top-4 left-4 z-10">
          <button
            type="button"
            onClick={() => {
              // The activation is a vault write on desktop; it has to land
              // before the reload or the login screen resurrects (same race
              // as addAccount, see flushVaultWriter).
              if (activateStoredIdentity(resume.uin)) void flushVaultWriter().finally(() => window.location.assign('/'))
            }}
            className="text-sm text-fg-secondary hover:text-fg-primary transition-colors"
          >
            {t('login.cancel_add')}
          </button>
        </div>
      )}

      <div className="w-full flex items-center justify-center">
        <div className="w-full max-w-sm space-y-8">
          <header className="flex flex-col items-center gap-3 text-center">
            {/* Always-spinning brand mark (linear 30s), matches iOS. */}
            <Logo size={64} spin />
            <div className="text-2xl font-bold tracking-tight">{t('brand.name')}</div>
            {/* The tagline used to sit here and is gone (founder, 07.09): the
                first screen should ask one question, not also make a claim.
                The KEY stays — Settings renders it in About. */}
          </header>

          <ModeSwitch
            onDone={() => {
              // The veil while the scoped reload happens - restoring a phrase
              // or creating an account used to end on a frozen form (founder,
              // 21.08, same family as the PIN unlock reveal).
              showTransitionVeil()
              // A HARD reload, not a route change. This page has lived without
              // an account scope, so any store it touched — the device database
              // above all — is pinned to the FLAT namespace for the rest of the
              // page's life. Continuing as an SPA kept exactly one session type
              // (a fresh QR link) writing its libsignal keys where no later
              // boot would look, and the next reload minted new keys over the
              // primary slot (2026-08-20). The identity is already persisted by
              // the time onDone runs; the reload starts the app scoped.
              // Desktop: the vault write has to land first (same race as the
              // resume button below).
              void flushVaultWriter().finally(() => window.location.assign(defaultHome()))
            }}
          />

        </div>
      </div>
    </div>
  )
}

// -----------------------------------------------------------
// Mode switch: create a fresh web account, or link an existing phone account
// by scanning a QR (web becomes a secondary device of that identity).
// -----------------------------------------------------------

function ModeSwitch({ onDone }: { onDone: (id: WebIdentity) => void }) {
  const { t } = useI18n()
  // ⚠ On the desktop the first tab is "Connect phone", not "New account".
  // The desktop app is almost never somebody's first RCQ device, and with
  // Create first, filled green, and a nickname already suggested, one reflex
  // click made a SECOND account with its own number ("Computer and phone
  // under different numbers", #968). The web keeps Create first: for a
  // browser it genuinely may be the first device.
  const [mode, setMode] = useState<'create' | 'recover' | 'link'>(isTauri() ? 'link' : 'create')
  const tab = (m: typeof mode, label: string) => (
    <button
      onClick={() => setMode(m)}
      className={`h-9 rounded-md transition-colors whitespace-nowrap px-1 ${mode === m ? 'bg-accent text-white' : 'text-fg-secondary hover:text-fg'}`}
    >
      {label}
    </button>
  )
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-surface-dim text-sm font-medium">
        {isTauri() ? (
          <>
            {tab('link', t('login.mode.link'))}
            {tab('recover', t('login.mode.recover'))}
            {tab('create', t('login.mode.create'))}
          </>
        ) : (
          <>
            {tab('create', t('login.mode.create'))}
            {tab('recover', t('login.mode.recover'))}
            {tab('link', t('login.mode.link'))}
          </>
        )}
      </div>
      {mode === 'create' ? (
        <CreatePane onDone={onDone} />
      ) : mode === 'recover' ? (
        <RecoverPane onDone={onDone} />
      ) : (
        <LinkPane onDone={onDone} />
      )}
    </div>
  )
}

// -----------------------------------------------------------
// Recovery-phrase backup card — the 24 words in a grid + a copy button.
// Shown after account creation (back this up to move to a phone) and in
// the recover flow. Numbered to match how phones present it.
// -----------------------------------------------------------

function PhraseGrid({ words }: { words: string[] }) {
  return (
    <div className="grid grid-cols-3 gap-1.5 rounded-lg bg-surface-dim p-3">
      {words.map((w, i) => (
        <div key={i} className="flex items-baseline gap-1 text-sm">
          <span className="text-[0.625rem] text-fg-dim w-5 text-right shrink-0">{i + 1}</span>
          <span className="font-medium break-all">{w}</span>
        </div>
      ))}
    </div>
  )
}

// -----------------------------------------------------------
// Recover-from-phrase
// -----------------------------------------------------------

function RecoverPane({ onDone }: { onDone: (id: WebIdentity) => void }) {
  const { t } = useI18n()
  const [phrase, setPhrase] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [island, setIsland] = useState(() => rememberedIsland())
  // ⚠ This pane used to restore onto `rememberedIsland()` with no way to see
  // or change it. That value is written only by the CREATE tab, so somebody
  // restoring an account that lives on their own island had to go make a new
  // account first, pick the island there, and come back — and if they did not
  // know that, they restored against whatever island this browser last
  // happened to look at, and read a phrase error (founder, 07.09). iOS has had
  // the row behind an "Advanced" disclosure since it shipped.

  async function submit() {
    setError(null)
    setBusy(true)
    try {
      const id = await recoverFromPhrase(phrase, island)
      // Reached, so remembered: the picker offers this island again on this
      // profile, whichever account is active later (founder, 12.09).
      rememberReachedIsland(island, 'recovered')
      onDone(id)
    } catch (e) {
      const code = e instanceof RecoverError ? e.code : 'network'
      setError(t(`login.recover.error.${code}`))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-fg-secondary leading-relaxed">{t('login.recover.body' + dk)}</p>
      <IslandField value={island} onChange={(next) => setIsland(next.base)} />
      <textarea
        value={phrase}
        onChange={(e) => setPhrase(e.target.value)}
        rows={4}
        placeholder={t('login.recover.placeholder')}
        className="w-full px-3 py-2 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm resize-none"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
      />
      {/* ⚠ Tokens and an alpha fill, never `bg-red-50`/`border-red-200`. Those
          two are fixed light colours: in the true-black theme this box was a
          white slab with dark red text sitting on a black page, which is the
          "looks cheap" the founder means (07.09). Same box as the create
          pane's now, so the two halves of the join path fail alike. */}
      {error && (
        <div className="text-sm text-red-500 bg-red-500/10 border border-red-500/25 rounded-md p-2">{error}</div>
      )}
      <button
        onClick={submit}
        disabled={busy || phrase.trim().split(/\s+/).length < 24}
        className="w-full h-11 rounded-md bg-accent hover:bg-accent-dim text-white font-semibold disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
      >
        {busy && <Spinner />}
        {busy ? t('login.recover.busy') : t('login.recover.cta')}
      </button>
    </div>
  )
}

// -----------------------------------------------------------
// Connect-a-phone: show a QR; the phone (Settings → Connect to web) scans it,
// seals its account into the one-time relay, the web opens it here and logs in
// as the same identity. Strings are English for now — i18n keys come with the
// mobile side + the Linked Devices screen.
// -----------------------------------------------------------

function LinkPane({ onDone }: { onDone: (id: WebIdentity) => void }) {
  const { t } = useI18n()
  const [qr, setQr] = useState<string | null>(null)
  const [state, setState] = useState<'waiting' | 'expired' | 'error'>('waiting')
  const [gen, setGen] = useState(0) // bump → fresh token + QR
  const [zoomed, setZoomed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setQr(null)
    setState('waiting')
    const eph = newLinkEphemeral()
    const tokenBytes = new Uint8Array(32)
    crypto.getRandomValues(tokenBytes)
    const token = Array.from(tokenBytes, (b) => b.toString(16).padStart(2, '0')).join('')
    // The phone parses this: a one-time relay token + the web's ephemeral
    // X25519 pubkey to seal the account to + `c` = what to CALL this session in
    // the phone's Linked-devices list. It used to be the bare word "Desktop"
    // or "Web", which is what founder was looking at; `clientLabel()` now names
    // the app or browser and the operating system, Telegram-style, inside the
    // 24 characters the phones keep. Old phones ignore `c` entirely and fall
    // back to "Web" — backward compatible either way.
    void clientLabel().then((client) => {
      const payload = `rcq://link?t=${token}&k=${encodeURIComponent(bytesToB64(eph.pub))}&c=${encodeURIComponent(client)}`
      return QRCode.toDataURL(payload, { width: 240, margin: 1, errorCorrectionLevel: 'M' })
    }).then((u) => {
      if (!cancelled) setQr(u)
    })

    // The relay's 120s TTL binds the DEPOSITED blob, not this token — an
    // un-deposited slot never expires server-side, so the only cost of
    // waiting is QR-rotation hygiene. 10 min covers the slow real-world
    // path (scan with camera → open link → unlock app → confirm); the old
    // 110s deadline made the web give up mid-flow and the phone's retry
    // then hit 409 slot_taken (beta report #193 "код истёк").
    const deadline = Date.now() + 600_000
    async function poll() {
      if (cancelled) return
      if (Date.now() > deadline) {
        if (!cancelled) setState('expired')
        return
      }
      let res: Response
      try {
        res = await fetch(`${rememberedIsland()}/link/${token}`)
      } catch {
        // Network blip — keep polling.
        setTimeout(poll, 2000)
        return
      }
      if (res.ok) {
        try {
          const { blob } = await res.json()
          const plain = openLinkSeal(blob, eph.priv, eph.pub)
          const id = adoptLinkBlob(parseLinkBlob(new TextDecoder().decode(plain)))
          // The phone's island is one this profile has reached now.
          rememberReachedIsland(id.apiBase, 'linked')
          if (!cancelled) onDone(id)
        } catch {
          // A malformed / wrong-key deposit landed in our slot.
          if (!cancelled) setState('error')
        }
        return
      }
      // 404 = nothing deposited yet; keep waiting.
      setTimeout(poll, 2000)
    }
    const h = setTimeout(poll, 2000)
    return () => {
      cancelled = true
      clearTimeout(h)
    }
  }, [gen]) // re-run (fresh token + QR) when the user taps refresh

  return (
    <div className="space-y-4 text-center">
      <p className="text-xs text-fg-secondary leading-relaxed">{t('login.link.scan_body')}</p>
      {/* The code is smaller than it was: at 252px it dominated a screen whose
          job is to explain what linking costs you, and a phone camera does not
          need it that big from 30cm. It grows a little under the cursor and
          opens centred on a blurred page when tapped, for the case where the
          phone is held further away or the screen is small. */}
      <div className="flex items-center justify-center">
        <div className="relative flex items-center justify-center">
          {/* Calm green sonar waves rippling out from behind the QR while we
              wait for the phone. Three rings on a slow 2.7s loop, staggered. */}
          {qr && state === 'waiting' && (
            <>
              <span className="rcq-wave absolute inset-0 m-auto w-[152px] h-[152px] rounded-2xl bg-accent/25" />
              <span className="rcq-wave absolute inset-0 m-auto w-[152px] h-[152px] rounded-2xl bg-accent/25" style={{ animationDelay: '0.9s' }} />
              <span className="rcq-wave absolute inset-0 m-auto w-[152px] h-[152px] rounded-2xl bg-accent/25" style={{ animationDelay: '1.8s' }} />
            </>
          )}
          <button
            type="button"
            onClick={() => qr && setZoomed(true)}
            disabled={!qr}
            aria-label={t('login.link.enlarge')}
            title={t('login.link.enlarge')}
            className="relative rounded-xl bg-white p-2.5 w-[168px] h-[168px] flex items-center justify-center shadow-lg shadow-accent/10 transition-transform duration-200 hover:scale-105 disabled:cursor-default"
          >
            {qr ? <img src={qr} alt="Link QR" width={148} height={148} /> : <Spinner />}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {zoomed && qr && (
          <motion.div
            key="qr-zoom"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={() => setZoomed(false)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-md p-6"
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.92, opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={(e) => e.stopPropagation()}
              className="rounded-2xl bg-white p-5 shadow-2xl"
            >
              <img src={qr} alt="Link QR" className="w-[min(72vw,340px)] h-[min(72vw,340px)]" />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Honest, jargon-free note about the multi-device → simpler-encryption
          trade-off (convenience vs max security), not an alarm. The "learn
          more" link deep-links to the FAQ answer that explains it in full. */}
      <div className="space-y-1">
        <p className="text-xs text-fg-dim leading-relaxed">{t('login.link.security_note' + dk)}</p>
        <a
          href="https://rcq.app/faq#web-link"
          target="_blank"
          rel="noreferrer"
          className="inline-block text-xs text-accent whitespace-nowrap underline-offset-2 hover:underline"
        >
          {t('login.link.security_more')}
        </a>
      </div>
      {state === 'waiting' && (
        <p className="text-xs text-fg-dim">{t('login.link.waiting')}</p>
      )}
      {(state === 'expired' || state === 'error') && (
        <div className="flex flex-col items-center gap-2">
          <p className="text-sm text-fg-secondary">
            {t(state === 'expired' ? 'login.link.expired' : 'login.link.error')}
          </p>
          <button
            onClick={() => setGen((g) => g + 1)}
            className="h-9 px-5 rounded-md bg-accent hover:bg-accent-dim text-white text-sm font-semibold transition-colors"
          >
            {t('login.link.refresh')}
          </button>
        </div>
      )}
    </div>
  )
}

// -----------------------------------------------------------
// Create-account
// -----------------------------------------------------------

function CreatePane({ onDone }: { onDone: (id: WebIdentity) => void }) {
  const { t } = useI18n()
  const { toast } = useToast()
  const [nickname, setNickname] = useState(() => suggestNickname())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // After registration we hold the new identity + its phrase and show a
  // mandatory backup card BEFORE entering the app — losing the phrase means
  // losing the account (and the ability to move it to a phone).
  const [accepted, setAccepted] = useState(false)
  const [pending, setPending] = useState<{ id: WebIdentity; words: string[] } | null>(null)
  // ⚠ THE CODE FIELD EXISTED NOWHERE ON THIS SCREEN. `createNewAccount` has
  // taken an invite since the CLI learned to join a closed island, and the web
  // had the plumbing and no way for a person to use it: somebody handed a code
  // in words hit a raw "403" and had nowhere to type it. The CLI, which nobody
  // outside a terminal runs, was the only client that could join a club.
  //
  // Shown when the island says it is invite-only, and revealed by a refusal
  // when it does not (a cached or unreachable /server/info, or an island that
  // closed while this tab was open).
  // Held here, not inside `IslandField`: everything below has to know which
  // island was picked, and the field used to keep that to itself.
  const [island, setIsland] = useState(() => rememberedIsland())
  const caps = useServerCapabilities(island)
  const [invite, setInvite] = useState('')
  /// Whether the person asked for the code box on an island that does not
  /// demand one. Reset by a change of island below, with the refusal.
  const [codeRevealed, setCodeRevealed] = useState(false)
  const [needsInvite, setNeedsInvite] = useState(false)
  // ⚠ BOTH settings, because they are two independent knobs on the island and
  // the client had been reading only one. `registration_policy` decides
  // whether the door wants a code; `closed_island` is what the picker prints
  // "Closed club" from. An operator who set only the second got a picker that
  // advertised a club and a form with no way in, one screen apart, which is
  // exactly what the founder walked into (07.09). A stray code on an island
  // that does not want one is ignored by the island, so asking is cheap.
  // ⚠⚠ TWO flags, not one, and the difference is a dead Create button.
  //
  // `showCode` decides whether to DRAW the field. `requireCode` decides
  // whether the form refuses to submit without it. They were one value, and
  // widening that one value to include `closed_island` — which is what it took
  // to make the field appear at all — also made the code MANDATORY on an
  // island that is closed but still registers anyone. The island's own help
  // text warns operators they can end up in exactly that state ("an island
  // anyone may join and nobody may write into"), and on it the register call
  // ignores a code entirely. So a single flag would have demanded a code that
  // nobody issues and that nothing reads, and the button would never enable.
  //
  // Closed-but-open therefore OFFERS the field and does not insist on it.
  //
  // ⚠⚠ AND on an island that SELLS entry, even one that is not locked. The
  // till can be selling access codes while the door is open — the flagship is
  // exactly that — and a buyer who is never shown the box registers as an
  // ordinary stranger and their payment buys nothing. Somebody holding a code
  // must always have somewhere to put it.
  // ⚠ The hint under the field follows the DOOR, not the field: an island that
  // merely sells entry with its door open must not be told "this island is
  // closed", which is the one sentence on the screen that explains the box.
  const doorIsShut = needsInvite || caps.registration_policy !== 'open' || caps.closed_island === true
  // ⚠⚠ AN OPEN ISLAND THAT SELLS ENTRY NO LONGER SHOWS THE BOX BY DEFAULT, it
  // offers a line to open one (founder, 07.09: "the field shows even when the
  // island I picked is not closed"). The flagship is exactly that island: its
  // door is open and its till sells codes, so the old rule put an empty code
  // box in front of every ordinary newcomer, and the overwhelming majority of
  // them have no code and never will. The buyer still has somewhere to paste,
  // one tap away, which was the whole point of the rule.
  //
  // A door that is genuinely SHUT still shows the field outright: there the
  // code is not an extra, it is the only way in.
  const sellsEntry = (caps.entry_price_cents ?? 0) > 0
  // ⚠ THE OTHER HALF OF THE DOOR. The form had the box to paste a code into
  // and nowhere to get one: "there is only a field for the access code, but
  // where is the crypto payment gateway?" (founder, 07.09). The gateway is not
  // in this app and must not be — the operator's page takes the crypto,
  // watches the chain and hands back a signed code — so all that was missing
  // is the way out to it.
  //
  // ⚠⚠ THE ISLAND'S OWN ADDRESS, never a constant. Every operator runs their
  // own till, so a self-hoster sells their entry and we sell ours; sending a
  // buyer to the flagship's page for somebody else's island is real money paid
  // where the account is not, with no way back.
  //
  // ⚠ https ONLY, and no button at all without it. This string comes from a
  // server we may merely be probing and it ends up opening in the person's
  // real browser (see the anchor below), so a plaintext or exotic scheme is
  // refused rather than cleaned up. An island that names no address gets a
  // sentence with its price and no link: a button that goes nowhere is worse
  // than nothing.
  const entryUrl = (caps.entry_url || '').trim()
  const canBuyEntry = sellsEntry && /^https:\/\//i.test(entryUrl)
  // ⚠⚠ THE GATEWAY INSIDE THE APP, only when the island names its own till
  // (`till_url`; see lib/server-info.ts). The button then opens EntryCheckout
  // in place of the anchor above, and the code it ends in lands in the box
  // below by itself. An island that names a page and no till keeps the
  // anchor; one that names neither gets the sentence with the price.
  const tillUrl = caps.till_url
  const inAppEntry = sellsEntry && !!tillUrl
  const [checkout, setCheckout] = useState<{ resumeId?: string } | null>(null)
  const islandHostname = islandLabel(island)
  const { name: islandCardName } = useIslandCard(island)
  // A payment that landed while nobody was looking: an entry invoice this
  // browser opened for THIS island and paid after the tab was closed. The
  // code is put into the box, which is where the person was heading.
  useEffect(() => {
    if (!inAppEntry) return
    let dead = false
    void (async () => {
      for (const stored of listEntryInvoices()) {
        if (dead) return
        if (stored.host.toLowerCase() !== islandHostname.toLowerCase()) continue
        try {
          const inv = await Till.entryInvoice(stored.id, stored.tillUrl || tillUrl)
          if (dead) return
          if (inv.status === 'paid' && inv.voucher) {
            setInvite(inv.voucher)
            setCodeRevealed(true)
            forgetEntryInvoice(inv.id)
            return
          }
          if (inv.status === 'expired') forgetEntryInvoice(inv.id)
        } catch {
          /* a till we cannot reach today is one we ask again tomorrow */
        }
      }
    })()
    return () => {
      dead = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inAppEntry, islandHostname, tillUrl])
  const showCode = doorIsShut || codeRevealed
  // Mirrors `auth.register`, which refuses on the POLICY alone: invite or
  // paid. `closed_island` is a different question (who may write to a
  // resident) and does not decide whether registration needs a code.
  const requireCode = needsInvite || caps.registration_policy !== 'open'

  async function submit() {
    setError(null)
    setBusy(true)
    try {
      const id = await createNewAccount(nickname, island, invite)
      // Reached, so remembered: the picker offers this island again on this
      // profile, whichever account is active later (founder, 12.09).
      rememberReachedIsland(island, 'created')
      const words = currentRecoveryPhrase()
      if (words) setPending({ id, words })
      else onDone(id) // shouldn't happen for a fresh account; fail open
    } catch (e) {
      // The island's own words for the door, not a status code. `invite_required`
      // also OPENS the field: an island can close while this tab is open, and
      // the person is then one paste away rather than stuck.
      //
      // ⚠⚠ THE BODY IS NOT ALWAYS ON AN ApiError, and reading only that one
      // shape is why none of this ran. `createNewAccount` registers with a bare
      // `fetch`, not the `request()` helper, and throws `new Error(body)` — so
      // on a closed island every refusal fell through to the generic branch and
      // the person was shown the island's raw JSON, `{"detail":{"code":
      // "invite_invalid"}}`, instead of the sentence written for exactly that
      // moment. `needsInvite` never armed either, so an island that closed
      // while the tab was open kept its code field hidden. Verified on is2,
      // 07.09. Both shapes carry the body; take whichever we were handed.
      const body = e instanceof ApiError ? e.body : e instanceof Error ? e.message : ''
      const code = parseErrorCode(body)
      if (code === 'invite_required' || code === 'entry_required') {
        // ⚠ TWO codes, one door. A closed island answers `invite_required`; one
        // whose policy is "paid" answers `entry_required` (auth.py). Matching
        // only the first is how the flagship spent its first minutes closed
        // showing people its own raw JSON, which is the exact failure the
        // comment above was written about — under a second name.
        setNeedsInvite(true)
        setError(t(code === 'entry_required' ? 'auth.error.entry_required' : 'auth.error.invite_required'))
      } else if (code === 'invite_invalid') {
        setNeedsInvite(true)
        setError(t('auth.error.invite_invalid'))
      } else if (e instanceof TypeError) {
        // ⚠ A TypeError out of `fetch` is the ONLY thing a browser gives us for
        // "the island did not answer": DNS, a dead host, a blocked network, a
        // certificate the browser refused. Its message is "Failed to fetch" /
        // "Load failed" / "NetworkError…" depending on the engine, and printing
        // that told nobody which island failed or what to do. This is the
        // founder's "could not connect" (07.09) — and it stays INSIDE the form,
        // with the address one tap away, rather than becoming a dialog whose
        // only button is "try again".
        setError(t('auth.error.register_offline', { island: islandLabel(island) }))
      } else {
        const detail = e instanceof Error ? e.message : 'unknown'
        setError(t('auth.error.register_failed', { detail }))
      }
    } finally {
      setBusy(false)
    }
  }

  if (pending) {
    return (
      <div className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{t('login.phrase.title')}</h2>
          <p className="text-sm text-fg-secondary leading-relaxed">{t('login.phrase.body' + dk)}</p>
        </div>
        <PhraseGrid words={pending.words} />
        <button
          onClick={() => {
            void navigator.clipboard?.writeText(pending.words.join(' ')).catch(() => {})
            toast(t('login.phrase.copied'))
          }}
          className="w-full h-9 rounded-md bg-field hover:bg-line/40 text-sm font-medium transition-colors"
        >
          {t('login.phrase.copy')}
        </button>
        <div className="text-xs text-fg-dim bg-amber-500/10 border border-amber-500/30 rounded-md p-2 leading-relaxed">
          {t('login.phrase.warning' + dk)}
        </div>
        <button
          onClick={() => onDone(pending.id)}
          className="w-full h-11 rounded-md bg-accent hover:bg-accent-dim text-white font-semibold transition-colors"
        >
          {t('login.phrase.saved')}
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-fg-secondary leading-relaxed">{t('login.create.body' + dk)}</p>

      <div className="space-y-1">
        <label className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
          {t('login.create.nickname')}
        </label>
        <input
          type="text"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          maxLength={64}
          className="w-full h-10 px-3 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
        />
        <p className="text-xs text-fg-dim">{t('login.create.nickname_hint')}</p>
      </div>

      {/* ⚠ Changing the island RETIRES the last island's refusal. Both of these
          are facts about the island we just left: `needsInvite` is "that island
          asked for a code" and it also makes the code MANDATORY, so after one
          refusal the form went on demanding a code for every island picked
          afterwards, including an open one that issues none — a dead Create
          button with no way to explain itself. The error is stale for the same
          reason. The typed code is deliberately kept: switching islands by
          mistake should not throw away something the person pasted. */}
      <IslandField
        value={island}
        onChange={(next) => {
          setIsland(next.base)
          setNeedsInvite(false)
          // The box the person opened by hand belongs to the island they opened
          // it on: carrying it to the next one puts an unexplained field back
          // on a screen that did not ask for one. The typed code stays.
          setCodeRevealed(false)
          setError(null)
        }}
      />

      {/* The way to the till, ABOVE the box the code goes into: buy first,
          paste second, in the order the person actually does it. Only an
          island that sells entry has anything to offer here, and only one that
          names a page gets a link.

          ⚠ A PLAIN ANCHOR, deliberately, and not a click handler that calls
          `openExternal`. On the desktop this is a Tauri webview, where
          `target="_blank"` means `window.open` and wry implements none, so the
          link would silently do nothing — but `installExternalLinkHandler`
          (lib/desktop.ts, armed once in main.tsx) already catches every
          left-click on an `http(s)` anchor in the capture phase and hands the
          URL to the system browser. Every external link in this tree rides
          that one path, including the terms and privacy links below; a bespoke
          handler here would be a second path to keep working. */}
      {/* ⚠ THE LABEL FOLLOWS THE DOOR, NOT THE PRICE. A shut island sells the
          way in, so it is "entry"; an open one that charges sells standing
          inside it, so it is "residency" — anyone can walk in for free. The
          flagship is the second kind, and calling its $15 an entry fee on an
          open door told every visitor they had to pay to register (founder,
          07.09). Same button, same code field, different sentence. */}
      {sellsEntry && (inAppEntry ? (
        <div className="space-y-1">
          <button
            type="button"
            onClick={() =>
              setCheckout({
                resumeId: listEntryInvoices().find(
                  (s) => s.host.toLowerCase() === islandHostname.toLowerCase(),
                )?.id,
              })
            }
            className="flex items-center justify-center w-full h-10 rounded-md bg-field hover:bg-line/40 text-accent text-sm font-semibold transition-colors"
          >
            {t(doorIsShut ? 'login.create.buy_entry' : 'login.create.buy_residency',
               { price: formatUsd(caps.entry_price_cents) })}
          </button>
          <p className="text-xs text-fg-dim leading-relaxed">{t('login.create.buy_entry_hint_inapp')}</p>
          <AnimatePresence>
            {checkout && (
              <EntryCheckout
                host={islandHostname}
                islandName={islandCardName || ''}
                priceDisplay={t('island.entry.price', { price: formatUsd(caps.entry_price_cents) })}
                tillUrl={tillUrl}
                termsUrl={caps.terms_url}
                resumeId={checkout.resumeId}
                onPaid={(voucher, id) => {
                  setInvite(voucher)
                  setCodeRevealed(true)
                  forgetEntryInvoice(id)
                  setCheckout(null)
                }}
                onClose={() => setCheckout(null)}
              />
            )}
          </AnimatePresence>
        </div>
      ) : canBuyEntry ? (
        <div className="space-y-1">
          <a
            href={entryUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="flex items-center justify-center w-full h-10 rounded-md bg-field hover:bg-line/40 text-accent text-sm font-semibold transition-colors"
          >
            {t(doorIsShut ? 'login.create.buy_entry' : 'login.create.buy_residency',
               { price: formatUsd(caps.entry_price_cents) })}
          </a>
          <p className="text-xs text-fg-dim leading-relaxed">{t('login.create.buy_entry_hint')}</p>
        </div>
      ) : (
        // The island charges for entry and does not say where it is sold. The
        // price is still worth printing: it is the one fact this screen would
        // otherwise never mention, and it tells the person the code they need
        // costs money rather than being something they forgot to be sent.
        <p className="text-xs text-fg-dim leading-relaxed">
          {t(doorIsShut ? 'login.create.entry_no_url' : 'login.create.residency_no_url',
             { price: formatUsd(caps.entry_price_cents) })}
        </p>
      ))}

      {/* The club door. Shown when the island says it is invite-only, and
          revealed by a refusal when it does not: an island can close while
          this tab is open, and an operator can hand a code out for a member
          they let in for free, not only for one who paid. */}
      {!showCode && sellsEntry && (
        <button
          type="button"
          onClick={() => setCodeRevealed(true)}
          className="self-start text-xs text-accent hover:underline"
        >
          {t('login.create.have_code')}
        </button>
      )}
      {showCode && (
        <div className="space-y-1">
          <label className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('login.create.invite')}
          </label>
          <input
            type="text"
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
            maxLength={128}
            placeholder={t('login.create.invite_placeholder')}
            className="w-full h-10 px-3 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
          <p className="text-xs text-fg-dim">
            {t(doorIsShut ? 'login.create.invite_hint' : 'login.create.invite_hint_paid')}
          </p>
        </div>
      )}

      {error && (
        <div className="text-sm text-red-500 bg-red-500/10 border border-red-500/25 rounded-md p-2">
          {error}
        </div>
      )}

      {/* Agreement to the terms and the privacy policy, with both a click
          away, before an account exists (founder, 05.09). */}
      {/* Small print, and it should LOOK like small print: it sat at body size
          in secondary text, which made the loudest thing under the form the
          one line nobody reads. Down to the size the field hints already use,
          and the links carry colour instead of an underline (founder, 07.09).
          The checkbox shrinks with it, or a 16px box next to 12px text reads
          as the subject of the sentence. */}
      <label className="flex items-start gap-2 text-[0.6875rem] leading-snug text-fg-dim cursor-pointer select-none">
        <input type="checkbox" className="mt-0.5 h-3 w-3 accent-accent" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
        <span>
          {t('login.terms.accept')}{' '}
          <a href="https://rcq.app/terms" target="_blank" rel="noreferrer" className="text-accent no-underline hover:underline underline-offset-2">{t('login.terms.terms')}</a>
          {' '}{t('login.terms.and')}{' '}
          <a href="https://rcq.app/privacy" target="_blank" rel="noreferrer" className="text-accent no-underline hover:underline underline-offset-2">{t('login.terms.privacy')}</a>
        </span>
      </label>
      <button
        onClick={submit}
        disabled={busy || !nickname.trim() || !accepted || (requireCode && !invite.trim())}
        className="w-full h-11 rounded-md bg-accent hover:bg-accent-dim text-white font-semibold disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
      >
        {busy && <Spinner />}
        {busy ? t('login.create.busy') : t('login.create.cta')}
      </button>

      <p className="text-xs text-fg-dim text-center leading-relaxed">{t('login.create.note' + dk)}</p>
    </div>
  )
}

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4 text-white" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  )
}

/// The island to create or recover on.
///
/// Collapsed to a single quiet line by default: the flagship is the right
/// answer for almost everyone, and a bare "server" field on a sign-up screen
/// asks a question most people cannot answer and makes the ones who can't feel
/// they are missing something. It opens for the ones who run their own.
/// ⚠ The pick is the CALLER's state, not this component's. It used to keep
/// `base` in its own `useState`, so choosing a closed island re-rendered the
/// row and nothing else: the form above it went on computing "does this island
/// want a code?" from the island the page opened with, and the code field
/// never appeared. It healed by accident on the next keystroke in the nickname
/// field, which is a hard bug to report and an easy one to disbelieve
/// (founder, 07.09).
function IslandField({ value, onChange }: { value: string; onChange: (next: IslandAddress) => void }) {
  const { t } = useI18n()
  const base = value
  const [open, setOpen] = useState(false)
  // ⚠ The HOOK, not a bare read of the cache. The cache alone paints the first
  // frame and then never moves, so an island whose name we learn a moment later
  // kept saying "ISLAND" until the page was loaded a second time.
  const islandName = useIslandCard(base).name

  // The desktop decides how the island is trusted BEFORE the first request to
  // it (docs/island-fingerprint-design.md §7.3). The remembered island is
  // asked on mount so the probe is done by the time the button is pressed;
  // the fetch wrapper would hold the request for it anyway.
  useEffect(() => {
    void engageIslandEagerly(base)
    // Once, for the island this page opened with; a pick below asks for its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])


  function commit(next: IslandAddress) {
    onChange(next)
    rememberIsland(next.base)
    // §3: a fingerprint typed with the address goes on file before anything is
    // dialled - the island card's request that follows this render waits on it
    // inside the wrapper. Against a record that disagrees it is a refusal with
    // the banner, and nothing is dialled until the person chooses.
    if (next.fingerprint) void prePinIsland(next.base, next.fingerprint)
    void engageIslandEagerly(next.base)
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 w-full rounded-md bg-field px-3 py-2 text-left hover:bg-line/50 transition-colors"
      >
        {/* Was a globe: the same picture whichever island you were about to
            join, which made the one line that says WHERE you are signing up
            say nothing at all. It carries the island's own face now, and its
            name above the host, both off the cache when we have talked to it
            before and both falling back to the lettered tile and the bare host
            when we have not. Same fix iOS made to its switcher pill. */}
        <IslandAvatar apiBase={base} size={28} />
        <span className="min-w-0 flex-1">
          <span className="block text-[0.6875rem] uppercase tracking-wide text-fg-dim">
            {islandName || t('login.island')}
          </span>
          <span className="block text-sm truncate">{islandLabel(base)}</span>
        </span>
        <span className="flex-none text-xs text-fg-dim">{t('login.island.change')}</span>
      </button>
      {open && (
        <IslandPickerModal current={base} onPick={commit} onClose={() => setOpen(false)} />
      )}
    </>
  )
}


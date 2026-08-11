// Entry point. Web is its own account model: a visitor creates a
// fresh in-browser account (its own UIN + keys). The old "Link from
// iOS" blob-paste flow was removed — it predated recovery phrases,
// only ever worked for iOS, and depended on an iOS QR screen that's
// disabled. Proper phone<->web linking (web as a secondary device) is
// a separate future feature; until then web is a standalone account.

import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import QRCode from 'qrcode'
import { LanguagePicker } from '../components/LanguagePicker'
import { ThemeToggle } from '../components/ThemeToggle'
import { Logo } from '../components/Logo'
import {
  DEFAULT_API_BASE,
  RecoverError,
  activateStoredIdentity,
  adoptLinkBlob,
  createNewAccount,
  currentRecoveryPhrase,
  listStoredIdentities,
  parseLinkBlob,
  recoverFromPhrase,
  suggestNickname,
} from '../lib/auth'
import { defaultHome } from '../lib/routing'
import { isTauri } from '../lib/desktop'
import { bytesToB64, newLinkEphemeral, openLinkSeal, type WebIdentity } from '../lib/crypto'
import { islandLabel, normaliseIsland, rememberIsland, rememberedIsland } from '../lib/island-choice'
import { useI18n } from '../lib/i18n-context'
import { useToast } from '../lib/toast'
import { useIdentity } from '../lib/identity-context'

export function Login() {
  const { setIdentity } = useIdentity()
  const navigate = useNavigate()
  const { t } = useI18n()

  // "Add account" in Settings clears the ACTIVE slot and lands here, with the
  // other accounts still in the roster. Until this existed there was no way
  // back: the only exits from this screen were creating or linking an account,
  // so a mistap forced you to make one. Any stored identity means we got here
  // from a signed-in session, so offer to go back to it.
  const [stored] = useState(() => listStoredIdentities())
  const resume = stored[0]

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-surface-dim px-4 py-6">
      {/* Floated out of flow so the form stays vertically CENTERED on
          mobile (the picker used to take a row at the top and push the
          content down). */}
      <div className="absolute top-4 right-4 z-10 flex items-center gap-1.5">
        <ThemeToggle />
        <LanguagePicker />
      </div>

      <div className="w-full flex items-center justify-center">
        <div className="w-full max-w-sm space-y-8">
          <header className="flex flex-col items-center gap-3 text-center">
            {/* Always-spinning brand mark (linear 30s), matches iOS. */}
            <Logo size={64} spin />
            <div className="text-2xl font-bold tracking-tight">{t('brand.name')}</div>
            <p className="text-fg-dim text-sm">{t('login.tagline')}</p>
          </header>

          <ModeSwitch
            onDone={(id) => {
              setIdentity(id)
              navigate(defaultHome(), { replace: true })
            }}
          />

          {resume && (
            <button
              type="button"
              onClick={() => {
                if (activateStoredIdentity(resume.uin)) window.location.assign('/')
              }}
              className="w-full text-center text-sm text-fg-secondary hover:text-fg-primary transition-colors"
            >
              {t('login.cancel_add').replace('{nick}', `#${resume.uin}`)}
            </button>
          )}
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
  const [mode, setMode] = useState<'create' | 'recover' | 'link'>('create')
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
        {tab('create', t('login.mode.create'))}
        {tab('recover', t('login.mode.recover'))}
        {tab('link', t('login.mode.link'))}
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
          <span className="font-mono text-[10px] text-fg-dim w-5 text-right shrink-0">{i + 1}</span>
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

  async function submit() {
    setError(null)
    setBusy(true)
    try {
      const id = await recoverFromPhrase(phrase, rememberedIsland())
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
      <p className="text-sm text-fg-secondary">{t('login.recover.body')}</p>
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
      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>
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
    // X25519 pubkey to seal the account to + `c` = the client kind, so the
    // phone's Linked-devices list can label this session "Desktop" vs "Web"
    // (it hardcoded "Web" before, since the QR carried no hint). Old phones
    // ignore `c` and keep the "Web" fallback — backward compatible.
    const client = isTauri() ? 'Desktop' : 'Web'
    const payload = `rcq://link?t=${token}&k=${encodeURIComponent(bytesToB64(eph.pub))}&c=${client}`
    void QRCode.toDataURL(payload, { width: 240, margin: 1, errorCorrectionLevel: 'M' }).then((u) => {
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
      <p className="text-sm text-fg-secondary">{t('login.link.scan_body')}</p>
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
        <p className="text-xs text-fg-dim leading-relaxed">{t('login.link.security_note')}</p>
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
  const [pending, setPending] = useState<{ id: WebIdentity; words: string[] } | null>(null)

  async function submit() {
    setError(null)
    setBusy(true)
    try {
      const id = await createNewAccount(nickname, rememberedIsland())
      const words = currentRecoveryPhrase()
      if (words) setPending({ id, words })
      else onDone(id) // shouldn't happen for a fresh account; fail open
    } catch (e) {
      const detail = e instanceof Error ? e.message : 'unknown'
      setError(t('auth.error.register_failed', { detail }))
    } finally {
      setBusy(false)
    }
  }

  if (pending) {
    return (
      <div className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{t('login.phrase.title')}</h2>
          <p className="text-sm text-fg-secondary leading-relaxed">{t('login.phrase.body')}</p>
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
          {t('login.phrase.warning')}
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
      <p className="text-sm text-fg-secondary">{t('login.create.body')}</p>

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

      <IslandField />

      {error && (
        <div className="text-sm text-red-600 bg-red-500/10 rounded-md p-2">
          {error}
        </div>
      )}

      <button
        onClick={submit}
        disabled={busy || !nickname.trim()}
        className="w-full h-11 rounded-md bg-accent hover:bg-accent-dim text-white font-semibold disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
      >
        {busy && <Spinner />}
        {busy ? t('login.create.busy') : t('login.create.cta')}
      </button>

      <p className="text-xs text-fg-dim text-center leading-relaxed">{t('login.create.note')}</p>
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
function IslandField() {
  const { t } = useI18n()
  const [base, setBase] = useState(() => rememberedIsland())
  const [draft, setDraft] = useState(() => islandLabel(rememberedIsland()))
  const [open, setOpen] = useState(() => rememberedIsland() !== DEFAULT_API_BASE)
  const custom = base !== DEFAULT_API_BASE

  /// Settle what was typed into a usable base URL. On blur and on submit, not
  /// on every keystroke: normalising as you type means an empty field fills
  /// itself back in and a half-typed host is rewritten under the cursor.
  function commit(text: string) {
    const next = normaliseIsland(text)
    setBase(next)
    setDraft(islandLabel(next))
    rememberIsland(next)
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 w-full rounded-md bg-field px-3 py-2 text-left hover:bg-line/50 transition-colors"
      >
        <GlobeIcon />
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] uppercase tracking-wide text-fg-dim">{t('login.island')}</span>
          <span className="block text-sm font-mono truncate">{islandLabel(base)}</span>
        </span>
        <span className="flex-none text-xs text-fg-dim">{t('login.island.change')}</span>
      </button>
    )
  }

  return (
    <div className="rounded-md bg-field px-3 py-2.5 space-y-2">
      <div className="flex items-center gap-2">
        <GlobeIcon />
        <span className="text-[11px] uppercase tracking-wide text-fg-dim flex-1">{t('login.island')}</span>
        {custom && (
          <button
            type="button"
            onClick={() => commit('')}
            className="text-xs text-fg-dim hover:text-fg-secondary transition-colors"
          >
            {t('login.island.reset')}
          </button>
        )}
      </div>
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit((e.target as HTMLInputElement).value)
          }
        }}
        placeholder={islandLabel(DEFAULT_API_BASE)}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        className="w-full h-9 px-3 rounded-md bg-surface outline-none focus:ring-1 focus:ring-accent text-sm font-mono"
      />
      <p className="text-xs text-fg-dim">{t('login.island.hint')}</p>
    </div>
  )
}

function GlobeIcon() {
  return (
    <svg className="flex-none text-fg-secondary" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z" />
    </svg>
  )
}

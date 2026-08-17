// Emoticon-aware text renderer — splices inline GIFs into a chat
// bubble's text. Mirrors iOS `EmoticonText`. Each token gets a
// stable React key (index is fine; the same string always
// tokenises to the same sequence).
//
// It also carries @-mentions, because this is the single place every bubble's
// text goes through — the reply snippet, the forward preview and the message
// body all render here, so a mention painted anywhere else would be a mention
// missing somewhere else. The feature is opt-in through `mention`: without that
// prop this component behaves exactly as it always did, which is what the
// snippets and previews want.

import type { ReactNode } from 'react'
import { tokenize, emoticonAssetURL } from '../lib/emoticons'
import { matchMentionAt, type MentionRoster } from '../lib/mentions'

export interface MentionContext {
  /// Everyone who can be named here. Empty for a 1:1 thread, where only the
  /// `#<uin>` form is meaningful.
  roster: MentionRoster[]
  /// Display name for a `#<uin>`, when we know one.
  nickOf: (uin: number) => string | null
  /// Opening a mentioned person. Not called for yourself.
  onOpen: (uin: number) => void
  /// My own number, so my own name is not a link to my own profile.
  meUin: number
  /// Which bubble this text is sitting in. The accent is the same green the
  /// outgoing bubble is tinted with, so an accent-coloured name inside my own
  /// message was green on green and all but disappeared — visible in the first
  /// screenshot of this feature. Inside a self bubble the mention keeps the
  /// bubble's own text colour and earns its emphasis from weight and an
  /// underline instead.
  tone?: 'self' | 'other'
}

interface Props {
  text: string
  /// Size of inline emoticon GIFs, written the way the call sites think
  /// about it — pixels at the default root size. Rendered in rem, so a
  /// smiley grows with the text around it when the reader raises the text
  /// size (#477) instead of shrinking into the line.
  ///
  /// Defaults to slightly larger than the surrounding text so the smiley
  /// reads as part of the flow without dwarfing it.
  emoticonSize?: number
  className?: string
  /// Present in a real message bubble; absent in snippets and previews.
  mention?: MentionContext
}

/// Split one plain-text run into nodes, turning `@nick` and `#uin` into
/// clickable names. Everything that does not resolve stays literal text — a
/// `#123` for someone who is not here must not become a link to a stranger,
/// and a bare '@' in an email address must not swallow the rest of the line.
function withMentions(text: string, ctx: MentionContext, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  let buf = ''
  let k = 0
  const flush = () => {
    if (buf) {
      out.push(<span key={`${keyBase}t${k++}`}>{buf}</span>)
      buf = ''
    }
  }
  const push = (uin: number, label: string) => {
    flush()
    const mine = uin === ctx.meUin
    const look =
      ctx.tone === 'self'
        ? 'font-semibold underline decoration-1 underline-offset-2 hover:opacity-80'
        : 'font-medium text-accent hover:text-accent-dim'
    // ⚠ A <span>, not a <button>. The message bubble around this is itself a
    // <button> (it opens the actions menu), and a button inside a button is
    // invalid HTML — React says so out loud and the browser is free to lift the
    // inner one out of the outer, which is how a mention ends up rendered
    // outside its own sentence. Keyboard access is kept by hand instead.
    out.push(
      <span
        key={`${keyBase}m${k++}`}
        role={mine ? undefined : 'link'}
        tabIndex={mine ? undefined : 0}
        onClick={(e) => {
          e.stopPropagation()
          if (!mine) ctx.onOpen(uin)
        }}
        onKeyDown={(e) => {
          if (mine) return
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          e.stopPropagation()
          ctx.onOpen(uin)
        }}
        className={`${look} transition-colors ${mine ? 'cursor-default' : 'cursor-pointer'}`}
      >
        {label}
      </span>,
    )
  }

  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '@' && ctx.roster.length > 0) {
      const m = matchMentionAt(text, i, ctx.roster)
      if (m) {
        push(m.uin, '@' + text.slice(i + 1, i + 1 + m.length))
        i += 1 + m.length
        continue
      }
    } else if (ch === '#') {
      const digits = /^#(\d{3,})/.exec(text.slice(i))
      if (digits) {
        const uin = Number(digits[1])
        const nick = ctx.nickOf(uin)
        if (nick) {
          push(uin, nick)
          i += digits[0].length
          continue
        }
      }
    }
    buf += ch
    i++
  }
  flush()
  return out
}

export function EmoticonText({ text, emoticonSize = 18, className = '', mention }: Props) {
  const side = `${emoticonSize / 16}rem`
  const tokens = tokenize(text)
  return (
    <span className={`whitespace-pre-wrap break-words ${className}`}>
      {tokens.map((tok, i) => {
        if (tok.kind === 'text') {
          if (mention) return <span key={i}>{withMentions(tok.text, mention, `${i}-`)}</span>
          return <span key={i}>{tok.text}</span>
        }
        return (
          <img
            key={i}
            src={emoticonAssetURL(tok.asset)}
            alt={tok.code}
            title={tok.code}
            style={{ width: side, height: side }}
            className="inline-block align-middle mx-0.5 object-contain"
            draggable={false}
          />
        )
      })}
    </span>
  )
}

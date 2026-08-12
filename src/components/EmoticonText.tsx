// Emoticon-aware text renderer — splices inline GIFs into a chat
// bubble's text. Mirrors iOS `EmoticonText`. Each token gets a
// stable React key (index is fine; the same string always
// tokenises to the same sequence).

import { tokenize, emoticonAssetURL } from '../lib/emoticons'

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
}

export function EmoticonText({ text, emoticonSize = 18, className = '' }: Props) {
  const side = `${emoticonSize / 16}rem`
  const tokens = tokenize(text)
  return (
    <span className={`whitespace-pre-wrap break-words ${className}`}>
      {tokens.map((tok, i) => {
        if (tok.kind === 'text') return <span key={i}>{tok.text}</span>
        return (
          <img
            key={i}
            src={emoticonAssetURL(tok.asset)}
            alt={tok.code}
            title={tok.code}
            style={{ width: side, height: side }}
            className="inline-block align-middle mx-0.5"
            draggable={false}
          />
        )
      })}
    </span>
  )
}

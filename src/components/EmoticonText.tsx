// Emoticon-aware text renderer — splices inline GIFs into a chat
// bubble's text. Mirrors iOS `EmoticonText`. Each token gets a
// stable React key (index is fine; the same string always
// tokenises to the same sequence).

import { tokenize, emoticonAssetURL } from '../lib/emoticons'

interface Props {
  text: string
  /// Pixel size of inline emoticon GIFs; defaults to slightly larger
  /// than the surrounding text so the smiley reads as part of the
  /// flow without dwarfing it.
  emoticonSize?: number
  className?: string
}

export function EmoticonText({ text, emoticonSize = 18, className = '' }: Props) {
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
            width={emoticonSize}
            height={emoticonSize}
            className="inline-block align-middle mx-0.5"
            draggable={false}
          />
        )
      })}
    </span>
  )
}

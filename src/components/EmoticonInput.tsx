// A composer that shows the kolobok instead of `:cool:`.
//
// This was a <textarea>, which cannot hold an image at all, so the one place in
// the app where you are actually LOOKING at your emoticons was the one place
// they stayed as codes. A contenteditable can, at the cost of owning the caret
// by hand — hence the care below. Everything downstream still speaks plain
// text: `serialize` walks the DOM back into `:code:` form, so the wire format,
// the drafts map and every other client are untouched.
//
// ⚠ Deliberately NOT an <img>-in-textarea trick or a mirrored overlay. Both
// desync the moment the text wraps, and a composer that disagrees with its own
// caret is worse than one that shows codes.

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { ENTRIES, emoticonAssetURL, tokenize } from '../lib/emoticons'

interface Props {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onArrowUpEmpty?: () => void
  onBlur?: () => void
  /// A screenshot in the clipboard is the commonest way to send an image on a
  /// desktop, so a paste that carries a file goes to the caller instead of the
  /// field.
  onPasteImage?: (file: File) => void
  placeholder: string
  className?: string
  emoticonSize?: number
  disabled?: boolean
}

/// DOM → the plain text everything else in the app uses.
export function serialize(root: HTMLElement): string {
  let out = ''
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      out += n.nodeValue ?? ''
      return
    }
    if (n instanceof HTMLImageElement) {
      out += n.dataset.code ?? ''
      return
    }
    if (n instanceof HTMLBRElement) {
      out += '\n'
      return
    }
    // A contenteditable makes divs when you press Enter; each one starts a line.
    if (n instanceof HTMLElement && n !== root && getComputedStyle(n).display === 'block' && out && !out.endsWith('\n')) {
      out += '\n'
    }
    n.childNodes.forEach(walk)
  }
  root.childNodes.forEach(walk)
  return out
}

function emoticonImg(asset: string, code: string, size: number): HTMLImageElement {
  const img = document.createElement('img')
  img.src = emoticonAssetURL(asset)
  img.alt = code
  img.title = code
  img.dataset.code = code
  // rem, not the width/height attributes: `size` is pixels at the default root
  // size, and the composer has to track the reader's text size like everything
  // else does (#477). Pinned in px, the smiley the user just inserted would
  // stay put while the text around it grew.
  img.style.width = `${size / 16}rem`
  img.style.height = `${size / 16}rem`
  img.draggable = false
  img.className = 'inline-block align-middle mx-0.5'
  return img
}

/// Plain text → the nodes that render it. Used to seed the field and to restore
/// a draft; never on every keystroke, which would fight the caret.
function paint(root: HTMLElement, text: string, size: number) {
  root.textContent = ''
  for (const tok of tokenize(text)) {
    if (tok.kind === 'text') {
      // Split on newlines so a multi-line draft comes back as lines.
      const parts = tok.text.split('\n')
      parts.forEach((part, i) => {
        if (i > 0) root.appendChild(document.createElement('br'))
        if (part) root.appendChild(document.createTextNode(part))
      })
    } else {
      root.appendChild(emoticonImg(tok.asset, tok.code, size))
    }
  }
}

export const EmoticonInput = forwardRef<HTMLDivElement, Props>(function EmoticonInput(
  {
    value,
    onChange,
    onSubmit,
    onArrowUpEmpty,
    onBlur,
    onPasteImage,
    placeholder,
    className = '',
    emoticonSize = 20,
    disabled = false,
  },
  forwarded,
) {
  const ref = useRef<HTMLDivElement>(null)
  useImperativeHandle(forwarded, () => ref.current as HTMLDivElement, [])
  // What we last reported upward. Repainting on every render would reset the
  // caret to the start on each keystroke, so the field is repainted ONLY when
  // the value changed somewhere else (a draft restored, a send clearing it).
  const lastEmitted = useRef<string>('')

  useEffect(() => {
    const el = ref.current
    if (!el || value === lastEmitted.current) return
    paint(el, value, emoticonSize)
    lastEmitted.current = value
  }, [value, emoticonSize])

  function emit() {
    const el = ref.current
    if (!el) return
    const text = serialize(el)
    lastEmitted.current = text
    onChange(text)
  }

  /// Turn a just-completed `:code:` into its picture.
  ///
  /// Runs on input rather than on send, because the whole point is seeing it
  /// while you type. Only ever looks at the text immediately BEFORE the caret,
  /// so it cannot rewrite anything the user is not currently touching.
  function convertBeforeCaret() {
    const el = ref.current
    const sel = window.getSelection()
    if (!el || !sel || sel.rangeCount === 0 || !sel.isCollapsed) return
    const range = sel.getRangeAt(0)
    const node = range.startContainer
    if (node.nodeType !== Node.TEXT_NODE) return
    const before = (node.nodeValue ?? '').slice(0, range.startOffset)
    const hit = ENTRIES.find((e) => before.endsWith(e.code))
    if (!hit) return

    const start = range.startOffset - hit.code.length
    const textNode = node as Text
    const after = textNode.splitText(start)
    after.nodeValue = (after.nodeValue ?? '').slice(hit.code.length)
    const img = emoticonImg(hit.asset, hit.code, emoticonSize)
    after.parentNode?.insertBefore(img, after)

    const r = document.createRange()
    r.setStartAfter(img)
    r.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r)
  }

  return (
    <div
      ref={ref}
      contentEditable
      role="textbox"
      aria-multiline="true"
      suppressContentEditableWarning
      data-placeholder={placeholder}
      onInput={() => {
        convertBeforeCaret()
        emit()
      }}
      onBlur={() => {
        // A safety net for any path that got a code in without the caret sitting
        // where the live converter can see it — a drag-and-drop, an autofill, an
        // IME commit. Repainting is free here: focus has left, so there is no
        // caret to fight over.
        const el = ref.current
        if (el) {
          const text = serialize(el)
          if (tokenize(text).some((t) => t.kind === 'emoticon') && !el.querySelector('img')) {
            paint(el, text, emoticonSize)
            lastEmitted.current = text
          }
        }
        onBlur?.()
      }}
      onPaste={(e) => {
        const file = Array.from(e.clipboardData.items)
          .find((i) => i.kind === 'file' && i.type.startsWith('image/'))
          ?.getAsFile()
        if (file && onPasteImage) {
          e.preventDefault()
          onPasteImage(file)
          return
        }
        // Plain text only. Pasting rich HTML into a field whose contents become
        // a wire message is how a composer starts carrying fonts and colours
        // nobody asked for, and the receiving end cannot render any of it.
        e.preventDefault()
        const text = e.clipboardData.getData('text/plain')
        document.execCommand('insertText', false, text)
        convertBeforeCaret()
        emit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey || e.metaKey)) {
          // Explicit, not left to the contenteditable's default: WebView2 was
          // reported swallowing it outright («ни Enter ни Ctrl+Enter никак» —
          // #799), and Ctrl+Enter never worked anywhere. Both chords now
          // insert a line break; bare Enter still sends.
          e.preventDefault()
          if (!document.execCommand('insertLineBreak')) {
            document.execCommand('insertText', false, '\n')
          }
          emit()
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          onSubmit()
          return
        }
        if (e.key === 'ArrowUp' && onArrowUpEmpty && serialize(e.currentTarget).trim() === '') {
          e.preventDefault()
          onArrowUpEmpty()
        }
      }}
      className={`rcq-composer ${className} ${disabled ? 'pointer-events-none opacity-50' : ''}`}
    />
  )
})

/// Insert an emoticon at the caret of a live composer element, or at its end
/// when the caret is elsewhere. Exported so the picker can reach the field the
/// user is actually typing in.
export function insertEmoticonAt(root: HTMLElement, asset: string, code: string, size = 20) {
  const img = emoticonImg(asset, code, size)
  const sel = window.getSelection()
  const inside = sel && sel.rangeCount > 0 && root.contains(sel.getRangeAt(0).startContainer)
  if (inside) {
    const range = sel!.getRangeAt(0)
    range.deleteContents()
    range.insertNode(img)
    const r = document.createRange()
    r.setStartAfter(img)
    r.collapse(true)
    sel!.removeAllRanges()
    sel!.addRange(r)
  } else {
    root.appendChild(img)
    const r = document.createRange()
    r.setStartAfter(img)
    r.collapse(true)
    sel?.removeAllRanges()
    sel?.addRange(r)
  }
  root.focus()
}

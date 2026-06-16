// KOLOBOK emoticon palette — appended into the composer when the
// user clicks the smiley button. Default Kolobok set is always shown;
// every cosmetic pack the user has equipped layers on as its own
// section so picker behavior matches iOS exactly.
//
// Picker animates in via framer-motion (slide-up + fade) — chat-bar
// is the entry-point and the user explicitly asked for a smooth
// reveal rather than a hard toggle.

import { motion } from 'framer-motion'
import {
  PALETTE,
  emoticonAssetURL,
  type PaletteEntry,
} from '../lib/emoticons'
import { useI18n } from '../lib/i18n-context'

interface Props {
  onPick: (primaryCode: string) => void
}

export function EmoticonPicker({ onPick }: Props) {
  const { t } = useI18n()
  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.97 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-2xl overflow-hidden border border-line bg-surface shadow-lg"
    >
      <div className="max-h-56 overflow-y-auto p-2 space-y-2">
        <Section title={t('chat.picker.section.base')}>
          <Grid items={PALETTE} onPick={onPick} />
        </Section>
      </div>
    </motion.div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="px-1 pb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-fg-dim">
        {title}
      </div>
      {children}
    </div>
  )
}

function Grid({ items, onPick }: { items: PaletteEntry[]; onPick: (code: string) => void }) {
  return (
    <div className="grid grid-cols-8 gap-1.5">
      {items.map((p) => (
        <button
          key={p.asset}
          onClick={() => onPick(p.primaryCode)}
          title={`${p.name}  ${p.primaryCode}`}
          className="w-9 h-9 flex items-center justify-center hover:bg-surface-dim rounded-md transition-colors"
        >
          <img
            src={emoticonAssetURL(p.asset)}
            alt={p.name}
            width={28}
            height={28}
            draggable={false}
          />
        </button>
      ))}
    </div>
  )
}

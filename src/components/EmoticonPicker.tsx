// Composer emoticon panel. The panel shows the user's OWN chosen kolobok set
// (curated in the config sheet), and is EMPTY by default with a "Choose" CTA —
// matching the iOS/Android picker. An "Edit" affordance reopens the curation
// sheet. Picking a kolobok appends its `:asset:` code into the composer.
//
// Animates in via framer-motion (slide-up + fade) from the chat bar.

import { useState } from 'react'
import { motion } from 'framer-motion'
import { emoticonAssetURL, panelPaletteFor, type PaletteEntry } from '../lib/emoticons'
import { usePanelAssets } from '../lib/emoticon-choices'
import { EmoticonConfigSheet } from './EmoticonConfigSheet'
import { useI18n } from '../lib/i18n-context'

interface Props {
  uin: number
  onPick: (primaryCode: string) => void
}

export function EmoticonPicker({ uin, onPick }: Props) {
  const { t } = useI18n()
  const [showConfig, setShowConfig] = useState(false)
  const panel = panelPaletteFor(usePanelAssets(uin))
  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 8, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.97 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="rounded-2xl overflow-hidden bg-surface shadow-lg"
      >
        {panel.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
            <p className="text-xs text-fg-secondary">{t('chat.picker.empty.hint')}</p>
            <button
              onClick={() => setShowConfig(true)}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-dim"
            >
              {t('chat.picker.empty.choose')}
            </button>
          </div>
        ) : (
          <div className="max-h-56 overflow-y-auto p-2">
            <div className="flex items-center justify-between px-1 pb-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-dim">
                {t('chat.picker.section.base')}
              </span>
              <button
                onClick={() => setShowConfig(true)}
                className="text-[11px] font-semibold text-accent hover:underline"
              >
                {t('chat.picker.edit')}
              </button>
            </div>
            <Grid items={panel} onPick={onPick} />
          </div>
        )}
      </motion.div>
      <EmoticonConfigSheet uin={uin} open={showConfig} onClose={() => setShowConfig(false)} />
    </>
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
          className="w-9 h-9 flex items-center justify-center hover:bg-field rounded-md transition-colors"
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

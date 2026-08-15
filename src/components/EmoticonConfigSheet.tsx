// The single curation window for the kolobok picker (port of iOS
// EmoticonPickerSheet / Android EmojiPickerDialog). One modal, two selectable
// sections: the composer PANEL set and the quick REACTIONS (<=6). Selection is
// a green tint only (no checkmark/badge). Every tap persists immediately via
// emoticon-choices, so there is no explicit save — "Done" just closes.

import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { PALETTE, PANEL_CAP, REACTION_CAP, emoticonAssetURL } from '../lib/emoticons'
import {
  usePanelAssets,
  useReactionAssets,
  togglePanelAsset,
  toggleReactionAsset,
} from '../lib/emoticon-choices'
import { useI18n } from '../lib/i18n-context'

interface Props {
  uin: number
  open: boolean
  onClose: () => void
}

export function EmoticonConfigSheet({ uin, open, onClose }: Props) {
  const { t } = useI18n()
  const [tab, setTab] = useState<'panel' | 'reactions'>('panel')
  const panel = usePanelAssets(uin)
  const reactions = useReactionAssets(uin)
  const active = tab === 'panel' ? panel : reactions
  const activeSet = useMemo(() => new Set(active), [active])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          role="dialog"
          aria-modal="true"
        >
          <div className="absolute inset-0 bg-black/40 backdrop-blur-md" onClick={onClose} />
          <motion.div
            className="relative z-10 w-full max-w-md bg-surface shadow-xl rounded-t-2xl sm:rounded-2xl"
            initial={{ y: 24, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 24, opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="flex items-center justify-between px-4 pt-4">
              <h3 className="text-base font-semibold text-fg-primary">{t('chat.picker.config.title')}</h3>
              <button
                onClick={onClose}
                className="rounded-md px-3 py-1 text-sm font-semibold text-accent transition-colors hover:bg-field"
              >
                {t('common.done')}
              </button>
            </div>

            {/* Segmented tabs with live counts */}
            <div className="mx-4 mt-3 grid grid-cols-2 gap-1 rounded-lg bg-ink-black/[0.05] p-1">
              <button
                onClick={() => setTab('panel')}
                className={`rounded-md py-1.5 text-sm font-medium transition-colors ${
                  tab === 'panel' ? 'bg-surface text-fg-primary shadow-sm' : 'text-fg-secondary'
                }`}
              >
                {t('chat.picker.tab.panel')} {panel.length}/{PANEL_CAP}
              </button>
              <button
                onClick={() => setTab('reactions')}
                className={`rounded-md py-1.5 text-sm font-medium transition-colors ${
                  tab === 'reactions' ? 'bg-surface text-fg-primary shadow-sm' : 'text-fg-secondary'
                }`}
              >
                {t('chat.picker.tab.reactions')} {reactions.length}/{REACTION_CAP}
              </button>
            </div>

            <p className="px-4 pt-2 text-xs text-fg-secondary">
              {t(tab === 'panel' ? 'chat.picker.hint.panel' : 'chat.picker.hint.reactions')}
            </p>

            {/* Grid of every kolobok; selection = green tint, no checkmark */}
            <div className="max-h-[46vh] overflow-y-auto p-3">
              <div className="grid grid-cols-8 gap-1.5">
                {PALETTE.map((p) => {
                  const selected = activeSet.has(p.asset)
                  return (
                    <button
                      key={p.asset}
                      onClick={() =>
                        tab === 'panel'
                          ? togglePanelAsset(uin, p.asset)
                          : toggleReactionAsset(uin, p.asset)
                      }
                      title={p.name}
                      className={`flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
                        selected ? 'bg-accent/30' : 'hover:bg-surface-dim'
                      }`}
                    >
                      <img
                        src={emoticonAssetURL(p.asset)}
                        alt={p.name}
                        width={28}
                        height={28}
                        draggable={false}
                      />
                    </button>
                  )
                })}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

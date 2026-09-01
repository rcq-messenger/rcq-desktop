/// "My site": the other half of the browser. Pick the files, give the site a
/// name, publish — and the bundle is signed HERE with the account's own key
/// before the island sees a byte of it, which is what lets every reader pin
/// the site to that key (lib/site-publish, lib/sites).
///
/// One site per account, the same rule the island enforces, so this is a
/// single thing you either have or do not — not a list.

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import {
  SITE_LIMITS, bundlePaths, checkName, deleteSite, isAllowedFile, mySites, pickIcon, publishSite,
  type MySite,
} from '../lib/site-publish'

interface Props {
  onClose: () => void
  /// Open the published site in the browser behind this panel.
  onOpen: (name: string) => void
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function MySitePanel({ onClose, onOpen }: Props) {
  const { t } = useI18n()
  const { identity } = useIdentity()
  const [site, setSite] = useState<MySite | null>(null)
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [nameState, setNameState] = useState<'free' | 'taken' | 'invalid' | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const [title, setTitle] = useState('')
  const [listed, setListed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const pick = useRef<HTMLInputElement | null>(null)

  const reload = useCallback(async () => {
    if (!identity) return
    setLoading(true)
    const rows = await mySites(identity)
    const first = rows[0] ?? null
    setSite(first)
    if (first) {
      setName(first.name)
      setTitle(first.title ?? '')
      setListed(first.listed)
    }
    setLoading(false)
  }, [identity])

  useEffect(() => { void reload() }, [reload])

  // The name is checked as it is typed, but only once it could be a name at
  // all: an island should not be asked about every keystroke of "b", "bl".
  useEffect(() => {
    if (!identity || site || name.length < 2) { setNameState(null); return }
    const id = window.setTimeout(() => { void checkName(identity, name).then(setNameState) }, 350)
    return () => window.clearTimeout(id)
  }, [identity, name, site])

  const paths = bundlePaths(files)
  const rejected = paths.filter((p) => !isAllowedFile(p))
  const oversize = files.filter((f) => f.size > SITE_LIMITS.maxFileBytes)
  const total = files.reduce((n, f) => n + f.size, 0)
  const hasIndex = paths.includes('index.html')
  const icon = pickIcon(paths)
  const canPublish =
    !busy && files.length > 0 && hasIndex && rejected.length === 0 && oversize.length === 0 &&
    files.length <= SITE_LIMITS.maxFiles && total <= SITE_LIMITS.maxBundleBytes &&
    /^[a-z0-9][a-z0-9-]{0,31}$/.test(name) && (site != null || nameState === 'free')

  async function publish() {
    if (!identity || !canPublish) return
    setBusy(true)
    setError(null)
    try {
      const out = await publishSite(identity, { name, files, title, listed })
      setSite(out)
      setFiles([])
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'failed'
      const file = (e as { file?: string }).file
      setError(t(`sites.publish.error.${code}`) + (file ? ` (${file})` : ''))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!identity || !site) return
    setBusy(true)
    const ok = await deleteSite(identity, site.name)
    setBusy(false)
    setConfirmDelete(false)
    if (!ok) { setError(t('sites.publish.error.failed')); return }
    setSite(null)
    setName('')
    setFiles([])
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.16 }}
        onClick={onClose}
        className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-md sm:items-center"
      >
        <motion.div
          initial={{ y: 16, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 16, opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-md max-h-[80vh] flex flex-col rounded-t-xl sm:rounded-xl bg-surface shadow-lg overflow-hidden"
        >
          <header className="flex items-center justify-between gap-2 px-4 py-3 shrink-0">
            <span className="text-sm font-semibold">{t('sites.mine')}</span>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common.close')}
              className="text-fg-secondary hover:text-fg-primary px-1"
            >
              ✕
            </button>
          </header>

          <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 space-y-4">
            {loading && <div className="text-xs text-fg-dim py-6 text-center">{t('sites.loading')}</div>}

            {!loading && site && (
              <div className="rounded-lg bg-field px-3 py-3 space-y-1">
                <button
                  type="button"
                  onClick={() => onOpen(site.name)}
                  className="text-sm font-mono text-fg-primary hover:text-accent"
                >
                  {site.name}.rcq
                </button>
                <div className="text-xs text-fg-secondary">
                  {t('sites.publish.version', { n: site.version })} · {fmtSize(site.size_bytes)}
                  {site.listed ? ` · ${t('sites.publish.listed_yes')}` : ''}
                </div>
                {site.frozen && (
                  <div className="text-xs text-red-400">{t('sites.error.frozen')}</div>
                )}
              </div>
            )}

            {!loading && (
              <>
                <label className="block space-y-1">
                  <span className="text-xs text-fg-secondary">{t('sites.publish.name')}</span>
                  <div className="flex items-center gap-2">
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                      // The name is the address, and an address that changes is
                      // a different site: once published, it is fixed here.
                      disabled={site != null}
                      spellCheck={false}
                      placeholder="blog"
                      className="flex-1 h-9 px-3 rounded-md bg-field text-fg-primary text-sm font-mono outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
                    />
                    <span className="text-sm font-mono text-fg-dim">.rcq</span>
                  </div>
                  {!site && nameState && (
                    <span className={`text-xs ${nameState === 'free' ? 'text-fg-secondary' : 'text-red-400'}`}>
                      {t(`sites.publish.name.${nameState}`)}
                    </span>
                  )}
                </label>

                <label className="block space-y-1">
                  <span className="text-xs text-fg-secondary">{t('sites.publish.title')}</span>
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value.slice(0, 80))}
                    className="w-full h-9 px-3 rounded-md bg-field text-fg-primary text-sm outline-none focus:ring-1 focus:ring-accent"
                  />
                </label>

                <div className="space-y-2">
                  <input
                    ref={pick}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => { setFiles(Array.from(e.target.files ?? [])); setError(null) }}
                  />
                  <button
                    type="button"
                    onClick={() => pick.current?.click()}
                    className="w-full h-9 rounded-md bg-field text-sm text-fg-primary hover:bg-line/40"
                  >
                    {t('sites.publish.pick')}
                  </button>
                  <p className="text-[0.6875rem] text-fg-dim leading-relaxed">{t('sites.publish.rules')}</p>
                  {files.length > 0 && (
                    <div className="space-y-1">
                      {paths.map((p) => (
                        <div key={p} className="flex items-center justify-between gap-2 text-xs">
                          <span className={`truncate font-mono ${isAllowedFile(p) ? 'text-fg-secondary' : 'text-red-400'}`}>{p}</span>
                          <span className="text-fg-dim flex-none">{fmtSize(files[paths.indexOf(p)]?.size ?? 0)}</span>
                        </div>
                      ))}
                      {/* Said out loud, because it is a file name doing a job:
                          whichever of these is in the set becomes the mark
                          shown beside the address in every list. */}
                      <div className="text-xs text-fg-dim">
                        {icon ? t('sites.publish.icon.found', { file: icon }) : t('sites.publish.icon.none')}
                      </div>
                      {!hasIndex && <div className="text-xs text-red-400">{t('sites.publish.error.no_index')}</div>}
                      {rejected.length > 0 && <div className="text-xs text-red-400">{t('sites.publish.error.bad_type')}</div>}
                      {(oversize.length > 0 || total > SITE_LIMITS.maxBundleBytes) && (
                        <div className="text-xs text-red-400">{t('sites.publish.error.file_too_large')}</div>
                      )}
                    </div>
                  )}
                </div>

                <label className="flex items-start gap-2 text-xs text-fg-secondary">
                  <input
                    type="checkbox"
                    checked={listed}
                    onChange={(e) => setListed(e.target.checked)}
                    className="mt-0.5"
                  />
                  {/* Being in the catalogue is a decision, not a default: a site
                      outside it opens by its exact name and is listed nowhere. */}
                  <span>{t('sites.publish.listed')}</span>
                </label>

                {error && <div className="text-xs text-red-400">{error}</div>}

                <button
                  type="button"
                  onClick={() => void publish()}
                  disabled={!canPublish}
                  className="w-full h-10 rounded-md bg-accent text-white text-sm font-medium disabled:opacity-50"
                >
                  {busy ? t('sites.publish.busy') : site ? t('sites.publish.update') : t('sites.publish.cta')}
                </button>

                {site && (
                  confirmDelete ? (
                    <div className="space-y-2">
                      {/* Said once, plainly: what a delete does and does not
                          reach. Nobody can un-read what readers already have. */}
                      <p className="text-xs text-fg-secondary">{t('sites.publish.delete.body')}</p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => void remove()}
                          className="flex-1 h-9 rounded-md bg-red-500/15 text-red-400 text-sm"
                        >
                          {t('sites.publish.delete.confirm')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(false)}
                          className="flex-1 h-9 rounded-md bg-field text-sm text-fg-secondary"
                        >
                          {t('common.cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                      className="w-full h-9 rounded-md text-sm text-red-400 hover:bg-red-500/10"
                    >
                      {t('sites.publish.delete')}
                    </button>
                  )
                )}
              </>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

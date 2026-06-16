// i18n context. Holds the active language code, exposes a `t()`
// translator and `setLanguage()` setter. Persistence in localStorage
// (key `rcq.web.language`) so the choice survives reloads.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { detectInitialLang, dictFor, translate, type Dict, type LangCode } from '../i18n'

interface I18nCtx {
  lang: LangCode
  setLanguage: (l: LangCode) => void
  t: (key: string, params?: Record<string, string | number>) => string
}

const Ctx = createContext<I18nCtx | undefined>(undefined)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<LangCode>(() => detectInitialLang())
  const dict: Dict = useMemo(() => dictFor(lang), [lang])

  const setLanguage = useCallback((l: LangCode) => {
    setLang(l)
    localStorage.setItem('rcq.web.language', l)
  }, [])

  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => translate(dict, key, params),
    [dict],
  )

  const value = useMemo<I18nCtx>(() => ({ lang, setLanguage, t }), [lang, setLanguage, t])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useI18n(): I18nCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useI18n called outside I18nProvider')
  return v
}

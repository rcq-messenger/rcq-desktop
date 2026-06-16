// i18n core. Mirrors the iOS `LanguageManager` enum and locale-file
// layout: 15 languages declared, each with a code that matches the
// iOS `lproj` directory name and a native display name. Phase-1
// ships full dicts only for `en` + `ru`; the others fall back to
// `en` at lookup time. Adding a new full translation = drop a new
// `<code>.ts` next to `en.ts` and append to `LOCALES` below.

import { en } from './en'
import { ru } from './ru'

export type Dict = Record<string, string>

/// Languages we plan to ship, same order + native names as the iOS
/// `AppLanguage` enum. Codes double as the storage value and the
/// `lproj` folder name on iOS so the two clients agree.
export const LANGUAGES = [
  { code: 'en', native: 'English' },
  { code: 'ru', native: 'Русский' },
  { code: 'es', native: 'Español' },
  { code: 'pt', native: 'Português' },
  { code: 'fr', native: 'Français' },
  { code: 'de', native: 'Deutsch' },
  { code: 'it', native: 'Italiano' },
  { code: 'tr', native: 'Türkçe' },
  { code: 'pl', native: 'Polski' },
  { code: 'uk', native: 'Українська' },
  { code: 'zh-Hans', native: '简体中文' },
  { code: 'ja', native: '日本語' },
  { code: 'ko', native: '한국어' },
  { code: 'ar', native: 'العربية' },
  { code: 'hi', native: 'हिन्दी' },
] as const

export type LangCode = (typeof LANGUAGES)[number]['code']

/// Available dicts. Codes that don't appear here read from `en`.
const DICTS: Partial<Record<LangCode, Dict>> = {
  en,
  ru,
}

/// Find the dict for a language code; fall back to English. Used by
/// the i18n provider on every render. The fallback isn't per-key —
/// once the active dict is picked, missing keys still resolve via
/// the same `t()` lookup against `en`.
export function dictFor(lang: LangCode): Dict {
  return DICTS[lang] ?? en
}

/// Translate a key with optional `{name}` interpolation. If the
/// active dict doesn't have it, fall back to English; if neither
/// does, return the key itself so a missing entry surfaces visibly
/// in the UI instead of rendering as an empty string.
export function translate(
  active: Dict,
  key: string,
  params?: Record<string, string | number>,
): string {
  const raw = active[key] ?? en[key] ?? key
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (_, name) =>
    params[name] != null ? String(params[name]) : `{${name}}`,
  )
}

/// Pick a sensible default at first launch — match iOS behaviour:
/// honour the browser's preferred language if we ship it, else
/// English.
export function detectInitialLang(): LangCode {
  const stored = localStorage.getItem('rcq.web.language')
  if (stored && LANGUAGES.some((l) => l.code === stored)) return stored as LangCode
  const navLang = (navigator.languages?.[0] ?? navigator.language ?? 'en').toLowerCase()
  // Match by full code first (zh-Hans) then by primary subtag (en, ru).
  for (const l of LANGUAGES) {
    if (l.code.toLowerCase() === navLang) return l.code
  }
  const primary = navLang.split('-')[0]
  for (const l of LANGUAGES) {
    if (l.code.toLowerCase() === primary) return l.code
  }
  return 'en'
}

// Language picker — used both on the Login splash and inside
// Settings. Wraps the shared Dropdown component so it matches the
// rest of the surface in light + dark mode and across browsers
// (native <select> ignored our palette and looked off in dark).

import { LANGUAGES, type LangCode } from '../i18n'
import { useI18n } from '../lib/i18n-context'
import { Dropdown, type DropdownOption } from './Dropdown'

interface Props {
  variant?: 'pill' | 'row'
}

export function LanguagePicker({ variant = 'pill' }: Props) {
  const { lang, setLanguage } = useI18n()
  const options: DropdownOption<LangCode>[] = LANGUAGES.map((l) => ({
    value: l.code,
    label: l.native,
  }))
  const active = LANGUAGES.find((l) => l.code === lang)
  return (
    <Dropdown<LangCode>
      value={lang}
      options={options}
      onChange={setLanguage}
      ariaLabel="Language"
      variant={variant}
      triggerLabel={active?.native}
      panelWidthClass={variant === 'pill' ? 'right-0 w-44' : undefined}
    />
  )
}

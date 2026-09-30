import { locales, t, type Locale } from './i18n';
export const languageNames: Record<Locale, string> = { en: 'English', ru: 'Русский', kk: 'Қазақша' };
export function Language({ locale, onChange }: { locale: Locale; onChange: (locale: Locale) => void }) {
  return <label className="language-control"><span>{t(locale, 'Language')}</span><select data-testid="locale-select" value={locale} onChange={event => onChange(event.target.value as Locale)}>{locales.map(value => <option key={value} value={value} lang={value}>{languageNames[value]}</option>)}</select></label>;
}

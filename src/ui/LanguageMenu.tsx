import type { JSX } from "react";
import { LOCALES, getLocale, switchLocale, tr, type Locale } from "../i18n/index.ts";
import "./language-menu.css";

/** Language switch for top bars and menus. Choosing a language reloads the page (see i18n/index.ts). */
export function LanguageMenu(props: { className?: string }): JSX.Element {
  const current = getLocale();
  return (
    <label className={`pc-lang ${props.className ?? ""}`} title={tr("Language")} data-pc="language-menu">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.400 5.600 12 3z" />
      </svg>
      <span className="pc-lang-name">{LOCALES.find((l) => l.id === current)?.label}</span>
      <select aria-label={tr("Language")} value={current} onChange={(e) => switchLocale(e.target.value as Locale)}>
        {LOCALES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
      </select>
    </label>
  );
}

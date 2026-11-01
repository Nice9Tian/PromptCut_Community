import table from "./table.json" with { type: "json" };

/**
 * Interface language. English is the source language: the text in the code is the lookup key
 * into table.json, which holds the Chinese and Japanese for each English string.
 *
 * The language is fixed for the life of the page. It is read once, before anything else asks
 * for text, and switching it reloads the page. That is what makes tr() safe to call at module
 * level (menus and option lists are module constants) without a re-render subscription.
 *
 * Text drawn into a rendered frame must never go through tr(): the same project has to render
 * the same pixels on every machine, whatever language its interface is in.
 */
export type Locale = "en" | "zh-CN" | "ja";

export const LOCALES: ReadonlyArray<{ id: Locale; label: string }> = [
  { id: "en", label: "English" },
  { id: "zh-CN", label: "简体中文" },
  { id: "ja", label: "日本語" },
];

const STORAGE_KEY = "pc.locale";

/** Maps a BCP 47 tag to a supported language. Traditional Chinese falls back to zh-CN. */
export function matchLocale(tag: string): Locale | null {
  const lower = tag.toLowerCase();
  if (lower.startsWith("zh")) return "zh-CN";
  if (lower.startsWith("ja")) return "ja";
  if (lower.startsWith("en")) return "en";
  return null;
}

/** Order: ?lang= in the address (probes and screenshots), the saved choice, the browser's list, English */
function detectLocale(): Locale {
  if (typeof document === "undefined") return "en"; // Node: tests and the server always use the source text
  const fromUrl = new URLSearchParams(location.search).get("lang");
  if (fromUrl) {
    const hit = matchLocale(fromUrl);
    if (hit) return hit;
  }
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && LOCALES.some((l) => l.id === saved)) return saved as Locale;
  } catch {
    // ignore
  }
  for (const tag of navigator.languages ?? []) {
    const hit = matchLocale(tag);
    if (hit) return hit;
  }
  return "en";
}

const locale = detectLocale();
if (typeof document !== "undefined") document.documentElement.lang = locale;

export function getLocale(): Locale {
  return locale;
}

/**
 * Saves the choice and reloads, which is the only way the language changes (see the file header).
 * `url` is where the page comes back to: callers with a project open point it at that project.
 */
export function switchLocale(next: Locale, url: URL = new URL(location.href)): void {
  if (next === locale) return;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // ignore
  }
  url.searchParams.delete("lang");
  location.replace(url);
}

type Row = { zh: string; ja: string };
const rows = table as Record<string, Row>;

/** Pure lookup, so tests can cover every language without a page. */
export function translate(target: Locale, source: string, args: ReadonlyArray<unknown> = []): string {
  const row = Object.hasOwn(rows, source) ? rows[source] : undefined;
  const text = (target === "zh-CN" ? row?.zh : target === "ja" ? row?.ja : undefined) || source;
  if (args.length === 0) return text;
  return text.replace(/\{(\d+)\}/g, (hole, index: string) => (Number(index) < args.length ? String(args[Number(index)]) : hole));
}

/**
 * Text for the interface. `{0}`, `{1}` in the source are filled from `args`.
 * A string missing from the table shows as English rather than failing.
 */
export function tr(source: string, ...args: ReadonlyArray<unknown>): string {
  return translate(locale, source, args);
}

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
  // Node: tests and the server always use the source text, even when a test fakes a document
  if (typeof document === "undefined" || typeof location === "undefined" || typeof navigator === "undefined") return "en";
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

/*
 * State shared with server/i18n.mjs through a global, so the page does not import from server/ and
 * server code does not import from src/: this page's language, the lookup, and the rows added with
 * addRows(). In Node the language here is English; requests bring their own.
 */
const shared = ((globalThis as Record<symbol, any>)[Symbol.for("promptcut.i18n")] ??= { translate: null, known: new Set(["en"]), locale: "en" });
shared.extra ??= {};
shared.version ??= 0;

/**
 * Rows kept outside table.json, for code that ships its own table. They are looked up after
 * table.json, which wins when both have the same English. server/i18n.mjs has the same function
 * for server code; a row added on either side is found by both.
 */
export function addRows(more: Record<string, Row>): void {
  Object.assign(shared.extra, more);
  shared.version++;
}

/**
 * Card names, parameter labels and other text that comes from card code or project data may still
 * be the Chinese original. Those are found by their Chinese wording, so the same tr() call keeps
 * working before and after that code is translated.
 */
let byChinese = new Map<string, string>();
let builtFor = -1;
function rowOf(source: string): [string | undefined, Row | undefined] {
  const extra: Record<string, Row> = shared.extra;
  if (Object.hasOwn(rows, source)) return [source, rows[source]];
  if (Object.hasOwn(extra, source)) return [source, extra[source]];
  if (builtFor !== shared.version) {
    // table.json goes in last, so its rows win when an added row has the same Chinese
    byChinese = new Map([...Object.entries(extra), ...Object.entries(rows)].map(([en, row]) => [row.zh, en]));
    builtFor = shared.version;
  }
  const en = byChinese.get(source);
  return en === undefined ? [undefined, undefined] : [en, Object.hasOwn(rows, en) ? rows[en] : extra[en]];
}

/** Tells the server which language to answer in (server/i18n.mjs). Installed once, from main.tsx. */
export function installLocaleHeader(): void {
  const send = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return send(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("x-pc-locale", locale);
    return send(input, { ...init, headers });
  };
}

/** Pure lookup, so tests can cover every language without a page. */
export function translate(target: Locale, source: string, args: ReadonlyArray<unknown> = []): string {
  const [key, row] = rowOf(source);
  const text = (target === "en" ? key : target === "zh-CN" ? row?.zh : row?.ja) || source;
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

// Server modules that also run in the page (server/auth/client.mjs, server/render-node/) translate
// through server/i18n.mjs, with this page's language and this lookup
shared.translate = translate;
shared.known = new Set(LOCALES.map((l) => l.id));
shared.locale = locale;

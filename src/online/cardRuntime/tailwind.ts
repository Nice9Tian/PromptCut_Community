/**
 * Tailwind class names used by synced cards are generated on the fly in the page
 * (`docs/plan/online-card-exec-contract.md` Section 2).
 *
 * The stylesheet for the online bundle is fixed at build time (containing only class names scanned
 * at build time); synced cards arrive later, and new class names they use (such as `text-[137px]`)
 * are not included. Here, the bundled Tailwind compiler generates two layers based on candidate
 * class names appearing in closure source code: used theme variables (`@layer theme`) and utility
 * classes (`@layer utilities`), without generating the base layer (already present in the page).
 * Layer order is declared first by the page's own stylesheet, and incoming layers with matching
 * names are merged in.
 *
 * Extracting candidate class names follows the same approach as Tailwind's own file scanning:
 * treat source code as plain text, split on whitespace and quotes, and let the compiler discard
 * non-class names. Thus matching extra tokens is harmless; quoted arbitrary values
 * (`content-['a']`) cannot be extracted, and such syntax has no styles online (scope note).
 *
 * The two style texts required by the compiler (Tailwind's `theme.css` and `utilities.css`) are
 * supplied by the caller: imported via `?raw` in the browser (`transpile.browser.ts`), and read
 * from `node_modules` in unit tests.
 */
import { compile } from "tailwindcss";
import { tr } from "../../i18n/index.ts";

/** Maximum candidate count extracted for a single card (guards against corrupt data) */
export const MAX_CANDIDATES = 20_000;

/** Source code → candidate class names (deduplicated, in order of appearance) */
export function classCandidates(sources: Iterable<string>, limit = MAX_CANDIDATES): string[] {
  const out = new Set<string>();
  for (const source of sources) {
    for (const piece of String(source ?? "").split(/[\s"'`]+/)) {
      if (!piece || piece.length > 200) continue;
      // Strip punctuation clinging to both ends (`className={cn(`, `},`, `;`); `:` `/` `[` `]` `(` `)`
      // in the middle belong to class names themselves
      const c = piece.replace(/^[^A-Za-z0-9[\-!@*]+/, "").replace(/[^A-Za-z0-9\])%!]+$/, "");
      if (!c || !/[A-Za-z]/.test(c)) continue;
      out.add(c);
      if (out.size >= limit) return [...out];
    }
  }
  return [...out];
}

export interface TailwindSources {
  /** Text of `tailwindcss/theme.css` */
  theme: string;
  /** Text of `tailwindcss/utilities.css` */
  utilities: string;
}

export type CardCssCompiler = (candidates: readonly string[]) => Promise<string>;

const ENTRY = [
  "@layer theme, base, components, utilities;",
  '@import "tailwindcss/theme.css" layer(theme);',
  '@import "tailwindcss/utilities.css" layer(utilities) source(none);',
].join("\n");

/**
 * Create a compiler. Each card is compiled separately (Tailwind's `build` accumulates candidates
 * across runs; if a single instance were shared, later-compiled cards would carry styles from
 * earlier-compiled cards, causing output for the same card to vary with compilation order); each
 * run takes ~10-20 ms. Returns an empty string when no candidates are class names.
 */
export function createCardCssCompiler(sources: TailwindSources): CardCssCompiler {
  const fresh = () => compile(ENTRY, {
    base: "/",
    loadStylesheet: async (id: string, base: string) => {
      if (id === "tailwindcss/theme.css") return { path: "tailwindcss/theme.css", base, content: sources.theme };
      if (id === "tailwindcss/utilities.css") return { path: "tailwindcss/utilities.css", base, content: sources.utilities };
      throw new Error(tr("The online page has no such stylesheet: {0}", id));
    },
  });
  // Output when no candidates are given (only layer declarations and copyright comments): subsequent
  // outputs equal to it are treated as "no styles"
  let empty: Promise<string> | null = null;
  return async (candidates) => {
    if (!candidates.length) return "";
    empty ??= fresh().then((c) => c.build([]));
    const css = (await fresh()).build([...candidates]);
    return css === (await empty) ? "" : css;
  };
}

/**
 * Whole-scene id renaming in step 5 of snapshot generation (see `createSnapshot.ts` file header):
 * rename each id collected in the whole scene HTML to `${id}__r`, and synchronously update
 * `url(#…)` / `href="#…"` references.
 *
 * The original implementation ran three regular expressions for each id, each scanning the entire
 * HTML (see `renameSceneIdsSequential` below), which becomes quadratic as elements with ids
 * increase: ~6.5 s for 1,400 elements with ids (`docs/reports/AGENT-c10-probe.md` "Corroboration").
 * Now each of the three regexes scans once, checking a lookup table at each match to decide whether
 * to rename, making the whole pass linear. **The output is byte-for-byte identical to the original
 * implementation**; see `renameSceneIds.test.mjs` for side-by-side tests (where the original
 * implementation is copied verbatim as a reference).
 *
 * # Why table lookup produces the same result as sequentially renaming each id
 *
 * The three regexes used by the original implementation for an id `X` were:
 *
 *   `(\sid=")X(")`      `(url\((?:&quot;|["'])?[^)"'&]*#)X((?:&quot;|["'])?\))`      `((?:xlink:)?href="#)X(")`
 *
 * When `X` contains none of `"'()&#$=` or whitespace (hereafter "normal id"):
 *
 *   - At every matchable position, `X` can only be an entire segment there: from after `id="` /
 *     `href="#` up to the next `"`; for `url(`, it is from after the last `#` in that run of
 *     `[^)"'&]` to the end of the string. Scanning that segment at each position in one pass and
 *     checking if it is in the set of ids determines "which id matches here".
 *   - Renaming merely appends `__r` to the end of that segment. Neither `__r` nor normal ids
 *     contain any of the characters above, so appending it neither creates nor destroys other
 *     match positions; match positions of the three regexes are pairwise non-overlapping.
 *     Therefore, neither the order of the three passes nor that of individual ids affects the
 *     result. **The only exception is chained renaming**: when the set contains both `a` and
 *     `a__r`, with `a` preceding, the original code first renames `a` to `a__r`, and renames it
 *     again to `a__r__r` when reaching `a__r`. `finalNames` precomputes this chain in set order
 *     and directly yields the final destination during table lookup.
 *   - The `id=` and `href=` regexes use lookbehind to avoid consuming prefixes: the original
 *     implementation scanned for each `X` individually, so it could still see prefixes even when
 *     one fell within another match's range (e.g. ` id=" id="a"` in text). The `url(` regex
 *     consumes prefixes as before: multiple `url(` instances embedded in the same string end at
 *     the same position and capture the same segment.
 *
 * If even a single id in the set is not a normal id (contains quotes, parentheses, `&`, `#`, `$`, 
 * `=`, or whitespace), the entire pass falls back to the original implementation: these characters
 * invalidate the reasoning above (e.g. `$` has special meaning in replacement strings), whereas ids
 * in real cards (such as React 19's `_r_0_`, `grad-x`) are all normal ids.
 * Except for whitespace, every character has a counterexample in unit tests (removing any exclusion
 * breaks `renameSceneIds.test.mjs`); no counterexample was found for whitespace, and excluding it
 * is merely conservative.
 *
 * Pure string function with no DOM access: imported directly by Node unit tests.
 */

/** Characters not permitted in a normal id (see file header) */
const NOT_PLAIN = /[\s"'()&#$=]/;

/**
 * Original implementation: per-id, with three regexes each scanning the entire string. Falls
 * back here for non-normal ids; do not modify it: it is the definition of the output.
 */
export function renameSceneIdsSequential(html: string, ids: Iterable<string>): string {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const id of ids) {
    const e = esc(id);
    html = html
      .replace(new RegExp(`(\\sid=")${e}(")`, "g"), `$1${id}__r$2`)
      .replace(new RegExp(`(url\\((?:&quot;|["'])?[^)"'&]*#)${e}((?:&quot;|["'])?\\))`, "g"), `$1${id}__r$2`)
      .replace(new RegExp(`((?:xlink:)?href="#)${e}(")`, "g"), `$1${id}__r$2`);
  }
  return html;
}

/**
 * Final destination name of each id after sequential renaming: `a` is first renamed to `a__r`;
 * if `a__r` is ordered after `a` in the set, it gets renamed again when reached, and so on.
 * Computed in reverse order, looking only one step ahead for each id.
 */
function finalNames(list: readonly string[]): Map<string, string> {
  const index = new Map<string, number>();
  list.forEach((id, i) => index.set(id, i));
  const out = new Map<string, string>();
  for (let i = list.length - 1; i >= 0; i--) {
    const next = list[i] + "__r";
    const k = index.get(next);
    out.set(list[i], k !== undefined && k > i ? out.get(next)! : next);
  }
  return out;
}

const ID_ATTR_RE = /(?<=\sid=")[^"]*(?=")/g;
const HREF_RE = /(?<=href="#)[^"]*(?=")/g;
const URL_RE = /(url\((?:&quot;|["'])?[^)"'&]*#)([^)"'&#]*)(?=(?:&quot;|["'])?\))/g;

/**
 * Rename ids in the whole scene HTML. The order of `ids` must match the original implementation
 * (in `createSnapshot`, document order from `querySelectorAll("[id]")` with the root element's
 * id last, preserving deduplicated Set order): the outcome of chained renaming depends on it.
 */
export function renameSceneIds(html: string, ids: Iterable<string>): string {
  const list = [...ids];
  if (list.length === 0) return html;
  if (list.some((id) => NOT_PLAIN.test(id))) return renameSceneIdsSequential(html, list);
  const names = finalNames(list);
  return html
    .replace(ID_ATTR_RE, (m) => names.get(m) ?? m)
    .replace(URL_RE, (m, pre: string, id: string) => {
      const to = names.get(id);
      return to === undefined ? m : pre + to;
    })
    .replace(HREF_RE, (m) => names.get(m) ?? m);
}

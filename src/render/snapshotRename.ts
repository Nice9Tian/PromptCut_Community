/*
 * Snapshot id renaming on consumer side (A2(7)).
 *
 * Why do it on consumer side: the shared key for control snapshots deliberately strips clipId,
 * so the same snapshot can attach to multiple clips. If renamed by a specific clipId during
 * prerendering, two clips in the same document would collide on id:
 * `<linearGradient id={gradId}>` at growth-curve.tsx:104 would resolve to the first by id, and the
 * gradient of the later attached clip would be completely broken. Therefore, the prerender side
 * keeps the original id, and renaming is done according to whichever clip it attaches to.
 *
 * -- Probe conclusions (scripts/probes/svg-url-serialize-probe.mjs, 2026-09-17, Chrome 152 headless) --
 * The doubt was that `[^)"'&]*` in export-frames.mjs back then excluded `&`, while the export
 * page URL contains `&` ('/?export=1&timeline=' in frame-pipeline.mjs:183), fearing outerHTML would
 * serialize it as `&amp;` and miss it. Actual measurements (a growth-curve clip, page URL
 * http://127.0.0.1:5208/?export=1&timeline=data%3A…):
 *
 *   getAttribute("fill")   "url(#_r_0_)"
 *   getComputedStyle().fill "url(\"#_r_0_\")"      ← Relative form, Chrome does not prepend page URL
 *   outerHTML after snapshot generation            style="fill: url(&quot;#_r_0_&quot;);"
 *   The only two forms of url(…#…) appearing in the entire control after snapshot generation (516806 bytes):
 *       "url(#_r_0_)"  and  "url(&quot;#_r_0_&quot;)"
 *   No &amp; anywhere in the segment; not a single href="#…"; only one id: " id=\"_r_0_\""
 *   Both paths for collecting ids (browser DOMParser / Node regex scan) produce the same set on this real snapshot
 *
 * Conclusion: **no absolute form exists**, so concerns about `&` do not hold. In addition,
 * React 19's useId produces `_r_0_` (no longer `:r1:`), but renaming still matches against the raw
 * string without CSS.escape, so ids containing colons can still be renamed.
 *
 * Final regexes (loosened by one step compared to :215, and discarding the prefix):
 *   id attribute        /\sid=(["'])([^"']*)\1/
 *   href reference      /(?:xlink:)?href=(["'])#([^"']*)\1/
 *   url reference       /url\((&quot;|["'])?([^)"']*?)(&quot;|["'])?\)/   takes the fragment after the last `#` as id
 * Loosening the character class from `[^)"'&]*` to `[^)"']*` is defensive: if some day (in
 * another Chrome version or for another attribute) it actually serializes into an absolute form,
 * this will still match. Upon matching, the **entire prefix is discarded** and rewritten as
 * url(#newId): snapshots must be host-independent, as they will be mounted and used by other pages
 * (stage pages, with different ports and query strings).
 */

/** Replaces characters in clipId other than [A-Za-z0-9_-] with `_` to avoid odd characters in id */
export function safeClipId(clipId: string): string {
  return String(clipId).replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Serialization escaping for HTML attribute values. DOMParser returns the **decoded** id, while
 * renaming operates on the **raw string**; both sides must align to produce the same set as the
 * regex scanning path. Chrome's serializer escapes only these three items in attribute values.
 */
function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/ /g, "&nbsp;");
}

/** Collects ids via regex scan (used by Node unit tests, and in browser when DOMParser is absent) */
export function collectIdsByScan(html: string): Set<string> {
  const ids = new Set<string>();
  const re = /\sid=(["'])([^"']*)\1/g;
  for (let m = re.exec(html); m; m = re.exec(html)) if (m[2]) ids.add(m[2]);
  return ids;
}

/** Collects ids via DOMParser (browser path). Parsing a snapshot ≤ 300 KB is on the order of 1-3 ms */
export function collectIdsByParse(html: string, parser: DOMParser): Set<string> {
  const doc = parser.parseFromString(html, "text/html");
  const ids = new Set<string>();
  for (const el of doc.querySelectorAll("[id]")) {
    const id = el.getAttribute("id");
    if (id) ids.add(escapeAttr(id));
  }
  return ids;
}

/** Parses if DOMParser exists, scans if not (Node). Both paths produce the same set on the same input. */
export function collectIds(html: string): Set<string> {
  const P = (globalThis as { DOMParser?: new () => DOMParser }).DOMParser;
  return P ? collectIdsByParse(html, new P()) : collectIdsByScan(html);
}

/*
 * Scanned in a single pass: id attributes, href="#…" / xlink:href="#…", and url(…#…) anywhere
 * (including inline style="…").
 * If rewritten with three sequential regexes, the second might collide with a new id just produced
 * by the first; combining them into a single alternating regex and checking a table to decide
 * whether to rewrite avoids this issue.
 *
 * **Does not handle `#id` selectors in <style> text** (left unhandled just like `__r` in
 * export-frames.mjs on the prerender side back then).
 * Reason: control snapshots are the innerHTML of the card wrapper layer, and __pcCreateSnapshot has
 * already inlined the computed styles needed by each element into style attributes. Even if <style>
 * rules are still present, they are overridden by the inlined values, so renaming them or not does
 * not affect rendering; both <defs> across the repo are also written directly in the card's own
 * <svg> (growth-curve.tsx / chart-growth.tsx) rather than selected via stylesheets. Note that
 * `url(#id)` inside <style> text will instead be rewritten by the url branch below: this is safe
 * (renamed along with the element), pinned by unit tests.
 */
const REF_RE =
  /(?<idpre>\sid=(?<idq>["']))(?<idval>[^"']*)\k<idq>|(?<hpre>(?:xlink:)?href=(?<hq>["']))#(?<hval>[^"']*)\k<hq>|url\((?<q1>&quot;|["'])?(?<uref>[^)"']*?)(?<q2>&quot;|["'])?\)/g;

function rewrite(html: string, ids: Set<string>, suffix: string): string {
  if (ids.size === 0) return html;
  return html.replace(REF_RE, (match, ...rest) => {
    const g = rest[rest.length - 1] as Record<string, string | undefined>;
    if (g.idval !== undefined) {
      return ids.has(g.idval) ? `${g.idpre}${g.idval}${suffix}${g.idq}` : match;
    }
    if (g.hval !== undefined) {
      return ids.has(g.hval) ? `${g.hpre}#${g.hval}${suffix}${g.hq}` : match;
    }
    const ref = g.uref;
    if (ref === undefined) return match;
    const hash = ref.lastIndexOf("#");
    if (hash < 0) return match; // Things like url(/@media/…), not a fragment reference
    const id = ref.slice(hash + 1);
    if (!ids.has(id)) return match; // Not an id in this snapshot; do not touch
    // Drop the prefix entirely (in case it is absolute): snapshots will be mounted onto other pages
    // and cannot carry the prerender page's address
    const q = g.q1 ?? g.q2 ?? "";
    return `url(${q}#${id}${suffix}${q})`;
  });
}

/* -- Cache: do not re-parse the same snapshot for the same clip --------------------------- */

/** cyrb53: non-cryptographic, fast and well-distributed, only used as Map keys */
function cyrb53(s: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const CACHE_MAX = 256;
const cache = new Map<string, { html: string; clipId: string; out: string }>();
let hits = 0;
let misses = 0;

/** For unit tests: check whether the cache actually hit (two equal strings cannot be distinguished by ===) */
export function snapshotRenameCacheStats(): { size: number; hits: number; misses: number } {
  return { size: cache.size, hits, misses };
}

/** For unit tests */
export function clearSnapshotRenameCache(): void {
  cache.clear();
  hits = 0;
  misses = 0;
}

/**
 * Rewrite all ids in the snapshot html to `${id}__s${safe(clipId)}`, and synchronously update
 * url(#id) / href="#id" references.
 * Only modify ids collected in this html; leave other `#` fragments untouched.
 */
export function renameSnapshotIds(html: string, clipId: string): string {
  if (!html) return html;
  const key = `${cyrb53(html)}:${html.length}:${clipId}`;
  const hit = cache.get(key);
  // Even if hashes collide, there is no mix-up: compare the raw text character by character on hit
  if (hit && hit.html === html && hit.clipId === clipId) {
    hits++;
    cache.delete(key); // Reinsert at the end of the queue: evict the least recently used item, not the earliest inserted one
    cache.set(key, hit);
    return hit.out;
  }
  misses++;
  const out = rewrite(html, collectIds(html), `__s${safeClipId(clipId)}`);
  cache.set(key, { html, clipId, out });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return out;
}

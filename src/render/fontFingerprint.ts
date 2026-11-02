/**
 * Font fingerprint (I0): the entry in the shared snapshot key (A3a) representing "what fonts this
 * machine had on hand at the time".
 *
 * Definition: Deduplicated, sorted, newline-joined, and hashed family names in `document.fonts` that
 * are **loaded** (`status === 'loaded'`). Why these three steps:
 *   - Only take loaded ones: declared @font-face rules not yet actually downloaded do not affect
 *     typography of this frame;
 *   - Deduplicate: multiple weights/styles of the same family are multiple FontFaces, but typography
 *     resolves to the same family;
 *   - Sort: FontFaceSet iteration order depends on loading sequence; without sorting, two machines
 *     inevitably compute different keys.
 *
 * Use synchronous hashing (two rounds of FNV-1a, 16-character hex) instead of `crypto.subtle.digest`:
 * this value must be returned in synchronous evaluations like `window.__pcCardPlan()`, whereas
 * `subtle` is asynchronous. It is not used for security, only requiring deterministic results across
 * machines with collision probability low enough to ignore.
 */
export interface FontLike {
  family: string;
  status: string;
}

/** Loaded family names: deduplicated + sorted. This list is what actually gets hashed in the key. */
export function fontFamilyNames(fonts: Iterable<FontLike> | null | undefined): string[] {
  const names = new Set<string>();
  if (fonts && typeof (fonts as any)[Symbol.iterator] === "function") {
    for (const font of fonts) {
      if (!font || font.status !== "loaded") continue;
      const family = String(font.family ?? "").trim();
      if (family) names.add(family);
    }
  }
  return [...names].sort();
}

function fnv1a(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Pure function, does not touch `document`: stage page, export page, and tests each pass in their
 * own FontFaceSet. When no fonts have loaded, returns the hash of an empty list (a deterministic
 * value), not an empty string: "no fonts" and "not computed" must be two distinct things.
 */
export function fontFingerprintOf(fonts: Iterable<FontLike> | null | undefined): string {
  // JSON-escape each family name before joining: directly calling join("\n") would produce the same
  // string for a single font whose family name contains a newline as for two separate fonts
  // (`new FontFace("A\nB", …)` is valid).
  const list = fontFamilyNames(fonts).map(name => JSON.stringify(name)).join("\n");
  return fnv1a(list, 0x811c9dc5) + fnv1a(list, 0x9e3779b9);
}

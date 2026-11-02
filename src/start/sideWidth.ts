/**
 * Two bars whose width can be dragged: the project sidebar on the left and the side panel on the right
 * of the chat page. The width is recorded locally, so the next time it opens it keeps this width
 * (user decision, 2026-10-23).
 *
 * Why localStorage rather than following the account: this is a matter of "what feels comfortable on
 * this screen of this machine", and on a different computer the screen differs, so carrying it over
 * would be wrong. Reads and writes are both wrapped in try/catch: incognito windows and browsers with
 * site data disabled throw outright, and when it throws we act as if nothing was stored and use the
 * default width, so the first screen must never go blank (same pattern as how
 * `src/skins/useSkin.ts` reads `pc.skin`).
 */

export interface WidthSpec {
  /** Default width */
  def: number;
  /** Narrower than this and the text inside is pointless */
  min: number;
  /** Wider than this and the main area gets squeezed until it no longer fits */
  max: number;
  key: string;
}

/** The project sidebar on the left. `def` equals the flex-basis that used to be hard-coded in the CSS */
export const SIDE_WIDTH: WidthSpec = { def: 248, min: 190, max: 420, key: "pc.start.sideWidth" };

/** The side panel on the right of the chat page: narrower than this and the picture and the two before/after images can no longer be seen clearly */
export const EXT_WIDTH: WidthSpec = { def: 320, min: 250, max: 520, key: "pc.start.extWidth" };

export function clampWidth(spec: WidthSpec, px: number): number {
  if (!Number.isFinite(px)) return spec.def;
  return Math.min(spec.max, Math.max(spec.min, Math.round(px)));
}

export function readWidth(spec: WidthSpec): number {
  try {
    const saved = localStorage.getItem(spec.key);
    if (saved === null) return spec.def;
    const n = Number(saved);
    // Corrupted (edited by hand, or something else written by an old version): fall back to the default,
    // and do not write NaN into the style
    return Number.isFinite(n) ? clampWidth(spec, n) : spec.def;
  } catch {
    return spec.def;
  }
}

export function writeWidth(spec: WidthSpec, px: number): void {
  try {
    localStorage.setItem(spec.key, String(clampWidth(spec, px)));
  } catch {
    // If it cannot be saved, it only takes effect for this one opening, with no error
  }
}

/** Whether the sidebar is collapsed. Recorded locally just like the width: someone who collapsed it finds it still collapsed the next time they open */
const COLLAPSED_KEY = "pc.start.sideCollapsed";

export function readSideCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSideCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Same as above
  }
}

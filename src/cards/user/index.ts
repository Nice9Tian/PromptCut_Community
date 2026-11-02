import type { CardDef } from "../../kernel/types";
import { overlayModules, overlayRaws, overlayDependencyRaws } from "../userOverlay";

/**
 * Cards created later by user / AI. One file per card, placed in this directory; **no need to edit this file**.
 *
 * Why we auto-collect with a glob instead of handwritten import manifests like native: when AI
 * creates a card, it can only write to its own file (create_card only allows writing here); having it
 * also edit a shared registry easily causes breakage and conflicts with the sandbox premise of
 * "touch only one file at a time". A scan here means saving a new file → vite HMR → list_cards sees it immediately.
 */
const globModules = import.meta.glob<Record<string, unknown>>("./*.tsx", { eager: true });

/**
 * In installed builds (with a card overlay layer), user cards not originally on this machine exist
 * only in the overlay layer and are invisible to glob; card plugin lists them separately via
 * `../userOverlay` (see that file).
 * When merging, glob takes precedence for the same key (even when the base build also has it, what
 * the load hook yields is already the overlay layer copy); keys are sorted lexicographically, as
 * stable as when there is only glob.
 */
function withOverlay<T>(fromGlob: Record<string, T>, fromOverlay: Record<string, T>): Record<string, T> {
  if (Object.keys(fromOverlay).length === 0) return fromGlob;
  const merged: Record<string, T> = { ...fromOverlay, ...fromGlob };
  return Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
}
const modules = withOverlay(globModules, overlayModules);

/** Structural check: collect all named exports that look like CardDef */
function isCardDef(value: unknown): value is CardDef<any> {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<CardDef<any>>;
  return (
    typeof c.id === "string" &&
    typeof c.name === "string" &&
    typeof c.defaults === "object" &&
    Array.isArray(c.controls) &&
    // Media effect cards (card / audio) omit Component; host component renders on their
    // behalf; having any of the three counts as a card
    (typeof c.Component === "function" || typeof c.card === "function" || typeof c.audio === "function")
  );
}

/**
 * Raw source text of the same batch of files. When saving .proc, custom card source code used by the
 * project must be bundled together (see editor/io/procCards.ts), but saving to disk is synchronous
 * and cannot wait for a request; updated here alongside HMR, it always gets the current version on disk.
 */
const raws = withOverlay(import.meta.glob<string>("./*.tsx", { eager: true, query: "?raw", import: "default" }), overlayRaws);
const dependencyRaws = withOverlay(import.meta.glob<string>("./**/*.{ts,tsx,mjs,css}", { eager: true, query: "?raw", import: "default" }), overlayDependencyRaws);

const baseOf = (path: string) => path.replace(/^\.\//, "").replace(/\.tsx$/, "");

/** File name (excluding .tsx) → raw source text */
export const userCardFiles: Record<string, string> = Object.fromEntries(
  Object.entries(raws).map(([path, src]) => [baseOf(path), src]),
);

/** Raw dependency map for cache identity only.  Proc serialization still uses
 * userCardFiles, which deliberately contains authored card entry files only. */
export const userCardDependencies: Record<string, string> = Object.fromEntries(
  Object.entries(dependencyRaws).map(([file, source]) => [`/src/cards/user/${file.replace(/^\.\//, '')}`, source]),
);

/** Card id → file name defining it. Usually identical, but not necessarily for manually added files */
export const userCardFileOf: Record<string, string> = {};

export const userCards: CardDef<any>[] = Object.entries(modules).flatMap(([path, mod]) => {
  const found = Object.values(mod).filter(isCardDef);
  if (found.length === 0) {
    // Warn only, do not throw: a malformed card should not prevent the entire editor from starting up
    console.warn(`[cards/user] ${path} 里没有找到 CardDef 具名导出,已跳过`);
  }
  for (const def of found) userCardFileOf[def.id] = baseOf(path);
  return found;
});

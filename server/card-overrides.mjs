/**
 * Card source code belongs to "Data management" (`docs/archive/topics/decoupling-plan.md`
 * Section 3.2 "Data management → Cards", Stage 5).
 *
 * # Overlay layer
 *
 * In the installed version, the repository copy of card source code is in `runtime/app/src/...`,
 * but update patches **completely overwrite** runtime/app: built-in cards modified by an Agent
 * or user revert to their original state after an upgrade (`after-0.4-plan.md` P0 item 1).
 * Therefore, modifications in the installed version are not written back to original files, but
 * into the overlay layer inside the data directory:
 *
 *     <PROMPTCUT_DATA_DIR>/card-overrides/src/cards/...   (relative paths match original files one-to-one)
 *
 * During loading, the overlay layer takes priority (`load` hook of `vite-plugin-cards`), with
 * original files serving as a read-only base. Patches only replace the base. When an overlay
 * layer exists, not a single file is written to the checkout directory: user cards not originally
 * on this machine (`create_card`, opening `.proc`, content store synchronization) are also written
 * only into the overlay layer, and the user card loading entry receives them via
 * `src/cards/userOverlay.ts` (the card plugin lists them at load time and resolves imports for them).
 * Both standalone render hosts and desktop apps have overlay layers, so neither writes to the
 * checkout directory. During development (without `PROMPTCUT_DATA_DIR`), files in the repository
 * are modified directly as before: what is modified then is the source code itself.
 * `PROMPTCUT_CARD_OVERRIDES` can explicitly specify the overlay layer directory (for testing).
 *
 * # Card code hash
 *
 * Render cache keys must include "this card's code at this moment": previously keys only had clip
 * parameters; when card source code was modified, old prerendered images still hit the cache, and
 * the 3D view kept pasting the pre-modification appearance. The hash is computed from the
 * **effective content** (overlay layer preferred) of "the card definition file + all card / part
 * files it imports along the way", with the algorithm injected by `vite-plugin-cards` (which holds
 * the dependency closure); it is not inversely imported here to avoid mutual references between the
 * two plugins.
 *
 * # Change notifications
 *
 * Whenever card source code changes (whether modifying a repository file or the overlay layer),
 * subscribers receive notice: render workers drop standby pages accordingly: standby pages are
 * opened in advance, loading pre-modification modules.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Overlay layer root directory; null if absent (files in repository are modified directly
 * during development).
 */
export function overridesRoot() {
  if (process.env.PROMPTCUT_CARD_OVERRIDES) return path.resolve(process.env.PROMPTCUT_CARD_OVERRIDES);
  if (process.env.PROMPTCUT_DATA_DIR) return path.join(process.env.PROMPTCUT_DATA_DIR, "card-overrides");
  return null;
}

/** Only cards and parts enter the overlay layer; kernel, editor, and server are never exposed */
export function isOverridable(rel) {
  const r = String(rel).replace(/\\/g, "/");
  return r.startsWith("src/cards/") || r.startsWith("src/parts/");
}

function relOf(root, abs) {
  return path.relative(root, abs).replace(/\\/g, "/");
}

/**
 * Which file in the overlay layer corresponds to this repository file (regardless of existence);
 * null if unmodifiable or no overlay layer exists.
 */
export function overrideFileFor(root, abs) {
  const top = overridesRoot();
  if (!top) return null;
  const rel = relOf(root, abs);
  if (rel.startsWith("..") || !isOverridable(rel)) return null;
  return path.join(top, rel);
}

/** The effective file: uses overlay layer if present, otherwise original file */
export function effectivePath(root, abs) {
  const o = overrideFileFor(root, abs);
  return o && fs.existsSync(o) ? o : abs;
}

/** Reads effective content */
export function readEffective(root, abs) {
  return fs.readFileSync(effectivePath(root, abs), "utf8");
}

/**
 * Whether this repository file is a file when effective: present in the base or in the overlay
 * layer (user cards not originally on this machine and installed only into the overlay layer
 * are the latter).
 */
export function effectiveIsFile(root, abs) {
  try { return fs.statSync(effectivePath(root, abs)).isFile(); } catch { return false; }
}

/** User card directory (relative to repository root) */
export const USER_CARD_DIR = "src/cards/user";

/**
 * File names directly within the user card directory: union of base and overlay layer, in ascending order.
 * When an overlay layer exists, user cards not originally on this machine are written only to the overlay
 * layer and not to the checkout directory (see file header), so places collecting cards by directory must
 * inspect both sides together.
 */
export function userCardDirEntries(root) {
  const names = new Set();
  const read = (dir) => {
    try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isFile()) names.add(e.name); } catch { /* Directory does not exist */ }
  };
  read(path.join(root, USER_CARD_DIR));
  const top = overridesRoot();
  if (top) read(path.join(top, USER_CARD_DIR));
  return [...names].sort();
}

/**
 * Files in user card directory present in overlay layer but absent from base (recursive),
 * relative to user card directory, forward slashes, in ascending order.
 * The user card loading entry (`src/cards/user/index.ts`) collects cards via directory glob and only sees
 * real directories; these files are listed separately for it by the card plugin
 * (`src/cards/userOverlay.ts`). Returns an empty list when there is no overlay layer.
 */
export function overlayOnlyUserFiles(root) {
  const top = overridesRoot();
  if (!top) return [];
  const base = path.join(top, USER_CARD_DIR);
  const out = [];
  const walk = (dir) => {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of items) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) { walk(file); continue; }
      if (!e.isFile()) continue;
      const rel = path.relative(base, file).replace(/\\/g, "/");
      if (!fs.existsSync(path.join(root, USER_CARD_DIR, rel))) out.push(rel);
    }
  };
  walk(base);
  return out.sort();
}

/**
 * Writes a card / part file. Writes to overlay layer if present (original file untouched),
 * otherwise writes to original file.
 * Returns the path actually written to.
 */
export function writeCardFile(root, abs, content) {
  const o = overrideFileFor(root, abs);
  const target = o || abs;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

/** File in overlay layer → its corresponding repository file; null if not in overlay layer */
export function repoFileForOverride(root, file) {
  const top = overridesRoot();
  if (!top) return null;
  const rel = path.relative(top, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return path.join(root, rel);
}

let hasher = null;
/**
 * Injected by vite-plugin-cards: cardId → hash of this card's effective code
 * (returns empty string if card not found).
 */
export function setCardHasher(fn) {
  hasher = fn;
}

/**
 * Hash of this card's code at this moment. Empty string when no algorithm is injected
 * (legacy callers, tests): one less entry in the key, behaving as before.
 */
export function cardCodeHash(cardId) {
  if (!hasher || !cardId) return "";
  try { return hasher(String(cardId)) || ""; } catch { return ""; }
}

let identifier = null;
/**
 * Injected by vite-plugin-cards: cardId → code identity of this card `{ version, custom }`
 * (c66-host-cards, `server/card-code.mjs`).
 * Placed here for the same reason as `setCardHasher`: needed by the frame pipeline, but avoids
 * inversely importing the card plugin.
 */
export function setCardIdentifier(fn) {
  identifier = typeof fn === 'function' ? fn : null;
}

/**
 * Code identity of this card at this moment; returns null if definition not found,
 * undefined if algorithm is not yet injected (caller does not cache).
 */
export function cardCodeIdentityOf(cardId) {
  if (!identifier) return undefined;
  if (!cardId) return null;
  try { return identifier(String(cardId)) ?? null; } catch { return null; }
}

const listeners = new Set();
/** Notifies when card source code changes (parameter is the changed file) */
export function onCardSourceChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
/** Called by vite-plugin-cards in file watcher */
export function emitCardSourceChange(file) {
  for (const fn of listeners) {
    try { fn(file); } catch { /* An error in one subscriber does not affect others */ }
  }
}

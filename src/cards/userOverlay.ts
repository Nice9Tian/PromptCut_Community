/**
 * User cards present in the overlay layer but absent from the base build (`src/cards/user/` in
 * checkout).
 *
 * Installed builds (desktop, standalone render host) have a card overlay layer
 * (`server/card-overrides.mjs`): user cards not originally on this machine (from create_card,
 * opening .proc, or synced card source code) are written only into the overlay layer, writing
 * zero files to the checkout directory. `./user/index.ts` collects cards by directory using
 * `import.meta.glob` and only sees the real directory; these cards are listed separately for it by
 * this module.
 *
 * This file on disk is an empty table: it is used when there is no overlay layer (development,
 * online build). When an overlay layer is present, the card plugin's load hook
 * (`cardOverridesLoader` / `userOverlayModuleCode` in `server/vite-plugin-cards.ts`) replaces it with
 * the actual manifest, and reloads it whenever files are added or removed in the user cards
 * directory. Keys have the same shape as the glob in `./user/index.ts`:
 * `./<path relative to src/cards/user/>`.
 */
/** Module for entry cards (top-level .tsx) */
export const overlayModules: Record<string, Record<string, unknown>> = {};
/** Raw source text of entry cards */
export const overlayRaws: Record<string, string> = {};
/** Raw text of all source files (.ts / .tsx / .mjs / .css), used for cache identity */
export const overlayDependencyRaws: Record<string, string> = {};

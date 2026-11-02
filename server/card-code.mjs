/**
 * Card code identity (C6.6 c66-host-cards): user cards and cards modified in the overlay layer
 * no longer enter the global code version (`frame-code.mjs`); instead, a separate identity is
 * computed for "this card's code", used in three places:
 *
 *   1. **Task requirements**: fine-grained tasks that use these cards write
 *      `{ [cardId]: identity }` in `requires.cardSources` (`split.mjs`, contract B.4);
 *   2. **Node capabilities**: the node's `cardSourceVersions[cardId]` returns this card's identity
 *      on this machine right now, compared by rule 1 of `filter.mjs` during claim; if this machine
 *      does not have this code (does not have this card, or has a different version), it does not
 *      claim and reports no error; once installed, it can claim on the next tick;
 *   3. **Whole-scene key**: `frameIdentity`'s `code` = global code version + identities of these
 *      cards used in this project (`cardEntryCode`). The global code version no longer covers user
 *      cards; whole-scene frame store and local tier content keys (`<entry.key>/<shared key>`)
 *      rely on this segment to distinguish card code. Shared tier keys already include this card's
 *      source version (`sourceVersion` in `card-identity.mjs`), so they are unaffected.
 *
 * How identity is computed is injected by the caller
 * (`identityOf(cardId) → { version, custom } | null`, `cardCodeIdentity` in `vite-plugin-cards.ts`:
 * definition file plus all card / part files it imports along the way, overlay layer prioritized,
 * newlines normalized to LF). Only cards where `custom` is true (user cards, or cards with overlay
 * layer files in their closure) enter task requirements and whole-scene keys; unmodified built-in
 * cards are covered by the global code version.
 *
 * Caching: identities are cached per card; once card source code changes (`onCardSourceChange` in
 * `card-overrides.mjs`, emitted only after Vite itself invalidates the module), the entire table
 * is cleared and `epoch` is incremented. During the short window right after a change (`settleMs`),
 * the node reports no cards (the claiming side prefers being one tick late): newly written cards
 * must wait until Vite's file watcher invalidates the module before the new code is loaded during
 * prerender; claiming too early would render with the old code.
 *
 * Uses only Node built-in modules.
 */
import { createHash } from 'node:crypto';

/** How long after card source changes the node will not report any card identity (see file header) */
export const CARD_CODE_SETTLE_MS = 1500;

/**
 * Card ids used in the project (ascending): `cardId` of clips across all cuts (active `tracks`,
 * parked `cuts[].tracks`), as well as `cardId` of card graph nodes (`cardNodes`, array or object).
 * Criteria match `projectCardIds` on the page (`src/editor/sync/cardSync.ts`) minus the ownership
 * table entry (the ownership table is a local side table on this machine, not belonging to this
 * project version).
 */
export function projectCardIds(project) {
  const ids = new Set();
  const scan = (tracks) => {
    for (const track of Array.isArray(tracks) ? tracks : []) {
      for (const clip of Array.isArray(track?.clips) ? track.clips : []) {
        if (typeof clip?.cardId === 'string' && clip.cardId) ids.add(clip.cardId);
      }
    }
  };
  scan(project?.tracks);
  for (const cut of Array.isArray(project?.cuts) ? project.cuts : []) scan(cut?.tracks);
  const nodes = project?.cardNodes;
  const list = Array.isArray(nodes) ? nodes : nodes && typeof nodes === 'object' ? Object.values(nodes) : [];
  for (const node of list) if (typeof node?.cardId === 'string' && node.cardId) ids.add(node.cardId);
  return [...ids].sort();
}

/** Stable JSON with object keys sorted (handles `{ string: string }` only) */
const stableMap = (map) => JSON.stringify(Object.keys(map).sort().map((key) => [key, map[key]]));

/**
 * `code` for the whole-scene key: global code version followed by the digest of custom card
 * identities used in this project. When there are no custom cards, it is the global code version
 * itself.
 * @param {string} globalCode  `frameCode(root)`
 * @param {Record<string, string>} versions  `{ cardId: identity }` (result of `customVersions`)
 */
export function cardEntryCode(globalCode, versions) {
  const map = versions && typeof versions === 'object' ? versions : {};
  if (Object.keys(map).length === 0) return globalCode;
  return `${globalCode}:cards:${createHash('sha256').update(stableMap(map)).digest('hex').slice(0, 32)}`;
}

/**
 * @param {object} options
 * @param {(cardId: string) => ({ version: string, custom: boolean } | null | undefined)} options.identityOf
 *   Returning undefined indicates the algorithm is not ready yet; not cached
 * @param {() => number} [options.now]
 * @param {number} [options.settleMs]
 */
export function createCardCodeIndex({ identityOf, now = Date.now, settleMs = CARD_CODE_SETTLE_MS } = {}) {
  if (typeof identityOf !== 'function') throw new TypeError('createCardCodeIndex: identityOf must be a function');
  /** cardId → { version, custom } | null */
  const cache = new Map();
  let epoch = 0;
  let changedAt = -Infinity;

  function identity(cardId) {
    if (typeof cardId !== 'string' || !cardId) return null;
    if (cache.has(cardId)) return cache.get(cardId);
    let got;
    try { got = identityOf(cardId); } catch { got = null; }
    // undefined = algorithm not yet injected (cards plugin not yet up): do not cache, query again next
    // time
    if (got === undefined) return null;
    const value = got && typeof got.version === 'string' && got.version ? { version: got.version, custom: got.custom === true } : null;
    cache.set(cardId, value);
    return value;
  }

  /**
   * `{ cardId: identity }` for custom cards (user cards, modified cards) among these cards; cards
   * whose definitions cannot be found are omitted (left to global code version and executor checks)
   */
  function customVersions(cardIds) {
    const out = {};
    for (const id of cardIds ?? []) {
      const got = identity(id);
      if (got?.custom) out[id] = got.version;
    }
    return out;
  }

  const settled = () => now() - changedAt >= settleMs;

  /**
   * `cardSourceVersions` in the node description (`Record<cardId, string[]>` of contract B.2):
   * computed on the fly for whichever card is requested. Always returns an empty array when card
   * source code has just changed and not yet settled (see file header).
   */
  const view = new Proxy(Object.create(null), {
    get(_target, key) {
      if (typeof key !== 'string') return undefined;
      if (!settled()) return [];
      const got = identity(key);
      return got ? [got.version] : [];
    },
    has(_target, key) { return typeof key === 'string'; },
  });

  return {
    identity,
    customVersions,
    /** Custom cards used in the project: `{ cardId: identity }` */
    projectVersions: (project) => customVersions(projectCardIds(project)),
    /** Card source code changed: clear cache, increment `epoch` by one, restart settle period */
    invalidate() {
      cache.clear();
      epoch += 1;
      changedAt = now();
    },
    /** About to modify card files (called before host installs synced cards): only restarts settle period */
    touch() { changedAt = now(); },
    settled,
    get epoch() { return epoch; },
    view,
  };
}

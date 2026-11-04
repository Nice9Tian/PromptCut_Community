/**
 * Snapshot tier determination, pure function, imports no modules (not even Node built-in modules).
 *
 * Moved out from `snapshot-store.mjs`: that file imports `frame-mov.mjs` (`atomic`), which imports
 * the npm package `pngjs`. Queue nodes (`server/render-node/`) must run on machines without
 * node_modules (contract sections A.1 / B: relying only on Node built-in modules and
 * `server/render-queue/`), so `snapshotTier` is retrieved from here. `snapshot-store.mjs` re-exports
 * the export of the same name from here, leaving other callers unchanged. Gatekeeper test:
 * `server/test/render-node-deps.test.mjs`.
 */

/**
 * Which tier each control uses (A3a). Input is capabilities provided by the review table
 * (`cardCapabilities` in `src/kernel/frameMode.mjs`, or the copy written by `cardGraph` for
 * composite nodes).
 *
 *   Shared tier: review table independent / sourceDependent **and** stateful: canvas cards also
 *           follow this criterion (in its snapshot, [data-pc-gl-plane] is already converted to
 *           <img>, M4);
 *   Local tier: other stateful controls, including belowDependent frosted-glass cards, context
 *           requiring whole-scene context, **and unknown** (plan 3.1(2): custom cards and composite
 *           card clips with parts in real projects are all unknown; the draft rule of "always
 *           classify as heavy, no dead assets, can only be transparent" would make them disappear
 *           entirely during playback and scrubbing; changed to always handle them as below-dependent
 *           cards belowDependent: measure as usual, dispatch according to actual measurements, live
 *           render if classified as light, use local tier snapshots if classified as heavy, do not
 *           move to the cloud, do not enter streams);
 *   Do not prerender: non-stateful light cards (render 9: cards classified as light at all
 *           positions do not produce snapshots).
 */
/**
 * After snapshots are invalidated (user decision, 2026-10-13: contract
 * prerender-products-contract.md section 1.1 line 32), always returns 'none' for all cards.
 */
export function snapshotTier(_capabilities) {
  return 'none';
}

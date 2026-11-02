/**
 * Run pending macrotasks to completion until the DOM stops mutating.
 *
 * Commits scheduled by React via Scheduler's MessageChannel and the `v.on("change", setState)`
 * async render both settle here; if not drained, which frame they land on is a matter of luck.
 * Control, font, and image readiness are awaited by waitFrameReady, explicitly failing on timeout.
 *
 * Originally written in `PAGE_PRELUDE` of `scripts/export-frames.mjs` (engine is now
 * `server/bakery/chrome.mjs`), injected via `evaluateOnNewDocument`. It is now part of the page
 * bundle: the `__pcMutationCount` it reads was already in the bundle (`src/kernel/exportClock.ts`).
 * See `ExportView.tsx` for where `window.__bfSettle` is attached.
 */
export async function settleDom(): Promise<void> {
  for (let k = 0; k < 4; k++) {
    const b = window.__pcMutationCount ?? 0;
    await new Promise((r) => setTimeout(r, 0));
    if ((window.__pcMutationCount ?? 0) === b) return;
  }
}

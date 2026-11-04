/**
 * Work in the prerender process that is "outside the render pool, but still occupying slots":
 * currently only full export.
 *
 * Export is a full long-running task pass that does not go through the render pool queue (it spawns
 * scripts/export-frames.mjs itself), but it also starts a Chrome instance and consumes CPU cores.
 * So when the pool calculates "remaining slots", it must be counted, and according to Section 3.3
 * of the plan:
 *
 *   - Export has the lowest priority, occupying at most "pool total - 1" slots, always reserving
 *     one for the Agent;
 *   - **Pause idle prerender** during export: prerendering speculatively renders ahead for 3D views
 *     when the user is likely not looking; if queued normally with export, export would instead
 *     queue behind a bunch of speculative tasks.
 *
 * Two plugins (vite-plugin-export records, vite-plugin-vision audits) are in the same process and
 * share this module state.
 */
let exporting = 0;
const listeners = new Set();

function emit() {
  for (const fn of listeners) {
    try { fn(); } catch { /* An error in one listener should not break accounting */ }
  }
}

/** An export pass has started */
export function exportBegin() {
  exporting++;
  emit();
}

/** An export pass has ended (must be called on success, failure, or cancellation) */
export function exportEnd() {
  exporting = Math.max(0, exporting - 1);
  emit();
}

/** How many export passes are currently running */
export function exportsRunning() {
  return exporting;
}

/** Notified when export starts / ends (render pool relies on it to dispatch paused prerenders after export ends) */
export function onPoolChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

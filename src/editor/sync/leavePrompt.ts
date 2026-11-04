/**
 * A one-time pass for the browser's leave confirmation (the `beforeunload` attached in `SyncOverlays.tsx`).
 * The user has already explicitly confirmed leaving within the page ("Refresh anyway" on the new-version bar,
 * `UpdateNotice.tsx`), so the refresh that follows does not make the browser ask again.
 * It passes only once, and is valid only for a few seconds: if the refresh does not happen, closing the page or
 * navigating away later warns as before.
 */

/** Validity of the pass: only a moment passes between the click and the browser firing `beforeunload`, so a few seconds is enough */
const ALLOW_MS = 3000;

let allowUntil = 0;

/** Do not show the browser's leave confirmation on the next leave (the user already confirmed within the page) */
export function allowNextLeave(now = Date.now()): void {
  allowUntil = now + ALLOW_MS;
}

/** Called in `beforeunload`: whether this time has been let through; it is used up after one call */
export function takeLeaveAllowance(now = Date.now()): boolean {
  const ok = now < allowUntil;
  allowUntil = 0;
  return ok;
}

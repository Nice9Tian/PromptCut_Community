/**
 * The editor's "read-only" state: when this project is granted read-only access only (this is what happens when a
 * guest enters someone else's project, user decision 2026-10-23),
 * controls that modify the project are greyed out with the reason explained, instead of letting people click and
 * only then get rejected by the server and see a baffling error.
 *
 * The decision comes only from `viewOnlyReason()` in `io/viewOnly.ts`; no copy is stored here:
 *   - `'read-only-member'`: this project gives you no write permission. **This file handles exactly this case**;
 *   - `'observe'` (the read-only viewer page opened with `?observe=1`): it keeps being handled as before (save button
 *     disabled, top bar badge) and is not merged in here,
 *     so the functions here always return "not locked" under observe.
 *
 * Read-only does not mean unusable: playback, preview, scrolling the timeline, selecting a clip to see its
 * parameters, reading Agent chat history, and export all work as usual.
 * Why export is allowed: exporting a read-only project writes the final video to this machine, does not change the
 * project, and does not touch the project document in the cloud.
 *
 * This is not permission control, it just keeps the UI from making people do work in vain: what really blocks
 * writes is the server (`server/account/authority.mjs`,
 * `server/docservice/modules/project.mjs`); even if this layer is bypassed, the cloud project still cannot be changed.
 *
 * In components use `useReadOnly()` (re-renders when permission changes); for handlers outside components use
 * `memberReadOnlyNow()` from `readOnlyCore.ts`.
 * Disabled controls carry `ro.why` as the hover explanation; that sentence is always `viewOnlyText()`, and no
 * place makes up its own.
 */
import { useSyncExternalStore } from "react";
import { memberReadOnlyNow, readOnlyState, type ReadOnlyState } from "./readOnlyCore";

export { memberReadOnlyNow, readOnlyState, blockedByReadOnly, type ReadOnlyState } from "./readOnlyCore";

/*
 * Permission is set by `syncManager` when entering / leaving a project (`setProjectAccess`), and it notifies
 * subscribers on every sync state update.
 * Here the sync manager is loaded **on demand** and then subscribed to, not referenced statically: components such
 * as the timeline and left rail are loaded by Node unit tests, while the sync manager leads all the way to
 * `src/online/mode.ts` (Node has no `import.meta.env`), and a static reference would turn the gatekeeper test
 * (`online/modeImportGuard.test.mjs`) red.
 * Permission may already have changed before the subscription lands, so notify once after it lands, letting
 * components that read the old value recompute (no re-render if the value is unchanged).
 */
const listeners = new Set<() => void>();
let attach: Promise<void> | null = null;
const notify = () => { for (const l of [...listeners]) l(); };

function attachToSync(): void {
  if (attach) return;
  attach = import("./sync/syncManager")
    .then((m) => { m.subscribeSync(notify); notify(); })
    .catch(() => { attach = null; });
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  attachToSync();
  return () => { listeners.delete(l); };
}

/** For places that only need a boolean (the value read is a boolean, so no re-render if permission is unchanged) */
export function useMemberReadOnly(): boolean {
  return useSyncExternalStore(subscribe, memberReadOnlyNow, memberReadOnlyNow);
}

/** Read the read-only state in a component: `locked` is whether it is locked, `why` is the greyed-out explanation, `title(own)` is the hover explanation */
export function useReadOnly(): ReadOnlyState {
  return readOnlyState(useMemberReadOnly());
}

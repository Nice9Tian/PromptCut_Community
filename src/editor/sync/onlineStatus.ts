/**
 * Wording of the connection status in the online page's top bar (C10 contract section 10, section 17 table A)
 * and the persistent offline notice. Pure functions, loadable in Node unit tests.
 *
 * Five states (the copy matches table A verbatim):
 *   - Offline:                     There is no network connection right now.
 *   - Document service unreachable: Cannot reach the server. Please try again later. Your changes stay in
 *                                  this page and will be submitted automatically after recovery.
 *   - Asset service unreachable:   Cannot reach the asset service. Original-size media and prerender output
 *                                  cannot be shown for now.
 *   - Recovering:                  Connection restored. Submitting the changes made while offline…
 *   - Recovered:                   All changes made while offline have been submitted.
 * When offline with uncommitted changes there is also a persistent notice (table A, "Persistent notice"),
 * and the browser's native leave confirmation is attached when the page closes.
 *
 * **HT-a no flicker during session resumption**: when the transport drops it is resumed inside the session
 * layer (`src/editor/sync/link.ts`), which DocSync cannot see, so the status does not change in the first
 * place;
 * in addition, offline-type wording must persist for `OFFLINE_SHOW_DELAY_MS` before it is shown (so the
 * moment when a session has just ended and a new one is immediately built does not flicker either).
 * "Sync paused" (the first entry of the offline batch is rejected, C6.5) still uses the original widget as
 * before and is not among these five.
 */
import type { SyncStatus } from "../../store/docsync";
import { tr } from "../../i18n/index.ts";

export const ONLINE_STATUS_TEXT = {
  noNetwork: tr("No network connection at the moment."),
  docDown: tr("Can't connect to the server, please try again later. Your changes stay on this page for now and will be submitted automatically once the connection is restored."),
  assetDown: tr("Can't connect to the asset service, so original-size media and prerender output can't be displayed for now."),
  recovering: tr("Connection restored. Submitting the changes made while offline…"),
  recovered: tr("All changes made while offline have been submitted."),
} as const;

export type OnlineStatusKind = keyof typeof ONLINE_STATUS_TEXT;

/**
 * Persistent notice when offline with uncommitted changes (table A). [ruling 2026-10-22 lead session,
 * conflict-merge report section 6 item 7] Two sentences depending on whether the changes were actually saved:
 * - Saved (account cloud project: written to the browser's local cache; desktop app: local recovery file);
 * - Not saved (passphrase room of the old approach in the online page: not written to disk, only in this
 *   page's memory).
 * The original text "You are offline and have uncommitted changes. Closing the page will lose these
 * operations." is void: for an account project it was a false warning.
 */
export const OFFLINE_UNSENT_TEXT = {
  saved: tr("Currently offline. Your changes are saved on this machine and will be merged back into the project once you're back online."),
  page: tr("Currently offline. Your changes exist only on this page and will be lost when you close it."),
} as const;

/** Where the offline changes are stored right now: on this machine (browser local cache, local recovery file) or only in this page */
export type OfflineStore = keyof typeof OFFLINE_UNSENT_TEXT;

export function offlineUnsentText(store: OfflineStore): string {
  return OFFLINE_UNSENT_TEXT[store];
}

/**
 * The sentence asked before leaving the editor within this page (top bar "Vibe mode", back to the home
 * page; the mobile app's back and system back use `UNSENT_LEAVE_BODY`, with its own confirmation dialog
 * "Stay / Leave", without that question). The criterion is the same one as the browser's native leave
 * confirmation (`unsentAtRisk`): the cases that would lose data when the page closes lose it just the same
 * when leaving the editor within this page (leaving disconnects the document service connection and
 * switches back to the start page).
 * No question when the changes are already saved on this machine (`store: "saved"`): re-entering this
 * project resumes submitting them (`restoreBrowserJournal` in `syncManager.ts`).
 * The "project not saved yet" kind of prompt is not here: online pages are all cloud projects, and there is
 * no such thing as a local draft (issue #16).
 */
export const UNSENT_LEAVE_BODY = tr("You are offline, and your changes exist only in this page. Leaving the editor will lose them.");
/** The two top-bar paths use the browser's native `confirm` (buttons are "OK / Cancel"), so a question must be appended at the end */
export const UNSENT_LEAVE_TEXT = tr("{0} Continue?", UNSENT_LEAVE_BODY);

/**
 * Where the offline changes are actually stored right now. **If they cannot persist, say so**: when this
 * browser can provide neither IndexedDB nor localStorage, `defaultStore()` in `offlineCache.ts` falls back
 * to the in-memory version, where writes raise no error but everything is gone once the page closes. That is
 * not "saved on this machine" but "only in this page"; otherwise the persistent notice, the browser's leave
 * confirmation and the top bar's question would all be fooled by this false "saved".
 */
export function offlineStoreOf(o: { durable: boolean; account: boolean; online: boolean }): OfflineStore {
  if (!o.durable) return "page";
  return o.account || !o.online ? "saved" : "page";
}

/**
 * Bubble: while offline there are uncommitted changes, and this browser cannot store them
 * (storage is unavailable, or the write failed). The persistent notice only says "where"; this
 * line says "why". Show it once, not on every tick.
 */
export const UNSENT_NO_STORE_TOAST = tr("This browser can't store changes made offline: they exist only in this page and will be lost if you close the page or leave the editor.");

/** Offline-type wording is shown only after it has lasted this long (no flicker) */
export const OFFLINE_SHOW_DELAY_MS = 1500;
/** How long "All changes made while offline have been committed" is shown */
export const RECOVERED_SHOW_MS = 4000;

export interface OnlineStatusInput {
  /** DocSync state */
  status: SyncStatus;
  /** `navigator.onLine` (whether the browser itself thinks it has a network) */
  navigatorOnline: boolean;
  /** Whether the last asset service request could not connect (network error, not 4xx/5xx) */
  assetDown: boolean;
  /** Recovery phase: back from offline with offline changes not yet fully committed = recovering; just finished committing = recovered; otherwise null */
  recovery: "recovering" | "recovered" | null;
}

/** Which message the top bar should show right now (null if there is nothing to say). The caller applies the delay for offline-type messages */
export function onlineStatusOf(s: OnlineStatusInput): OnlineStatusKind | null {
  if (s.status === "paused") return null; // "Sync paused" is handled by the original widget
  if (s.status === "offline") return s.navigatorOnline ? "docDown" : "noNetwork";
  if (s.recovery) return s.recovery;
  if (s.assetDown) return s.navigatorOnline ? "assetDown" : "noNetwork";
  return null;
}

/** Whether to show the persistent notice ("Currently offline..."): offline and holding uncommitted changes. When paused the connection is already back, so do not say "offline" */
export function offlineUnsent(status: SyncStatus, unconfirmed: number): boolean {
  return status === "offline" && unconfirmed > 0;
}

/**
 * Whether to attach the browser's native leave confirmation: offline or paused (the offline batch is waiting for a user decision)
 * with uncommitted changes, and the changes exist only in this page (closing the page loses them).
 * Do not block when the changes are already saved on this machine (`store: "saved"`).
 */
export function unsentAtRisk(status: SyncStatus, unconfirmed: number, store: OfflineStore = "page"): boolean {
  return store === "page" && (status === "offline" || status === "paused") && unconfirmed > 0;
}

/**
 * State machine for the recovery phase: previous phase + this tick's state and unconfirmed count → new phase.
 * If changes piled up while offline (or after a pause where replay was chosen) and some are still
 * unconfirmed when back online, the phase is "recovering"; once all are confirmed it becomes "recovered";
 * the caller clears "recovered" after `RECOVERED_SHOW_MS`.
 */
export function nextRecovery(prev: { phase: "recovering" | "recovered" | null; wasOffline: boolean; hadUnsent: boolean },
  status: SyncStatus, unconfirmed: number): { phase: "recovering" | "recovered" | null; wasOffline: boolean; hadUnsent: boolean } {
  // Paused (the first item of the offline batch was rejected, C6.5): hand over to the offline dialog; whether the user then replays or discards, never say "All changes made while offline have been committed"
  if (status === "paused") return { phase: null, wasOffline: false, hadUnsent: false };
  if (status === "offline") return { phase: null, wasOffline: true, hadUnsent: prev.hadUnsent || unconfirmed > 0 };
  if (prev.wasOffline) {
    // Just came back: enter the recovery phase only if changes piled up while offline
    if (!prev.hadUnsent) return { phase: null, wasOffline: false, hadUnsent: false };
    return unconfirmed > 0
      ? { phase: "recovering", wasOffline: false, hadUnsent: true }
      : { phase: "recovered", wasOffline: false, hadUnsent: false };
  }
  if (prev.phase === "recovering" && unconfirmed === 0 && status === "online") return { phase: "recovered", wasOffline: false, hadUnsent: false };
  return { ...prev, wasOffline: false };
}

/** Tooltip shown when "Import media" is greyed out while the online browser is offline (user decision, 2026-10-22, `workflow/project.md` "What can be done offline") */
export const IMPORT_OFFLINE_TEXT = tr("You are offline");

/**
 * Whether "Import media" should be greyed out: only when the online browser is offline (the browser says there is no network, or the document service is unreachable).
 * The desktop app imports as usual and uploads once connected;
 * all other operations that change project content are allowed offline and do not go through here.
 */
export function importOfflineOf(s: { online: boolean; status: SyncStatus; active: boolean; navigatorOnline: boolean }): boolean {
  if (!s.online) return false;
  if (!s.navigatorOnline) return true;
  return s.active && s.status === "offline";
}

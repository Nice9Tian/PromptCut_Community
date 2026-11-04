/**
 * The keys for backend session ids in localStorage, and "clear all when switching projects".
 *
 * # Why a separate file
 *
 * This logic itself does not depend on any other module, and it must be unit-testable: it
 * manages an **invisible** state:
 * on the UI the chat is empty, but the backend may be continuing from the previous history.
 * This disconnect has no UI symptoms, and can only be guarded by tests.
 *
 * # What it manages
 *
 * Session ids are stored per driver in `aiSession:<provider>` (multi-Agent tabs carry the
 * `:<tabId>` suffix).
 * The server uses it to read back full history from `%TEMP%/promptcut/harness-sessions/<id>.json`
 * (server/runners/api.mjs), while the three CLI paths use `--conversation <id>` / `--resume`.
 *
 * In user diagnostic reports: brand new project, UI chat is empty, media library is also empty,
 * but **the first round of requests sends out 19 messages** (`stage: "request", messages: 19` in
 * trace), and the model immediately speaks the name of the video from the previous project:
 * it did not call list_media even once, and that name was read from the previous history.
 */

/** Prefix for session id keys. `aiSession:<provider>` or `aiSession:<provider>:<tabId>` */
export const AI_SESSION_PREFIX = "aiSession:";

/**
 * Clears session ids for all drivers and all tabs. Called when switching / creating projects.
 *
 * Scans by prefix instead of deleting per driver: tab keys have dynamic tabIds, which cannot
 * be known here.
 * Only deletes this prefix: `aiProvider`, `aiShowThinking`, etc., are long-term preferences and
 * should not be affected by switching projects.
 */
export function resetAiSessionIds(storage: Storage | undefined = safeStorage()): void {
  if (!storage) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(AI_SESSION_PREFIX)) doomed.push(k);
    }
    for (const k of doomed) storage.removeItem(k);
  } catch {
    // Inability to read storage (incognito mode, site data blocked) should not break "open project"
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

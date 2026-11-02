/**
 * Exclusive lock for drafts: the same .proc should not be edited by two PromptCuts at once.
 *
 * Use two layers together; missing either one is not enough:
 *
 * 1. **The Node half** (`/api/skill-lock`): atomically create `<name>.proc.lock` (`open(…,'wx')`);
 *    whoever wins it owns the lock. It also works when running in a browser. Its weakness is that after
 *    the holder is killed, the lock file is left behind, and it can only fall back to reading the pid
 *    in the lock to check liveness, but pids get recycled by the system, so misjudgments are possible.
 *
 * 2. **The shell half** (Tauri command `acquire_proc_lock`): use Windows share mode 0 to hold the
 *    handle of that lock file exclusively. **The kernel reclaims it the moment the process dies**, so
 *    there is no such thing as a stale lock. Only the side that can get a native handle can do this,
 *    so it lives in Rust.
 *
 * The order is Node first, then shell: the Node step creates the lock file and decides "whether anyone
 *    else holds it", and the shell step only hardens the lock that is already ours to kernel level.
 *    In the reverse order, the shell would create and lock the file first, and Node's later
 *    `open(…,'r+')` probe would hit an EBUSY that we caused ourselves, judging ourselves to be "held by someone else".
 *
 * Failing to get the lock is not a crash, it is a message: the caller decides whether to block the "open" action.
 */

/**
 * Compile-time constant for the online build (see "online build pruning" in `src/online/pageFlag.ts`
 * for how it is written and why). Online pages have no drafts (new, open and save are greyed out),
 * so they neither take nor release a draft lock; in the online build the whole /api/skill-lock call
 * is pruned away (M8 leftover L24).
 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

/** Tauri's invoke. Not available when running in a browser, in which case only the Node half exists */
function invoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  const t = (window as unknown as {
    __TAURI__?: { core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
  }).__TAURI__;
  return t?.core?.invoke ?? null;
}

export interface LockOutcome {
  ok: boolean;
  /** One-line message shown to the user when the lock cannot be acquired */
  error?: string;
  /** The previous holder is gone, so the lock was taken over */
  stolen?: boolean;
  /** No lock in SKILL mode */
  skipped?: string;
}

async function post(action: "acquire" | "release", body: Record<string, unknown>): Promise<LockOutcome> {
  if (ONLINE_BUILD) return { ok: true, skipped: "online" };
  try {
    const res = await fetch(`/api/skill-lock/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as LockOutcome;
    return { ...data, ok: res.ok && data.ok !== false };
  } catch (e) {
    // The server lacking this endpoint (old version) must not block opening the project entirely
    return { ok: true, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Which draft is locked right now; releasing must use the same key */
let heldDraftId: string | null = null;
let heldPath: string | null = null;

/**
 * Acquire the lock for a draft. If it cannot be acquired, return the reason and let the caller
 * decide whether to block.
 * If another draft is already locked, that one is released first: a window edits only one project
 * at a time.
 */
export async function acquireDraftLock(draftId: string): Promise<LockOutcome> {
  if (heldDraftId === draftId) return { ok: true };
  await releaseDraftLock();
  const out = await post("acquire", { draftId });
  if (!out.ok) return out;
  heldDraftId = draftId;
  // The shell can only lock if the server returned the real path; without it only the Node layer
  // applies (which is all a browser has anyway)
  const file = (out as LockOutcome & { file?: string }).file;
  if (file && !out.skipped) {
    heldPath = file;
    const call = invoke();
    if (call) {
      try {
        await call("acquire_proc_lock", { procPath: file });
      } catch (e) {
        // A failure in the shell's extra hardening does not change the outcome: the Node layer has already
        // decided the lock is ours.
        // Log one line, and do not keep the user out.
        console.warn("[procLock] Shell hardening failed, only the Node-level protection remains:", e);
      }
    }
  }
  return out;
}

/**
 * Release the lock currently held. Call it when switching drafts, returning to the home page,
 * creating a project, or closing the page.
 *
 * With `onlyId`, release only if the lock currently held is exactly that one: call sites that
 * "release the previous one when switching drafts" use it. At that moment the lock in hand may
 * already be the one for the newly acquired draft (openDraft runs first, then activeDraftId is
 * recorded). Releasing without an id would release the new lock, and the draft being edited
 * would be left with no lock.
 */
export async function releaseDraftLock(onlyId?: string): Promise<void> {
  if (onlyId !== undefined && heldDraftId !== onlyId) return;
  const id = heldDraftId;
  const file = heldPath;
  heldDraftId = null;
  heldPath = null;
  if (file) {
    const call = invoke();
    // Release the kernel layer first, otherwise the Node half cannot even delete the lock file
    if (call) await call("release_proc_lock", { procPath: file }).catch(() => {});
  }
  if (id) await post("release", { draftId: id });
}

/*
 * Release the lock on page close / refresh.
 *
 * Without this: after a refresh the new page tries to acquire the same draft, the Node half sees
 * the lock file still there and the pid inside really alive (it is the same vite process), so it
 * decides someone else holds the lock, and the user can no longer open their own project just by
 * refreshing.
 *
 * pagehide is more reliable than beforeunload (it also fires on mobile and with bfcache); use
 * sendBeacon rather than fetch, because the browser kills ordinary requests while the page is
 * unloading. The handle held by the shell layer needs no attention: if the process is still alive,
 * the next acquire releases first; if the process is gone, the kernel reclaims it on its own.
 */
if (!ONLINE_BUILD && typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (!heldDraftId) return;
    try {
      navigator.sendBeacon(
        "/api/skill-lock/release",
        new Blob([JSON.stringify({ draftId: heldDraftId })], { type: "application/json" }),
      );
    } catch {
      /* A failure during unload cannot be remedied; the pid fallback will recognize it as ours on the next acquire */
    }
  });
}

/** Id of the draft currently locked, or null if none */
export function lockedDraftId(): string | null {
  return heldDraftId;
}

/**
 * The flow for the top bar's "Save project" and "Pack and save" (moved out of `TopBar.tsx` so it can
 * be tested in node; the UI only handles the buttons and messages).
 * Semantics: `docs/semantics/mechanism/document-service.md`, "Save baseline and modified-state
 * check":
 * "Saving temporarily disables foreground editing and waits for this machine to finish writing; a
 * failure does not overwrite the last valid save, and editing is restored".
 *
 * Two rules as before:
 *   - "Save as" needs a user gesture, so picking the location must be the first await after the click;
 *   - If the user clicks cancel in "Save as", the whole thing does not count as a save: the draft is
 *     not written and the dirty flag is not cleared.
 *
 * Order: pick the location → lock (`../saveLock.ts`, foreground editing paused) → wait for this
 * machine to finish writing (`localWrites.ts`; if it is not done by the time limit, do not write and
 * explain what is being waited on) → serialize → write to disk (`proc.ts`: collect prerender
 * snapshots, write the temporary copy, discard it on error, the original file is untouched) → draft,
 * dirty flag → unlock.
 * At the end (success, timeout, failure) always unlock and restore editing.
 *
 * All dependencies come in as parameters (`SaveDeps`); the default wiring to the real ones is
 * assembled in TopBar.
 */
import type { SaveOutcome } from "./proc";
import { beginSaveLock, isSaveLocked, type SaveKind, type SaveLock } from "../saveLock";
import { LOCAL_WRITES_TIMEOUT_MS, localCommitSeq, waitForLocalWrites, type LocalWriteProbe } from "./localWrites";
import { writeToHandle } from "./safeWrite";
import { tr } from "../../i18n/index.ts";

export { SETTLE_TIMEOUT_TEXT } from "./localWrites";

export interface PackResultLike {
  blob: Blob;
  missing: readonly unknown[];
}

export interface SaveDeps {
  /** Write `.proc`: pick the location (or reuse the last one), then call `produce` to get the content and write it to disk. That is `writeProcToDisk` in `proc.ts` */
  writeProc(produce: () => Promise<string>, fileName: string): Promise<SaveOutcome>;
  /** Wait for the document service to confirm all local changes; throw on timeout (that is `whenSaved` in syncManager) */
  settle(timeoutMs: number): Promise<void>;
  /** The other local writes on this machine (media import, the local Agent, ...), `localWrites.ts`; if not given, only wait for the document service confirmation and for background writes to stop */
  probes?: readonly LocalWriteProbe[];
  /** Total time limit for waiting for this machine to finish writing, default `LOCAL_WRITES_TIMEOUT_MS` (for tests) */
  waitTimeoutMs?: number;
  /** The current project (object identity): if the project was changed locally after serialization, it cannot be marked "saved" */
  currentProject?(): unknown;
  /** Current project → `.proc` text */
  serialize(): string;
  /** The local draft is updated too */
  saveDraft(): Promise<void>;
  /** Clear the dirty flag, remember the file name */
  markSaved(fileName: string): void;
  /** One sentence for the user: `error` is why this save failed, `info` is something the user needs to know about a save that succeeded */
  notify(message: string, tone?: "error" | "info"): void;
}

export interface PackDeps extends Omit<SaveDeps, "writeProc" | "serialize" | "saveDraft" | "markSaved" | "currentProject"> {
  /** Pick the save target for `.procp`; returns null when there is no file system access API (falls back to a browser download). Throws AbortError if the user cancels */
  pick(fileName: string): Promise<FileSystemFileHandle | null>;
  /** Pack */
  pack(): Promise<PackResultLike>;
  /** Write to the picked target; defaults to `writeToHandle` in `safeWrite.ts` (on error the temp copy is discarded and the original file is untouched) */
  writeHandle?(handle: FileSystemFileHandle, data: Blob): Promise<void>;
  /** Fall back to a browser download when there is no save target */
  download(blob: Blob, fileName: string): void;
  /** The sentence saying which media are missing from the package */
  missingMessage(missing: readonly unknown[]): string;
}

export { writeFailedText } from "./safeWrite";

export const CHANGED_DURING_SAVE_TEXT = tr("The project was changed again on this machine during the save (by an Agent or a background task). The file holds the content as of the moment the save started; later changes are not saved yet.");

export const SNAPSHOTS_SKIPPED_TEXT = tr("The prerender snapshots could not be included in the file this time (the render service did not respond in time). The project content was saved in full, and it will be prerendered again when reopened.");

/** `busy`: the previous save has not finished, so this one does not start another */
export type SaveResult = "saved" | "downloaded" | "cancelled" | "failed" | "busy";

/** Clicked again while a save is in progress: do not start another, and do not report an error (the "saving" layer is still up) */
class SaveBusy extends Error {
  constructor() { super(tr("Saving")); this.name = "SaveBusy"; }
}

/** The lock lives in a small box: it is taken inside the callback handed to writeProc, and the outer finally needs to reach it */
interface LockBox { lock: SaveLock | null }

function lockFor(box: LockBox, kind: SaveKind): SaveLock {
  const lock = beginSaveLock(kind);
  if (!lock) throw new SaveBusy();
  box.lock = lock;
  return lock;
}

/** Wait for the local write to finish; throw on timeout (the message lists what we are waiting for) */
async function waitLocal(deps: Pick<SaveDeps, "settle" | "probes" | "waitTimeoutMs">, lock: SaveLock): Promise<void> {
  await waitForLocalWrites({
    settle: (ms) => deps.settle(ms),
    probes: deps.probes ?? [],
    timeoutMs: deps.waitTimeoutMs ?? LOCAL_WRITES_TIMEOUT_MS,
    onWaiting: (labels) => lock.waiting(labels),
  });
}

/** Save `.proc` */
export async function saveProcFile(fileName: string, deps: SaveDeps): Promise<SaveResult> {
  if (isSaveLocked()) return "busy";
  const box: LockBox = { lock: null };
  let serialized: unknown = undefined;
  let commitsAtSerialize = 0;
  try {
    const outcome = await deps.writeProc(async () => {
      const lock = lockFor(box, "proc");
      await waitLocal(deps, lock);
      lock.writing();
      serialized = deps.currentProject?.();
      commitsAtSerialize = localCommitSeq();
      return deps.serialize();
    }, fileName);
    if (outcome.kind === "cancelled") return "cancelled";
    await deps.saveDraft();
    const infos: string[] = [];
    // Once saved it is no longer dirty, otherwise "Home" and "New project" would ask one extra question
    // every time. But if the project changed after serialization (local Agent, background tasks, or
    // collaborators), the file does not contain those edits: it must not be marked "saved". If the change
    // came from this machine, tell the user; collaborators' edits always mark the project dirty anyway,
    // so we do not mention them
    const changed = !!deps.currentProject && deps.currentProject() !== serialized;
    if (changed) {
      if (localCommitSeq() !== commitsAtSerialize) infos.push(CHANGED_DURING_SAVE_TEXT);
    } else deps.markSaved(fileName);
    if (outcome.kind === "downloaded") {
      // This WebView has no file picker API; at least tell the user where the file went
      infos.unshift(tr("This environment does not support choosing a folder, saved to the browser's download location: {0}", outcome.where));
    } else if (outcome.snapshotsSkipped) {
      infos.push(SNAPSHOTS_SKIPPED_TEXT);
    }
    if (infos.length) deps.notify(infos.join("\n\n"), "info");
    return outcome.kind === "downloaded" ? "downloaded" : "saved";
  } catch (e) {
    if (e instanceof SaveBusy) return "busy";
    deps.notify(String((e as Error).message));
    return "failed";
  } finally {
    box.lock?.end();
  }
}

/**
 * Pack and save: .procp = arrangement + the media the project uses (A1).
 *
 * Same rule as saving a project: picking the save target must be the first await; packing (fetching
 * media by hash from the local content store) may only come after the target is picked.
 */
export async function savePackedFile(fileName: string, deps: PackDeps): Promise<SaveResult> {
  if (isSaveLocked()) return "busy";
  let target: FileSystemFileHandle | null = null;
  try {
    target = await deps.pick(fileName);
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return "cancelled"; // The user cancelled, not an error
    deps.notify(String((e as Error).message));
    return "failed";
  }
  const box: LockBox = { lock: null };
  try {
    const lock = lockFor(box, "procp");
    await waitLocal(deps, lock);
    lock.writing();
    // Old media without a hash are added to the store first; anything that still cannot go into the package
    // after that (the file is really gone) is listed to the user at the end, never silently dropped
    const { blob, missing } = await deps.pack();
    let result: SaveResult = "saved";
    // The several things the user needs to know about a successful save are merged into one card (it used to be two alerts in a row)
    const infos: string[] = [];
    if (target) {
      // Write a temp copy and only replace the original file on close; on error, abort discards the temp copy and the original package is unchanged (`safeWrite.ts`)
      await (deps.writeHandle ?? writeToHandle)(target, blob);
    } else {
      deps.download(blob, fileName);
      infos.push(tr("This environment does not support choosing a folder, saved to the browser's download location: {0}", fileName));
      result = "downloaded";
    }
    if (missing.length) infos.push(deps.missingMessage(missing));
    if (infos.length) deps.notify(infos.join("\n\n"), "info");
    return result;
  } catch (e) {
    if (e instanceof SaveBusy) return "busy";
    deps.notify(String((e as Error).message));
    return "failed";
  } finally {
    box.lock?.end();
  }
}

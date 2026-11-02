/**
 * Wait for local writes to finish before saving (`docs/semantics/mechanism/document-service.md`,
 * "Save baseline and modification status check":
 * "The local modification status check covers foreground editing on the current device, pending
 * operations, saving, media ingest/upload, the local Agent, rendering and background writes.
 * Saving temporarily disables foreground editing and waits for local writes to finish").
 *
 * "Finished" means local writes that have **already started but not yet landed** have all landed. It does
 * not mean waiting for every task that will write the project in the future: for tasks such as
 * transcription and sound generation that run for several minutes and write back once at the end, the
 * project holds no half-finished part of them before they write back, so saving does not wait; after they
 * write back the project becomes dirty again and the next save picks them up.
 *
 * Criteria for each item being "done" (foreground editing is already blocked by `../saveLock.ts` at this
 * point, so everything below is local writes still in flight):
 *   - Pending operations: the document service has confirmed all modifications sent by this page and the
 *     recovery log is on disk (`settle`, i.e. `whenSaved` of syncManager); when no document service is
 *     connected, local modifications go into the store synchronously, so none are in flight.
 *   - Media ingest/upload: the current project has no media that "this device is importing":
 *     `pending: true` and this device holds its file (`getMediaFile`). Media being uploaded by other
 *     devices is also pending but is not a local write, so we do not wait for it (semantics: non-local
 *     content is a fixed snapshot, other places are not required to stop writing).
 *   - Local Agent: no tool that the Agent had the page execute is running (`agentToolRunning` in
 *     `userEditing.ts`).
 *   - Background writes: in the last `QUIET_MS` milliseconds no modification from this page itself has
 *     landed (`onLocalCommit`). Foreground is already blocked, so what is still landing can only be
 *     background tasks, the Agent, or input wrap-up that started before the lock; wait for them to stop,
 *     no need to identify them one by one.
 *   - Rendering: prerender snapshots are stored together with the file (`collectFrameSnapshots` in
 *     `proc.ts`) and waited for at the file-writing step, not here.
 * The first three items and "background writes" are all waited for within the total limit `timeoutMs`;
 * if not finished by then, throw `LocalWritesPending`; the caller does not write the file and tells the
 * user what is being waited for.
 */
import { onLocalCommit } from "../../store/project";
import { agentToolRunning } from "../userEditing";
import { tr } from "../../i18n/index.ts";

/** One kind of local write: how many items are still unfinished right now */
export interface LocalWriteProbe {
  /** Name shown to the user, with a count, e.g. "importing media (2)" */
  label(count: number): string;
  count(): number;
}

/** Total limit for waiting for local writes to finish (milliseconds) */
export const LOCAL_WRITES_TIMEOUT_MS = 10_000;
/** "Background writes have stopped": no modification from this page has landed for this long */
export const QUIET_MS = 300;
/** Polling interval */
const POLL_MS = 50;

export const PENDING_OPS_LABEL = tr("The document service confirming local changes");
export const BACKGROUND_LABEL = tr("A background task is writing to the project");

/** Wording for the timeout waiting for document service confirmation (reuses the original sentence) */
export const SETTLE_TIMEOUT_TEXT = tr("Some changes have not been confirmed by the document service (you may be offline, the connection may be slow, or sync may be paused), so nothing was saved this time. Save again once connected and processing has finished.");

export function pendingWritesText(labels: readonly string[]): string {
  return tr("Some local writes have not finished: {0}. The original file was not changed, save again after they finish.", labels.join(tr(", ")));
}

/** Writes still unfinished when the limit is reached */
export class LocalWritesPending extends Error {
  readonly labels: readonly string[];
  constructor(labels: readonly string[], message: string) {
    super(message);
    this.name = "LocalWritesPending";
    this.labels = labels;
  }
}

/* ── Moments when this page's modifications land ── */

let lastCommitAt = Number.NEGATIVE_INFINITY;
let commitSeq = 0;
onLocalCommit(() => {
  lastCommitAt = Date.now();
  commitSeq += 1;
});

/** Moment when this page's most recent modification landed (-Infinity if none ever) */
export function lastLocalCommitAt(): number {
  return lastCommitAt;
}

/** How many modifications this page has landed (only increases; comparing two readings tells whether local changes happened in between) */
export function localCommitSeq(): number {
  return commitSeq;
}

/* ── Each kind of local write ── */

/** Local Agent: a tool is running */
export const agentToolProbe: LocalWriteProbe = {
  label: () => tr("Changes the Agent is making"),
  count: () => (agentToolRunning() ? 1 : 0),
};

interface MediaLike { id: string; pending?: boolean }

/** Media ingest/upload: media this device is importing and has not finished uploading */
export function mediaImportProbe(media: () => readonly MediaLike[], hasLocalFile: (id: string) => boolean): LocalWriteProbe {
  return {
    label: (n) => tr("Media being imported ({0})", n),
    count: () => media().filter((m) => m.pending && hasLocalFile(m.id)).length,
  };
}

export interface WaitLocalWritesOptions {
  /** Wait for the document service to confirm this page's modifications (throws on timeout) */
  settle(timeoutMs: number): Promise<void>;
  probes: readonly LocalWriteProbe[];
  timeoutMs?: number;
  quietMs?: number;
  /** What is being waited for (for the "saving" layer) */
  onWaiting?(labels: readonly string[]): void;
  /** For tests */
  now?(): number;
  lastCommitAt?(): number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Wait for local writes to finish. Resolves when all are done; if some are still unfinished at the limit,
 * throws `LocalWritesPending` (the message lists what is being waited for).
 * Waiting for document service confirmation comes last: only after the earlier items finish does the last
 * batch of modifications to confirm appear; if more modifications from this page land during confirmation,
 * run another round.
 */
export async function waitForLocalWrites(o: WaitLocalWritesOptions): Promise<void> {
  const now = o.now ?? Date.now;
  const lastAt = o.lastCommitAt ?? lastLocalCommitAt;
  const quietMs = o.quietMs ?? QUIET_MS;
  const deadline = now() + (o.timeoutMs ?? LOCAL_WRITES_TIMEOUT_MS);
  let shown = "";
  const show = (labels: readonly string[]) => {
    const key = labels.join("|");
    if (key === shown) return;
    shown = key;
    o.onWaiting?.(labels);
  };
  for (;;) {
    const busy: string[] = [];
    for (const p of o.probes) {
      const n = p.count();
      if (n > 0) busy.push(p.label(n));
    }
    if (now() - lastAt() < quietMs) busy.push(BACKGROUND_LABEL);
    if (busy.length) {
      if (now() >= deadline) throw new LocalWritesPending(busy, pendingWritesText(busy));
      show(busy);
      await sleep(POLL_MS);
      continue;
    }
    show([PENDING_OPS_LABEL]);
    const seq = commitSeq;
    try {
      await o.settle(Math.max(0, deadline - now()));
    } catch {
      throw new LocalWritesPending([PENDING_OPS_LABEL], SETTLE_TIMEOUT_TEXT);
    }
    // More modifications from this page landed during confirmation (background tasks, the Agent): check another round
    if (commitSeq === seq && o.probes.every((p) => p.count() === 0)) {
      show([]);
      return;
    }
  }
}

/**
 * After a project is deleted, actually delete its bytes on the asset service (2026-10-23
 * claude/guest-fix [ruling], review REVIEW-guest-identity C).
 *
 * Why this is needed: document service project deletion (creator clicking "Delete project", 3-day
 * cleanup for guest projects, `server/account/authority.mjs`) only marks the ledger as deleted and
 * records a `project-access-changed` (`reason: 'delete'`) access event; when the asset service
 * previously received this event, it only dropped the stream; `removeProject` in
 * `project-stores.mjs` had no caller in production code, leaving asset bytes and two-tier markers
 * permanently on disk. Guest "automatic cleanup after 3 days" (product/document-service.md "Guest")
 * existed in name only, and bytes would only grow without decreasing.
 *
 * Approach: as a participant in asset service access event consumers (`project-revocations.mjs`),
 * upon receiving a deletion event:
 * 1. First record the project id into the pending deletion manifest (persisted to disk, `file`):
 *    process restarts after event confirmation will not miss the deletion;
 * 2. Immediately call `removeProject(id, { recreatable: true })` on the spot (first invalidate this
 *    project's data layer, then delete the entire project directory), strike it off the manifest
 *    once successfully deleted, then ACK. **Delete before ACK**: every time the asset service reads
 *    or writes, it catches up on access events before authority verification (`checkAccess` in
 *    `project-revocations.mjs`), so any writes following the deletion event are queued after this
 *    directory is completely cleared: when the original creator reuses their own deleted project id
 *    (moving again after "Cancel this move" in move to the cloud, the only case `createProject` in
 *    `authority.mjs` allows), new bytes will not be written into a half-deleted directory, nor
 *    deleted by a late deletion;
 * 3. If immediate deletion fails (after several retries), ACK anyway to prevent an undeletable
 *    directory from blocking event confirmation for the entire asset service; at this point, this
 *    project id remains `project-gone` in this process (`removeProject` marks deletion before
 *    deleting the directory), continuing deletion in the background with backoff, released only
 *    when deletion succeeds;
 * 4. On service startup, finish deleting items in the manifest that have not yet been deleted
 *    (similarly moves to background if deletion fails).
 *
 * Account projects are deleted the same way as guest projects: once a project is deleted it can
 * never be accessed again (tombstone, `project-gone`), no one else can get this project id, and
 * keeping bytes only wastes disk space.
 *
 * Only imports Node built-in modules.
 */
import fs from 'node:fs/promises';
import { atomic } from './atomic.mjs';

/** Retry intervals (in milliseconds) when deletion fails; continuously uses the last one once exhausted */
export const REAPER_RETRY_MS = Object.freeze([1_000, 10_000, 60_000, 600_000]);
/** How many times to try immediately before ACK, and interval between attempts (in milliseconds) */
const INLINE_RETRY_MS = Object.freeze([0, 100, 500]);

const EMPTY_RECEIPT = () => ({ complete: true, closedStreams: [], stoppedRuns: [], rejectedCredentials: [] });

/**
 * @param {object} options
 * @param {{ removeProject: (projectId: string) => Promise<unknown> }} options.projectStores
 * @param {string} options.file Disk location for persisting the pending-deletion manifest (JSON)
 * @param {(event: string, fields?: object) => void} [options.log]
 * @param {number[]} [options.retryMs]
 */
export function createProjectReaper({ projectStores, file, log = () => {}, retryMs = REAPER_RETRY_MS, inlineRetryMs = INLINE_RETRY_MS }) {
  if (typeof projectStores?.removeProject !== 'function' || !file) throw new TypeError('project reaper needs projectStores.removeProject and file');
  /** @type {Map<string, number>} project id → number of failed attempts */
  const pending = new Map();
  const timers = new Map();
  const running = new Set();
  let stopped = false;
  let writing = Promise.resolve();

  function persist() {
    const snapshot = JSON.stringify({ v: 1, pending: [...pending.keys()] });
    writing = writing.catch(() => {}).then(() => atomic(file, snapshot));
    return writing;
  }

  function schedule(projectId, delay) {
    if (stopped || timers.has(projectId) || running.has(projectId)) return;
    const timer = setTimeout(() => { timers.delete(projectId); void reap(projectId); }, delay);
    timer.unref?.();
    timers.set(projectId, timer);
  }

  /**
   * Delete inline: retry as many times as `inlineRetryMs`; returns true on success. If deletion
   * fails, fall back to background backoff and return false
   */
  async function reapNow(projectId) {
    for (const delay of inlineRetryMs) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (await reap(projectId, { background: false })) return true;
      if (stopped) return false;
    }
    schedule(projectId, retryMs[0]);
    return false;
  }

  async function reap(projectId, { background = true } = {}) {
    if (stopped || running.has(projectId) || !pending.has(projectId)) return !pending.has(projectId);
    running.add(projectId);
    try {
      await projectStores.removeProject(projectId, { recreatable: true });
      pending.delete(projectId);
      log('asset.project-reaped', { projectId });
      await persist().catch(error => log('asset.project-reaper-persist-failed', { code: error?.code ?? 'error' }));
    } catch (error) {
      const failures = (pending.get(projectId) ?? 0) + 1;
      pending.set(projectId, failures);
      log('asset.project-reap-failed', { projectId, failures, code: error?.code ?? 'error' });
      running.delete(projectId);
      if (background) schedule(projectId, retryMs[Math.min(failures - 1, retryMs.length - 1)]);
      return false;
    }
    running.delete(projectId);
    return true;
  }

  return {
    /** On service startup: resume deleting items left unfinished from the previous run */
    async start() {
      let saved = null;
      try { saved = JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (error) { if (error?.code !== 'ENOENT') log('asset.project-reaper-state-unreadable', { code: error?.code ?? 'invalid' }); }
      for (const id of Array.isArray(saved?.pending) ? saved.pending : []) if (typeof id === 'string' && id) pending.set(id, 0);
      for (const id of [...pending.keys()]) await reapNow(id);
    },
    /**
     * Access event participant: record deletion events into manifest, persist to disk, delete inline
     * (switch to background on failure), then return receipt
     */
    async handleAccessEvent(event) {
      if (event?.type === 'project-access-changed' && event.reason === 'delete' && typeof event.projectId === 'string' && event.projectId) {
        if (!pending.has(event.projectId)) {
          pending.set(event.projectId, 0);
          await persist();
        }
        await reapNow(event.projectId);
      }
      return EMPTY_RECEIPT();
    },
    unavailable() { /* Deleting bytes does not depend on whether the authority is online */ },
    /**
     * Wait until deletions currently in progress and queued are all finished (for testing; does not wait
     * for retries)
     */
    async idle() {
      for (let i = 0; i < 1000 && (running.size || [...timers.keys()].some(id => (pending.get(id) ?? 0) === 0)); i++) await new Promise(r => setTimeout(r, 5));
      await writing.catch(() => {});
    },
    pending: () => [...pending.keys()],
    close() { stopped = true; for (const t of timers.values()) clearTimeout(t); timers.clear(); },
  };
}

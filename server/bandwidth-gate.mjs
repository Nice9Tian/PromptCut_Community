/**
 * Bandwidth gate: shared between the media upload queue (`upload-queue.mjs`) and the prerender
 * artifact push queue (`artifact-push.mjs`, A5 of C6.4) (`docs/plan/c66-design.md` section 3:
 * "Share a single bandwidth gate, media queued behind artifacts").
 *
 * There is only one rule: **artifacts take priority, media yields**.
 *   - Artifacts (`beginArtifact`) never wait: the push queue pushes with its original concurrency,
 *     only registering "I am pushing" on the gate;
 *   - Artifact demand (`artifactDemand(provider)`): the push queue registers a function returning
 *     "how many segments are waiting to be pushed" (excluding those in backoff);
 *   - Media (`acquireMedia`) acquires the gate chunk by chunk: only one chunk is allowed at a time;
 *     waits if artifacts are pushing, artifact demand remains, or the cross-process probe reports
 *     busy. Thus media holds the gate for at most one chunk (8 MiB) longer than artifacts before
 *     yielding.
 *
 * Cross-process: the push queue runs in the prerender process and the upload queue runs in the
 * editor process; the gates on both sides are not the same object. The editor side provides a
 * probe (`pushQueueFileProbe`) to `external`: it reads `push-queue.json` persisted by the push
 * queue; if there are segments written recently that have not yet failed, it is considered busy.
 * When both are in the same process (unit tests, future merged process), they directly share
 * `sharedBandwidthGate()`, and the probe can be omitted.
 *
 * Uses Node built-in modules only.
 */
import fsSync from 'node:fs';

const GATE_KEY = Symbol.for('promptcut.bandwidth-gate');

/**
 * @param {object} [options]
 * @param {(() => boolean | Promise<boolean>) | null} [options.external]  Cross-process probe for
 *   "artifacts are still pushing"
 * @param {number} [options.pollMs]  How often to re-check while media is waiting (probes and demand
 *   functions have no notifications, so polling is required), defaults to 250
 */
export function createBandwidthGate({ external = null, pollMs = 250 } = {}) {
  let artifactActive = 0;
  let mediaActive = 0;
  const providers = new Set();
  /** Waiting media: { wake } */
  const waiters = new Set();
  let externalFn = typeof external === 'function' ? external : null;

  const demand = () => {
    let n = 0;
    for (const fn of providers) {
      try { n += Math.max(0, Number(fn()) || 0); } catch { /* Demand function errors are treated as 0 */ }
    }
    return n;
  };
  const wakeAll = () => { for (const w of waiters) w.wake(); };

  async function externalBusy() {
    if (!externalFn) return false;
    try { return (await externalFn()) === true; } catch { return false; }
  }

  return {
    /** Begins pushing an artifact segment; the returned function is called when finished. Never waits */
    beginArtifact() {
      artifactActive++;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        artifactActive--;
        wakeAll();
      };
    },
    /**
     * Registers an artifact demand function (returns how many segments are waiting to push); returns
     * an unregister function
     */
    artifactDemand(provider) {
      if (typeof provider !== 'function') return () => {};
      providers.add(provider);
      return () => { providers.delete(provider); wakeAll(); };
    },
    /** Replaces the cross-process probe (null removes it) */
    setExternal(fn) { externalFn = typeof fn === 'function' ? fn : null; wakeAll(); },
    /**
     * Acquires the gate for one media chunk. Returns a release function; throws `AbortError` when
     * `signal` is aborted.
     * @param {{ signal?: AbortSignal }} [options]
     * @returns {Promise<() => void>}
     */
    async acquireMedia({ signal } = {}) {
      for (;;) {
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (mediaActive === 0 && artifactActive === 0 && demand() === 0 && !(await externalBusy())
          && mediaActive === 0 && artifactActive === 0) {
          mediaActive++;
          let released = false;
          return () => {
            if (released) return;
            released = true;
            mediaActive--;
            wakeAll();
          };
        }
        await new Promise((resolve) => {
          const w = { wake: () => { clearTimeout(timer); waiters.delete(w); signal?.removeEventListener?.('abort', w.wake); resolve(); } };
          const timer = setTimeout(w.wake, pollMs);
          timer.unref?.();
          waiters.add(w);
          signal?.addEventListener?.('abort', w.wake, { once: true });
        });
      }
    },
    state() {
      return { artifactActive, artifactDemand: demand(), mediaActive, mediaWaiting: waiters.size, external: !!externalFn };
    },
  };
}

/** The single shared gate for this process (used by default by both push queue and upload queue) */
export function sharedBandwidthGate() {
  const holder = /** @type {any} */ (globalThis);
  holder[GATE_KEY] ??= createBandwidthGate();
  return holder[GATE_KEY];
}

/**
 * Cross-process probe: reads `push-queue.json` of the prerender process push queue
 * (`artifact-push.mjs` writes back on every enqueue, completion, and failure).
 * Considered busy if the file was written within `staleMs` and contains segments that have not
 * failed (`attempts === 0`). Failed segments are in backoff and do not block media; files not
 * updated for a long time (push queue not created, or stale file left by an exited process) also
 * do not block. Read results are cached for `cacheMs`.
 * @param {string} file
 * @param {{ staleMs?: number, cacheMs?: number, now?: () => number }} [options]
 */
export function pushQueueFileProbe(file, { staleMs = 120_000, cacheMs = 1000, now = Date.now } = {}) {
  let cached = null;
  return () => {
    const t = now();
    if (cached && t - cached.at < cacheMs) return cached.busy;
    let busy = false;
    try {
      const stat = fsSync.statSync(file);
      if (t - stat.mtimeMs <= staleMs) {
        const saved = JSON.parse(fsSync.readFileSync(file, 'utf8'));
        busy = Array.isArray(saved?.items) && saved.items.some((item) => !(Number(item?.attempts) > 0));
      }
    } catch { busy = false; }
    cached = { at: t, busy };
    return busy;
  };
}

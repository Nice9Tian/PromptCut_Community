/**
 * Sound effect synthesis for Cloud Agent (`sound_generate`, `sound_status`, `sound_cancel`;
 * contract `docs/plan/cloud-agent-contract.md` section 9.4a).
 *
 * Synthesis of notification sounds and keyboard sounds is deterministic pure computation
 (`src/kernel/soundEffects.ts`) and executes no project-supplied code, so it is synthesized in chunks
 * within the Agent service process:
 *
 *   Parameters → (`src/audio/soundRequest.ts`, same as desktop app) recipe
 *     → (`src/audio/soundGeneration.ts`, same as desktop app) PCM16 WAV
 *     → written to asset service (`media`) with member's own asset ticket
 *     → atomically registered on project replica (`commitSoundEffect`, same as desktop app:
 *       recipe, content hash, clip).
 *
 * Therefore, the same recipe produces sample-by-sample identical WAV in cloud and desktop apps
 * (compared in unit test CA-SND-01).
 *
 * Job tables are partitioned by instance (project × member): a chat in one project cannot see or
 * cancel jobs from other projects or other members; job ids include random numbers.
 * Only one synthesis runs across the entire process at a time (`slot`), yielding the event loop once
 * per chunk; a member can queue at most 4 jobs in a project (same number as desktop app).
 * Frontend code only goes through `ssr-host.mjs` (`host.sound`).
 */
import { randomBytes } from 'node:crypto';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'stale']);
const finished = (job) => TERMINAL.has(job.state);
const REDO = new Set(['failed', 'cancelled', 'stale']);

/**
 * Process-level: allows only one job to occupy at a time (synthesis is CPU-intensive work;
 * prevents synthesis across multiple projects from maxing out the service process)
 */
export function createSlot() {
  let tail = Promise.resolve();
  return {
    /**
     * Wait until one's turn; returns a release function. Stops waiting when `signal` is cancelled
     * (the queued slot is still yielded to the next in line)
     */
    acquire(signal) {
      let release;
      const mine = new Promise((resolve) => { release = resolve; });
      const before = tail;
      tail = before.then(() => mine);
      return new Promise((resolve, reject) => {
        const onAbort = () => { release(); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        before.then(() => {
          signal?.removeEventListener('abort', onAbort);
          if (signal?.aborted) return;
          resolve(release);
        });
      });
    },
  };
}

/** Job table for an instance (project × member) */
export const newSoundState = () => ({ jobs: new Map(), byRequest: new Map(), latest: new Map() });

const viewOf = (job) => ({
  id: job.id, jobId: job.id, requestId: job.requestId, state: job.state, progress: job.progress,
  ...(job.error ? { error: job.error } : {}), ...(job.result ? { result: job.result } : {}),
});

/**
 * Three tools for a chat.
 * @param {object} d
 * @param {ReturnType<typeof newSoundState>} d.state Job table for this instance
 * @param {ReturnType<typeof createSlot>} d.slot Process-level synthesis slot
 * @param {() => Promise<object>} d.host `ssr-host.mjs`
 * @param {() => Promise<{ project: object }>} d.snapshot Project replica at this moment
 * @param {(track: object, apply: (host: object) => any) => Promise<any>} d.mutate
 *   Modify on project replica and commit (`track` is event context for this call)
 * @param {() => Promise<void>} d.ensureCanWrite Read-only members are rejected here
 * @param {(wav: Uint8Array) => Promise<{ hash: string, size: number }>} d.put Write into asset service
 * @param {(row: object) => void} d.record Record one usage row
 * @param {new (message: string, extra?: object) => Error} d.ToolError
 * @param {{ pendingJobs?: number, historyJobs?: number }} [d.limits]
 */
export function createSoundTools({ state, slot, host, snapshot, mutate, ensureCanWrite, put, record = () => {}, ToolError = Error, limits = {} }) {
  const pendingMax = limits.pendingJobs ?? 4;
  const historyMax = limits.historyJobs ?? 8;

  function trim() {
    const done = [...state.jobs.values()].filter(finished);
    for (const old of done.slice(0, Math.max(0, done.length - historyMax))) {
      state.jobs.delete(old.id);
      if (state.byRequest.get(old.requestKey) === old.id) state.byRequest.delete(old.requestKey);
      if (state.latest.get(old.targetKey) === old.id) state.latest.delete(old.targetKey);
    }
  }

  async function run(job, plan, spec, h, track) {
    const signal = job.abort.signal;
    const t0 = Date.now();
    let bytes = 0;
    let release = null;
    const stale = () => state.latest.get(job.targetKey) !== job.id;
    try {
      release = await slot.acquire(signal);
      if (stale()) throw Object.assign(new Error('A newer generation request exists; the old result was not applied'), { stale: true });
      job.state = 'rendering';
      const wav = await h.sound.renderWav(plan.recipe, {
        signal,
        progress: (fraction) => { if (!signal.aborted) job.progress = fraction * 0.8; },
        yield: () => new Promise((resolve) => setImmediate(resolve)),
      });
      release(); release = null;
      signal.throwIfAborted();
      job.state = 'uploading'; job.progress = 0.8;
      bytes = wav.byteLength;
      const asset = await put(wav);
      signal.throwIfAborted();
      if (!/^[a-f0-9]{64}$/.test(asset.hash)) throw new Error('The asset service did not return a valid content hash');
      const reuseKey = await h.sound.reuseDigest(plan.recipe);
      let result = null;
      await mutate(track, (hh) => {
        // Check once more after entering the lock: if cancelled or a newer request arrived,
        // do not persist this one
        signal.throwIfAborted();
        if (stale()) throw Object.assign(new Error('A newer generation request exists; the old result was not applied'), { stale: true });
        result = hh.sound.commit({
          ...spec,
          asset: {
            kind: 'audio', name: plan.name, hash: asset.hash, url: `/@media/${asset.hash}`, ext: 'wav', size: wav.byteLength,
            duration: plan.recipe.frames / plan.recipe.sampleRate, soundEffect: { recipe: plan.recipe, reuseKey },
          },
          link: { recipe: plan.recipe, reuseKey, requestId: job.requestId, ...(plan.sourceClipId ? { sourceClipId: plan.sourceClipId } : {}) },
        });
        return { ok: true };
      });
      job.state = 'succeeded'; job.progress = 1; job.result = result;
    } catch (err) {
      const message = String(err?.message ?? err);
      if (signal.aborted && job.state !== 'stale') { job.state = 'cancelled'; job.error = 'Cancelled; the original sound effect is unchanged'; }
      else if (job.state === 'stale') { /* Reason already written when superseded by a newer request */ }
      else if (err?.stale || /已改变|已切换|has changed/.test(message)) { job.state = 'stale'; job.error = err?.stale ? message : `The project or clip has changed; the old generation result was not applied (${message})`; }
      else { job.state = 'failed'; job.error = message.slice(0, 300); }
    } finally {
      release?.();
      try {
        record({ service: 'sound', vendor: 'builtin', model: plan.recipe.preset, units: bytes, unit: 'bytes', ok: job.state === 'succeeded', ms: Date.now() - t0 });
      } catch { /* Failure to record usage does not affect the result */ }
      trim();
    }
    return job;
  }

  async function generate(args, track) {
    const requestId = args?.requestId;
    if (typeof requestId !== 'string' || !requestId || requestId.length > 200) throw new ToolError('requestId must be 1 to 200 characters');
    await ensureCanWrite();
    const h = await host();
    const { project: p } = await snapshot();
    let plan;
    try {
      plan = h.sound.plan(p, { ...args, requestId });
      h.sound.assertSize(plan.recipe);
    } catch (err) {
      throw new ToolError(String(err?.message ?? err).slice(0, 300));
    }
    const signature = h.sound.reuseKey(plan.recipe);
    const targetKey = `${p.activeCutId ?? ''}:${plan.target?.clip.id ?? requestId}`;
    const requestKey = `${targetKey}\0${requestId}`;
    const old = state.jobs.get(state.byRequest.get(requestKey) ?? '');
    if (old && !REDO.has(old.state)) {
      if (old.signature !== signature) throw new ToolError('requestId was already used for a different recipe; use a new requestId after changing it');
      const resultCurrent = () => !!p.media?.some((m) => m.id === old.result?.mediaId)
        && (!old.result?.clipId || p.tracks?.some((t) => t.clips.some((c) => c.id === old.result.clipId && c.mediaId === old.result.mediaId)));
      if (old.state !== 'succeeded' || resultCurrent()) return viewOf(await old.done);
    }
    const pending = [...state.jobs.values()].filter((j) => !finished(j) && j.targetKey !== targetKey);
    if (pending.length >= pendingMax) throw new ToolError(`The sound effect queue is full (max ${pendingMax}); wait or cancel`);
    for (const prior of state.jobs.values()) {
      if (prior.targetKey !== targetKey || finished(prior)) continue;
      prior.state = 'stale'; prior.error = 'A newer generation request exists; the old result was not applied';
      prior.abort.abort();
    }
    const job = {
      id: `sound-${randomBytes(6).toString('hex')}`, requestId, targetKey, requestKey, signature,
      state: 'queued', progress: 0, error: undefined, result: undefined, abort: new AbortController(), done: null,
    };
    state.jobs.set(job.id, job); state.byRequest.set(requestKey, job.id); state.latest.set(targetKey, job.id);
    const spec = {
      projectId: p.id, cutId: p.activeCutId, expectedClip: plan.expectedClip, expectedSource: plan.expectedSource,
      replaceClipId: plan.target?.clip.id, start: plan.start, duration: plan.duration, mediaOffset: plan.mediaOffset,
      trackId: typeof args.trackId === 'string' ? args.trackId : undefined,
    };
    job.done = run(job, plan, spec, h, track);
    return viewOf(await job.done);
  }

  const withOk = (view) => (view.state === 'succeeded' ? { ok: true, ...view } : finished(view) ? { ok: false, ...view, error: view.error ?? 'No sound effect was generated' } : view);

  return {
    sound_generate: async (args, track) => withOk(await generate(args ?? {}, track ?? {})),
    sound_status: async (args) => {
      if (!args?.jobId) return { jobs: [...state.jobs.values()].map(viewOf) };
      const job = state.jobs.get(String(args.jobId));
      if (!job) throw new ToolError('Sound effect job not found (after a service restart, regenerate from the clip\'s recipe)');
      return viewOf(job);
    },
    sound_cancel: async (args) => {
      const job = state.jobs.get(String(args?.jobId ?? ''));
      if (!job) throw new ToolError('Sound effect job not found');
      if (!finished(job)) job.abort.abort();
      // The moment of commit is atomic: wait for it to settle before responding, do not return
      // a state that will change later
      const settled = await Promise.race([job.done, new Promise((resolve) => setTimeout(() => resolve(null), 2000))]);
      return viewOf(settled ?? job);
    },
  };
}

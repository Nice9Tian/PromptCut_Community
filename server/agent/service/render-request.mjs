/**
 * Prerender retries when no members are online (contract `docs/plan/cloud-agent-contract.md` section
 * 16): after a Cloud Agent write commits, the Agent service publishes manifest plans under
 * **service identity**, having render nodes render modified clips; maintained until results are
 * stored.
 *
 * - What to publish: the same manifest plan as online pages (`clipsPlanTaskOf` in
 *   `server/render-queue/messages.mjs`, verified against unit tests for the page counterpart).
 *   The manifest includes only clips written in this round and classified as heavy (media clips are
 *   excluded; heavy/light classification is determined on the write side using shared cost records
 *   from the document service, and clips classified as light do not enter, see "Only dispatch heavy
 *   cards" in `render-clips.mjs`; clips received here are already classified); up to 200 clips per
 *   plan, batched if exceeded.
 * - When to publish: accumulate for 3 seconds after each write commits (merging consecutive writes
 *   into a single plan); send an extra dispatch at the end of a round. After a new plan is
 *   dispatched, withdraw unrendered older plans for this chat from the previous batch (frames from
 *   older revisions are obsolete), merging clips from older plans that have not finished rendering
 *   into the new plan.
 * - Maintain until stored: evaluated by "how long continuously without progress": abandoned and
 *   withdrawn if there is no progress or completion for 10 consecutive minutes; additionally has an
 *   absolute ceiling of 12 hours. After abandonment, the next page entering will dispatch on its
 *   own according to existing rules.
 * - Both results and failures are recorded in the chat's event log (`render` event), never dropped
 *   silently.
 * - Unrendered manifests for each chat are written to `pending-render.json` under its directory;
 *   republished from it after the process starts up (queue is in-memory only), requiring no member
 *   presence.
 *
 * The publication channel (`publisher`) is an interface slot: the real one requires third-stage
 * queue changes (service identity able to publish manifest plans) and Block Yi's service identity,
 * wired after merge; before that, provided by test doubles. When `publisher` is not provided, this
 * module does nothing and emits no events. Shape:
 *
 *   publisher.availability(projectId) → { available: boolean, enabled: boolean, streams?: boolean }
 *       Whether render nodes are enabled for this project;
 *       `streams === false` (provided only by publication channels aware of the "generate track
 *       streams" toggle, account mode) = hosted render nodes do not produce streams for this project
 *       (`docs/semantics/product/rendering.md` "Who produces streams and host toggle"): do not dispatch,
 *       record `render { state: 'off' }`
 *   publisher.codeVersion?.() → string | null                                         Code version of this checkout
 *   publisher.open(projectId, { onProgress({ id, done?, total? }), onDone({ id }), onFail({ id, reason?, clips? }), onClose() })
 *       → { publish(task): Promise<void> | void, withdraw(id): Promise<void> | void, close(): void }
 *
 * This file does not import `src/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { clipsPlanTaskOf } from '../../render-queue/messages.mjs';

export const RENDER_REQUEST_DEFAULTS = Object.freeze({
  /** How long to accumulate writes after landing before dispatching */
  debounceMs: 3000,
  /** Maximum number of clips per plan */
  maxClipsPerPlan: 200,
  /** Abandon if there is no progress continuously for this duration */
  stallMs: 10 * 60_000,
  /**
   * Timeout when a project contains user cards: such projects are rendered by isolated worker
   * processes of the render service: only rendering one project at a time, cold start takes about
   * 10 seconds, and when multiple projects are waiting they switch every 5 minutes at most, so there
   * can be no progress for a long time before its turn. Generously budgeted assuming "five projects
   * queued ahead" plus cold start
   */
  userCardStallMs: 30 * 60_000,
  /** Absolute ceiling */
  maxMs: 12 * 60 * 60_000,
  /** Minimum interval between `render progress` events */
  progressEveryMs: 30_000,
  /**
   * How long to wait before republishing after publication channel disconnects (doubles each time up
   * to ceiling)
   */
  reopenMs: [2000, 5000, 15_000, 60_000],
});

/** Card IDs of media clips: they are not prerendered and do not enter the manifest */
export const MEDIA_CARD_IDS = Object.freeze(new Set(['video', 'image', 'audio']));

export const STALL_REASON = 'Render node made no progress for 10 minutes';
/**
 * Publication channel cannot be opened and failure is non-transient (document service explicitly
 * denies publish ticket): record failure directly for these reasons, do not retry silently
 */
export const PERMANENT_OPEN_REASONS = Object.freeze(new Set(['no-project', 'forbidden', 'service-disabled', 'service-revoked', 'relocated', 'not-listed', 'banned']));
/**
 * Reason when abandoning projects with user cards (rendered by isolated worker processes, must
 * queue)
 */
export const USER_CARD_STALL_REASON = 'Render node made no progress for 30 minutes (projects with user cards must be queued for rendering)';

/**
 * Picks clips to prerender from the project among these IDs (still in project, not media clips)
 */
export function renderableClips(project, clipIds) {
  const want = new Set(clipIds);
  const out = [];
  for (const tr of project?.tracks ?? []) {
    for (const c of tr?.clips ?? []) {
      if (c && want.has(c.id) && typeof c.cardId === 'string' && !MEDIA_CARD_IDS.has(c.cardId)) out.push(c.id);
    }
  }
  return out;
}

const chunk = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };

/**
 * @param {object} o
 * @param {object | null} o.publisher See file header; when null, the entire module does nothing
 * @param {ReturnType<import('./conversations.mjs').createConversationStore>} o.store
 */
export function createRenderRequests({ publisher = null, store, now = () => Date.now(), limits: limitsIn = {}, log = () => {} } = {}) {
  const limits = { ...RENDER_REQUEST_DEFAULTS, ...limitsIn };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* Logging failure does not affect prerender retries */ } };
  /** Chat key → prerender retry state for this chat */
  const jobs = new Map();
  /** projectId → { handle, opening, plans: Set(planId), retry, retryTimer } */
  const channels = new Map();
  /** planId → job */
  const planOwner = new Map();
  let closed = false;

  const fileOf = (job) => {
    const dir = store.dirOf(job.projectId, job.ownerKey, job.id);
    return dir ? path.join(dir, 'pending-render.json') : null;
  };

  function persist(job) {
    const file = fileOf(job);
    if (!file) return;
    try {
      if (!job.plans.size && !job.dirty.size) { fs.rmSync(file, { force: true }); return; }
      if (!fs.existsSync(path.dirname(file))) return; // Chat has already been deleted
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({
        v: 1, rev: job.rev, runId: job.runId, dirty: [...job.dirty],
        plans: [...job.plans.values()].map((p) => ({ id: p.id, projectRev: p.projectRev, clips: p.clips, publishedAt: p.publishedAt })),
      }), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      say('agent.render.persist-failed', { message: String(err?.message ?? err).slice(0, 120) });
    }
  }

  function jobOf(ref, create) {
    const key = `${ref.projectId}\n${ref.ownerKey}\n${ref.id}`;
    let job = jobs.get(key);
    if (!job && create) {
      job = { key, projectId: ref.projectId, ownerKey: ref.ownerKey, id: ref.id, dirty: new Set(), rev: null, runId: null, timer: null, plans: new Map(), lastReportAt: 0, publishing: Promise.resolve() };
      jobs.set(key, job);
    }
    return job ?? null;
  }

  /** Records a `render` entry into this chat's event log; returns false if chat was deleted */
  function report(job, fields) {
    const conv = store.get(job.projectId, job.ownerKey, job.id);
    if (!conv) return false;
    store.emit(conv, { type: 'render', ...(job.runId ? { runId: job.runId } : {}), ...fields });
    return true;
  }

  function dropJobIfDone(job) {
    if (job.plans.size || job.dirty.size || job.timer) return;
    jobs.delete(job.key);
  }

  function closeChannelIfIdle(projectId) {
    const ch = channels.get(projectId);
    if (!ch || ch.plans.size) return;
    clearTimeout(ch.retryTimer);
    channels.delete(projectId);
    try { ch.handle?.close(); } catch { /* Already closed */ }
  }

  function forgetPlan(job, planId) {
    job.plans.delete(planId);
    planOwner.delete(planId);
    channels.get(job.projectId)?.plans.delete(planId);
  }

  async function withdraw(job, planId) {
    const ch = channels.get(job.projectId);
    forgetPlan(job, planId);
    try { await ch?.handle?.withdraw(planId); } catch { /* Channel disconnected: tasks in the queue are cleared with the connection */ }
  }

  function onProgress({ id, done, total } = {}) {
    const job = planOwner.get(id);
    const plan = job?.plans.get(id);
    if (!plan) return;
    plan.lastProgressAt = now();
    if (Number.isFinite(done)) plan.done = done;
    if (Number.isFinite(total)) plan.total = total;
    if (now() - job.lastReportAt < limits.progressEveryMs) return;
    job.lastReportAt = now();
    const all = [...job.plans.values()];
    report(job, { state: 'progress', clips: all.flatMap((p) => p.clips), done: all.reduce((n, p) => n + (p.done ?? 0), 0), total: all.reduce((n, p) => n + (p.total ?? p.clips.length), 0) });
  }

  function onDone({ id } = {}) {
    const job = planOwner.get(id);
    const plan = job?.plans.get(id);
    if (!plan) return;
    forgetPlan(job, id);
    job.finished.push(...plan.clips);
    if (!job.plans.size) {
      const clips = job.finished.splice(0);
      report(job, { state: 'done', clips });
      say('agent.render.done', { projectId: job.projectId, clips: clips.length });
    } else {
      job.lastReportAt = now();
      report(job, { state: 'progress', clips: plan.clips, done: job.finished.length, total: job.finished.length + [...job.plans.values()].reduce((n, p) => n + p.clips.length, 0) });
    }
    persist(job);
    closeChannelIfIdle(job.projectId);
    dropJobIfDone(job);
  }

  function onFail({ id, reason, clips } = {}) {
    const job = planOwner.get(id);
    const plan = job?.plans.get(id);
    if (!plan) return;
    forgetPlan(job, id);
    report(job, { state: 'failed', clips: Array.isArray(clips) && clips.length ? clips.map(String) : plan.clips, reason: typeof reason === 'string' && reason ? reason.slice(0, 200) : 'Render failed' });
    say('agent.render.failed', { projectId: job.projectId, clips: plan.clips.length });
    persist(job);
    closeChannelIfIdle(job.projectId);
    dropJobIfDone(job);
  }

  /**
   * Publication channel disconnected on its own (document service restart, network): reopen after a
   * delay and republish unrendered plans as is
   */
  function onChannelClose(projectId) {
    const ch = channels.get(projectId);
    if (!ch || closed) return;
    ch.handle = null;
    ch.opening = null;
    if (!ch.plans.size) { channels.delete(projectId); return; }
    const wait = limits.reopenMs[Math.min(ch.retry, limits.reopenMs.length - 1)];
    ch.retry += 1;
    clearTimeout(ch.retryTimer);
    ch.retryTimer = setTimeout(() => { void republish(projectId); }, wait);
    ch.retryTimer.unref?.();
  }

  async function channelFor(projectId) {
    let ch = channels.get(projectId);
    if (!ch) { ch = { handle: null, opening: null, plans: new Set(), retry: 0, retryTimer: null }; channels.set(projectId, ch); }
    if (ch.handle) return ch;
    ch.opening ??= Promise.resolve(publisher.open(projectId, { onProgress, onDone, onFail, onClose: () => onChannelClose(projectId) })).then(
      (handle) => { ch.handle = handle; ch.opening = null; ch.retry = 0; return ch; },
      (err) => { ch.opening = null; throw err; },
    );
    return ch.opening;
  }

  async function republish(projectId) {
    if (closed) return;
    const ch = channels.get(projectId);
    if (!ch || !ch.plans.size) return;
    try {
      const open = await channelFor(projectId);
      for (const id of [...ch.plans]) {
        const plan = planOwner.get(id)?.plans.get(id);
        if (!plan) { ch.plans.delete(id); continue; }
        await open.handle.publish(plan.task);
      }
      say('agent.render.republished', { projectId, plans: ch.plans.size });
    } catch (err) {
      say('agent.render.reopen-failed', { projectId, message: String(err?.message ?? err).slice(0, 120) });
      onChannelClose(projectId);
    }
  }

  /** Dispatches accumulated clips for this chat as a plan */
  function publish(job) {
    clearTimeout(job.timer);
    job.timer = null;
    job.publishing = job.publishing.then(async () => {
      if (closed || !job.dirty.size) return;
      let avail;
      try { avail = await publisher.availability(job.projectId); } catch { avail = null; }
      if (avail?.streams === false) {
        // "Generate track streams" is off: hosted render nodes do not produce streams for this project
        // at all, and no one will render even if dispatched. Record faithfully, do not report "done"
        const clips = [...job.dirty];
        job.dirty.clear();
        report(job, { state: 'off', clips });
        say('agent.render.streams-off', { projectId: job.projectId, clips: clips.length });
        persist(job);
        dropJobIfDone(job);
        return;
      }
      if (!avail?.available || !avail?.enabled) {
        const clips = [...job.dirty];
        job.dirty.clear();
        report(job, { state: 'unavailable', clips });
        say('agent.render.unavailable', { projectId: job.projectId, clips: clips.length });
        persist(job);
        dropJobIfDone(job);
        return;
      }
      // Merge in unrendered clips from the previous batch: they will be withdrawn, but still need
      // rendering in the new version
      const old = [...job.plans.values()];
      const clips = [...new Set([...old.flatMap((p) => p.clips), ...job.dirty])].sort();
      const rev = job.rev;
      job.dirty.clear();
      let ch;
      try {
        ch = await channelFor(job.projectId);
      } catch (err) {
        if (PERMANENT_OPEN_REASONS.has(err?.reason)) {
          // Document service explicitly refuses prerender plans for this project: record failure with reason,
          // do not retry indefinitely
          for (const p of old) forgetPlan(job, p.id);
          report(job, { state: 'failed', clips, reason: `The cloud render service does not accept this project's prerender (${err.reason})` });
          say('agent.render.open-refused', { projectId: job.projectId, reason: err.reason });
          persist(job);
          closeChannelIfIdle(job.projectId);
          dropJobIfDone(job);
          return;
        }
        // Cannot open channel: release clips back and retry after a delay (do not record failure: this is
        // transient)
        for (const c of clips) job.dirty.add(c);
        say('agent.render.open-failed', { projectId: job.projectId, message: String(err?.message ?? err).slice(0, 120) });
        if (!job.timer && !closed) { job.timer = setTimeout(() => publish(job), limits.reopenMs[0]); job.timer.unref?.(); }
        persist(job);
        return;
      }
      let codeVersion = null;
      try { codeVersion = publisher.codeVersion?.() ?? null; } catch { codeVersion = null; }
      const at = now();
      const fresh = [];
      for (const part of chunk(clips, limits.maxClipsPerPlan)) {
        const task = clipsPlanTaskOf({ projectId: job.projectId, projectRev: rev, clips: part, codeVersion });
        const plan = { id: task.id, task, projectRev: rev, clips: task.input.clips, publishedAt: at, lastProgressAt: at, done: 0, total: null };
        job.plans.set(plan.id, plan);
        planOwner.set(plan.id, job);
        ch.plans.add(plan.id);
        fresh.push(plan);
      }
      persist(job);
      for (const plan of fresh) await ch.handle.publish(plan.task);
      // Withdraw the old plan only after the new one is dispatched
      for (const p of old) if (!fresh.some((f) => f.id === p.id)) await withdraw(job, p.id);
      job.lastReportAt = 0;
      report(job, { state: 'published', clips, plans: fresh.length });
      persist(job);
      say('agent.render.published', { projectId: job.projectId, plans: fresh.length, clips: clips.length, rev });
    }).catch((err) => {
      say('agent.render.publish-failed', { projectId: job.projectId, message: String(err?.message ?? err).slice(0, 160) });
    });
    return job.publishing;
  }

  /**
   * Periodic sweep: abandon and withdraw plans with no progress for too long or exceeding absolute
   * ceiling
   */
  function watchdog() {
    const at = now();
    for (const job of [...jobs.values()]) {
      for (const plan of [...job.plans.values()]) {
        const stalled = at - plan.lastProgressAt >= (job.userCards ? limits.userCardStallMs : limits.stallMs);
        const tooLong = at - plan.publishedAt >= limits.maxMs;
        if (!stalled && !tooLong) continue;
        void withdraw(job, plan.id);
        report(job, { state: 'failed', clips: plan.clips, reason: stalled ? (job.userCards ? USER_CARD_STALL_REASON : STALL_REASON) : 'Render exceeded the 12-hour limit' });
        say('agent.render.gave-up', { projectId: job.projectId, clips: plan.clips.length, why: stalled ? 'stalled' : 'max' });
        persist(job);
        closeChannelIfIdle(job.projectId);
        dropJobIfDone(job);
      }
    }
  }
  const sweep = publisher ? setInterval(watchdog, Math.max(50, Math.min(30_000, Math.floor(limits.stallMs / 4)))) : null;
  sweep?.unref?.();

  return {
    enabled: !!publisher,
    /**
     * How long to accumulate writes after landing before dispatching (the write side uses the same
     * value for "accumulate before classifying heavy/light", `createHeavyRenderGate` in
     * `render-clips.mjs`)
     */
    debounceMs: limits.debounceMs,

    /**
     * A write committed. `project` is the project content after the write (used to pick clips to
     * render), and `rev` is its revision.
     * @param {{ projectId: string, ownerKey: string, id: string }} ref Which chat
     */
    noteWrite(ref, { clipIds = [], clips: given = null, rev, project, runId = null, userCards = false } = {}) {
      if (!publisher || closed) return;
      // `clips`: clips already selected by writer from project content (account mode: selected by task
      // process, forwarded via lead service); otherwise selected via `project`
      const clips = Array.isArray(given) ? [...new Set(given.filter((c) => typeof c === 'string' && c))] : renderableClips(project, clipIds);
      const job = jobOf(ref, clips.length > 0);
      if (!job) return;
      // Project contains user cards: rendered by isolated worker process, extend timeout for
      // determining "no progress" (see userCardStallMs)
      if (userCards) job.userCards = true;
      if (Number.isSafeInteger(rev)) job.rev = rev;
      if (runId) job.runId = runId;
      if (!clips.length) return;
      job.finished ??= [];
      for (const c of clips) job.dirty.add(c);
      clearTimeout(job.timer);
      job.timer = setTimeout(() => { void publish(job); }, limits.debounceMs);
      job.timer.unref?.();
      persist(job);
    },

    /**
     * Round finished: dispatch accumulated items immediately (ensuring the final version has a plan)
     */
    flush(ref) {
      const job = jobOf(ref, false);
      if (!publisher || !job || !job.dirty.size) return Promise.resolve();
      return publish(job);
    },

    /**
     * Called after process startup: republish according to each chat's `pending-render.json`.
     * Uses only service identity; does not require member presence. Returns the number of republished
     * chats.
     */
    async restore() {
      if (!publisher) return 0;
      let n = 0;
      for (const at of store.walk()) {
        let saved;
        try { saved = JSON.parse(fs.readFileSync(path.join(at.dir, 'pending-render.json'), 'utf8')); } catch { continue; }
        const clips = [...new Set([...(Array.isArray(saved?.dirty) ? saved.dirty : []), ...(Array.isArray(saved?.plans) ? saved.plans.flatMap((p) => (Array.isArray(p?.clips) ? p.clips : [])) : [])])].map(String);
        const rev = Number.isSafeInteger(saved?.rev) ? saved.rev : (saved?.plans ?? []).map((p) => p?.projectRev).filter(Number.isSafeInteger).sort((a, b) => b - a)[0];
        if (!clips.length || !Number.isSafeInteger(rev)) continue;
        const job = jobOf(at, true);
        job.finished ??= [];
        job.rev = rev;
        job.runId = typeof saved.runId === 'string' ? saved.runId : null;
        // After restart, unknown whether this project has user cards: wait according to the timeout limit
        // it carries (waiting longer will not cause errors; waiting less will misjudge queued plans as
        // abandoned)
        job.userCards = true;
        for (const c of clips) job.dirty.add(c);
        n += 1;
        await publish(job);
      }
      if (n) say('agent.render.restored', { conversations: n });
      return n;
    },

    /** Cloud Agent switch is off or project is deleted: recall and clear this project's manifest */
    async cancelProject(projectId) {
      for (const job of [...jobs.values()]) {
        if (job.projectId !== projectId) continue;
        clearTimeout(job.timer);
        job.timer = null;
        job.dirty.clear();
        for (const id of [...job.plans.keys()]) await withdraw(job, id);
        persist(job);
        jobs.delete(job.key);
      }
      closeChannelIfIdle(projectId);
    },

    /**
     * A chat is deleted: no longer track its manifest (already dispatched plans finish rendering as
     * usual; changes are in the project for others to view).
     */
    forget(ref) {
      const job = jobOf(ref, false);
      if (!job) return;
      clearTimeout(job.timer);
      for (const id of [...job.plans.keys()]) forgetPlan(job, id);
      jobs.delete(job.key);
      closeChannelIfIdle(job.projectId);
    },

    /** Diagnostics: does not contain body */
    describe() {
      return { jobs: [...jobs.values()].map((j) => ({ projectId: j.projectId, dirty: j.dirty.size, plans: j.plans.size })), channels: channels.size };
    },

    /** Test: wait for this chat's current publish to finish */
    _settled(ref) {
      return jobOf(ref, false)?.publishing ?? Promise.resolve();
    },
    _watchdog: watchdog,

    /** Finalize: stop timers, close channels. Manifests remain on disk, republished on next startup */
    close() {
      closed = true;
      if (sweep) clearInterval(sweep);
      for (const job of jobs.values()) clearTimeout(job.timer);
      for (const ch of channels.values()) {
        clearTimeout(ch.retryTimer);
        try { ch.handle?.close(); } catch { /* Already closed */ }
      }
      channels.clear();
    },
  };
}

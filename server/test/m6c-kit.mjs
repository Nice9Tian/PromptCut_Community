/**
 * For testing only. Fakes and **interface assumptions** for M6c contract tests
 * (`docs/plan/m6c-contract.md` X1-X5).
 *
 * Tester writes strictly to contract without looking at implementation (`claude/m6c-stream`,
 * `claude/m6c-queue`). Any interface name not frozen in contract is centralized in this file,
 * each marked `[assumption A-...]`, reconciled during lead session integration: if implementation
 * names differ, only change here; test cases stay untouched.
 *
 * Frozen in contract and used directly in test cases:
 *   - Stream task `requires.capabilities.streams === true`, node `node.hello`'s
 *     `capabilities.streams` (X1);
 *   - Fine-grained task `requires.localMedia = <publisher nodeId>` (X2);
 *   - `profile` restriction of `watch: 'all'`, `host` receives only summaries (X3, for summary
 *     format see `queue.summary` in render-queue-contract H.3);
 *   - `plan`'s `requires.preferNode`, constant `PLAN_PREFER_MS` (default 5000, in `constants.mjs`)
 *     (X4);
 *   - Idle gate: executor has available slot and no interactive frame request within 500 ms (X5).
 */
import { createRenderQueue, QUEUE_DEFAULTS } from '../render-queue/index.mjs';
import { createRouter } from '../docservice/router.mjs';
import { renderQueueModule } from '../docservice/modules/render-queue.mjs';
import { makeTaskInput } from './fake-render-queue-env.mjs';
import { createQueueIdleGate } from '../queue-idle.mjs';

export const FP = 'aaaaaaaaaaaaaaaa';

/* ================================================================== Assumption manifest (copied verbatim into report) */

export const ASSUMPTIONS = Object.freeze({
  'A-X1-1': 'The executor\'s stream path still goes through createPrerenderExecutor({ pipeline, projects, prepareProject, log }).render(task, { signal, progress });'
    + 'Stream tasks are no longer rejected with code "stream-not-supported". The smoke test asserts only this (actually producing a stream needs ffmpeg, which is covered by queue-mode-probe / stream-produce-probe)',
  'A-X1-2': 'The StreamResult of a stream task goes into task.complete via the { complete: true, result } returned by sink.put (the existing path of C6.2 / J.3),'
    + 'local-node does not change its signature',
  'A-X2-1': 'checkClaimable(task, node) in filter.mjs takes this node\'s id from node.nodeId and compares it with requires.localMedia'
    + '(session-level cases go through createNodeSession({ nodeId }) separately and do not depend on this one)',
  'A-X3-1': 'The X3 decision can be made in either layer: the queue (onWatch) or the document service\'s queue module (modules/render-queue.mjs);'
    + 'The cases are driven through the combination of createRouter + renderQueueModule + createRenderQueue, covering both layers',
  'A-X3-2': 'host sending queue.watch { projects: "all" } (without mode, or with mode: "full") is also handled as a summary and receives at least one queue.summary',
  'A-X3-3': 'browser\'s watch all returns { type: "error", reason: "forbidden" } (same shape as the rejection of the H.3 summary subscription)',
  'A-X4-1': 'QUEUE_DEFAULTS.PLAN_PREFER_MS defaults to 5000 and can be overridden via createRenderQueue({ constants: { PLAN_PREFER_MS } }); the window is counted from the publish time',
  'A-X4-2': 'planTaskOf({ projectId, projectRev, preferNode }) writes preferNode into requires.preferNode',
  'A-X4-3': 'Within the window, a claim by a non-preferNode and a claim of the plan by host / browser both return task.claim-rejected (any reason name), and the task stays open',
  'A-X5-1': '"preload not ready" is simulated with FramePipeline\'s internal generations / entries: a non-aborted generation pointing to an entry whose status is "html"',
  'A-X5-2': '"Interactive frame request (drag, playback)" is simulated with the playhead() injected when FramePipeline is constructed: drag = { at: most recent, playing: false },'
    + 'playback = { at, playing: true }; Date is taken over by mock.timers, so it is consistent whether the implementation reads Date.now() or uses the passed-in now',
  'A-X5-3': '[changed in integration reconciliation] The idle gate of this machine\'s queue node is createQueueIdleGate({ pipeline, lastInteractionAt }).idle(now) in queue-idle.mjs'
    + '(isIdle: () => idleGate.idle() in vite-plugin-frames); the executor no longer has isIdle. The cases pass the pipeline itself',
});

/* ================================================================== Tasks */

/** A track stream fine-grained task (X1): `requires.capabilities.streams = true`, also with M5b's `transcode: true`. */
export function streamTask({ projectId = 'p1', seg = 0, key = 'stream-rk', requires = {} } = {}) {
  const from = seg * 8;
  return makeTaskInput({
    projectId, kind: 'stream', resultKey: key, range: [from, from + 7],
    input: { clipId: 'clip-bg', cardId: null, entryKey: null, contentKey: `${key}-ck` },
    requires: { envFingerprint: FP, transcode: true, capabilities: { streams: true }, ...requires },
    weight: { class: 'medium', estMs: null, frames: 120 },
  });
}

/** A snapshot fine-grained task; if `localMedia` is provided, write into `requires.localMedia` (X2). */
export function snapTask({ projectId = 'p1', seg = 0, key = 'snap-rk', localMedia, requires = {} } = {}) {
  const from = seg * 60;
  return makeTaskInput({
    projectId, kind: 'snapshot', tier: 'local', resultKey: key, range: [from, from + 59],
    input: { clipId: 'clip-1', cardId: 'demo', entryKey: 'e1', contentKey: `e1/${key}-ck`, canvasHeavy: false },
    requires: { envFingerprint: FP, ...(localMedia !== undefined ? { localMedia } : {}), ...requires },
    weight: { class: 'light', estMs: null, frames: 60 },
  });
}

/** plan task (X4): directly built from contract fields, write `preferNode` into `requires`. */
export function planTask({ projectId = 'p1', projectRev = 1, preferNode } = {}) {
  return makeTaskInput({
    projectId, projectRev, kind: 'plan', input: {},
    requires: preferNode !== undefined ? { preferNode } : {},
    weight: { class: 'medium', estMs: null, frames: null },
  });
}

/** [assumption A-X4-2] Publisher includes `preferNode` when building plan via `planTaskOf` */
export function planTaskViaSplit(planTaskOf, { projectId, projectRev, preferNode }) {
  return planTaskOf({ projectId, projectRev, preferNode });
}

/** [assumption A-X4-1] */
export const PLAN_PREFER_MS_DEFAULT = () => QUEUE_DEFAULTS.PLAN_PREFER_MS;

/** [assumption A-X2-1] Node descriptor carries `nodeId` */
export function nodeDescriptor({ nodeId, profile = 'pc', userId = 'u1', capabilities = {}, ...rest }) {
  return {
    nodeId, profile, userId, envFingerprint: FP, codeVersions: [], cardSourceVersions: {},
    capabilities: { transcode: true, userCards: true, graphCards: true, memoryMB: 16_000, ...capabilities },
    ...rest,
  };
}

/* ================================================================== Document service + queue module + queue (X3) */

/**
 * [assumption A-X3-1] Real router + real queue module + real queue, without network. Wiring of
 * `send` follows `sendFromOutside` in `service.mjs`: check module's `outbound` first, do not send
 * if null. Inboxes are partitioned by connId, storing messages after JSON round-trip.
 */
export function createDocQueueRig({ constants, start = 1_000_000 } = {}) {
  let t = start;
  const now = () => t;
  const inbox = new Map();
  const router = createRouter({
    now,
    write: (connId, text) => {
      if (!inbox.has(connId)) inbox.set(connId, []);
      inbox.get(connId).push(JSON.parse(text));
    },
  });
  let mod = null;
  const q = createRenderQueue({
    now,
    ...(constants ? { constants } : {}),
    send: (connId, message) => {
      let opts;
      if (typeof mod?.outbound === 'function') {
        opts = mod.outbound(connId, message);
        if (opts === null) return;
      }
      router.send(connId, message, opts);
    },
  });
  mod = renderQueueModule(q, {});
  router.mount(mod);

  const rig = {
    q, router, mod,
    now,
    advance(ms) { t += ms; },
    tick() { router.tick(); },
    connect(connId, principal = { userId: 'u1', tenantId: 't1' }) { router.connect(connId, principal); },
    send(connId, message) { router.dispatch(connId, JSON.stringify(message)); },
    node(connId, nodeId, { profile = 'pc', userId = 'u1', capabilities, watch } = {}) {
      rig.connect(connId, { userId, tenantId: 't1' });
      rig.send(connId, { type: 'node.hello', nodeId, profile, envFingerprint: FP, ...(capabilities ? { capabilities } : {}) });
      if (watch !== undefined) rig.send(connId, { type: 'queue.watch', projects: watch, reqId: `w-${connId}` });
    },
    publisher(connId, publisherId, { userId = 'u1' } = {}) {
      rig.connect(connId, { userId, tenantId: 't1' });
      rig.send(connId, { type: 'publisher.hello', publisherId });
    },
    publish(connId, tasks) { rig.send(connId, { type: 'task.publish', tasks }); },
    inbox: connId => inbox.get(connId) ?? [],
    of: (connId, type) => (inbox.get(connId) ?? []).filter(m => (Array.isArray(type) ? type.includes(m.type) : m.type === type)),
    clear(connId) { if (connId === undefined) inbox.clear(); else inbox.set(connId, []); },
  };
  return rig;
}

/* ================================================================== X5: Prerender pipeline interaction and preload */

/**
 * [assumption A-X5-2] Controllable playhead: used for `FramePipeline({ playhead })`.
 * `drag(at)` records a scrub, `play(at)` starts playback, `stop(at)` stops; `at` defaults to
 * `Date.now()` (taken over by mock.timers).
 */
export function createPlayhead() {
  let head = null;
  const fn = () => (head ? { ...head } : null);
  fn.drag = (at = Date.now()) => { head = { at, playing: false, frame: 0 }; };
  fn.play = (at = Date.now()) => { head = { at, playing: true, frame: 0 }; };
  fn.stop = (at = Date.now()) => { head = { at, playing: false, frame: 0 }; };
  fn.clear = () => { head = null; };
  return fn;
}

/** [assumption A-X5-1] Simulate a preload generation that is still running (has not reached ready) */
export function simulatePreloadRunning(pipeline, { owner = 'page-1', key = 'entry-running', status = 'html' } = {}) {
  pipeline.entries.set(key, { key, status, stage: 'required' });
  pipeline.generations.set(owner, { key, controller: new AbortController(), seenAt: Date.now() });
  return () => {
    pipeline.generations.delete(owner);
    pipeline.entries.delete(key);
  };
}

/**
 * [assumption A-X5-3] Idle gate of local queue node. Integration reconciliation: implementation
 * is gate in `queue-idle.mjs`, reading interactions on pipeline (playhead, yield, warm pool
 * playing); interactive frame request timestamp recorded by router is absent in unit tests, not
 * provided. Parameter is pipeline (originally executor).
 */
export function queueIdle(pipeline, now = Date.now()) {
  return createQueueIdleGate({ pipeline }).idle(now);
}

/* ================================================================== Miscellaneous */

export const countBy = list => list.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());

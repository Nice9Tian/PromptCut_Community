/**
 * Real executor (contract `docs/plan/render-queue-contract.md` J.4, J.7 test cases J8-J11; design
 * appendix `docs/plan/queue-executor-design.md` sections 2, 3, 7).
 * Run: node --experimental-test-module-mocks --test server/test/prerender-executor.test.mjs
 *
 * Written strictly according to contract and appendix, without looking at implementation.
 *
 * Conventions (following appendix section 7 "No Chrome", written similarly to
 * `card-lock-pipeline.test.mjs`):
 *   - `server/bakery/index.mjs` is completely mocked (`mock.module`). Mock `openBakery` returns a
 *     mock prerender chamber: `page.evaluate` returns the browserPlan for this set of scenes
 *     (`{ graph, sourceVersions, environment }`, i.e. the shape of `window.__pcCardPlan()`),
 *     and `loadProject` / `reset` / `page.setViewport` / `client.send` / `close` are all no-ops.
 *     Mock `bakeFrames` records each invocation (`out`, `targetFrames`, `snapshotFrames`, three
 *     switches), stepping through frames in the order of real `bakeFrames`
 *     (`server/bakery/bake.mjs`): checks `signal` at the start of each frame, throwing
 *     `{ cancelled: true }` if aborted (cancellation takes effect only between frames);
 *     if this frame needs a snapshot, call `onSnapshot` first, then call `onFrame` for frames in
 *     `targetFrames` (this frame's snapshot is generated before taking screenshot);
 *     `onBakeFrame(rec, frame, phase)` is called once at the start of each frame (`'start'`) and
 *     once after snapshot before screenshot (`'shot'`) (used by abort test cases).
 *     `onSnapshot` outputs depend only on (clip, frame number), independent of frame store
 *     location: the isolated single-card path (`out` under `<root>/controls/`) has one item per
 *     card with original frame numbers; the whole-scene path converts to local frames based on
 *     clip start point.
 *   - `FramePipeline` injects `environment` without probing; `dataRoot` points to temp directory
 *     (costs cannot be read, prerender set falls back to declarations); `interactive: false`.
 *     The PNG branch (`hasComplete` / `put` / `finish` of `entry.cardCache`) is stubbed.
 *   - Executor `createPrerenderExecutor({ pipeline, projects, prepareProject, log })`;
 *     `projects.get` is provided by test, and `prepareProject` is a deep copy (recording call
 *     count).
 *   - Fine-grained tasks are sliced from the executor's PlanContext by the real `splitPlan`
 *     (splitter node is this machine, same fingerprint), plus TaskView fields.
 *   - Control group: On another frame store, use existing `fillCardControls` (shared tier) /
 *     `renderLocalSnapshots` (local tier) to render the entire card at once.
 *
 * Before `server/prerender-executor.mjs` (and new `FramePipeline` methods) exist, J8-J10 each fail;
 * J11 contrasts with existing behavior and should pass.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/* ------------------------------------------------------------------ Mock prerender room */

const bakeLog = [];
/** Called at the start of each bakeFrames (used by abort test cases to abort mid-render) */
let onBake = null;
/** Called twice per frame in bakeFrames: `(rec, frame, 'start')` before checking signal, `(rec, frame, 'shot')` after snapshot and before screenshot */
let onBakeFrame = null;
/** Current scene: Prerender chamber opened by mock openBakery uses it to return browserPlan and create snapshot outputs */
let scene = null;
const opened = [];

function fakeBakery() {
  const bakery = {
    closed: false,
    page: {
      setViewport: async () => {},
      evaluate: async () => structuredClone(scene.browserPlan),
    },
    client: { send: async () => {} },
    loadProject: async () => {},
    reset: async () => {},
    close: async () => { bakery.closed = true; },
    itemsFor(frame, rec) {
      const isolated = typeof rec.out === 'string' && path.basename(path.dirname(rec.out)) === 'controls';
      if (isolated) return CLIPS.map((id) => ({ id, frame, html: `<div data-clip="${id}" data-f="${frame}">own</div>` }));
      return CLIPS.map((id) => ({ id, frame: frame - START[id] * FPS, html: `<div data-clip="${id}" data-f="${frame - START[id] * FPS}">scene</div>` }))
        .filter((item) => item.frame >= 0 && item.frame < COUNT[item.id]);
    },
  };
  return bakery;
}

mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: {
    openBakery: async () => { const b = fakeBakery(); opened.push(b); return b; },
    findFfmpeg: async () => { throw new Error('Unit test does not look for ffmpeg'); },
    streamPngVideo: () => { throw new Error('Unit test does not encode'); },
    bakeFrames: async (bakery, opts = {}) => {
      const rec = {
        out: opts.out, targetFrames: [...(opts.targetFrames ?? [])], snapshotFrames: [...(opts.snapshotFrames ?? [])].sort((a, b) => a - b),
        snapshotOnly: opts.snapshotOnly ?? null, fullFrame: opts.fullFrame ?? null, writeFrames: opts.writeFrames ?? null,
      };
      bakeLog.push(rec);
      if (onBake) await onBake(rec);
      const targets = new Set(rec.targetFrames), snaps = new Set(rec.snapshotFrames);
      for (const frame of [...new Set([...targets, ...snaps])].sort((a, b) => a - b)) {
        if (onBakeFrame) await onBakeFrame(rec, frame, 'start');
        if (opts.signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
        if (snaps.has(frame)) {
          const items = bakery?.itemsFor ? bakery.itemsFor(frame, rec) : [];
          await opts.onSnapshot?.(frame, '<div data-pc-scene=""></div>', items);
        }
        if (onBakeFrame) await onBakeFrame(rec, frame, 'shot');
        if (targets.has(frame)) await opts.onFrame?.(frame, Buffer.from(`png-${frame}`));
      }
    },
  },
});

const { FramePipeline } = await import('../frame-pipeline.mjs');
const { CardFrameCache } = await import('../card-cache.mjs');
const { describeEnvironment, resultKeyOf } = await import('../render-node/fingerprint.mjs');
const { splitPlan, planTaskOf } = await import('../render-node/split.mjs');
const { anchorFrames } = await import('../../src/render/snapshotPick.mjs');

let execMod = null, execErr = null;
async function loadExecutor() {
  if (!execMod && !execErr) {
    try { execMod = await import('../prerender-executor.mjs'); } catch (err) { execErr = err; }
  }
  if (execErr) throw new Error(`Cannot load server/prerender-executor.mjs: ${execErr.message}`);
  assert.equal(typeof execMod.createPrerenderExecutor, 'function', `prerender-executor.mjs must export createPrerenderExecutor; exports: ${Object.keys(execMod).join(', ')}`);
  return execMod;
}

/* ------------------------------------------------------------------ Scenario */

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const FPS = 30;
const OWN_ENV = describeEnvironment({
  platform: 'win32',
  renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  vendor: 'Google Inc. (Google)', chromeVersion: 'HeadlessChrome/138.0.7204.49',
});
const OWN = OWN_ENV.fingerprint;

/**
 * Five clips (5 seconds, 150 frames):
 *   clip-a  demo-a  shared tier, cacheable, 0-5 seconds, 150 frames -> split into 3 segments (0-59, 60-119, 120-149)
 *   clip-c  demo-c  shared tier, canvasHeavy, user card, 1-2 seconds, 30 frames
 *   clip-t  trans   sourceDependent (shared tier but not cacheable) -> remove from PlanContext
 *   clip-b  glass   belowDependent, local tier, 1-4 seconds, 90 frames (global frames 30-119) -> split into 2 segments
 *   clip-s  text    stateless, no prerender
 */
const START = { 'clip-a': 0, 'clip-c': 1, 'clip-t': 0, 'clip-b': 1, 'clip-s': 0 };
const END = { 'clip-a': 5, 'clip-c': 2, 'clip-t': 1, 'clip-b': 4, 'clip-s': 5 };
const CLIPS = Object.keys(START);
const COUNT = Object.fromEntries(CLIPS.map((c) => [c, Math.round((END[c] - START[c]) * FPS)]));
const CARD = { 'clip-a': 'demo-a', 'clip-c': 'demo-c', 'clip-t': 'trans', 'clip-b': 'glass', 'clip-s': 'text' };
const CAPS = {
  'clip-a': { compositing: 'independent', frameMode: 'stateful' },
  'clip-c': { compositing: 'independent', frameMode: 'stateful', canvasHeavy: true },
  'clip-t': { compositing: 'sourceDependent', frameMode: 'stateful' },
  'clip-b': { compositing: 'belowDependent', frameMode: 'stateful' },
  'clip-s': { compositing: 'independent', frameMode: 'stateless' },
};
const PID = 'queue-exec';
const REV = 3;

function projectJson() {
  return {
    id: PID, fps: FPS, width: 320, height: 180, duration: 5, style: {}, media: [],
    tracks: CLIPS.map((clipId, i) => ({ id: `t${i + 1}`, clips: [{ id: clipId, cardId: CARD[clipId], start: START[clipId], end: END[clipId] }] })),
  };
}
function browserPlanOf() {
  return {
    graph: {
      definitions: [],
      nodes: CLIPS.map((clipId) => ({ id: `n:${clipId}`, adapter: 'chrome', cardId: CARD[clipId], capabilities: { ...CAPS[clipId] }, inputs: {} })),
      outputs: CLIPS.map((clipId) => ({ nodeId: `n:${clipId}`, clipId, start: START[clipId], end: END[clipId], opacity: 1 })),
    },
    sourceVersions: { 'demo-a': 'builtin:1', 'demo-c': 'user:abc123', trans: 'builtin:2', glass: 'builtin:3', text: 'builtin:4' },
    environment: { width: 320, height: 180, fps: FPS },
  };
}

scene = { browserPlan: browserPlanOf() };

const tmpRoots = [];
async function tmpRoot(prefix = 'pc-m5b-exec-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpRoots.push(root);
  return root;
}
const pipes = [];
/** First shut down pipeline created by this case (disk writes to lock store and snapshot store may still be flushing), then delete temp directory */
async function cleanupRoots() {
  await Promise.allSettled(pipes.splice(0).map((p) => p.close()));
  await Promise.all(tmpRoots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
}

function newPipeline(root) {
  const p = new FramePipeline({ root, origin: () => 'http://127.0.0.1:1', environment: OWN_ENV, dataRoot: root, interactive: false });
  const origRecord = p.recordCardPlan.bind(p);
  p.recordCardPlan = (entry, plan) => {
    for (const c of plan ?? []) {
      if (!c.tier || c.tier === 'none') {
        const comp = c.compositing ?? c.capabilities?.compositing ?? 'unknown';
        c.tier = (comp === 'independent' || comp === 'sourceDependent') ? 'shared' : 'local';
      }
    }
    return origRecord(entry, plan);
  };
  pipes.push(p);
  return p;
}

/** Stub the PNG branch (no writes to disk) */
function stubPng(entry) {
  const puts = [];
  entry.cardCache.hasComplete = async () => false;
  entry.cardCache.put = async (key, frame) => { puts.push({ key, frame }); return true; };
  entry.cardCache.finish = async () => {};
  return puts;
}

/** Executor + project repository it uses (records calls) */
async function executorFor(pipeline, { json = projectJson() } = {}) {
  const { createPrerenderExecutor } = await loadExecutor();
  const projects = {
    calls: [],
    async get(projectId, projectRev) {
      projects.calls.push([projectId, projectRev]);
      return projectId === PID && projectRev === REV ? structuredClone(json) : null;
    },
  };
  const prepared = { n: 0 };
  const prepareProject = (value) => { prepared.n += 1; return structuredClone(value); };
  const logs = [];
  const executor = createPrerenderExecutor({ pipeline, projects, prepareProject, log: (...a) => logs.push(a) });
  assert.equal(typeof executor?.plan, 'function', 'The executor has plan');
  assert.equal(typeof executor?.render, 'function', 'The executor has render');
  // M6c integration ruling: Executor no longer has isIdle (idle threshold for PC nodes changed
  // to queue-idle.mjs, m6c-contract "Integration ruling")
  assert.equal(executor?.isIdle, undefined, 'The executor no longer has isIdle');
  return { executor, projects, prepared, prepareProject, logs };
}

const view = (task) => ({ ...structuredClone(task), state: 'claimed', version: 1, attempts: 1 });
const planView = () => view(planTaskOf({ projectId: PID, projectRev: REV }));
const signalNone = () => new AbortController().signal;

/** This version split on this machine (same fingerprint, so keys match PlanContext) */
function splitOf(ctx) {
  return splitPlan({ ...ctx, planTask: planTaskOf({ projectId: PID, projectRev: REV }), envFingerprint: OWN, codeVersion: 'cv-test' });
}
const tasksOf = (ctx, clipId) => splitOf(ctx).filter((t) => t.input.clipId === clipId).sort((a, b) => a.range.from - b.range.from);

/** Call records of bakeFrames, with `out` replaced by path relative to frame store root */
const normalize = (root, recs) => recs.map((r) => ({ ...r, out: path.relative(root, r.out).split(path.sep).join('/') }));

async function treeOf(dir) {
  const out = {};
  let names = [];
  try { names = await fs.readdir(dir); } catch { return out; }
  for (const name of names.sort()) out[name] = await fs.readFile(path.join(dir, name));
  return out;
}

/** Errors returned by executor's render: code / retryable */
async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

/* ================================================================== J8 */

test('J8 plan: entryKey equals the key that pipeline.entry() computes from the same JSON; cardId is filled in; uncacheable shared-tier cards are dropped; streams is empty', { timeout: 30_000 }, async (t) => {
  t.after(cleanupRoots);
  const B = newPipeline(await tmpRoot());
  t.after(() => B.close());
  const { executor, projects, prepared, prepareProject } = await executorFor(B);
  const bakesBefore = bakeLog.length;

  const ctx = await executor.plan(planView(), { signal: signalNone() });

  // Fetch project: retrieve this version by plan task's source, then prepareProject
  assert.deepEqual(projects.calls[0], [PID, REV], 'projects.get(projectId, projectRev)');
  assert.ok(prepared.n >= 1, 'prepareProject was called');

  // entryKey: Same as entry.key computed by another pipeline for the same JSON
  const C = newPipeline(await tmpRoot());
  t.after(() => C.close());
  const expectedKey = (await C.entry(prepareProject(projectJson()))).key;
  assert.equal(ctx.entryKey, expectedKey, 'entryKey = pipeline.entry(prepareProject(json)).key');
  assert.equal(ctx.entryKey, (await B.entry(prepareProject(projectJson()))).key, 'Also identical on the same pipeline');

  // cardPlan: Keys match real CardFrameCache.plan, added cardId, removed sourceDependent
  const reference = new CardFrameCache({ root: await tmpRoot(), project: projectJson(), envFingerprint: OWN }).plan(browserPlanOf());
  const byClip = new Map(ctx.cardPlan.map((c) => [c.clipId, c]));
  for (const clipId of ['clip-a', 'clip-c', 'clip-b']) {
    const got = byClip.get(clipId);
    const ref = reference.find((c) => c.clipId === clipId);
    assert.ok(got, `${clipId} is in cardPlan`);
    assert.equal(got.snapshotKey, ref.snapshotKey, `${clipId}: snapshotKey is the same as CardFrameCache.plan`);
    assert.equal(got.contentKey, ref.contentKey, `${clipId}: contentKey is the same`);
    assert.equal(got.count, COUNT[clipId], `${clipId}: frame count`);
  }
  for (const c of ctx.cardPlan) {
    const node = browserPlanOf().graph.nodes.find((n) => n.id === c.nodeId);
    assert.equal(c.cardId, node?.cardId, `${c.clipId}: cardId is filled in from browserPlan.graph.nodes[].cardId`);
  }
  assert.equal(byClip.has('clip-t'), false, 'Uncacheable shared-tier cards (sourceDependent) are dropped');
  assert.equal(byClip.get('clip-b').tier, 'local');

  assert.deepEqual(ctx.streams, [], 'streams is empty (J.0: streams do not go through the queue)');
  assert.ok(ctx.prerenderSet instanceof Set && ['clip-a', 'clip-c', 'clip-b'].every((c) => ctx.prerenderSet.has(c)), 'prerenderSet is included');

  // Anchor frames: anchorFrames(clips, fps), keeping only those within range
  const clips = projectJson().tracks.flatMap((tr) => tr.clips);
  const anchors = anchorFrames(clips, FPS).filter((f) => f >= 0 && f < 150);
  assert.deepEqual([...new Set(ctx.anchorFrames)].sort((a, b) => a - b), anchors);

  // isUserCard / isGraphCard / weightOf (table in appendix section 2)
  assert.equal(ctx.isUserCard(byClip.get('clip-c')), true, 'A sourceVersions entry starting with user: is a user card');
  assert.equal(ctx.isUserCard(byClip.get('clip-a')), false);
  assert.equal(ctx.isGraphCard(byClip.get('clip-a')), false);
  assert.equal(ctx.weightOf(byClip.get('clip-a')).class, 'medium', 'An ordinary shared-tier card is recorded as medium');
  assert.equal(ctx.weightOf(byClip.get('clip-c')).class, 'heavy', 'canvasHeavy is recorded as heavy');
  assert.equal(ctx.weightOf(byClip.get('clip-b')).class, 'heavy', 'A local-tier card (belowDependent) is recorded as heavy');

  // E.5 invariant: Splitting with same fingerprint, shared tier task's resultKey is control.snapshotKey
  const tasks = splitOf(ctx);
  for (const task of tasks.filter((x) => x.tier === 'shared')) {
    assert.equal(task.resultKey, byClip.get(task.input.clipId).snapshotKey, `${task.id}: resultKey === snapshotKey`);
  }
  for (const task of tasks.filter((x) => x.tier === 'local')) {
    assert.equal(task.input.entryKey, ctx.entryKey);
    assert.equal(task.input.contentKey, `${ctx.entryKey}/${byClip.get(task.input.clipId).contentKey}`);
    assert.equal(task.resultKey, resultKeyOf(task.input.contentKey, OWN));
  }
  assert.deepEqual(tasks.map((x) => x.input.clipId).sort(), ['clip-a', 'clip-a', 'clip-a', 'clip-b', 'clip-b', 'clip-c'], 'Splits into a×3, b×2, c×1, no t');
  assert.equal(tasks.filter((x) => x.kind === 'stream').length, 0);

  // plan only computes the plan, does not render; does not borrow the background lane
  assert.equal(bakeLog.length, bakesBefore, 'plan does not call bakeFrames');
  assert.equal(B.lanes.has('background'), false, 'plan does not borrow the background lane (attachment section 2: a new queue lane)');
});

test('J8 plan: when no snapshot can be fetched, throws { code: no-snapshot, retryable: true } and does not open a prerender room', async (t) => {
  t.after(cleanupRoots);
  const B = newPipeline(await tmpRoot());
  t.after(() => B.close());
  const { executor } = await executorFor(B);
  const openedBefore = opened.length;
  const task = view(planTaskOf({ projectId: PID, projectRev: REV + 1 }));
  const err = await rejectionOf(executor.plan(task, { signal: signalNone() }));
  assert.ok(err, 'plan fails');
  assert.equal(err.code, 'no-snapshot', `code: ${err?.code} ${err?.message}`);
  assert.equal(err.retryable, true, 'Retryable (the snapshot may still be uploading)');
  assert.equal(opened.length, openedBefore, 'No prerender room was opened');
});

// J8 (executor's isIdle) invalidated in M6c: executor no longer has isIdle; local queue node's
// idle threshold changed to `queue-idle.mjs` (contract m6c-contract X5 and "Integration ruling"),
// criteria covered by X5-1 to X5-3 in `m6c-queue-impl.test.mjs`.

/* ================================================================== J9 */

test('J9 render (shared tier, batch by batch: single-pass push turned off): renders the whole card segment by segment, 60 frames per segment; compared with fillCardControls rendering it all at once, the bakeFrames call records and the files written to disk are identical; progress callback', { timeout: 45_000 }, async (t) => {
  t.after(cleanupRoots);
  // Control: Frame store A, existing fillCardControls renders clip-a all at once
  const rootA = await tmpRoot();
  const A = newPipeline(rootA);
  t.after(() => A.close());
  await A.ensureCardLocks();
  const entryA = await A.entry(projectJson());
  A.recordCardPlan(entryA, entryA.cardCache.plan(browserPlanOf()));
  stubPng(entryA);
  const ctlA = entryA.cardPlan.find((c) => c.clipId === 'clip-a');
  let mark = bakeLog.length;
  await A.fillCardControls(entryA, fakeBakery(), null, [ctlA]);
  const recA = normalize(rootA, bakeLog.slice(mark));
  assert.equal(recA.length, 38, 'Fixture: 150 frames in batches of 4 frames is 38 batches');

  // Executor: Frame store B, render segment by segment after plan
  const rootB = await tmpRoot();
  const B = newPipeline(rootB);
  B.queueSinglePassOff = true; // Batch-by-batch path (canvas heavy card, segments requested by playhead, when switch is off)
  t.after(() => B.close());
  const { executor } = await executorFor(B);
  const ctx = await executor.plan(planView(), { signal: signalNone() });
  const entryB = B.entries.get(ctx.entryKey);
  assert.ok(entryB, 'After plan, the entry is in the pipeline');
  stubPng(entryB);
  const tasks = tasksOf(ctx, 'clip-a');
  assert.deepEqual(tasks.map((x) => [x.range.from, x.range.to]), [[0, 59], [60, 119], [120, 149]]);
  assert.equal(tasks[0].resultKey, ctlA.snapshotKey, 'The keys on both sides are the same');

  mark = bakeLog.length;
  const progress = [];
  for (const task of tasks) {
    const seen = [];
    const out = await executor.render(view(task), { signal: signalNone(), progress: (done) => seen.push(done) });
    assert.equal(out, null, 'render returns null (the sink reads the disk itself)');
    progress.push({ task, seen });
  }
  const recB = normalize(rootB, bakeLog.slice(mark));
  assert.deepEqual(recB, recA, 'The bakeFrames call records are identical (batch start, targetFrames, snapshotFrames, switches)');

  const dirA = path.join(rootA, 'controls-html', ctlA.snapshotKey);
  const dirB = path.join(rootB, 'controls-html', tasks[0].resultKey);
  const [treeA, treeB] = [await treeOf(dirA), await treeOf(dirB)];
  assert.equal(Object.keys(treeA).length, 151, 'Control group: 150 frames + index.json');
  assert.deepEqual(Object.keys(treeB), Object.keys(treeA), 'The file names written to disk are the same');
  for (const name of Object.keys(treeA)) assert.ok(treeA[name].equals(treeB[name]), `${name} is byte-for-byte identical`);

  for (const { task, seen } of progress) {
    const n = task.range.to - task.range.from + 1;
    assert.ok(seen.length >= 1, `${task.id}: progress was reported`);
    assert.ok(seen.every((v) => Number.isFinite(v) && v >= 0 && v <= n), `${task.id}: progress is within 0..${n}: ${seen}`);
    assert.ok(seen.every((v, i) => i === 0 || v >= seen[i - 1]), `${task.id}: progress does not go backwards: ${seen}`);
    assert.ok(seen.at(-1) > 0, `${task.id}: the final progress is greater than 0`);
  }
});

/** The PNG branch uses real CardFrameCache (mock PNG lands as-is in `controls/<key>/mov/frames/`), only stubbing finish which requires ffmpeg */
function realPng(entry) {
  entry.cardCache.finish = async () => {};
}
const pngTreeOf = (root, key) => treeOf(path.join(root, 'controls', key, 'mov', 'frames'));
const pngNames = (tree) => Object.keys(tree).filter((n) => n.endsWith('.png'));
const htmlFramesOf = (tree) => Object.keys(tree).filter((n) => n.endsWith('.html')).map((n) => Number(n.slice(0, -5))).sort((a, b) => a - b);
const pngFramesOf = (tree) => pngNames(tree).map((n) => Number(n.slice(0, -4))).sort((a, b) => a - b);
const span = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
/** Progress sequence for this segment when submitting every 4 frames: 4, 8, …, n */
const progressBy4 = (n) => Array.from({ length: Math.ceil(n / 4) }, (_, i) => Math.min(4 * (i + 1), n));

/** Control group: frame store A, existing fillCardControls renders clip-a in one pass (snapshots and PNGs hit disk) */
async function oneShotClipA() {
  const rootA = await tmpRoot();
  const A = newPipeline(rootA);
  await A.ensureCardLocks();
  const entryA = await A.entry(projectJson());
  A.recordCardPlan(entryA, entryA.cardCache.plan(browserPlanOf()));
  realPng(entryA);
  const ctlA = entryA.cardPlan.find((c) => c.clipId === 'clip-a');
  const mark = bakeLog.length;
  await A.fillCardControls(entryA, fakeBakery(), null, [ctlA]);
  const recs = normalize(rootA, bakeLog.slice(mark));
  const html = await treeOf(path.join(rootA, 'controls-html', ctlA.snapshotKey));
  const png = await pngTreeOf(rootA, ctlA.key);
  return { ctlA, recs, html, png };
}

/** Executor on frame store B, forward push one pass per segment (default on); records frames in snapshot store */
async function singlePassExecutor() {
  const rootB = await tmpRoot();
  const B = newPipeline(rootB);
  assert.notEqual(B.queueSinglePassOff, true, 'Single-pass push per segment is on by default');
  const { executor } = await executorFor(B);
  const ctx = await executor.plan(planView(), { signal: signalNone() });
  const entryB = B.entries.get(ctx.entryKey);
  realPng(entryB);
  const store = B.snapshots();
  const commits = [];
  const commit = store.commitSnapshots.bind(store);
  store.commitSnapshots = (args) => { commits.push(args.items.map((item) => item.localFrame)); return commit(args); };
  const ctlB = entryB.cardPlan.find((c) => c.clipId === 'clip-a');
  const tasks = tasksOf(ctx, 'clip-a');
  for (const task of tasks) assert.equal(B.queueSinglePass(ctlB, task.range), true, `${task.id}: this segment uses single-pass push`);
  return { rootB, B, executor, ctx, ctlB, tasks, commits };
}

test('J9b render (shared tier, single-pass push per segment): bakeFrames is called only once per segment and its frame set equals the union of the batch-by-batch runs; the snapshot and PNG files written to disk are byte-for-byte identical to fillCardControls rendering it all at once; commits and progress still go by 4 frames', { timeout: 45_000 }, async (t) => {
  t.after(cleanupRoots);
  const A = await oneShotClipA();
  assert.equal(A.recs.length, 38, 'Fixture: the control group\'s 150 frames in batches of 4 frames is 38 batches');
  assert.equal(Object.keys(A.html).length, 151, 'Control group: 150 frames + index.json');
  assert.equal(pngNames(A.png).length, 150, 'Control group: 150 PNG frames');

  const { rootB, executor, ctlB, tasks, commits } = await singlePassExecutor();
  assert.deepEqual(tasks.map((x) => [x.range.from, x.range.to]), [[0, 59], [60, 119], [120, 149]]);
  assert.equal(tasks[0].resultKey, A.ctlA.snapshotKey, 'The snapshot keys on both sides are the same');
  assert.equal(ctlB.key, A.ctlA.key, 'The PNG cache keys on both sides are the same');

  const mark = bakeLog.length;
  const progress = [];
  for (const task of tasks) {
    const seen = [];
    const out = await executor.render(view(task), { signal: signalNone(), progress: (done) => seen.push(done) });
    assert.equal(out, null, 'render returns null (the sink reads the disk itself)');
    progress.push({ task, seen });
  }
  const recB = normalize(rootB, bakeLog.slice(mark));
  assert.equal(recB.length, 3, 'One bakeFrames call for each of the three segments');
  const { targetFrames: _t, snapshotFrames: _s, ...rest } = A.recs[0];
  tasks.forEach((task, i) => {
    assert.deepEqual(recB[i].targetFrames, span(task.range.from, task.range.to), `${task.id}: targetFrames is the whole segment`);
    assert.deepEqual(recB[i].snapshotFrames, span(task.range.from, task.range.to), `${task.id}: snapshotFrames is the whole segment (all missing)`);
    const { targetFrames: _tb, snapshotFrames: _sb, ...restB } = recB[i];
    assert.deepEqual(restB, rest, `${task.id}: out and the three switches are the same as in the batch-by-batch run`);
  });
  assert.deepEqual(recB.flatMap((r) => r.targetFrames), A.recs.flatMap((r) => r.targetFrames), 'The union of targetFrames equals that of the batch-by-batch run');
  assert.deepEqual(recB.flatMap((r) => r.snapshotFrames), A.recs.flatMap((r) => r.snapshotFrames), 'The union of snapshotFrames equals that of the batch-by-batch run');

  const html = await treeOf(path.join(rootB, 'controls-html', tasks[0].resultKey));
  assert.deepEqual(Object.keys(html), Object.keys(A.html), 'The snapshot file names are the same');
  for (const name of Object.keys(A.html)) assert.ok(A.html[name].equals(html[name]), `Snapshot ${name} is byte-for-byte identical`);
  const png = await pngTreeOf(rootB, ctlB.key);
  assert.deepEqual(pngNames(png), pngNames(A.png), 'The PNG file names are the same');
  for (const name of pngNames(A.png)) assert.ok(A.png[name].equals(png[name]), `PNG ${name} is byte-for-byte identical`);

  // Storing still submits every 4 frames: each submission is a group aligned to 4 frames
  assert.deepEqual(commits.flat(), span(0, 149), 'The committed frames together make up the whole card, in order');
  for (const frames of commits) {
    assert.ok(frames.length >= 1 && frames.length <= 4, `A single commit has at most 4 frames: ${frames}`);
    assert.equal(frames[0] % 4, 0, `A single commit starts at a 4-frame boundary: ${frames}`);
    assert.deepEqual(frames, span(frames[0], frames[0] + frames.length - 1), `A single commit is one contiguous group: ${frames}`);
  }
  for (const { task, seen } of progress) {
    const n = task.range.to - task.range.from + 1;
    assert.deepEqual(seen, progressBy4(n), `${task.id}: progress is reported in steps of 4 frames`);
  }
});

/* ================================================================== J10 */

test('J10 render (local tier): converts each segment to global frames and renders only the frames this card is missing; compared with renderLocalSnapshots rendering it all at once, the frame set and the files written to disk are identical', { timeout: 45_000 }, async (t) => {
  t.after(cleanupRoots);
  const rootA = await tmpRoot();
  const A = newPipeline(rootA);
  t.after(() => A.close());
  await A.ensureCardLocks();
  const entryA = await A.entry(projectJson());
  A.recordCardPlan(entryA, entryA.cardCache.plan(browserPlanOf()));
  const ctlA = entryA.cardPlan.find((c) => c.clipId === 'clip-b');
  assert.equal(ctlA.tier, 'local');
  let mark = bakeLog.length;
  await A.renderLocalSnapshots(entryA, await A.missingSnapshotFrames(entryA, { tiers: ['local'] }), fakeBakery());
  const recA = normalize(rootA, bakeLog.slice(mark));
  assert.equal(recA.length, 1, 'Control group: local tier, one whole-scene pass');
  assert.deepEqual(recA[0].targetFrames, Array.from({ length: 90 }, (_, i) => 30 + i), 'Control group: global frames 30-119');

  const rootB = await tmpRoot();
  const B = newPipeline(rootB);
  t.after(() => B.close());
  const { executor } = await executorFor(B);
  const ctx = await executor.plan(planView(), { signal: signalNone() });
  const tasks = tasksOf(ctx, 'clip-b');
  assert.deepEqual(tasks.map((x) => [x.range.from, x.range.to]), [[0, 59], [60, 89]]);
  mark = bakeLog.length;
  const seenAll = [];
  for (const task of tasks) {
    const seen = [];
    await executor.render(view(task), { signal: signalNone(), progress: (done) => seen.push(done) });
    seenAll.push(seen);
  }
  const recB = normalize(rootB, bakeLog.slice(mark));
  assert.equal(recB.length, 2, 'One whole-scene pass per segment');
  assert.deepEqual(recB[0].targetFrames, Array.from({ length: 60 }, (_, i) => 30 + i), 'First segment: local frames 0-59 → global frames 30-89');
  assert.deepEqual(recB[1].targetFrames, Array.from({ length: 30 }, (_, i) => 90 + i), 'Second segment: local frames 60-89 → global frames 90-119');
  assert.deepEqual(recB.flatMap((r) => r.targetFrames), recA[0].targetFrames, 'Combined, they equal the control group\'s frame set');
  for (const r of recB) {
    assert.deepEqual(r.snapshotFrames, r.targetFrames, 'snapshotFrames equals targetFrames (as in renderLocalSnapshots)');
    assert.deepEqual({ out: r.out, snapshotOnly: r.snapshotOnly, fullFrame: r.fullFrame, writeFrames: r.writeFrames },
      { out: recA[0].out, snapshotOnly: recA[0].snapshotOnly, fullFrame: recA[0].fullFrame, writeFrames: recA[0].writeFrames }, 'The remaining parameters follow renderLocalSnapshots');
  }
  const sub = ['controls-local', ctx.entryKey, ctlA.snapshotKey];
  const [treeA, treeB] = [await treeOf(path.join(rootA, ...sub)), await treeOf(path.join(rootB, ...sub))];
  assert.equal(Object.keys(treeA).length, 91, 'Control group: 90 frames + index.json');
  assert.deepEqual(Object.keys(treeB), Object.keys(treeA), 'The file names written to disk are the same');
  for (const name of Object.keys(treeA)) assert.ok(treeA[name].equals(treeB[name]), `${name} is byte-for-byte identical`);
  for (const seen of seenAll) {
    assert.ok(seen.length >= 1 && seen.every((v) => Number.isFinite(v) && v >= 0), `The local tier reports progress too: ${seen}`);
  }

  // Existing frames are not re-rendered: re-render first segment → do not call bakeFrames
  // (or no frames in the call)
  mark = bakeLog.length;
  await executor.render(view(tasks[0]), { signal: signalNone(), progress: () => {} });
  const again = bakeLog.slice(mark).flatMap((r) => r.targetFrames);
  assert.deepEqual(again, [], 'This card is already complete in this segment: no more rendering');
});

test('J10 render (local tier): frames already present in this segment are not rendered, only the missing ones', { timeout: 30_000 }, async (t) => {
  t.after(cleanupRoots);
  const rootB = await tmpRoot();
  const B = newPipeline(rootB);
  t.after(() => B.close());
  const { executor } = await executorFor(B);
  const ctx = await executor.plan(planView(), { signal: signalNone() });
  const ctl = ctx.cardPlan.find((c) => c.clipId === 'clip-b');
  // Preset local frames 10-19 (global frames 40-49)
  await B.snapshots().commitSnapshots({ tier: 'local', entryKey: ctx.entryKey, key: ctl.snapshotKey, clipId: 'clip-b', capabilities: ctl.capabilities,
    items: Array.from({ length: 10 }, (_, i) => ({ localFrame: 10 + i, html: `<p>seed ${10 + i}</p>` })) });
  const [first] = tasksOf(ctx, 'clip-b');
  const mark = bakeLog.length;
  await executor.render(view(first), { signal: signalNone(), progress: () => {} });
  const frames = bakeLog.slice(mark).flatMap((r) => r.targetFrames);
  const expected = Array.from({ length: 60 }, (_, i) => 30 + i).filter((g) => g < 40 || g > 49);
  assert.deepEqual(frames, expected, 'Only the missing global frames are rendered (skipping 40-49)');
  const seeded = await fs.readFile(path.join(rootB, 'controls-local', ctx.entryKey, ctl.snapshotKey, '10.html'), 'utf8');
  assert.equal(seeded, '<p>seed 10</p>', 'Existing frames are not overwritten');
});

test('J10 render: throws plan-mismatch (not retryable) and does not render when a task does not match the plan; stream tasks throw no-streams when there is no track stream producer (since M6c X1 it no longer throws stream-not-supported)', { timeout: 30_000 }, async (t) => {
  t.after(cleanupRoots);
  const B = newPipeline(await tmpRoot());
  t.after(() => B.close());
  const { executor } = await executorFor(B);
  const ctx = await executor.plan(planView(), { signal: signalNone() });
  const [shared] = tasksOf(ctx, 'clip-a');
  const [local] = tasksOf(ctx, 'clip-b');
  const mut = (task, fn) => { const copy = view(task); fn(copy); return copy; };
  const cases = [
    ['Shared-tier contentKey differs', mut(shared, (x) => { x.input.contentKey = 'f'.repeat(64); })],
    ['Shared-tier resultKey is not the key of this machine\'s fingerprint', mut(shared, (x) => { x.resultKey = resultKeyOf(x.input.contentKey, 'aaaaaaaaaaaaaaaa'); })],
    ['Tier differs (a shared-tier card treated as local tier)', mut(shared, (x) => { x.tier = 'local'; })],
    ['Range out of bounds', mut(shared, (x) => { x.range = { unit: 'localFrame', from: 120, to: 150 }; })],
    ['Clip does not exist', mut(shared, (x) => { x.input.clipId = 'clip-nope'; })],
    ['A dropped card (sourceDependent)', mut(shared, (x) => { x.input.clipId = 'clip-t'; })],
    ['Local-tier entryKey differs', mut(local, (x) => { x.input.entryKey = sha256('other-entry'); x.input.contentKey = `${x.input.entryKey}/${x.input.contentKey.split('/')[1]}`; })],
    ['Local-tier contentKey lacks the entryKey prefix', mut(local, (x) => { x.input.contentKey = x.input.contentKey.split('/')[1]; })],
  ];
  const mark = bakeLog.length;
  for (const [what, task] of cases) {
    const err = await rejectionOf(executor.render(task, { signal: signalNone(), progress: () => {} }));
    assert.ok(err, `${what}: must fail`);
    assert.equal(err.code, 'plan-mismatch', `${what}: code is plan-mismatch: ${err?.code} ${err?.message}`);
    assert.equal(err.retryable, false, `${what}: not retryable`);
  }
  const stream = view({
    id: `stream:${'c'.repeat(64)}:0-7`, kind: 'stream', resultKey: 'c'.repeat(64), range: { unit: 'segment', from: 0, to: 7 },
    source: { projectId: PID, projectRev: REV, derivedFrom: `plan:${PID}@${REV}` },
    input: { clipId: 'clip-a', cardId: null, entryKey: null, contentKey: 'd'.repeat(64) },
    weight: { class: 'heavy', estMs: null, frames: 120 }, requires: { envFingerprint: OWN, codeVersion: 'cv-test' }, priority: 10,
  });
  const serr = await rejectionOf(executor.render(stream, { signal: signalNone(), progress: () => {} }));
  assert.ok(serr, 'The stream task must fail');
  // M6c X1: Executor accepts stream tasks; this pipeline has interactive: false and no track
  // stream producer, so it returns no-streams (non-retryable)
  assert.equal(serr.code, 'no-streams');
  assert.equal(serr.retryable, false);
  assert.equal(bakeLog.length, mark, 'A task that does not match renders no frames at all');
});

test('J10 render (batch by batch: single-pass push turned off): abort midway → rejects, stops at a batch boundary, writes no further frames; a re-render with a new signal afterwards can fill in the rest', { timeout: 30_000 }, async (t) => {
  t.after(cleanupRoots);
  t.after(() => { onBake = null; });
  const rootB = await tmpRoot();
  const B = newPipeline(rootB);
  B.queueSinglePassOff = true; // Batch-by-batch path (canvas heavy card, segments requested by playhead, when switch is off)
  t.after(() => B.close());
  const { executor } = await executorFor(B);
  const ctx = await executor.plan(planView(), { signal: signalNone() });
  const entryB = B.entries.get(ctx.entryKey);
  stubPng(entryB);
  const [first] = tasksOf(ctx, 'clip-a');
  const controller = new AbortController();
  let calls = 0;
  onBake = async () => { calls += 1; if (calls === 2) controller.abort(); };
  const mark = bakeLog.length;
  const err = await rejectionOf(executor.render(view(first), { signal: controller.signal, progress: () => {} }));
  onBake = null;
  assert.ok(err, 'render rejects after abort');
  assert.notEqual(err.code, 'plan-mismatch', 'not plan-mismatch');
  assert.ok(bakeLog.length - mark <= 3, `stops at a batch boundary: at most one more batch after the abort, actually ${bakeLog.length - mark} batches (15 batches for the whole segment)`);
  const dir = path.join(rootB, 'controls-html', first.resultKey);
  const written = Object.keys(await treeOf(dir)).filter((n) => n.endsWith('.html')).length;
  assert.ok(written < 60, `did not write the whole segment: ${written} frames`);

  await executor.render(view(first), { signal: signalNone(), progress: () => {} });
  const after = Object.keys(await treeOf(dir)).filter((n) => n.endsWith('.html')).length;
  assert.equal(after, 60, 're-render fills in this segment');
});

test('J10b render (one sequential pass per segment): abort midway → rejected, no snapshots or PNGs written after the abort point, committed snapshots reach only a 4-frame boundary; re-rendering afterwards with a new signal fills in the rest, and the whole card on disk is byte-for-byte identical to a single full render', { timeout: 45_000 }, async (t) => {
  t.after(cleanupRoots);
  t.after(() => { onBakeFrame = null; });
  const A = await oneShotClipA();
  const { rootB, executor, ctlB, tasks, commits } = await singlePassExecutor();
  const [first, ...others] = tasks;
  const htmlDir = path.join(rootB, 'controls-html', first.resultKey);

  // Frame 15 snapshot has been generated, abort before screenshot: snapshots for the 12-15 group
  // are all generated, but submitting to store (when frame 15 screenshot finishes) is after abort,
  // so they should not be stored
  const ABORT_AT = 15;
  const controller = new AbortController();
  onBakeFrame = async (_rec, frame, phase) => { if (frame === ABORT_AT && phase === 'shot') controller.abort(); };
  const seen = [];
  let mark = bakeLog.length;
  const err = await rejectionOf(executor.render(view(first), { signal: controller.signal, progress: (done) => seen.push(done) }));
  onBakeFrame = null;
  assert.ok(err, 'render rejects after abort');
  assert.notEqual(err.code, 'plan-mismatch', 'not plan-mismatch');
  assert.equal(err.cancelled, true, `rejected as a cancellation: ${err?.message}`);
  const aborted = bakeLog.slice(mark);
  assert.equal(aborted.length, 1, 'sequential pass: this segment called bakeFrames only once');
  assert.deepEqual(aborted[0].targetFrames, span(0, 59));

  const html = await treeOf(htmlDir);
  assert.deepEqual(htmlFramesOf(html), span(0, 11), 'snapshots are written only up to the groups committed before the abort point (12-15 were generated but the abort came before the commit)');
  const index = JSON.parse(html['index.json'].toString('utf8'));
  assert.deepEqual(index.frames, [[0, 11]], `index.json contains only complete 4-frame groups: ${JSON.stringify(index)}`);
  assert.equal(index.count, 12);
  for (const n of htmlFramesOf(html)) assert.ok(html[`${n}.html`].equals(A.html[`${n}.html`]), `written snapshot ${n} is identical to a single full render`);
  assert.deepEqual(commits, [span(0, 3), span(4, 7), span(8, 11)], 'committed three times, one 4-frame group each time');
  assert.deepEqual(seen, [4, 8, 12], 'progress is reported only for the groups that were committed');

  const png = await pngTreeOf(rootB, ctlB.key);
  assert.deepEqual(pngFramesOf(png), span(0, ABORT_AT - 1), 'PNG is written only up to the abort point (the abort frame and everything after it are not written)');
  for (const name of pngNames(png)) assert.ok(png[name].equals(A.png[name]), `written PNG ${name} is complete and identical to a single full render`);

  // Re-render this segment on new signal: push another pass from start, snapshots only fill missing 12-59
  mark = bakeLog.length;
  const seen2 = [];
  await executor.render(view(first), { signal: signalNone(), progress: (done) => seen2.push(done) });
  const retry = bakeLog.slice(mark);
  assert.equal(retry.length, 1, 're-rendering this segment is still a single pass');
  assert.deepEqual(retry[0].targetFrames, span(0, 59), 're-render: the PNG branch still needs the whole segment, as before');
  assert.deepEqual(retry[0].snapshotFrames, span(12, 59), 're-render: snapshots fill in only the missing ones');
  assert.deepEqual(htmlFramesOf(await treeOf(htmlDir)), span(0, 59), 're-render fills in this segment');
  assert.deepEqual(seen2, progressBy4(60), 're-render progress is still reported per 4 frames');

  for (const task of others) await executor.render(view(task), { signal: signalNone(), progress: () => {} });
  const htmlAll = await treeOf(htmlDir);
  assert.deepEqual(Object.keys(htmlAll), Object.keys(A.html), 'whole card: snapshot file names match a single full render');
  for (const name of Object.keys(A.html)) assert.ok(A.html[name].equals(htmlAll[name]), `whole card: snapshot ${name} is byte-for-byte identical`);
  const pngAll = await pngTreeOf(rootB, ctlB.key);
  assert.deepEqual(pngNames(pngAll), pngNames(A.png), 'whole card: PNG file names match a single full render');
  for (const name of pngNames(A.png)) assert.ok(A.png[name].equals(pngAll[name]), `whole card: PNG ${name} is byte-for-byte identical`);
});

/* ================================================================== J11 */

/** Existing fillCardControls behavior on clip-a: 38 batches of 4 frames (last batch 2 frames); snapshotFrames deducts existing */
function expectedFullCard(control, have = new Set()) {
  const out = [];
  for (let first = 0; first < control.count; first += 4) {
    const frames = Array.from({ length: Math.min(4, control.count - first) }, (_, n) => first + n);
    out.push({
      out: `controls/${control.key}`, targetFrames: frames, snapshotFrames: frames.filter((n) => !have.has(n)),
      snapshotOnly: false, fullFrame: true, writeFrames: false,
    });
  }
  return out;
}

async function fullCardRun(extraArgs) {
  const root = await tmpRoot();
  const P = newPipeline(root);
  try {
    await P.ensureCardLocks();
    const entry = await P.entry(projectJson());
    P.recordCardPlan(entry, entry.cardCache.plan(browserPlanOf()));
    stubPng(entry);
    const ctl = entry.cardPlan.find((c) => c.clipId === 'clip-a');
    await P.snapshots().commitSnapshots({ tier: 'shared', key: ctl.snapshotKey, clipId: 'clip-a', capabilities: ctl.capabilities,
      items: Array.from({ length: 10 }, (_, i) => ({ localFrame: i, html: `<p>seed ${i}</p>` })) });
    const mark = bakeLog.length;
    const args = [entry, fakeBakery(), null, [ctl], ...extraArgs];
    await P.fillCardControls(...args);
    const recs = normalize(root, bakeLog.slice(mark));
    const tree = await treeOf(path.join(root, 'controls-html', ctl.snapshotKey));
    return { ctl, recs, tree };
  } finally {
    await P.close();
  }
}

test('J11 fillCardControls behaves the same when no range argument is passed: batches, targetFrames, snapshotFrames (minus the existing ones) and what is written to disk are the same as now', { timeout: 45_000 }, async (t) => {
  t.after(cleanupRoots);
  const base = await fullCardRun([]);
  const have = new Set(Array.from({ length: 10 }, (_, i) => i));
  assert.deepEqual(base.recs, expectedFullCard(base.ctl, have), 'without the 5th argument: identical to the current behavior, item by item');
  assert.equal(Object.keys(base.tree).filter((n) => n.endsWith('.html')).length, 150, 'all 150 frames of the whole card are present');
  assert.equal(base.tree['0.html'].toString(), '<p>seed 0</p>', 'existing frames are not overwritten');

  // Passing empty object or undefined for 5th argument: same as omitting it
  for (const extra of [[undefined], [{}]]) {
    const run = await fullCardRun(extra);
    assert.deepEqual(run.recs, base.recs, `5th argument ${JSON.stringify(extra[0])}: call records unchanged`);
    assert.deepEqual(Object.keys(run.tree), Object.keys(base.tree));
    for (const name of Object.keys(base.tree)) assert.ok(run.tree[name].equals(base.tree[name]), `${name} is identical`);
  }
  // Range covers the entire card: same as omitting it
  const whole = await fullCardRun([{ range: { from: 0, to: 149 } }]);
  assert.deepEqual(whole.recs, base.recs, 'when the range is the whole card, the result is the same as not passing it');
});

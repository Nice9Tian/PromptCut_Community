/*
 * Scheduling of query render (`docs/semantics/product/rendering.md` "Agent priority is only
 * queue-jumping", "Operation previews in the AI panel can jump the queue";
 * `docs/semantics/mechanism/rendering.md` "Query render and prerender process"; report
 * `docs/reports/AGENT-query-render.md`).
 *
 *   QR-G1-*  Operation previews opened by user in AI panel (`'preview'` batch of `see_frames`):
 *            does not enter Agent lane, inserted ahead of all pending items in normal prerender
 *            queue, does not interrupt currently running item, Agent dedicated instance will not
 *            take it even if idle; requests requested by model itself still go through Agent lane.
 *   QR-G2-*  Agent dedicated instance takes normal prerenders when idle: only when Agent queue is
 *            empty, one item at a time; when Agent task arrives, runs first after current item
 *            finishes without queuing behind pending prerenders; does not launch Chrome to take
 *            prerenders; same card is not rendered on two instances concurrently; editor process
 *            still has no Agent lane; card batches from background pass can be borrowed, each batch
 *            processed only once, finalized only once.
 *
 * All browsers replaced: lanes pre-populated with fake prerender rooms (`acquire` takes "reuse,
 * reset" path), `bakeFrames` replaced with fake.
 * Run: `node --experimental-test-module-mocks --test server/test/query-render.test.mjs`
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const gate = () => { let open; const p = new Promise(resolve => { open = resolve; }); return { p, open }; };
async function until(check, ms = 3000) {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error('Timed out waiting for the condition');
    await sleep(1);
  }
}

/** Fake `bakeFrames`: records which frames pushed to which prerender room, calls `onFrame` per frame */
const bakeLog = [];
let onBakeStart = null;
mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: {
    openBakery: async () => { throw new Error('Chrome is not opened here'); },
    findFfmpeg: async () => 'ffmpeg',
    bakeFrames: async (bakery, opts = {}) => {
      const rec = { bakery: bakery?.name, frames: [...(opts.targetFrames ?? [])] };
      bakeLog.push({ ...rec, phase: 'start' });
      if (onBakeStart) await onBakeStart(rec);
      await sleep(8);
      for (const frame of rec.frames) {
        if (opts.signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
        await opts.onFrame?.(frame, Buffer.from(`png-${frame}`));
      }
      bakeLog.push({ ...rec, phase: 'end' });
    },
  },
});

const { FramePipeline } = await import('../frame-pipeline.mjs');

const project = { id: 'p1', width: 64, height: 36, fps: 30, duration: 4, tracks: [], media: [] };

function fakeBakery(name, log = []) {
  const bakery = {
    name, scales: [],
    reset: async () => { log.push(`${name}.reset`); },
    page: { setViewport: async ({ deviceScaleFactor }) => { bakery.scales.push(deviceScaleFactor); }, evaluate: async () => null },
    client: { send: async () => {} },
    close: async () => { bakery.closed = true; log.push(`${name}.close`); },
  };
  return bakery;
}

const tmpRoots = [];
function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-query-render-'));
  tmpRoots.push(dir);
  return dir;
}
test.after(() => { for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true }); });

/**
 * `agentOpen`: whether prerender room for Agent dedicated instance is open (used recently by
 * Agent). Prerender room for `'queue'` lane is always pre-populated.
 * `readFramesCore` replaced with "borrow, record which lane and on which prerender room".
 */
function harness({ agentOpen = false, interactive = true, graceMs = 0 } = {}) {
  const log = [];
  const svc = new FramePipeline({ root: tmpRoot(), origin: () => 'http://127.0.0.1:1', interactive });
  // Grace period (`AGENT_GRACE_MS`) after Agent task completes is only measured in QR-G2-10;
  // other cases use 0
  svc.agentGraceMs = graceMs;
  const bakeries = { queue: fakeBakery('queue', log), agent: fakeBakery('agent', log) };
  svc.lanes.set('queue', { bakery: bakeries.queue });
  if (agentOpen) svc.lanes.set('agent', { bakery: bakeries.agent });
  const entry = { key: 'k', project, dir: '.', html: new Map(), controls: new Map(), recordVersion: 0 };
  svc.entry = async () => entry;
  svc.readFramesCore = async (_entry, frames, lane, _signal, _onSession, _onFrame, lease) => {
    const bakery = lease ? await lease(project) : await svc.acquire(lane, project);
    log.push(`${lane}@${bakery.name}`);
    await sleep(5);
    if (!lease) svc.release(lane);
    return new Map(frames.map(n => [n, { buf: Buffer.alloc(0), source: 'mov' }]));
  };
  /** Queues normal prerender: on start records `<name>:start@<prerender room>`, after release `<name>:end` */
  const task = (name, { hold = null, ...options } = {}) => svc.runQueueTask(async lease => {
    const bakery = await lease(project);
    log.push(`${name}:start@${bakery.name}`);
    if (hold) await hold.p;
    log.push(`${name}:end`);
    return name;
  }, undefined, options);
  return { svc, log, bakeries, task };
}

/* ------------------------------------------------------------------ G1 */

test('QR-G1-1 an operation preview opened by the user does not enter the Agent lane: it renders on the prerender room of the queue lane at 1x scale; the Agent dedicated instance is never borrowed', async () => {
  const before = process.env.PROMPTCUT_PRERENDER_SCALE;
  process.env.PROMPTCUT_PRERENDER_SCALE = '2';
  const { svc, log, bakeries } = harness({ agentOpen: true });
  let agentTasks = 0;
  const run = svc.runAgentTask.bind(svc);
  svc.runAgentTask = work => { agentTasks++; return run(work); };
  try {
    const frames = await svc.see_frames(project, [0.5, 1], { lane: 'preview' });
    assert.equal(frames.size, 2);
    assert.deepEqual(log.filter(x => x.includes('@')), ['preview@queue']);
    assert.equal(agentTasks, 0, 'did not go through runAgentTask');
    assert.ok(!log.includes('agent.reset'), 'the prerender room of the Agent dedicated instance was neither reset nor borrowed');
    // Operation previews render at 1x (same as originally on Agent lane), without scaling with prerender
    assert.deepEqual(bakeries.queue.scales, [1]);
    assert.equal(svc.diagnostics().scheduler.counts['preview@queue'], 1);
    assert.equal(svc.diagnostics().scheduler.counts['agent@agent'], undefined);
  } finally {
    if (before === undefined) delete process.env.PROMPTCUT_PRERENDER_SCALE; else process.env.PROMPTCUT_PRERENDER_SCALE = before;
    await svc.close();
  }
});

test('QR-G1-2 an operation preview is inserted ahead of all pending items in the regular prerender queue, without interrupting the item currently running', async () => {
  const { svc, log, task } = harness();
  try {
    const holdA = gate();
    const a = task('A', { hold: holdA });
    const b = task('B');
    const c = task('C');
    await until(() => log.includes('A:start@queue'));
    const preview = svc.see_frames(project, [0.5], { lane: 'preview' });
    await until(() => svc.queueTasks[0]?.kind === 'preview');
    assert.deepEqual(svc.queueTasks.map(item => item.kind), ['preview', 'queue', 'queue'], 'the preview was queued ahead of the two pending items');
    await sleep(20);
    assert.ok(!log.includes('A:end') && !log.some(x => x.startsWith('preview')), 'the running A was not interrupted, and the preview is waiting for it');
    holdA.open();
    await Promise.all([a, b, c, preview]);
    assert.deepEqual(log.filter(x => !x.endsWith('.reset')),
      ['A:start@queue', 'A:end', 'preview@queue', 'B:start@queue', 'B:end', 'C:start@queue', 'C:end']);
  } finally { await svc.close(); }
});

test('QR-G1-3 several operation previews still keep their order among themselves, and all are queued ahead of the regular prerender pending items', async () => {
  const { svc, log, task } = harness();
  try {
    const holdA = gate();
    const a = task('A', { hold: holdA });
    const b = task('B');
    await until(() => log.includes('A:start@queue'));
    const p1 = svc.runQueueTask(async lease => { await lease(project); log.push('P1'); }, undefined, { front: true, kind: 'preview' });
    const p2 = svc.runQueueTask(async lease => { await lease(project); log.push('P2'); }, undefined, { front: true, kind: 'preview' });
    holdA.open();
    await Promise.all([a, b, p1, p2]);
    assert.deepEqual(log.filter(x => !x.endsWith('.reset')), ['A:start@queue', 'A:end', 'P1', 'P2', 'B:start@queue', 'B:end']);
  } finally { await svc.close(); }
});

test('QR-G1-4 a see_frames requested by the model itself (default lane) still goes through the Agent lane and borrows the Agent dedicated instance', async () => {
  const { svc, log } = harness({ agentOpen: true });
  try {
    await svc.see_frames(project, [0.5]);
    assert.deepEqual(log.filter(x => x.includes('@')), ['agent@agent']);
    assert.equal(svc.diagnostics().scheduler.counts['agent@agent'], 1);
    assert.equal(svc.diagnostics().scheduler.counts['preview@queue'], undefined);
  } finally { await svc.close(); }
});

test('QR-G1-5 an idle Agent dedicated instance still does not take operation previews (the dedicated instance of the Agent is not occupied): the preview waits for the queue lane', async () => {
  const { svc, log, task } = harness({ agentOpen: true });
  try {
    const holdA = gate();
    const a = task('A', { hold: holdA });
    await until(() => log.includes('A:start@queue'));
    const preview = svc.see_frames(project, [0.5], { lane: 'preview' });
    await until(() => svc.queueTasks[0]?.kind === 'preview');
    await sleep(20);
    assert.equal(svc.agentUnit, null, 'the Agent dedicated instance did not take it');
    assert.ok(!log.some(x => x.startsWith('preview')));
    holdA.open();
    await Promise.all([a, preview]);
    assert.ok(log.includes('preview@queue'));
    assert.ok(!log.includes('preview@agent') && !log.includes('agent.reset'));
  } finally { await svc.close(); }
});

test('QR-G1-6 routes are split by who asked: a GIF opened by the user goes through preview and skips the vision priority queue; /render and bake_card from the model go through Agent; 3D view textures do not enter the Agent lane', () => {
  const read = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const routes = read('../vision/routes.ts');
  assert.match(routes, /ensureGif\(m\[1\], "user"\)/, 'GET /gif is triggered by the user');
  assert.match(routes, /ensureGif\(key, "model"\)/, 'POST /render is requested by the model');
  assert.match(routes, /who === "user"\s*\?\s*await renderFrames\(root, originOf\(server\), spec\.project, spec\.times, notes, 0, \{ lane: "preview" \}\)/,
    'the user branch calls renderFrames directly (lane preview), without going through enqueue');
  assert.match(routes, /enqueue\(\(\) => renderFrames\(root, originOf\(server\), spec\.project, spec\.times, notes, 1, \{ lane: "agent" \}\), 1, 25000\)/,
    'the model branch still goes through enqueue with foreground priority and the Agent lane');
  assert.match(routes, /const lane = pri > 0 \? "preview" : "prerender";/);
  assert.match(routes, /bakeClip\(root, originOf\(server\), resolved, clipId, ts, size, bg, "box", pri, \{ signal, lane \}\)/);
  // bake_card (model) without lane = defaults to Agent
  assert.match(routes, /bakeOne\(root, originOf\(server\), resolveMediaUrls\(project\)\.project, clipId, Number\(t\), size, bg, "square", 1, undefined, \{ signal \}\)/);
  const render = read('../vision/render.ts');
  assert.match(render, /service\.see_frames\(normalized, times, \{ signal: o\.signal, lane: o\.lane \?\? "agent" \}\)/);
  const bake = read('../vision/bake.ts');
  assert.equal((bake.match(/lane: o\.lane \}/g) || []).length, 2, 'bakeOne / bakeClip both pass lane to renderOneFrame / renderFrames');
});

test('QR-G1-7 the image of a single card (bake_card, 3D view textures) is rendered to a bitmap on the spot: it does not go through see_frames of the frame store and generates no snapshots; same queueing rules as above', () => {
  const read = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const bake = read('../vision/bake.ts');
  assert.equal((bake.match(/post, bitmapOnly: true, lane: o\.lane \}/g) || []).length, 2, 'bakeOne / bakeClip both take the bitmap path when going through the prerender process');
  assert.match(bake, /graphCode: graphCardCode\(project, iso\.clip\.nodeId\), store: BAKE_STORE_VERSION \}/, 'the bake method version goes into the cache key, so old keys no longer hit');
  assert.match(bake, /export const BAKE_STORE_VERSION = 2;/);
  const render = read('../vision/render.ts');
  assert.match(render, /if \(!o\.runner && o\.bitmapOnly\) \{\s*const shots = await renderCardBitmaps\(root, origin, project, times, \{ signal: o\.signal, lane: o\.lane \?\? "agent" \}\);/,
    'the bitmap path branches off before entering see_frames of frameService');
  // Check again after stripping comments: description text will mention these names
  const bitmap = read('../vision/card-bitmap.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const banned of ['see_frames', '.entry(', 'onSnapshot', 'snapshotFrames', '.record(', 'cardRender', 'writeMov', 'domCache'])
    assert.ok(!bitmap.includes(banned), `card-bitmap.ts should not contain ${banned}: this path creates no frame store entry and neither generates nor records snapshots`);
  assert.match(bitmap, /fullFrame: true, writeFrames: false/, 'the screenshot is the image of this frame, and no frame file is written');
  assert.match(bitmap, /if \(lane === "agent"\) await service\.runAgentTask\(work\);/, 'Agent work goes through the Agent dedicated instance');
  assert.match(bitmap, /service\.runQueueTask\(work, o\.signal, \{ front: lane === "preview", scaleLane: "preview", kind: lane \}\)/,
    'textures do not enter the Agent lane: those the user is waiting to see are inserted ahead of the regular prerender pending items, idle prefetches go to the back of the queue, and all are rendered at 1x scale');
});

/* ------------------------------------------------------------------ G2 */

test('QR-G2-1 when the Agent queue is empty and the queue lane is busy, the Agent dedicated instance takes the next regular prerender item', async () => {
  const { svc, log, task } = harness({ agentOpen: true });
  try {
    const holdA = gate();
    const a = task('A', { hold: holdA });
    const b = task('B');
    await b;
    assert.ok(log.includes('A:start@queue') && log.includes('B:start@agent'), JSON.stringify(log));
    assert.ok(log.indexOf('B:end') < log.indexOf('A:end') || !log.includes('A:end'), 'B did not wait for A');
    assert.equal(svc.diagnostics().scheduler.counts['queue@agent'], 1);
    holdA.open();
    await a;
  } finally { await svc.close(); }
});

test('QR-G2-2 when an Agent task arrives: it runs first once the item in hand of the dedicated instance finishes, not queued behind the pending prerender items; after it finishes, prerender is taken again', async () => {
  const { svc, log, task } = harness({ agentOpen: true });
  try {
    const holdA = gate(), holdB = gate();
    const a = task('A', { hold: holdA });
    const b = task('B', { hold: holdB });
    await until(() => log.includes('B:start@agent'));
    const c = task('C');
    const d = task('D');
    const x = svc.runAgentTask(async lease => { const bakery = await lease(project); log.push(`X@${bakery.name}`); return 'X'; });
    await sleep(20);
    assert.ok(!log.includes('B:end') && !log.some(e => e.startsWith('X')), 'the running B was not interrupted, and X is waiting for it');
    assert.deepEqual(svc.queueTasks.map(item => item.kind), ['queue', 'queue'], 'C and D are still queued');
    holdB.open();
    assert.equal(await x, 'X');
    const at = e => log.indexOf(e);
    assert.ok(at('B:end') < at('X@agent'), 'X comes after B finishes');
    assert.ok(!log.includes('C:start@agent') || at('X@agent') < at('C:start@agent'), 'X is queued ahead of the queued C');
    await Promise.all([c, d]);
    // A still occupies queue lane: C and D are both taken by Agent dedicated instance after X
    assert.ok(at('X@agent') < at('C:start@agent') && at('C:end') < at('D:start@agent'), JSON.stringify(log));
    holdA.open();
    await a;
  } finally { await svc.close(); }
});

test('QR-G2-3 the editor process (interactive: false) has no Agent lane: regular prerender runs only on the queue lane, and Agent tasks return NO_AGENT_LANE', async () => {
  const { svc, log, task } = harness({ interactive: false });
  // Even if lanes contains an 'agent' (which won't exist in editor process), do not borrow it
  svc.lanes.set('agent', { bakery: fakeBakery('agent', log) });
  try {
    const holdA = gate();
    const a = task('A', { hold: holdA });
    const b = task('B');
    await until(() => log.includes('A:start@queue'));
    await sleep(20);
    assert.ok(!log.some(e => e.startsWith('B')), 'B was not picked up by the Agent dedicated instance');
    holdA.open();
    await Promise.all([a, b]);
    assert.ok(log.includes('B:start@queue'));
    await assert.rejects(svc.runAgentTask(async () => 'x'), error => error.status === 503 && error.code === 'NO_AGENT_LANE');
    assert.equal(svc.agentPending, 0);
  } finally { await svc.close(); }
});

test('QR-G2-4 if the prerender room of the dedicated instance is not open (the Agent has not been used recently), it takes nothing: no Chrome is opened just to take on prerender', async () => {
  const { svc, log, task } = harness({ agentOpen: false });
  let opened = 0;
  const acquire = svc.acquire.bind(svc);
  svc.acquire = (lane, ...rest) => { if (lane === 'agent') opened++; return acquire(lane, ...rest); };
  try {
    const holdA = gate();
    const a = task('A', { hold: holdA });
    const b = task('B');
    await until(() => log.includes('A:start@queue'));
    await sleep(20);
    assert.ok(!log.some(e => e.startsWith('B')));
    holdA.open();
    await Promise.all([a, b]);
    assert.ok(log.includes('B:start@queue'));
    assert.equal(opened, 0);
  } finally { await svc.close(); }
});

test('QR-G2-5 the same card is not rendered on two instances at the same time: the dedicated instance skips an item with the same tag as the one the queue lane has in hand, and takes another', async () => {
  const { svc, log, task } = harness({ agentOpen: true });
  try {
    const holdA = gate();
    const a = task('A', { hold: holdA, tag: 'card:k1' });
    await until(() => log.includes('A:start@queue'));
    const b = task('B', { tag: 'card:k1' });
    const c = task('C', { tag: 'card:k2' });
    await c;
    assert.ok(log.includes('C:start@agent'), 'other cards are taken by the dedicated instance');
    await sleep(10);
    assert.ok(!log.some(e => e.startsWith('B')), 'B of the same card waits for A');
    holdA.open();
    await Promise.all([a, b]);
    assert.ok(log.includes('B:start@queue') || log.includes('B:start@agent'));
    assert.ok(log.indexOf('A:end') < log.findIndex(e => e.startsWith('B:start')), 'B starts only after A finishes');
  } finally { await svc.close(); }
});

test('QR-G2-6 the idle timer fires while the dedicated instance is borrowed for prerender: it is not closed out from under it, it closes after the work finishes, and takes no more afterwards', async () => {
  const { svc, log, bakeries, task } = harness({ agentOpen: true });
  const realSet = globalThis.setTimeout;
  const timers = [];
  try {
    globalThis.setTimeout = (fn, ms, ...args) => {
      if (ms === 10 * 60 * 1000) { timers.push(fn); return realSet(() => {}, 0); }
      return realSet(fn, ms, ...args);
    };
    svc.release('agent');
    globalThis.setTimeout = realSet;
    assert.equal(timers.length, 1);
    const holdA = gate(), holdB = gate();
    const a = task('A', { hold: holdA });
    const b = task('B', { hold: holdB });
    await until(() => log.includes('B:start@agent'));
    timers[0]();
    assert.equal(bakeries.agent.closed, undefined, 'not closed while it is working');
    assert.equal(svc.lanes.get('agent')?.expired, true);
    const c = task('C');
    holdB.open();
    await b;
    await until(() => bakeries.agent.closed === true);
    assert.equal(svc.lanes.has('agent'), false);
    holdA.open();
    await Promise.all([a, c]);
    assert.ok(log.includes('C:start@queue'), 'after it expires it takes no more, and C is done by the queue lane');
  } finally { globalThis.setTimeout = realSet; await svc.close(); }
});

/* ---------------------------------------------- Card batches from background pass (fillCardControls share) */

function cardHarness({ agentOpen = true } = {}) {
  const log = [];
  const svc = new FramePipeline({ root: tmpRoot(), origin: () => 'http://127.0.0.1:1', environment: { fingerprint: '0123456789abcdef' } });
  svc.agentGraceMs = 0;
  const bakeries = { background: fakeBakery('background', log), agent: fakeBakery('agent', log) };
  if (agentOpen) svc.lanes.set('agent', { bakery: bakeries.agent });
  svc.isolatedCardProject = () => ({ width: 64, height: 36, fps: 30, duration: 2, tracks: [], media: [] });
  const puts = [];
  const finishes = [];
  const entry = {
    key: 'e1', project, cardPlan: [],
    cardCache: {
      hasComplete: async () => false,
      put: async (_key, frame) => { puts.push(frame); return true; },
      finish: async () => { finishes.push(puts.length); return true; },
    },
  };
  // 32 frames = 8 batches; no snapshot key (branch for cards not in prerender set), PNG only
  const control = { clipId: 'c1', key: 'ck1', cacheable: true, count: 32, sampling: { firstFrame: 0 }, end: 2, capabilities: {} };
  return { svc, log, bakeries, entry, control, puts, finishes };
}

test('QR-G2-7 a card in the background pass: when the dedicated instance is idle it borrows batches that have not started; each batch runs only once, and the card is finalized only once, after all batches', async () => {
  bakeLog.length = 0;
  const { svc, bakeries, entry, control, puts, finishes } = cardHarness();
  try {
    await svc.fillCardControls(entry, bakeries.background, undefined, [control], { share: true });
    const ends = bakeLog.filter(r => r.phase === 'end');
    const frames = ends.flatMap(r => r.frames).sort((a, b) => a - b);
    assert.deepEqual(frames, Array.from({ length: 32 }, (_, n) => n), 'frames 0 to 31 are each pushed exactly once');
    const by = name => ends.filter(r => r.bakery === name).length;
    assert.ok(by('agent') >= 1, `the dedicated instance took batches (agent ${by('agent')} batches)`);
    assert.ok(by('background') >= 1, `the background also does some itself (background ${by('background')} batches)`);
    assert.equal(by('agent') + by('background'), 8);
    assert.deepEqual(finishes, [32], 'finalized only once, and after all 32 frames have been delivered');
    assert.equal(puts.length, 32);
    assert.equal(svc.cardBatchPool, null, 'the pool is released once done');
    assert.ok((svc.diagnostics().scheduler.counts['card-batch@agent'] ?? 0) >= 1);
  } finally { await svc.close(); }
});

test('QR-G2-8 an Agent task arrives while a background card batch is in progress: it runs first once the batch in hand of the dedicated instance finishes, and no new batch is borrowed in the meantime', async () => {
  bakeLog.length = 0;
  const { svc, bakeries, entry, control } = cardHarness();
  const order = [];
  let x = null;
  onBakeStart = async rec => {
    order.push(`${rec.bakery}:${rec.frames[0]}`);
    // When dedicated instance starts working on a batch for the first time, Agent task arrives
    if (rec.bakery === 'agent' && !x) {
      x = svc.runAgentTask(async lease => { const bakery = await lease(project); order.push(`X@${bakery.name}`); });
    }
  };
  try {
    await svc.fillCardControls(entry, bakeries.background, undefined, [control], { share: true });
    await x;
    const agentBatches = order.map((e, i) => [e, i]).filter(([e]) => e.startsWith('agent:'));
    const xAt = order.indexOf('X@agent');
    assert.ok(xAt > agentBatches[0][1], 'X comes after the batch the dedicated instance had in hand');
    // Dedicated instance only started that batch before X: no second batch inserted ahead of X
    assert.equal(agentBatches.filter(([, i]) => i < xAt).length, 1, JSON.stringify(order));
    const firstAgentEnd = bakeLog.findIndex(r => r.phase === 'end' && r.bakery === 'agent');
    assert.ok(firstAgentEnd >= 0, 'that batch finished (not interrupted)');
  } finally { onBakeStart = null; await svc.close(); }
});

test('QR-G2-9 with no open dedicated instance, share behaves exactly like not passing it: all batches run on the background prerender room, in the same order', async () => {
  const run = async share => {
    bakeLog.length = 0;
    const { svc, bakeries, entry, control } = cardHarness({ agentOpen: false });
    try { await svc.fillCardControls(entry, bakeries.background, undefined, [control], share ? { share: true } : {}); }
    finally { await svc.close(); }
    return bakeLog.filter(r => r.phase === 'end').map(r => `${r.bakery}:${r.frames.join(',')}`);
  };
  const shared = await run(true);
  const plain = await run(false);
  assert.deepEqual(shared, plain);
  assert.ok(shared.every(e => e.startsWith('background:')));
  assert.equal(shared.length, 8);
});

test('QR-G2-10 after an Agent task finishes, it stays idle for AGENT_GRACE_MS before taking prerender: an Agent task that follows right after does not have to wait for a batch', async () => {
  const { AGENT_GRACE_MS } = await import('../frame-pipeline.mjs');
  assert.equal(AGENT_GRACE_MS, 1000);
  const { svc, log, task } = harness({ agentOpen: true, graceMs: 80 });
  try {
    const holdA = gate();
    const a = task('A', { hold: holdA });
    await until(() => log.includes('A:start@queue'));
    await svc.runAgentTask(async lease => { await lease(project); log.push('X1'); });
    const b = task('B');
    await sleep(20);
    assert.ok(!log.some(e => e.startsWith('B')), 'within the gap the dedicated instance does not take B');
    // Another Agent task arrives within grace period: run immediately, no need to wait for prerender
    const t0 = Date.now();
    await svc.runAgentTask(async lease => { await lease(project); log.push('X2'); });
    assert.ok(Date.now() - t0 < 60, `X2 did not wait (${Date.now() - t0} ms)`);
    await b;
    assert.ok(log.includes('B:start@agent'), 'after the gap the dedicated instance takes B');
    assert.ok(log.indexOf('X2') < log.indexOf('B:start@agent'));
    holdA.open();
    await a;
  } finally { await svc.close(); }
});

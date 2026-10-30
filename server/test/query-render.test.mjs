/*
 * 查询渲染的调度(`docs/semantics/product/rendering.md`「Agent 优先只是插队」「AI 栏的操作预览可以插队」,
 * `docs/semantics/mechanism/rendering.md`「查询渲染与预渲染进程」;报告 `docs/reports/AGENT-query-render.md`)。
 *
 *   QR-G1-*  用户在 AI 栏点开的操作预览(`see_frames` 的 `'preview'` 批):不进 Agent lane、插在普通预渲染队列所有待办之前、
 *            不打断正在跑的那一项、Agent 专用实例空着也不接它;模型自己要的仍走 Agent lane。
 *   QR-G2-*  Agent 专用实例空闲时接普通预渲染:Agent 队列空才接、一次一项;Agent 任务来了在当前那一项做完后先做,
 *            不排在预渲染待办后面;不为接预渲染开 Chrome;同一张卡不在两个实例上同时渲;编辑器进程仍没有 Agent lane;
 *            后台那一趟的卡批可以被借走,每批只做一次、收尾只做一次。
 *
 * 浏览器全部替掉:lane 上预先放假的预渲染间(`acquire` 走「复用、重置」那条路),`bakeFrames` 换成假的。
 * 跑法:`node --experimental-test-module-mocks --test server/test/query-render.test.mjs`
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
    if (Date.now() - t0 > ms) throw new Error('等不到条件成立');
    await sleep(1);
  }
}

/** 假 `bakeFrames`:记下在哪个预渲染间上推了哪些帧,每帧调 `onFrame` */
const bakeLog = [];
let onBakeStart = null;
mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: {
    openBakery: async () => { throw new Error('这里不开 Chrome'); },
    findFfmpeg: async () => 'ffmpeg',
    bakeFrames: async (bakery, opts = {}) => {
      const rec = { bakery: bakery?.name, frames: [...(opts.targetFrames ?? [])] };
      bakeLog.push({ ...rec, phase: 'start' });
      if (onBakeStart) await onBakeStart(rec);
      await sleep(8);
      for (const frame of rec.frames) {
        if (opts.signal?.aborted) throw Object.assign(new Error('已取消'), { cancelled: true });
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
 * `agentOpen`:Agent 专用实例的预渲染间是不是已经开着(Agent 最近用过)。`'queue'` lane 的预渲染间总是预先放好。
 * `readFramesCore` 换成「借一下、记下是哪条 lane、在哪个预渲染间上」。
 */
function harness({ agentOpen = false, interactive = true, graceMs = 0 } = {}) {
  const log = [];
  const svc = new FramePipeline({ root: tmpRoot(), origin: () => 'http://127.0.0.1:1', interactive });
  // Agent 任务做完之后的空档(`AGENT_GRACE_MS`)只在 QR-G2-10 里量,其余用例给 0
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
  /** 排一项普通预渲染:开工记 `<name>:start@<预渲染间>`,放行后记 `<name>:end` */
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

test('QR-G1-1 用户点开的操作预览不进 Agent lane:在 queue lane 的预渲染间上、按 1 倍缩放渲;Agent 专用实例一次都没被借', async () => {
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
    assert.equal(agentTasks, 0, '没有经 runAgentTask');
    assert.ok(!log.includes('agent.reset'), 'Agent 专用实例的预渲染间没被重置、没被借');
    // 操作预览按 1 倍渲(同它原来在 Agent lane 上一样),不跟着预渲染缩放
    assert.deepEqual(bakeries.queue.scales, [1]);
    assert.equal(svc.diagnostics().scheduler.counts['preview@queue'], 1);
    assert.equal(svc.diagnostics().scheduler.counts['agent@agent'], undefined);
  } finally {
    if (before === undefined) delete process.env.PROMPTCUT_PRERENDER_SCALE; else process.env.PROMPTCUT_PRERENDER_SCALE = before;
    await svc.close();
  }
});

test('QR-G1-2 操作预览插在普通预渲染队列所有待办之前,不打断正在跑的那一项', async () => {
  const { svc, log, task } = harness();
  try {
    const holdA = gate();
    const a = task('A', { hold: holdA });
    const b = task('B');
    const c = task('C');
    await until(() => log.includes('A:start@queue'));
    const preview = svc.see_frames(project, [0.5], { lane: 'preview' });
    await until(() => svc.queueTasks[0]?.kind === 'preview');
    assert.deepEqual(svc.queueTasks.map(item => item.kind), ['preview', 'queue', 'queue'], '预览排到了两个待办之前');
    await sleep(20);
    assert.ok(!log.includes('A:end') && !log.some(x => x.startsWith('preview')), '正在跑的 A 没被打断,预览在等它');
    holdA.open();
    await Promise.all([a, b, c, preview]);
    assert.deepEqual(log.filter(x => !x.endsWith('.reset')),
      ['A:start@queue', 'A:end', 'preview@queue', 'B:start@queue', 'B:end', 'C:start@queue', 'C:end']);
  } finally { await svc.close(); }
});

test('QR-G1-3 几个操作预览之间仍按先后,都排在普通预渲染待办之前', async () => {
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

test('QR-G1-4 模型自己要的 see_frames(缺省 lane)照旧走 Agent lane、借 Agent 专用实例', async () => {
  const { svc, log } = harness({ agentOpen: true });
  try {
    await svc.see_frames(project, [0.5]);
    assert.deepEqual(log.filter(x => x.includes('@')), ['agent@agent']);
    assert.equal(svc.diagnostics().scheduler.counts['agent@agent'], 1);
    assert.equal(svc.diagnostics().scheduler.counts['preview@queue'], undefined);
  } finally { await svc.close(); }
});

test('QR-G1-5 Agent 专用实例空着也不接操作预览(不占用 Agent 的专用实例):预览等 queue lane', async () => {
  const { svc, log, task } = harness({ agentOpen: true });
  try {
    const holdA = gate();
    const a = task('A', { hold: holdA });
    await until(() => log.includes('A:start@queue'));
    const preview = svc.see_frames(project, [0.5], { lane: 'preview' });
    await until(() => svc.queueTasks[0]?.kind === 'preview');
    await sleep(20);
    assert.equal(svc.agentUnit, null, 'Agent 专用实例没有接它');
    assert.ok(!log.some(x => x.startsWith('preview')));
    holdA.open();
    await Promise.all([a, preview]);
    assert.ok(log.includes('preview@queue'));
    assert.ok(!log.includes('preview@agent') && !log.includes('agent.reset'));
  } finally { await svc.close(); }
});

test('QR-G1-6 路由按谁要的分:用户点开的 GIF 走 preview、不经 vision 优先级队列;模型的 /render 与 bake_card 走 Agent;3D 视图贴图不进 Agent lane', () => {
  const read = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const routes = read('../vision/routes.ts');
  assert.match(routes, /ensureGif\(m\[1\], "user"\)/, 'GET /gif 是用户触发的');
  assert.match(routes, /ensureGif\(key, "model"\)/, 'POST /render 是模型要的');
  assert.match(routes, /who === "user"\s*\?\s*await renderFrames\(root, originOf\(server\), spec\.project, spec\.times, notes, 0, \{ lane: "preview" \}\)/,
    '用户那一支直接 renderFrames(lane preview),不经 enqueue');
  assert.match(routes, /enqueue\(\(\) => renderFrames\(root, originOf\(server\), spec\.project, spec\.times, notes, 1, \{ lane: "agent" \}\), 1, 25000\)/,
    '模型那一支照旧 enqueue 前台优先级、Agent lane');
  assert.match(routes, /const lane = pri > 0 \? "preview" : "prerender";/);
  assert.match(routes, /bakeClip\(root, originOf\(server\), resolved, clipId, ts, size, bg, "box", pri, \{ signal, lane \}\)/);
  // bake_card(模型)不带 lane = 缺省 Agent
  assert.match(routes, /bakeOne\(root, originOf\(server\), resolveMediaUrls\(project\)\.project, clipId, Number\(t\), size, bg, "square", 1, undefined, \{ signal \}\)/);
  const render = read('../vision/render.ts');
  assert.match(render, /service\.see_frames\(normalized, times, \{ signal: o\.signal, lane: o\.lane \?\? "agent" \}\)/);
  const bake = read('../vision/bake.ts');
  assert.equal((bake.match(/lane: o\.lane \}/g) || []).length, 2, 'bakeOne / bakeClip 都把 lane 传给 renderOneFrame / renderFrames');
});

test('QR-G1-7 单张卡片画面(bake_card、3D 视图贴图)当场渲出位图:不经帧库的 see_frames、不生成快照;排队规则同上', () => {
  const read = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const bake = read('../vision/bake.ts');
  assert.equal((bake.match(/post, bitmapOnly: true, lane: o\.lane \}/g) || []).length, 2, 'bakeOne / bakeClip 走预渲染进程时都要位图那条路');
  assert.match(bake, /graphCode: graphCardCode\(project, iso\.clip\.nodeId\), store: BAKE_STORE_VERSION \}/, '出法版本进缓存键,旧键不再命中');
  assert.match(bake, /export const BAKE_STORE_VERSION = 2;/);
  const render = read('../vision/render.ts');
  assert.match(render, /if \(!o\.runner && o\.bitmapOnly\) \{\s*const shots = await renderCardBitmaps\(root, origin, project, times, \{ signal: o\.signal, lane: o\.lane \?\? "agent" \}\);/,
    '位图那条路在进 frameService 的 see_frames 之前就分出去');
  // 去掉注释再查:说明文字里会提到这些名字
  const bitmap = read('../vision/card-bitmap.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const banned of ['see_frames', '.entry(', 'onSnapshot', 'snapshotFrames', '.record(', 'cardRender', 'writeMov', 'domCache'])
    assert.ok(!bitmap.includes(banned), `card-bitmap.ts 不该出现 ${banned}:这条路不建帧库条目、不生成也不记快照`);
  assert.match(bitmap, /fullFrame: true, writeFrames: false/, '截图就是这一帧的画面,不写帧文件');
  assert.match(bitmap, /if \(lane === "agent"\) await service\.runAgentTask\(work\);/, 'Agent 的走 Agent 专用实例');
  assert.match(bitmap, /service\.runQueueTask\(work, o\.signal, \{ front: lane === "preview", scaleLane: "preview", kind: lane \}\)/,
    '贴图不进 Agent lane:用户等着看的插在普通预渲染待办之前,空闲预取排队尾,都是 1 倍缩放');
});

/* ------------------------------------------------------------------ G2 */

test('QR-G2-1 Agent 队列空、queue lane 忙时,Agent 专用实例接下一项普通预渲染', async () => {
  const { svc, log, task } = harness({ agentOpen: true });
  try {
    const holdA = gate();
    const a = task('A', { hold: holdA });
    const b = task('B');
    await b;
    assert.ok(log.includes('A:start@queue') && log.includes('B:start@agent'), JSON.stringify(log));
    assert.ok(log.indexOf('B:end') < log.indexOf('A:end') || !log.includes('A:end'), 'B 没等 A');
    assert.equal(svc.diagnostics().scheduler.counts['queue@agent'], 1);
    holdA.open();
    await a;
  } finally { await svc.close(); }
});

test('QR-G2-2 Agent 任务来了:在专用实例手里那一项做完后先做,不排在预渲染待办后面;做完再接预渲染', async () => {
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
    assert.ok(!log.includes('B:end') && !log.some(e => e.startsWith('X')), '正在跑的 B 没被打断,X 在等它');
    assert.deepEqual(svc.queueTasks.map(item => item.kind), ['queue', 'queue'], 'C、D 还在排队');
    holdB.open();
    assert.equal(await x, 'X');
    const at = e => log.indexOf(e);
    assert.ok(at('B:end') < at('X@agent'), 'X 在 B 做完之后');
    assert.ok(!log.includes('C:start@agent') || at('X@agent') < at('C:start@agent'), 'X 排在排队中的 C 之前');
    await Promise.all([c, d]);
    // A 还占着 queue lane:C、D 都由 Agent 专用实例在 X 之后接走
    assert.ok(at('X@agent') < at('C:start@agent') && at('C:end') < at('D:start@agent'), JSON.stringify(log));
    holdA.open();
    await a;
  } finally { await svc.close(); }
});

test('QR-G2-3 编辑器进程(interactive: false)没有 Agent lane:普通预渲染只在 queue lane 上做,Agent 任务回 NO_AGENT_LANE', async () => {
  const { svc, log, task } = harness({ interactive: false });
  // 就算 lanes 里有一个 'agent'(编辑器进程里不会有),也不借它
  svc.lanes.set('agent', { bakery: fakeBakery('agent', log) });
  try {
    const holdA = gate();
    const a = task('A', { hold: holdA });
    const b = task('B');
    await until(() => log.includes('A:start@queue'));
    await sleep(20);
    assert.ok(!log.some(e => e.startsWith('B')), 'B 没被 Agent 专用实例接走');
    holdA.open();
    await Promise.all([a, b]);
    assert.ok(log.includes('B:start@queue'));
    await assert.rejects(svc.runAgentTask(async () => 'x'), error => error.status === 503 && error.code === 'NO_AGENT_LANE');
    assert.equal(svc.agentPending, 0);
  } finally { await svc.close(); }
});

test('QR-G2-4 专用实例的预渲染间没开着(Agent 最近没用过)就不接:不为接预渲染开 Chrome', async () => {
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

test('QR-G2-5 同一张卡不在两个实例上同时渲:和 queue lane 手里同 tag 的项专用实例不接,接别的', async () => {
  const { svc, log, task } = harness({ agentOpen: true });
  try {
    const holdA = gate();
    const a = task('A', { hold: holdA, tag: 'card:k1' });
    await until(() => log.includes('A:start@queue'));
    const b = task('B', { tag: 'card:k1' });
    const c = task('C', { tag: 'card:k2' });
    await c;
    assert.ok(log.includes('C:start@agent'), '别的卡由专用实例接');
    await sleep(10);
    assert.ok(!log.some(e => e.startsWith('B')), '同一张卡的 B 等 A');
    holdA.open();
    await Promise.all([a, b]);
    assert.ok(log.includes('B:start@queue') || log.includes('B:start@agent'));
    assert.ok(log.indexOf('A:end') < log.findIndex(e => e.startsWith('B:start')), 'B 在 A 做完之后才开工');
  } finally { await svc.close(); }
});

test('QR-G2-6 空闲计时器在专用实例借去做预渲染时到点:不在它脚下关,做完再关,之后不再接', async () => {
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
    assert.equal(bakeries.agent.closed, undefined, '做着的时候不关');
    assert.equal(svc.lanes.get('agent')?.expired, true);
    const c = task('C');
    holdB.open();
    await b;
    await until(() => bakeries.agent.closed === true);
    assert.equal(svc.lanes.has('agent'), false);
    holdA.open();
    await Promise.all([a, c]);
    assert.ok(log.includes('C:start@queue'), '过期之后不再接,C 由 queue lane 做');
  } finally { globalThis.setTimeout = realSet; await svc.close(); }
});

/* ---------------------------------------------- 后台那一趟的卡批(fillCardControls 的 share) */

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
  // 32 帧 = 8 批;没有快照键(不在预渲染集合里的卡那一支),只走 PNG
  const control = { clipId: 'c1', key: 'ck1', cacheable: true, count: 32, sampling: { firstFrame: 0 }, end: 2, capabilities: {} };
  return { svc, log, bakeries, entry, control, puts, finishes };
}

test('QR-G2-7 后台那一趟的卡:专用实例空闲时借走还没开工的批;每批只做一次、这张卡只收尾一次且在所有批之后', async () => {
  bakeLog.length = 0;
  const { svc, bakeries, entry, control, puts, finishes } = cardHarness();
  try {
    await svc.fillCardControls(entry, bakeries.background, undefined, [control], { share: true });
    const ends = bakeLog.filter(r => r.phase === 'end');
    const frames = ends.flatMap(r => r.frames).sort((a, b) => a - b);
    assert.deepEqual(frames, Array.from({ length: 32 }, (_, n) => n), '0～31 每帧恰好推过一次');
    const by = name => ends.filter(r => r.bakery === name).length;
    assert.ok(by('agent') >= 1, `专用实例接了批(agent ${by('agent')} 批)`);
    assert.ok(by('background') >= 1, `后台自己也做(background ${by('background')} 批)`);
    assert.equal(by('agent') + by('background'), 8);
    assert.deepEqual(finishes, [32], '收尾只一次,而且在 32 帧都交了之后');
    assert.equal(puts.length, 32);
    assert.equal(svc.cardBatchPool, null, '做完把池子收了');
    assert.ok((svc.diagnostics().scheduler.counts['card-batch@agent'] ?? 0) >= 1);
  } finally { await svc.close(); }
});

test('QR-G2-8 后台卡批进行中 Agent 任务到达:等专用实例手里那一批做完就先做,期间不再借新批', async () => {
  bakeLog.length = 0;
  const { svc, bakeries, entry, control } = cardHarness();
  const order = [];
  let x = null;
  onBakeStart = async rec => {
    order.push(`${rec.bakery}:${rec.frames[0]}`);
    // 专用实例第一次开工一批时,Agent 任务到达
    if (rec.bakery === 'agent' && !x) {
      x = svc.runAgentTask(async lease => { const bakery = await lease(project); order.push(`X@${bakery.name}`); });
    }
  };
  try {
    await svc.fillCardControls(entry, bakeries.background, undefined, [control], { share: true });
    await x;
    const agentBatches = order.map((e, i) => [e, i]).filter(([e]) => e.startsWith('agent:'));
    const xAt = order.indexOf('X@agent');
    assert.ok(xAt > agentBatches[0][1], 'X 在专用实例手里那一批之后');
    // X 之前专用实例只开工了那一批:没有第二批插到 X 前面
    assert.equal(agentBatches.filter(([, i]) => i < xAt).length, 1, JSON.stringify(order));
    const firstAgentEnd = bakeLog.findIndex(r => r.phase === 'end' && r.bakery === 'agent');
    assert.ok(firstAgentEnd >= 0, '那一批做完了(没被打断)');
  } finally { onBakeStart = null; await svc.close(); }
});

test('QR-G2-9 没有开着的专用实例时 share 与不传完全相同:全部批在后台的预渲染间上、同样的顺序', async () => {
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

test('QR-G2-10 Agent 任务做完后空 AGENT_GRACE_MS 才接预渲染:紧跟着的下一个 Agent 任务不用等一批', async () => {
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
    assert.ok(!log.some(e => e.startsWith('B')), '空档之内专用实例不接 B');
    // 空档之内又来一个 Agent 任务:马上做,不用等任何预渲染
    const t0 = Date.now();
    await svc.runAgentTask(async lease => { await lease(project); log.push('X2'); });
    assert.ok(Date.now() - t0 < 60, `X2 没等(${Date.now() - t0} ms)`);
    await b;
    assert.ok(log.includes('B:start@agent'), '空档过了专用实例接 B');
    assert.ok(log.indexOf('X2') < log.indexOf('B:start@agent'));
    holdA.open();
    await a;
  } finally { await svc.close(); }
});

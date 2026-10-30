/**
 * 真实执行器（契约 `docs/plan/render-queue-contract.md` J.4，J.7 用例 J8～J11；设计附件
 * `docs/plan/queue-executor-design.md` 第 2、3、7 节）。
 * 跑：node --experimental-test-module-mocks --test server/test/prerender-executor.test.mjs
 *
 * 只照契约与附件写，不看实现。
 *
 * 约定（照附件第 7 节「不用 Chrome」，写法同 `card-lock-pipeline.test.mjs`）：
 *   - `server/bakery/index.mjs` 整个换成假的（`mock.module`）。假 `openBakery` 回一个假预渲染间：
 *     `page.evaluate` 回这一套场景的 browserPlan（`{ graph, sourceVersions, environment }`，即 `window.__pcCardPlan()` 的形状），
 *     `loadProject` / `reset` / `page.setViewport` / `client.send` / `close` 都是空操作。
 *     假 `bakeFrames` 记下每次调用（`out`、`targetFrames`、`snapshotFrames`、三个开关），按真 `bakeFrames`
 *     （`server/bakery/bake.mjs`）的顺序逐帧走：每帧开头看 `signal`，已中止就抛 `{ cancelled: true }`（取消只在两帧之间生效）；
 *     这一帧要快照就先调 `onSnapshot`，再对 `targetFrames` 里的帧调 `onFrame`（这一帧的快照在截图之前生成）；
 *     `onBakeFrame(rec, frame, phase)` 在每帧开头（`'start'`）和快照之后、截图之前（`'shot'`）各调一次（中止用例用）。
 *     `onSnapshot` 的产物只由（片段、帧号）决定，与帧库在哪无关：
 *     隔离单卡那一路（`out` 在 `<root>/controls/` 下）每张卡一项、帧号原样；整场景那一路按片段起点换成本地帧。
 *   - `FramePipeline` 注入 `environment`，不探测；`dataRoot` 指向临时目录（成本读不到，预渲染集合按声明兜底）；
 *     `interactive: false`。PNG 那一支（`entry.cardCache` 的 `hasComplete` / `put` / `finish`）换成桩。
 *   - 执行器 `createPrerenderExecutor({ pipeline, projects, prepareProject, log })`；`projects.get` 由测试给，
 *     `prepareProject` 是深拷贝（记调用次数）。
 *   - 细任务由真的 `splitPlan` 从执行器的 PlanContext 切出（切分节点就是本机，指纹相同），再加上 TaskView 的字段。
 *   - 对照组：另一个帧库上，用现有的 `fillCardControls`（共享档）/ `renderLocalSnapshots`（本地档）一次渲完整张卡。
 *
 * `server/prerender-executor.mjs`（及 `FramePipeline` 的新方法）还没有时，J8～J10 各自失败；J11 对照的是现有行为，应当通过。
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/* ------------------------------------------------------------------ 假的预渲染间 */

const bakeLog = [];
/** 每次 bakeFrames 开始时调用（中止用例用它在渲染中途 abort） */
let onBake = null;
/** bakeFrames 里每帧调两次：`(rec, frame, 'start')` 在看 signal 之前，`(rec, frame, 'shot')` 在快照之后、截图之前 */
let onBakeFrame = null;
/** 当前场景：假 openBakery 开出来的预渲染间按它回 browserPlan、造快照产物 */
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
    findFfmpeg: async () => { throw new Error('单测不找 ffmpeg'); },
    streamPngVideo: () => { throw new Error('单测不编码'); },
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
        if (opts.signal?.aborted) throw Object.assign(new Error('已取消'), { cancelled: true });
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
  if (execErr) throw new Error(`载不进 server/prerender-executor.mjs：${execErr.message}`);
  assert.equal(typeof execMod.createPrerenderExecutor, 'function', `prerender-executor.mjs 要导出 createPrerenderExecutor；导出：${Object.keys(execMod).join(', ')}`);
  return execMod;
}

/* ------------------------------------------------------------------ 场景 */

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const FPS = 30;
const OWN_ENV = describeEnvironment({
  platform: 'win32',
  renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  vendor: 'Google Inc. (Google)', chromeVersion: 'HeadlessChrome/138.0.7204.49',
});
const OWN = OWN_ENV.fingerprint;

/**
 * 五个片段（5 秒，150 帧）：
 *   clip-a  demo-a  共享档，可缓存，0～5 秒，150 帧 → 切 3 段（0-59、60-119、120-149）
 *   clip-c  demo-c  共享档、canvasHeavy、用户卡，1～2 秒，30 帧
 *   clip-t  trans   sourceDependent（共享档但不可缓存）→ PlanContext 里要去掉
 *   clip-b  glass   belowDependent，本地档，1～4 秒，90 帧（全局帧 30～119）→ 切 2 段
 *   clip-s  text    无状态，不预渲染
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
/** 先关掉本用例建的管线（锁库、快照库的写盘可能还在落），再删临时目录 */
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

/** PNG 那一支换成桩（不落盘） */
function stubPng(entry) {
  const puts = [];
  entry.cardCache.hasComplete = async () => false;
  entry.cardCache.put = async (key, frame) => { puts.push({ key, frame }); return true; };
  entry.cardCache.finish = async () => {};
  return puts;
}

/** 执行器 + 它用的项目仓库（记调用） */
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
  assert.equal(typeof executor?.plan, 'function', '执行器有 plan');
  assert.equal(typeof executor?.render, 'function', '执行器有 render');
  // M6c 集成裁定:执行器不再有 isIdle(PC 节点的闲时门槛改为 queue-idle.mjs,m6c-contract「集成时的裁定」)
  assert.equal(executor?.isIdle, undefined, '执行器不再有 isIdle');
  return { executor, projects, prepared, prepareProject, logs };
}

const view = (task) => ({ ...structuredClone(task), state: 'claimed', version: 1, attempts: 1 });
const planView = () => view(planTaskOf({ projectId: PID, projectRev: REV }));
const signalNone = () => new AbortController().signal;

/** 本机切分这一版（指纹相同，所以与 PlanContext 的键一致） */
function splitOf(ctx) {
  return splitPlan({ ...ctx, planTask: planTaskOf({ projectId: PID, projectRev: REV }), envFingerprint: OWN, codeVersion: 'cv-test' });
}
const tasksOf = (ctx, clipId) => splitOf(ctx).filter((t) => t.input.clipId === clipId).sort((a, b) => a.range.from - b.range.from);

/** bakeFrames 的调用记录，`out` 换成相对帧库根的路径 */
const normalize = (root, recs) => recs.map((r) => ({ ...r, out: path.relative(root, r.out).split(path.sep).join('/') }));

async function treeOf(dir) {
  const out = {};
  let names = [];
  try { names = await fs.readdir(dir); } catch { return out; }
  for (const name of names.sort()) out[name] = await fs.readFile(path.join(dir, name));
  return out;
}

/** 执行器的 render 返回的错误：code / retryable */
async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

/* ================================================================== J8 */

test('J8 plan：entryKey 等于 pipeline.entry() 对同一份 JSON 算出的键；补了 cardId；不可缓存的共享档卡被去掉；streams 为空', { timeout: 30_000 }, async (t) => {
  t.after(cleanupRoots);
  const B = newPipeline(await tmpRoot());
  t.after(() => B.close());
  const { executor, projects, prepared, prepareProject } = await executorFor(B);
  const bakesBefore = bakeLog.length;

  const ctx = await executor.plan(planView(), { signal: signalNone() });

  // 取项目：按 plan 任务的 source 取这一版，再 prepareProject
  assert.deepEqual(projects.calls[0], [PID, REV], 'projects.get(projectId, projectRev)');
  assert.ok(prepared.n >= 1, 'prepareProject 调过');

  // entryKey：与另一个管线对同一份 JSON 算出的 entry.key 相同
  const C = newPipeline(await tmpRoot());
  t.after(() => C.close());
  const expectedKey = (await C.entry(prepareProject(projectJson()))).key;
  assert.equal(ctx.entryKey, expectedKey, 'entryKey = pipeline.entry(prepareProject(json)).key');
  assert.equal(ctx.entryKey, (await B.entry(prepareProject(projectJson()))).key, '同一个管线上也相同');

  // cardPlan：键与真的 CardFrameCache.plan 一致，补了 cardId，去掉 sourceDependent
  const reference = new CardFrameCache({ root: await tmpRoot(), project: projectJson(), envFingerprint: OWN }).plan(browserPlanOf());
  const byClip = new Map(ctx.cardPlan.map((c) => [c.clipId, c]));
  for (const clipId of ['clip-a', 'clip-c', 'clip-b']) {
    const got = byClip.get(clipId);
    const ref = reference.find((c) => c.clipId === clipId);
    assert.ok(got, `${clipId} 在 cardPlan 里`);
    assert.equal(got.snapshotKey, ref.snapshotKey, `${clipId}：snapshotKey 与 CardFrameCache.plan 相同`);
    assert.equal(got.contentKey, ref.contentKey, `${clipId}：contentKey 相同`);
    assert.equal(got.count, COUNT[clipId], `${clipId}：帧数`);
  }
  for (const c of ctx.cardPlan) {
    const node = browserPlanOf().graph.nodes.find((n) => n.id === c.nodeId);
    assert.equal(c.cardId, node?.cardId, `${c.clipId}：cardId 从 browserPlan.graph.nodes[].cardId 补上`);
  }
  assert.equal(byClip.has('clip-t'), false, '不可缓存的共享档卡（sourceDependent）被去掉');
  assert.equal(byClip.get('clip-b').tier, 'local');

  assert.deepEqual(ctx.streams, [], 'streams 为空（J.0：流不走队列）');
  assert.ok(ctx.prerenderSet instanceof Set && ['clip-a', 'clip-c', 'clip-b'].every((c) => ctx.prerenderSet.has(c)), 'prerenderSet 带上');

  // 锚帧：anchorFrames(clips, fps)，只留在范围内的
  const clips = projectJson().tracks.flatMap((tr) => tr.clips);
  const anchors = anchorFrames(clips, FPS).filter((f) => f >= 0 && f < 150);
  assert.deepEqual([...new Set(ctx.anchorFrames)].sort((a, b) => a - b), anchors);

  // isUserCard / isGraphCard / weightOf（附件第 2 节的表）
  assert.equal(ctx.isUserCard(byClip.get('clip-c')), true, 'sourceVersions 以 user: 开头的是用户卡');
  assert.equal(ctx.isUserCard(byClip.get('clip-a')), false);
  assert.equal(ctx.isGraphCard(byClip.get('clip-a')), false);
  assert.equal(ctx.weightOf(byClip.get('clip-a')).class, 'medium', '普通共享档卡记 medium');
  assert.equal(ctx.weightOf(byClip.get('clip-c')).class, 'heavy', 'canvasHeavy 记 heavy');
  assert.equal(ctx.weightOf(byClip.get('clip-b')).class, 'heavy', '本地档（belowDependent）记 heavy');

  // E.5 的不变量：同指纹切分，共享档任务的 resultKey 就是 control.snapshotKey
  const tasks = splitOf(ctx);
  for (const task of tasks.filter((x) => x.tier === 'shared')) {
    assert.equal(task.resultKey, byClip.get(task.input.clipId).snapshotKey, `${task.id}：resultKey === snapshotKey`);
  }
  for (const task of tasks.filter((x) => x.tier === 'local')) {
    assert.equal(task.input.entryKey, ctx.entryKey);
    assert.equal(task.input.contentKey, `${ctx.entryKey}/${byClip.get(task.input.clipId).contentKey}`);
    assert.equal(task.resultKey, resultKeyOf(task.input.contentKey, OWN));
  }
  assert.deepEqual(tasks.map((x) => x.input.clipId).sort(), ['clip-a', 'clip-a', 'clip-a', 'clip-b', 'clip-b', 'clip-c'], '切出 a×3、b×2、c×1，没有 t');
  assert.equal(tasks.filter((x) => x.kind === 'stream').length, 0);

  // plan 只算计划，不渲染；不借后台那条 lane
  assert.equal(bakeLog.length, bakesBefore, 'plan 不调 bakeFrames');
  assert.equal(B.lanes.has('background'), false, 'plan 不借 background lane（附件第 2 节：新的 queue lane）');
});

test('J8 plan：取不到快照时抛 { code: no-snapshot, retryable: true }，不开预渲染间', async (t) => {
  t.after(cleanupRoots);
  const B = newPipeline(await tmpRoot());
  t.after(() => B.close());
  const { executor } = await executorFor(B);
  const openedBefore = opened.length;
  const task = view(planTaskOf({ projectId: PID, projectRev: REV + 1 }));
  const err = await rejectionOf(executor.plan(task, { signal: signalNone() }));
  assert.ok(err, 'plan 失败');
  assert.equal(err.code, 'no-snapshot', `code：${err?.code} ${err?.message}`);
  assert.equal(err.retryable, true, '可重试（快照可能还在上传）');
  assert.equal(opened.length, openedBefore, '没开预渲染间');
});

// J8(执行器的 isIdle)在 M6c 作废:执行器不再有 isIdle,本机队列节点的闲时门槛改为 `queue-idle.mjs`
// (契约 m6c-contract X5 与「集成时的裁定」),判据由 `m6c-queue-impl.test.mjs` 的 X5-1～X5-3 覆盖。

/* ================================================================== J9 */

test('J9 render（共享档，逐批：关掉一段一趟顺推）：按 60 帧一段逐段渲整张卡，与 fillCardControls 一次渲完相比，bakeFrames 调用记录与落盘文件相同；进度回调', { timeout: 45_000 }, async (t) => {
  t.after(cleanupRoots);
  // 对照：帧库 A，现有的 fillCardControls 一次渲完 clip-a
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
  assert.equal(recA.length, 38, '夹具：150 帧按 4 帧一批是 38 批');

  // 执行器：帧库 B，plan 之后逐段 render
  const rootB = await tmpRoot();
  const B = newPipeline(rootB);
  B.queueSinglePassOff = true; // 逐批这条路（canvas 重卡、播放头要的段、开关关掉时）
  t.after(() => B.close());
  const { executor } = await executorFor(B);
  const ctx = await executor.plan(planView(), { signal: signalNone() });
  const entryB = B.entries.get(ctx.entryKey);
  assert.ok(entryB, 'plan 之后 entry 在管线里');
  stubPng(entryB);
  const tasks = tasksOf(ctx, 'clip-a');
  assert.deepEqual(tasks.map((x) => [x.range.from, x.range.to]), [[0, 59], [60, 119], [120, 149]]);
  assert.equal(tasks[0].resultKey, ctlA.snapshotKey, '两边的键相同');

  mark = bakeLog.length;
  const progress = [];
  for (const task of tasks) {
    const seen = [];
    const out = await executor.render(view(task), { signal: signalNone(), progress: (done) => seen.push(done) });
    assert.equal(out, null, 'render 返回 null（sink 自己读磁盘）');
    progress.push({ task, seen });
  }
  const recB = normalize(rootB, bakeLog.slice(mark));
  assert.deepEqual(recB, recA, 'bakeFrames 的调用记录相同（批次起点、targetFrames、snapshotFrames、开关）');

  const dirA = path.join(rootA, 'controls-html', ctlA.snapshotKey);
  const dirB = path.join(rootB, 'controls-html', tasks[0].resultKey);
  const [treeA, treeB] = [await treeOf(dirA), await treeOf(dirB)];
  assert.equal(Object.keys(treeA).length, 151, '对照组：150 帧 + index.json');
  assert.deepEqual(Object.keys(treeB), Object.keys(treeA), '落盘文件名相同');
  for (const name of Object.keys(treeA)) assert.ok(treeA[name].equals(treeB[name]), `${name} 逐字节相同`);

  for (const { task, seen } of progress) {
    const n = task.range.to - task.range.from + 1;
    assert.ok(seen.length >= 1, `${task.id}：报过进度`);
    assert.ok(seen.every((v) => Number.isFinite(v) && v >= 0 && v <= n), `${task.id}：进度在 0..${n}：${seen}`);
    assert.ok(seen.every((v, i) => i === 0 || v >= seen[i - 1]), `${task.id}：进度不倒退：${seen}`);
    assert.ok(seen.at(-1) > 0, `${task.id}：最后的进度大于 0`);
  }
});

/** PNG 那一支用真的 CardFrameCache（假 PNG 原样落在 `controls/<key>/mov/frames/`），只把要 ffmpeg 的 finish 换成桩 */
function realPng(entry) {
  entry.cardCache.finish = async () => {};
}
const pngTreeOf = (root, key) => treeOf(path.join(root, 'controls', key, 'mov', 'frames'));
const pngNames = (tree) => Object.keys(tree).filter((n) => n.endsWith('.png'));
const htmlFramesOf = (tree) => Object.keys(tree).filter((n) => n.endsWith('.html')).map((n) => Number(n.slice(0, -5))).sort((a, b) => a - b);
const pngFramesOf = (tree) => pngNames(tree).map((n) => Number(n.slice(0, -4))).sort((a, b) => a - b);
const span = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
/** 按 4 帧一交时这一段的进度序列：4、8、…、n */
const progressBy4 = (n) => Array.from({ length: Math.ceil(n / 4) }, (_, i) => Math.min(4 * (i + 1), n));

/** 对照组：帧库 A，现有的 fillCardControls 一次渲完 clip-a（快照与 PNG 都真落盘） */
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

/** 帧库 B 上的执行器，一段一趟顺推（缺省开着）；记下快照库每次入库的帧 */
async function singlePassExecutor() {
  const rootB = await tmpRoot();
  const B = newPipeline(rootB);
  assert.notEqual(B.queueSinglePassOff, true, '缺省开着一段一趟顺推');
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
  for (const task of tasks) assert.equal(B.queueSinglePass(ctlB, task.range), true, `${task.id}：这一段走顺推`);
  return { rootB, B, executor, ctx, ctlB, tasks, commits };
}

test('J9b render（共享档，一段一趟顺推）：每段 bakeFrames 只调一次、帧集合与逐批的并集相同；快照与 PNG 落盘与 fillCardControls 一次渲完逐字节相同；入库与进度仍按 4 帧', { timeout: 45_000 }, async (t) => {
  t.after(cleanupRoots);
  const A = await oneShotClipA();
  assert.equal(A.recs.length, 38, '夹具：对照组 150 帧按 4 帧一批是 38 批');
  assert.equal(Object.keys(A.html).length, 151, '对照组：150 帧 + index.json');
  assert.equal(pngNames(A.png).length, 150, '对照组：150 帧 PNG');

  const { rootB, executor, ctlB, tasks, commits } = await singlePassExecutor();
  assert.deepEqual(tasks.map((x) => [x.range.from, x.range.to]), [[0, 59], [60, 119], [120, 149]]);
  assert.equal(tasks[0].resultKey, A.ctlA.snapshotKey, '两边的快照键相同');
  assert.equal(ctlB.key, A.ctlA.key, '两边的 PNG 缓存键相同');

  const mark = bakeLog.length;
  const progress = [];
  for (const task of tasks) {
    const seen = [];
    const out = await executor.render(view(task), { signal: signalNone(), progress: (done) => seen.push(done) });
    assert.equal(out, null, 'render 返回 null（sink 自己读磁盘）');
    progress.push({ task, seen });
  }
  const recB = normalize(rootB, bakeLog.slice(mark));
  assert.equal(recB.length, 3, '三段各一次 bakeFrames');
  const { targetFrames: _t, snapshotFrames: _s, ...rest } = A.recs[0];
  tasks.forEach((task, i) => {
    assert.deepEqual(recB[i].targetFrames, span(task.range.from, task.range.to), `${task.id}：targetFrames 是整段`);
    assert.deepEqual(recB[i].snapshotFrames, span(task.range.from, task.range.to), `${task.id}：snapshotFrames 是整段（都缺）`);
    const { targetFrames: _tb, snapshotFrames: _sb, ...restB } = recB[i];
    assert.deepEqual(restB, rest, `${task.id}：out 与三个开关照逐批`);
  });
  assert.deepEqual(recB.flatMap((r) => r.targetFrames), A.recs.flatMap((r) => r.targetFrames), 'targetFrames 的并集与逐批相同');
  assert.deepEqual(recB.flatMap((r) => r.snapshotFrames), A.recs.flatMap((r) => r.snapshotFrames), 'snapshotFrames 的并集与逐批相同');

  const html = await treeOf(path.join(rootB, 'controls-html', tasks[0].resultKey));
  assert.deepEqual(Object.keys(html), Object.keys(A.html), '快照文件名相同');
  for (const name of Object.keys(A.html)) assert.ok(A.html[name].equals(html[name]), `快照 ${name} 逐字节相同`);
  const png = await pngTreeOf(rootB, ctlB.key);
  assert.deepEqual(pngNames(png), pngNames(A.png), 'PNG 文件名相同');
  for (const name of pngNames(A.png)) assert.ok(A.png[name].equals(png[name]), `PNG ${name} 逐字节相同`);

  // 入库仍每 4 帧交一次：每次交的是按 4 帧对齐的一组
  assert.deepEqual(commits.flat(), span(0, 149), '入库的帧合起来是整张卡、按顺序');
  for (const frames of commits) {
    assert.ok(frames.length >= 1 && frames.length <= 4, `一次入库不超过 4 帧：${frames}`);
    assert.equal(frames[0] % 4, 0, `一次入库从 4 帧边界起：${frames}`);
    assert.deepEqual(frames, span(frames[0], frames[0] + frames.length - 1), `一次入库是连续的一组：${frames}`);
  }
  for (const { task, seen } of progress) {
    const n = task.range.to - task.range.from + 1;
    assert.deepEqual(seen, progressBy4(n), `${task.id}：进度按 4 帧报`);
  }
});

/* ================================================================== J10 */

test('J10 render（本地档）：按段换算成全局帧、只渲这张卡缺的帧，与 renderLocalSnapshots 一次渲完相比帧集合与落盘文件相同', { timeout: 45_000 }, async (t) => {
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
  assert.equal(recA.length, 1, '对照组：本地档一趟整场景');
  assert.deepEqual(recA[0].targetFrames, Array.from({ length: 90 }, (_, i) => 30 + i), '对照组：全局帧 30～119');

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
  assert.equal(recB.length, 2, '每段一趟整场景');
  assert.deepEqual(recB[0].targetFrames, Array.from({ length: 60 }, (_, i) => 30 + i), '第一段：本地帧 0～59 → 全局帧 30～89');
  assert.deepEqual(recB[1].targetFrames, Array.from({ length: 30 }, (_, i) => 90 + i), '第二段：本地帧 60～89 → 全局帧 90～119');
  assert.deepEqual(recB.flatMap((r) => r.targetFrames), recA[0].targetFrames, '合起来与对照组的帧集合相同');
  for (const r of recB) {
    assert.deepEqual(r.snapshotFrames, r.targetFrames, 'snapshotFrames 与 targetFrames 相同（照 renderLocalSnapshots）');
    assert.deepEqual({ out: r.out, snapshotOnly: r.snapshotOnly, fullFrame: r.fullFrame, writeFrames: r.writeFrames },
      { out: recA[0].out, snapshotOnly: recA[0].snapshotOnly, fullFrame: recA[0].fullFrame, writeFrames: recA[0].writeFrames }, '其余参数照 renderLocalSnapshots');
  }
  const sub = ['controls-local', ctx.entryKey, ctlA.snapshotKey];
  const [treeA, treeB] = [await treeOf(path.join(rootA, ...sub)), await treeOf(path.join(rootB, ...sub))];
  assert.equal(Object.keys(treeA).length, 91, '对照组：90 帧 + index.json');
  assert.deepEqual(Object.keys(treeB), Object.keys(treeA), '落盘文件名相同');
  for (const name of Object.keys(treeA)) assert.ok(treeA[name].equals(treeB[name]), `${name} 逐字节相同`);
  for (const seen of seenAll) {
    assert.ok(seen.length >= 1 && seen.every((v) => Number.isFinite(v) && v >= 0), `本地档也报进度：${seen}`);
  }

  // 已有的帧不再渲：再渲第一段 → 不调 bakeFrames（或调用里一帧都没有）
  mark = bakeLog.length;
  await executor.render(view(tasks[0]), { signal: signalNone(), progress: () => {} });
  const again = bakeLog.slice(mark).flatMap((r) => r.targetFrames);
  assert.deepEqual(again, [], '这张卡在这一段已经齐了：不再渲');
});

test('J10 render（本地档）：这一段里已有的帧不渲，只渲缺的', { timeout: 30_000 }, async (t) => {
  t.after(cleanupRoots);
  const rootB = await tmpRoot();
  const B = newPipeline(rootB);
  t.after(() => B.close());
  const { executor } = await executorFor(B);
  const ctx = await executor.plan(planView(), { signal: signalNone() });
  const ctl = ctx.cardPlan.find((c) => c.clipId === 'clip-b');
  // 预置本地帧 10～19（全局帧 40～49）
  await B.snapshots().commitSnapshots({ tier: 'local', entryKey: ctx.entryKey, key: ctl.snapshotKey, clipId: 'clip-b', capabilities: ctl.capabilities,
    items: Array.from({ length: 10 }, (_, i) => ({ localFrame: 10 + i, html: `<p>seed ${10 + i}</p>` })) });
  const [first] = tasksOf(ctx, 'clip-b');
  const mark = bakeLog.length;
  await executor.render(view(first), { signal: signalNone(), progress: () => {} });
  const frames = bakeLog.slice(mark).flatMap((r) => r.targetFrames);
  const expected = Array.from({ length: 60 }, (_, i) => 30 + i).filter((g) => g < 40 || g > 49);
  assert.deepEqual(frames, expected, '只渲缺的全局帧（跳过 40～49）');
  const seeded = await fs.readFile(path.join(rootB, 'controls-local', ctx.entryKey, ctl.snapshotKey, '10.html'), 'utf8');
  assert.equal(seeded, '<p>seed 10</p>', '已有的帧不被覆盖');
});

test('J10 render：任务对不上计划时抛 plan-mismatch（不可重试），不渲染；没有轨道流生产者时流任务抛 no-streams（M6c X1 起不再抛 stream-not-supported）', { timeout: 30_000 }, async (t) => {
  t.after(cleanupRoots);
  const B = newPipeline(await tmpRoot());
  t.after(() => B.close());
  const { executor } = await executorFor(B);
  const ctx = await executor.plan(planView(), { signal: signalNone() });
  const [shared] = tasksOf(ctx, 'clip-a');
  const [local] = tasksOf(ctx, 'clip-b');
  const mut = (task, fn) => { const copy = view(task); fn(copy); return copy; };
  const cases = [
    ['共享档 contentKey 不同', mut(shared, (x) => { x.input.contentKey = 'f'.repeat(64); })],
    ['共享档 resultKey 不是本机指纹的键', mut(shared, (x) => { x.resultKey = resultKeyOf(x.input.contentKey, 'aaaaaaaaaaaaaaaa'); })],
    ['档位不同（共享档的卡当本地档）', mut(shared, (x) => { x.tier = 'local'; })],
    ['范围越界', mut(shared, (x) => { x.range = { unit: 'localFrame', from: 120, to: 150 }; })],
    ['片段不存在', mut(shared, (x) => { x.input.clipId = 'clip-nope'; })],
    ['被去掉的卡（sourceDependent）', mut(shared, (x) => { x.input.clipId = 'clip-t'; })],
    ['本地档 entryKey 不同', mut(local, (x) => { x.input.entryKey = sha256('other-entry'); x.input.contentKey = `${x.input.entryKey}/${x.input.contentKey.split('/')[1]}`; })],
    ['本地档 contentKey 没带 entryKey 前缀', mut(local, (x) => { x.input.contentKey = x.input.contentKey.split('/')[1]; })],
  ];
  const mark = bakeLog.length;
  for (const [what, task] of cases) {
    const err = await rejectionOf(executor.render(task, { signal: signalNone(), progress: () => {} }));
    assert.ok(err, `${what}：要失败`);
    assert.equal(err.code, 'plan-mismatch', `${what}：code 是 plan-mismatch：${err?.code} ${err?.message}`);
    assert.equal(err.retryable, false, `${what}：不可重试`);
  }
  const stream = view({
    id: `stream:${'c'.repeat(64)}:0-7`, kind: 'stream', resultKey: 'c'.repeat(64), range: { unit: 'segment', from: 0, to: 7 },
    source: { projectId: PID, projectRev: REV, derivedFrom: `plan:${PID}@${REV}` },
    input: { clipId: 'clip-a', cardId: null, entryKey: null, contentKey: 'd'.repeat(64) },
    weight: { class: 'heavy', estMs: null, frames: 120 }, requires: { envFingerprint: OWN, codeVersion: 'cv-test' }, priority: 10,
  });
  const serr = await rejectionOf(executor.render(stream, { signal: signalNone(), progress: () => {} }));
  assert.ok(serr, '流任务要失败');
  // M6c X1：执行器接流任务；这条管线 interactive: false、没有轨道流生产者，所以回 no-streams（不可重试）
  assert.equal(serr.code, 'no-streams');
  assert.equal(serr.retryable, false);
  assert.equal(bakeLog.length, mark, '对不上的任务一帧都不渲');
});

test('J10 render（逐批：关掉一段一趟顺推）：中途中止 → 拒绝、停在批次边界、不再写后面的帧；之后用新信号重渲能补齐', { timeout: 30_000 }, async (t) => {
  t.after(cleanupRoots);
  t.after(() => { onBake = null; });
  const rootB = await tmpRoot();
  const B = newPipeline(rootB);
  B.queueSinglePassOff = true; // 逐批这条路（canvas 重卡、播放头要的段、开关关掉时）
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
  assert.ok(err, '中止后 render 拒绝');
  assert.notEqual(err.code, 'plan-mismatch', '不是 plan-mismatch');
  assert.ok(bakeLog.length - mark <= 3, `停在批次边界：中止后最多再进一批，实际 ${bakeLog.length - mark} 批（整段 15 批）`);
  const dir = path.join(rootB, 'controls-html', first.resultKey);
  const written = Object.keys(await treeOf(dir)).filter((n) => n.endsWith('.html')).length;
  assert.ok(written < 60, `没写完整段：${written} 帧`);

  await executor.render(view(first), { signal: signalNone(), progress: () => {} });
  const after = Object.keys(await treeOf(dir)).filter((n) => n.endsWith('.html')).length;
  assert.equal(after, 60, '重渲补齐这一段');
});

test('J10b render（一段一趟顺推）：中途中止 → 拒绝、中止点之后的快照与 PNG 都不写、已入库的快照只到 4 帧边界；之后用新信号重渲能补齐，整张卡落盘与一次渲完逐字节相同', { timeout: 45_000 }, async (t) => {
  t.after(cleanupRoots);
  t.after(() => { onBakeFrame = null; });
  const A = await oneShotClipA();
  const { rootB, executor, ctlB, tasks, commits } = await singlePassExecutor();
  const [first, ...others] = tasks;
  const htmlDir = path.join(rootB, 'controls-html', first.resultKey);

  // 第 15 帧的快照已经生成、截图之前中止：12～15 这一组的快照都生成了，但交库（第 15 帧截完图时）在中止之后，不该入库
  const ABORT_AT = 15;
  const controller = new AbortController();
  onBakeFrame = async (_rec, frame, phase) => { if (frame === ABORT_AT && phase === 'shot') controller.abort(); };
  const seen = [];
  let mark = bakeLog.length;
  const err = await rejectionOf(executor.render(view(first), { signal: controller.signal, progress: (done) => seen.push(done) }));
  onBakeFrame = null;
  assert.ok(err, '中止后 render 拒绝');
  assert.notEqual(err.code, 'plan-mismatch', '不是 plan-mismatch');
  assert.equal(err.cancelled, true, `按取消拒绝：${err?.message}`);
  const aborted = bakeLog.slice(mark);
  assert.equal(aborted.length, 1, '顺推：这一段只调了一次 bakeFrames');
  assert.deepEqual(aborted[0].targetFrames, span(0, 59));

  const html = await treeOf(htmlDir);
  assert.deepEqual(htmlFramesOf(html), span(0, 11), '快照只写到中止点之前交过的那几组（12～15 生成了但中止在交库之前）');
  const index = JSON.parse(html['index.json'].toString('utf8'));
  assert.deepEqual(index.frames, [[0, 11]], `index.json 只含完整的 4 帧组：${JSON.stringify(index)}`);
  assert.equal(index.count, 12);
  for (const n of htmlFramesOf(html)) assert.ok(html[`${n}.html`].equals(A.html[`${n}.html`]), `已写的快照 ${n} 与一次渲完相同`);
  assert.deepEqual(commits, [span(0, 3), span(4, 7), span(8, 11)], '入库三次，每次一组 4 帧');
  assert.deepEqual(seen, [4, 8, 12], '进度只报到交过的那几组');

  const png = await pngTreeOf(rootB, ctlB.key);
  assert.deepEqual(pngFramesOf(png), span(0, ABORT_AT - 1), 'PNG 只写到中止点之前（中止那一帧及之后不写）');
  for (const name of pngNames(png)) assert.ok(png[name].equals(A.png[name]), `已写的 PNG ${name} 完整、与一次渲完相同`);

  // 新信号重渲这一段：从头再推一趟，快照只补缺的 12～59
  mark = bakeLog.length;
  const seen2 = [];
  await executor.render(view(first), { signal: signalNone(), progress: (done) => seen2.push(done) });
  const retry = bakeLog.slice(mark);
  assert.equal(retry.length, 1, '重渲这一段仍是一趟');
  assert.deepEqual(retry[0].targetFrames, span(0, 59), '重渲：PNG 那一支照旧要整段');
  assert.deepEqual(retry[0].snapshotFrames, span(12, 59), '重渲：快照只补缺的');
  assert.deepEqual(htmlFramesOf(await treeOf(htmlDir)), span(0, 59), '重渲补齐这一段');
  assert.deepEqual(seen2, progressBy4(60), '重渲的进度仍按 4 帧报');

  for (const task of others) await executor.render(view(task), { signal: signalNone(), progress: () => {} });
  const htmlAll = await treeOf(htmlDir);
  assert.deepEqual(Object.keys(htmlAll), Object.keys(A.html), '整张卡：快照文件名与一次渲完相同');
  for (const name of Object.keys(A.html)) assert.ok(A.html[name].equals(htmlAll[name]), `整张卡：快照 ${name} 逐字节相同`);
  const pngAll = await pngTreeOf(rootB, ctlB.key);
  assert.deepEqual(pngNames(pngAll), pngNames(A.png), '整张卡：PNG 文件名与一次渲完相同');
  for (const name of pngNames(A.png)) assert.ok(A.png[name].equals(pngAll[name]), `整张卡：PNG ${name} 逐字节相同`);
});

/* ================================================================== J11 */

/** fillCardControls 对 clip-a 的现有行为：38 批，每批 4 帧（最后一批 2 帧），snapshotFrames 扣掉已有的 */
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

test('J11 不传范围参数时 fillCardControls 的行为不变：批次、targetFrames、snapshotFrames（扣掉已有的）与落盘和现在一样', { timeout: 45_000 }, async (t) => {
  t.after(cleanupRoots);
  const base = await fullCardRun([]);
  const have = new Set(Array.from({ length: 10 }, (_, i) => i));
  assert.deepEqual(base.recs, expectedFullCard(base.ctl, have), '不传第 5 个参数：与现有行为逐项相同');
  assert.equal(Object.keys(base.tree).filter((n) => n.endsWith('.html')).length, 150, '整张卡 150 帧都在');
  assert.equal(base.tree['0.html'].toString(), '<p>seed 0</p>', '已有的帧不覆盖');

  // 第 5 个参数给空对象、给 undefined：与不传相同
  for (const extra of [[undefined], [{}]]) {
    const run = await fullCardRun(extra);
    assert.deepEqual(run.recs, base.recs, `第 5 个参数 ${JSON.stringify(extra[0])}：调用记录不变`);
    assert.deepEqual(Object.keys(run.tree), Object.keys(base.tree));
    for (const name of Object.keys(base.tree)) assert.ok(run.tree[name].equals(base.tree[name]), `${name} 相同`);
  }
  // 范围覆盖整张卡：与不传相同
  const whole = await fullCardRun([{ range: { from: 0, to: 149 } }]);
  assert.deepEqual(whole.recs, base.recs, '范围是整张卡时与不传相同');
});

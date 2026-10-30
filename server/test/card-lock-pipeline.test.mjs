/**
 * 卡片级指纹锁：本机预渲染进程这一侧（契约 `docs/plan/render-queue-contract.md` F.3 与 F.8，
 * 测试表 F.5 的 L1～L8、F.8 第 5 条的 L9、L10）。
 * 跑：node --experimental-test-module-mocks --test server/test/card-lock-pipeline.test.mjs
 *
 * 只照契约 F.3、F.8 以及它引用的 E.2、E.3 写，不看实现。
 *
 * 约定：
 *   - `server/card-lock.mjs` 是 F.3 新建的模块，按需动态引入：它不存在时只有用到它的用例失败。
 *   - 不起 Chrome：`server/bakery/index.mjs` 整个换成假的（和 `agent-lane.test.mjs` 一样用 `mock.module`）。
 *     假的 `bakeFrames` 记下每次调用的 `out` / `targetFrames` / `snapshotFrames`，对 `targetFrames` 调
 *     `onFrame`、对 `snapshotFrames` 调 `onSnapshot`，这就是 L6～L10 的「假 bakery 计数」。`onSnapshot` 的产物
 *     由假 bakery 的 `itemsFor` 给：隔离单卡那一路（`out` 在 `<root>/controls/` 下）每张卡一项、帧号原样；
 *     整场景那一路按片段起点换成本地帧、只给这一帧上有的卡。
 *   - `FramePipeline` 构造时注入 `environment`（E.2），不探测；`dataRoot` 指向临时目录（成本记录读不到，
 *     预渲染集合按声明兜底，stateful 的卡都在集合里）；`interactive: false`（不产轨道流）。
 *   - card plan 用真的 `CardFrameCache.plan()`（entry 自带的那个）算，contentKey / snapshotKey 与生产一致；
 *     `fillCardControls` 那几条把 entry 上 `cardCache` 的 `hasComplete` / `put` / `finish` 换成桩（PNG 那一支不落盘）。
 *   - `publishLayer` 在实例上包一层记录（`this.publishLayer` 的每次调用），记下调用那一刻的 `snapshotKey`。
 *   - L9 走真的 `preload`：只把借预渲染间（`acquire`）、整片 MOV（`fillMov`）、视频（`prerender`）、存档（`save`）
 *     换成桩，其余（锚帧、fillCardControls、本地档、延后重判的计时器）跑真的；用例结束 `close()`。
 *   - 每条用例一个 `fs.mkdtemp` 临时目录，结束删掉。
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/* ------------------------------------------------------------------ 假的预渲染间 */

const bakeLog = [];
/** 测试可以设一个钩子：每次 bakeFrames 开始时调用（L8 用它在别的卡渲染期间改盘面） */
let onBake = null;

mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: {
    openBakery: async () => { throw new Error('单测不开 Chrome'); },
    findFfmpeg: async () => 'ffmpeg',
    streamPngVideo: () => { throw new Error('单测不编码'); },
    bakeFrames: async (bakery, opts = {}) => {
      const rec = { out: opts.out, targetFrames: [...(opts.targetFrames ?? [])], snapshotFrames: [...(opts.snapshotFrames ?? [])] };
      bakeLog.push(rec);
      if (onBake) await onBake(rec);
      for (const frame of rec.targetFrames) await opts.onFrame?.(frame, Buffer.from(`png-${frame}`));
      for (const frame of rec.snapshotFrames) {
        const items = bakery?.itemsFor ? bakery.itemsFor(frame, rec) : [];
        await opts.onSnapshot?.(frame, '<div data-pc-scene=""></div>', items);
      }
    },
  },
});

const { FramePipeline } = await import('../frame-pipeline.mjs');
const { CardFrameCache } = await import('../card-cache.mjs');
const { SnapshotStore } = await import('../snapshot-store.mjs');
const { describeEnvironment } = await import('../render-node/fingerprint.mjs');
const loadCardLock = () => import('../card-lock.mjs');

/* ------------------------------------------------------------------ 常量 */

const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const rk = (contentKey, fp) => sha256(`${contentKey}\n${fp}`);
const HEX64 = /^[0-9a-f]{64}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const OWN_ENV = describeEnvironment({
  platform: 'win32',
  renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  vendor: 'Google Inc. (Google)', chromeVersion: 'HeadlessChrome/138.0.7204.49',
});
const OWN = OWN_ENV.fingerprint;
const PAGE = describeEnvironment({
  platform: 'Win32', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)', vendor: 'Google Inc. (NVIDIA)',
  chromeVersion: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
}).fingerprint;
const PAGE2 = describeEnvironment({
  platform: 'MacIntel', renderer: 'Apple M2', vendor: 'Apple',
  chromeVersion: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
}).fingerprint;
assert.notEqual(OWN, PAGE);
assert.notEqual(PAGE, PAGE2);

const IDLE_MS = 30_000;

/**
 * 卡：a、c 共享档，b 本地档，每张 0.5 秒 = 15 帧。a 从 0 秒（全局帧 0～14），c 从 2 秒（全局帧 60～74），
 * b 从 0 秒。`twin` 时另有 a2：与 a 同一个节点、同样的时长与相位，摆在 1 秒（全局帧 30～44）——
 * 同一张卡摆了两次，内容键（和共享快照键）与 a 相同（F.8 第 3 条）。graph 的写法同 env-fingerprint-keys.test.mjs。
 */
const N = 15;
const ALL = Array.from({ length: N }, (_, i) => i);
const FULL = [[0, N - 1]];
const START = { 'clip-a': 0, 'clip-a2': 1, 'clip-c': 2, 'clip-b': 0 };
const SHARED = { compositing: 'independent', frameMode: 'stateful' };
const LOCAL = { compositing: 'belowDependent', frameMode: 'stateful' };

function projectOf({ twin = false } = {}) {
  const clip = (id, cardId) => ({ id, cardId, start: START[id], end: START[id] + 0.5 });
  return {
    id: twin ? 'card-lock-twin' : 'card-lock', fps: 30, width: 320, height: 180, duration: 3, style: {}, media: [],
    tracks: [
      { id: 't1', clips: [clip('clip-a', 'demo-a'), ...(twin ? [clip('clip-a2', 'demo-a')] : [])] },
      { id: 't2', clips: [clip('clip-c', 'demo-c')] },
      { id: 't3', clips: [clip('clip-b', 'glass')] },
    ],
  };
}
function graphOf({ twin = false } = {}) {
  const out = (nodeId, clipId) => ({ nodeId, clipId, start: START[clipId], end: START[clipId] + 0.5, opacity: 1 });
  return {
    definitions: [],
    nodes: [
      { id: 'n-a', adapter: 'chrome', cardId: 'demo-a', capabilities: { ...SHARED }, inputs: {} },
      { id: 'n-c', adapter: 'chrome', cardId: 'demo-c', capabilities: { ...SHARED }, inputs: {} },
      { id: 'n-b', adapter: 'chrome', cardId: 'glass', capabilities: { ...LOCAL }, inputs: {} },
    ],
    outputs: [out('n-a', 'clip-a'), ...(twin ? [out('n-a', 'clip-a2')] : []), out('n-c', 'clip-c'), out('n-b', 'clip-b')],
  };
}

const withTmp = async (prefix, fn) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  // 锁库的写盘是排在后面异步做的（F.3），用例结束时可能还在落；删目录时重试几次
  try { return await fn(root); } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
};

/**
 * 一套本机预渲染进程的场景：
 *   `locks`    开始前盘上已有的锁：[{ clipId, fp, source = 'page', touchedAt = Date.now() }]
 *   `frames`   开始前盘上已有的共享档快照：[{ clipId, fp, frames: [本地帧…] }]（写在 resultKeyOf(contentKey, fp) 下）
 *   `twin`     见上
 *   `options`  另给 FramePipeline 构造的参数（L9 的 cardLockIdleMs）
 *   `record`   是否先建 entry、记下 card plan（L9 走 preload，自己算）
 */
async function scene(root, { locks = [], frames = [], twin = false, options = {}, record = true } = {}) {
  const project = projectOf({ twin }), graph = graphOf({ twin });
  const plan0 = new CardFrameCache({ root, project, envFingerprint: OWN }).plan(graph);
  const ck = Object.fromEntries(plan0.map(c => [c.clipId, c.contentKey]));
  const caps = Object.fromEntries(plan0.map(c => [c.clipId, c.capabilities]));
  const pngKey = Object.fromEntries(plan0.map(c => [c.clipId, c.key]));
  assert.ok(ck['clip-a'] && ck['clip-c'], '夹具：plan 里有 a、c 两张共享档卡');
  assert.ok(plan0.every(c => c.count === N), `夹具：每张卡 ${N} 帧`);
  if (twin) assert.equal(ck['clip-a2'], ck['clip-a'], '夹具：a2 与 a 内容键相同');
  if (locks.length) {
    const { createCardLockStore } = await loadCardLock();
    for (const { clipId, fp, source = 'page', touchedAt = Date.now() } of locks) {
      const seed = createCardLockStore({ dir: path.join(root, 'controls-lock'), now: () => touchedAt });
      await seed.load();
      seed.takeover(ck[clipId], fp, source);
      await seed.flush();
    }
  }
  const store = new SnapshotStore(root);
  for (const { clipId, fp, frames: list } of frames) {
    await store.commitSnapshots({ tier: 'shared', key: rk(ck[clipId], fp), clipId, capabilities: caps[clipId],
      items: list.map(localFrame => ({ localFrame, html: `<p>${clipId} ${fp} ${localFrame}</p>` })) });
  }

  const pipeline = new FramePipeline({ root, origin: () => 'http://127.0.0.1:1', environment: OWN_ENV, dataRoot: root, interactive: false, ...options });
  await pipeline.ensureCardLocks();
  const origRecord = pipeline.recordCardPlan.bind(pipeline);
  pipeline.recordCardPlan = (entry, plan) => {
    for (const c of plan ?? []) {
      if (!c.tier || c.tier === 'none') {
        const comp = c.compositing ?? c.capabilities?.compositing ?? 'unknown';
        c.tier = (comp === 'independent' || comp === 'sourceDependent') ? 'shared' : 'local';
      }
    }
    return origRecord(entry, plan);
  };
  const layers = [];
  const publish = pipeline.publishLayer.bind(pipeline);
  pipeline.publishLayer = (entry, control, tier, ranges) => {
    layers.push({ clipId: control?.clipId, snapshotKey: control?.snapshotKey, tier, ranges: structuredClone(ranges) });
    return publish(entry, control, tier, ranges);
  };
  let entry = null;
  if (record) {
    entry = await pipeline.entry(project);
    pipeline.recordCardPlan(entry, entry.cardCache.plan(graph));
  }
  const s = {
    root, project, graph, pipeline, ck, caps, pngKey, layers, store,
    get entry() { return entry; },
    set entry(value) { entry = value; },
    ctl: clipId => entry.cardPlan.find(c => c.clipId === clipId),
    own: clipId => rk(ck[clipId], OWN),
    keyOf: (clipId, fp) => rk(ck[clipId], fp),
    index: (clipId, fp) => store.snapshotIndex({ tier: 'shared', key: rk(ck[clipId], fp) }),
    lockStore: () => pipeline.cardLockStore,
    layersOf: clipId => layers.filter(l => l.clipId === clipId),
  };
  return s;
}

/** fillCardControls 用：PNG 那一支换成桩，记 put */
function stubPng(entry, { complete = false } = {}) {
  const puts = [];
  entry.cardCache.hasComplete = async () => complete;
  entry.cardCache.put = async (key, frame) => { puts.push({ key, frame }); return true; };
  entry.cardCache.finish = async () => {};
  return puts;
}
/** 假的预渲染间：记 reset；`itemsFor` 给 onSnapshot 的产物；`evaluate` 回 browser plan（preload 用） */
function fakeBakery(s) {
  const controlsDir = path.join(s.root, 'controls') + path.sep;
  const clips = Object.keys(s.ck);
  const bakery = {
    resets: 0,
    page: { setViewport: async () => {}, evaluate: async () => s.graph },
    itemsFor(frame, rec) {
      const isolated = typeof rec.out === 'string' && rec.out.startsWith(controlsDir);
      if (isolated) return clips.map(id => ({ id, frame, html: `<div data-clip="${id}" data-f="${frame}">own</div>` }));
      return clips.map(id => ({ id, frame: frame - START[id] * 30, html: `<div data-clip="${id}" data-f="${frame}">scene</div>` }))
        .filter(item => item.frame >= 0 && item.frame < N);
    },
  };
  bakery.reset = async () => { bakery.resets += 1; };
  return bakery;
}
/** 这一趟里给某张卡（按 PNG 缓存目录认）要过的 HTML 快照帧 */
const bakesOf = (s, clipId) => bakeLog.filter(r => r.out === path.join(s.root, 'controls', s.pngKey[clipId]));
const snapshotFramesOf = (s, clipId) => bakesOf(s, clipId).flatMap(r => r.snapshotFrames).sort((x, y) => x - y);
const uniq = list => [...new Set(list)].sort((x, y) => x - y);

async function waitFor(what, predicate, { timeoutMs = 10_000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(stepMs);
  }
  assert.fail(`等了 ${timeoutMs} ms 仍未满足：${what}`);
}

/* ================================================================== L1 */

test('L1 锁库：acquire 得锁、同指纹刷新、异指纹拒绝；takeover 覆盖；get / list；方法同步', async () => withTmp('pc-cl-l1-', async root => {
  const { createCardLockStore, CARD_LOCK_IDLE_MS } = await loadCardLock();
  assert.equal(CARD_LOCK_IDLE_MS, 30_000);
  let t = 1_000_000;
  const store = createCardLockStore({ dir: path.join(root, 'controls-lock'), now: () => t });
  await store.load();   // 目录不存在不算错
  const K1 = sha256('k1'), K2 = sha256('k2');
  assert.equal(store.get(K1), null);

  const r1 = store.acquire(K1, PAGE, 'page');
  assert.ok(!(r1 instanceof Promise), 'acquire 同步');
  assert.deepEqual(r1, { granted: true, lock: { envFingerprint: PAGE, source: 'page', since: t, touchedAt: t } });
  assert.deepEqual(store.get(K1), { envFingerprint: PAGE, source: 'page', since: 1_000_000, touchedAt: 1_000_000 });

  t += 500;
  const r2 = store.acquire(K1, PAGE, 'prerender');
  assert.equal(r2.granted, true);
  assert.deepEqual(store.get(K1), { envFingerprint: PAGE, source: 'page', since: 1_000_000, touchedAt: 1_000_500 },
    '同指纹只刷新 touchedAt（since、source 不变）');

  t += 500;
  const r3 = store.acquire(K1, OWN, 'prerender');
  assert.equal(r3.granted, false);
  assert.equal(r3.lock.envFingerprint, PAGE, '回的是现有的锁');
  assert.deepEqual(store.get(K1), { envFingerprint: PAGE, source: 'page', since: 1_000_000, touchedAt: 1_000_500 }, '异指纹被拒：锁不变');

  t += 500;
  const r4 = store.takeover(K1, OWN, 'prerender');
  assert.ok(!(r4 instanceof Promise), 'takeover 同步');
  assert.deepEqual(store.get(K1), { envFingerprint: OWN, source: 'prerender', since: 1_001_500, touchedAt: 1_001_500 }, 'takeover 覆盖，since = touchedAt = now');

  store.acquire(K2, PAGE2, 'page');
  assert.deepEqual(store.list(), [
    { contentKey: K1, envFingerprint: OWN, source: 'prerender', since: 1_001_500, touchedAt: 1_001_500 },
    { contentKey: K2, envFingerprint: PAGE2, source: 'page', since: 1_001_500, touchedAt: 1_001_500 },
  ].sort((a, b) => (a.contentKey < b.contentKey ? -1 : 1)), 'list 按 contentKey 排序');
}));

test('L1 锁库：flush 后落盘（一把锁一个 <contentKey>.json），新建的库 load 读得回；排队的多次写以最后一次为准', async () => withTmp('pc-cl-l1-disk-', async root => {
  const { createCardLockStore } = await loadCardLock();
  const dir = path.join(root, 'controls-lock');
  let t = 5_000;
  const store = createCardLockStore({ dir, now: () => t });
  await store.load();
  const K1 = sha256('disk-1'), K2 = sha256('disk-2');
  store.acquire(K1, PAGE, 'page');
  t += 1; store.acquire(K1, PAGE, 'page');
  t += 1; store.takeover(K1, OWN, 'prerender');
  t += 1; store.acquire(K1, OWN, 'prerender');
  store.acquire(K2, PAGE2, 'page');
  await store.flush();

  const files = (await fs.readdir(dir)).filter(name => name.endsWith('.json')).sort();
  assert.deepEqual(files, [`${K1}.json`, `${K2}.json`].sort());
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, `${K1}.json`), 'utf8')),
    { envFingerprint: OWN, source: 'prerender', since: 5_002, touchedAt: 5_003 }, '文件内容是最后一次的状态');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, `${K2}.json`), 'utf8')),
    { envFingerprint: PAGE2, source: 'page', since: 5_003, touchedAt: 5_003 });
  const leftovers = (await fs.readdir(dir)).filter(name => !name.endsWith('.json'));
  assert.deepEqual(leftovers, [], 'flush 之后没有残留的临时文件');

  const again = createCardLockStore({ dir, now: () => 9_999 });
  assert.equal(again.get(K1), null, 'load 之前是空的');
  await again.load();
  assert.deepEqual(again.list(), store.list(), '新建的库 load 读得回');
  assert.deepEqual(again.get(K1), { envFingerprint: OWN, source: 'prerender', since: 5_002, touchedAt: 5_003 });
}));

test('L1 锁库：坏文件跳过；非法 contentKey、空的环境指纹在 acquire / takeover 抛（F.8 第 4 条）', async () => withTmp('pc-cl-l1-bad-', async root => {
  const { createCardLockStore } = await loadCardLock();
  const dir = path.join(root, 'controls-lock');
  await fs.mkdir(dir, { recursive: true });
  const good = sha256('good'), broken = sha256('broken'), empty = sha256('empty');
  await fs.writeFile(path.join(dir, `${good}.json`), JSON.stringify({ envFingerprint: PAGE, source: 'page', since: 1, touchedAt: 2 }));
  await fs.writeFile(path.join(dir, `${broken}.json`), '{ not json');
  await fs.writeFile(path.join(dir, `${empty}.json`), '');
  await fs.writeFile(path.join(dir, 'README.txt'), 'not a lock');
  const store = createCardLockStore({ dir, now: () => 10 });
  await store.load();
  assert.deepEqual(store.list(), [{ contentKey: good, envFingerprint: PAGE, source: 'page', since: 1, touchedAt: 2 }], '坏文件跳过，其余照读');
  assert.equal(store.get(broken), null);

  for (const bad of ['', 'abc', sha256('x').toUpperCase(), sha256('x').slice(0, 63), `${sha256('x')}0`, `../${sha256('x').slice(3)}`, 'g'.repeat(64), null, undefined, 42]) {
    assert.throws(() => store.acquire(bad, PAGE, 'page'), `acquire(${JSON.stringify(bad)}) 应抛`);
    assert.throws(() => store.takeover(bad, PAGE, 'page'), `takeover(${JSON.stringify(bad)}) 应抛`);
  }
  const fresh = sha256('fresh');
  for (const fp of ['', null, undefined]) {
    assert.throws(() => store.acquire(fresh, fp, 'page'), `acquire 的环境指纹 ${JSON.stringify(fp)} 应抛`);
    assert.throws(() => store.takeover(good, fp, 'page'), `takeover 的环境指纹 ${JSON.stringify(fp)} 应抛`);
  }
  assert.equal(store.get(fresh), null, '抛出的调用不建锁');
  assert.equal(store.get(good).envFingerprint, PAGE, '抛出的调用不改现有的锁');
  assert.equal(store.list().length, 1, '抛出的调用不改内存');
  await store.flush();
  assert.deepEqual((await fs.readdir(dir)).filter(n => n.endsWith('.json')).sort(), [`${good}.json`, `${broken}.json`, `${empty}.json`].sort(),
    '不写非法键的文件');
}));

/* ================================================================== L2 */

test('L2 cardLockDecision：own / reuse / defer / takeover 四个分支，按顺序判；touchedAt 恰好 idleMs 前算闲置', async () => {
  const { cardLockDecision, CARD_LOCK_IDLE_MS } = await loadCardLock();
  const now = 10_000_000;
  const lock = (fp, touchedAt = now) => ({ envFingerprint: fp, source: 'page', since: touchedAt - 1, touchedAt });
  // 1. 没锁 / 自己的锁 → own（不管齐没齐、新不新鲜）
  for (const complete of [false, true]) {
    assert.equal(cardLockDecision({ lock: null, ownFingerprint: OWN, complete, now }), 'own');
    assert.equal(cardLockDecision({ lock: undefined, ownFingerprint: OWN, complete, now }), 'own');
    assert.equal(cardLockDecision({ lock: lock(OWN), ownFingerprint: OWN, complete, now }), 'own');
    assert.equal(cardLockDecision({ lock: lock(OWN, now - 10 * IDLE_MS), ownFingerprint: OWN, complete, now }), 'own');
  }
  // 2. 别人的锁、结果已齐 → reuse（新鲜、闲置都一样）
  assert.equal(cardLockDecision({ lock: lock(PAGE), ownFingerprint: OWN, complete: true, now }), 'reuse');
  assert.equal(cardLockDecision({ lock: lock(PAGE, now - 10 * IDLE_MS), ownFingerprint: OWN, complete: true, now }), 'reuse');
  // 3. 别人的锁、不齐、还新鲜 → defer
  assert.equal(cardLockDecision({ lock: lock(PAGE), ownFingerprint: OWN, complete: false, now }), 'defer');
  assert.equal(cardLockDecision({ lock: lock(PAGE, now - CARD_LOCK_IDLE_MS + 1), ownFingerprint: OWN, complete: false, now }), 'defer', 'idleMs - 1 前');
  // 4. 边界：恰好 idleMs 前 → takeover（`now - touchedAt < idleMs` 才 defer）
  assert.equal(cardLockDecision({ lock: lock(PAGE, now - CARD_LOCK_IDLE_MS), ownFingerprint: OWN, complete: false, now }), 'takeover', '恰好 idleMs');
  assert.equal(cardLockDecision({ lock: lock(PAGE, now - CARD_LOCK_IDLE_MS - 1), ownFingerprint: OWN, complete: false, now }), 'takeover');
  // idleMs 可覆盖
  assert.equal(cardLockDecision({ lock: lock(PAGE, now - 100), ownFingerprint: OWN, complete: false, now, idleMs: 100 }), 'takeover');
  assert.equal(cardLockDecision({ lock: lock(PAGE, now - 99), ownFingerprint: OWN, complete: false, now, idleMs: 100 }), 'defer');
  assert.equal(CARD_LOCK_IDLE_MS, IDLE_MS);
});

/* ================================================================== L3 */

test('L3 applyCardLocks：异指纹锁 → snapshotKey = resultKeyOf(contentKey, 锁指纹)、envFingerprint 是锁指纹、cardLock.foreign；key / contentKey 不变；诊断可见', async () => withTmp('pc-cl-l3-', async root => {
  const s = await scene(root, { locks: [{ clipId: 'clip-a', fp: PAGE }] });
  const before = new CardFrameCache({ root, project: s.project, envFingerprint: OWN }).plan(s.graph);
  const a = s.ctl('clip-a'), c = s.ctl('clip-c'), b = s.ctl('clip-b');
  const a0 = before.find(x => x.clipId === 'clip-a'), c0 = before.find(x => x.clipId === 'clip-c'), b0 = before.find(x => x.clipId === 'clip-b');

  assert.equal(a.snapshotKey, rk(a.contentKey, PAGE), 'recordCardPlan 里调 applyCardLocks：a 换成锁定方的键');
  assert.match(a.snapshotKey, HEX64);
  assert.equal(a.envFingerprint, PAGE);
  assert.deepEqual(a.cardLock, { envFingerprint: PAGE, source: 'page', foreign: true });
  assert.equal(a.key, a0.key, 'PNG 键不动');
  assert.equal(a.contentKey, a0.contentKey, '内容键不动');
  // 没锁的共享档卡：自己的键、cardLock null
  assert.equal(c.snapshotKey, c0.snapshotKey);
  assert.equal(c.envFingerprint, OWN);
  assert.equal(c.cardLock, null);
  // 本地档不参与
  assert.equal(b.tier, 'local');
  assert.equal(b.snapshotKey, b0.snapshotKey);
  assert.equal(b.envFingerprint, OWN);

  // 重复调结果相同
  const snapshot = structuredClone(s.entry.cardPlan);
  s.pipeline.applyCardLocks(s.entry.cardPlan);
  s.pipeline.applyCardLocks(s.entry.cardPlan);
  assert.deepEqual(s.entry.cardPlan, snapshot, '同一份 plan 重复调结果相同');

  // 诊断
  const diag = s.pipeline.diagnostics();
  assert.deepEqual(diag.cardLocks, s.lockStore().list(), 'diagnostics().cardLocks = store.list()');
  assert.equal(diag.cardLocks.find(l => l.contentKey === a.contentKey)?.envFingerprint, PAGE);
  const pd = s.pipeline.planDiagnostics().find(p => p.key === s.entry.key);
  assert.deepEqual(pd.controls.find(x => x.clipId === 'clip-a').cardLock, { envFingerprint: PAGE, source: 'page', foreign: true });
  assert.equal(pd.controls.find(x => x.clipId === 'clip-a').snapshotKey, a.snapshotKey);
  assert.equal(pd.controls.find(x => x.clipId === 'clip-c').cardLock, null);
}));

test('L3 applyCardLocks：锁换回本机指纹后恢复自己的键（foreign: false）；锁没了恢复自己的键、cardLock null；同内容键的片段一起换', async () => withTmp('pc-cl-l3-back-', async root => {
  const s = await scene(root, { locks: [{ clipId: 'clip-a', fp: PAGE }], twin: true });
  const own = s.own('clip-a');
  for (const id of ['clip-a', 'clip-a2']) assert.equal(s.ctl(id).snapshotKey, s.keyOf('clip-a', PAGE), `${id} 用锁定方的键`);

  s.lockStore().takeover(s.ck['clip-a'], OWN, 'prerender');
  s.pipeline.applyCardLocks(s.entry.cardPlan);
  for (const id of ['clip-a', 'clip-a2']) {
    const x = s.ctl(id);
    assert.equal(x.snapshotKey, own, `${id} 换回自己的键`);
    assert.equal(x.envFingerprint, OWN);
    assert.deepEqual(x.cardLock, { envFingerprint: OWN, source: 'prerender', foreign: false });
  }

  // 再被页面接手、又换回
  s.lockStore().takeover(s.ck['clip-a'], PAGE2, 'page');
  s.pipeline.applyCardLocks(s.entry.cardPlan);
  assert.equal(s.ctl('clip-a').snapshotKey, rk(s.ck['clip-a'], PAGE2));
  assert.equal(s.ctl('clip-a').envFingerprint, PAGE2);

  // 锁没了（换一个空的锁库）：恢复自己的键
  await s.lockStore().flush();
  const { createCardLockStore } = await loadCardLock();
  s.pipeline.cardLockStore = createCardLockStore({ dir: path.join(root, 'empty-locks') });
  await s.pipeline.cardLockStore.load();
  s.pipeline.applyCardLocks(s.entry.cardPlan);
  assert.equal(s.ctl('clip-a').snapshotKey, own);
  assert.equal(s.ctl('clip-a').envFingerprint, OWN);
  assert.equal(s.ctl('clip-a').cardLock, null);
  assert.equal(s.ctl('clip-a').key, s.pngKey['clip-a']);
}));

/* ================================================================== L4 */

test('L4 acceptMeasuredSnapshot：没指纹 ENV_MISSING；第一帧得锁、写在页面键下、发 layer（页面键）；同页面指纹后续帧照写；别的页面指纹 CARD_LOCKED', async () => withTmp('pc-cl-l4-', async root => {
  const s = await scene(root);
  const a = s.ctl('clip-a');
  const pageKey = s.keyOf('clip-a', PAGE);

  for (const envFingerprint of [undefined, null, '', 'abc', PAGE.toUpperCase(), `${PAGE}0`, PAGE.slice(1), 42]) {
    const r = await s.pipeline.acceptMeasuredSnapshot(s.entry, a, { envFingerprint, localFrame: 0, html: '<p>x</p>' });
    assert.deepEqual(r, { ok: true, stored: false, reason: 'ENV_MISSING' }, `envFingerprint = ${JSON.stringify(envFingerprint)}`);
  }
  assert.equal(s.lockStore().get(a.contentKey), null, '没指纹不建锁');

  s.layers.length = 0;
  const r1 = await s.pipeline.acceptMeasuredSnapshot(s.entry, a, { envFingerprint: PAGE, localFrame: 0, html: '<p>page 0</p>' });
  assert.deepEqual(r1, { ok: true, stored: true, indexed: true, count: 1, envFingerprint: PAGE, key: pageKey });
  assert.equal(await s.store.readSnapshot({ tier: 'shared', key: pageKey, localFrame: 0 }), '<p>page 0</p>', '写在页面键下');
  assert.equal((await s.index('clip-a', OWN)).count, 0, '本机键下没有');
  const lock = s.lockStore().get(a.contentKey);
  assert.deepEqual([lock.envFingerprint, lock.source], [PAGE, 'page'], '页面得锁');
  assert.deepEqual(s.layers, [{ clipId: 'clip-a', snapshotKey: pageKey, tier: 'shared', ranges: [[0, 0]] }], '发一条 layer，键为页面键');
  // plan 跟着换成锁定方的键
  assert.equal(s.ctl('clip-a').snapshotKey, pageKey);
  assert.equal(s.ctl('clip-a').cardLock?.foreign, true);

  const r2 = await s.pipeline.acceptMeasuredSnapshot(s.entry, s.ctl('clip-a'), { envFingerprint: PAGE, localFrame: 1, html: '<p>page 1</p>' });
  assert.deepEqual(r2, { ok: true, stored: true, indexed: true, count: 2, envFingerprint: PAGE, key: pageKey });
  assert.deepEqual(s.layers.at(-1), { clipId: 'clip-a', snapshotKey: pageKey, tier: 'shared', ranges: [[0, 1]] });

  const r3 = await s.pipeline.acceptMeasuredSnapshot(s.entry, s.ctl('clip-a'), { envFingerprint: PAGE2, localFrame: 2, html: '<p>mac</p>' });
  assert.deepEqual(r3, { ok: true, stored: false, reason: 'CARD_LOCKED', lockedBy: PAGE });
  assert.equal((await s.index('clip-a', PAGE2)).count, 0, '别的页面指纹一帧都不写');
  assert.equal(await s.store.readSnapshot({ tier: 'shared', key: s.keyOf('clip-a', PAGE2), localFrame: 2 }), null);
  assert.equal(s.lockStore().get(a.contentKey).envFingerprint, PAGE);

  // 持久化：flush 后新的进程读得回页面的锁
  await s.lockStore().flush();
  const { createCardLockStore } = await loadCardLock();
  const reread = createCardLockStore({ dir: path.join(root, 'controls-lock') });
  await reread.load();
  assert.equal(reread.get(a.contentKey)?.envFingerprint, PAGE);
}));

test('L4 acceptMeasuredSnapshot：同一张卡摆在多个片段上时，入库后内容键相同的每个片段都换成页面键、各发一条 layer（F.8 第 3 条）', async () => withTmp('pc-cl-l4-twin-', async root => {
  const s = await scene(root, { twin: true });
  const pageKey = s.keyOf('clip-a', PAGE);
  s.layers.length = 0;
  const r = await s.pipeline.acceptMeasuredSnapshot(s.entry, s.ctl('clip-a'), { envFingerprint: PAGE, localFrame: 4, html: '<p>page 4</p>' });
  assert.equal(r.stored, true);
  for (const id of ['clip-a', 'clip-a2']) {
    assert.equal(s.ctl(id).snapshotKey, pageKey, `${id} 换成页面键`);
    assert.equal(s.ctl(id).cardLock?.foreign, true);
    const ls = s.layersOf(id);
    assert.equal(ls.length, 1, `${id} 恰好一条 layer：${JSON.stringify(s.layers)}`);
    assert.deepEqual(ls[0], { clipId: id, snapshotKey: pageKey, tier: 'shared', ranges: [[4, 4]] });
  }
  assert.equal(s.layersOf('clip-c').length, 0, '别的卡不发');
}));

test('L4 acceptMeasuredSnapshot：预渲染进程先得锁时页面被拒；页面指纹与本机相同时写在本机键下；超限 OVER_LIMIT；没有内容键 NO_CONTENT_KEY', async () => withTmp('pc-cl-l4-own-', async root => {
  const s = await scene(root);
  const c = s.ctl('clip-c'), a = s.ctl('clip-a');
  s.lockStore().acquire(c.contentKey, OWN, 'prerender');
  const r = await s.pipeline.acceptMeasuredSnapshot(s.entry, c, { envFingerprint: PAGE, localFrame: 0, html: '<p>x</p>' });
  assert.deepEqual(r, { ok: true, stored: false, reason: 'CARD_LOCKED', lockedBy: OWN });
  assert.equal((await s.index('clip-c', PAGE)).count, 0);

  // 页面与预渲染进程同一种环境：同指纹得锁，键就是本机自己的键
  const r2 = await s.pipeline.acceptMeasuredSnapshot(s.entry, c, { envFingerprint: OWN, localFrame: 3, html: '<p>same env</p>' });
  assert.deepEqual(r2, { ok: true, stored: true, indexed: true, count: 1, envFingerprint: OWN, key: s.own('clip-c') });
  assert.equal(s.ctl('clip-c').snapshotKey, s.own('clip-c'), '键不变');
  assert.equal(s.ctl('clip-c').cardLock?.foreign, false);
  assert.equal(await s.store.readSnapshot({ tier: 'shared', key: s.own('clip-c'), localFrame: 3 }), '<p>same env</p>');

  // 超限：什么都没写进 index
  const huge = `<p>${'x'.repeat(2 * 1024 * 1024)}</p>`;
  const r3 = await s.pipeline.acceptMeasuredSnapshot(s.entry, a, { envFingerprint: PAGE, localFrame: 0, html: huge });
  assert.deepEqual(r3, { ok: true, stored: true, indexed: false, reason: 'OVER_LIMIT', envFingerprint: PAGE, key: s.keyOf('clip-a', PAGE) });
  assert.equal((await s.index('clip-a', PAGE)).count, 0);

  // 没有内容键的 control（F.8 第 4 条）：不写、不建锁
  const bare = { ...s.ctl('clip-b') };
  delete bare.contentKey;
  const locksBefore = s.lockStore().list();
  const r4 = await s.pipeline.acceptMeasuredSnapshot(s.entry, bare, { envFingerprint: PAGE, localFrame: 0, html: '<p>bare</p>' });
  assert.deepEqual(r4, { ok: true, stored: false, reason: 'NO_CONTENT_KEY' });
  assert.deepEqual(s.lockStore().list(), locksBefore, '不建锁');
  const bareShared = { ...s.ctl('clip-c'), contentKey: undefined };
  const r5 = await s.pipeline.acceptMeasuredSnapshot(s.entry, bareShared, { envFingerprint: PAGE, localFrame: 5, html: '<p>bare</p>' });
  assert.deepEqual(r5, { ok: true, stored: false, reason: 'NO_CONTENT_KEY' });
  assert.equal(await s.store.readSnapshot({ tier: 'shared', key: s.keyOf('clip-c', PAGE), localFrame: 5 }), null);
}));

/* ================================================================== L5 */

test('L5 页面锁定后：snapshotTargets 不含这张卡；missingSnapshotFrames 不把它的帧算缺，但发出它现有的区间（锁定方的键）', async () => withTmp('pc-cl-l5-', async root => {
  const s = await scene(root, { locks: [{ clipId: 'clip-a', fp: PAGE }], frames: [{ clipId: 'clip-a', fp: PAGE, frames: [0, 1] }] });
  const targets = s.pipeline.snapshotTargets(s.entry);
  assert.ok(targets instanceof Map);
  assert.ok(!targets.has('clip-a'), '被页面锁定的卡没有 target');
  assert.ok(targets.has('clip-c'));
  assert.equal(targets.get('clip-c').key, s.own('clip-c'));

  s.layers.length = 0;
  const missing = await s.pipeline.missingSnapshotFrames(s.entry, { tiers: ['shared'] });
  assert.deepEqual(missing, ALL.map(n => n + 60), '只有 c 缺的全局帧；a 的 2～14 不算缺');
  assert.deepEqual(s.layersOf('clip-a'), [{ clipId: 'clip-a', snapshotKey: s.keyOf('clip-a', PAGE), tier: 'shared', ranges: [[0, 1]] }],
    '发出 a 现有的区间，键为页面键');
  // 锚帧那一趟（限定锚帧）同样不为它要帧
  const anchors = await s.pipeline.missingSnapshotFrames(s.entry, { tiers: ['shared'], restrictTo: [0, 3, 60] });
  assert.deepEqual(anchors, [60], '锚帧那一趟不为被锁的卡要帧');
}));

test('L5 整场景路：锁定中途发生时 snapshotTargets 跟着变；recordSnapshots 不写被锁的卡，给自己的卡写帧前得锁', async () => withTmp('pc-cl-l5-rec-', async root => {
  const s = await scene(root);
  assert.ok(s.pipeline.snapshotTargets(s.entry).has('clip-a'), '没锁时有 target');
  const r = await s.pipeline.acceptMeasuredSnapshot(s.entry, s.ctl('clip-a'), { envFingerprint: PAGE, localFrame: 0, html: '<p>page</p>' });
  assert.equal(r.stored, true);
  assert.ok(!s.pipeline.snapshotTargets(s.entry).has('clip-a'), '页面锁定之后 target 撤掉（缓存跟着锁变）');

  s.pipeline.recordSnapshots(s.entry, [
    { id: 'clip-a', frame: 3, html: '<i>scene a</i>' },
    { id: 'clip-c', frame: 0, html: '<i>scene c</i>' },
  ]);
  await s.pipeline.flushSnapshots(s.entry);
  assert.equal((await s.index('clip-a', OWN)).count, 0, '被锁的卡：本机键下不写');
  assert.deepEqual((await s.index('clip-a', PAGE)).frames, [[0, 0]], '也不替锁定方写');
  assert.deepEqual((await s.index('clip-c', OWN)).frames, [[0, 0]], '自己的卡照写');
  const lc = s.lockStore().get(s.ck['clip-c']);
  assert.deepEqual([lc?.envFingerprint, lc?.source], [OWN, 'prerender'], '写帧前得锁');
}));

/* ================================================================== L6 */

test('L6 页面结果已齐：fillCardControls 不渲 HTML（假 bakery 计数），发的 layer 是页面键；PNG 那一支照旧；自己的卡照常并得锁', async () => withTmp('pc-cl-l6-', async root => {
  const s = await scene(root, {
    locks: [{ clipId: 'clip-a', fp: PAGE, touchedAt: Date.now() - 10 * IDLE_MS }],   // 闲置也一样：齐了就 reuse
    frames: [{ clipId: 'clip-a', fp: PAGE, frames: ALL }],
  });
  const puts = stubPng(s.entry, { complete: false });
  bakeLog.length = 0;
  s.layers.length = 0;
  await s.pipeline.fillCardControls(s.entry, fakeBakery(s), null, s.entry.cardPlan);

  const a = s.ctl('clip-a'), c = s.ctl('clip-c');
  assert.deepEqual(snapshotFramesOf(s, 'clip-a'), [], 'a：一帧 HTML 快照都不渲');
  assert.deepEqual(uniq(bakesOf(s, 'clip-a').flatMap(r => r.targetFrames)), ALL, 'a：PNG 那一支照旧');
  assert.deepEqual(uniq(puts.filter(p => p.key === a.key).map(p => p.frame)), ALL);
  assert.equal((await s.index('clip-a', OWN)).count, 0, '本机键下没写');
  assert.deepEqual((await s.index('clip-a', PAGE)).frames, FULL, '页面的结果不动');
  const aLayers = s.layersOf('clip-a');
  assert.ok(aLayers.length >= 1, '发了 a 的 layer');
  for (const l of aLayers) assert.equal(l.snapshotKey, s.keyOf('clip-a', PAGE), 'a 的 layer 都是页面键');
  assert.deepEqual(aLayers.at(-1).ranges, FULL);
  assert.equal(s.lockStore().get(a.contentKey).envFingerprint, PAGE, '锁不变');
  assert.equal(a.snapshotKey, s.keyOf('clip-a', PAGE));

  // 自己的卡 c：照常渲、得锁、发自己的键
  assert.deepEqual(snapshotFramesOf(s, 'clip-c'), ALL);
  assert.deepEqual((await s.index('clip-c', OWN)).frames, FULL);
  const lc = s.lockStore().get(c.contentKey);
  assert.deepEqual([lc?.envFingerprint, lc?.source], [OWN, 'prerender'], '渲之前得锁');
  assert.ok(s.layers.some(l => l.clipId === 'clip-c' && l.snapshotKey === s.own('clip-c')));
}));

test('L6 补充：页面结果已齐、PNG 也齐：这张卡一次都不进 bakeFrames', async () => withTmp('pc-cl-l6-png-', async root => {
  const s = await scene(root, {
    locks: [{ clipId: 'clip-a', fp: PAGE }],
    frames: [{ clipId: 'clip-a', fp: PAGE, frames: ALL }],
  });
  stubPng(s.entry, { complete: true });
  bakeLog.length = 0;
  s.layers.length = 0;
  await s.pipeline.fillCardControls(s.entry, fakeBakery(s), null, s.entry.cardPlan);
  assert.equal(bakesOf(s, 'clip-a').length, 0);
  assert.ok(s.layers.some(l => l.clipId === 'clip-a' && l.snapshotKey === s.keyOf('clip-a', PAGE)), '照样投递页面的结果');
}));

/* ================================================================== L7 */

test('L7 页面锁闲置且不齐：接手，锁转为本机指纹，control 换回自己的键，先发一条自己键的 layer（换键），之后照常产', async () => withTmp('pc-cl-l7-', async root => {
  const s = await scene(root, {
    locks: [{ clipId: 'clip-a', fp: PAGE, touchedAt: Date.now() - IDLE_MS - 5_000 }],
    frames: [{ clipId: 'clip-a', fp: PAGE, frames: [0, 1] }],
  });
  assert.equal(s.ctl('clip-a').cardLock?.foreign, true);
  stubPng(s.entry, { complete: false });
  bakeLog.length = 0;
  s.layers.length = 0;
  const t0 = Date.now();
  await s.pipeline.fillCardControls(s.entry, fakeBakery(s), null, s.entry.cardPlan);

  const a = s.ctl('clip-a');
  const own = s.own('clip-a');
  const lock = s.lockStore().get(a.contentKey);
  assert.deepEqual([lock.envFingerprint, lock.source], [OWN, 'prerender'], '锁转为本机指纹');
  assert.ok(lock.since >= t0 && lock.touchedAt >= t0, '接手时 since / touchedAt 是此刻');
  assert.equal(a.snapshotKey, own, 'control 换回自己的键');
  assert.equal(a.envFingerprint, OWN);
  assert.deepEqual(a.cardLock, { envFingerprint: OWN, source: 'prerender', foreign: false });

  // 换键：自己键的第一条 layer 是现有区间（此前为空），在任何帧产出之前
  const ownLayers = s.layers.map((l, i) => ({ ...l, i })).filter(l => l.clipId === 'clip-a' && l.snapshotKey === own);
  assert.ok(ownLayers.length >= 2, `至少一条换键 layer 加产出后的 layer，实际 ${JSON.stringify(ownLayers)}`);
  assert.deepEqual(ownLayers[0].ranges, [], '先发一条自己键现有的区间（空）');
  assert.deepEqual(ownLayers.at(-1).ranges, FULL, '之后照常产，整张卡从头渲');
  const lastPageLayer = s.layers.map((l, i) => ({ ...l, i })).filter(l => l.clipId === 'clip-a' && l.snapshotKey === s.keyOf('clip-a', PAGE)).at(-1);
  if (lastPageLayer) assert.ok(lastPageLayer.i < ownLayers[0].i, '换键之后不再发页面键');

  assert.deepEqual(snapshotFramesOf(s, 'clip-a'), ALL, '从头产这张卡');
  assert.deepEqual((await s.index('clip-a', OWN)).frames, FULL);
  assert.deepEqual((await s.index('clip-a', PAGE)).frames, [[0, 1]], '页面的旧帧不动');

  await s.lockStore().flush();
  const saved = JSON.parse(await fs.readFile(path.join(root, 'controls-lock', `${a.contentKey}.json`), 'utf8'));
  assert.deepEqual([saved.envFingerprint, saved.source], [OWN, 'prerender'], '接手落盘');
}));

test('L7 接手时同一内容键的所有片段一起换回自己的键、各发一条自己键的 layer（F.8 第 3 条）', async () => withTmp('pc-cl-l7-twin-', async root => {
  const s = await scene(root, {
    twin: true,
    locks: [{ clipId: 'clip-a', fp: PAGE, touchedAt: Date.now() - IDLE_MS - 5_000 }],
    frames: [{ clipId: 'clip-a', fp: PAGE, frames: [0, 1] }],
  });
  stubPng(s.entry, { complete: false });
  bakeLog.length = 0;
  s.layers.length = 0;
  // 换键发层要在产出任何 HTML 帧之前，两个片段都发：记下第一次渲 HTML 那一刻已经发出的 layer
  const aDir = path.join(root, 'controls', s.pngKey['clip-a']);
  let atFirstHtml = null;
  onBake = async rec => { if (atFirstHtml === null && rec.out === aDir && rec.snapshotFrames.length) atFirstHtml = s.layers.slice(); };
  try {
    await s.pipeline.fillCardControls(s.entry, fakeBakery(s), null, s.entry.cardPlan);
  } finally { onBake = null; }
  const own = s.own('clip-a');
  assert.ok(atFirstHtml, '接手后渲了 HTML');
  for (const id of ['clip-a', 'clip-a2']) {
    assert.ok(atFirstHtml.some(l => l.clipId === id && l.snapshotKey === own && l.ranges.length === 0),
      `${id}：接手时（渲 HTML 之前）就发了自己键的换键 layer；实际 ${JSON.stringify(atFirstHtml)}`);
  }
  for (const id of ['clip-a', 'clip-a2']) {
    assert.equal(s.ctl(id).snapshotKey, own, `${id} 换回自己的键`);
    const ownLayers = s.layersOf(id).filter(l => l.snapshotKey === own);
    assert.ok(ownLayers.length >= 1, `${id} 发了自己键的 layer：${JSON.stringify(s.layers.filter(l => l.clipId.startsWith('clip-a')))}`);
    assert.deepEqual(ownLayers.at(-1).ranges, FULL, `${id} 最后一条是整张卡`);
  }
  // 两个片段共用一份快照：HTML 只产一遍
  assert.deepEqual(uniq(snapshotFramesOf(s, 'clip-a')), ALL);
  assert.equal(snapshotFramesOf(s, 'clip-a').length, N, '同一内容键不重复产 HTML');
}));

/* ================================================================== L8 */

test('L8 页面锁还新鲜且不齐：本趟延后，末尾再判；仍新鲜就跳过，不写任何帧；锁与键不变', async () => withTmp('pc-cl-l8-', async root => {
  const s = await scene(root, {
    locks: [{ clipId: 'clip-a', fp: PAGE, touchedAt: Date.now() }],
    frames: [{ clipId: 'clip-a', fp: PAGE, frames: [0, 1] }],
  });
  const puts = stubPng(s.entry, { complete: false });
  bakeLog.length = 0;
  s.layers.length = 0;
  await s.pipeline.fillCardControls(s.entry, fakeBakery(s), null, s.entry.cardPlan);

  const a = s.ctl('clip-a');
  assert.equal(bakesOf(s, 'clip-a').length, 0, 'a 这一趟跳过：不进 bakeFrames');
  assert.equal(puts.filter(p => p.key === a.key).length, 0, 'a 一帧 PNG 也不写');
  assert.equal((await s.index('clip-a', OWN)).count, 0);
  assert.deepEqual((await s.index('clip-a', PAGE)).frames, [[0, 1]], '不替锁定方产帧');
  assert.equal(s.lockStore().get(a.contentKey).envFingerprint, PAGE, '锁不变');
  assert.equal(a.snapshotKey, s.keyOf('clip-a', PAGE), '键仍是页面键');
  for (const l of s.layersOf('clip-a')) assert.equal(l.snapshotKey, s.keyOf('clip-a', PAGE), 'a 的 layer 只可能是页面键');
  // 其余卡照做
  assert.deepEqual(snapshotFramesOf(s, 'clip-c'), ALL);
  await s.pipeline.close();
}));

test('L8 末尾再判：延后的卡在别的卡渲染期间被页面补齐 → 末尾判成 reuse，发页面键的全量 layer，不渲 HTML', async () => withTmp('pc-cl-l8-rejudge-', async root => {
  const s = await scene(root, {
    locks: [{ clipId: 'clip-a', fp: PAGE, touchedAt: Date.now() }],
    frames: [{ clipId: 'clip-a', fp: PAGE, frames: [0, 1] }],
  });
  stubPng(s.entry, { complete: false });
  const cDir = path.join(root, 'controls', s.pngKey['clip-c']);
  const pageKey = s.keyOf('clip-a', PAGE);
  let cStartedAt = -1;
  onBake = async rec => {
    if (rec.out !== cDir || cStartedAt >= 0) return;
    cStartedAt = s.layers.length;
    // 页面在这期间把剩下的帧推完了
    await s.store.commitSnapshots({ tier: 'shared', key: pageKey, clipId: 'clip-a', capabilities: s.caps['clip-a'],
      items: ALL.slice(2).map(localFrame => ({ localFrame, html: `<p>late ${localFrame}</p>` })) });
  };
  try {
    bakeLog.length = 0;
    s.layers.length = 0;
    await s.pipeline.fillCardControls(s.entry, fakeBakery(s), null, s.entry.cardPlan);
  } finally { onBake = null; }

  const a = s.ctl('clip-a');
  assert.ok(cStartedAt >= 0, 'c 渲过');
  assert.deepEqual(snapshotFramesOf(s, 'clip-a'), [], 'a 不渲 HTML');
  const full = s.layers.map((l, i) => ({ ...l, i })).filter(l => l.clipId === 'clip-a' && l.snapshotKey === pageKey && JSON.stringify(l.ranges) === JSON.stringify(FULL));
  assert.ok(full.length >= 1, `末尾再判后发页面键的全量 layer；实际 a 的 layer：${JSON.stringify(s.layersOf('clip-a'))}`);
  assert.ok(full[0].i >= cStartedAt, '这条 layer 在 c 开始渲之后发出（末尾再判）');
  assert.equal((await s.index('clip-a', OWN)).count, 0);
  assert.equal(s.lockStore().get(a.contentKey).envFingerprint, PAGE);
  await s.pipeline.close();
}));

/* ================================================================== L9（F.8 第 2 条） */

/** 走真的 preload（会话 's'）；借预渲染间、MOV、视频、存档换成桩 */
function stubPreload(s) {
  const bakery = fakeBakery(s);
  let acquires = 0;
  s.pipeline.acquire = async lane => { acquires += 1; assert.equal(lane, 'background'); return bakery; };
  s.pipeline.fillMov = async () => {};
  s.pipeline.prerender = async () => {};
  s.pipeline.save = async () => {};
  return { bakery, acquires: () => acquires };
}
async function preloadOnce(s) {
  // 先把 entry 建出来、PNG 那一支换成桩（当作已齐，只看 HTML 快照）；preload 拿到的是同一个 entry（同一个 entry.key）
  const entry = await s.pipeline.entry(s.project);
  stubPng(entry, { complete: true });
  s.entry = entry;
  assert.equal(await s.pipeline.preload(s.project, { session: 's', localRev: 1 }), entry);
  await s.pipeline.background;
  return entry;
}

test('L9 cardLockIdleMs 给小值：延后的卡在锁闲置后被计时器重判并接手（仍新鲜时再延后），不等下一次 preload', { timeout: 30_000 }, async () => withTmp('pc-cl-l9-', async root => {
  const idle = 300;
  // 锁的 touchedAt 放在 1.2 秒之后：第一趟一定判成 defer，之后几次重判仍新鲜（再延后），约 1.5 秒后闲置、接手
  const s = await scene(root, {
    record: false, options: { cardLockIdleMs: idle },
    locks: [{ clipId: 'clip-a', fp: PAGE, touchedAt: Date.now() + 1_200 }],
    frames: [{ clipId: 'clip-a', fp: PAGE, frames: [0, 1] }],
  });
  const stub = stubPreload(s);
  bakeLog.length = 0;
  try {
    await preloadOnce(s);
    const ck = s.ck['clip-a'];
    assert.equal(s.lockStore().get(ck).envFingerprint, PAGE, '第一趟：仍是页面的锁');
    assert.deepEqual(snapshotFramesOf(s, 'clip-a'), [], '第一趟：a 延后，不渲');
    assert.equal((await s.index('clip-c', OWN)).count, N, '第一趟：c 照常产齐');
    const firstPass = stub.acquires();

    await waitFor('计时器重判后接手 a', () => s.lockStore().get(ck)?.envFingerprint === OWN);
    await s.pipeline.background;
    await waitFor('接手后 a 产齐', async () => (await s.index('clip-a', OWN)).count === N);
    await s.pipeline.background;
    assert.equal(s.lockStore().get(ck).source, 'prerender');
    assert.equal(s.entry.cardPlan.find(c => c.clipId === 'clip-a').snapshotKey, s.own('clip-a'), '换回自己的键');
    assert.deepEqual((await s.index('clip-a', OWN)).frames, FULL);
    assert.ok(stub.acquires() > firstPass, '重判那一小趟借了 background 的预渲染间');
    assert.ok(s.layers.some(l => l.clipId === 'clip-a' && l.snapshotKey === s.own('clip-a') && JSON.stringify(l.ranges) === JSON.stringify(FULL)));
  } finally {
    await s.pipeline.close();
  }
}));

test('L9 重判前页面结果已齐：改为投递（页面键的全量 layer），不接手、不渲 HTML', { timeout: 30_000 }, async () => withTmp('pc-cl-l9-reuse-', async root => {
  const s = await scene(root, {
    record: false, options: { cardLockIdleMs: 200 },
    locks: [{ clipId: 'clip-a', fp: PAGE, touchedAt: Date.now() + 60_000 }],   // 一直新鲜
    frames: [{ clipId: 'clip-a', fp: PAGE, frames: [0, 1] }],
  });
  stubPreload(s);
  bakeLog.length = 0;
  try {
    await preloadOnce(s);
    const ck = s.ck['clip-a'];
    const pageKey = s.keyOf('clip-a', PAGE);
    assert.deepEqual(snapshotFramesOf(s, 'clip-a'), [], '第一趟：a 延后');
    // 页面把剩下的帧推完了（经测量帧入库之外的路也一样：看的是锁定方键下的 index）
    await s.store.commitSnapshots({ tier: 'shared', key: pageKey, clipId: 'clip-a', capabilities: s.caps['clip-a'],
      items: ALL.slice(2).map(localFrame => ({ localFrame, html: `<p>late ${localFrame}</p>` })) });
    await waitFor('重判后投递页面的全量结果', () => s.layers.some(l => l.clipId === 'clip-a' && l.snapshotKey === pageKey && JSON.stringify(l.ranges) === JSON.stringify(FULL)));
    await s.pipeline.background;
    assert.equal(s.lockStore().get(ck).envFingerprint, PAGE, '不接手');
    assert.deepEqual(snapshotFramesOf(s, 'clip-a'), [], '不渲 HTML');
    assert.equal((await s.index('clip-a', OWN)).count, 0);
    assert.equal(s.entry.cardPlan.find(c => c.clipId === 'clip-a').snapshotKey, pageKey);
  } finally {
    await s.pipeline.close();
  }
}));

/* ================================================================== L10（F.8 第 1 条） */

test('L10 本机已齐、没有锁文件的卡：后台那一趟走到它时锁归本机（不渲），此后页面测量帧回 CARD_LOCKED', async () => withTmp('pc-cl-l10-', async root => {
  const s = await scene(root, { frames: [{ clipId: 'clip-a', fp: OWN, frames: ALL }] });
  assert.equal(s.lockStore().get(s.ck['clip-a']), null, '开始时没有锁文件');
  stubPng(s.entry, { complete: true });
  bakeLog.length = 0;
  await s.pipeline.fillCardControls(s.entry, fakeBakery(s), null, s.entry.cardPlan);
  assert.equal(bakesOf(s, 'clip-a').length, 0, '本机已齐：不渲');
  const lock = s.lockStore().get(s.ck['clip-a']);
  assert.deepEqual([lock?.envFingerprint, lock?.source], [OWN, 'prerender'], '锁归本机');

  const r = await s.pipeline.acceptMeasuredSnapshot(s.entry, s.ctl('clip-a'), { envFingerprint: PAGE, localFrame: 0, html: '<p>page</p>' });
  assert.deepEqual(r, { ok: true, stored: false, reason: 'CARD_LOCKED', lockedBy: OWN });
  assert.equal((await s.index('clip-a', PAGE)).count, 0);
  assert.equal(s.ctl('clip-a').snapshotKey, s.own('clip-a'));
  await s.lockStore().flush();
  const saved = JSON.parse(await fs.readFile(path.join(root, 'controls-lock', `${s.ck['clip-a']}.json`), 'utf8'));
  assert.equal(saved.envFingerprint, OWN, '落盘');
}));

test('L10 补充：页面在后台那一趟走到这张卡之前推来测量帧的，仍是页面先得锁', async () => withTmp('pc-cl-l10-page-', async root => {
  const s = await scene(root, { frames: [{ clipId: 'clip-a', fp: OWN, frames: ALL }] });
  const r = await s.pipeline.acceptMeasuredSnapshot(s.entry, s.ctl('clip-a'), { envFingerprint: PAGE, localFrame: 0, html: '<p>page</p>' });
  assert.equal(r.stored, true);
  stubPng(s.entry, { complete: true });
  bakeLog.length = 0;
  await s.pipeline.fillCardControls(s.entry, fakeBakery(s), null, s.entry.cardPlan);
  assert.equal(s.lockStore().get(s.ck['clip-a']).envFingerprint, PAGE, '锁仍是页面的');
  assert.equal(s.ctl('clip-a').snapshotKey, s.keyOf('clip-a', PAGE));
  assert.deepEqual(snapshotFramesOf(s, 'clip-a'), []);
  await s.pipeline.close();
}));

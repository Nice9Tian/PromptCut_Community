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
    openBakery: async () => { throw new Error('Unit test does not open Chrome'); },
    findFfmpeg: async () => 'ffmpeg',
    streamPngVideo: () => { throw new Error('Unit test does not encode'); },
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
  assert.ok(ck['clip-a'] && ck['clip-c'], 'fixture: the plan has two shared-tier cards, a and c');
  assert.ok(plan0.every(c => c.count === N), `fixture: ${N} frames per card`);
  if (twin) assert.equal(ck['clip-a2'], ck['clip-a'], 'fixture: a2 and a have the same content key');
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
  assert.fail(`waited ${timeoutMs} ms and still not satisfied: ${what}`);
}

/* ================================================================== L1 */

test('L1 lock store: acquire obtains the lock, the same fingerprint refreshes, a different fingerprint is rejected; takeover overwrites; get / list; methods are synchronous', async () => withTmp('pc-cl-l1-', async root => {
  const { createCardLockStore, CARD_LOCK_IDLE_MS } = await loadCardLock();
  assert.equal(CARD_LOCK_IDLE_MS, 30_000);
  let t = 1_000_000;
  const store = createCardLockStore({ dir: path.join(root, 'controls-lock'), now: () => t });
  await store.load();   // 目录不存在不算错
  const K1 = sha256('k1'), K2 = sha256('k2');
  assert.equal(store.get(K1), null);

  const r1 = store.acquire(K1, PAGE, 'page');
  assert.ok(!(r1 instanceof Promise), 'acquire is synchronous');
  assert.deepEqual(r1, { granted: true, lock: { envFingerprint: PAGE, source: 'page', since: t, touchedAt: t } });
  assert.deepEqual(store.get(K1), { envFingerprint: PAGE, source: 'page', since: 1_000_000, touchedAt: 1_000_000 });

  t += 500;
  const r2 = store.acquire(K1, PAGE, 'prerender');
  assert.equal(r2.granted, true);
  assert.deepEqual(store.get(K1), { envFingerprint: PAGE, source: 'page', since: 1_000_000, touchedAt: 1_000_500 },
    'the same fingerprint only refreshes touchedAt (since and source unchanged)');

  t += 500;
  const r3 = store.acquire(K1, OWN, 'prerender');
  assert.equal(r3.granted, false);
  assert.equal(r3.lock.envFingerprint, PAGE, 'returns the existing lock');
  assert.deepEqual(store.get(K1), { envFingerprint: PAGE, source: 'page', since: 1_000_000, touchedAt: 1_000_500 }, 'a different fingerprint is rejected: the lock is unchanged');

  t += 500;
  const r4 = store.takeover(K1, OWN, 'prerender');
  assert.ok(!(r4 instanceof Promise), 'takeover is synchronous');
  assert.deepEqual(store.get(K1), { envFingerprint: OWN, source: 'prerender', since: 1_001_500, touchedAt: 1_001_500 }, 'takeover overwrites, since = touchedAt = now');

  store.acquire(K2, PAGE2, 'page');
  assert.deepEqual(store.list(), [
    { contentKey: K1, envFingerprint: OWN, source: 'prerender', since: 1_001_500, touchedAt: 1_001_500 },
    { contentKey: K2, envFingerprint: PAGE2, source: 'page', since: 1_001_500, touchedAt: 1_001_500 },
  ].sort((a, b) => (a.contentKey < b.contentKey ? -1 : 1)), 'list is sorted by contentKey');
}));

test('L1 lock store: after flush it is written to disk (one <contentKey>.json per lock), and a newly created store can read it back with load; of several queued writes, the last one wins', async () => withTmp('pc-cl-l1-disk-', async root => {
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
    { envFingerprint: OWN, source: 'prerender', since: 5_002, touchedAt: 5_003 }, 'the file content is the state of the last write');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, `${K2}.json`), 'utf8')),
    { envFingerprint: PAGE2, source: 'page', since: 5_003, touchedAt: 5_003 });
  const leftovers = (await fs.readdir(dir)).filter(name => !name.endsWith('.json'));
  assert.deepEqual(leftovers, [], 'no temporary files are left after flush');

  const again = createCardLockStore({ dir, now: () => 9_999 });
  assert.equal(again.get(K1), null, 'empty before load');
  await again.load();
  assert.deepEqual(again.list(), store.list(), 'a newly created store can read it back with load');
  assert.deepEqual(again.get(K1), { envFingerprint: OWN, source: 'prerender', since: 5_002, touchedAt: 5_003 });
}));

test('L1 lock store: bad files are skipped; an invalid contentKey or an empty environment fingerprint throws in acquire / takeover (F.8 item 4)', async () => withTmp('pc-cl-l1-bad-', async root => {
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
  assert.deepEqual(store.list(), [{ contentKey: good, envFingerprint: PAGE, source: 'page', since: 1, touchedAt: 2 }], 'bad files are skipped, the rest are read as usual');
  assert.equal(store.get(broken), null);

  for (const bad of ['', 'abc', sha256('x').toUpperCase(), sha256('x').slice(0, 63), `${sha256('x')}0`, `../${sha256('x').slice(3)}`, 'g'.repeat(64), null, undefined, 42]) {
    assert.throws(() => store.acquire(bad, PAGE, 'page'), `acquire(${JSON.stringify(bad)}) should throw`);
    assert.throws(() => store.takeover(bad, PAGE, 'page'), `takeover(${JSON.stringify(bad)}) should throw`);
  }
  const fresh = sha256('fresh');
  for (const fp of ['', null, undefined]) {
    assert.throws(() => store.acquire(fresh, fp, 'page'), `acquire with environment fingerprint ${JSON.stringify(fp)} should throw`);
    assert.throws(() => store.takeover(good, fp, 'page'), `takeover with environment fingerprint ${JSON.stringify(fp)} should throw`);
  }
  assert.equal(store.get(fresh), null, 'a call that throws does not create a lock');
  assert.equal(store.get(good).envFingerprint, PAGE, 'a call that throws does not change the existing lock');
  assert.equal(store.list().length, 1, 'a call that throws does not change the in-memory state');
  await store.flush();
  assert.deepEqual((await fs.readdir(dir)).filter(n => n.endsWith('.json')).sort(), [`${good}.json`, `${broken}.json`, `${empty}.json`].sort(),
    'no file is written for an invalid key');
}));

/* ================================================================== L2 */

test('L2 cardLockDecision: four branches own / reuse / defer / takeover, decided in order; touchedAt exactly idleMs ago counts as idle', async () => {
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
  assert.equal(cardLockDecision({ lock: lock(PAGE, now - CARD_LOCK_IDLE_MS + 1), ownFingerprint: OWN, complete: false, now }), 'defer', 'idleMs - 1 ago');
  // 4. 边界：恰好 idleMs 前 → takeover（`now - touchedAt < idleMs` 才 defer）
  assert.equal(cardLockDecision({ lock: lock(PAGE, now - CARD_LOCK_IDLE_MS), ownFingerprint: OWN, complete: false, now }), 'takeover', 'exactly idleMs');
  assert.equal(cardLockDecision({ lock: lock(PAGE, now - CARD_LOCK_IDLE_MS - 1), ownFingerprint: OWN, complete: false, now }), 'takeover');
  // idleMs 可覆盖
  assert.equal(cardLockDecision({ lock: lock(PAGE, now - 100), ownFingerprint: OWN, complete: false, now, idleMs: 100 }), 'takeover');
  assert.equal(cardLockDecision({ lock: lock(PAGE, now - 99), ownFingerprint: OWN, complete: false, now, idleMs: 100 }), 'defer');
  assert.equal(CARD_LOCK_IDLE_MS, IDLE_MS);
});

/* ================================================================== L3 */

test('L3 applyCardLocks: lock with a different fingerprint → snapshotKey = resultKeyOf(contentKey, lock fingerprint), envFingerprint is the lock fingerprint, cardLock.foreign; key / contentKey unchanged; visible in diagnostics', async () => withTmp('pc-cl-l3-', async root => {
  const s = await scene(root, { locks: [{ clipId: 'clip-a', fp: PAGE }] });
  const before = new CardFrameCache({ root, project: s.project, envFingerprint: OWN }).plan(s.graph);
  const a = s.ctl('clip-a'), c = s.ctl('clip-c'), b = s.ctl('clip-b');
  const a0 = before.find(x => x.clipId === 'clip-a'), c0 = before.find(x => x.clipId === 'clip-c'), b0 = before.find(x => x.clipId === 'clip-b');

  assert.equal(a.snapshotKey, rk(a.contentKey, PAGE), 'recordCardPlan calls applyCardLocks: a is switched to the key of the lock owner');
  assert.match(a.snapshotKey, HEX64);
  assert.equal(a.envFingerprint, PAGE);
  assert.deepEqual(a.cardLock, { envFingerprint: PAGE, source: 'page', foreign: true });
  assert.equal(a.key, a0.key, 'PNG key untouched');
  assert.equal(a.contentKey, a0.contentKey, 'content key untouched');
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
  assert.deepEqual(s.entry.cardPlan, snapshot, 'calling it repeatedly with the same plan gives the same result');

  // 诊断
  const diag = s.pipeline.diagnostics();
  assert.deepEqual(diag.cardLocks, s.lockStore().list(), 'diagnostics().cardLocks = store.list()');
  assert.equal(diag.cardLocks.find(l => l.contentKey === a.contentKey)?.envFingerprint, PAGE);
  const pd = s.pipeline.planDiagnostics().find(p => p.key === s.entry.key);
  assert.deepEqual(pd.controls.find(x => x.clipId === 'clip-a').cardLock, { envFingerprint: PAGE, source: 'page', foreign: true });
  assert.equal(pd.controls.find(x => x.clipId === 'clip-a').snapshotKey, a.snapshotKey);
  assert.equal(pd.controls.find(x => x.clipId === 'clip-c').cardLock, null);
}));

test('L3 applyCardLocks: once the lock is switched back to the fingerprint of this machine, its own key is restored (foreign: false); when the lock is gone, its own key is restored and cardLock is null; clips with the same content key switch together', async () => withTmp('pc-cl-l3-back-', async root => {
  const s = await scene(root, { locks: [{ clipId: 'clip-a', fp: PAGE }], twin: true });
  const own = s.own('clip-a');
  for (const id of ['clip-a', 'clip-a2']) assert.equal(s.ctl(id).snapshotKey, s.keyOf('clip-a', PAGE), `${id} uses the key of the lock owner`);

  s.lockStore().takeover(s.ck['clip-a'], OWN, 'prerender');
  s.pipeline.applyCardLocks(s.entry.cardPlan);
  for (const id of ['clip-a', 'clip-a2']) {
    const x = s.ctl(id);
    assert.equal(x.snapshotKey, own, `${id} switched back to its own key`);
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

test('L4 acceptMeasuredSnapshot: no fingerprint gives ENV_MISSING; the first frame acquires the lock, is written under the page key, and emits a layer (page key); later frames with the same page fingerprint are written as usual; a different page fingerprint gives CARD_LOCKED', async () => withTmp('pc-cl-l4-', async root => {
  const s = await scene(root);
  const a = s.ctl('clip-a');
  const pageKey = s.keyOf('clip-a', PAGE);

  for (const envFingerprint of [undefined, null, '', 'abc', PAGE.toUpperCase(), `${PAGE}0`, PAGE.slice(1), 42]) {
    const r = await s.pipeline.acceptMeasuredSnapshot(s.entry, a, { envFingerprint, localFrame: 0, html: '<p>x</p>' });
    assert.deepEqual(r, { ok: true, stored: false, reason: 'ENV_MISSING' }, `envFingerprint = ${JSON.stringify(envFingerprint)}`);
  }
  assert.equal(s.lockStore().get(a.contentKey), null, 'no fingerprint, no lock is created');

  s.layers.length = 0;
  const r1 = await s.pipeline.acceptMeasuredSnapshot(s.entry, a, { envFingerprint: PAGE, localFrame: 0, html: '<p>page 0</p>' });
  assert.deepEqual(r1, { ok: true, stored: true, indexed: true, count: 1, envFingerprint: PAGE, key: pageKey });
  assert.equal(await s.store.readSnapshot({ tier: 'shared', key: pageKey, localFrame: 0 }), '<p>page 0</p>', 'written under the page key');
  assert.equal((await s.index('clip-a', OWN)).count, 0, 'nothing under the local key');
  const lock = s.lockStore().get(a.contentKey);
  assert.deepEqual([lock.envFingerprint, lock.source], [PAGE, 'page'], 'the page acquires the lock');
  assert.deepEqual(s.layers, [{ clipId: 'clip-a', snapshotKey: pageKey, tier: 'shared', ranges: [[0, 0]] }], 'one layer is emitted, keyed by the page key');
  // plan 跟着换成锁定方的键
  assert.equal(s.ctl('clip-a').snapshotKey, pageKey);
  assert.equal(s.ctl('clip-a').cardLock?.foreign, true);

  const r2 = await s.pipeline.acceptMeasuredSnapshot(s.entry, s.ctl('clip-a'), { envFingerprint: PAGE, localFrame: 1, html: '<p>page 1</p>' });
  assert.deepEqual(r2, { ok: true, stored: true, indexed: true, count: 2, envFingerprint: PAGE, key: pageKey });
  assert.deepEqual(s.layers.at(-1), { clipId: 'clip-a', snapshotKey: pageKey, tier: 'shared', ranges: [[0, 1]] });

  const r3 = await s.pipeline.acceptMeasuredSnapshot(s.entry, s.ctl('clip-a'), { envFingerprint: PAGE2, localFrame: 2, html: '<p>mac</p>' });
  assert.deepEqual(r3, { ok: true, stored: false, reason: 'CARD_LOCKED', lockedBy: PAGE });
  assert.equal((await s.index('clip-a', PAGE2)).count, 0, 'a different page fingerprint writes no frames at all');
  assert.equal(await s.store.readSnapshot({ tier: 'shared', key: s.keyOf('clip-a', PAGE2), localFrame: 2 }), null);
  assert.equal(s.lockStore().get(a.contentKey).envFingerprint, PAGE);

  // 持久化：flush 后新的进程读得回页面的锁
  await s.lockStore().flush();
  const { createCardLockStore } = await loadCardLock();
  const reread = createCardLockStore({ dir: path.join(root, 'controls-lock') });
  await reread.load();
  assert.equal(reread.get(a.contentKey)?.envFingerprint, PAGE);
}));

test('L4 acceptMeasuredSnapshot: when the same card is placed on several clips, after it is stored every clip with the same content key switches to the page key and each emits one layer (F.8 item 3)', async () => withTmp('pc-cl-l4-twin-', async root => {
  const s = await scene(root, { twin: true });
  const pageKey = s.keyOf('clip-a', PAGE);
  s.layers.length = 0;
  const r = await s.pipeline.acceptMeasuredSnapshot(s.entry, s.ctl('clip-a'), { envFingerprint: PAGE, localFrame: 4, html: '<p>page 4</p>' });
  assert.equal(r.stored, true);
  for (const id of ['clip-a', 'clip-a2']) {
    assert.equal(s.ctl(id).snapshotKey, pageKey, `${id} switched to the page key`);
    assert.equal(s.ctl(id).cardLock?.foreign, true);
    const ls = s.layersOf(id);
    assert.equal(ls.length, 1, `${id} has exactly one layer: ${JSON.stringify(s.layers)}`);
    assert.deepEqual(ls[0], { clipId: id, snapshotKey: pageKey, tier: 'shared', ranges: [[4, 4]] });
  }
  assert.equal(s.layersOf('clip-c').length, 0, 'other cards emit none');
}));

test('L4 acceptMeasuredSnapshot: when the prerender process acquires the lock first, the page is rejected; when the page fingerprint is the same as that of this machine, it is written under the local key; over the limit gives OVER_LIMIT; no content key gives NO_CONTENT_KEY', async () => withTmp('pc-cl-l4-own-', async root => {
  const s = await scene(root);
  const c = s.ctl('clip-c'), a = s.ctl('clip-a');
  s.lockStore().acquire(c.contentKey, OWN, 'prerender');
  const r = await s.pipeline.acceptMeasuredSnapshot(s.entry, c, { envFingerprint: PAGE, localFrame: 0, html: '<p>x</p>' });
  assert.deepEqual(r, { ok: true, stored: false, reason: 'CARD_LOCKED', lockedBy: OWN });
  assert.equal((await s.index('clip-c', PAGE)).count, 0);

  // 页面与预渲染进程同一种环境：同指纹得锁，键就是本机自己的键
  const r2 = await s.pipeline.acceptMeasuredSnapshot(s.entry, c, { envFingerprint: OWN, localFrame: 3, html: '<p>same env</p>' });
  assert.deepEqual(r2, { ok: true, stored: true, indexed: true, count: 1, envFingerprint: OWN, key: s.own('clip-c') });
  assert.equal(s.ctl('clip-c').snapshotKey, s.own('clip-c'), 'key unchanged');
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
  assert.deepEqual(s.lockStore().list(), locksBefore, 'no lock is created');
  const bareShared = { ...s.ctl('clip-c'), contentKey: undefined };
  const r5 = await s.pipeline.acceptMeasuredSnapshot(s.entry, bareShared, { envFingerprint: PAGE, localFrame: 5, html: '<p>bare</p>' });
  assert.deepEqual(r5, { ok: true, stored: false, reason: 'NO_CONTENT_KEY' });
  assert.equal(await s.store.readSnapshot({ tier: 'shared', key: s.keyOf('clip-c', PAGE), localFrame: 5 }), null);
}));

/* ================================================================== L5 */

test('L5 after the page locks it: snapshotTargets does not include this card; missingSnapshotFrames does not count its frames as missing, but emits its existing ranges (the key of the lock owner)', async () => withTmp('pc-cl-l5-', async root => {
  const s = await scene(root, { locks: [{ clipId: 'clip-a', fp: PAGE }], frames: [{ clipId: 'clip-a', fp: PAGE, frames: [0, 1] }] });
  const targets = s.pipeline.snapshotTargets(s.entry);
  assert.ok(targets instanceof Map);
  assert.ok(!targets.has('clip-a'), 'a card locked by the page has no target');
  assert.ok(targets.has('clip-c'));
  assert.equal(targets.get('clip-c').key, s.own('clip-c'));

  s.layers.length = 0;
  const missing = await s.pipeline.missingSnapshotFrames(s.entry, { tiers: ['shared'] });
  assert.deepEqual(missing, ALL.map(n => n + 60), 'only the global frames missing for c; frames 2 to 14 of a do not count as missing');
  assert.deepEqual(s.layersOf('clip-a'), [{ clipId: 'clip-a', snapshotKey: s.keyOf('clip-a', PAGE), tier: 'shared', ranges: [[0, 1]] }],
    'emit the existing ranges of a, keyed by the page key');
  // 锚帧那一趟（限定锚帧）同样不为它要帧
  const anchors = await s.pipeline.missingSnapshotFrames(s.entry, { tiers: ['shared'], restrictTo: [0, 3, 60] });
  assert.deepEqual(anchors, [60], 'the anchor frame pass does not request frames for the locked card');
}));

test('L5 whole-scene path: when locking happens midway, snapshotTargets changes accordingly; recordSnapshots does not write locked cards, and acquires the lock before writing frames for its own cards', async () => withTmp('pc-cl-l5-rec-', async root => {
  const s = await scene(root);
  assert.ok(s.pipeline.snapshotTargets(s.entry).has('clip-a'), 'has a target when unlocked');
  const r = await s.pipeline.acceptMeasuredSnapshot(s.entry, s.ctl('clip-a'), { envFingerprint: PAGE, localFrame: 0, html: '<p>page</p>' });
  assert.equal(r.stored, true);
  assert.ok(!s.pipeline.snapshotTargets(s.entry).has('clip-a'), 'the target is withdrawn after the page locks it (the cache follows the lock)');

  s.pipeline.recordSnapshots(s.entry, [
    { id: 'clip-a', frame: 3, html: '<i>scene a</i>' },
    { id: 'clip-c', frame: 0, html: '<i>scene c</i>' },
  ]);
  await s.pipeline.flushSnapshots(s.entry);
  assert.equal((await s.index('clip-a', OWN)).count, 0, 'locked card: nothing is written under the local key');
  assert.deepEqual((await s.index('clip-a', PAGE)).frames, [[0, 0]], 'and nothing is written on behalf of the lock owner either');
  assert.deepEqual((await s.index('clip-c', OWN)).frames, [[0, 0]], 'its own card is written as usual');
  const lc = s.lockStore().get(s.ck['clip-c']);
  assert.deepEqual([lc?.envFingerprint, lc?.source], [OWN, 'prerender'], 'the lock is acquired before writing frames');
}));

/* ================================================================== L6 */

test('L6 page results are already complete: fillCardControls does not render HTML (counted via a fake bakery), the layer it emits uses the page key; the PNG branch is unchanged; its own cards proceed as usual and also acquire the lock', async () => withTmp('pc-cl-l6-', async root => {
  const s = await scene(root, {
    locks: [{ clipId: 'clip-a', fp: PAGE, touchedAt: Date.now() - 10 * IDLE_MS }],   // 闲置也一样：齐了就 reuse
    frames: [{ clipId: 'clip-a', fp: PAGE, frames: ALL }],
  });
  const puts = stubPng(s.entry, { complete: false });
  bakeLog.length = 0;
  s.layers.length = 0;
  await s.pipeline.fillCardControls(s.entry, fakeBakery(s), null, s.entry.cardPlan);

  const a = s.ctl('clip-a'), c = s.ctl('clip-c');
  assert.deepEqual(snapshotFramesOf(s, 'clip-a'), [], 'a: no HTML snapshot frames are rendered');
  assert.deepEqual(uniq(bakesOf(s, 'clip-a').flatMap(r => r.targetFrames)), ALL, 'a: the PNG branch is unchanged');
  assert.deepEqual(uniq(puts.filter(p => p.key === a.key).map(p => p.frame)), ALL);
  assert.equal((await s.index('clip-a', OWN)).count, 0, 'nothing written under the local key');
  assert.deepEqual((await s.index('clip-a', PAGE)).frames, FULL, 'page results untouched');
  const aLayers = s.layersOf('clip-a');
  assert.ok(aLayers.length >= 1, 'a layer for a was emitted');
  for (const l of aLayers) assert.equal(l.snapshotKey, s.keyOf('clip-a', PAGE), 'all layers of a use the page key');
  assert.deepEqual(aLayers.at(-1).ranges, FULL);
  assert.equal(s.lockStore().get(a.contentKey).envFingerprint, PAGE, 'the lock is unchanged');
  assert.equal(a.snapshotKey, s.keyOf('clip-a', PAGE));

  // 自己的卡 c：照常渲、得锁、发自己的键
  assert.deepEqual(snapshotFramesOf(s, 'clip-c'), ALL);
  assert.deepEqual((await s.index('clip-c', OWN)).frames, FULL);
  const lc = s.lockStore().get(c.contentKey);
  assert.deepEqual([lc?.envFingerprint, lc?.source], [OWN, 'prerender'], 'the lock is acquired before rendering');
  assert.ok(s.layers.some(l => l.clipId === 'clip-c' && l.snapshotKey === s.own('clip-c')));
}));

test('L6 addendum: page results complete and PNGs complete too: this card never enters bakeFrames', async () => withTmp('pc-cl-l6-png-', async root => {
  const s = await scene(root, {
    locks: [{ clipId: 'clip-a', fp: PAGE }],
    frames: [{ clipId: 'clip-a', fp: PAGE, frames: ALL }],
  });
  stubPng(s.entry, { complete: true });
  bakeLog.length = 0;
  s.layers.length = 0;
  await s.pipeline.fillCardControls(s.entry, fakeBakery(s), null, s.entry.cardPlan);
  assert.equal(bakesOf(s, 'clip-a').length, 0);
  assert.ok(s.layers.some(l => l.clipId === 'clip-a' && l.snapshotKey === s.keyOf('clip-a', PAGE)), 'the page results are still delivered');
}));

/* ================================================================== L7 */

test('L7 page lock idle and incomplete: take over, the lock switches to the fingerprint of this machine, the control switches back to its own key, first emit a layer under its own key (key switch), then produce as usual', async () => withTmp('pc-cl-l7-', async root => {
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
  assert.deepEqual([lock.envFingerprint, lock.source], [OWN, 'prerender'], 'the lock switches to the fingerprint of this machine');
  assert.ok(lock.since >= t0 && lock.touchedAt >= t0, 'at takeover, since / touchedAt are the current time');
  assert.equal(a.snapshotKey, own, 'the control switches back to its own key');
  assert.equal(a.envFingerprint, OWN);
  assert.deepEqual(a.cardLock, { envFingerprint: OWN, source: 'prerender', foreign: false });

  // 换键：自己键的第一条 layer 是现有区间（此前为空），在任何帧产出之前
  const ownLayers = s.layers.map((l, i) => ({ ...l, i })).filter(l => l.clipId === 'clip-a' && l.snapshotKey === own);
  assert.ok(ownLayers.length >= 2, `at least one key-switch layer plus the layer after production, actual ${JSON.stringify(ownLayers)}`);
  assert.deepEqual(ownLayers[0].ranges, [], 'first emit the existing ranges under its own key (empty)');
  assert.deepEqual(ownLayers.at(-1).ranges, FULL, 'then produce as usual, rendering the whole card from the start');
  const lastPageLayer = s.layers.map((l, i) => ({ ...l, i })).filter(l => l.clipId === 'clip-a' && l.snapshotKey === s.keyOf('clip-a', PAGE)).at(-1);
  if (lastPageLayer) assert.ok(lastPageLayer.i < ownLayers[0].i, 'after the key switch the page key is no longer emitted');

  assert.deepEqual(snapshotFramesOf(s, 'clip-a'), ALL, 'produce this card from the start');
  assert.deepEqual((await s.index('clip-a', OWN)).frames, FULL);
  assert.deepEqual((await s.index('clip-a', PAGE)).frames, [[0, 1]], 'old frames of the page untouched');

  await s.lockStore().flush();
  const saved = JSON.parse(await fs.readFile(path.join(root, 'controls-lock', `${a.contentKey}.json`), 'utf8'));
  assert.deepEqual([saved.envFingerprint, saved.source], [OWN, 'prerender'], 'the takeover is written to disk');
}));

test('L7 at takeover, all clips with the same content key switch back to their own key together, and each emits a layer under its own key (F.8 item 3)', async () => withTmp('pc-cl-l7-twin-', async root => {
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
  assert.ok(atFirstHtml, 'HTML was rendered after the takeover');
  for (const id of ['clip-a', 'clip-a2']) {
    assert.ok(atFirstHtml.some(l => l.clipId === id && l.snapshotKey === own && l.ranges.length === 0),
      `${id}: the key-switch layer under its own key was already emitted at takeover (before rendering HTML); actual ${JSON.stringify(atFirstHtml)}`);
  }
  for (const id of ['clip-a', 'clip-a2']) {
    assert.equal(s.ctl(id).snapshotKey, own, `${id} switched back to its own key`);
    const ownLayers = s.layersOf(id).filter(l => l.snapshotKey === own);
    assert.ok(ownLayers.length >= 1, `${id} emitted a layer under its own key: ${JSON.stringify(s.layers.filter(l => l.clipId.startsWith('clip-a')))}`);
    assert.deepEqual(ownLayers.at(-1).ranges, FULL, `the last layer of ${id} is the whole card`);
  }
  // 两个片段共用一份快照：HTML 只产一遍
  assert.deepEqual(uniq(snapshotFramesOf(s, 'clip-a')), ALL);
  assert.equal(snapshotFramesOf(s, 'clip-a').length, N, 'the same content key does not produce HTML twice');
}));

/* ================================================================== L8 */

test('L8 page lock still fresh and incomplete: deferred on this pass and judged again at the end; if still fresh, skipped without writing any frame; lock and key unchanged', async () => withTmp('pc-cl-l8-', async root => {
  const s = await scene(root, {
    locks: [{ clipId: 'clip-a', fp: PAGE, touchedAt: Date.now() }],
    frames: [{ clipId: 'clip-a', fp: PAGE, frames: [0, 1] }],
  });
  const puts = stubPng(s.entry, { complete: false });
  bakeLog.length = 0;
  s.layers.length = 0;
  await s.pipeline.fillCardControls(s.entry, fakeBakery(s), null, s.entry.cardPlan);

  const a = s.ctl('clip-a');
  assert.equal(bakesOf(s, 'clip-a').length, 0, 'a is skipped on this pass: does not enter bakeFrames');
  assert.equal(puts.filter(p => p.key === a.key).length, 0, 'a writes no PNG frames at all');
  assert.equal((await s.index('clip-a', OWN)).count, 0);
  assert.deepEqual((await s.index('clip-a', PAGE)).frames, [[0, 1]], 'does not produce frames on behalf of the lock owner');
  assert.equal(s.lockStore().get(a.contentKey).envFingerprint, PAGE, 'the lock is unchanged');
  assert.equal(a.snapshotKey, s.keyOf('clip-a', PAGE), 'the key is still the page key');
  for (const l of s.layersOf('clip-a')) assert.equal(l.snapshotKey, s.keyOf('clip-a', PAGE), 'the layers of a can only use the page key');
  // 其余卡照做
  assert.deepEqual(snapshotFramesOf(s, 'clip-c'), ALL);
  await s.pipeline.close();
}));

test('L8 judged again at the end: a deferred card is completed by the page while other cards render → judged as reuse at the end, emits a full layer under the page key, does not render HTML', async () => withTmp('pc-cl-l8-rejudge-', async root => {
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
  assert.ok(cStartedAt >= 0, 'c was rendered');
  assert.deepEqual(snapshotFramesOf(s, 'clip-a'), [], 'a does not render HTML');
  const full = s.layers.map((l, i) => ({ ...l, i })).filter(l => l.clipId === 'clip-a' && l.snapshotKey === pageKey && JSON.stringify(l.ranges) === JSON.stringify(FULL));
  assert.ok(full.length >= 1, `a full layer under the page key is emitted after the final re-judgment; actual layers of a: ${JSON.stringify(s.layersOf('clip-a'))}`);
  assert.ok(full[0].i >= cStartedAt, 'this layer is emitted after c starts rendering (final re-judgment)');
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

test('L9 cardLockIdleMs given a small value: a deferred card is re-judged by a timer once the lock goes idle and is taken over (deferred again while still fresh), without waiting for the next preload', { timeout: 30_000 }, async () => withTmp('pc-cl-l9-', async root => {
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
    assert.equal(s.lockStore().get(ck).envFingerprint, PAGE, 'first pass: still the lock of the page');
    assert.deepEqual(snapshotFramesOf(s, 'clip-a'), [], 'first pass: a is deferred, not rendered');
    assert.equal((await s.index('clip-c', OWN)).count, N, 'first pass: c is fully produced as usual');
    const firstPass = stub.acquires();

    await waitFor('a is taken over after the timer re-judges', () => s.lockStore().get(ck)?.envFingerprint === OWN);
    await s.pipeline.background;
    await waitFor('a is fully produced after the takeover', async () => (await s.index('clip-a', OWN)).count === N);
    await s.pipeline.background;
    assert.equal(s.lockStore().get(ck).source, 'prerender');
    assert.equal(s.entry.cardPlan.find(c => c.clipId === 'clip-a').snapshotKey, s.own('clip-a'), 'switched back to its own key');
    assert.deepEqual((await s.index('clip-a', OWN)).frames, FULL);
    assert.ok(stub.acquires() > firstPass, 'that short re-judgment pass borrowed the prerender slot of background');
    assert.ok(s.layers.some(l => l.clipId === 'clip-a' && l.snapshotKey === s.own('clip-a') && JSON.stringify(l.ranges) === JSON.stringify(FULL)));
  } finally {
    await s.pipeline.close();
  }
}));

test('L9 page results already complete before the re-judgment: switch to delivery (a full layer under the page key), no takeover, no HTML rendering', { timeout: 30_000 }, async () => withTmp('pc-cl-l9-reuse-', async root => {
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
    assert.deepEqual(snapshotFramesOf(s, 'clip-a'), [], 'first pass: a is deferred');
    // 页面把剩下的帧推完了（经测量帧入库之外的路也一样：看的是锁定方键下的 index）
    await s.store.commitSnapshots({ tier: 'shared', key: pageKey, clipId: 'clip-a', capabilities: s.caps['clip-a'],
      items: ALL.slice(2).map(localFrame => ({ localFrame, html: `<p>late ${localFrame}</p>` })) });
    await waitFor('the full page results are delivered after the re-judgment', () => s.layers.some(l => l.clipId === 'clip-a' && l.snapshotKey === pageKey && JSON.stringify(l.ranges) === JSON.stringify(FULL)));
    await s.pipeline.background;
    assert.equal(s.lockStore().get(ck).envFingerprint, PAGE, 'no takeover');
    assert.deepEqual(snapshotFramesOf(s, 'clip-a'), [], 'does not render HTML');
    assert.equal((await s.index('clip-a', OWN)).count, 0);
    assert.equal(s.entry.cardPlan.find(c => c.clipId === 'clip-a').snapshotKey, pageKey);
  } finally {
    await s.pipeline.close();
  }
}));

/* ================================================================== L10（F.8 第 1 条） */

test('L10 card already complete locally with no lock file: when the background pass reaches it, the lock goes to this machine (not rendered), after which page measurement frames are answered with CARD_LOCKED', async () => withTmp('pc-cl-l10-', async root => {
  const s = await scene(root, { frames: [{ clipId: 'clip-a', fp: OWN, frames: ALL }] });
  assert.equal(s.lockStore().get(s.ck['clip-a']), null, 'no lock file at the start');
  stubPng(s.entry, { complete: true });
  bakeLog.length = 0;
  await s.pipeline.fillCardControls(s.entry, fakeBakery(s), null, s.entry.cardPlan);
  assert.equal(bakesOf(s, 'clip-a').length, 0, 'complete locally: not rendered');
  const lock = s.lockStore().get(s.ck['clip-a']);
  assert.deepEqual([lock?.envFingerprint, lock?.source], [OWN, 'prerender'], 'the lock goes to this machine');

  const r = await s.pipeline.acceptMeasuredSnapshot(s.entry, s.ctl('clip-a'), { envFingerprint: PAGE, localFrame: 0, html: '<p>page</p>' });
  assert.deepEqual(r, { ok: true, stored: false, reason: 'CARD_LOCKED', lockedBy: OWN });
  assert.equal((await s.index('clip-a', PAGE)).count, 0);
  assert.equal(s.ctl('clip-a').snapshotKey, s.own('clip-a'));
  await s.lockStore().flush();
  const saved = JSON.parse(await fs.readFile(path.join(root, 'controls-lock', `${s.ck['clip-a']}.json`), 'utf8'));
  assert.equal(saved.envFingerprint, OWN, 'written to disk');
}));

test('L10 addendum: if the page pushes measurement frames before the background pass reaches this card, the page still acquires the lock first', async () => withTmp('pc-cl-l10-page-', async root => {
  const s = await scene(root, { frames: [{ clipId: 'clip-a', fp: OWN, frames: ALL }] });
  const r = await s.pipeline.acceptMeasuredSnapshot(s.entry, s.ctl('clip-a'), { envFingerprint: PAGE, localFrame: 0, html: '<p>page</p>' });
  assert.equal(r.stored, true);
  stubPng(s.entry, { complete: true });
  bakeLog.length = 0;
  await s.pipeline.fillCardControls(s.entry, fakeBakery(s), null, s.entry.cardPlan);
  assert.equal(s.lockStore().get(s.ck['clip-a']).envFingerprint, PAGE, 'the lock still belongs to the page');
  assert.equal(s.ctl('clip-a').snapshotKey, s.keyOf('clip-a', PAGE));
  assert.deepEqual(snapshotFramesOf(s, 'clip-a'), []);
  await s.pipeline.close();
}));

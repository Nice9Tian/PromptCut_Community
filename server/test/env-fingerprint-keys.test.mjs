/**
 * M4:环境指纹进结果键(契约 `docs/plan/render-queue-contract.md` E 节,测试表 E.7 的 F1～F8)。
 * 跑:node --experimental-test-module-mocks --test server/test/env-fingerprint-keys.test.mjs
 *
 * 只照契约 E 节(以及它引用的 B.1、B.4)、设计 `distributed-prerender-queue.md` 2.1 和
 * 语义 `mechanism/rendering.md`「不同环境的结果不混用」写,不看实现。断言以契约为准。
 *
 * 约定:
 *   - `resultKeyOf` 从 `server/render-node/fingerprint.mjs` 引(契约 E.3 要求生产代码也从那里引);
 *     另按契约 B.1 的公式用 `node:crypto` 独立算一遍交叉核对。
 *   - `server/bakery/environment.mjs` 是 M4 新建的模块,在 F7 里按需动态引入,
 *     这样它不存在时只有 F7 失败,不连累别的用例。
 *   - F7 / F8 的假 page 真的执行传给 `evaluate` 的函数:先按 Puppeteer 的做法把函数
 *     源码重建成新函数(所以函数必须自包含),再在一个假的 `document` / WebGL 环境里跑。
 *     这样测试不依赖 evaluate 回值的具体形状(契约没规定),只依赖契约写明的 DOM / WebGL 调用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { describeEnvironment, envFingerprintOf, gpuClassOf, chromeMajorOf, normalizeOs, resultKeyOf } from '../render-node/fingerprint.mjs';
import { CardFrameCache, cardControlPngPath } from '../card-cache.mjs';
import { planStreams, StreamStore } from '../frame-stream.mjs';
import { SnapshotStore, snapshotDir } from '../snapshot-store.mjs';
import { planTaskOf, splitPlan } from '../render-node/split.mjs';
import { FramePipeline } from '../frame-pipeline.mjs';

const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
// 契约 B.1 的两条公式,独立实现
const fpOf = (osName, gpuClass, chromeMajor) => sha256(`${osName}\n${gpuClass}\n${chromeMajor}`).slice(0, 16);
const rkOf = (contentKey, fp) => sha256(`${contentKey}\n${fp}`);
const HEX16 = /^[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;

// 路由正则(`server/vite-plugin-frames.ts` 与 `server/frame-stream.mjs` 里今天的写法;契约 E 节:路由正则不改)
const SNAPSHOT_ROUTE = /^\/snapshot\/(html|local)\/([a-f0-9]{64})(?:\/([a-f0-9]{64}))?\/(\d{1,8})$/;
const CONTROL_ROUTE = /^\/control\/([a-f0-9]{64})\/(\d{1,8})$/;
const STREAM_ROUTE = /^\/stream\/([a-f0-9]{64})\/(manifest|init\/([a-f0-9]{16})|seg\/(\d{1,7}-[a-f0-9]{16}\.m4s))$/;

/* ------------------------------------------------------------------ 真实的探测串 */

const CHROME_138 = 'HeadlessChrome/138.0.7204.49';
const UA_138 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/138.0.7204.49 Safari/537.36';
const GPU = {
  swiftshader: { renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', vendor: 'Google Inc. (Google)' },
  nvidia: { renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)', vendor: 'Google Inc. (NVIDIA)' },
  amd: { renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT (0x000073DF) Direct3D11 vs_5_0 ps_5_0, D3D11)', vendor: 'Google Inc. (AMD)' },
  intel: { renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)', vendor: 'Google Inc. (Intel)' },
  apple: { renderer: 'Apple M2', vendor: 'Apple' },
};

// 两种环境:预渲染进程的 SwiftShader(Windows、Chrome 138),和一台 Mac(Apple GPU、Chrome 139)
const ENV_A = describeEnvironment({ platform: 'win32', ...GPU.swiftshader, chromeVersion: CHROME_138 });
const ENV_B = describeEnvironment({ platform: 'darwin', ...GPU.apple, chromeVersion: 'HeadlessChrome/139.0.7258.5' });
const FP_A = ENV_A.fingerprint;
const FP_B = ENV_B.fingerprint;

/* ------------------------------------------------------------------ 一份 browserPlan */

const PROJECT = {
  id: 'm4-env', fps: 30, width: 1920, height: 1080, duration: 4, style: {}, media: [],
  tracks: [
    { id: 't1', clips: [{ id: 'clip-a', cardId: 'demo-a', start: 0, end: 3, frame: { x: 0, y: 0, w: 640, h: 360 } }] },
    { id: 't2', clips: [{ id: 'clip-c', cardId: 'demo-c', start: 0.5, end: 2 }] },
    { id: 't3', clips: [{ id: 'clip-b', cardId: 'glass', start: 0, end: 1 }] },
  ],
};
const SHARED = { compositing: 'independent', frameMode: 'stateful' };
const LOCAL = { compositing: 'belowDependent', frameMode: 'stateful' };
/** card-cache.mjs 的 plan() 收的 graph(同 card-cache.test.mjs 的形状):两张共享档卡、一张本地档卡 */
const GRAPH = {
  definitions: [],
  nodes: [
    { id: 'n-a', adapter: 'chrome', cardId: 'demo-a', capabilities: { ...SHARED }, inputs: {} },
    { id: 'n-c', adapter: 'chrome', cardId: 'demo-c', capabilities: { ...SHARED }, inputs: {} },
    { id: 'n-b', adapter: 'chrome', cardId: 'glass', capabilities: { ...LOCAL }, inputs: {} },
  ],
  outputs: [
    { nodeId: 'n-a', clipId: 'clip-a', start: 0, end: 3, opacity: 1, frame: { x: 0, y: 0, w: 640, h: 360 } },
    { nodeId: 'n-c', clipId: 'clip-c', start: 0.5, end: 2, opacity: 1 },
    { nodeId: 'n-b', clipId: 'clip-b', start: 0, end: 1, opacity: 1 },
  ],
};
const ENTRY_KEY = sha256('m4-env-entry');   // entry.key 是 64 位十六进制(frameIdentity)
const UNUSED_ROOT = path.join(os.tmpdir(), 'pc-m4-env-unused');   // plan() 不碰盘

const cacheWith = (envFingerprint, root = UNUSED_ROOT, project = PROJECT) => new CardFrameCache({ root, project, envFingerprint });
const planWith = (envFingerprint, graph = GRAPH) => cacheWith(envFingerprint).plan(graph);
const byClip = (plan, clipId) => plan.find(c => c.clipId === clipId);
const entryOf = cardPlan => ({ key: ENTRY_KEY, project: PROJECT, cardPlan });
const withTmp = async (prefix, fn) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try { return await fn(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
};

/* ================================================================== F1 */

test('F1 真实串的指纹提取:SwiftShader / NVIDIA / AMD / Intel / Apple 归类,Chrome 主版本,指纹稳定且三项任一不同就不同', () => {
  assert.equal(gpuClassOf(GPU.swiftshader.renderer, GPU.swiftshader.vendor), 'software', 'SwiftShader 的 ANGLE 串');
  assert.equal(gpuClassOf(GPU.nvidia.renderer, GPU.nvidia.vendor), 'nvidia');
  assert.equal(gpuClassOf(GPU.amd.renderer, GPU.amd.vendor), 'amd');
  assert.equal(gpuClassOf(GPU.intel.renderer, GPU.intel.vendor), 'intel');
  assert.equal(gpuClassOf('Apple M2', ''), 'apple', '`Apple M2` → apple');
  assert.equal(gpuClassOf('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', 'Google Inc. (Apple)'), 'apple');
  // 其它真实形态
  assert.equal(gpuClassOf('ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Ti Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.15.3623)', 'Google Inc. (NVIDIA)'), 'nvidia', 'D3D11 带驱动版本');
  assert.equal(gpuClassOf('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Google Inc. (Intel)'), 'intel');
  assert.equal(gpuClassOf('Google SwiftShader', 'Google Inc.'), 'software');
  assert.equal(gpuClassOf('llvmpipe (LLVM 15.0.7, 256 bits)', 'Mesa'), 'software');
  assert.equal(gpuClassOf('Microsoft Basic Render Driver', 'Microsoft'), 'software');
  assert.equal(gpuClassOf('', ''), 'software', '拿不到 WebGL:两个空串 → software');

  assert.equal(chromeMajorOf(CHROME_138), 138);
  assert.equal(chromeMajorOf(UA_138), 138, '完整 UA 不能取开头 Mozilla/5.0 的 5');
  assert.equal(chromeMajorOf('138.0.7204.49'), 138);
  assert.equal(chromeMajorOf(138), 138);
  assert.equal(chromeMajorOf(''), 0);

  const base = { os: 'windows', gpuClass: 'software', chromeMajor: 138 };
  const fp = envFingerprintOf(base);
  assert.match(fp, HEX16);
  assert.equal(fp, envFingerprintOf({ ...base }), '同输入指纹稳定');
  assert.equal(fp, fpOf('windows', 'software', 138), '与契约 B.1 的公式一致');
  assert.notEqual(fp, envFingerprintOf({ ...base, os: 'linux' }), 'os 不同');
  assert.notEqual(fp, envFingerprintOf({ ...base, gpuClass: 'nvidia' }), 'gpuClass 不同');
  assert.notEqual(fp, envFingerprintOf({ ...base, chromeMajor: 139 }), 'chromeMajor 不同');

  // 从原始探测值一次算齐
  assert.deepEqual(ENV_A, { os: 'windows', gpuClass: 'software', chromeMajor: 138, fingerprint: fpOf('windows', 'software', 138) });
  assert.deepEqual(describeEnvironment({ platform: 'win32', ...GPU.nvidia, chromeVersion: UA_138 }),
    { os: 'windows', gpuClass: 'nvidia', chromeMajor: 138, fingerprint: fpOf('windows', 'nvidia', 138) });
  assert.equal(ENV_B.os, normalizeOs('darwin'));
  assert.equal(ENV_B.gpuClass, 'apple');
  assert.notEqual(FP_A, FP_B);

  // resultKeyOf:64 位十六进制、按公式
  assert.equal(resultKeyOf('content', FP_A), rkOf('content', FP_A));
  assert.match(resultKeyOf('content', FP_A), HEX64);
  assert.notEqual(resultKeyOf('content', FP_A), resultKeyOf('content', FP_B));
});

/* ================================================================== F2 */

test('F2 同一张卡两种环境:同一份 browserPlan、两种指纹 → contentKey 相同而 snapshotKey 与 key 不同,snapshotKey === resultKeyOf(contentKey, fp)', () => {
  const a = byClip(planWith(FP_A), 'clip-a');
  const b = byClip(planWith(FP_B), 'clip-a');
  assert.ok(a && b, 'plan 里有 clip-a');

  // 内容身份只认内容:两种环境下相同
  assert.equal(typeof a.contentKey, 'string');
  assert.equal(a.contentKey, b.contentKey, 'contentKey 与环境无关');
  assert.equal(typeof a.cacheContentKey, 'string');
  assert.equal(a.cacheContentKey, b.cacheContentKey, 'cacheContentKey 与环境无关');

  // 结果键乘上指纹:两种环境下必然不同
  assert.notEqual(a.snapshotKey, b.snapshotKey, 'snapshotKey 按环境隔离');
  assert.notEqual(a.key, b.key, 'PNG 缓存键 key 按环境隔离');

  // 等式
  assert.equal(a.snapshotKey, resultKeyOf(a.contentKey, FP_A));
  assert.equal(b.snapshotKey, resultKeyOf(b.contentKey, FP_B));
  assert.equal(a.key, resultKeyOf(a.cacheContentKey, FP_A));
  assert.equal(b.key, resultKeyOf(b.cacheContentKey, FP_B));
  assert.equal(a.envFingerprint, FP_A);
  assert.equal(b.envFingerprint, FP_B);
});

test('F2 其余细节:每个 control 都成立;costKey 与其余字段不随指纹变;同一指纹两次完全相同;函数形式同字符串形式;64 位十六进制、路由正则仍匹配', () => {
  const planA = planWith(FP_A);
  const planB = planWith(FP_B);
  assert.equal(planA.length, 3);
  assert.deepEqual(planA.map(c => c.clipId), planB.map(c => c.clipId));
  for (let i = 0; i < planA.length; i++) {
    const a = planA[i], b = planB[i];
    const label = a.clipId;
    for (const k of ['contentKey', 'cacheContentKey', 'snapshotKey', 'key']) {
      assert.match(a[k], HEX64, `${label}.${k} 是 64 位十六进制`);
      assert.match(b[k], HEX64, `${label}.${k} 是 64 位十六进制`);
    }
    assert.equal(a.contentKey, b.contentKey, `${label} contentKey`);
    assert.equal(a.cacheContentKey, b.cacheContentKey, `${label} cacheContentKey`);
    assert.notEqual(a.snapshotKey, b.snapshotKey, `${label} snapshotKey`);
    assert.notEqual(a.key, b.key, `${label} key`);
    assert.equal(a.snapshotKey, resultKeyOf(a.contentKey, FP_A), `${label} snapshotKey 等式`);
    assert.equal(a.snapshotKey, rkOf(a.contentKey, FP_A), `${label} snapshotKey 与契约 B.1 公式一致`);
    assert.equal(a.key, resultKeyOf(a.cacheContentKey, FP_A), `${label} key 等式`);
    assert.equal(b.key, rkOf(b.cacheContentKey, FP_B), `${label} key 与契约 B.1 公式一致`);
    assert.notEqual(a.contentKey, a.snapshotKey, `${label} 内容键不是结果键`);
    // costKey 不乘指纹;其余字段不变
    assert.equal(a.costKey, b.costKey, `${label} costKey 不乘指纹`);
    const rest = ({ key, snapshotKey, envFingerprint, ...others }) => others;
    assert.deepEqual(rest(a), rest(b), `${label} 除 key / snapshotKey / envFingerprint 外逐字段相同`);
  }
  // 己二：撤掉每张卡的快照后 tier 恒为 none
  assert.equal(byClip(planA, 'clip-b').tier, 'none');

  // 同一指纹算两次完全相同;函数形式与字符串形式相同
  assert.deepEqual(planWith(FP_A), planA);
  assert.deepEqual(planWith(() => FP_A), planA);

  // 路由正则(契约:结果键仍是 64 位十六进制,路由不改)
  const a = byClip(planA, 'clip-a');
  const local = byClip(planA, 'clip-b');
  assert.match(`/snapshot/html/${a.snapshotKey}/0`, SNAPSHOT_ROUTE);
  assert.match(`/snapshot/local/${ENTRY_KEY}/${local.snapshotKey}/0`, SNAPSHOT_ROUTE);
  assert.match(`/control/${a.key}/0`, CONTROL_ROUTE);
});

/* ================================================================== F3 */

test('F3 没有指纹(undefined、\'\'、函数返回 null)时 plan() 抛出,错误消息含「环境指纹」', () => {
  const noFingerprint = err => err instanceof Error && /环境指纹/.test(err.message);
  const cases = [
    ['不传', new CardFrameCache({ root: UNUSED_ROOT, project: PROJECT })],
    ['undefined', cacheWith(undefined)],
    ["''", cacheWith('')],
    ['() => null', cacheWith(() => null)],
    ['() => undefined', cacheWith(() => undefined)],
    ["() => ''", cacheWith(() => '')],
    ['非字符串 12345', cacheWith(12345)],
    ['函数返回非字符串', cacheWith(() => 12345)],
  ];
  for (const [label, cache] of cases) assert.throws(() => cache.plan(GRAPH), noFingerprint, label);
});

test('F3 指纹在 plan() 开头解析:空 browserPlan 也抛;函数形式每次 plan() 时解析', () => {
  const noFingerprint = err => err instanceof Error && /环境指纹/.test(err.message);
  // 契约 E.3「plan() 开头解析一次;不是非空字符串就抛」—— 与有没有卡无关
  assert.throws(() => cacheWith(undefined).plan({ nodes: [], outputs: [] }), noFingerprint, '空 graph');
  assert.throws(() => cacheWith(() => null).plan(null), noFingerprint, 'browserPlan 为 null');
  // 函数形式:构造时还没有指纹、之后才有(FramePipeline 的 `() => this.envFingerprint`)
  let fp = null;
  const cache = cacheWith(() => fp);
  assert.throws(() => cache.plan(GRAPH), noFingerprint, '指纹还没定');
  fp = FP_A;
  const plan = cache.plan(GRAPH);
  assert.equal(byClip(plan, 'clip-a').envFingerprint, FP_A);
  assert.deepEqual(plan, planWith(FP_A), '定下来之后与直接给字符串相同');
});

/* ================================================================== F4 */

test('F4 流:同一个 entry 两种指纹 → contentKey 相同、streamKey 不同且 = resultKeyOf(contentKey, fp);单卡流与组流;没有指纹返回 []', () => {
  const entry = entryOf(planWith(FP_A));
  for (const budget of [6, 1]) {
    const kind = budget === 1 ? 'group' : 'card';
    const underA = planStreams(entry, { budget, codeVersion: 'cv', envFingerprint: FP_A });
    const underB = planStreams(entry, { budget, codeVersion: 'cv', envFingerprint: FP_B });
    // 夹具里另有一张依赖下层的卡:它判重时有自己的一条流(`kind: below`,排在最后),键同样按环境隔离
    assert.equal(underA.filter((s) => s.kind !== 'below').length, budget === 1 ? 1 : 2, `${kind}:流数`);
    assert.deepEqual(underA.filter((s) => s.kind === 'below').map((s) => s.clipIds.length), underA.some((s) => s.kind === 'below') ? [1] : []);
    assert.equal(underB.length, underA.length);
    for (let i = 0; i < underA.length; i++) {
      const a = underA[i], b = underB[i];
      assert.equal(a.kind, a.kind === 'below' ? b.kind : kind);
      assert.deepEqual(a.clipIds, b.clipIds);
      assert.match(a.contentKey, HEX64);
      assert.equal(a.contentKey, b.contentKey, `${kind} ${a.clipIds}:contentKey 与指纹无关`);
      assert.notEqual(a.streamKey, b.streamKey, `${kind} ${a.clipIds}:streamKey 按环境隔离`);
      assert.equal(a.streamKey, resultKeyOf(a.contentKey, FP_A));
      assert.equal(b.streamKey, resultKeyOf(b.contentKey, FP_B));
      assert.equal(a.envFingerprint, FP_A);
      assert.equal(b.envFingerprint, FP_B);
      assert.match(`/stream/${a.streamKey}/manifest`, STREAM_ROUTE, '流路由正则仍匹配');
    }
  }
  for (const envFingerprint of [undefined, '', null]) {
    assert.deepEqual(planStreams(entry, { codeVersion: 'cv', envFingerprint }), [], `envFingerprint = ${JSON.stringify(envFingerprint)}`);
  }
  assert.deepEqual(planStreams(entry, {}), [], '不传 envFingerprint');
});

test('F4 流:两种环境各自的 plan() 输出(成员的结果键不同)算出的 contentKey 仍相同 —— 成员键取内容键', () => {
  const entryA = entryOf(planWith(FP_A));
  const entryB = entryOf(planWith(FP_B));
  for (const budget of [6, 1]) {
    const specsA = planStreams(entryA, { budget, codeVersion: 'cv', envFingerprint: FP_A });
    const specsB = planStreams(entryB, { budget, codeVersion: 'cv', envFingerprint: FP_B });
    assert.ok(specsA.length > 0);
    assert.deepEqual(specsA.map(s => s.contentKey), specsB.map(s => s.contentKey), `budget ${budget}:contentKey 相同`);
    for (let i = 0; i < specsA.length; i++) {
      assert.notEqual(specsA[i].streamKey, specsB[i].streamKey);
      assert.equal(specsA[i].streamKey, resultKeyOf(specsA[i].contentKey, FP_A));
      assert.equal(specsB[i].streamKey, resultKeyOf(specsB[i].contentKey, FP_B));
    }
    // 也与「同一份 cardPlan 换指纹」一致
    const sameEntry = planStreams(entryA, { budget, codeVersion: 'cv', envFingerprint: FP_B });
    assert.deepEqual(sameEntry.map(s => s.streamKey), specsB.map(s => s.streamKey), `budget ${budget}:只由内容和指纹决定`);
  }
});

/* ================================================================== F5 */

test('F5 落盘隔离:两种环境的共享档、本地档、PNG 缓存、流目录两两不同;一种环境写入的快照另一种读不到', () => withTmp('pc-m4-f5-', async root => {
  const planA = planWith(FP_A), planB = planWith(FP_B);
  const sharedA = byClip(planA, 'clip-a'), sharedB = byClip(planB, 'clip-a');
  const localA = byClip(planA, 'clip-b'), localB = byClip(planB, 'clip-b');
  const [streamA] = planStreams(entryOf(planA), { codeVersion: 'cv', envFingerprint: FP_A });
  const [streamB] = planStreams(entryOf(planB), { codeVersion: 'cv', envFingerprint: FP_B });
  const streams = new StreamStore(path.join(root, 'streams'));

  const dirs = {
    sharedA: snapshotDir(root, { tier: 'shared', key: sharedA.snapshotKey }),
    sharedB: snapshotDir(root, { tier: 'shared', key: sharedB.snapshotKey }),
    localA: snapshotDir(root, { tier: 'local', entryKey: ENTRY_KEY, key: localA.snapshotKey }),
    localB: snapshotDir(root, { tier: 'local', entryKey: ENTRY_KEY, key: localB.snapshotKey }),
    pngA: path.join(root, 'controls', sharedA.key),
    pngB: path.join(root, 'controls', sharedB.key),
    streamA: path.join(root, 'streams', streamA.streamKey),
    streamB: path.join(root, 'streams', streamB.streamKey),
  };
  assert.equal(new Set(Object.values(dirs)).size, 8, `八个目录两两不同:${JSON.stringify(dirs, null, 1)}`);
  assert.equal(streams.dir(streamA.streamKey), dirs.streamA, 'StreamStore 的目录就是 streams/<streamKey>');
  assert.notEqual(cardControlPngPath(root, sharedA.key, 0), cardControlPngPath(root, sharedB.key, 0));

  // 共享档 / 本地档:A 写,B 读不到
  const store = new SnapshotStore(root);
  const put = (ctl, tier, html) => store.commitSnapshots({ tier, entryKey: tier === 'local' ? ENTRY_KEY : undefined, key: ctl.snapshotKey,
    clipId: ctl.clipId, capabilities: ctl.capabilities, items: [{ localFrame: 0, html }] });
  await put(sharedA, 'shared', '<p>A shared</p>');
  await put(localA, 'local', '<p>A local</p>');
  assert.equal(await store.readSnapshot({ tier: 'shared', key: sharedA.snapshotKey, localFrame: 0 }), '<p>A shared</p>');
  assert.equal(await store.readSnapshot({ tier: 'shared', key: sharedB.snapshotKey, localFrame: 0 }), null, 'B 读不到 A 的共享档快照');
  assert.equal((await store.snapshotIndex({ tier: 'shared', key: sharedB.snapshotKey })).count, 0);
  assert.equal(await store.readSnapshot({ tier: 'local', entryKey: ENTRY_KEY, key: localA.snapshotKey, localFrame: 0 }), '<p>A local</p>');
  assert.equal(await store.readSnapshot({ tier: 'local', entryKey: ENTRY_KEY, key: localB.snapshotKey, localFrame: 0 }), null, 'B 读不到 A 的本地档快照');
  assert.equal((await store.snapshotIndex({ tier: 'local', entryKey: ENTRY_KEY, key: localB.snapshotKey })).count, 0);

  // 流:A 存的清单,B 的键读不到;扫盘只挂 A 的键
  await streams.save({ streamKey: streamA.streamKey, kind: 'card', plane: 'local', clipIds: streamA.clipIds, fps: 30, bound: { x: 0, y: 0, w: 2, h: 2 }, tight: null, inits: {},
    segments: { 0: { file: '0-0123456789abcdef.m4s', init: '0123456789abcdef', stride: 1, samples: 15 } } });
  const fresh = new StreamStore(path.join(root, 'streams'));
  assert.equal(await fresh.load(streamB.streamKey), null, 'B 读不到 A 的流');
  assert.equal((await fresh.load(streamA.streamKey))?.streamKey, streamA.streamKey);
  assert.deepEqual((await fresh.scan()).map(s => s.key), [streamA.streamKey]);
}));

test('F5 落盘隔离:独立卡 PNG 缓存按环境隔离,A 环境写的样本 B 环境拿不到', () => withTmp('pc-m4-f5-png-', async root => {
  // 小画幅,和 card-cache.test.mjs 同一个口径(样本 PNG 与画幅一致)
  const project = { fps: 30, width: 16, height: 8, style: {} };
  const graph = { definitions: [], nodes: [{ id: 'card', adapter: 'chrome', cardId: 'demo', capabilities: { compositing: 'independent', need_prerendering: false }, inputs: {} }],
    outputs: [{ nodeId: 'card', clipId: 'clip', start: 1.01, end: 1.2, opacity: 1, frame: { x: 0 } }] };
  const png = new PNG({ width: 16, height: 8 });
  png.data.fill(255);
  const painted = PNG.sync.write(png);
  const cacheA = cacheWith(FP_A, root, project);
  const cacheB = cacheWith(FP_B, root, project);
  try {
    const [ctlA] = cacheA.plan(graph);
    const [ctlB] = cacheB.plan(graph);
    assert.notEqual(ctlA.key, ctlB.key);
    assert.equal(ctlA.cacheContentKey, ctlB.cacheContentKey);
    const frame = ctlA.sampling.firstFrame;
    await cacheA.put(ctlA.key, 0, painted);
    const seenByA = await cacheA.renderState([ctlA], [frame]);
    assert.match(seenByA.frames.clip?.[frame] ?? '', new RegExp(`/api/frames/control/${ctlA.key}/0`), 'A 自己读得到');
    const seenByB = await cacheB.renderState([ctlB], [frame]);
    assert.equal(seenByB.frames.clip, undefined, 'B 读不到 A 的 PNG 样本');
    assert.equal(await cacheB.hasComplete({ ...ctlB, count: 1 }), false);
  } finally { await Promise.all([cacheA.close(), cacheB.close()]); }
}));

/* ================================================================== F6 */

test('F6 splitPlan 喂真实 plan() 输出:共享档 resultKey === snapshotKey、流 resultKey === streamKey、本地档按 E.5;两种指纹的任务 id 不相交', () => {
  const planTask = planTaskOf({ projectId: 'proj-m4', projectRev: 7 });
  const split = fp => {
    const cardPlan = planWith(fp);
    const streams = planStreams(entryOf(cardPlan), { codeVersion: 'cv', envFingerprint: fp });
    const tasks = splitPlan({ planTask, entryKey: ENTRY_KEY, cardPlan, prerenderSet: undefined, streams, envFingerprint: fp, codeVersion: 'cv' });
    return { cardPlan, streams, tasks };
  };
  const A = split(FP_A), B = split(FP_B);
  for (const [fp, { cardPlan, streams, tasks }] of [[FP_A, A], [FP_B, B]]) {
    const shared = tasks.filter(t => t.kind === 'snapshot' && t.tier === 'shared');
    const local = tasks.filter(t => t.kind === 'snapshot' && t.tier === 'local');
    const stream = tasks.filter(t => t.kind === 'stream');
    assert.equal(shared.length, 0, '己二：快照已撤，splitPlan 真实链路不再切出快照细任务');
    assert.equal(local.length, 0, '己二：不再切出本地档快照细任务');
    assert.ok(stream.length >= 2, '流任务');
    for (const t of stream) {
      const spec = streams.find(s => s.topClipId === t.input.clipId);
      assert.ok(spec, `流任务 ${t.id} 找得到它的 spec`);
      assert.equal(t.resultKey, spec.streamKey, '流任务 resultKey === spec.streamKey');
      assert.equal(t.input.contentKey, spec.contentKey, '流任务内容键 = spec.contentKey');
    }
    for (const t of tasks) {
      assert.equal(t.requires.envFingerprint, fp);
      assert.match(t.resultKey, HEX64);
      assert.equal(t.id, `${t.kind}:${t.resultKey}:${t.range.from}-${t.range.to}`);
    }
  }
  const idsA = new Set(A.tasks.map(t => t.id));
  const overlap = B.tasks.map(t => t.id).filter(id => idsA.has(id));
  assert.deepEqual(overlap, [], '两种指纹切出的任务 id 集合不相交');
  // 内容相同:两边的任务按内容键一一对应
  assert.deepEqual(A.tasks.map(t => [t.kind, t.input.contentKey, t.range.from, t.range.to]),
    B.tasks.map(t => [t.kind, t.input.contentKey, t.range.from, t.range.to]));
});

/* ================================================================== F7 / F8 的假 Chrome */

const GL_CONST = { VENDOR: 0x1F00, RENDERER: 0x1F01 };
const DEBUG_INFO = { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 };

/**
 * 假 DOM + WebGL。`contexts`:getContext 肯给哪几种;`debugInfo`:有没有 WEBGL_debug_renderer_info。
 * 有 debugInfo 时 gl.RENDERER / VENDOR 只给打码的串,读到打码串说明没用 UNMASKED_*。
 */
function fakeGpu({ renderer = '', vendor = '', contexts = ['webgl2', 'webgl'], debugInfo = true } = {}) {
  const log = { canvases: 0, contextsTried: [], lost: 0, appended: 0 };
  const gl = {
    ...GL_CONST,
    getExtension(name) {
      if (name === 'WEBGL_debug_renderer_info') return debugInfo ? { ...DEBUG_INFO } : null;
      if (name === 'WEBGL_lose_context') return { loseContext() { log.lost++; }, restoreContext() {} };
      return null;
    },
    getParameter(p) {
      if (debugInfo && p === DEBUG_INFO.UNMASKED_RENDERER_WEBGL) return renderer;
      if (debugInfo && p === DEBUG_INFO.UNMASKED_VENDOR_WEBGL) return vendor;
      if (p === GL_CONST.RENDERER) return debugInfo ? 'WebKit WebGL' : renderer;
      if (p === GL_CONST.VENDOR) return debugInfo ? 'WebKit' : vendor;
      return null;
    },
  };
  const append = () => { log.appended++; };
  const document = {
    createElement(tag) {
      if (String(tag).toLowerCase() !== 'canvas') return { appendChild: append };
      log.canvases++;
      return { width: 300, height: 150, getContext(type) { log.contextsTried.push(type); return contexts.includes(type) ? gl : null; } };
    },
    body: { appendChild: append, append },
    documentElement: { appendChild: append, append },
  };
  return { document, log };
}

/** 按 Puppeteer 的做法把函数源码重建成新函数(闭包变量不可见),在假 DOM 里执行 */
function rebuild(fn) {
  const text = fn.toString();
  const attempts = [`(${text})`, `(function ${text})`, `(async function ${text.replace(/^async\s+/, '')})`];
  for (const source of attempts) {
    try { return new Function(`return ${source}`)(); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  throw new Error(`evaluate 收到的函数无法按源码重建:${text.slice(0, 80)}`);
}

function fakePage(gpu, { evaluate } = {}) {
  const calls = [];
  const page = {
    calls,
    async evaluate(fn, ...args) {
      calls.push(fn);
      if (evaluate) return evaluate(fn, ...args);
      if (typeof fn !== 'function') throw new TypeError('假 page 只收函数');
      const run = rebuild(fn);
      const had = { document: Object.getOwnPropertyDescriptor(globalThis, 'document'), window: Object.getOwnPropertyDescriptor(globalThis, 'window') };
      Object.defineProperty(globalThis, 'document', { value: gpu.document, configurable: true, writable: true });
      Object.defineProperty(globalThis, 'window', { value: { document: gpu.document }, configurable: true, writable: true });
      try { return await run(...args); }
      finally {
        for (const [name, desc] of Object.entries(had)) {
          if (desc) Object.defineProperty(globalThis, name, desc); else delete globalThis[name];
        }
      }
    },
  };
  return page;
}

function fakeBrowser(version = CHROME_138) {
  const browser = { calls: 0, async version() { browser.calls++; return typeof version === 'function' ? version() : version; } };
  return browser;
}

const never = () => new Promise(() => {});
const loadEnvironmentModule = () => import('../bakery/environment.mjs');

/* ================================================================== F7 */

test('F7 probeBrowserEnvironment 正常路径:version() + 自包含函数读 UNMASKED_*,交给 describeEnvironment,detected: true', { timeout: 10000 }, async () => {
  const { probeBrowserEnvironment } = await loadEnvironmentModule();
  const gpu = fakeGpu(GPU.nvidia);
  const browser = fakeBrowser(CHROME_138);
  const page = fakePage(gpu);
  const env = await probeBrowserEnvironment({ browser, page }, { platform: 'linux', timeoutMs: 2000 });
  const expected = describeEnvironment({ platform: 'linux', ...GPU.nvidia, chromeVersion: CHROME_138 });
  assert.equal(env.os, 'linux');
  assert.equal(env.gpuClass, 'nvidia');
  assert.equal(env.chromeMajor, 138);
  assert.equal(env.fingerprint, expected.fingerprint);
  assert.match(env.fingerprint, HEX16);
  assert.equal(env.renderer, GPU.nvidia.renderer, '读的是 UNMASKED_RENDERER_WEBGL,不是打码的 gl.RENDERER');
  assert.equal(env.vendor, GPU.nvidia.vendor);
  assert.equal(env.chromeVersion, CHROME_138);
  assert.equal(env.detected, true);
  // evaluate 收到的是一个函数;canvas 不挂进文档;先试 webgl2;读完释放上下文
  assert.equal(browser.calls, 1);
  assert.ok(page.calls.length >= 1);
  assert.ok(page.calls.every(fn => typeof fn === 'function'), 'evaluate 收到的是函数');
  assert.ok(gpu.log.canvases >= 1, '新建了 canvas');
  assert.equal(gpu.log.appended, 0, 'canvas 不挂进文档');
  assert.equal(gpu.log.contextsTried[0], 'webgl2', '先试 webgl2');
  assert.ok(gpu.log.lost >= 1, '用 WEBGL_lose_context 释放上下文');
});

test('F7 probeBrowserEnvironment:只有 webgl、或没有 debug 扩展时读 gl.RENDERER / VENDOR;SwiftShader 照实归 software 不特判', { timeout: 10000 }, async () => {
  const { probeBrowserEnvironment } = await loadEnvironmentModule();
  // webgl2 拿不到,退到 webgl
  const onlyWebgl = fakeGpu({ ...GPU.intel, contexts: ['webgl'] });
  const env1 = await probeBrowserEnvironment({ browser: fakeBrowser(), page: fakePage(onlyWebgl) }, { platform: 'win32', timeoutMs: 2000 });
  assert.deepEqual(onlyWebgl.log.contextsTried.slice(0, 2), ['webgl2', 'webgl']);
  assert.equal(env1.gpuClass, 'intel');
  assert.equal(env1.renderer, GPU.intel.renderer);
  assert.equal(env1.detected, true);
  // 没有 WEBGL_debug_renderer_info:读 gl.RENDERER / gl.VENDOR
  const masked = fakeGpu({ ...GPU.amd, debugInfo: false });
  const env2 = await probeBrowserEnvironment({ browser: fakeBrowser(), page: fakePage(masked) }, { platform: 'win32', timeoutMs: 2000 });
  assert.equal(env2.renderer, GPU.amd.renderer);
  assert.equal(env2.vendor, GPU.amd.vendor);
  assert.equal(env2.gpuClass, 'amd');
  assert.equal(env2.detected, true);
  // 预渲染用的 Chrome(--disable-gpu + SwiftShader):就是 software
  const swift = fakeGpu(GPU.swiftshader);
  const env3 = await probeBrowserEnvironment({ browser: fakeBrowser(), page: fakePage(swift) }, { platform: 'win32', timeoutMs: 2000 });
  assert.equal(env3.gpuClass, 'software');
  assert.equal(env3.fingerprint, ENV_A.fingerprint);
  assert.equal(env3.detected, true);
});

test('F7 probeBrowserEnvironment:没有 WebGL → 两个空串、software,detected 仍为 true', { timeout: 10000 }, async () => {
  const { probeBrowserEnvironment } = await loadEnvironmentModule();
  const gpu = fakeGpu({ renderer: 'should-not-be-read', vendor: 'x', contexts: [] });
  const env = await probeBrowserEnvironment({ browser: fakeBrowser(), page: fakePage(gpu) }, { platform: 'linux', timeoutMs: 2000 });
  assert.equal(env.renderer, '');
  assert.equal(env.vendor, '');
  assert.equal(env.gpuClass, 'software');
  assert.equal(env.chromeMajor, 138);
  assert.equal(env.detected, true, '拿不到 WebGL 上下文也算探测成功');
  assert.equal(env.fingerprint, describeEnvironment({ platform: 'linux', renderer: '', vendor: '', chromeVersion: CHROME_138 }).fingerprint);
});

test('F7 probeBrowserEnvironment:version() 抛出 / evaluate 抛出 / 超时 → 不抛、缺项按空值、detected: false', { timeout: 15000 }, async () => {
  const { probeBrowserEnvironment } = await loadEnvironmentModule();
  const fpWith = (renderer, vendor, chromeVersion) => describeEnvironment({ platform: 'linux', renderer, vendor, chromeVersion }).fingerprint;

  // version() 抛出:WebGL 那一项照常,Chrome 版本按空值(主版本 0)
  const failingBrowser = { async version() { throw new Error('browser gone'); } };
  const e1 = await probeBrowserEnvironment({ browser: failingBrowser, page: fakePage(fakeGpu(GPU.nvidia)) }, { platform: 'linux', timeoutMs: 2000 });
  assert.equal(e1.detected, false);
  assert.equal(e1.chromeMajor, 0);
  assert.ok(!e1.chromeVersion, 'chromeVersion 按空值');
  assert.equal(e1.gpuClass, 'nvidia');
  assert.equal(e1.fingerprint, fpWith(GPU.nvidia.renderer, GPU.nvidia.vendor, ''));

  // evaluate 抛出:GPU 那一项按空值(→ software),版本照常
  const throwingPage = fakePage(null, { evaluate: async () => { throw new Error('Execution context was destroyed'); } });
  const e2 = await probeBrowserEnvironment({ browser: fakeBrowser(), page: throwingPage }, { platform: 'linux', timeoutMs: 2000 });
  assert.equal(e2.detected, false);
  assert.ok(!e2.renderer && !e2.vendor, 'renderer / vendor 按空值');
  assert.equal(e2.gpuClass, 'software');
  assert.equal(e2.chromeMajor, 138);
  assert.equal(e2.fingerprint, fpWith('', '', CHROME_138));
  assert.equal(typeof throwingPage.calls[0], 'function', 'evaluate 收到的是函数');

  // evaluate 永不返回:过了 timeoutMs 就放弃
  const hangingPage = fakePage(null, { evaluate: never });
  const t0 = Date.now();
  const e3 = await probeBrowserEnvironment({ browser: fakeBrowser(), page: hangingPage }, { platform: 'linux', timeoutMs: 50 });
  assert.ok(Date.now() - t0 < 3000, `超时要及时放弃(用了 ${Date.now() - t0} ms)`);
  assert.equal(e3.detected, false);
  assert.equal(e3.gpuClass, 'software');
  assert.equal(e3.chromeMajor, 138);
  assert.equal(e3.fingerprint, fpWith('', '', CHROME_138));

  // version() 永不返回
  const hangingBrowser = { version: never };
  const t1 = Date.now();
  const e4 = await probeBrowserEnvironment({ browser: hangingBrowser, page: fakePage(fakeGpu(GPU.intel)) }, { platform: 'linux', timeoutMs: 50 });
  assert.ok(Date.now() - t1 < 3000, `超时要及时放弃(用了 ${Date.now() - t1} ms)`);
  assert.equal(e4.detected, false);
  assert.equal(e4.chromeMajor, 0);
  assert.match(e4.fingerprint, HEX16);

  // 两步都失败:照样给出一个指纹,不抛
  const e5 = await probeBrowserEnvironment({ browser: failingBrowser, page: throwingPage }, { platform: 'linux', timeoutMs: 50 });
  assert.equal(e5.detected, false);
  assert.equal(e5.fingerprint, fpWith('', '', ''));
});

/* ================================================================== F8 */

const PIPELINE_PROJECT = { id: 'm4-pipeline', fps: 30, width: 1920, height: 1080, duration: 4, style: {}, media: [], tracks: [] };
const fakeBakery = (gpuStrings = GPU.nvidia, version = CHROME_138) => {
  const browser = fakeBrowser(version);
  const page = fakePage(fakeGpu(gpuStrings));
  return { browser, page, probes: () => browser.calls + page.calls.length };
};

test('F8 FramePipeline:构造时注入 environment 就不探测,cardCache.plan 用它,diagnostics 可见', { timeout: 15000 }, () => withTmp('pc-m4-f8-inject-', async root => {
  const environment = describeEnvironment({ platform: 'linux', ...GPU.nvidia, chromeVersion: 'HeadlessChrome/140.0.1.2' });
  const pipeline = new FramePipeline({ root, origin: () => '', environment });
  assert.deepEqual(pipeline.environment, environment);
  assert.equal(pipeline.envFingerprint, environment.fingerprint);
  const bakery = fakeBakery(GPU.amd);
  const got = await pipeline.ensureEnvironment(bakery);
  assert.equal(bakery.probes(), 0, '注入了就不探测');
  assert.deepEqual(got, environment);
  assert.deepEqual(pipeline.environment, environment);
  assert.deepEqual(pipeline.diagnostics().environment, environment, 'diagnostics().environment 可见');

  const entry = await pipeline.entry(PIPELINE_PROJECT);
  const [control] = entry.cardCache.plan(GRAPH);
  assert.equal(control.envFingerprint, environment.fingerprint, 'entry.cardCache 用注入的指纹');
  assert.equal(control.snapshotKey, resultKeyOf(control.contentKey, environment.fingerprint));
  assert.equal(control.key, resultKeyOf(control.cacheContentKey, environment.fingerprint));
}));

test('F8 FramePipeline.ensureEnvironment:没定之前是 null;并发调用只探测一次;结果终身不变;cardCache 按定下来的指纹出键', { timeout: 15000 }, () => withTmp('pc-m4-f8-probe-', async root => {
  const pipeline = new FramePipeline({ root, origin: () => '' });
  assert.equal(pipeline.environment, null, '没定下来之前是 null');
  assert.equal(pipeline.envFingerprint, null);
  assert.equal(pipeline.diagnostics().environment, null);

  // 指纹还没定:entry 的 cardCache.plan 抛「环境指纹」(E.2 + E.3)
  const entry = await pipeline.entry(PIPELINE_PROJECT);
  assert.throws(() => entry.cardCache.plan(GRAPH), err => /环境指纹/.test(err?.message));

  // 并发三次,只探测一次
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const bakery = fakeBakery(GPU.nvidia, async () => { await gate; return CHROME_138; });
  const pending = [pipeline.ensureEnvironment(bakery), pipeline.ensureEnvironment(bakery), pipeline.ensureEnvironment(bakery)];
  release();
  const results = await Promise.all(pending);
  assert.equal(bakery.browser.calls, 1, 'version() 只调一次');
  assert.equal(bakery.page.calls.length, 1, 'evaluate 只调一次');
  const expected = describeEnvironment({ platform: process.platform, ...GPU.nvidia, chromeVersion: CHROME_138 });
  for (const r of results) assert.equal(r?.fingerprint, expected.fingerprint);
  assert.equal(pipeline.environment.fingerprint, expected.fingerprint);
  assert.equal(pipeline.environment.gpuClass, 'nvidia');
  assert.equal(pipeline.environment.os, normalizeOs(process.platform));
  assert.equal(pipeline.environment.detected, true);
  assert.equal(pipeline.envFingerprint, expected.fingerprint);
  assert.deepEqual(pipeline.diagnostics().environment, pipeline.environment);

  // 同一个 entry 的 cardCache 现在按这个指纹出键(`() => this.envFingerprint` 在 plan() 时解析)
  const [control] = entry.cardCache.plan(GRAPH);
  assert.equal(control.envFingerprint, expected.fingerprint);
  assert.equal(control.snapshotKey, resultKeyOf(control.contentKey, expected.fingerprint));

  // 终身不变:换一个 GPU 的 bakery 再调,不探测,结果不变
  const before = structuredClone(pipeline.environment);
  const other = fakeBakery(GPU.amd, 'HeadlessChrome/150.0.0.0');
  const again = await pipeline.ensureEnvironment(other);
  assert.equal(other.probes(), 0, '定下来之后不再探测');
  assert.deepEqual(again, before);
  assert.deepEqual(pipeline.environment, before);
}));

test('F8 FramePipeline.ensureEnvironment:detected: false 的结果也终身不变', { timeout: 15000 }, () => withTmp('pc-m4-f8-undetected-', async root => {
  const pipeline = new FramePipeline({ root, origin: () => '' });
  const broken = {
    browser: { calls: 0, async version() { broken.browser.calls++; throw new Error('no browser'); } },
    page: fakePage(null, { evaluate: async () => { throw new Error('no page'); } }),
  };
  const first = await pipeline.ensureEnvironment(broken);
  assert.equal(first?.detected, false);
  assert.match(pipeline.envFingerprint ?? '', HEX16, '探测失败也定下一个指纹');
  const fixed = structuredClone(pipeline.environment);
  assert.equal(fixed.detected, false);

  const good = fakeBakery(GPU.nvidia);
  const second = await pipeline.ensureEnvironment(good);
  assert.equal(good.probes(), 0, '失败的结果也定下来了,不再探测(免得同一进程中途换键)');
  assert.deepEqual(second, fixed);
  assert.deepEqual(pipeline.environment, fixed);
  assert.deepEqual(pipeline.diagnostics().environment, fixed);
}));

test('F8 FramePipeline.ensureEnvironment:bakery 缺 browser 或 page 时不探测、不定指纹', { timeout: 15000 }, () => withTmp('pc-m4-f8-partial-', async root => {
  const pipeline = new FramePipeline({ root, origin: () => '' });
  const full = fakeBakery(GPU.intel);
  for (const [label, bakery] of [['只有 page', { page: full.page }], ['只有 browser', { browser: full.browser }], ['null', null], ['undefined', undefined], ['空对象', {}]]) {
    const got = await pipeline.ensureEnvironment(bakery);
    assert.equal(got ?? null, null, `${label}:返回 this.environment(null)`);
    assert.equal(pipeline.environment, null, `${label}:不定下来`);
    assert.equal(pipeline.envFingerprint, null);
  }
  assert.equal(full.probes(), 0, '缺一样就不探测');
  // 真的 bakery 来了才探测
  const env = await pipeline.ensureEnvironment(full);
  assert.equal(full.probes(), 2, 'version() 与 evaluate 各一次');
  assert.equal(env?.gpuClass, 'intel');
  assert.equal(pipeline.environment?.gpuClass, 'intel');
}));

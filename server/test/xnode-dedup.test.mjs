/**
 * 跨节点去重:文档服务重启后,别的节点做完、两档都已在素材服务里的一段,被另一个节点领到时走去重完成
 * (`docs/archive/agent-reports/AGENT-xnode-dedup.md`;语义 `mechanism/document-service.md`「渲染任务队列」:「已经在素材服务里的结果不用重做」;
 * `product/rendering.md`「两档」:渲染节点产出原尺寸后一并生成小尺寸,两档都推送到素材服务)。
 * 跑:node --experimental-test-module-mocks --test server/test/xnode-dedup.test.mjs
 *
 * 场景(M8 E3 放本机,run `m8e3lanM` / `xdA1`):host-a 做完一段,PC 收 `task.done` 按清单把原尺寸拉进本机帧库
 * (`applyResult` 只拉原尺寸与 PNG,不拉小尺寸);局域网主机重启后 PC 领到这一段 —— 本机帧库「覆盖」了整段,却没有小尺寸。
 *
 *   X1  本机覆盖、缺小尺寸,内容库里别的节点写的清单两档齐、块都在:has 回 true(去重),resultFor 回那份清单,一块都不推
 *   X2  同上,但清单里没有小尺寸(产出方没做小尺寸):has 回 false,记 sink.has-miss { reason: 'local-small-missing' }
 *       —— 交给执行器从本机原尺寸补画小尺寸(不重渲原尺寸)
 *   X3  同上,清单两档齐,但素材服务上缺一张小位图:has 回 false,记 sink.has-miss { reason: 'blocks-missing', missing: 1 }
 *   X4  sink.has-miss 的其它原因:清单不在、对不上、不全、取清单出错(诊断;不改行为)
 *   X5  独立渲染主机的管线(没有推送队列)打开小尺寸(`enableSmallTier`):commitSnapshots 之后照样记下这一批的小尺寸,
 *       不进推送队列、不开 Chrome;`PROMPTCUT_SMALL_TIER=0` 仍能关
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const bakeryCalls = [];
const refuse = (name) => (...args) => { bakeryCalls.push(name); void args; throw new Error(`单测不渲染(${name})`); };
mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: {
    openBakery: async (...a) => refuse('openBakery')(...a),
    findFfmpeg: async (...a) => refuse('findFfmpeg')(...a),
    streamPngVideo: refuse('streamPngVideo'),
    bakeFrames: async (...a) => refuse('bakeFrames')(...a),
  },
});

const { createAssetSink, manifestKeyOf } = await import('../artifact-transfer.mjs');
const { FramePipeline } = await import('../frame-pipeline.mjs');
const { describeEnvironment } = await import('../render-node/fingerprint.mjs');
const { SMALL_SUFFIX } = await import('../bakery/small-bitmap.mjs');

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const RESULT_KEY = sha256('rk:xnode-dedup');
const refOf = (from, to) => ({ kind: 'snapshot', tier: 'shared', resultKey: RESULT_KEY, range: { unit: 'localFrame', from, to } });
const htmlOf = (f) => Buffer.from(`<div>frame ${f}</div>`);
const smallOf = (f) => Buffer.from(`RIFF-small-${f}`);

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) { try { await c(); } catch { /* 收拾失败不影响结论 */ } } });

/**
 * PC 的帧库替身:原尺寸按 `write` 写,小尺寸按 `writeSmall` 写(拉来的帧没有小尺寸);`smallTier` 决定管线开没开小尺寸
 * (PC 配了推送队列 = 开)。
 */
function frameLibrary({ smallTier = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-xnode-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const index = { frames: [], oversize: [] };
  return {
    root,
    write(from, to) {
      for (let f = from; f <= to; f++) fs.writeFileSync(path.join(root, `${f}.html`), htmlOf(f));
      index.frames = [[from, to]];
    },
    writeSmall(from, to) { for (let f = from; f <= to; f++) fs.writeFileSync(path.join(root, `${f}${SMALL_SUFFIX}`), smallOf(f)); },
    pipeline: {
      snapshots: () => ({ snapshotIndex: async () => ({ frames: index.frames.map((r) => [...r]), oversize: [] }), dir: () => root }),
      whenSmallSettled: async () => {},
      smallTierEnabled: () => smallTier,
    },
  };
}

/** 素材服务替身(按内容寻址) */
function assetStore() {
  const blocks = new Map();
  const calls = { put: 0, uploaded: 0, has: 0 };
  return {
    blocks, calls,
    preload(bufs) { for (const b of bufs) blocks.set(sha256(b), b); },
    async put(ns, bytes) {
      calls.put += 1;
      const hash = sha256(bytes);
      if (blocks.has(hash)) return { hash, size: bytes.length, uploaded: false };
      calls.uploaded += 1;
      blocks.set(hash, Buffer.from(bytes));
      return { hash, size: bytes.length, uploaded: true };
    },
    async has(ns, hash) { calls.has += 1; return blocks.has(hash); },
  };
}

function contentStore({ failGet = false } = {}) {
  const items = new Map();
  return {
    items,
    async put(kind, key, body) { items.set(`${kind}|${key}`, structuredClone(body)); },
    async get(kind, key) {
      if (failGet) throw Object.assign(new Error('内容库 content.get:连接已断开'), { code: 'disconnected' });
      const body = items.get(`${kind}|${key}`);
      return body ? { body: structuredClone(body) } : null;
    },
  };
}

/** 别的节点(host-a)产出、推送后写进内容库的清单:原尺寸 + (可选)小尺寸 */
function otherNodeManifest(from, to, { small = true } = {}) {
  const frames = [], smalls = [];
  for (let f = from; f <= to; f++) {
    frames.push([f, sha256(htmlOf(f)), htmlOf(f).length]);
    smalls.push([f, sha256(smallOf(f)), smallOf(f).length]);
  }
  return {
    v: 1, kind: 'snapshot', tier: 'shared', resultKey: RESULT_KEY, dirKey: RESULT_KEY, entryKey: null,
    range: { from, to }, canvasHeavy: false, frames, ...(small ? { small: smalls } : {}),
  };
}
const blocksOf = (from, to, { small = true } = {}) => {
  const out = [];
  for (let f = from; f <= to; f++) { out.push(htmlOf(f)); if (small) out.push(smallOf(f)); }
  return out;
};
const missLines = (logs) => logs.filter((l) => l.event === 'sink.has-miss').map((l) => l.fields);

test('X1 本机覆盖、缺小尺寸,内容库里别的节点的清单两档齐、块都在:has 回 true(去重),resultFor 回那份清单,一块都不推', async () => {
  const lib = frameLibrary();
  lib.write(0, 7); // 按清单拉来的原尺寸,没有小尺寸
  const store = assetStore();
  store.preload(blocksOf(0, 7));
  const content = contentStore();
  const manifest = otherNodeManifest(0, 7);
  await content.put('snapshot-manifest', manifestKeyOf(refOf(0, 7)), manifest);
  const logs = [];
  const sink = createAssetSink({ pipeline: lib.pipeline, client: store, content, log: (event, fields) => logs.push({ event, fields }) });
  assert.equal(await sink.has(refOf(0, 7)), true, `应走去重:${JSON.stringify(missLines(logs))}`);
  assert.equal(store.calls.put, 0, '一块都不推');
  const got = await sink.resultFor(refOf(0, 7));
  assert.deepEqual(got, manifest, 'resultFor 回内容库里那份(带小尺寸)清单,不是本机现算的缺小尺寸的那份');
  assert.equal(missLines(logs).length, 0);
});

test('X2 本机覆盖、缺小尺寸,清单里也没有小尺寸:has 回 false,记 sink.has-miss local-small-missing(交给执行器补画小尺寸)', async () => {
  const lib = frameLibrary();
  lib.write(0, 7);
  const store = assetStore();
  store.preload(blocksOf(0, 7, { small: false }));
  const content = contentStore();
  await content.put('snapshot-manifest', manifestKeyOf(refOf(0, 7)), otherNodeManifest(0, 7, { small: false }));
  const logs = [];
  const sink = createAssetSink({ pipeline: lib.pipeline, client: store, content, log: (event, fields) => logs.push({ event, fields }) });
  assert.equal(await sink.has(refOf(0, 7)), false);
  const [line] = missLines(logs);
  assert.equal(line?.reason, 'local-small-missing', JSON.stringify(logs));
  assert.equal(line.covered, true);
  assert.equal(line.manifest, 'no-small', '写明内容库里那份清单为什么也不能用');
});

test('X3 本机覆盖、缺小尺寸,清单两档齐但素材服务上缺一张小位图:has 回 false,记 blocks-missing', async () => {
  const lib = frameLibrary();
  lib.write(0, 7);
  const store = assetStore();
  store.preload(blocksOf(0, 7).filter((b) => !b.equals(smallOf(5))));
  const content = contentStore();
  await content.put('snapshot-manifest', manifestKeyOf(refOf(0, 7)), otherNodeManifest(0, 7));
  const logs = [];
  const sink = createAssetSink({ pipeline: lib.pipeline, client: store, content, log: (event, fields) => logs.push({ event, fields }) });
  assert.equal(await sink.has(refOf(0, 7)), false);
  const [line] = missLines(logs);
  assert.equal(line?.reason, 'blocks-missing', JSON.stringify(logs));
  assert.equal(line.total, 16);
  assert.equal(line.missing, 1);
  assert.equal(line.errors, 0);
});

test('X4 sink.has-miss 的其它原因:清单不在、对不上、不全、取清单出错(本机没有这一段)', async () => {
  const cases = [
    { name: 'manifest-missing', setup: async () => {} },
    { name: 'manifest-mismatch', setup: async (c) => c.put('snapshot-manifest', manifestKeyOf(refOf(0, 7)), { ...otherNodeManifest(0, 7), resultKey: sha256('别的') }), field: /^resultKey:/ },
    { name: 'manifest-incomplete', setup: async (c) => c.put('snapshot-manifest', manifestKeyOf(refOf(0, 7)), { ...otherNodeManifest(0, 7), frames: otherNodeManifest(0, 7).frames.slice(0, 5) }) },
    { name: 'manifest-get-failed', failGet: true, setup: async () => {} },
  ];
  for (const k of cases) {
    const lib = frameLibrary();
    const store = assetStore();
    store.preload(blocksOf(0, 7));
    const content = contentStore({ failGet: k.failGet === true });
    await k.setup(content);
    const logs = [];
    const sink = createAssetSink({ pipeline: lib.pipeline, client: store, content, log: (event, fields) => logs.push({ event, fields }) });
    assert.equal(await sink.has(refOf(0, 7)), false, k.name);
    const [line] = missLines(logs);
    assert.equal(line?.reason, k.name, `${k.name}:${JSON.stringify(logs)}`);
    assert.equal(line.covered, false);
    if (k.field) assert.match(line.field, k.field);
  }
  // 不给内容库
  const lib = frameLibrary();
  const logs = [];
  const sink = createAssetSink({ pipeline: lib.pipeline, client: assetStore(), log: (event, fields) => logs.push({ event, fields }) });
  assert.equal(await sink.has(refOf(0, 7)), false);
  assert.equal(missLines(logs)[0]?.reason, 'no-content');
});

/* ------------------------------------------------------------------ X5 独立渲染主机的管线打开小尺寸 */

const OWN_ENV = describeEnvironment({
  platform: 'win32', renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  vendor: 'Google Inc. (Google)', chromeVersion: 'HeadlessChrome/138.0.7204.49',
});

test('X5 没有推送队列的管线(独立渲染主机)打开小尺寸:commitSnapshots 之后记下这一批的小尺寸,不进推送队列、不开 Chrome', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pc-xnode-host-'));
  const p = new FramePipeline({ root, origin: () => 'http://127.0.0.1:1', environment: OWN_ENV, dataRoot: root, interactive: false });
  cleanups.push(async () => { await p.close(); await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const args = { tier: 'shared', key: 'f'.repeat(64), clipId: 'c1', items: [{ localFrame: 0, html: '<div>0</div>' }, { localFrame: 1, html: '<div>1</div>' }] };
  assert.equal(p.smallTierEnabled(), false, '缺省:没有推送队列就不开');
  await p.snapshots().commitSnapshots(args);
  assert.equal(p.smallPending?.length ?? 0, 0, '没开时不记');
  p.enableSmallTier();
  assert.equal(p.smallTierEnabled(), false, '己二：小尺寸已停产，恒为 false');
  assert.equal(p.pushQueue ?? null, null, '仍没有推送队列');
  const calls = bakeryCalls.length;
  await p.snapshots().commitSnapshots({ ...args, items: [{ localFrame: 2, html: '<div>2</div>' }] });
  assert.equal(p.smallPending?.length ?? 0, 0, '停产后不再记小尺寸');
  assert.equal(p.enqueueSnapshotPush(args), 0, '没有推送队列:不进队');
  assert.equal(bakeryCalls.length, calls, '一次 openBakery 都没有');
  assert.equal(p.scheduleSmallSnapshots({ ...args, adopted: true }), false, '拉来的帧照旧不排');
  p.smallPending = [];
});

/* ------------------------------------------------------------------ X6 整条链:host 做完 → PC 拉原尺寸 → 重启 → PC 领到 */

test('X6 整条链:host 两档做完推上去;PC 按清单拉原尺寸;队列重建(文档服务重启)后只有 PC 在,领到这一段以去重完成、执行器没调', async (t) => {
  const F = await import('./fake-artifact-fixtures.mjs');
  const { createAssetHarness } = await import('./fake-asset-service.mjs');
  const { createAssetClient } = await import('../asset-store/client.mjs');
  const T = await import('../artifact-transfer.mjs');
  const harness = createAssetHarness();
  t.after(() => harness.cleanup());
  const roots = F.makeRoots(FramePipeline, 'pc-xnode-chain-');
  t.after(() => roots.cleanup());
  const svc = await F.startServices(harness, (base) => createAssetClient({ base }));
  t.after(() => svc.cleanup());

  // host-a:没有推送队列、打开小尺寸(修前没有这个开关,小尺寸文件由夹具直接写,模拟它已生成)
  const A = roots.make(await roots.root());
  A.enableSmallTier?.();
  const task = F.snapshotTask({ contentKey: sha256('card-xnode'), from: 0, to: 29 });
  await F.seedSnapshots(A, task, F.range(0, 29));
  const dirA = A.snapshots().dir({ tier: 'shared', key: task.resultKey });
  for (const f of F.range(0, 29)) await fsp.writeFile(path.join(dirA, `${f}${SMALL_SUFFIX}`), smallOf(f));
  const putA = await T.createAssetSink({ pipeline: A, client: svc.client, content: svc.content }).put({ ...F.refOf(task), artifacts: null, meta: F.metaOf(task) });
  assert.equal(putA.complete, true, JSON.stringify(putA).slice(0, 300));
  assert.equal(T.smallFramesOf(putA.result).length, 30, 'host 的清单两档齐');

  // PC:配着推送队列(小尺寸开);收 task.done 按清单拉 —— 只拉原尺寸
  const B = roots.make(await roots.root());
  assert.equal(B.smallTierEnabled(), false, '已退役：小尺寸停产');
  await T.applyResult(B, svc.client, putA.result);
  const dirB = B.snapshots().dir({ tier: 'shared', key: task.resultKey });
  assert.ok(fs.existsSync(path.join(dirB, '0.html')), 'PC 本机有原尺寸');
  assert.ok(!fs.existsSync(path.join(dirB, `0${SMALL_SUFFIX}`)), 'PC 本机没有小尺寸(applyResult 不拉)');

  // 文档服务重启:队列只在内存里,重建为空;发布方重新发布同一段;重启后只有 PC 的节点在
  const { createRenderQueue } = await import('../render-queue/index.mjs');
  const { createLocalNode } = await import('../render-node/local-node.mjs');
  const { createLoopback } = await import('./fake-loopback-transport.mjs');
  const { createFakeExecutor, createTimerClock } = await import('./fake-render-executor.mjs');
  const clock = createTimerClock();
  const lb = createLoopback();
  const queue = createRenderQueue({ now: clock.now, send: lb.queueSend, epoch: 'epoch-after-restart' });
  lb.attach(queue);
  const exec = createFakeExecutor({ clock, planContext: () => { throw new Error('X6 不做 plan'); } });
  const page = lb.connect('conn-page', { userId: 'u1', tenantId: 't1' });
  const inbox = [];
  page.onMessage((m) => inbox.push(m));
  page.send({ type: 'publisher.hello', publisherId: 'page-x6' });
  const { state, version, attempts, ...input } = task;
  void state; void version; void attempts;
  page.send({ type: 'task.publish', tasks: [{ ...input, source: { projectId: 'p1', projectRev: 1 } }] });

  const events = [];
  const logs = [];
  const contentB = await svc.another('node-pc');
  const node = createLocalNode({
    nodeId: 'node-pc',
    node: { profile: 'pc', userId: 'u9', envFingerprint: F.TASK_FP, codeVersions: ['c'], cardSourceVersions: {},
      capabilities: { transcode: true, userCards: true, graphCards: true, memoryMB: 16_000 } },
    endpoint: lb.connect('conn-node-pc', { userId: 'u9', tenantId: 't1' }),
    now: clock.now, random: () => 0.5, isIdle: () => true, maxConcurrent: 1, codeVersion: 'c',
    executor: exec.forNode('node-pc'),
    sink: T.createAssetSink({ pipeline: B, client: svc.client, content: contentB, log: (event, fields) => logs.push({ event, fields }) }),
    onEvent: (e) => events.push(e),
  });
  node.start();
  const done = () => inbox.find((m) => m.type === 'task.done' && m.id === task.id);
  const t0 = Date.now();
  while (!done() && Date.now() - t0 < 15_000) {
    lb.flush(); node.tick(); lb.flush(); queue.tick(); lb.flush();
    await new Promise((resolve) => setTimeout(resolve, 5)); // sink.has 走真网络
    clock.advance(200);
  }
  node.stop();
  lb.flush();
  assert.ok(done(), `收到 task.done:${JSON.stringify(inbox.map((m) => m.type))};节点事件:${JSON.stringify(events).slice(0, 400)}`);
  assert.ok(events.some((e) => e.type === 'dedup' && e.id === task.id),
    `以去重的方式完成:${JSON.stringify(events.map((e) => e.type))};${JSON.stringify(logs.filter((l) => l.event === 'sink.has-miss'))}`);
  // 己二：小尺寸已停产；PC 本机原尺寸已齐走去重完成
  assert.equal((done().result?.frames ?? []).length, 30, 'task.done 带的是 30 帧原尺寸清单');
});

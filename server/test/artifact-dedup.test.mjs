/**
 * 清单进内容库与跨节点去重（契约 `docs/plan/manifest-contract.md` 第 1、3 节，第 6 节用例 U1～U5）。
 * 跑：node --experimental-test-module-mocks --test server/test/artifact-dedup.test.mjs
 *
 * 只照契约写，不看实现。
 *
 * 约定（沿用 C6.2 `artifact-transfer.test.mjs` 的构造办法）：
 *   - 几个临时帧库 A、B、C，各一个真的 `FramePipeline`（注入 `environment`、不探测）；`server/bakery/index.mjs`
 *     整个换成假的（`mock.module`），它的每个函数被调一次就记一笔 —— 「没有渲染」就是这些计数为 0。
 *   - 一个素材服务（memory，端口 0）、一个文档服务（内容库模块，memory，端口 0）；客户端用 C6.2 的
 *     `createAssetClient` 与本阶段的 `createContentClient`（经 M5a 的 `createWsEndpoint`）。
 *   - sink：`createAssetSink({ pipeline, client, content })`；ref 带任务的 `input` 与 `requires`（C6.2 第 11 节第 3 条）。
 *   - 清单的键 `<resultKey>:<from>-<to>`，快照 kind `snapshot-manifest`、流 kind `render-manifest`（契约第 1 节）。
 *   - `resultFor(ref)` 按契约是「本机覆盖的由 collect* 现算、查内容库得到的回记下的清单」，这里一律 `await` 它。
 *
 * 实现模块还不存在时每条用例各自失败、报原因。
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { createAssetHarness } from './fake-asset-service.mjs';

const bakeryCalls = [];
const refuse = (name) => (...args) => { bakeryCalls.push(name); void args; throw new Error(`单测不渲染（${name}）`); };
mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: {
    openBakery: async (...a) => refuse('openBakery')(...a),
    findFfmpeg: async (...a) => refuse('findFfmpeg')(...a),
    streamPngVideo: refuse('streamPngVideo'),
    bakeFrames: async (...a) => refuse('bakeFrames')(...a),
  },
});

const { FramePipeline } = await import('../frame-pipeline.mjs');
const { snapshotDir } = await import('../snapshot-store.mjs');
const F = await import('./fake-artifact-fixtures.mjs');
const { resultKeyOf } = await import('../render-node/fingerprint.mjs');
const {
  sha256, range, wire, snapshotTask, streamTask, dirKeyOf, manifestKey, refOf, metaOf, seedSnapshots, unpack,
  filesOf, writeStreamFixture, makeRoots, producerOf, startServices, TASK_FP,
} = F;

let transfer = null, transferError = null;
try { transfer = await import('../artifact-transfer.mjs'); } catch (err) { transferError = err; }
let clientMod = null, clientError = null;
try { clientMod = await import('../asset-store/client.mjs'); } catch (err) { clientError = err; }
function T() {
  if (transferError) throw new Error(`载不进 server/artifact-transfer.mjs：${transferError.message}`);
  return transfer;
}
function newClient(base) {
  if (clientError) throw new Error(`载不进 server/asset-store/client.mjs：${clientError.message}`);
  return clientMod.createAssetClient({ base });
}

const harness = createAssetHarness();
after(() => harness.cleanup());

/** 每条用例一套：帧库、服务；t.after 收拾 */
async function rig(t) {
  const roots = makeRoots(FramePipeline);
  t.after(() => roots.cleanup());
  const svc = await startServices(harness, newClient);
  t.after(() => svc.cleanup());
  return { roots, svc };
}

/** A 产一段、sink.put（带 content）推上去：回 sink 回的 result */
async function produceAndPut(A, svc, task, frames = range(task.range.from, task.range.to)) {
  await seedSnapshots(A, task, frames);
  const sink = T().createAssetSink({ pipeline: A, client: svc.client, content: svc.content });
  const r = await sink.put({ ...refOf(task), artifacts: null, meta: metaOf(task) });
  assert.equal(r.complete, true, `A 的 sink.put 收全：${JSON.stringify(r).slice(0, 200)}`);
  return r.result;
}

/** 内容库里出现这个键（sink.put 之后写清单；给一点时间，允许实现在回包之后才写完） */
async function manifestOf(content, kind, key, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    const got = await content.get(kind, key);
    if (got || Date.now() - t0 > ms) return got;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/* ------------------------------------------------------------------ U1 */

test('U1 A 的 sink put 一段之后：内容库里有键 <resultKey>:<from>-<to> 的清单，正文等于 result（快照与流）', async (t) => {
  const { roots, svc } = await rig(t);
  const A = roots.make(await roots.root());
  const task = snapshotTask({ contentKey: sha256('card-U1'), from: 60, to: 119 });
  const result = await produceAndPut(A, svc, task);
  assert.equal(manifestKey(task), `${task.resultKey}:60-119`);
  const got = await manifestOf(svc.content, 'snapshot-manifest', manifestKey(task));
  assert.ok(got, `内容库里有 snapshot-manifest ${manifestKey(task)}`);
  assert.deepEqual(got.body, wire(result), '正文就是 sink.put 回的 result');
  assert.deepEqual(got.body, unpack(await T().collectSnapshotResult(A, task)).result, '也就是 C6.2 的 SnapshotResult');
  assert.equal(await svc.content.get('render-manifest', manifestKey(task)), null, '快照清单不进 render-manifest');
  const listed = await svc.content.list('snapshot-manifest', `${task.resultKey}:`);
  assert.deepEqual(listed.items.map((i) => i.key), [manifestKey(task)], '只写了这一段的键，没有整卡一个键');

  // 本地档：键用任务的 resultKey（不是落盘的 dirKey）
  const entryKey = sha256('entry-U1');
  const local = snapshotTask({ tier: 'local', entryKey, contentKey: sha256('card-U1-local'), from: 0, to: 19, clipId: 'clip-l' });
  assert.notEqual(local.resultKey, dirKeyOf(local));
  const localResult = await produceAndPut(A, svc, local);
  const gotLocal = await manifestOf(svc.content, 'snapshot-manifest', manifestKey(local));
  assert.ok(gotLocal, `本地档的清单键是 <resultKey>:<from>-<to>：${manifestKey(local)}`);
  assert.deepEqual(gotLocal.body, wire(localResult));
  assert.equal(await svc.content.get('snapshot-manifest', `${dirKeyOf(local)}:0-19`), null, '不按 dirKey 出键');

  // 流：render-manifest
  const S = roots.make(await roots.root(), { interactive: true });
  const contentKey = sha256('stream-U1');
  const streamKey = resultKeyOf(contentKey, TASK_FP);
  await writeStreamFixture(S.root, { streamKey, segments: [0, 1, 2, 3, 4, 5, 6, 7] });
  const st = streamTask({ streamKey, contentKey, from: 0, to: 7 });
  const ssink = T().createAssetSink({ pipeline: S, client: svc.client, content: svc.content });
  const rs = await ssink.put({ ...refOf(st), artifacts: null, meta: metaOf(st) });
  assert.equal(rs.complete, true);
  const gotStream = await manifestOf(svc.content, 'render-manifest', manifestKey(st));
  assert.ok(gotStream, `内容库里有 render-manifest ${manifestKey(st)}`);
  assert.deepEqual(gotStream.body, wire(rs.result));
  assert.equal(gotStream.body.kind, 'stream');
});

test('U1 写清单失败只记日志，不影响 { complete: true, result }；不给 content 时不写清单（C6.2 行为）', async (t) => {
  const { roots, svc } = await rig(t);
  const A = roots.make(await roots.root());
  const task = snapshotTask({ contentKey: sha256('card-U1b'), from: 0, to: 59 });
  await seedSnapshots(A, task, range(0, 59));
  const broken = {
    put: async () => { throw Object.assign(new Error('docservice down'), { code: 'disconnected' }); },
    get: async () => null,
    list: async () => ({ items: [], truncated: false }),
  };
  const r = await T().createAssetSink({ pipeline: A, client: svc.client, content: broken }).put({ ...refOf(task), artifacts: null, meta: metaOf(task) });
  assert.equal(r.complete, true, '写清单失败不影响完成');
  assert.deepEqual(wire(r.result), unpack(await T().collectSnapshotResult(A, task)).result);
  for (const [n, h] of r.result.frames) assert.ok(await svc.client.has('snap', h), `第 ${n} 帧的块推上去了`);

  const other = snapshotTask({ contentKey: sha256('card-U1c'), from: 0, to: 59 });
  await seedSnapshots(A, other, range(0, 59));
  const r2 = await T().createAssetSink({ pipeline: A, client: svc.client }).put({ ...refOf(other), artifacts: null, meta: metaOf(other) });
  assert.equal(r2.complete, true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await svc.content.get('snapshot-manifest', manifestKey(other)), null, '没给 content：不写清单');
});

/* ------------------------------------------------------------------ U2 */

test('U2 B 本机没有，内容库有清单且块都在：has 为 true，resultFor 回的就是这份清单；B 没有渲染、没有写帧库', async (t) => {
  const { roots, svc } = await rig(t);
  const A = roots.make(await roots.root());
  const rootB = await roots.root();
  const B = roots.make(rootB);
  const task = snapshotTask({ contentKey: sha256('card-U2'), from: 0, to: 59 });
  const result = await produceAndPut(A, svc, task);
  assert.ok(await manifestOf(svc.content, 'snapshot-manifest', manifestKey(task)), '夹具：清单在内容库里');

  const before = bakeryCalls.length;
  const contentB = await svc.another('node-b');
  const sinkB = T().createAssetSink({ pipeline: B, client: svc.client, content: contentB });
  const noContent = T().createAssetSink({ pipeline: B, client: svc.client });
  assert.equal(await noContent.has(refOf(task)), false, '夹具：不给 content 时 B 本机没有 → false');
  assert.equal(await sinkB.has(refOf(task)), true, '清单在、块都在、覆盖整段 → true');
  assert.equal(typeof sinkB.resultFor, 'function', 'sink 提供 resultFor(ref)');
  const got = await sinkB.resultFor(refOf(task));
  assert.deepEqual(wire(got), wire(result), 'resultFor 回的就是内容库里那份清单');
  assert.equal(bakeryCalls.length, before, 'B 没有调任何渲染');
  assert.deepEqual(await filesOf(snapshotDir(rootB, { tier: 'shared', key: task.resultKey })), {}, 'has 只查不拉：B 的帧库没被写');

  // A 自己（本机覆盖）：resultFor 由 collect* 现算
  const sinkA = T().createAssetSink({ pipeline: A, client: svc.client, content: svc.content });
  assert.equal(await sinkA.has(refOf(task)), true);
  assert.deepEqual(wire(await sinkA.resultFor(refOf(task))), unpack(await T().collectSnapshotResult(A, task)).result, '本机覆盖的：collect* 现算');

  // 流也一样：render-manifest + px 里的块
  const S = roots.make(await roots.root(), { interactive: true });
  const contentKey = sha256('stream-U2');
  const streamKey = resultKeyOf(contentKey, TASK_FP);
  await writeStreamFixture(S.root, { streamKey, segments: range(8, 15) });
  const st = streamTask({ streamKey, contentKey, from: 8, to: 15 });
  const rs = await T().createAssetSink({ pipeline: S, client: svc.client, content: svc.content }).put({ ...refOf(st), artifacts: null, meta: metaOf(st) });
  assert.equal(rs.complete, true);
  await manifestOf(svc.content, 'render-manifest', manifestKey(st));
  const BS = roots.make(await roots.root(), { interactive: true });
  producerOf(BS);
  const sinkBS = T().createAssetSink({ pipeline: BS, client: svc.client, content: contentB });
  assert.equal(await sinkBS.has(refOf(st)), true, '流：清单在、块都在 → true');
  assert.deepEqual(wire(await sinkBS.resultFor(refOf(st))), wire(rs.result));
  assert.equal(bakeryCalls.length, before, '流也没有渲染');
});

test('U2 接进本机节点（local-node）：B 认领到这一段，以去重的方式完成，执行器一次都没调', async (t) => {
  const { roots, svc } = await rig(t);
  const A = roots.make(await roots.root());
  const B = roots.make(await roots.root());
  const task = snapshotTask({ contentKey: sha256('card-U2-node'), from: 0, to: 59 });
  await produceAndPut(A, svc, task);
  assert.ok(await manifestOf(svc.content, 'snapshot-manifest', manifestKey(task)));

  const { createRenderQueue } = await import('../render-queue/index.mjs');
  const { createLocalNode } = await import('../render-node/local-node.mjs');
  const { createLoopback } = await import('./fake-loopback-transport.mjs');
  const { createFakeExecutor, createTimerClock } = await import('./fake-render-executor.mjs');
  const clock = createTimerClock();
  const lb = createLoopback();
  const queue = createRenderQueue({ now: clock.now, send: lb.queueSend, epoch: 'epoch-u2' });
  lb.attach(queue);
  const exec = createFakeExecutor({ clock, planContext: () => { throw new Error('U2 不做 plan'); } });

  const page = lb.connect('conn-page', { userId: 'u1', tenantId: 't1' });
  const inbox = [];
  page.onMessage((m) => inbox.push(m));
  page.send({ type: 'publisher.hello', publisherId: 'page-u2' });
  const { state, version, attempts, ...input } = task;
  void state; void version; void attempts;
  page.send({ type: 'task.publish', tasks: [{ ...input, source: { projectId: 'p1', projectRev: 1 } }] });

  const events = [];
  const contentB = await svc.another('node-b');
  const node = createLocalNode({
    nodeId: 'node-b',
    node: { profile: 'pc', userId: 'u9', envFingerprint: TASK_FP, codeVersions: ['c'], cardSourceVersions: {},
      capabilities: { transcode: true, userCards: true, graphCards: true, memoryMB: 16_000 } },
    endpoint: lb.connect('conn-node-b', { userId: 'u9', tenantId: 't1' }),
    now: clock.now, random: () => 0.5, isIdle: () => true, maxConcurrent: 1, codeVersion: 'c',
    executor: exec.forNode('node-b'),
    sink: T().createAssetSink({ pipeline: B, client: svc.client, content: contentB }),
    onEvent: (e) => events.push(e),
  });
  node.start();
  const done = () => inbox.find((m) => m.type === 'task.done' && m.id === task.id);
  const t0 = Date.now();
  while (!done() && Date.now() - t0 < 15_000) {
    lb.flush();
    node.tick();
    lb.flush();
    queue.tick();
    lb.flush();
    await new Promise((resolve) => setTimeout(resolve, 5)); // sink.has 走真网络，给它真时间
    clock.advance(200);
  }
  node.stop();
  lb.flush();
  assert.ok(done(), `页面收到了 task.done：${JSON.stringify(inbox.map((m) => m.type))}；节点事件：${JSON.stringify(events).slice(0, 600)}`);
  assert.equal(exec.calls({ kind: 'render' }).length, 0, 'B 没有调执行器');
  assert.ok(events.some((e) => e.type === 'dedup' && e.id === task.id), `以去重的方式完成：${JSON.stringify(events).slice(0, 400)}`);
  assert.deepEqual(lb.errors().map((e) => String(e?.stack ?? e)), [], '端点处理器没有抛异常');
});

/* ------------------------------------------------------------------ U3 */

test('U3 清单在，但缺一个块（从素材服务删掉）：has 为 false', async (t) => {
  const { roots, svc } = await rig(t);
  const A = roots.make(await roots.root());
  const B = roots.make(await roots.root());
  const task = snapshotTask({ contentKey: sha256('card-U3'), from: 0, to: 59 });
  const result = await produceAndPut(A, svc, task);
  assert.ok(await manifestOf(svc.content, 'snapshot-manifest', manifestKey(task)));
  const sinkB = T().createAssetSink({ pipeline: B, client: svc.client, content: await svc.another('node-b') });
  assert.equal(await sinkB.has(refOf(task)), true, '夹具：删之前是 true');

  const lost = result.frames.find(([n]) => n === 41)[1];
  assert.equal(await svc.srv.stores.snap.remove(lost), true, '夹具：从 snap 删掉第 41 帧的块');
  assert.equal(await svc.client.has('snap', lost), false);
  const sinkB2 = T().createAssetSink({ pipeline: B, client: svc.client, content: await svc.another('node-c') });
  assert.equal(await sinkB2.has(refOf(task)), false, '缺一个块 → false');

  // 流：删一个分段的块
  const S = roots.make(await roots.root(), { interactive: true });
  const contentKey = sha256('stream-U3');
  const streamKey = resultKeyOf(contentKey, TASK_FP);
  await writeStreamFixture(S.root, { streamKey, segments: range(0, 7) });
  const st = streamTask({ streamKey, contentKey, from: 0, to: 7 });
  const rs = await T().createAssetSink({ pipeline: S, client: svc.client, content: svc.content }).put({ ...refOf(st), artifacts: null, meta: metaOf(st) });
  assert.equal(rs.complete, true);
  await manifestOf(svc.content, 'render-manifest', manifestKey(st));
  const BS = roots.make(await roots.root(), { interactive: true });
  producerOf(BS);
  await svc.srv.stores.px.remove(rs.result.segments[5].hash);
  assert.equal(await T().createAssetSink({ pipeline: BS, client: svc.client, content: svc.content }).has(refOf(st)), false, '流缺一个分段的块 → false');
});

/* ------------------------------------------------------------------ U4 */

test('U4 清单只覆盖部分帧（块都在）：has 为 false', async (t) => {
  const { roots, svc } = await rig(t);
  const A = roots.make(await roots.root());
  const B = roots.make(await roots.root());
  const task = snapshotTask({ contentKey: sha256('card-U4'), from: 0, to: 59 });
  // A 只有 0～29：它自己的 sink.put 回 complete: false，不写清单；这里手工把「部分清单」写进内容库
  await seedSnapshots(A, task, range(0, 29));
  const partial = unpack(await T().collectSnapshotResult(A, task));
  assert.equal(partial.result.frames.length, 30, '夹具：清单只有 30 帧');
  await T().pushResult(svc.client, partial.raw, partial.readBlob);
  await svc.content.put('snapshot-manifest', manifestKey(task), partial.result);
  const sinkB = T().createAssetSink({ pipeline: B, client: svc.client, content: svc.content });
  assert.equal(await sinkB.has(refOf(task)), false, '清单没覆盖 30～59 → false');
  // 只问被覆盖的那一段（另一个键）：内容库里没有这个键 → false；本机没有 → false
  assert.equal(await sinkB.has(refOf(snapshotTask({ contentKey: sha256('card-U4'), from: 0, to: 29 }))), false, '键不同就查不到');

  // 清单的 range 说是整段，frames 也列满了，但缺的是中间一帧（帧 17 不在 frames 里）
  const holey = { ...partial.result, frames: [] };
  await seedSnapshots(A, task, range(30, 59));
  const full = unpack(await T().collectSnapshotResult(A, task));
  await T().pushResult(svc.client, full.raw, full.readBlob);
  holey.frames = full.result.frames.filter(([n]) => n !== 17);
  await svc.content.put('snapshot-manifest', manifestKey(task), holey);
  assert.equal(await T().createAssetSink({ pipeline: B, client: svc.client, content: svc.content }).has(refOf(task)), false, '中间缺一帧 → false');
  // 补齐之后 → true（确认上面两个 false 不是别的原因）
  await svc.content.put('snapshot-manifest', manifestKey(task), full.result);
  assert.equal(await T().createAssetSink({ pipeline: B, client: svc.client, content: svc.content }).has(refOf(task)), true, '清单完整 → true');

  // 流：清单缺一个分段号
  const S = roots.make(await roots.root(), { interactive: true });
  const contentKey = sha256('stream-U4');
  const streamKey = resultKeyOf(contentKey, TASK_FP);
  await writeStreamFixture(S.root, { streamKey, segments: [0, 1, 2, 3, 5, 6, 7] });
  const st = streamTask({ streamKey, contentKey, from: 0, to: 7 });
  const sr = unpack(await T().collectStreamResult(S, st));
  await T().pushResult(svc.client, sr.raw, sr.readBlob);
  await svc.content.put('render-manifest', manifestKey(st), sr.result);
  const BS = roots.make(await roots.root(), { interactive: true });
  producerOf(BS);
  assert.equal(await T().createAssetSink({ pipeline: BS, client: svc.client, content: svc.content }).has(refOf(st)), false, '流缺第 4 段 → false');
});

/* ------------------------------------------------------------------ U5 */

test('U5 同一张卡的两段由 A、B 各产一段：内容库里两个键都在、互不覆盖；第三台 C 拉这两段，都能拉全', async (t) => {
  const { roots, svc } = await rig(t);
  const rootA = await roots.root(), rootB = await roots.root(), rootC = await roots.root();
  const A = roots.make(rootA), B = roots.make(rootB), C = roots.make(rootC);
  const contentKey = sha256('card-U5');
  const seg1 = snapshotTask({ contentKey, from: 0, to: 59 });
  const seg2 = snapshotTask({ contentKey, from: 60, to: 119 });
  assert.equal(seg1.resultKey, seg2.resultKey, '同一张卡：同一个 resultKey');

  const contentA = svc.content;
  const contentB = await svc.another('node-b');
  await seedSnapshots(A, seg1, range(0, 59), { tag: 'A' });
  await seedSnapshots(B, seg2, range(60, 119), { tag: 'B' });
  // 两个节点并发推
  const [r1, r2] = await Promise.all([
    T().createAssetSink({ pipeline: A, client: svc.client, content: contentA }).put({ ...refOf(seg1), artifacts: null, meta: metaOf(seg1) }),
    T().createAssetSink({ pipeline: B, client: svc.client, content: contentB }).put({ ...refOf(seg2), artifacts: null, meta: metaOf(seg2) }),
  ]);
  assert.equal(r1.complete, true);
  assert.equal(r2.complete, true);
  const m1 = await manifestOf(svc.content, 'snapshot-manifest', manifestKey(seg1));
  const m2 = await manifestOf(svc.content, 'snapshot-manifest', manifestKey(seg2));
  assert.ok(m1 && m2, `两个键都在：${manifestKey(seg1)}、${manifestKey(seg2)}`);
  assert.deepEqual(m1.body, wire(r1.result), '第一段是 A 写的，没被 B 覆盖');
  assert.deepEqual(m2.body, wire(r2.result), '第二段是 B 写的');
  assert.deepEqual(m1.body.frames.map(([n]) => n), range(0, 59));
  assert.deepEqual(m2.body.frames.map(([n]) => n), range(60, 119));
  const listed = await svc.content.list('snapshot-manifest', `${seg1.resultKey}:`);
  assert.deepEqual(listed.items.map((i) => i.key).sort(), [manifestKey(seg1), manifestKey(seg2)].sort());

  // C：按键查清单、拉两段
  const contentC = await svc.another('node-c');
  const sinkC = T().createAssetSink({ pipeline: C, client: svc.client, content: contentC });
  for (const seg of [seg1, seg2]) assert.equal(await sinkC.has(refOf(seg)), true, `C 查得到 ${manifestKey(seg)} 且块都在`);
  for (const seg of [seg1, seg2]) {
    const got = await contentC.get('snapshot-manifest', manifestKey(seg));
    const out = await T().applyResult(C, svc.client, got.body);
    assert.equal(out.fetched, 60, `${manifestKey(seg)}：拉了 60 个块`);
  }
  const dirOf = (root) => snapshotDir(root, { tier: 'shared', key: seg1.resultKey });
  const fa = await filesOf(dirOf(rootA)), fb = await filesOf(dirOf(rootB)), fc = await filesOf(dirOf(rootC));
  for (const n of range(0, 59)) assert.ok(fc[`${n}.html`]?.equals(fa[`${n}.html`]), `C 的第 ${n} 帧与 A 相同`);
  for (const n of range(60, 119)) assert.ok(fc[`${n}.html`]?.equals(fb[`${n}.html`]), `C 的第 ${n} 帧与 B 相同`);
  const idx = await C.snapshots().snapshotIndex({ tier: 'shared', key: seg1.resultKey });
  assert.deepEqual(idx.frames, [[0, 119]], 'C 拉全了两段');
  // 拉完之后 C 本机就覆盖了
  const plain = T().createAssetSink({ pipeline: C, client: svc.client });
  for (const seg of [seg1, seg2]) assert.equal(await plain.has(refOf(seg)), true);
});

/**
 * 无条件推送（契约 `docs/plan/manifest-contract.md` 第 4 节，第 6 节用例 W1～W6）。
 * 跑：node --experimental-test-module-mocks --test server/test/artifact-push.test.mjs
 *
 * 只照契约写，不看实现。
 *
 * 约定：
 *   - 一个临时帧库、一个真的 `FramePipeline`（注入 `environment`、不探测；`bakery/index.mjs` 换成假的，不起 Chrome）；
 *     素材服务（memory，端口 0）与文档服务（内容库，memory，端口 0）同 `artifact-dedup.test.mjs`。
 *   - 推送队列：`createPushQueue({ pipeline, client, content, dir, log, concurrency, now, setTimeout, clearTimeout })`。
 *     `dir` 是帧库根。契约说退避要「注入时钟」但没写选项名，这里按 M5a `createWsEndpoint` 的写法传
 *     `now` / `setTimeout` / `clearTimeout`（假时钟，见 `fake-manifest-env.mjs` 的 `createManualClock`）。每个队列都传，
 *     免得失败的段挂一个真的 5 s 计时器。
 *   - 「配了推送队列的管线」：契约没写怎么配。这里 `attachQueue(pipeline, queue)`：管线有 `setPushQueue` 就调它，
 *     否则设 `pipeline.pushQueue = queue`（`createPushQueue` 自己已经挂上的，两种写法都不冲突）。
 *   - `enqueue(unit, priority)`：`priority` 传数字 0 / 1 / 2（契约表的 `normal` / `low` / `lowest`，第 9 节第 2 条定为最终级别）；
 *     返回 `Promise<void>`，队列文件写回后兑现（第 9 节第 1 条），测试里要读 `push-queue.json` 之前都先 await 它；
 *     `unit` = `{ kind, tier, resultKey, dirKey, entryKey, range, canvasHeavy }`。
 *   - 推送顺序看内容库清单的写入顺序（`content.put`，并发 1 时就是推送顺序）。
 *   - 钩子要算这一段的 `to`（与 `split.mjs` 一致：最后一段到 `count - 1`），所以用到钩子的用例都在管线上挂一个
 *     entry，card plan 里有这张卡的 control（`clipId`、`snapshotKey`、`tier`、`count`）。
 *
 * 实现模块还不存在时每条用例各自失败、报原因。
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
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
const { resultKeyOf } = await import('../render-node/fingerprint.mjs');
const F = await import('./fake-artifact-fixtures.mjs');
const E = await import('./fake-manifest-env.mjs');
const {
  sha256, range, wire, snapshotTask, dirKeyOf, manifestKey, seedSnapshots, unpack, htmlOf, bigHtml, dataImageHtml, dataImageBytes,
  makeRoots, startServices, treeOf, producerOf, OWN_ENV, SHARED_CAPS, LOCAL_CAPS,
} = F;
const { countingAsset, countingContent, createManualClock, until } = E;

let transfer = null, transferError = null;
try { transfer = await import('../artifact-transfer.mjs'); } catch (err) { transferError = err; }
let pushMod = null, pushError = null;
try { pushMod = await import('../artifact-push.mjs'); } catch (err) { pushError = err; }
let clientMod = null, clientError = null;
try { clientMod = await import('../asset-store/client.mjs'); } catch (err) { clientError = err; }
function T() {
  if (transferError) throw new Error(`载不进 server/artifact-transfer.mjs：${transferError.message}`);
  return transfer;
}
function P() {
  if (pushError) throw new Error(`载不进 server/artifact-push.mjs：${pushError.message}`);
  assert.equal(typeof pushMod.createPushQueue, 'function', `artifact-push.mjs 要导出 createPushQueue；导出：${Object.keys(pushMod).join(', ')}`);
  return pushMod;
}
function newClient(base) {
  if (clientError) throw new Error(`载不进 server/asset-store/client.mjs：${clientError.message}`);
  return clientMod.createAssetClient({ base });
}

const harness = createAssetHarness();
after(() => harness.cleanup());

const FP = OWN_ENV.fingerprint;
const NORMAL = 0, LOW = 1, LOWEST = 2;

async function rig(t) {
  const roots = makeRoots(FramePipeline, 'pc-c64-push-');
  t.after(() => roots.cleanup());
  const svc = await startServices(harness, newClient);
  t.after(() => svc.cleanup());
  return { roots, svc };
}

/** 建队列（带假时钟），测试结束时 stop */
function queueOf(t, { pipeline, client, content, dir, concurrency = 1, clock = createManualClock() }) {
  const logs = [];
  const queue = P().createPushQueue({
    pipeline, client, content, dir, concurrency,
    log: (...args) => logs.push(args),
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  assert.ok(queue && typeof queue.enqueue === 'function' && typeof queue.start === 'function' && typeof queue.stop === 'function' && typeof queue.stats === 'function',
    'PushQueue = { enqueue, start, stop, stats }');
  t.after(async () => { try { await queue.stop(); } catch { /* 已停 */ } });
  const live = { queue, logs };
  liveQueues.add(live);
  t.after(() => { liveQueues.delete(live); });
  return { queue, clock, logs };
}

/** 本条用例建过的队列：等待超时时把各队列的 lastError 和最近的重试日志带进报错，偶发失败时才看得出原因 */
const liveQueues = new Set();
const queueDiag = () => JSON.stringify([...liveQueues].map(({ queue, logs }) => ({
  stats: (({ running, pending, inflight, backingOff, pushed, failures, uploaded, skipped, manifests }) => ({ running, pending, inflight, backingOff, pushed, failures, uploaded, skipped, manifests }))(queue.stats()),
  lastError: queue.stats().lastError,
  retries: logs.filter(([event]) => event === 'push.retry').slice(-3),
}))).slice(0, 1500);

function attachQueue(pipeline, queue) {
  if (typeof pipeline.setPushQueue === 'function') pipeline.setPushQueue(queue);
  else if (pipeline.pushQueue !== queue) pipeline.pushQueue = queue;
}

/** 共享档一张卡的 control（card plan 形状，`card-cache.mjs`） */
function sharedControl({ clipId, contentKey, count, capabilities = SHARED_CAPS }) {
  return { clipId, key: `png-${clipId}`, snapshotKey: resultKeyOf(contentKey, FP), contentKey, envFingerprint: FP, tier: 'shared', capabilities, count, sampling: { firstFrame: 0 } };
}
function entryWith(pipeline, controls, key = sha256(`entry-${Math.random()}`)) {
  const entry = { key, project: { fps: 30, width: 1920, height: 1080, duration: 10, tracks: [] }, cardPlan: controls, status: 'ready' };
  pipeline.entries.set(key, entry);
  return entry;
}
const unitOf = (task, canvasHeavy = false) => ({
  kind: 'snapshot', tier: task.tier, resultKey: task.resultKey, dirKey: dirKeyOf(task), entryKey: task.tier === 'local' ? task.input.entryKey : null,
  range: { ...task.range }, canvasHeavy,
});
/** 清单写入顺序里，每个键第一次出现的位置 */
const putOrder = (content) => [...new Set(content.puts().map((c) => c.key))];
const waitPuts = (content, n, ms = 15_000) => until(() => content.puts().length >= n, { timeoutMs: ms, what: () => `内容库只写了 ${content.puts().length} 份清单：${JSON.stringify(putOrder(content))}；队列：${queueDiag()}` });

/** 读队列文件；没有回 null。撞上队列正在改名替换它（Windows 上报 EPERM / EBUSY / EACCES）就稍等重读，不当成「没有」 */
async function readQueueFile(dir) {
  for (let attempt = 0; ; attempt++) {
    try { return await fs.readFile(path.join(dir, 'push-queue.json'), 'utf8'); }
    catch (err) {
      if (err?.code === 'ENOENT' || attempt >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) return null;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

/* ------------------------------------------------------------------ W1 */

test('W1 配了推送队列的管线 commitSnapshots 写 130 帧（跨 3 段）：每段进队恰好一次；推完之后素材服务有全部块，内容库有 3 份清单', async (t) => {
  const { roots, svc } = await rig(t);
  const root = await roots.root();
  const A = roots.make(root);
  const asset = countingAsset(svc.client);
  const content = countingContent(svc.content);
  const { queue } = queueOf(t, { pipeline: A, client: asset, content, dir: root });
  const enqueued = [];
  const rawEnqueue = queue.enqueue.bind(queue);
  const pending = [];
  queue.enqueue = (unit, priority) => { enqueued.push({ unit: wire(unit), priority }); const r = rawEnqueue(unit, priority); pending.push(r); return r; };
  attachQueue(A, queue);

  const contentKey = sha256('card-W1');
  const control = sharedControl({ clipId: 'clip-w1', contentKey, count: 130 });
  entryWith(A, [control]);
  const rk = control.snapshotKey;
  // 按批写（每批 10 帧，13 批），和预渲染一样经 commitSnapshots
  for (let from = 0; from < 130; from += 10) {
    await A.snapshots().commitSnapshots({ tier: 'shared', key: rk, clipId: 'clip-w1', capabilities: SHARED_CAPS,
      items: range(from, from + 9).map((n) => ({ localFrame: n, html: htmlOf(n, 'W1') })) });
  }
  // 钩子若经 pipeline 上挂的队列对象调 enqueue，这里看得到进队的单元；看不到（实现在闭包里直接进队）就只看推送结果
  if (enqueued.length) {
    const distinct = new Map(enqueued.map((e) => [`${e.unit.resultKey}:${e.unit.range.from}-${e.unit.range.to}`, e]));
    assert.deepEqual([...distinct.keys()].sort(), [`${rk}:0-59`, `${rk}:120-129`, `${rk}:60-119`].sort(),
      `三段，键与 split.mjs 的切分一致（最后一段到 count - 1）：${JSON.stringify([...distinct.keys()])}`);
    for (const e of distinct.values()) {
      assert.equal(e.unit.kind, 'snapshot');
      assert.equal(e.unit.tier, 'shared');
      assert.equal(e.unit.resultKey, rk, '共享档 resultKey = snapshotKey');
    }
  }
  assert.equal(content.puts().length, 0, 'start() 之前不推');
  // 钩子不 await enqueue（第 9 节第 1 条）：等它回的 Promise 兑现（看得到的话），再读队列文件
  await Promise.all(pending);
  await until(async () => (await readQueueFile(root)) !== null, { timeoutMs: 3000, what: () => '进队之后没写 push-queue.json' });
  const persisted = await readQueueFile(root);
  assert.ok(persisted, '进队就写 <dir>/push-queue.json');
  assert.doesNotThrow(() => JSON.parse(persisted), 'push-queue.json 是合法 JSON');

  queue.start();
  await waitPuts(content, 3);
  await new Promise((resolve) => setTimeout(resolve, 300)); // 看看有没有多推
  assert.deepEqual(putOrder(content).sort(), [`${rk}:0-59`, `${rk}:120-129`, `${rk}:60-119`].sort());
  assert.equal(content.puts().length, 3, `每段恰好推一次：${JSON.stringify(content.puts().map((c) => c.key))}`);
  const perHash = new Map();
  for (const p of asset.puts) perHash.set(p.hash, (perHash.get(p.hash) ?? 0) + 1);
  assert.equal(perHash.size, 130, '130 个块');
  assert.ok([...perHash.values()].every((n) => n === 1), '每个块只推一次');
  for (const [from, to] of [[0, 59], [60, 119], [120, 129]]) {
    const task = snapshotTask({ contentKey, from, to, fp: FP });
    assert.equal(task.resultKey, rk);
    const expected = unpack(await T().collectSnapshotResult(A, task)).result;
    const got = await svc.content.get('snapshot-manifest', manifestKey(task));
    assert.ok(got, `内容库有 ${manifestKey(task)}`);
    assert.deepEqual(got.body, expected, `${from}-${to} 的清单就是 C6.2 的 SnapshotResult`);
    for (const [n, h, bytes] of expected.frames) {
      const st = await svc.srv.stores.snap.stat(h);
      assert.ok(st && st.size === bytes, `第 ${n} 帧的块在 snap 里`);
    }
  }
  const stats = queue.stats();
  assert.ok(stats && typeof stats === 'object', 'stats() 回一个对象');
  assert.equal(bakeryCalls.length, 0, '推送不触发渲染');
});

test('W1 推送在后台跑：素材服务卡住时 commitSnapshots 照常很快返回，不挡预渲染', async (t) => {
  const { roots, svc } = await rig(t);
  const root = await roots.root();
  const A = roots.make(root);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const asset = countingAsset(svc.client, { beforePut: () => gate });
  const content = countingContent(svc.content);
  const { queue } = queueOf(t, { pipeline: A, client: asset, content, dir: root, concurrency: 2 });
  attachQueue(A, queue);
  const control = sharedControl({ clipId: 'clip-w1b', contentKey: sha256('card-W1b'), count: 120 });
  entryWith(A, [control]);
  queue.start();
  await A.snapshots().commitSnapshots({ tier: 'shared', key: control.snapshotKey, clipId: 'clip-w1b', capabilities: SHARED_CAPS,
    items: range(0, 59).map((n) => ({ localFrame: n, html: htmlOf(n, 'W1b') })) });
  await until(() => asset.puts.length > 0, { timeoutMs: 5000, what: () => '队列没有开始推第一段' });
  // 推送卡在 gate 上、测试放行之前永远不会完成：commitSnapshots 只要在放行之前返回，就说明它不等推送。
  // 不用「< 2000 ms」这种墙钟阈值 —— 全量并行时 CPU 满载，写 60 帧本身偶尔就要两三秒。
  const t0 = Date.now();
  let limit;
  const idx = await Promise.race([
    A.snapshots().commitSnapshots({ tier: 'shared', key: control.snapshotKey, clipId: 'clip-w1b', capabilities: SHARED_CAPS,
      items: range(60, 119).map((n) => ({ localFrame: n, html: htmlOf(n, 'W1b') })) }),
    new Promise((resolve, reject) => { limit = setTimeout(() => reject(new Error(`推送卡住时 commitSnapshots ${Date.now() - t0} ms 还没返回：它在等推送`)), 20_000); }),
  ]).finally(() => clearTimeout(limit));
  assert.equal(asset.puts.filter((p) => p.ok).length, 0, 'commitSnapshots 返回时推送仍卡着（一个块都没推成）');
  assert.deepEqual(idx.frames, [[0, 119]], '写盘照常');
  release();
  await waitPuts(content, 2);
});

/* ------------------------------------------------------------------ W2 */

test('W2 优先级：同时进队一段共享档、一段本地档、一段含超体积帧的，推送顺序是 normal → low → lowest', async (t) => {
  const { roots, svc } = await rig(t);
  const root = await roots.root();
  const A = roots.make(root);
  const shared = snapshotTask({ contentKey: sha256('card-W2-shared'), from: 0, to: 59, fp: FP });
  const entryKey = sha256('entry-W2');
  const local = snapshotTask({ tier: 'local', entryKey, contentKey: sha256('card-W2-local'), from: 0, to: 59, fp: FP, clipId: 'clip-l' });
  const over = snapshotTask({ contentKey: sha256('card-W2-over'), from: 0, to: 59, fp: FP });
  // 先写帧库（队列还没建：不走钩子）
  await seedSnapshots(A, shared, range(0, 59), { tag: 'S' });
  await seedSnapshots(A, local, range(0, 59), { tag: 'L' });
  const idx = await seedSnapshots(A, over, range(0, 59), { html: (n) => (n === 17 ? bigHtml(n) : htmlOf(n, 'O')) });
  assert.deepEqual(idx.oversize, [[17, 17]], '夹具：第 17 帧超体积');

  const content = countingContent(svc.content);
  const { queue } = queueOf(t, { pipeline: A, client: svc.client, content, dir: root, concurrency: 1 });
  // 故意按 lowest → low → normal 进队
  await queue.enqueue(unitOf(over), LOWEST);
  await queue.enqueue(unitOf(local), LOW);
  await queue.enqueue(unitOf(shared), NORMAL);
  queue.start();
  await waitPuts(content, 3);
  assert.deepEqual(putOrder(content), [manifestKey(shared), manifestKey(local), manifestKey(over)], 'normal → low → lowest');
  // 三份清单都对
  for (const task of [shared, local, over]) {
    const got = await svc.content.get('snapshot-manifest', manifestKey(task));
    assert.deepEqual(got?.body, unpack(await T().collectSnapshotResult(A, task)).result, `${task.tier} ${manifestKey(task).slice(-6)} 的清单`);
  }
  const overBody = (await svc.content.get('snapshot-manifest', manifestKey(over))).body;
  assert.equal(overBody.frames.length, 60, '超体积的帧也在清单里');
  assert.equal(overBody.dirKey, over.resultKey);
  const localBody = (await svc.content.get('snapshot-manifest', manifestKey(local))).body;
  assert.deepEqual([localBody.tier, localBody.entryKey, localBody.dirKey], ['local', entryKey, dirKeyOf(local)], '本地档清单带 entryKey 与落盘键');
});

/* ------------------------------------------------------------------ W3 */

test('W3 data:image 占比过半的段按 low 推（钩子自己判；占比不到一半的仍是 normal；有超体积帧的是 lowest）', async (t) => {
  const { roots, svc } = await rig(t);
  const root = await roots.root();
  const A = roots.make(root);
  const content = countingContent(svc.content);
  const { queue } = queueOf(t, { pipeline: A, client: svc.client, content, dir: root, concurrency: 1 });
  const enqueued = [];
  const rawEnqueue = queue.enqueue.bind(queue);
  queue.enqueue = (unit, priority) => { enqueued.push({ unit: wire(unit), priority }); return rawEnqueue(unit, priority); };
  attachQueue(A, queue);

  const X = sharedControl({ clipId: 'clip-img', contentKey: sha256('card-W3-img'), count: 60 });      // data:image ≈ 80%
  const Y = sharedControl({ clipId: 'clip-some', contentKey: sha256('card-W3-some'), count: 60 });    // data:image ≈ 30%
  const Z = sharedControl({ clipId: 'clip-over', contentKey: sha256('card-W3-over'), count: 60 });    // 一帧超体积
  entryWith(A, [X, Y, Z]);
  const htmlX = (n) => dataImageHtml(n, 0.8);
  const htmlY = (n) => dataImageHtml(n, 0.3);
  const share = (fn) => { let img = 0, all = 0; for (const n of range(0, 59)) { const h = fn(n); img += dataImageBytes(h); all += Buffer.byteLength(h, 'utf8'); } return img / all; };
  assert.ok(share(htmlX) > 0.7, `夹具：X 的 data:image 占比 ${share(htmlX).toFixed(3)}`);
  assert.ok(share(htmlY) < 0.4 && share(htmlY) > 0.2, `夹具：Y 的 data:image 占比 ${share(htmlY).toFixed(3)}`);
  const commit = (c, html) => A.snapshots().commitSnapshots({ tier: 'shared', key: c.snapshotKey, clipId: c.clipId, capabilities: SHARED_CAPS,
    items: range(0, 59).map((n) => ({ localFrame: n, html: html(n) })) });
  // 进队顺序 X、Z、Y（先进先出的话就是这个顺序）
  await commit(X, htmlX);
  await commit(Z, (n) => (n === 30 ? bigHtml(n) : htmlOf(n, 'Z')));
  await commit(Y, htmlY);
  t.diagnostic(`钩子进队：${JSON.stringify(enqueued.map((e) => [e.unit.resultKey?.slice(0, 6), e.priority]))}`);
  queue.start();
  await waitPuts(content, 3);
  assert.deepEqual(putOrder(content), [`${Y.snapshotKey}:0-59`, `${X.snapshotKey}:0-59`, `${Z.snapshotKey}:0-59`],
    'Y（normal）→ X（data:image 过半，low）→ Z（有超体积帧，lowest）');
});

/* ------------------------------------------------------------------ W4 */

test('W4 推到一半 stop()，从同一个 dir 重建队列：未完成的段接着推，已完成的不重推（数 put 的上传次数）', async (t) => {
  const { roots, svc } = await rig(t);
  const root = await roots.root();
  const A = roots.make(root);
  const tasks = ['a', 'b', 'c', 'd'].map((k) => snapshotTask({ contentKey: sha256(`card-W4-${k}`), from: 0, to: 59, fp: FP }));
  const segOf = new Map();
  for (const [i, task] of tasks.entries()) {
    await seedSnapshots(A, task, range(0, 59), { tag: `W4-${i}` });
    for (const [, h] of unpack(await T().collectSnapshotResult(A, task)).result.frames) segOf.set(h, i);
  }

  // 第一个队列：第一段照常推完；第二段一开始推就卡住，这时 stop()，再让它失败
  let first = null, second = null, releaseSecond;
  const blocked = new Promise((resolve) => { releaseSecond = resolve; });
  const asset1 = countingAsset(svc.client, {
    beforePut: async ({ hash }) => {
      const seg = segOf.get(hash);
      if (first === null) first = seg;
      if (seg === first) return;
      if (second === null) second = seg;
      await blocked;
      throw Object.assign(new Error('停机时中断'), { status: 503 });
    },
  });
  const content1 = countingContent(svc.content);
  const q1 = queueOf(t, { pipeline: A, client: asset1, content: content1, dir: root, concurrency: 1 });
  for (const task of tasks) await q1.queue.enqueue(unitOf(task), NORMAL); // 第 9 节第 1 条：写回队列文件后才兑现
  const before = await readQueueFile(root);
  assert.ok(before && tasks.every((task) => before.includes(task.resultKey)), '四段都落进了 push-queue.json');
  q1.queue.start();
  await until(() => second !== null, { timeoutMs: 10_000, what: () => `第二段没开始推：first=${first}；队列：${queueDiag()}` });
  assert.equal(content1.puts().length, 1, '第一段推完、写了清单');
  await q1.queue.stop();
  releaseSecond();
  // stop() 不等在推的段（契约）：第二段放行后失败、再写一次队列文件。等它收尾、写完再读文件，
  // 否则读到的可能是正在替换的文件（Windows 上改名替换的瞬间读会失败），也可能和下面 q2 的 restore 撞上。
  await until(() => q1.queue.stats().inflight === 0, { timeoutMs: 10_000, what: () => `第二段一直没收尾；队列：${queueDiag()}` });
  await q1.queue.stop(); // 已停的队列再 stop 一次只做一件事：等排着的写回全部完成
  await new Promise((resolve) => setTimeout(resolve, 100));
  const doneKey = manifestKey(tasks[first]);
  assert.deepEqual(content1.puts().map((c) => c.key), [doneKey], '停下之后不再推别的段');
  const persisted = await readQueueFile(root);
  assert.ok(persisted, '队列文件还在');
  assert.ok(!persisted.includes(tasks[first].resultKey), '已完成的段不留在文件里');
  for (const [i, task] of tasks.entries()) if (i !== first) assert.ok(persisted.includes(task.resultKey), `未完成的第 ${i} 段还在文件里`);

  // 第二个队列：同一个 dir，重建之后接着推
  const asset2 = countingAsset(svc.client);
  const content2 = countingContent(svc.content);
  const q2 = queueOf(t, { pipeline: A, client: asset2, content: content2, dir: root, concurrency: 1 });
  q2.queue.start();
  await waitPuts(content2, 3);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const rest = tasks.filter((_, i) => i !== first).map(manifestKey);
  assert.deepEqual(putOrder(content2).sort(), [...rest].sort(), '其余三段接着推完');
  assert.equal(content2.puts().length, 3, '每段一次');
  assert.equal(asset2.puts.filter((p) => segOf.get(p.hash) === first).length, 0, '已完成的第一段一个块都不重推');
  assert.equal(asset2.puts.filter((p) => segOf.get(p.hash) !== first).length, 180, '其余三段 180 个块');
  for (const task of tasks) assert.ok(await svc.content.get('snapshot-manifest', manifestKey(task)), `${manifestKey(task).slice(-12)} 在内容库里`);
  const after_ = await readQueueFile(root);
  assert.ok(after_ === null || tasks.every((task) => !after_.includes(task.resultKey)), '全部完成后文件里不留已完成的段');
});

/* ------------------------------------------------------------------ W5 */

test('W5 素材服务对某段返回 500：这一段按 5 s、30 s 退避重试（注入时钟），最后成功；别的段不受影响', async (t) => {
  const { roots, svc } = await rig(t);
  const root = await roots.root();
  const A = roots.make(root);
  const tasks = ['a', 'b', 'c'].map((k) => snapshotTask({ contentKey: sha256(`card-W5-${k}`), from: 0, to: 59, fp: FP }));
  const bad = new Set();
  let sentinel = null;
  for (const [i, task] of tasks.entries()) {
    await seedSnapshots(A, task, range(0, 59), { tag: `W5-${i}` });
    const frames = unpack(await T().collectSnapshotResult(A, task)).result.frames;
    if (i === 1) { for (const [, h] of frames) bad.add(h); sentinel = frames[0][1]; }
  }
  // 每个块按它自己被 put 的次数决定成败（前两次 500、第三次成功）。不能按哨兵块的次数判：一段里的块是
  // 4 路并发 put 的，谁先到 beforePut 由读盘快慢决定，第三轮里别的块可能抢在哨兵前面、仍被判失败，
  // 于是这一段又进 120 s 退避，假时钟不再拨，测试就等到超时（全量并行时偶发）。
  let attempts = 0;
  const tries = new Map();
  const asset = countingAsset(svc.client, {
    beforePut: ({ hash }) => {
      if (hash === sentinel) attempts++;
      const n = (tries.get(hash) ?? 0) + 1;
      tries.set(hash, n);
      if (bad.has(hash) && n <= 2) throw Object.assign(new Error('HTTP 500'), { status: 500 });
    },
  });
  const content = countingContent(svc.content);
  const clock = createManualClock();
  const { queue } = queueOf(t, { pipeline: A, client: asset, content, dir: root, concurrency: 1, clock });
  for (const task of tasks) await queue.enqueue(unitOf(task), NORMAL);
  queue.start();
  await waitPuts(content, 2);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(putOrder(content).sort(), [manifestKey(tasks[0]), manifestKey(tasks[2])].sort(), '别的段不受影响');
  assert.equal(attempts, 1, '失败的段试了一次');
  assert.equal(await svc.content.get('snapshot-manifest', manifestKey(tasks[1])), null, '失败的段不写清单');

  await clock.advance(4_999);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(attempts, 1, '5 s 之前不重试');
  await clock.advance(1);
  await until(() => attempts === 2, { timeoutMs: 3000, what: () => `5 s 到了没有重试：attempts=${attempts}，登记过的计时 ${JSON.stringify(clock.delays)}` });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await svc.content.get('snapshot-manifest', manifestKey(tasks[1])), null, '第二次仍失败');

  await clock.advance(29_999);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(attempts, 2, '再等 30 s 之前不重试');
  await clock.advance(1);
  await until(() => attempts === 3, { timeoutMs: 3000, what: () => `30 s 到了没有重试：attempts=${attempts}，登记过的计时 ${JSON.stringify(clock.delays)}` });
  await waitPuts(content, 3);
  const got = await svc.content.get('snapshot-manifest', manifestKey(tasks[1]));
  assert.deepEqual(got?.body, unpack(await T().collectSnapshotResult(A, tasks[1])).result, '第三次成功，清单写进内容库');
  assert.equal(content.puts().length, 3, '成功的段不重推');
});

/* ------------------------------------------------------------------ W6 */

// fMP4 合成件（同 frame-stream.test.mjs）：storeSegment 要能切分、校验
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]); };
const full = (version, flags) => u32(((version & 0xff) << 24) | (flags & 0xffffff));
function makeInit({ width = 64, height = 64, level = 0x1f } = {}) {
  const avcC = box('avcC', Buffer.from([1, 0x64, 0x00, level, 0xff, 0xe1, 0x00, 0x00, 0x01, 0x00, 0x00]));
  const entry = Buffer.alloc(78);
  entry.writeUInt16BE(1, 6);
  entry.writeUInt16BE(width, 24);
  entry.writeUInt16BE(height, 26);
  const avc1 = box('avc1', entry, avcC);
  const stsd = box('stsd', full(0, 0), u32(1), avc1);
  const mdhd = box('mdhd', full(0, 0), u32(0), u32(0), u32(15360), u32(0), u32(0));
  const moov = box('moov', box('trak', box('mdia', mdhd, box('minf', box('stbl', stsd)))));
  return Buffer.concat([box('ftyp', Buffer.from('isom'), u32(512)), moov]);
}
function makeSegment(sizes, fill = 1) {
  const tfhd = box('tfhd', full(0, 0x020020), u32(1), u32(0x01010000));
  const trunBody = (dataOffset) => Buffer.concat([full(0, 0x000205), u32(sizes.length), u32(dataOffset), u32(0x02000000), ...sizes.map(u32)]);
  const probe = box('moof', box('traf', tfhd, box('trun', trunBody(0))));
  const moof = box('moof', box('traf', tfhd, box('trun', trunBody(probe.length + 8))));
  const mdat = box('mdat', Buffer.concat(sizes.map((n, i) => Buffer.alloc(n, fill + i))));
  return Buffer.concat([moof, mdat]);
}

/**
 * C6.2 之后 main 上（没配推送队列）同一串写入的结果，由本测试在 `claude/c6-4`（dc1addc）上跑出来记下：
 * 文件 → sha256；`stream.json` 的 `at`（`Date.now()`）先归一成 0 再算。
 */
const GOLDEN = {
  commit1: {
    count: 10,
    frames: [
      [
        0,
        9
      ]
    ],
    oversize: [],
    written: [
      0,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9
    ],
    oversized: []
  },
  commit2: {
    count: 19,
    frames: [
      [
        0,
        11
      ],
      [
        13,
        19
      ]
    ],
    oversize: [
      [
        12,
        12
      ]
    ],
    written: [
      10,
      11,
      13,
      14,
      15,
      16,
      17,
      18,
      19
    ],
    oversized: [
      12
    ]
  },
  commit3: {
    count: 5,
    frames: [
      [
        0,
        4
      ]
    ],
    oversize: [],
    written: [
      0,
      1,
      2,
      3,
      4
    ],
    oversized: []
  },
  staged: [],
  streamStats: 2,
  stagedAfter: [
    {
      kind: 'stream',
      key: '5517a8bfe97b060bb52e6467e56b225715869c8e8b895dd54ffa48496cab01c9',
      ranges: [
        [
          0,
          1
        ]
      ]
    }
  ],
  files: {
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/0.html': '75082248faa2a87647ec9828cc5a9f0c9d6a1df58571389f84a329137357d16b',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/1.html': 'a218ea33014a442314c535809c62b2a19c237af650d35c03ce7bb4c49705bbd9',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/10.html': '6e8228abc539ca53a7ccc4c0f29dee04c1a3a8f4b0aa2cfedaf68d33a0973e66',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/11.html': '4501a9ad3e8f18f7be1b962440161521689fe5197963ceb525b4fc7305e9bfcc',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/12.html': 'c8bb3b41c1ec8371d52649b229fec2c8179e61f215a1f32a534509d15bf49637',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/13.html': '44c2c19742c83e29a46bbca2abd73c80d46e0becb43ab36852905cb64fd8765c',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/14.html': 'afd2faf8438b08a3a3bb4a5110c465322c9cd98dac2f38ebcb912e2f705bce95',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/15.html': '9102cf004b6524868eb4f407c0f1beb950e06613b08559f76ebf1eaf6b3ea3aa',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/16.html': 'e87aafd2147d8a342f9ad9fe6363974f9e79c799a377716e1f4f635c1a551f0b',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/17.html': '48786b3925062133167dca28fedc2df96309c6a089c76895666cfeb270a9c16a',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/18.html': '09387aa8c8c6668df59f752b63ab1b6a09b96d004ebbbdf4acfee47603042d3b',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/19.html': '084303ed742e69b5b7681c8ece903df25febd61ba0cde83b10130915227f28a0',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/2.html': '65f924f49f79acce505d119c56b497e2dad404542189e86f444f86653f59e717',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/3.html': '03df86f8203c59a617d256436b9acfe6a303d9238c1500950787a9f11487e80d',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/4.html': 'a0988094bb3c660c5e366064ce6682fc4da0e65c4de1470547e6a3f8007f52e0',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/5.html': '74e6c57f4fed0c88afa6b210772276979831df4af225854cd39891805736b461',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/6.html': 'fbe7fffed5c537d6951a3c640cbcda32c857f6eba08055f2703fc35b2bc57269',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/7.html': '5d45e7221ea6b81674de33480a81873f5223790d19cdbcc132ed14a935f3a2f8',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/8.html': 'b2146a9bc9c6ff0801b3044ba7c37f3fb6bdb1b9181ef121149ff4bafa2db108',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/9.html': '0f2e48adc573fd46bb663b87be086c6f14291ee0bbf1c32723db22f0faedef0d',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/index.json': 'fb44521ec46be4ced8e844051faf11b87e9bdb46486696c9b45cd73f982f3e01',
    'controls-local/448952440c0214b285530725ee9e5e7513666983317ca84fdcaf68c3324ec28d/609337f08f815ee6ebd8b5bb7e695a3d587f744059b51489c84248aba099047a/0.html': 'e4fb5efb47136d510cc023cf3aed0759b25c58d62fc15bcff4154b95793d7e6f',
    'controls-local/448952440c0214b285530725ee9e5e7513666983317ca84fdcaf68c3324ec28d/609337f08f815ee6ebd8b5bb7e695a3d587f744059b51489c84248aba099047a/1.html': 'c7251178ef2c10898151022839fad7d28e1a9cdc97cf33b0a39ff6fa3f948a59',
    'controls-local/448952440c0214b285530725ee9e5e7513666983317ca84fdcaf68c3324ec28d/609337f08f815ee6ebd8b5bb7e695a3d587f744059b51489c84248aba099047a/2.html': '979e25c23a47264ab819bb9c7f192cd445ff2d1645c778fad22471ec44d13c91',
    'controls-local/448952440c0214b285530725ee9e5e7513666983317ca84fdcaf68c3324ec28d/609337f08f815ee6ebd8b5bb7e695a3d587f744059b51489c84248aba099047a/3.html': 'f3ebcd45c3041dd2c1aec256e57dfa7b37c1ad0992d4d2f15fde894f2699bc8c',
    'controls-local/448952440c0214b285530725ee9e5e7513666983317ca84fdcaf68c3324ec28d/609337f08f815ee6ebd8b5bb7e695a3d587f744059b51489c84248aba099047a/4.html': '5e90dbe11ecda22ac852d7d7022c2baabbc18a4f705ce7d8609fb8fde0a615f1',
    'controls-local/448952440c0214b285530725ee9e5e7513666983317ca84fdcaf68c3324ec28d/609337f08f815ee6ebd8b5bb7e695a3d587f744059b51489c84248aba099047a/index.json': '2e79bc7f2ab28f6e4255f9402ee86a4d916c78f59bbaefbdc882d3f300468c99',
    'streams/5517a8bfe97b060bb52e6467e56b225715869c8e8b895dd54ffa48496cab01c9/0-312d810e32dd8d36.m4s': '312d810e32dd8d364cccbb4b2ea1e96c55d3053576bf6299f58a4679bb5d7a66',
    'streams/5517a8bfe97b060bb52e6467e56b225715869c8e8b895dd54ffa48496cab01c9/1-8b7a9f5ffe8ee475.m4s': '8b7a9f5ffe8ee475c119bbda4b033f157e4540456187e3546a57a0b7161c7252',
    'streams/5517a8bfe97b060bb52e6467e56b225715869c8e8b895dd54ffa48496cab01c9/init-a01177ae56eef330.mp4': 'a01177ae56eef330122d54c5a419f0c7843e5dfbeb656f3ceb5c254e91ba238e',
    // 清单里记着 `version: STREAM_CODE_VERSION`。渲染重构「己一」把它从 1 加到 2,这一个文件的字节跟着变(别的字段、流键、分段都没变:
    // 把常量改回 1,这里仍是原来记下的 5c074ef83138e314fb829b238eeac62127ebfaac4844ac83d5107d015b66c75e)
    // 2026-10-13「稀疏流一」改过这一项:流的清单多记一项 `originFrame`(这条流自己的第一帧)、`version` 跟着 `STREAM_CODE_VERSION` 从 2 到 3。
    // 「稀疏流一」第二期再改一次:`version` 跟着 `STREAM_CODE_VERSION` 从 3 到 4(这里直接调 storeSegment、不带位置矩形,清单别处没变)。
    // 2026-10-17 流清单分桶对齐:流的清单多记一项 `lastFrame`(这条流自己的最后一帧,供跨任务 8 段桶截尾;去掉它仍是 c25fc173...)。
    // 推送队列配没配不影响它;别的文件一个字没变
    'streams/5517a8bfe97b060bb52e6467e56b225715869c8e8b895dd54ffa48496cab01c9/stream.json': '33b11571683bb2954d727db01a93beafc56c8d95d8fa209940b6299a18161863'
  }
};

async function w6Scenario(A, rootA) {
  const out = {};
  // 共享档：两批，第二批含一帧超体积
  const shared = snapshotTask({ contentKey: sha256('card-W6-shared'), from: 0, to: 59, fp: FP });
  out.commit1 = wire(await A.snapshots().commitSnapshots({ tier: 'shared', key: shared.resultKey, clipId: 'clip-w6', capabilities: SHARED_CAPS,
    items: range(0, 9).map((n) => ({ localFrame: n, html: htmlOf(n, 'W6') })) }));
  out.commit2 = wire(await A.snapshots().commitSnapshots({ tier: 'shared', key: shared.resultKey, clipId: 'clip-w6', capabilities: SHARED_CAPS,
    items: range(10, 19).map((n) => ({ localFrame: n, html: n === 12 ? bigHtml(n) : htmlOf(n, 'W6') })) }));
  // 本地档
  const entryKey = sha256('entry-W6');
  const local = snapshotTask({ tier: 'local', entryKey, contentKey: sha256('card-W6-local'), from: 0, to: 59, fp: FP, clipId: 'clip-w6l' });
  out.commit3 = wire(await A.snapshots().commitSnapshots({ tier: 'local', entryKey, key: dirKeyOf(local), clipId: 'clip-w6l', capabilities: LOCAL_CAPS,
    items: range(0, 4).map((n) => ({ localFrame: n, html: htmlOf(n, 'W6L') })) }));
  out.staged = A.ready.stagedKeys().map(wire);

  // 流：storeSegment 两个分段（第二个替换第一个的稀疏版）
  const prod = producerOf(A, 'libx264');
  const streamKey = resultKeyOf(sha256('stream-W6'), FP);
  const spec = { streamKey, contentKey: sha256('stream-W6'), envFingerprint: FP, kind: 'card', plane: 'local', clipIds: ['clip-s'], topClipId: 'clip-s', fps: 30,
    bound: { x: 0, y: 0, w: 64, h: 64 }, offset: { x: 0, y: 0 }, originFrame: 0, firstFrame: 0, lastFrame: 29, firstSegment: 0, lastSegment: 1, total: 30, members: [] };
  const state = { spec, manifest: prod.freshManifest(spec), aliases: new Set(), entryKey, reserved: new Set(), failures: new Map(), measured: null, measuredSegments: new Set(), generation: 1 };
  prod.streams.set(streamKey, state);
  prod.entryKey = entryKey;
  const rect = { x: 0, y: 0, w: 64, h: 64 };
  const fmp4 = (sizes, fill) => Buffer.concat([makeInit(), makeSegment(sizes, fill)]);
  await prod.storeSegment(state, 1, { segment: 0, stride: 1, rect, encoder: 'libx264', samples: 3, out: { bytes: fmp4([10, 4, 4], 1), encodeMs: 12, tailMs: 3 } });
  await prod.storeSegment(state, 1, { segment: 1, stride: 1, rect, encoder: 'libx264', samples: 2, out: { bytes: fmp4([9, 5], 7), encodeMs: 11, tailMs: 2 } });
  out.streamStats = prod.stats.segments;
  out.stagedAfter = A.ready.stagedKeys().map(wire).sort((a, b) => `${a.kind}${a.key}`.localeCompare(`${b.kind}${b.key}`));

  // 盘面：全部文件的 sha256（stream.json 的 at 归一）
  const tree = await treeOf(rootA);
  out.files = {};
  for (const [rel, buf] of Object.entries(tree).sort(([a], [b]) => a.localeCompare(b))) {
    if (rel.startsWith('controls-lock/')) continue; // 锁库与本测试无关
    let bytes = buf;
    if (rel.endsWith('stream.json')) {
      const m = JSON.parse(buf.toString('utf8'));
      for (const s of Object.values(m.segments ?? {})) s.at = 0;
      bytes = Buffer.from(JSON.stringify(m));
    }
    out.files[rel] = crypto.createHash('sha256').update(bytes).digest('hex');
  }
  return out;
}

test('W6 没配推送队列的管线：commitSnapshots 与 storeSegment 的行为和写盘内容，与 C6.2 之后的 main 完全一样', async (t) => {
  const roots = makeRoots(FramePipeline, 'pc-c64-w6-');
  t.after(() => roots.cleanup());
  const rootA = await roots.root();
  const A = roots.make(rootA, { interactive: true });
  assert.ok(!A.pushQueue, '缺省没配推送队列');
  const got = await w6Scenario(A, rootA);
  if (process.env.PC_W6_DUMP) console.log(JSON.stringify(got));
  assert.deepEqual(got, GOLDEN, '返回值、就绪索引与写盘内容逐项一致');
  assert.equal(await readQueueFile(rootA), null, '没配推送队列：不写 push-queue.json');
  assert.equal(bakeryCalls.length, 0);
});

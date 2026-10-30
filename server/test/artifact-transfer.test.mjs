/**
 * 预渲染产物推拉（契约 `docs/plan/artifact-transfer-contract.md` 第 3～6 节，第 7 节用例 T1～T8）。
 * 跑：node --experimental-test-module-mocks --test server/test/artifact-transfer.test.mjs
 *
 * 只照契约写，不看实现。
 *
 * 约定：
 *   - 两个临时帧库 A、B，各一个真的 `FramePipeline`：注入 `environment`（不探测）、`dataRoot` 指向临时目录；
 *     `server/bakery/index.mjs` 整个换成假的（和 `card-lock-pipeline.test.mjs` 一样用 `mock.module`），不起 Chrome。
 *     只用它的帧库（`snapshots()`）、快照写入（`commitSnapshots`）、就绪索引（`ready`）和流存储（`streamProducer()`）。
 *     快照用例 `interactive: false`；流用例 `interactive: true`（生产者只在这种实例里有），并手动 `attachRoute()`、
 *     把 `encoderName` 定成一个名字（不探测编码器、不开 worker）。
 *   - 一个共享的素材服务（`fake-asset-service.mjs`，端口 0，memory 实现），客户端用 `server/asset-store/client.mjs`。
 *   - A 的产物直接用写入函数造：快照走 `commitSnapshots`；流按 `frame-stream.mjs` 的格式手工写
 *     `streams/<streamKey>/stream.json` + `init-<sha16>.mp4` + `<n>-<sha16>.m4s`（字节是造的，不是真 fMP4）。
 *   - 任务（`TaskView`）按 `render-queue-contract.md` B.4 / E.5 / F.1 的形状造：结果键 = `resultKeyOf(input.contentKey, requires.envFingerprint)`；
 *     任务的锁指纹（`requires.envFingerprint`）故意与两个 `FramePipeline` 自己的环境指纹不同，确认落盘键取的是任务的指纹。
 *   - `result` 经 JSON 往返之后再交给 `applyResult`（模拟随 `task.done` 过线）。
 *   - 契约第 4 节说 `collect*`「同时返回一个 `readBlob`」，没定形状：这里两种都认 ——
 *     回 `{ result, readBlob }`，或回清单本身、`readBlob` 挂在它上面（见 `unpack`）。
 *
 * 实现模块（`server/artifact-transfer.mjs`、`server/asset-store/client.mjs`）还不存在时每条用例各自失败、报原因。
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAssetHarness } from './fake-asset-service.mjs';

mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: {
    openBakery: async () => { throw new Error('单测不开 Chrome'); },
    findFfmpeg: async () => { throw new Error('单测不找 ffmpeg'); },
    streamPngVideo: () => { throw new Error('单测不编码'); },
    bakeFrames: async () => { throw new Error('单测不预渲染'); },
  },
});

const { FramePipeline } = await import('../frame-pipeline.mjs');
const { snapshotDir } = await import('../snapshot-store.mjs');
const { segmentSignature } = await import('../frame-stream.mjs');
const { describeEnvironment, resultKeyOf } = await import('../render-node/fingerprint.mjs');

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

/* ------------------------------------------------------------------ 常量与小工具 */

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha16 = (buf) => sha256(buf).slice(0, 16);
const HEX64 = /^[0-9a-f]{64}$/;
const RESULT_LIMIT = 256 * 1024;

const OWN_ENV = describeEnvironment({
  platform: 'win32',
  renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  vendor: 'Google Inc. (Google)', chromeVersion: 'HeadlessChrome/138.0.7204.49',
});
/** 任务的锁指纹：一台装 NVIDIA 的机器（和两个 FramePipeline 自己的指纹都不同） */
const TASK_FP = describeEnvironment({
  platform: 'Win32', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)', vendor: 'Google Inc. (NVIDIA)',
  chromeVersion: 'HeadlessChrome/138.0.7204.49',
}).fingerprint;
assert.notEqual(TASK_FP, OWN_ENV.fingerprint);

const SHARED_CAPS = { compositing: 'independent', frameMode: 'stateful' };
const LOCAL_CAPS = { compositing: 'belowDependent', frameMode: 'stateful' };

async function withRoots(n, fn) {
  const roots = [];
  for (let i = 0; i < n; i++) roots.push(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-c62-lib-')));
  const pipelines = [];
  const make = (root, { interactive = false } = {}) => {
    const p = new FramePipeline({ root, origin: () => 'http://127.0.0.1:1', environment: OWN_ENV, dataRoot: root, interactive });
    pipelines.push(p);
    return p;
  };
  try { return await fn(roots, make); } finally {
    await Promise.allSettled(pipelines.map((p) => p.close()));
    await Promise.all(roots.map((r) => fs.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
  }
}

/** 快照任务（B.4 / E.5 / E.9 / F.1 的形状） */
function snapshotTask({ tier = 'shared', contentKey, entryKey = null, from, to, clipId = 'clip-x', fp = TASK_FP }) {
  const inputKey = tier === 'local' ? `${entryKey}/${contentKey}` : contentKey;
  const resultKey = resultKeyOf(inputKey, fp);
  return {
    id: `snapshot:${resultKey}:${from}-${to}`, kind: 'snapshot', tier, resultKey,
    range: { unit: 'localFrame', from, to },
    source: { projectId: 'p1', projectRev: 1, derivedFrom: 'plan:p1@1' },
    input: { clipId, cardId: null, entryKey: tier === 'local' ? entryKey : null, contentKey: inputKey },
    weight: { class: 'heavy', estMs: null, frames: to - from + 1 },
    requires: { envFingerprint: fp, codeVersion: 'c', cardSources: {}, transcode: false, userCards: false, graphCards: false, belowDependent: tier === 'local' },
    priority: 10, state: 'claimed', version: 1, attempts: 1,
  };
}
/** 共享档的落盘键 = 结果键；本地档 = resultKeyOf(去掉 entryKey 前缀的内容键, 任务的锁指纹)（E.9） */
const dirKeyOf = (task) => (task.tier === 'local' ? resultKeyOf(task.input.contentKey.slice(task.input.entryKey.length + 1), task.requires.envFingerprint) : task.resultKey);

function streamTask({ streamKey, contentKey, from, to, clipId = 'clip-s', fp = TASK_FP }) {
  return {
    id: `stream:${streamKey}:${from}-${to}`, kind: 'stream', resultKey: streamKey,
    range: { unit: 'segment', from, to },
    source: { projectId: 'p1', projectRev: 1, derivedFrom: 'plan:p1@1' },
    input: { clipId, cardId: null, entryKey: null, contentKey },
    weight: { class: 'heavy', estMs: null, frames: (to - from + 1) * 15 },
    requires: { envFingerprint: fp, codeVersion: 'c', cardSources: {}, transcode: true, userCards: false, graphCards: false, belowDependent: false },
    priority: 10, state: 'claimed', version: 1, attempts: 1,
  };
}

const htmlOf = (n, tag = 'A') => `<div data-pc-scene="" data-f="${n}">${tag} frame ${n} ${'·'.repeat(n % 7)}</div>`;
const BIG = 17;
const bigHtml = () => `<div data-pc-scene="">${'x'.repeat(310 * 1024)}</div>`;

/** A 的共享档 / 本地档写 `frames` 这些帧（其中 BIG 那一帧超 300 KB） */
async function seedSnapshots(pipeline, task, frames, { tag = 'A', big = true, capabilities } = {}) {
  const caps = capabilities ?? (task.tier === 'local' ? LOCAL_CAPS : SHARED_CAPS);
  const items = frames.map((n) => ({ localFrame: n, html: big && n === BIG ? bigHtml() : htmlOf(n, tag) }));
  return pipeline.snapshots().commitSnapshots({
    tier: task.tier, entryKey: task.input.entryKey ?? undefined, key: dirKeyOf(task), clipId: task.input.clipId, capabilities: caps, items,
  });
}

/** `collect*` 的回值拆成 { result, readBlob }；result 做一次 JSON 往返（函数属性丢掉），就是过线的样子 */
function unpack(out) {
  assert.ok(out && typeof out === 'object', 'collect* 要回一个对象');
  const direct = out.v !== undefined || out.kind !== undefined;
  const result = direct ? out : out.result;
  const readBlob = direct ? out.readBlob : (out.readBlob ?? out.result?.readBlob);
  assert.ok(result && typeof result === 'object', '拿不到清单（result）');
  assert.equal(typeof readBlob, 'function', 'collect* 要同时给出 readBlob(hash)');
  return { result: JSON.parse(JSON.stringify(result)), readBlob, raw: result };
}
const wire = (result) => JSON.parse(JSON.stringify(result));

async function filesOf(dir) {
  let names = [];
  try { names = await fs.readdir(dir); } catch { return {}; }
  const out = {};
  for (const name of names.sort()) out[name] = await fs.readFile(path.join(dir, name));
  return out;
}
const expectedFrameList = async (dir, frames) => Promise.all(frames.map(async (n) => {
  const buf = await fs.readFile(path.join(dir, `${n}.html`));
  return [n, sha256(buf), buf.length];
}));
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** 记 get 次数的客户端包装 */
function countingClient(client) {
  const gets = [];
  const puts = [];
  return {
    gets, puts,
    put: (ns, bytes, opts) => { puts.push({ ns, size: bytes.length }); return client.put(ns, bytes, opts); },
    get: (ns, hash) => { gets.push({ ns, hash }); return client.get(ns, hash); },
    has: (ns, hash) => client.has(ns, hash),
  };
}

/** B 上挂一个假的 entry 和一个页面会话：用来看 adoptResult 之后 claimSessions 发没发 layer */
function watchEntry(pipeline, { entryKey, controls }) {
  const entry = { key: entryKey, project: { fps: 30 }, cardPlan: controls };
  pipeline.entries.set(entryKey, entry);
  const seen = [];
  pipeline.ready.subscribe('page', (m) => seen.push(m));
  pipeline.ready.adopt('page', entryKey, 1);
  return { entry, seen, layers: () => seen.filter((m) => m.type === 'layer') };
}
const staged = (pipeline, kind, key) => pipeline.ready.stagedKeys().find((s) => s.kind === kind && s.key === key) ?? null;

/* ------------------------------------------------------------------ T1 */

test('T1 A 的共享档写 60 帧（含 1 帧超 300 KB）：collectSnapshotResult 的帧数、哈希与文件一致；pushResult 之后每个块在 snap 里都有', async () => {
  await withRoots(1, async ([rootA], make) => {
    const A = make(rootA);
    const srv = await harness.serve();
    const client = newClient(srv.base);
    const task = snapshotTask({ contentKey: sha256('card-T1'), from: 0, to: 59 });
    const idx = await seedSnapshots(A, task, range(0, 59));
    assert.deepEqual(idx.oversize, [[BIG, BIG]], '夹具：第 17 帧超限');
    assert.deepEqual(idx.frames, [[0, BIG - 1], [BIG + 1, 59]]);

    const { result, readBlob, raw } = unpack(await T().collectSnapshotResult(A, task));
    const dir = snapshotDir(rootA, { tier: 'shared', key: task.resultKey });
    assert.equal(result.v, 1);
    assert.equal(result.kind, 'snapshot');
    assert.equal(result.tier, 'shared');
    assert.equal(result.resultKey, task.resultKey);
    assert.equal(result.dirKey, task.resultKey, '共享档 dirKey = resultKey');
    assert.equal(result.entryKey, null, '共享档 entryKey 为 null');
    assert.deepEqual({ from: result.range.from, to: result.range.to }, { from: 0, to: 59 });
    assert.equal(result.canvasHeavy, false, 'DOM 卡 canvasHeavy 为 false');
    assert.equal(result.frames.length, 60, '超限的那一帧也在清单里');
    assert.deepEqual(result.frames, await expectedFrameList(dir, range(0, 59)), '[localFrame, sha256, bytes]，按帧升序');
    assert.ok(result.frames.every(([, h]) => HEX64.test(h)));
    assert.ok(JSON.stringify(raw).length <= RESULT_LIMIT, '清单 ≤ 256 KiB');
    for (const [n, h] of [result.frames[0], result.frames[BIG], result.frames[59]]) {
      const buf = await readBlob(h);
      assert.ok(Buffer.isBuffer(buf), `readBlob(${n}) 回 Buffer`);
      assert.equal(sha256(buf), h, `readBlob(${n}) 的字节对得上哈希`);
    }

    const pushed = await T().pushResult(client, raw, readBlob);
    const distinct = new Set(result.frames.map(([, h]) => h)).size;
    assert.equal(pushed.uploaded + pushed.skipped, distinct, `uploaded + skipped = 块数：${JSON.stringify({ uploaded: pushed.uploaded, skipped: pushed.skipped })}`);
    assert.equal(pushed.uploaded, distinct, '素材服务原来是空的：全部上传');
    assert.deepEqual(wire(pushed.result), result, 'pushResult 原样回清单');
    for (const [n, h, bytes] of result.frames) {
      const st = await srv.stores.snap.stat(h);
      assert.ok(st, `第 ${n} 帧的块在 snap 里`);
      assert.equal(st.size, bytes);
      assert.equal(await srv.stores.px.stat(h), null, `第 ${n} 帧的块不在 px 里`);
      assert.equal(await srv.stores.media.stat(h), null, `第 ${n} 帧的块不在 media 里`);
    }
    // 再推一次：全部跳过
    const again = await T().pushResult(client, raw, readBlob);
    assert.deepEqual([again.uploaded, again.skipped], [0, distinct], '已有的块不再上传');
  });
});

/* ------------------------------------------------------------------ T2 */

test('T2 B applyResult：controls-html/<dirKey>/ 与 A 逐字节相同、index.json 一致（含 oversize）；就绪索引 stageByKey 了这个键，会话收到 layer', async () => {
  await withRoots(2, async ([rootA, rootB], make) => {
    const A = make(rootA), B = make(rootB);
    const srv = await harness.serve();
    const client = newClient(srv.base);
    const task = snapshotTask({ contentKey: sha256('card-T2'), from: 0, to: 59 });
    await seedSnapshots(A, task, range(0, 59));
    const { result, readBlob, raw } = unpack(await T().collectSnapshotResult(A, task));
    await T().pushResult(client, raw, readBlob);

    const watch = watchEntry(B, { entryKey: sha256('entry-T2'), controls: [{ clipId: 'clip-x', snapshotKey: result.dirKey, tier: 'shared', capabilities: SHARED_CAPS, count: 60 }] });
    const out = await T().applyResult(B, client, wire(result));
    assert.equal(out.fetched, 60, `拉了 60 个块：${JSON.stringify(out)}`);
    assert.equal(out.skipped, 0);
    assert.ok(out.written >= 59, `written ${out.written}`);

    const dirA = snapshotDir(rootA, { tier: 'shared', key: result.dirKey });
    const dirB = snapshotDir(rootB, { tier: 'shared', key: result.dirKey });
    const fa = await filesOf(dirA), fb = await filesOf(dirB);
    const htmlNames = (f) => Object.keys(f).filter((n) => n.endsWith('.html'));
    assert.deepEqual(htmlNames(fb), htmlNames(fa), '帧文件同一批');
    for (const name of htmlNames(fa)) assert.ok(fb[name].equals(fa[name]), `${name} 逐字节相同`);
    assert.deepEqual(Object.keys(fb).sort(), [...htmlNames(fa), 'index.json'].sort(), 'B 的目录里没有别的文件（没有半截的 .tmp）');
    const ia = JSON.parse(fa['index.json'].toString('utf8')), ib = JSON.parse(fb['index.json'].toString('utf8'));
    assert.deepEqual(ib, ia, 'index.json 一致');
    assert.deepEqual(ib.oversize, [[BIG, BIG]], '超限帧由 B 的 commitSnapshots 自己判出来');
    assert.deepEqual(await B.snapshots().snapshotIndex({ tier: 'shared', key: result.dirKey }), await A.snapshots().snapshotIndex({ tier: 'shared', key: result.dirKey }));

    const hit = staged(B, 'html', result.dirKey);
    assert.ok(hit, `B 的就绪索引挂上了这个键：${JSON.stringify(B.ready.stagedKeys())}`);
    assert.deepEqual(hit.ranges, ib.frames, '范围与 index.json 的 frames 一致（不含超限帧）');
    const layer = watch.layers().find((m) => m.clipId === 'clip-x');
    assert.ok(layer, `用到这个键的会话收到了 layer：${JSON.stringify(watch.seen)}`);
    assert.deepEqual({ kind: layer.kind, key: layer.key, ranges: layer.ranges }, { kind: 'html', key: result.dirKey, ranges: ib.frames });
    // A 没被动过
    assert.equal(staged(A, 'html', result.dirKey), null, 'A 的索引不受 B 拉取影响');
  });
});

/* ------------------------------------------------------------------ T3 */

test('T3 本地档：dirKey 与 entryKey 的换算符合 E.9；B 落在 controls-local/<entryKey>/<dirKey>/', async () => {
  await withRoots(2, async ([rootA, rootB], make) => {
    const A = make(rootA), B = make(rootB);
    const srv = await harness.serve();
    const client = newClient(srv.base);
    const entryKey = sha256('entry-T3');
    const contentKey = sha256('card-T3');
    const task = snapshotTask({ tier: 'local', entryKey, contentKey, from: 10, to: 29, clipId: 'clip-l' });
    const expectDir = resultKeyOf(contentKey, TASK_FP);
    assert.equal(dirKeyOf(task), expectDir);
    assert.notEqual(task.resultKey, expectDir, '本地档的任务身份不等于落盘键（E.9）');
    await seedSnapshots(A, task, range(10, 29), { big: false });

    const { result, readBlob, raw } = unpack(await T().collectSnapshotResult(A, task));
    assert.equal(result.tier, 'local');
    assert.equal(result.resultKey, task.resultKey);
    assert.equal(result.entryKey, entryKey, '本地档 entryKey 必填');
    assert.equal(result.dirKey, expectDir, 'dirKey = resultKeyOf(去掉 "<entryKey>/" 前缀的内容键, 任务的锁指纹)');
    assert.notEqual(result.dirKey, resultKeyOf(contentKey, OWN_ENV.fingerprint), '用的是任务的锁指纹，不是本机指纹');
    assert.deepEqual({ from: result.range.from, to: result.range.to }, { from: 10, to: 29 });
    const dirA = snapshotDir(rootA, { tier: 'local', entryKey, key: expectDir });
    assert.deepEqual(result.frames, await expectedFrameList(dirA, range(10, 29)));
    await T().pushResult(client, raw, readBlob);

    const watch = watchEntry(B, { entryKey, controls: [{ clipId: 'clip-l', snapshotKey: expectDir, tier: 'local', capabilities: LOCAL_CAPS, count: 40 }] });
    const out = await T().applyResult(B, client, wire(result));
    assert.equal(out.fetched, 20);
    const dirB = path.join(rootB, 'controls-local', entryKey, expectDir);
    assert.equal(dirB, snapshotDir(rootB, { tier: 'local', entryKey, key: expectDir }));
    const fa = await filesOf(dirA), fb = await filesOf(dirB);
    assert.deepEqual(Object.keys(fb), Object.keys(fa));
    for (const name of Object.keys(fa)) {
      if (name === 'index.json') assert.deepEqual(JSON.parse(fb[name]), JSON.parse(fa[name]));
      else assert.ok(fb[name].equals(fa[name]), `${name} 逐字节相同`);
    }
    assert.deepEqual(await filesOf(path.join(rootB, 'controls-html')), {}, '本地档不落进共享档目录');
    const hit = staged(B, 'local', `${entryKey}/${expectDir}`);
    assert.ok(hit, `线上的键是 <entryKey>/<dirKey>：${JSON.stringify(B.ready.stagedKeys())}`);
    assert.deepEqual(hit.ranges, [[10, 29]]);
    const layer = watch.layers().find((m) => m.clipId === 'clip-l');
    assert.ok(layer, '用到这个键的会话收到了 layer');
    assert.deepEqual({ kind: layer.kind, key: layer.key, ranges: layer.ranges }, { kind: 'local', key: `${entryKey}/${expectDir}`, ranges: [[10, 29]] });
  });
});

/* ------------------------------------------------------------------ T4 */

test('T4 B 已经有一部分帧：只下载缺的（数 get 次数），已有的不覆盖', async () => {
  await withRoots(2, async ([rootA, rootB], make) => {
    const A = make(rootA), B = make(rootB);
    const srv = await harness.serve();
    const client = newClient(srv.base);
    const task = snapshotTask({ contentKey: sha256('card-T4'), from: 0, to: 59 });
    await seedSnapshots(A, task, range(0, 59));
    // B 先有 0～29（内容和 A 的不同：能看出有没有被覆盖）
    await seedSnapshots(B, task, range(0, 29), { tag: 'B', big: false });
    const dirB = snapshotDir(rootB, { tier: 'shared', key: task.resultKey });
    const before = await filesOf(dirB);

    const { result, readBlob, raw } = unpack(await T().collectSnapshotResult(A, task));
    await T().pushResult(client, raw, readBlob);
    const counting = countingClient(client);
    const out = await T().applyResult(B, counting, wire(result));

    const want = new Set(result.frames.filter(([n]) => n >= 30).map(([, h]) => h));
    assert.equal(counting.gets.length, want.size, `只下载缺的 30 帧：实际 ${counting.gets.length} 次 get`);
    assert.ok(counting.gets.every((g) => g.ns === 'snap' && want.has(g.hash)), '下载的都是缺的帧的块');
    assert.equal(counting.puts.length, 0, '拉取不上传');
    assert.deepEqual([out.fetched, out.skipped], [30, 30], JSON.stringify(out));

    const after_ = await filesOf(dirB);
    for (const n of range(0, 29)) assert.ok(after_[`${n}.html`].equals(before[`${n}.html`]), `第 ${n} 帧（B 已有）不覆盖`);
    const dirA = snapshotDir(rootA, { tier: 'shared', key: task.resultKey });
    const fa = await filesOf(dirA);
    for (const n of range(30, 59)) assert.ok(after_[`${n}.html`].equals(fa[`${n}.html`]), `第 ${n} 帧（拉来的）与 A 相同`);
    const idx = await B.snapshots().snapshotIndex({ tier: 'shared', key: task.resultKey });
    assert.deepEqual(idx.frames, [[0, 59]], 'B 自己的第 17 帧不超限；拉来的帧都进了索引');
    assert.deepEqual(staged(B, 'html', task.resultKey)?.ranges, [[0, 59]]);

    // 再 apply 一次：一个都不下载
    const again = countingClient(client);
    const out2 = await T().applyResult(B, again, wire(result));
    assert.equal(again.gets.length, 0, '全都有了：不下载');
    assert.equal(out2.fetched, 0);
  });
});

/* ------------------------------------------------------------------ T5 */

const A_ENCODER = 'h264_nvenc';
const B_ENCODER = 'libx264';

/**
 * 在 root 下按 `frame-stream.mjs` 的格式手工造一条流：`segments` 这些分段用 init1，`extra` 这些分段用 init2
 * （给「只列本段用到的 init」用）。回 { manifest, files: { name: Buffer } }。
 */
async function writeStreamFixture(root, { streamKey, segments, extra = [], encoder = A_ENCODER, seed = 1 }) {
  const dir = path.join(root, 'streams', streamKey);
  await fs.mkdir(dir, { recursive: true });
  const bound = { x: 0, y: 0, w: 64, h: 64 };
  const tight = { x: 8, y: 8, w: 48, h: 48 };
  const init1 = Buffer.concat([Buffer.from('....ftypiso6'), crypto.createHash('sha512').update(`init1-${seed}`).digest()]);
  const init2 = Buffer.concat([Buffer.from('....ftypiso6'), crypto.createHash('sha512').update(`init2-${seed}`).digest()]);
  const id1 = sha16(init1), id2 = sha16(init2);
  const files = { [`init-${id1}.mp4`]: init1 };
  const manifest = {
    // `originFrame`:这条流自己的第一帧(分段从它起数);清单不带它的结果别处不收(`streamAdoption`)
    version: 1, streamKey, kind: 'card', plane: 'local', clipIds: ['clip-s'], fps: 30, originFrame: 45, bound, offset: { x: 32, y: 32 }, tight,
    inits: { [id1]: { codec: 'avc1.64001f', width: 48, height: 96, timescale: 15360, rect: tight, encoder, bytes: init1.length } },
    segments: {},
  };
  if (extra.length) {
    files[`init-${id2}.mp4`] = init2;
    manifest.inits[id2] = { codec: 'avc1.64001f', width: 64, height: 128, timescale: 15360, rect: bound, encoder, bytes: init2.length };
  }
  for (const n of [...segments, ...extra]) {
    const useExtra = extra.includes(n);
    const bytes = Buffer.concat([Buffer.from('....moof'), crypto.createHash('sha512').update(`seg-${seed}-${n}`).digest(), Buffer.alloc(200 + n, n)]);
    const file = `${n}-${sha16(bytes)}.m4s`;
    files[file] = bytes;
    const stride = useExtra ? 3 : 1;
    const rect = useExtra ? bound : tight;
    manifest.segments[n] = {
      file, init: useExtra ? id2 : id1, stride, samples: 15, bytes: bytes.length, encodeMs: 20, tailMs: 5,
      sig: segmentSignature({ streamKey, segment: n, stride, encoder, rect }), dropped: [], at: 1,
    };
  }
  for (const [name, buf] of Object.entries(files)) await fs.writeFile(path.join(dir, name), buf);
  await fs.writeFile(path.join(dir, 'stream.json'), JSON.stringify(manifest));
  return { manifest, files, dir };
}

function producerOf(pipeline) {
  const p = typeof pipeline.streams === 'function' ? pipeline.streams() : pipeline.streamProducer();
  assert.ok(p, '拿不到流生产者（streams() / streamProducer()）');
  p.attachRoute();
  p.encoderName = B_ENCODER; // 本机编码器名与 A 不同（勘察结论第 2 条的情形）；不探测
  return p;
}

test('T5 流：collectStreamResult、pushResult，B adoptSegments：分段文件相同，清单合进生产者状态，拉来的分段不判 stale，ready 发布 stream 范围', async () => {
  await withRoots(3, async ([rootA, rootB, rootC], make) => {
    const A = make(rootA, { interactive: true });
    const srv = await harness.serve();
    const client = newClient(srv.base);
    const contentKey = sha256('stream-T5');
    const streamKey = resultKeyOf(contentKey, TASK_FP);
    const fx = await writeStreamFixture(rootA, { streamKey, segments: [0, 1, 2, 3], extra: [4] });
    const task = streamTask({ streamKey, contentKey, from: 0, to: 3 });

    const { result, readBlob, raw } = unpack(await T().collectStreamResult(A, task));
    assert.equal(result.v, 1);
    assert.equal(result.kind, 'stream');
    assert.equal(result.resultKey, streamKey);
    assert.deepEqual({ from: result.range.from, to: result.range.to }, { from: 0, to: 3 });
    const top = fx.manifest;
    assert.deepEqual(result.header, { kind: top.kind, plane: top.plane, clipIds: top.clipIds, fps: top.fps, originFrame: 45, bound: top.bound, offset: top.offset, tight: top.tight }, 'header 取自 stream.json 顶层(含这条流的第一帧)');
    const [id1, id2] = Object.keys(top.inits);
    assert.deepEqual(Object.keys(result.inits), [id1], '只列本段分段用到的 init（第 4 段的 init 不在）');
    const init1 = fx.files[`init-${id1}.mp4`];
    assert.deepEqual(result.inits[id1], { hash: sha256(init1), bytes: init1.length, codec: top.inits[id1].codec, width: 48, height: 96, timescale: 15360, rect: top.tight, encoder: A_ENCODER });
    assert.deepEqual(Object.keys(result.segments).map(Number).sort((a, b) => a - b), [0, 1, 2, 3], '只列本段范围里的分段');
    for (const n of [0, 1, 2, 3]) {
      const s = top.segments[n];
      const bytes = fx.files[s.file];
      assert.deepEqual(result.segments[n], { hash: sha256(bytes), bytes: bytes.length, init: id1, stride: 1, samples: 15, sig: s.sig, encoder: A_ENCODER }, `第 ${n} 段`);
    }
    assert.equal(id2 in result.inits, false);

    const pushed = await T().pushResult(client, raw, readBlob);
    assert.equal(pushed.uploaded + pushed.skipped, 5, '1 个 init + 4 个分段');
    for (const h of [result.inits[id1].hash, ...[0, 1, 2, 3].map((n) => result.segments[n].hash)]) {
      assert.ok(await srv.stores.px.stat(h), `${h.slice(0, 8)} 在 px 里`);
      assert.equal(await srv.stores.snap.stat(h), null, '流的块不进 snap');
    }

    // B：这条流在 B 上没有状态
    const B = make(rootB, { interactive: true });
    const prodB = producerOf(B);
    assert.equal(prodB.streams.get(streamKey), undefined, '夹具：B 上没有这条流的状态');
    await T().applyResult(B, client, wire(result));
    const dirA = fx.dir, dirB = path.join(rootB, 'streams', streamKey);
    const fb = await filesOf(dirB);
    for (const name of [`init-${id1}.mp4`, ...[0, 1, 2, 3].map((n) => top.segments[n].file)]) {
      assert.ok(fb[name], `B 有 ${name}`);
      assert.ok(fb[name].equals(await fs.readFile(path.join(dirA, name))), `${name} 与 A 相同`);
    }
    assert.equal(fb[top.segments[4].file], undefined, '范围外的分段不拉');
    assert.equal(fb[`init-${id2}.mp4`], undefined, '范围外的 init 不拉');
    assert.ok(Object.keys(fb).every((n) => !n.endsWith('.tmp')), '没有半截文件');

    const state = prodB.streams.get(streamKey);
    assert.ok(state?.manifest, '清单合进了生产者在内存里的状态（没有就新建）');
    const disk = JSON.parse(fb['stream.json'].toString('utf8'));
    for (const m of [state.manifest, disk]) {
      assert.equal(m.streamKey, streamKey);
      assert.deepEqual(Object.keys(m.segments).map(Number).sort((a, b) => a - b), [0, 1, 2, 3]);
      for (const n of [0, 1, 2, 3]) {
        const seg = m.segments[n];
        assert.equal(seg.file, top.segments[n].file, `第 ${n} 段的文件名照现有命名`);
        assert.equal(seg.init, id1);
        assert.equal(seg.adopted, true, `第 ${n} 段记 adopted: true`);
        assert.equal(seg.sig, top.segments[n].sig, `第 ${n} 段带对方的 sig`);
        assert.equal(seg.encoder, A_ENCODER, `第 ${n} 段带对方的 encoder`);
      }
      assert.ok(m.inits[id1], 'init 进了清单');
    }
    assert.deepEqual(disk.segments, JSON.parse(JSON.stringify(state.manifest.segments)), 'stream.json 经 StreamStore.save 落盘，与内存一致');
    for (const n of [0, 1, 2, 3]) assert.notEqual(prodB.segmentState(state, n), 'stale', `第 ${n} 段（A 用 ${A_ENCODER} 编、B 的编码器是 ${B_ENCODER}）不判 stale`);
    const hit = staged(B, 'stream', streamKey);
    assert.ok(hit, `ready 挂上了 kind: 'stream'：${JSON.stringify(B.ready.stagedKeys())}`);
    assert.deepEqual(hit.ranges, [[0, 3]], '单位是分段号');

    // C：这条流在 C 上已经有状态，第 0 段是 C 自己编的、不 stale：跳过、不覆盖；其余拉来；合进同一个 state
    const C = make(rootC, { interactive: true });
    const prodC = producerOf(C);
    const own = await writeStreamFixture(rootC, { streamKey, segments: [0], encoder: B_ENCODER, seed: 99 });
    const spec = { streamKey, contentKey, envFingerprint: TASK_FP, kind: 'card', plane: 'local', clipIds: ['clip-s'], topClipId: 'clip-s', fps: 30,
      bound: own.manifest.bound, offset: own.manifest.offset, firstSegment: 0, lastSegment: 4, total: 75, members: [] };
    const cState = { spec, manifest: JSON.parse(JSON.stringify(own.manifest)), aliases: new Set(), entryKey: sha256('entry-T5'), reserved: new Set(), failures: new Map(), measured: null, measuredSegments: new Set() };
    prodC.streams.set(streamKey, cState);
    prodC.entryKey = cState.entryKey;
    assert.equal(prodC.segmentState(cState, 0), 'dense', '夹具：C 的第 0 段新鲜');
    const watch = watchEntry(C, { entryKey: cState.entryKey, controls: [] });
    await T().applyResult(C, client, wire(result));
    assert.equal(prodC.streams.get(streamKey), cState, '合进已有的 state，不换对象');
    const mc = cState.manifest;
    assert.equal(mc.segments[0].file, own.manifest.segments[0].file, '第 0 段（本机已有、不 stale）不覆盖');
    assert.notEqual(mc.segments[0].adopted, true);
    assert.equal(mc.segments[0].sig, own.manifest.segments[0].sig);
    const fc = await filesOf(path.join(rootC, 'streams', streamKey));
    assert.ok(fc[own.manifest.segments[0].file].equals(own.files[own.manifest.segments[0].file]), '第 0 段的文件没被改');
    for (const n of [1, 2, 3]) {
      assert.equal(mc.segments[n].adopted, true, `第 ${n} 段拉来`);
      assert.ok(fc[top.segments[n].file]?.equals(fx.files[top.segments[n].file]), `第 ${n} 段文件与 A 相同`);
      assert.notEqual(prodC.segmentState(cState, n), 'stale');
    }
    assert.deepEqual(JSON.parse(fc['stream.json']).segments, JSON.parse(JSON.stringify(mc.segments)), '落盘与内存一致');
    const layer = watch.layers().filter((m) => m.kind === 'stream' && m.key === streamKey).at(-1);
    assert.ok(layer, `照现有的 publish(state) 发了 stream 层：${JSON.stringify(watch.seen)}`);
    assert.deepEqual({ clipId: layer.clipId, ranges: layer.ranges }, { clipId: 'clip-s', ranges: [[0, 3]] });
  });
});

/* ------------------------------------------------------------------ T6 */

test('T6 createAssetSink：本机帧库覆盖完整时 has 为真；put 回 { complete: true, result }；缺一帧 / 推失败时 { complete: false }', async () => {
  await withRoots(3, async ([rootA, rootA2, rootS], make) => {
    const A = make(rootA), A2 = make(rootA2), S = make(rootS, { interactive: true });
    const srv = await harness.serve();
    const client = newClient(srv.base);
    const task = snapshotTask({ contentKey: sha256('card-T6'), from: 0, to: 59 });
    await seedSnapshots(A, task, range(0, 59));
    // A2 缺第 30 帧
    await seedSnapshots(A2, task, [...range(0, 29), ...range(31, 59)]);
    const ref = (t) => ({ resultKey: t.resultKey, kind: t.kind, tier: t.tier, range: t.range, input: t.input, requires: t.requires });
    const meta = (t) => ({ taskId: t.id, nodeId: 'node-1', token: 'lease-token' });

    const sink = T().createAssetSink({ pipeline: A, client });
    assert.equal(await sink.has(ref(task)), true, '本机覆盖了整个 range（超限帧也算有）');
    const r = await sink.put({ ...ref(task), artifacts: null, meta: meta(task) });
    assert.equal(r.complete, true);
    const expected = unpack(await T().collectSnapshotResult(A, task)).result;
    assert.deepEqual(wire(r.result), expected, 'result 就是第 3 节的清单');
    assert.ok(JSON.stringify(r.result).length <= RESULT_LIMIT);
    for (const [n, h] of expected.frames) assert.ok(await srv.stores.snap.stat(h), `put 推完了第 ${n} 帧`);

    const sink2 = T().createAssetSink({ pipeline: A2, client });
    assert.equal(await sink2.has(ref(task)), false, '缺一帧：has 为假');
    const sub = snapshotTask({ contentKey: sha256('card-T6'), from: 0, to: 29 });
    assert.equal(await sink2.has(ref(sub)), true, '只问 0～29：覆盖了');
    const r2 = await sink2.put({ ...ref(task), artifacts: null, meta: meta(task) });
    assert.equal(r2.complete, false, '缺一帧：put 回 complete: false');

    // 块推失败：complete: false
    const broken = { ...client, put: async () => { throw Object.assign(new Error('push failed'), { status: 503 }); }, has: client.has, get: client.get };
    const other = snapshotTask({ contentKey: sha256('card-T6'), from: 0, to: 59, fp: OWN_ENV.fingerprint });
    await seedSnapshots(A, other, range(0, 59), { tag: 'A-own' });
    const r3 = await T().createAssetSink({ pipeline: A, client: broken }).put({ ...ref(other), artifacts: null, meta: meta(other) });
    assert.equal(r3.complete, false, '推失败：put 回 complete: false');
    // HR26（`docs/plan/hosted-render-contract.md` 第 6 节）：素材服务回 507 service-quota（渲染服务的产物到了容量上限）——不回 incomplete（那是可重试的），抛不可重试的错
    const overQuota = { ...client, put: async () => { throw Object.assign(new Error('asset 507'), { status: 507, body: { error: 'service-quota' } }); }, has: client.has, get: client.get };
    await assert.rejects(
      () => T().createAssetSink({ pipeline: A, client: overQuota }).put({ ...ref(other), artifacts: null, meta: meta(other) }),
      (e) => e.code === 'service-quota' && e.retryable === false && e.status === 507,
      '到了容量上限：抛 service-quota、不可重试',
    );

    // 流：has / put
    const contentKey = sha256('stream-T6');
    const streamKey = resultKeyOf(contentKey, TASK_FP);
    await writeStreamFixture(rootS, { streamKey, segments: [0, 1, 2] });
    const st = streamTask({ streamKey, contentKey, from: 0, to: 2 });
    const ssink = T().createAssetSink({ pipeline: S, client });
    assert.equal(await ssink.has(ref(st)), true, '流：分段 0～2 都有');
    assert.equal(await ssink.has(ref(streamTask({ streamKey, contentKey, from: 0, to: 4 }))), false, '流：缺 3、4');
    const r4 = await ssink.put({ ...ref(st), artifacts: null, meta: meta(st) });
    assert.equal(r4.complete, true);
    assert.equal(r4.result.kind, 'stream');
    assert.deepEqual(Object.keys(r4.result.segments).map(Number).sort(), [0, 1, 2]);
    for (const n of [0, 1, 2]) assert.ok(await srv.stores.px.stat(r4.result.segments[n].hash));
    const r5 = await ssink.put({ ...ref(streamTask({ streamKey, contentKey, from: 0, to: 4 })), artifacts: null, meta: meta(st) });
    assert.equal(r5.complete, false, '流缺分段：complete: false');
  });
});

/* ------------------------------------------------------------------ T7 */

test('T7 result 超过 256 KiB（人为造大）：报错，不截断', async () => {
  await withRoots(1, async ([rootA], make) => {
    const A = make(rootA);
    const srv = await harness.serve();
    const client = newClient(srv.base);
    // 每帧一项约 80 字节：3600 帧的清单约 290 KB。帧内容相同（推送时只有一个块，省时间）
    const N = 3600;
    const task = snapshotTask({ contentKey: sha256('card-T7'), from: 0, to: N - 1 });
    await A.snapshots().commitSnapshots({ tier: 'shared', key: task.resultKey, clipId: 'clip-x', capabilities: SHARED_CAPS,
      items: range(0, N - 1).map((n) => ({ localFrame: n, html: '<div>same</div>' })) });

    let collected = null, collectError = null;
    try { collected = unpack(await T().collectSnapshotResult(A, task)); } catch (err) { collectError = err; }
    if (collected) {
      assert.equal(collected.result.frames.length, N, 'collect 没报错时清单不许截断');
      await assert.rejects(T().pushResult(client, collected.raw, collected.readBlob), 'collect 不报错，pushResult 也要报错');
    } else {
      assert.ok(collectError instanceof Error, 'collectSnapshotResult 报错');
      assert.doesNotMatch(String(collectError.message), /^载不进/, collectError.message);
    }
    // sink 不能把它当成收全了
    const r = await T().createAssetSink({ pipeline: A, client }).put({ resultKey: task.resultKey, kind: 'snapshot', tier: 'shared', range: task.range, input: task.input, requires: task.requires, artifacts: null, meta: { taskId: task.id, nodeId: 'n', token: 't' } })
      .then((v) => v, (e) => ({ error: e }));
    assert.ok(r.error instanceof Error || r.complete === false, `sink.put 报错或 complete: false，不许回 complete: true：${JSON.stringify(r).slice(0, 200)}`);
    if (!r.error) assert.equal(r.result, undefined);
  });
});

/* ------------------------------------------------------------------ T8 */

test('T8 applyResult 遇到素材服务上没有的块（404）：整体失败、抛错；已写下的帧都在索引里，不留半截文件', async () => {
  await withRoots(2, async ([rootA, rootB], make) => {
    const A = make(rootA), B = make(rootB);
    const srv = await harness.serve();
    const client = newClient(srv.base);
    const task = snapshotTask({ contentKey: sha256('card-T8'), from: 0, to: 59 });
    await seedSnapshots(A, task, range(0, 59));
    const { result, readBlob } = unpack(await T().collectSnapshotResult(A, task));
    // 推的时候漏掉第 40 帧
    const MISSING = 40;
    await T().pushResult(client, { ...result, frames: result.frames.filter(([n]) => n !== MISSING) }, readBlob);
    const lost = result.frames.find(([n]) => n === MISSING)[1];
    assert.equal(await client.has('snap', lost), false, '夹具：第 40 帧的块不在素材服务上');

    await assert.rejects(T().applyResult(B, client, wire(result)), '缺块：整体失败');

    const dirB = snapshotDir(rootB, { tier: 'shared', key: result.dirKey });
    const files = await filesOf(dirB);
    const names = Object.keys(files);
    assert.ok(names.every((n) => n === 'index.json' || /^\d+\.html$/.test(n)), `不留半截文件：${names.filter((n) => n !== 'index.json' && !/^\d+\.html$/.test(n))}`);
    assert.equal(files[`${MISSING}.html`], undefined, '缺的那一帧没有文件');
    const idx = await B.snapshots().snapshotIndex({ tier: 'shared', key: result.dirKey });
    const inIndex = new Set([...idx.frames, ...idx.oversize].flatMap(([a, b]) => range(a, b)));
    const onDisk = new Set(names.filter((n) => n.endsWith('.html')).map((n) => Number(n.slice(0, -5))));
    assert.deepEqual([...onDisk].sort((a, b) => a - b), [...inIndex].sort((a, b) => a - b), '盘上的帧和 index.json 对得上（经 commitSnapshots 写的）');
    assert.equal(inIndex.has(MISSING), false);
    const fa = await filesOf(snapshotDir(rootA, { tier: 'shared', key: result.dirKey }));
    for (const n of onDisk) assert.ok(files[`${n}.html`].equals(fa[`${n}.html`]), `已写下的第 ${n} 帧是完整的`);
  });
});

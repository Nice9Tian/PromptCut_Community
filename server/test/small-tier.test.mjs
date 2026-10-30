/**
 * 预渲染小尺寸(`docs/plan/c10a-contract.md` 第 9 节):尺寸规则、两档分开就绪、清单与推送、给在线页面的层表。
 * 跑:node --experimental-test-module-mocks --test server/test/small-tier.test.mjs
 *
 * 不起 Chrome(`bakery/index.mjs` 换成假的,调用就记一笔并抛):生成小位图本身由 `scripts/probes/small-tier-probe.mjs`
 * 在真的预渲染 Chrome 里验;这里验的是它之外的一切 —— 尺寸、清单、推送、完成条件、层表、什么时候不生成。
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

const { FramePipeline } = await import('../frame-pipeline.mjs');
const { describeEnvironment, resultKeyOf } = await import('../render-node/fingerprint.mjs');
const T = await import('../artifact-transfer.mjs');
const { createPushQueue } = await import('../artifact-push.mjs');
const { smallScale, smallSize, webpSize, isWebp, SMALL_SUFFIX, SMALL_WEBP_QUALITY } = await import('../bakery/small-bitmap.mjs');

const OWN_ENV = describeEnvironment({
  platform: 'win32', renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  vendor: 'Google Inc. (Google)', chromeVersion: 'HeadlessChrome/138.0.7204.49',
});
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const roots = [];
const pipelines = [];
after(async () => {
  await Promise.allSettled(pipelines.map((p) => p.close()));
  await Promise.all(roots.map((r) => fs.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});
async function makePipeline() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-c10a-small-'));
  roots.push(root);
  const p = new FramePipeline({ root, origin: () => 'http://127.0.0.1:1', environment: OWN_ENV, dataRoot: root, interactive: false });
  pipelines.push(p);
  return p;
}
/** 假素材服务客户端:按 (ns, hash) 存 */
function memClient() {
  const blobs = new Map();
  const puts = [];
  return {
    blobs, puts,
    async put(ns, bytes, { ext } = {}) {
      const hash = sha256(bytes);
      const id = `${ns}/${hash}`;
      puts.push({ ns, hash, ext });
      const uploaded = !blobs.has(id);
      blobs.set(id, { bytes: Buffer.from(bytes), ext });
      return { hash, uploaded };
    },
    async has(ns, hash) { return blobs.has(`${ns}/${hash}`); },
    async get(ns, hash) { return blobs.get(`${ns}/${hash}`)?.bytes ?? null; },
  };
}
/** 一张像样的 WebP 头(VP8X,带 alpha 标记),尺寸 w×h;后面的字节随便 */
function fakeWebp(w, h, salt = 0) {
  const b = Buffer.alloc(40 + salt);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(b.length - 8, 4); b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii'); b.writeUInt32LE(10, 16); b[20] = 0x10;
  b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  return b;
}
const html = (n) => `<div style="position:absolute;left:${n}px;top:0;width:10px;height:10px;background:red"></div>`;

/* ------------------------------------------------------------------ 尺寸规则 */

test('ST1 尺寸:等比缩进 800×600 以内,不放大,保持画幅(16:9 → 800×450,9:16 → 337×600)', () => {
  assert.deepEqual(smallSize({ projectWidth: 1920, projectHeight: 1080 }), { scale: 800 / 1920, width: 800, height: 450 });
  assert.deepEqual(smallSize({ projectWidth: 1080, projectHeight: 1920 }), { scale: 600 / 1920, width: 337, height: 600 });
  assert.deepEqual(smallSize({ projectWidth: 3840, projectHeight: 2160 }), { scale: 800 / 3840, width: 800, height: 450 });
  assert.deepEqual(smallSize({ projectWidth: 1000, projectHeight: 1000 }), { scale: 0.6, width: 600, height: 600 });
  assert.deepEqual(smallSize({ projectWidth: 640, projectHeight: 360 }), { scale: 1, width: 640, height: 360 }, '不放大');
  assert.equal(smallScale(0, 0), 1);
  // 设了框的卡:框按项目的同一个缩放比缩(小位图铺满页面上包裹层里的快照平面)
  assert.deepEqual(smallSize({ projectWidth: 1920, projectHeight: 1080, boxWidth: 600, boxHeight: 300 }), { scale: 800 / 1920, width: 250, height: 125 });
  assert.deepEqual(smallSize({ projectWidth: 1920, projectHeight: 1080, boxWidth: 1, boxHeight: 1 }), { scale: 800 / 1920, width: 1, height: 1 }, '至少 1 像素');
  assert.equal(SMALL_WEBP_QUALITY, 80);
});

test('ST2 WebP 头:认得出、读得出尺寸', () => {
  const w = fakeWebp(800, 450);
  assert.equal(isWebp(w), true);
  assert.deepEqual(webpSize(w), { width: 800, height: 450 });
  assert.equal(isWebp(Buffer.from('not a webp at all')), false);
  assert.equal(webpSize(Buffer.from('RIFF')), null);
});

/* ------------------------------------------------------------------ 清单:两档分开记 */

async function seed(p, key, frames) {
  await p.snapshots().commitSnapshots({ tier: 'shared', key, clipId: 'c1', capabilities: {}, items: frames.map((f) => ({ localFrame: f, html: html(f) })) });
  return p.snapshots().dir({ tier: 'shared', key });
}
const task = (key, from, to) => ({ kind: 'snapshot', tier: 'shared', resultKey: key, range: { from, to }, input: {} });

test('ST3 清单:没有小位图时和 C6.4 一字不差(不带 small 项);有的帧另列一张 small 表,frames 不变', async () => {
  const p = await makePipeline();
  const key = 'k'.repeat(64).replace(/k/g, 'a');
  const dir = await seed(p, key, [0, 1, 2, 3]);
  const before = (await T.collectSnapshotResult(p, task(key, 0, 3))).result;
  assert.equal('small' in before, false, '没有小位图就不带这一项');
  await fs.writeFile(path.join(dir, `1${SMALL_SUFFIX}`), fakeWebp(800, 450, 1));
  await fs.writeFile(path.join(dir, `3${SMALL_SUFFIX}`), fakeWebp(800, 450, 3));
  const after = (await T.collectSnapshotResult(p, task(key, 0, 3))).result;
  assert.deepEqual(after.frames, before.frames, '原尺寸的表不受小尺寸影响');
  assert.deepEqual(after.small.map(([f]) => f), [1, 3]);
  assert.equal(after.small[0][1], sha256(fakeWebp(800, 450, 1)));
  // 小尺寸就绪不能当作原尺寸就绪:只有小位图、没有 HTML 的帧不进任何一张表
  await fs.writeFile(path.join(dir, `5${SMALL_SUFFIX}`), fakeWebp(800, 450, 5));
  const wider = (await T.collectSnapshotResult(p, task(key, 0, 7))).result;
  assert.deepEqual(wider.frames.map(([f]) => f), [0, 1, 2, 3]);
  assert.deepEqual(wider.small.map(([f]) => f), [1, 3], '没有原尺寸的帧不列小尺寸');
  assert.ok(T.manifestMatches(after, task(key, 0, 3)));
  assert.deepEqual(T.smallFramesOf(after).length, 2);
});

test('ST4 清单形状:small 表形状不对就不认这份清单', () => {
  const ok = { v: 1, kind: 'snapshot', resultKey: 'x', range: { from: 0, to: 1 }, frames: [[0, 'a'.repeat(64), 1]], small: [[0, 'b'.repeat(64), 1]] };
  assert.equal(T.manifestMatches(ok, { kind: 'snapshot', resultKey: 'x', range: { from: 0, to: 1 } }), true);
  assert.equal(T.manifestMatches({ ...ok, small: [[0, 'nothex', 1]] }, { kind: 'snapshot', resultKey: 'x', range: { from: 0, to: 1 } }), false);
  assert.equal(T.manifestMatches({ ...ok, small: 'x' }, { kind: 'snapshot', resultKey: 'x', range: { from: 0, to: 1 } }), false);
  assert.deepEqual(T.smallFramesOf({ small: [[0, 'nothex']] }), []);
});

test('ST5 推送:两档都推到素材服务(HTML 进 snap,小位图 WebP 进 px),推送本身不渲染', async () => {
  const p = await makePipeline();
  const key = 'b'.repeat(64);
  const dir = await seed(p, key, [0, 1]);
  await fs.writeFile(path.join(dir, `0${SMALL_SUFFIX}`), fakeWebp(800, 450, 0));
  await fs.writeFile(path.join(dir, `1${SMALL_SUFFIX}`), fakeWebp(800, 450, 1));
  const client = memClient();
  const calls = bakeryCalls.length;
  const { result, readBlob } = await T.collectSnapshotResult(p, task(key, 0, 1));
  await T.pushResult(client, result, readBlob);
  const px = client.puts.filter((x) => x.ns === 'px');
  const snap = client.puts.filter((x) => x.ns === 'snap');
  assert.equal(snap.length, 2);
  assert.equal(px.length, 2);
  assert.ok(px.every((x) => x.ext === 'webp'));
  for (const [, hash] of result.small) assert.ok(await client.has('px', hash), `小位图 ${hash} 在素材服务上`);
  assert.equal(bakeryCalls.length, calls, '推送不触发渲染');
});

test('ST6 完成条件:列清单前等正在生成的小尺寸落定,两档一起进这一段的清单', async () => {
  const p = await makePipeline();
  const key = 'c'.repeat(64);
  const dir = await seed(p, key, [0, 1]);
  // 模拟「小尺寸还在生成」:链上挂一个 60 ms 之后才写文件的活
  p.smallChain = new Promise((resolve) => setTimeout(async () => {
    await fs.writeFile(path.join(dir, `0${SMALL_SUFFIX}`), fakeWebp(800, 450, 0));
    await fs.writeFile(path.join(dir, `1${SMALL_SUFFIX}`), fakeWebp(800, 450, 1));
    resolve();
  }, 60));
  const { result } = await T.collectSnapshotResult(p, task(key, 0, 1));
  assert.deepEqual(result.small.map(([f]) => f), [0, 1]);
  // 链上的活失败了也不挡原尺寸
  p.smallChain = Promise.reject(new Error('坏了'));
  const again = (await T.collectSnapshotResult(p, task(key, 0, 1))).result;
  assert.deepEqual(again.frames.map(([f]) => f), [0, 1]);
});

/* ------------------------------------------------------------------ 什么时候不生成 */

test('ST7 什么时候排:没配推送队列不排;配了就记下、等预渲染间换页时再画(不开 Chrome);拉来的帧不排', async () => {
  const p = await makePipeline();
  const calls = bakeryCalls.length;
  const args = { tier: 'shared', key: 'd'.repeat(64), clipId: 'c1', items: [{ localFrame: 0, html: html(0) }] };
  assert.equal(p.scheduleSmallSnapshots(args), false, '没配推送队列');
  p.pushQueue = { enqueue: async () => {} };
  assert.equal(p.smallTierEnabled(), false, '己二：小尺寸已停产，配了推送队列也默认为 false');
  p.smallTierEnabled = () => true; // 单测下显式打开以测试排期逻辑
  assert.equal(p.scheduleSmallSnapshots(args), true, '记下来');
  assert.equal(p.smallPending.length, 1);
  assert.equal(p.scheduleSmallSnapshots({ ...args, adopted: true }), false, '拉来的帧');
  // 攒太多只留最新的
  for (let i = 0; i < 600; i++) p.scheduleSmallSnapshots({ ...args, items: [{ localFrame: i, html: html(i) }] });
  assert.ok(p.smallPending.reduce((n, j) => n + j.items.length, 0) <= 480);
  assert.ok(p.smallStats.dropped > 0);
  p.smallPending = [];
  // commitSnapshots 的钩子照常进推送队列,但不开 Chrome
  await p.snapshots().commitSnapshots(args);
  assert.equal(bakeryCalls.length, calls, '一次 openBakery 都没有');
  p.smallPending = [];
  p.smallTierEnabled = FramePipeline.prototype.smallTierEnabled;
  assert.equal(p.smallTierEnabled(), false);
  p.pushQueue = null;
});

/* ------------------------------------------------------------------ 层表 */

test('ST8 层表:列预渲染集合里产快照的卡,共享档结果键 = 共享键,本地档按 E.9 算;判轻的、不产快照的不列', () => {
  const fp = OWN_ENV.fingerprint;
  const entry = {
    key: 'entry1', project: { id: 'proj-1', fps: 30, width: 1920, height: 1080 },
    cardPlan: [
      { clipId: 'a', snapshotKey: 'S'.repeat(8), tier: 'shared', sampling: { firstFrame: 30 }, count: 90 },
      { clipId: 'b', snapshotKey: 'L'.repeat(8), contentKey: 'ck-b', envFingerprint: fp, tier: 'local', sampling: { firstFrame: 0 }, count: 45 },
      { clipId: 'c', snapshotKey: 'X'.repeat(8), tier: 'shared', sampling: { firstFrame: 0 }, count: 10 },
      { clipId: 'd', snapshotKey: null, tier: 'none', sampling: { firstFrame: 0 }, count: 10 },
    ],
  };
  const body = T.layerMapOf(entry, { picked: (id) => id !== 'c', fingerprint: fp, now: 123 });
  assert.equal(body.kind, 'layer-map');
  assert.equal(body.projectId, 'proj-1');
  assert.equal(body.span, 60);
  assert.equal(body.at, 123);
  assert.deepEqual(body.layers.map((l) => l.clipId), ['a', 'b']);
  // C10 契约第 18 节第 3 条:层表 v 2,每层带 contentKey(共享档内容键,取不到为 null)与 envFingerprint;
  // M7 契约 D12 升 v 3:另带候选表,没有切分记录时只有自己一个候选,等于层上的字段
  assert.equal(body.v, 3);
  assert.deepEqual(body.layers[0], { clipId: 'a', kind: 'html', key: 'S'.repeat(8), tier: 'shared', resultKey: 'S'.repeat(8), dirKey: 'S'.repeat(8), entryKey: null, firstFrame: 30, count: 90,
    contentKey: null, envFingerprint: fp, candidates: [{ envFingerprint: fp, resultKey: 'S'.repeat(8), key: 'S'.repeat(8), dirKey: 'S'.repeat(8) }] });
  assert.equal(body.layers[1].contentKey, 'ck-b');
  assert.equal(body.layers[1].envFingerprint, fp);
  assert.equal(body.layers[1].kind, 'local');
  assert.equal(body.layers[1].key, `entry1/${'L'.repeat(8)}`);
  assert.equal(body.layers[1].resultKey, resultKeyOf('entry1/ck-b', fp));
  assert.equal(T.layerMapKeyOf('proj-1'), 'layers:proj-1');
  assert.equal(T.layerMapKeyOf(''), null);
  assert.ok(Buffer.byteLength(JSON.stringify(body)) < 256 * 1024);
});

test('ST9 层表写进内容库:攒一下、后写的赢、内容相同不重写、失败按退避重试', async () => {
  const p = await makePipeline();
  let t = 0;
  const timers = [];
  const clock = {
    now: () => t,
    setTimeout: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    clearTimeout: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
  };
  const advance = async (ms) => {
    t += ms;
    for (;;) {
      const due = timers.filter((h) => h.at <= t).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
      await new Promise((r) => setImmediate(r));
    }
    await new Promise((r) => setImmediate(r));
  };
  const writes = [];
  let fail = 1;
  const content = {
    async put(kind, key, body) {
      if (fail > 0) { fail--; throw Object.assign(new Error('断了'), { code: 'disconnected' }); }
      writes.push({ kind, key, body });
      return { hash: 'h' };
    },
  };
  const queue = createPushQueue({ pipeline: p, client: memClient(), content, dir: roots.at(-1), clock, backoff: [1000], gate: false });
  const body = (n) => ({ v: 1, kind: 'layer-map', projectId: 'p', at: n, layers: [{ clipId: `c${n}` }] });
  assert.equal(queue.putLayerMap('p', body(1)), true);
  assert.equal(queue.putLayerMap('p', body(2)), true, '攒着的被后来的顶掉');
  await advance(300);
  assert.equal(writes.length, 0, '第一次写失败');
  await advance(1000);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, 'snapshot-manifest');
  assert.equal(writes[0].key, 'layers:p');
  assert.deepEqual(writes[0].body.layers, [{ clipId: 'c2' }]);
  queue.putLayerMap('p', { ...body(2), at: 999 });
  await advance(300);
  assert.equal(writes.length, 1, '内容相同(不算 at)不重写');
  queue.putLayerMap('p', body(3));
  await advance(300);
  assert.equal(writes.length, 2);
  assert.equal(queue.putLayerMap('', body(4)), false, '项目没有 id');
  assert.equal(queue.stats().layerMaps, 2);
  await queue.stop();
  p.pushQueue = null;
});

/* ------------------------------------------------------------------ 完成条件:两档都推送成功(阿里云 295/300,2026-09-27) */

/** 一张共享档卡的 control(`scheduleMissingSmall` / `writeSmallSnapshots` 要的几项) */
const controlOf = (key, count) => ({ clipId: 'c1', snapshotKey: key, tier: 'shared', capabilities: {}, count, appearance: { width: 1920, height: 1080 } });
/** 把管线接上一个假推送队列(打开小尺寸),再把画小位图换成直接写假 WebP(单测不开 Chrome) */
function withSmallTier(p) {
  p.pushQueue = { enqueue: async () => {} };
  p.smallTierEnabled = () => true;
  const drawn = [];
  p.writeSmallSnapshots = async (job) => {
    const dir = p.snapshots().dir({ tier: job.tier, entryKey: job.entryKey, key: job.key });
    for (const item of job.items) {
      drawn.push(item.localFrame);
      await fs.writeFile(path.join(dir, `${item.localFrame}${SMALL_SUFFIX}`), fakeWebp(800, 450, item.localFrame));
    }
    return job.items.length;
  };
  return drawn;
}

test('ST10 已有原尺寸、缺小尺寸的帧(先于推送队列渲的、画之前进程退了的)排进小尺寸,从帧库读回原 HTML;没开小尺寸不读', async () => {
  const p = await makePipeline();
  const key = 'e'.repeat(64);
  const dir = await seed(p, key, [0, 1, 2, 3, 28, 29, 30, 31]);
  // 这几帧有小尺寸:1、2、3;0 与 28～31 没有 —— 同阿里云那一轮(锚帧 0 与播放头那一批 28～31 渲在推送队列配上之前)
  for (const f of [1, 2, 3]) await fs.writeFile(path.join(dir, `${f}${SMALL_SUFFIX}`), fakeWebp(800, 450, f));
  const control = controlOf(key, 60);
  const entry = { key: 'entry-e', project: { width: 1920, height: 1080, fps: 30 } };
  assert.equal(await p.scheduleMissingSmall(entry, control, { from: 0, to: 59 }), 0, '没开小尺寸:不排');
  assert.equal(p.smallPending?.length ?? 0, 0);
  p.pushQueue = { enqueue: async () => {} };
  p.smallTierEnabled = () => true;
  assert.equal(await p.scheduleMissingSmall(entry, control, { from: 0, to: 59 }), 5);
  assert.deepEqual(p.smallPending.flatMap((j) => j.items.map((i) => i.localFrame)), [0, 28, 29, 30, 31]);
  assert.equal(p.smallPending[0].items[0].html, html(0), '从帧库读回原 HTML');
  assert.equal(p.smallPending[0].key, key);
  // 只看这一段:28～31 不在 [0, 3] 里
  p.smallPending = [];
  assert.equal(await p.scheduleMissingSmall(entry, control, { from: 0, to: 3 }), 1);
  p.smallPending = [];
  p.pushQueue = null;
});

test('ST11 队列细任务收尾:还有记下没画的小尺寸就换一次页画掉(换页前的钩子);没有就不换页', async () => {
  const p = await makePipeline();
  const drawn = withSmallTier(p);
  const key = 'f'.repeat(64);
  await seed(p, key, [0, 1]);
  p.smallPending = []; // 写帧的钩子顺手记下的那一批不算:这里要的是「已有原尺寸、缺小尺寸」
  const resets = [];
  const bakery = {
    page: { setViewport: async () => {} },
    client: { send: async () => {} },
    async reset(project, url) { resets.push(url); await this.beforeReset?.(this); },
  };
  bakery.beforeReset = (b) => p.flushSmallOn(b);
  const project = { width: 1920, height: 1080, fps: 30, duration: 2, tracks: [], media: [] };
  assert.equal(await p.flushPendingSmall(bakery, project), false, '没有待画的:不换页');
  assert.equal(resets.length, 0);
  await p.scheduleMissingSmall({ key: 'x', project }, controlOf(key, 2), { from: 0, to: 1 });
  assert.equal(await p.flushPendingSmall(bakery, project), true);
  assert.equal(resets.length, 1);
  await p.whenSmallSettled();
  assert.deepEqual(drawn, [0, 1]);
  assert.equal(p.smallPending.length, 0);
  p.pushQueue = null;
});

test('ST12 sink:开着小尺寸时缺一张小尺寸就不算完成(put 回 incomplete、has 回 false、不认内容库里缺小尺寸的清单);补齐后两档一起推', async () => {
  const p = await makePipeline();
  const key = '9'.repeat(64);
  const dir = await seed(p, key, [0, 1, 2, 3]);
  for (const f of [1, 2, 3]) await fs.writeFile(path.join(dir, `${f}${SMALL_SUFFIX}`), fakeWebp(800, 450, f));
  const client = memClient();
  const manifests = new Map();
  const content = {
    async get(kind, k) { return manifests.has(k) ? { body: manifests.get(k) } : null; },
    async put(kind, k, body) { manifests.set(k, body); return { hash: 'h' }; },
  };
  const sink = T.createAssetSink({ pipeline: p, client, content });
  const ref = task(key, 0, 3);
  // 没开小尺寸(没配推送队列):和 C6.4 一样,原尺寸齐就完成
  assert.equal(await sink.has(ref), true);
  assert.equal((await sink.put(ref)).complete, true);
  assert.equal(T.smallComplete((await sink.put(ref)).result), false, '这份清单确实缺帧 0 的小尺寸');
  // 开着小尺寸:缺帧 0 的小尺寸 → 不算已有、不算完成(可重试),即使内容库里已有一份原尺寸齐的清单
  p.pushQueue = { enqueue: async () => {} };
  p.smallTierEnabled = () => true;
  assert.ok(manifests.size, '内容库里已有上面那份(原尺寸齐、小尺寸缺)');
  assert.equal(await sink.has(ref), false);
  assert.equal(await sink.resultFor(ref), null);
  const miss = await sink.put(ref);
  assert.equal(miss.complete, false);
  assert.equal(miss.reason, 'small-missing', '回包说明为什么没收全(AGENT-stall-phases 的诊断)');
  // 补上那一张:两档一起推,清单每帧都有小尺寸
  await fs.writeFile(path.join(dir, `0${SMALL_SUFFIX}`), fakeWebp(800, 450, 0));
  assert.equal(await sink.has(ref), true);
  const done = await sink.put(ref);
  assert.equal(done.complete, true);
  assert.equal(T.smallComplete(done.result), true);
  assert.deepEqual(done.result.small.map(([f]) => f), [0, 1, 2, 3]);
  for (const [, hash] of done.result.small) assert.ok(await client.has('px', hash));
  // 流没有小尺寸:恒算齐
  assert.equal(T.smallComplete({ kind: 'stream', segments: {} }), true);
  p.pushQueue = null;
});

test('ST13 队列细任务(共享档 / 本地档)这一段只差小尺寸时也补上:任务回来时每帧两档都在帧库里', async () => {
  const p = await makePipeline();
  const drawn = withSmallTier(p);
  const project = { width: 1920, height: 1080, fps: 30, duration: 2, tracks: [], media: [] };
  const resets = [];
  const bakery = {
    page: { setViewport: async () => {} },
    client: { send: async () => {} },
    async reset(_project, url) { resets.push(url); await this.beforeReset?.(this); },
  };
  bakery.beforeReset = (b) => p.flushSmallOn(b);
  p.acquire = async () => bakery;
  p.release = () => {};
  // 原尺寸早就齐了(fillCardControls 什么都不渲、也不换页 —— 最坏的情形)
  p.fillCardControls = async () => [];
  const key = '7'.repeat(64);
  const dir = await seed(p, key, [0, 1, 2, 3]);
  p.smallPending = [];
  await fs.writeFile(path.join(dir, `2${SMALL_SUFFIX}`), fakeWebp(800, 450, 2));
  const control = controlOf(key, 4);
  const entry = { key: 'entry-7', project, cardPlan: [control] };
  await p.renderCardSnapshotRange(entry, control, { from: 0, to: 3 });
  assert.deepEqual(drawn.sort((a, b) => a - b), [0, 1, 3]);
  assert.equal(resets.length, 1, '收尾换一次页画掉');
  const { result } = await T.collectSnapshotResult(p, task(key, 0, 3));
  assert.equal(T.smallComplete(result), true);
  // 本地档:一帧都不用渲,只差小尺寸,也借预渲染间补
  drawn.length = 0;
  const lkey = '6'.repeat(64);
  await p.snapshots().commitSnapshots({ tier: 'local', entryKey: entry.key, key: lkey, clipId: 'c2', capabilities: {}, items: [0, 1].map((f) => ({ localFrame: f, html: html(f) })) });
  p.smallPending = [];
  const local = { clipId: 'c2', snapshotKey: lkey, tier: 'local', capabilities: {}, count: 2, sampling: { firstFrame: 0 }, end: 2, appearance: { width: 1920, height: 1080 } };
  await p.renderSceneSnapshotRange({ ...entry, cardPlan: [local] }, local, { from: 0, to: 1 });
  assert.deepEqual(drawn.sort((a, b) => a - b), [0, 1]);
  p.pushQueue = null;
});

/**
 * X7(`docs/plan/m6c-contract.md`):远端节点产的卡,本机的 PNG 缓存。
 *
 *   推送侧:快照清单(C6.2 的 `SnapshotResult`)另带这一段的 PNG 缓存帧 `pngs: [{ key, fps, frames: [[帧, 哈希, 字节数]] }]`,
 *          块推进素材服务的 `px`;
 *   拉取侧:`applyResult` 落地快照时,清单带着 `pngs` 就一并取回,原样写进本机 PNG 缓存
 *          (`CardFrameCache` 的 `controls/<key>/mov/frames/`);没有 `pngs` 的保持原样(legacy 通道照旧画占位),不在本机预渲染重试。
 *
 * 两个临时帧库 A(远端,产)、B(本机,取),各一个真的 `FramePipeline`(`bakery/index.mjs` 换成假的,不起 Chrome);
 * 一台真 HTTP 的素材服务(memory,端口 0)。A、B 的 entry 用真的 `CardFrameCache`,PNG 用 pngjs 现造。
 *
 * 跑法:node --experimental-test-module-mocks --test server/test/artifact-png.test.mjs
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
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
const { CardFrameCache, cardControlPngPath } = await import('../card-cache.mjs');
const { describeEnvironment, resultKeyOf } = await import('../render-node/fingerprint.mjs');
const { readRenderRecord } = await import('../png-record.mjs');
const T = await import('../artifact-transfer.mjs');
const { createAssetClient } = await import('../asset-store/client.mjs');

const harness = createAssetHarness();
after(() => harness.cleanup());

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const wire = (v) => JSON.parse(JSON.stringify(v));

const ENV = describeEnvironment({
  platform: 'win32', renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  vendor: 'Google Inc. (Google)', chromeVersion: 'HeadlessChrome/152.0.0.0',
});
const FP = ENV.fingerprint;
const CAPTURE = 'capture-v1';
const SHARED_CAPS = { compositing: 'independent', frameMode: 'stateful' };

/** 4×4 的 PNG:第 n 帧一个颜色;`clear` 为真时全零(全透明,同 Chrome 截出的空帧) */
function pngOf(n, clear = false) {
  const png = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < 16 && !clear; i++) {
    png.data[i * 4] = (n * 37) & 255; png.data[i * 4 + 1] = (n * 11) & 255; png.data[i * 4 + 2] = 200; png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** 一张共享档卡的 control(`card-cache.mjs` 的 `plan` 产出的那些字段里用得到的) */
function controlFor(tag, { clipId = `clip-${tag}` } = {}) {
  const contentKey = sha256(`content-${tag}`);
  return {
    key: resultKeyOf(sha256(`png-${tag}-${clipId}`), FP), snapshotKey: resultKeyOf(contentKey, FP), contentKey, envFingerprint: FP,
    tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', cacheable: true, needPrerendering: true,
    clipId, start: 0, end: 2, count: 60, sampling: { firstFrame: 0, phase: { numerator: 0, denominator: 1 } },
  };
}
const taskFor = (control, from = 0, to = 59) => ({
  id: `snapshot:${control.snapshotKey}:${from}-${to}`, kind: 'snapshot', tier: 'shared', resultKey: control.snapshotKey,
  range: { unit: 'localFrame', from, to }, source: { projectId: 'p1', projectRev: 1 },
  input: { clipId: control.clipId, cardId: null, entryKey: null, contentKey: control.contentKey },
  requires: { envFingerprint: FP }, state: 'claimed', version: 1, attempts: 1,
});

async function withLibs(fn) {
  const roots = [];
  const pipelines = [];
  const make = async ({ capture = CAPTURE } = {}) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-x7-lib-'));
    roots.push(root);
    const p = new FramePipeline({ root, origin: () => 'http://127.0.0.1:1', environment: ENV, dataRoot: root, interactive: false, captureCode: () => capture });
    pipelines.push(p);
    return p;
  };
  try { return await fn(make); } finally {
    await Promise.allSettled(pipelines.map((p) => p.close()));
    await Promise.all(roots.map((r) => fs.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
  }
}

/** 管线上挂一个 entry:card plan 是这些 control,PNG 缓存是真的 `CardFrameCache`(capture 取管线的) */
function attachEntry(pipeline, controls, key = `entry-${Math.random().toString(36).slice(2, 8)}`) {
  const project = { fps: 30, width: 64, height: 64 };
  const cardCache = new CardFrameCache({ root: pipeline.root, project, capture: () => pipeline.captureCode(), scale: () => 1, envFingerprint: FP });
  const entry = { key, project, cardPlan: controls, cardCache };
  pipeline.entries.set(key, entry);
  return entry;
}

/** A 产一段:60 帧快照 + PNG 缓存。第 0 帧全透明且二次确认、第 1 帧全透明未确认、第 5 帧没有 PNG */
async function produce(A, control) {
  const entry = attachEntry(A, [control]);
  await A.snapshots().commitSnapshots({ tier: 'shared', key: control.snapshotKey, clipId: control.clipId, capabilities: SHARED_CAPS,
    items: range(0, 59).map((n) => ({ localFrame: n, html: `<div data-pc-scene="">card ${control.clipId} frame ${n}</div>` })) });
  for (const n of range(0, 59)) {
    if (n === 5) continue;
    const clear = n === 0 || n === 1;
    await entry.cardCache.put(control.key, n, pngOf(n, clear));
    if (n === 0) await entry.cardCache.put(control.key, n, pngOf(n, clear));   // 同一产出方再渲一遍,确认它确实是空的
  }
  return entry;
}

function countingClient(client) {
  const gets = [];
  return { gets, put: (...a) => client.put(...a), has: (...a) => client.has(...a), get: (ns, hash) => { gets.push({ ns, hash }); return client.get(ns, hash); } };
}

async function pushed(A, control) {
  const srv = await harness.serve();
  const client = createAssetClient({ base: srv.base });
  const { result, readBlob } = await T.collectSnapshotResult(A, taskFor(control));
  await T.pushResult(client, result, readBlob);
  return { srv, client, result: wire(result) };
}

/* ------------------------------------------------------------------ 用例 */

test('X7-1 推送侧:快照清单带上这一段的 PNG 缓存帧(只列有效的),块推进 px', async () => {
  await withLibs(async (make) => {
    const A = await make();
    const control = controlFor('x71');
    await produce(A, control);
    const { client, result } = await pushed(A, control);
    assert.equal(result.frames.length, 60, '快照照旧 60 帧');
    assert.ok(Array.isArray(result.pngs) && result.pngs.length === 1, '带一份 pngs');
    const [item] = result.pngs;
    assert.equal(item.key, control.key);
    assert.equal(item.fps, 30);
    const listed = item.frames.map(([f]) => f);
    assert.deepEqual(listed, range(0, 59).filter((n) => n !== 1 && n !== 5), '未确认的全透明帧(1)与没有 PNG 的帧(5)不列');
    for (const [f, hash, bytes] of item.frames) {
      const buf = await fs.readFile(cardControlPngPath(A.root, control.key, f));
      assert.equal(hash, sha256(buf), `第 ${f} 帧的哈希是盘上字节的`);
      assert.equal(bytes, buf.length);
      assert.equal(await client.has('px', hash), true, `第 ${f} 帧在 px 里`);
      assert.equal(await client.has('snap', hash), false, 'PNG 不进 snap');
    }
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= T.RESULT_MAX_BYTES);
  });
});

test('X7-2 拉取侧:applyResult 把 PNG 原样写进本机 PNG 缓存,legacy 的 renderState 给真实 PNG 而不是缺料', async () => {
  await withLibs(async (make) => {
    const A = await make();
    const B = await make();
    const control = controlFor('x72');
    await produce(A, control);
    const { client, result } = await pushed(A, control);
    const bEntry = attachEntry(B, [structuredClone(control)]);
    const before = await bEntry.cardCache.renderState(bEntry.cardPlan, range(0, 59));
    assert.equal(Object.keys(before.frames).length, 0, '取之前 B 没有 PNG');
    assert.equal(Object.keys(before.missing).length, 60, '取之前 60 帧都是缺料(legacy 画占位)');

    const counting = countingClient(client);
    const applied = await T.applyResult(B, counting, result);
    assert.equal(applied.written, 60, '快照照旧 60 帧');
    assert.equal(applied.png?.written, 58, 'PNG 写了 58 帧');
    assert.equal(counting.gets.filter((g) => g.ns === 'px').length, 58, '从 px 下了 58 块');
    for (const [f] of result.pngs[0].frames) {
      const a = await fs.readFile(cardControlPngPath(A.root, control.key, f));
      const b = await fs.readFile(cardControlPngPath(B.root, control.key, f));
      assert.ok(a.equals(b), `第 ${f} 帧与 A 逐字节相同`);
    }
    assert.equal(readRenderRecord(await fs.readFile(cardControlPngPath(B.root, control.key, 0))).renders, 2, '二次确认过的全透明帧带着渲染遍数落地');
    const after_ = await bEntry.cardCache.renderState(bEntry.cardPlan, range(0, 59));
    assert.deepEqual(Object.keys(after_.frames[control.clipId]).map(Number).sort((a, b) => a - b), range(0, 59).filter((n) => n !== 1 && n !== 5));
    assert.deepEqual(Object.keys(after_.missing).map(Number).sort((a, b) => a - b), [1, 5], '只剩对方也没有的两帧还是缺料');
  });
});

test('X7-3 清单里没有 pngs:保持原样(缺料、占位),不下载任何像素块,也不在本机预渲染重试', async () => {
  await withLibs(async (make) => {
    const A = await make();
    const B = await make();
    const control = controlFor('x73');
    await produce(A, control);
    const { client, result } = await pushed(A, control);
    delete result.pngs;
    const bEntry = attachEntry(B, [structuredClone(control)]);
    const counting = countingClient(client);
    const applied = await T.applyResult(B, counting, result);
    assert.equal(applied.written, 60);
    assert.equal(applied.png, undefined, '没有 pngs 就没有 png 计数');
    assert.equal(counting.gets.filter((g) => g.ns === 'px').length, 0);
    await assert.rejects(fs.access(path.join(B.root, 'controls', control.key)), '本机没有这个键的 PNG 目录');
    const state = await bEntry.cardCache.renderState(bEntry.cardPlan, range(0, 59));
    assert.equal(Object.keys(state.missing).length, 60, '仍是缺料');
  });
});

test('X7-4 本机已有的有效帧跳过、不下载;capture 对不上的(抓帧代码不同)不收', async () => {
  await withLibs(async (make) => {
    const A = await make();
    const B = await make();
    const C = await make({ capture: 'capture-v2' });
    const control = controlFor('x74');
    await produce(A, control);
    const { client, result } = await pushed(A, control);
    const bEntry = attachEntry(B, [structuredClone(control)]);
    for (const n of range(10, 19)) await bEntry.cardCache.put(control.key, n, pngOf(n));
    const counting = countingClient(client);
    const applied = await T.applyResult(B, counting, result);
    assert.equal(applied.png.skipped, 10);
    assert.equal(applied.png.written, 48);
    assert.equal(counting.gets.filter((g) => g.ns === 'px').length, 48, '已有的 10 帧不下载');

    attachEntry(C, [structuredClone(control)]);
    const other = await T.applyResult(C, client, result);
    assert.equal(other.png.written, 0);
    assert.equal(other.png.mismatched, 58, '产出记录的 capture 与本机不同:一帧都不收');
  });
});

test('X7-5 本机没有用到这个键的 entry:照样写进 controls/<key>/,之后开的 CardFrameCache 查得到', async () => {
  await withLibs(async (make) => {
    const A = await make();
    const B = await make();
    const control = controlFor('x75');
    await produce(A, control);
    const { client, result } = await pushed(A, control);
    const applied = await T.applyResult(B, client, result);
    assert.equal(applied.png.written, 58);
    const later = attachEntry(B, [structuredClone(control)]);
    const state = await later.cardCache.renderState(later.cardPlan, range(0, 59));
    assert.equal(Object.keys(state.frames[control.clipId] ?? {}).length, 58);
  });
});

test('X7-6 PNG 块在素材服务上不见了:快照照常落地、不抛,PNG 记 failed', async () => {
  await withLibs(async (make) => {
    const A = await make();
    const B = await make();
    const control = controlFor('x76');
    await produce(A, control);
    const { client, result } = await pushed(A, control);
    const gone = new Set(result.pngs[0].frames.slice(0, 3).map(([, hash]) => hash));
    const lossy = { ...client, get: (ns, hash) => (ns === 'px' && gone.has(hash) ? Promise.resolve(null) : client.get(ns, hash)) };
    attachEntry(B, [structuredClone(control)]);
    const applied = await T.applyResult(B, lossy, result);
    assert.equal(applied.written, 60);
    assert.equal(applied.png.failed, 3);
    assert.equal(applied.png.written, 55);
  });
});

test('X7-7 带上 PNG 会让清单超过 256 KiB 时不带 PNG,快照清单照常交付', async () => {
  await withLibs(async (make) => {
    const A = await make();
    const base = controlFor('x77');
    // 同一张卡摆 70 次:共用一份快照,各有一份 PNG 缓存(键不同)。70 × 60 帧的 PNG 条目超过 256 KiB
    const controls = range(0, 69).map((i) => ({ ...base, clipId: `clip-x77-${i}`, key: resultKeyOf(sha256(`png-x77-${i}`), FP) }));
    const entry = attachEntry(A, controls);
    await A.snapshots().commitSnapshots({ tier: 'shared', key: base.snapshotKey, clipId: base.clipId, capabilities: SHARED_CAPS,
      items: range(0, 59).map((n) => ({ localFrame: n, html: `<div>${n}</div>` })) });
    // PNG 缓存只按目录查:70 个键的 frames 目录各放同样 60 个文件(直接写盘,不走 70 × 60 次 put)
    const oneStore = await entry.cardCache.store(controls[0].key);
    for (const n of range(0, 59)) await entry.cardCache.put(controls[0].key, n, pngOf(n));
    const files = await fs.readdir(oneStore.frameDir);
    for (const c of controls.slice(1)) {
      const dir = path.join(A.root, 'controls', c.key, 'mov', 'frames');
      await fs.mkdir(dir, { recursive: true });
      for (const name of files) {
        const src = await fs.readFile(path.join(oneStore.frameDir, name));
        // 产出记录里的卡键要是它自己的,否则不算有效
        const { withRenderRecord } = await import('../png-record.mjs');
        const record = readRenderRecord(src);
        await fs.writeFile(path.join(dir, name), withRenderRecord(src, { ...record, signature: { ...record.signature, cards: c.key } }));
      }
    }
    const { result } = await T.collectSnapshotResult(A, taskFor(base));
    assert.equal(result.frames.length, 60);
    assert.equal(result.pngs, undefined, '超限:不带 pngs');
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= T.RESULT_MAX_BYTES);
  });
});

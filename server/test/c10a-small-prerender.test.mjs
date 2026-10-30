/**
 * C10a 预渲染小尺寸（`docs/plan/c10a-contract.md` 第 9 节，第 12 节「预渲染小尺寸：尺寸规则、两档分开就绪、完成条件」）。
 * 跑：node --test server/test/c10a-small-prerender.test.mjs
 *
 *   尺寸：等比缩进 800×600 以内，不放大，保持项目画幅；16:9 → 800×450，9:16 → 337×600。
 *   入库：小位图（WebP）按内容哈希推到素材服务 `px/<hash>`；清单每段在原尺寸之外带小尺寸那一份的哈希表。
 *   就绪：两档分开记，小尺寸就绪不能当原尺寸就绪。完成：两档都推送成功。
 *
 * 假设的接口见 `c10a-kit.mjs` 的 K4（尺寸函数的位置与名字、清单的 `small` 字段、就绪索引的小尺寸 `kind`）。
 * 探测只看尺寸函数：找不到就整组 skip；找到了，其余几条跟着真跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { skipIf, findSmallSize, sizeOf, repoUrl, ORIGINALS_FILE } from './c10a-kit.mjs';

const found = await findSmallSize();
if (found?.error) {
  test('C10A-PS-00 尺寸函数载得进 node', () => { assert.fail(`${found.file} 导出了尺寸函数却载不进来：${found.error?.stack ?? found.error}`); });
}
const skip = skipIf(!found?.fn, '预渲染小尺寸的尺寸函数（K4）');
const it = (name, fn) => test(name, { skip }, fn);

const size = (w, h) => sizeOf(found.fn(w, h));
const sha = (b) => createHash('sha256').update(b).digest('hex');

it('C10A-PS-01 尺寸规则：契约里的例子与常见画幅', () => {
  const cases = [
    [[1920, 1080], [800, 450]],
    [[1080, 1920], [337, 600]], // 契约原文：9:16 为 337×600
    [[3840, 2160], [800, 450]],
    [[1280, 720], [800, 450]],
    [[2048, 1536], [800, 600]],
    [[800, 600], [800, 600]],
    [[1000, 1000], [600, 600]],
    [[4000, 1000], [800, 200]],
    [[1000, 4000], [150, 600]],
  ];
  for (const [[w, h], want] of cases) assert.deepEqual(size(w, h), { width: want[0], height: want[1] }, `${w}×${h}`);
});

it('C10A-PS-02 尺寸规则：不放大（本来就在 800×600 以内的原样）', () => {
  for (const [w, h] of [[640, 360], [450, 600], [800, 450], [320, 240], [1, 1], [600, 600], [337, 600]]) {
    assert.deepEqual(size(w, h), { width: w, height: h }, `${w}×${h}`);
  }
});

it('C10A-PS-03 尺寸规则的性质：整数、在框内、不放大、画幅误差不到 1 像素、缩了就有一边顶到框', () => {
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  for (let i = 0; i < 500; i++) {
    const w = rnd(16, 8192);
    const h = rnd(16, 8192);
    const s = size(w, h);
    assert.ok(Number.isInteger(s.width) && Number.isInteger(s.height) && s.width >= 1 && s.height >= 1, `${w}×${h} → ${JSON.stringify(s)}`);
    assert.ok(s.width <= 800 && s.height <= 600, `${w}×${h} → ${s.width}×${s.height} 超出 800×600`);
    assert.ok(s.width <= w && s.height <= h, `${w}×${h} → ${s.width}×${s.height} 放大了`);
    const k = Math.min(800 / w, 600 / h, 1);
    assert.ok(Math.abs(s.width - w * k) < 1 && Math.abs(s.height - h * k) < 1, `${w}×${h} → ${s.width}×${s.height}，应约 ${(w * k).toFixed(2)}×${(h * k).toFixed(2)}`);
    if (k < 1) assert.ok(s.width === 800 || s.height === 600 || Math.abs(s.width - 800) < 1 || Math.abs(s.height - 600) < 1, `${w}×${h} → ${s.width}×${s.height}：缩了却没有一边顶到框`);
  }
});

// ------------------------------------------------------------------ 清单、推送、完成条件

/** 一段快照清单：3 帧原尺寸 HTML + 3 张 WebP 小位图（K4：`small` 与 `frames` 同形） */
function snapshotResult() {
  const blobs = new Map();
  const add = (bytes) => { const h = sha(bytes); blobs.set(h, bytes); return [h, bytes.length]; };
  const frames = [];
  const small = [];
  for (let f = 0; f < 3; f++) {
    frames.push([f, ...add(Buffer.from(`<div data-frame="${f}">${randomBytes(8).toString('hex')}</div>`, 'utf8'))]);
    small.push([f, ...add(Buffer.concat([Buffer.from('RIFF'), randomBytes(4), Buffer.from('WEBPVP8L'), randomBytes(24)]))]);
  }
  const result = {
    v: 1, kind: 'snapshot', tier: 'shared', resultKey: 'k'.repeat(16), dirKey: 'k'.repeat(16), entryKey: null,
    range: { from: 0, to: 2 }, canvasHeavy: false, frames, small,
  };
  return { result, blobs, readBlob: async (h) => blobs.get(h) ?? null };
}

function fakeClient({ failPx = false, present = null } = {}) {
  const puts = [];
  return {
    puts,
    async put(ns, bytes, opts = {}) {
      const hash = sha(bytes);
      puts.push({ ns, hash, ext: opts.ext ?? null });
      if (failPx && ns === 'px') throw Object.assign(new Error('px 推送失败（测试注入）'), { status: 503 });
      return { hash, uploaded: true };
    },
    async has(ns, hash) { return present ? present(ns, hash) : true; },
    async get() { return null; },
  };
}

it('C10A-PS-04 清单带小尺寸哈希表：推送时两档都推，原尺寸进 snap、小位图以 WebP 进 px', async () => {
  const { pushResult } = await import(repoUrl('server/artifact-transfer.mjs'));
  const { result, readBlob } = snapshotResult();
  const client = fakeClient();
  await pushResult(client, result, readBlob);
  const snap = client.puts.filter((p) => p.ns === 'snap').map((p) => p.hash).sort();
  const px = client.puts.filter((p) => p.ns === 'px');
  assert.deepEqual(snap, result.frames.map(([, h]) => h).sort(), '原尺寸三帧进 snap');
  assert.deepEqual(px.map((p) => p.hash).sort(), result.small.map(([, h]) => h).sort(), '小位图三张进 px');
  assert.ok(px.every((p) => p.ext === 'webp'), `小位图的扩展名是 webp：${JSON.stringify(px)}`);
});

it('C10A-PS-05 完成条件：小尺寸有一块推失败，这一段就不算完成（pushResult 抛错）', async () => {
  const { pushResult } = await import(repoUrl('server/artifact-transfer.mjs'));
  const { result, readBlob } = snapshotResult();
  await assert.rejects(pushResult(fakeClient({ failPx: true }), result, readBlob), '原尺寸都推上去了也不算完成');
});

it('C10A-PS-06 去重看两档：清单列了小尺寸而素材服务上缺一块，blocksPresent 回 false', async () => {
  const { blocksPresent } = await import(repoUrl('server/artifact-transfer.mjs'));
  const { result } = snapshotResult();
  const missing = result.small[1][1];
  assert.equal(await blocksPresent(fakeClient({ present: () => true }), result), true, '两档都在');
  assert.equal(await blocksPresent(fakeClient({ present: (ns, h) => h !== missing }), result), false, '缺一张小位图');
});

// ------------------------------------------------------------------ 就绪分开记

/*
 * 集成对账（K4）改写了这一条：实现把两档分开记在**清单**里（`frames` 只列原尺寸、`small` 另列），预渲染进程的就绪索引
 * （`server/ready-index.mjs`，桌面页面的 SSE）根本不收小尺寸；在线页面按 `small` 表算小尺寸就绪，导出前核对
 * （`src/export/originals.ts`）只认 `frames`。所以「小尺寸就绪不能当原尺寸就绪」在这两处核对，不在就绪索引里加一档。
 */
it('C10A-PS-07 两档分开就绪：清单里小尺寸盖满整段、原尺寸只有一半，导出前核对仍算缺原尺寸，缺的帧取不到原尺寸', async () => {
  const ready = await import(repoUrl('server/ready-index.mjs'));
  assert.equal(ready.READY_KINDS.some((k) => /small/i.test(k)), false, `就绪索引不收小尺寸：${JSON.stringify(ready.READY_KINDS)}`);
  await import(repoUrl('src/testing/registerTs.mjs'));
  const { loadOriginalsIndex } = await import(repoUrl(ORIGINALS_FILE));
  const hex = (c) => c.repeat(64);
  const frames = Array.from({ length: 30 }, (_, f) => [f, hex('a'), 10]); // 原尺寸只有 0～29
  const small = Array.from({ length: 60 }, (_, f) => [f, hex('b'), 5]); // 小尺寸 0～59 盖满
  const content = {
    'layers:p1': { v: 1, kind: 'layer-map', projectId: 'p1', fps: 30, span: 60, layers: [{ clipId: 'c1', kind: 'html', key: 'K1', resultKey: 'R1', firstFrame: 100, count: 60 }] },
    'R1:0-59': { v: 1, kind: 'snapshot', resultKey: 'R1', range: { from: 0, to: 59 }, frames, small },
  };
  const deps = {
    request: async (m) => (m.type === 'content.get' && m.kind === 'snapshot-manifest' && content[m.key]
      ? { type: 'content.item', kind: m.kind, key: m.key, body: content[m.key] } : { type: 'content.item', kind: m.kind, key: m.key, missing: true }),
    assetBase: () => null,
    authHeaders: async () => ({}),
  };
  const idx = await loadOriginalsIndex('p1', deps);
  assert.deepEqual(idx.missing, ['c1'], '小尺寸盖满也不算原尺寸就绪');
  assert.equal(idx.hashAt('c1', 100 + 10), hex('a'), '有原尺寸的帧取原尺寸');
  assert.equal(idx.hashAt('c1', 100 + 40), null, '只有小尺寸的帧：原尺寸算缺，不拿小尺寸顶');
  content['R1:0-59'] = { ...content['R1:0-59'], frames: Array.from({ length: 60 }, (_, f) => [f, hex('a'), 10]) };
  assert.deepEqual((await loadOriginalsIndex('p1', deps)).missing, [], '原尺寸补齐之后才就绪');
});

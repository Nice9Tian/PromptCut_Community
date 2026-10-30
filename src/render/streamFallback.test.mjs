/**
 * 兜底顺序在舞台一侧(`streamPlayer.ts`)的单测:解码器预算的纯函数、组流清空、
 * 稀疏段换满帧段时的清单刷新(疑点 G)。跑:node --test src/render/streamFallback.test.mjs
 *
 * 解码与合成要浏览器;这里用假的 root / canvas / 字节源,只钉「哪条流建轨道」「清单什么时候再问」
 * 「流清空时画面清空」这几件纯逻辑。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { StreamPlayer, planesWithinBudget, DECODER_BUDGET, MANIFEST_REFRESH_MS } from './streamPlayer.ts';

globalThis.CSS = { escape: (s) => s };
let now = 1_000_000;
Date.now = () => now;

const fakeCanvas = () => ({ getContext: () => null, style: { getPropertyValue: () => '', setProperty() {} }, width: 0, height: 0, parentElement: null });

/** 只认 streamPlayer 用到的选择器 */
function fakeRoot({ canvases = {} } = {}) {
  return {
    querySelector(sel) {
      let m = /^\[data-pc-clip="(.+?)"\] > canvas\[data-pc-stream-plane\]$/.exec(sel);
      if (m) return canvases[m[1]] ?? null;
      m = /data-pc-stream-group="(.+?)"/.exec(sel);
      if (m) return canvases[m[1]] ?? null;
      return null;
    },
  };
}

const never = () => new Promise(() => {});
function fakeSource(manifests) {
  const src = { calls: 0, manifest: async () => { const m = manifests[Math.min(src.calls, manifests.length - 1)]; src.calls++; return m; }, init: never, segment: never };
  return src;
}
const manifestWith = (stride) => ({
  streamKey: 'K', kind: 'card', plane: 'local', clipIds: ['a'], fps: 30, segmentFrames: 15,
  bound: { x: 10, y: 20, w: 300, h: 200 }, tight: null, inits: {},
  segments: { 0: { init: 'i', file: `0-${stride}.m4s`, stride, samples: 15 } },
});
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { now = 1_000_000; });

test('planesWithinBudget:小的流(像素远没到预算)只受条数上限管,留前 DECODER_BUDGET 条有流键的平面', () => {
  const planes = Array.from({ length: DECODER_BUDGET + 2 }, (_, i) => ({ clipIds: [`c${i}`], key: `K${i}`, ranges: [[0, 9]], originFrame: 0 }));
  const withHole = [{ clipIds: ['nokey'] }, ...planes];
  // 预算的口径是数像素(`streamBudget.mjs`,那边的单测在 server/test/stream-budget.test.mjs);这里每条给 64×144 的小画幅,只剩条数上限起作用
  const small = () => 64 * 144;
  const kept = planesWithinBudget(withHole, 30, small);
  assert.equal(kept.length, DECODER_BUDGET);
  assert.deepEqual(kept.map((p) => p.clipIds[0]), planes.slice(0, DECODER_BUDGET).map((p) => p.clipIds[0]), '没有流键的只占位、不占解码器');
  // 没带这条流第一帧的平面(没法把帧号换成分段号)同样不占解码器
  const { originFrame: _dropped, ...noOrigin } = planes[0];
  assert.deepEqual(planesWithinBudget([noOrigin, { ...planes[1], originFrame: -1 }, planes[2]], 30, small).map((p) => p.clipIds[0]), ['c2']);
});

test('舞台 sync() 守住条数的硬上限:画布晚到的平面照样占着它的位置,不让超出的那一条顶上', () => {
  const planes = Array.from({ length: DECODER_BUDGET + 1 }, (_, i) => ({ clipIds: [`c${i}`], key: `K${i}`, ranges: [[0, 9]], originFrame: 0 }));
  const canvases = Object.fromEntries(planes.slice(1).map((p) => [p.clipIds[0], fakeCanvas()]));   // c0 的画布还没挂上
  const player = new StreamPlayer({ root: () => fakeRoot({ canvases }), source: fakeSource([manifestWith(1)]) });
  player.setPlanes(planes, 30);
  player.present(0);
  const ids = player.diag().tracks.map((t) => t.id.split('#')[0]).sort();
  assert.deepEqual(ids, planes.slice(1, DECODER_BUDGET).map((p) => p.clipIds[0]).sort(), '超出条数上限的那一条不建解码器(像素那一半由父页判:超出的平面带 over,见 streamOver.test.mjs)');
});

test('疑点 G:当前段是稀疏段时,每 MANIFEST_REFRESH_MS 再问一次清单;换成满帧段后不再问', async () => {
  const source = fakeSource([manifestWith(3), manifestWith(1)]);
  const player = new StreamPlayer({ root: () => fakeRoot({ canvases: { a: fakeCanvas() } }), source });
  player.setPlanes([{ clipIds: ['a'], key: 'K', ranges: [[0, 0]], originFrame: 0 }], 30);
  player.present(0);
  await flush();
  assert.equal(source.calls, 1);
  player.present(1 / 30);
  await flush();
  assert.equal(source.calls, 1, '节流:刚问过不再问');
  now += MANIFEST_REFRESH_MS + 1;
  player.present(2 / 30);
  await flush();
  assert.equal(source.calls, 2, '稀疏段:过了刷新间隔再问一次,满帧段到了就能换上');
  now += MANIFEST_REFRESH_MS + 1;
  player.present(3 / 30);
  await flush();
  assert.equal(source.calls, 2, '已经是满帧段:不再问');
});

test('疑点 G:同一个流键的就绪区间变了(新分段发布),允许再问清单', async () => {
  const source = fakeSource([manifestWith(1)]);
  const player = new StreamPlayer({ root: () => fakeRoot({ canvases: { a: fakeCanvas() } }), source });
  player.setPlanes([{ clipIds: ['a'], key: 'K', ranges: [[0, 0]], originFrame: 0 }], 30);
  player.present(0);
  await flush();
  assert.equal(source.calls, 1);
  now += MANIFEST_REFRESH_MS + 1;
  player.setPlanes([{ clipIds: ['a'], key: 'K', ranges: [[0, 1]], originFrame: 0 }], 30);
  player.present(1 / 30);
  await flush();
  assert.equal(source.calls, 2);
});

test('组流清空(这一段没料)时,流画面清空;撤快照后不操作快照平面,由流平面与占位接管', () => {
  const player = new StreamPlayer({ root: () => fakeRoot({ canvases: { 'a,b': fakeCanvas() } }), source: fakeSource([manifestWith(1)]) });
  player.setPlanes([{ clipIds: ['a', 'b'], key: 'G', ranges: [[5, 9]], originFrame: 0 }], 30);
  player.present(0);   // 第 0 段不在就绪区间里 → blank
  assert.deepEqual([...player.showingClips()], [], '这一拍没有流画面');
});

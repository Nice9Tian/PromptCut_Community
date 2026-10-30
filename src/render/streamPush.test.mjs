/**
 * 在线页面的流字节怎么到舞台(`streamPlayer.ts` 的 `StreamPlaneSender` / `PushedStreamSource`;`docs/plan/browser-stream-task.md` 第七处):
 * 父页发流平面时带上清单和这台舞台还没有的块,舞台只从推来的块里取,不去问预渲染进程。
 * 跑:node --test src/render/streamPush.test.mjs
 *
 * 解码与合成要浏览器;这里用假的 root / canvas,只钉「字节按哈希取」「缺块怎么办」「两边的账对不对」「带清单的平面不碰别的字节源」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamPlayer, StreamPlaneSender, PushedStreamSource, manifestBlockHashes } from './streamPlayer.ts';

globalThis.CSS = { escape: (s) => s };

const H = (n) => n.toString(16).padStart(64, '0');
const buf = (...bytes) => new Uint8Array(bytes);
const flush = () => new Promise((r) => setTimeout(r, 0));

const INIT = H(0x1), INIT_ID = INIT.slice(0, 16);
/** 一条流在父页手里的样子:清单只列 `segs` 这几段,`blocks` 是这些段和开头文件的字节 */
function planeData(key, segs, { drop = [] } = {}) {
  const segments = {};
  const blocks = new Map([[INIT, buf(9, 9)]]);
  for (const n of segs) {
    const hash = H(0x100 + n);
    segments[n] = { init: INIT_ID, file: hash, stride: 1, samples: 15 };
    blocks.set(hash, buf(n, n, n));
  }
  for (const hash of drop) blocks.delete(hash);
  return {
    manifest: { streamKey: key, kind: 'card', plane: 'local', clipIds: ['a'], fps: 30, segmentFrames: 15, bound: { x: 0, y: 0, w: 300, h: 200 }, tight: null,
      inits: { [INIT_ID]: { codec: 'avc1.640028', width: 300, height: 416, rect: { x: 0, y: 0, w: 300, h: 200 }, hash: INIT } }, segments },
    blocks,
  };
}
const plane = (segs) => ({ clipIds: ['a'], key: 'K', ranges: segs.length ? [[segs[0], segs[segs.length - 1]]] : [], originFrame: 0 });

test('manifestBlockHashes:开头文件 + 分段;桌面的清单(文件名、没有 hash)一块都不列', () => {
  assert.deepEqual(new Set(manifestBlockHashes(planeData('K', [0, 1]).manifest)), new Set([INIT, H(0x100), H(0x101)]));
  assert.deepEqual(manifestBlockHashes({ inits: { i: { codec: 'x', width: 1, height: 1, rect: { x: 0, y: 0, w: 1, h: 1 } } }, segments: { 0: { init: 'i', file: '0-abc.m4s', stride: 1, samples: 15 } } }), []);
  assert.deepEqual(manifestBlockHashes(null), []);
});

test('按哈希取:第一次带上清单和全部块;舞台从推来的块里取开头文件和分段', async () => {
  let data = planeData('K', [0, 1]);
  const sender = new StreamPlaneSender((key) => (key === 'K' ? data : null));
  const stage = new PushedStreamSource();
  const sent = sender.decorate([plane([0, 1])]);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].clipIds, ['a']);
  assert.equal(sent[0].key, 'K');
  assert.deepEqual(sent[0].ranges, [[0, 1]]);
  assert.equal(sent[0].manifest, data.manifest);
  assert.deepEqual(new Set(Object.keys(sent[0].blocks)), new Set([INIT, H(0x100), H(0x101)]));
  assert.ok(sent[0].blocks[INIT] instanceof ArrayBuffer, '块是 ArrayBuffer(经 postMessage 克隆到舞台)');
  stage.accept(sent);
  assert.equal(await stage.manifest('K'), data.manifest);
  assert.deepEqual([...new Uint8Array(await stage.init('K', INIT_ID))], [9, 9]);
  assert.deepEqual([...new Uint8Array(await stage.segment('K', H(0x101)))], [1, 1, 1]);
  assert.equal(stage.size, 3);
  // 下一拍没变:清单照带,块一块都不重发
  const again = sender.decorate([plane([0, 1])]);
  assert.equal(again[0].manifest, data.manifest);
  assert.equal('blocks' in again[0], false);
  stage.accept(again);
  assert.equal(stage.size, 3, '舞台手里的块还在');
  // 多取到一段:只发新的那一块
  data = planeData('K', [0, 1, 2]);
  const more = sender.decorate([plane([0, 1, 2])]);
  assert.deepEqual(Object.keys(more[0].blocks), [H(0x102)]);
  stage.accept(more);
  assert.deepEqual([...new Uint8Array(await stage.segment('K', H(0x102)))], [2, 2, 2]);
  assert.equal(sender.heldCount, 4);
});

test('两边的账:清单不再用到的块舞台当场丢掉;以后又用到时父页重发', async () => {
  let data = planeData('K', [0, 1]);
  const sender = new StreamPlaneSender(() => data);
  const stage = new PushedStreamSource();
  stage.accept(sender.decorate([plane([0, 1])]));
  // 播放头走了,父页的窗口里只剩第 1、2 段
  data = planeData('K', [1, 2]);
  const next = sender.decorate([plane([1, 2])]);
  assert.deepEqual(Object.keys(next[0].blocks), [H(0x102)]);
  stage.accept(next);
  assert.equal(stage.has(H(0x100)), false, '第 0 段没人用了:丢掉');
  assert.equal(stage.has(H(0x101)) && stage.has(H(0x102)) && stage.has(INIT), true);
  // 往回拖:第 0 段又要了,父页认得舞台手里没有它
  data = planeData('K', [0, 1]);
  const back = sender.decorate([plane([0, 1])]);
  assert.deepEqual(Object.keys(back[0].blocks), [H(0x100)]);
  stage.accept(back);
  assert.equal(stage.has(H(0x100)), true);
  // 暂停:父页发空表,舞台全丢;再播全部重发
  stage.accept(sender.decorate([]));
  assert.equal(stage.size, 0);
  assert.equal(sender.heldCount, 0);
  assert.equal(Object.keys(sender.decorate([plane([0, 1])])[0].blocks).length, 3);
});

test('缺块:舞台手里没有的清单、开头文件、分段,取的时候当场回绝(那一拍落到快照),不挂着等', async () => {
  const data = planeData('K', [0, 1], { drop: [H(0x101)] });   // 清单列着第 1 段,字节却不在父页手里
  const sender = new StreamPlaneSender(() => data);
  const stage = new PushedStreamSource();
  const sent = sender.decorate([plane([0, 1])]);
  assert.equal(H(0x101) in sent[0].blocks, false);
  stage.accept(sent);
  await assert.rejects(stage.segment('K', H(0x101)), (e) => e.status === 404);
  await assert.rejects(stage.manifest('nope'), (e) => e.status === 404);
  await assert.rejects(stage.init('K', 'ffffffffffffffff'), (e) => e.status === 404);
  await assert.rejects(new PushedStreamSource().init('K', INIT_ID), (e) => e.status === 404);
  assert.deepEqual([...new Uint8Array(await stage.segment('K', H(0x100)))], [0, 0, 0], '别的段照取');
  // 父页认为舞台没有这一块:字节到了之后补发
  data.blocks.set(H(0x101), buf(1, 1, 1));
  assert.deepEqual(Object.keys(sender.decorate([plane([0, 1])])[0].blocks), [H(0x101)]);
});

test('父页没有这条流的清单(还没取到):平面原样发,不带清单;调用失败后清账,全部重发', () => {
  let data = null;
  const sender = new StreamPlaneSender(() => data);
  assert.deepEqual(sender.decorate([plane([0])]), [{ clipIds: ['a'], key: 'K', ranges: [[0, 0]], originFrame: 0 }]);
  assert.deepEqual(sender.decorate([{ clipIds: ['x'] }]), [{ clipIds: ['x'] }], '没有流键的平面(只占位)不问');
  data = planeData('K', [0]);
  assert.equal(Object.keys(sender.decorate([plane([0])])[0].blocks).length, 2);
  assert.equal('blocks' in sender.decorate([plane([0])])[0], false);
  sender.reset();   // 这一次没送到(舞台在重载)
  assert.equal(Object.keys(sender.decorate([plane([0])])[0].blocks).length, 2);
});

test('两条平面用到同一块(同一条流挂在两张卡上):一次只发一份', () => {
  const data = planeData('K', [0]);
  const sender = new StreamPlaneSender(() => data);
  const sent = sender.decorate([{ clipIds: ['a'], key: 'K', ranges: [[0, 0]], originFrame: 0 }, { clipIds: ['b'], key: 'K', ranges: [[0, 0]], originFrame: 0 }]);
  assert.equal(Object.keys(sent[0].blocks).length, 2);
  assert.equal('blocks' in sent[1], false);
  const stage = new PushedStreamSource();
  stage.accept(sent);
  assert.equal(stage.size, 2);
});

/* ---------------- 播放器:带清单的平面不碰别的字节源 ---------------- */

const fakeCanvas = () => ({ getContext: () => null, style: { getPropertyValue: () => '', setProperty() {} }, width: 0, height: 0, parentElement: null });
const fakeRoot = (canvases) => ({ querySelector(sel) { const m = /^\[data-pc-clip="(.+?)"\] > canvas\[data-pc-stream-plane\]$/.exec(sel); return m ? canvases[m[1]] ?? null : null; } });
function spySource() {
  const calls = [];
  const never = () => new Promise(() => {});
  return { calls, manifest: (k) => { calls.push(['manifest', k]); return never(); }, init: (k, id) => { calls.push(['init', k, id]); return never(); }, segment: (k, f) => { calls.push(['segment', k, f]); return never(); } };
}

test('带清单的流平面:清单当场生效,分段按哈希向推来的块要;预渲染进程那个字节源一次都不问', async () => {
  const data = planeData('K', [0, 1]);
  const http = spySource();
  const player = new StreamPlayer({ root: () => fakeRoot({ a: fakeCanvas() }), source: http });
  const asked = [];
  const segment = player.pushed.segment.bind(player.pushed);
  player.pushed.segment = (key, file) => { asked.push(file); return segment(key, file); };
  player.setPlanes(new StreamPlaneSender(() => data).decorate([plane([0, 1])]), 30);
  player.present(0);
  await flush();
  const [track] = player.diag().tracks;
  assert.equal(track.pushed, true);
  assert.equal(track.manifest, true, '不用等一次清单请求');
  assert.deepEqual(track.bound, { x: 0, y: 0, w: 300, h: 200 });
  assert.deepEqual(asked, [H(0x100)], '第 0 段按哈希向推来的块要');
  assert.deepEqual(http.calls, [], '带了清单的平面不碰预渲染进程的地址');
  assert.deepEqual(player.diag().pushed, { blocks: 3, bytes: 2 + 3 + 3 });
  // 暂停:父页发空表,流关掉,推来的块全丢
  player.setPlanes([], 30);
  assert.deepEqual(player.diag().pushed, { blocks: 0, bytes: 0 });
  assert.equal(player.diag().tracks.length, 0);
});

test('父页带来新的清单(多了分段):同一条轨道当场换上,不重建', async () => {
  let data = planeData('K', [0]);
  const sender = new StreamPlaneSender(() => data);
  const player = new StreamPlayer({ root: () => fakeRoot({ a: fakeCanvas() }), source: spySource() });
  const asked = [];
  const segment = player.pushed.segment.bind(player.pushed);
  player.pushed.segment = (key, file) => { asked.push(file); return segment(key, file).catch((e) => { asked.push('rejected'); throw e; }); };
  player.setPlanes(sender.decorate([plane([0])]), 30);
  player.present(0);
  await flush();
  const seeks = player.diag().tracks[0].seeks;
  // 播到第 1 段:清单里还没有它(父页还没取到)→ 这一拍没有流画面,不出错
  player.setPlanes(sender.decorate([{ clipIds: ['a'], key: 'K', ranges: [[0, 1]], originFrame: 0 }]), 30);
  player.present(15 / 30);
  await flush();
  assert.deepEqual([...player.showingClips()], []);
  // 父页取到了第 1 段,带着新清单再发一次
  data = planeData('K', [0, 1]);
  player.setPlanes(sender.decorate([{ clipIds: ['a'], key: 'K', ranges: [[0, 1]], originFrame: 0 }]), 30);
  player.present(16 / 30);
  await flush();
  assert.ok(asked.includes(H(0x101)), '新清单里有第 1 段了:去要它的字节');
  assert.equal(asked.includes('rejected'), false);
  assert.equal(player.diag().tracks.length, 1);
  assert.ok(player.diag().tracks[0].seeks >= seeks, '还是原来那条轨道');
});

test('桌面的流平面(不带清单)照旧问播放器的字节源', async () => {
  const http = spySource();
  const player = new StreamPlayer({ root: () => fakeRoot({ a: fakeCanvas() }), source: http });
  player.setPlanes([{ clipIds: ['a'], key: 'K', ranges: [[0, 0]], originFrame: 0 }], 30);
  player.present(0);
  await flush();
  assert.deepEqual(http.calls, [['manifest', 'K']]);
  assert.equal(player.diag().tracks[0].pushed, false);
});

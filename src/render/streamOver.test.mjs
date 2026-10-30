/**
 * 超出预算的流平面(`streamPlayer.ts` 的 `OverPlane`):舞台不为它建解码器,只取清单,占位符照清单里这一帧所在分段的位置矩形摆
 * (mechanism/rendering.md「重管线:预渲染」:占位符的位置取流清单里的位置矩形)。跑:npm test -- src/render/streamOver.test.mjs
 *
 *   - 单卡流的位置矩形是包裹层自己的坐标(`boxOf`);组流、依赖下层的流的是舞台坐标(`stageBoxOf`,加清单的 `offset`);
 *   - 没有清单、这个分段没量过:回 null(占位符照老办法定位);
 *   - 播放头进了下一个分段、清单到了:叫宿主一次(占位符的几何是渲染时取的);
 *   - 在线页面:超出预算的平面只带清单、不带字节;
 *   - 舞台坐标换到包裹层坐标(`placeholderHost.ts` 的 `stageBoxToLocal`)。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { StreamPlayer, StreamPlaneSender, MANIFEST_REFRESH_MS } from './streamPlayer.ts';
import { stageBoxToLocal, keepTopOfGroups, geometryFor, resetPlaceholderGeometry, setOverBoxSource, setStreamBoxSource } from './placeholderHost.ts';

globalThis.CSS = { escape: (s) => s };
let now = 1_000_000;
globalThis.__pcRealNow = () => now;
globalThis.__pcRealSetTimeout = () => 0;

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const never = () => new Promise(() => {});
const FPS = 30;

/** 一份清单:第一帧在 `originFrame`,每个分段带(或不带)位置矩形 */
function manifestOf({ kind = 'card', plane = 'local', clipIds = ['a'], boxes = {}, offset = { x: 0, y: 0 } } = {}) {
  const segments = {};
  for (const [n, box] of Object.entries(boxes)) segments[n] = { init: 'i', file: `${n}.m4s`, stride: 15, samples: 15, ...(box ? { box } : {}) };
  return { streamKey: 'K', kind, plane, clipIds, fps: FPS, segmentFrames: 15, bound: { x: -32, y: -32, w: 704, h: 424 }, tight: null, offset, inits: {}, segments };
}
function sourceOf(manifests) {
  const src = { calls: [], manifest: async (key) => { src.calls.push(key); const m = manifests[key]; if (!m) throw new Error('404'); return typeof m === 'function' ? m() : m; }, init: never, segment: never };
  return src;
}
const root = { querySelector: () => null, contains: () => false };

beforeEach(() => { now = 1_000_000; });

test('超出预算的单卡流:不建解码器;占位符的矩形是清单里这一帧所在分段的 box(包裹层坐标),跟着播放头换;变了叫宿主一次', async () => {
  const boxes = { 0: { x: 10, y: 20, w: 300, h: 200 }, 1: { x: 40, y: 20, w: 300, h: 200 }, 2: null };
  const source = sourceOf({ S: manifestOf({ boxes }) });
  let changed = 0;
  const player = new StreamPlayer({ root: () => root, source, onBoxChange: () => { changed++; } });
  // 片段从第 100 帧开始:第 0 段是 100～114,第 1 段是 115～129
  player.setPlanes([], FPS, [{ clipIds: ['a'], key: 'S', ranges: [[0, 2]], originFrame: 100, over: true }]);
  assert.equal(player.hasOver, true);
  assert.equal(player.overBoxOf('a'), null, '还没走过一拍、清单也没到');
  assert.equal(player.boxOf('a'), null, 'boxOf 只管预算以内的流');
  player.present(107 / FPS);
  await flush();
  assert.deepEqual(source.calls, ['S'], '只取清单');
  assert.equal(player.diag().tracks.length, 0, '不建解码器、不建轨道');
  assert.deepEqual(player.overBoxOf('a'), boxes[0]);
  assert.equal(player.stageBoxOf('a'), null, '单卡流的矩形不是舞台坐标');
  assert.equal(changed, 1, '清单到了:叫宿主重取一次');

  player.present(114 / FPS);
  await flush();
  assert.deepEqual(player.overBoxOf('a'), boxes[0]);
  assert.equal(changed, 1, '还在同一个分段:不叫');

  player.present(115 / FPS);
  await flush();
  assert.deepEqual(player.overBoxOf('a'), boxes[1], '进了下一个分段');
  assert.equal(changed, 2);
  assert.deepEqual(source.calls, ['S'], '这一段有矩形:不再问清单');

  // 第 2 段在清单里、只是没量过(桌面上没量过的分段以后也不会有矩形):回 null(占位符照老办法定位),**不再问清单**
  player.present(130 / FPS);
  await flush();
  assert.equal(player.overBoxOf('a'), null);
  assert.equal(changed, 3);
  for (let f = 131; f < 140; f++) { now += MANIFEST_REFRESH_MS + 1; player.present(f / FPS); await flush(); }
  assert.equal(source.calls.length, 1, '清单里已有这一段而没有矩形:播放着也不再取清单');
  // 第 3 段清单里还没有(手里的清单是旧的):隔一会儿再问一次,问到了就有矩形
  boxes[3] = { x: 70, y: 20, w: 300, h: 200 };
  const fresh = manifestOf({ boxes });
  const stale = manifestOf({ boxes: { 0: boxes[0], 1: boxes[1], 2: null } });
  let served = stale;
  source.manifest = async (key) => { source.calls.push(key); return served; };
  player.setPlanes([], FPS, []);
  await flush();
  const player2 = new StreamPlayer({ root: () => root, source });
  player2.setPlanes([], FPS, [{ clipIds: ['a'], key: 'S', ranges: [[0, 3]], originFrame: 100, over: true }]);
  player2.present(146 / FPS);
  await flush();
  assert.equal(source.calls.length, 2);
  assert.equal(player2.overBoxOf('a'), null, '旧清单里没有第 3 段');
  player2.present(147 / FPS);
  await flush();
  assert.equal(source.calls.length, 2, '间隔没到不问');
  served = fresh;
  now += MANIFEST_REFRESH_MS + 1;
  player2.present(148 / FPS);
  await flush();
  assert.equal(source.calls.length, 3, '清单里还没有这一段:隔一会儿再问');
  assert.deepEqual(player2.overBoxOf('a'), boxes[3]);
  player2.stop();

  // 这一拍不再超预算(父页不再标 over):清掉,叫宿主一次
  player.setPlanes([], FPS, []);
  await flush();
  assert.equal(player.hasOver, false);
  assert.equal(player.overBoxOf('a'), null);
  assert.equal(changed, 3, '本来就没有矩形:不用宿主重取');
});

test('超出预算的组流、依赖下层的流:矩形是舞台坐标,每个成员都拿得到;清单说的坐标系和平面对不上的不用', async () => {
  const box = { x: 500, y: 300, w: 640, h: 360 };
  const source = sourceOf({
    G: manifestOf({ kind: 'group', plane: 'stage', clipIds: ['a', 'b'], boxes: { 0: box } }),
    B: manifestOf({ kind: 'below', plane: 'stage', clipIds: ['glass'], boxes: { 0: box }, offset: { x: 4, y: 6 } }),
    W: manifestOf({ kind: 'card', plane: 'local', clipIds: ['wrong'], boxes: { 0: box } }),
  });
  const player = new StreamPlayer({ root: () => root, source });
  player.setPlanes([
    { clipIds: ['a', 'b'], key: 'G', ranges: [[0, 0]], originFrame: 0, over: true },
    { clipIds: ['glass'], key: 'B', ranges: [[0, 0]], originFrame: 0, plane: 'stage', over: true },
    { clipIds: ['wrong'], key: 'W', ranges: [[0, 0]], originFrame: 0, plane: 'stage', over: true },   // 父页说是舞台坐标,清单说是包裹层坐标
  ], FPS);
  player.present(0);
  await flush();
  assert.equal(player.diag().tracks.length, 0, '标了 over 的混在流平面里发来也不建解码器');
  assert.equal(player.overBoxOf('a'), null, '舞台坐标的矩形不当包裹层坐标回');
  assert.deepEqual(player.stageBoxOf('a'), box);
  assert.deepEqual(player.stageBoxOf('b'), box);
  assert.deepEqual(player.stageBoxOf('glass'), { x: 504, y: 306, w: 640, h: 360 }, '加清单的 offset');
  assert.equal(player.stageBoxOf('wrong'), null);
  assert.equal(player.overBoxOf('wrong'), null);
  assert.deepEqual(player.diag().over.map((o) => o.key).sort(), ['B', 'G', 'W']);
  // 整组只有一个矩形:宿主据此只让一个成员(最上面的,列表里最后一个)显示占位符
  assert.deepEqual(player.overGroups(), [['a', 'b']], '只列有位置矩形的组流;依赖下层的流只有一张卡,不列');
  player.stop();
  assert.equal(player.hasOver, false, '退到 back:清掉');
});

test('父页带来清单的(在线页面):直接用,不问字节源;带来新清单当场换', async () => {
  const source = sourceOf({});
  let changed = 0;
  const player = new StreamPlayer({ root: () => root, source, onBoxChange: () => { changed++; } });
  const first = manifestOf({ boxes: { 0: { x: 1, y: 2, w: 30, h: 40 } } });
  player.setPlanes([], FPS, [{ clipIds: ['a'], key: 'S', ranges: [[0, 0]], originFrame: 0, over: true, manifest: first }]);
  player.present(0);
  await flush();
  assert.deepEqual(player.overBoxOf('a'), { x: 1, y: 2, w: 30, h: 40 });
  assert.deepEqual(source.calls, []);
  const next = manifestOf({ boxes: { 0: { x: 5, y: 2, w: 30, h: 40 } } });
  player.setPlanes([], FPS, [{ clipIds: ['a'], key: 'S', ranges: [[0, 0]], originFrame: 0, over: true, manifest: next }]);
  await flush();
  assert.deepEqual(player.overBoxOf('a'), { x: 5, y: 2, w: 30, h: 40 });
  assert.equal(changed, 2);
  assert.deepEqual(source.calls, []);
});

test('在线页面发流平面:超出预算的平面只带清单、不带字节,也不记进「舞台手里的块」', () => {
  const hash = (c) => c.repeat(64);
  const manifest = (seg, init) => ({ ...manifestOf({}), inits: { i: { codec: 'avc1.640028', width: 64, height: 144, rect: { x: 0, y: 0, w: 64, h: 64 }, hash: init } },
    segments: { 0: { init: 'i', file: seg, stride: 15, samples: 15, box: { x: 0, y: 0, w: 8, h: 8 } } } });
  const data = {
    IN: { manifest: manifest(hash('a'), hash('b')), blocks: new Map([[hash('a'), new Uint8Array(4)], [hash('b'), new Uint8Array(4)]]) },
    OV: { manifest: manifest(hash('c'), hash('d')), blocks: new Map([[hash('c'), new Uint8Array(4)], [hash('d'), new Uint8Array(4)]]) },
  };
  const sender = new StreamPlaneSender((key) => data[key] ?? null);
  const out = sender.decorate([
    { clipIds: ['in'], key: 'IN', ranges: [[0, 0]], originFrame: 0 },
    { clipIds: ['ov'], key: 'OV', ranges: [[0, 0]], originFrame: 0, over: true },
  ]);
  assert.deepEqual(Object.keys(out[0].blocks).sort(), [hash('a'), hash('b')]);
  assert.equal(out[1].over, true);
  assert.equal(out[1].manifest, data.OV.manifest, '清单带着:占位符照它的位置矩形摆');
  assert.equal(out[1].blocks, undefined, '字节不带');
  assert.equal(sender.heldCount, 2, '舞台手里只有预算以内那一条的块');
});

test('stageBoxToLocal:舞台坐标的矩形换到包裹层自己的坐标;只认平移加等比缩放的包裹层', () => {
  const box = { x: 500, y: 300, w: 640, h: 360 };
  // 预览不缩放、包裹层在舞台的 (400, 200)、不缩放
  assert.deepEqual(stageBoxToLocal(box, { ref: { left: 0, top: 0, width: 1920 }, refWidth: 1920, wrap: { left: 400, top: 200, width: 640 }, wrapWidth: 640, transform: 'none' }),
    { x: 100, y: 100, w: 640, h: 360 });
  // 预览缩到一半、舞台在屏幕的 (50, 20)
  assert.deepEqual(stageBoxToLocal(box, { ref: { left: 50, top: 20, width: 960 }, refWidth: 1920, wrap: { left: 250, top: 120, width: 320 }, wrapWidth: 640 }),
    { x: 100, y: 100, w: 640, h: 360 });
  // 包裹层自己缩到 0.5(绕中心):屏幕上宽 320,左上角在舞台的 (560, 290)
  assert.deepEqual(stageBoxToLocal(box, { ref: { left: 0, top: 0, width: 1920 }, refWidth: 1920, wrap: { left: 560, top: 290, width: 320 }, wrapWidth: 640, transform: 'matrix(0.5, 0, 0, 0.5, 0, 0)' }),
    { x: -120, y: 20, w: 1280, h: 720 });
  // 转过的、带三维的:换不了,照老办法定位
  const at = { ref: { left: 0, top: 0, width: 1920 }, refWidth: 1920, wrap: { left: 400, top: 200, width: 640 }, wrapWidth: 640 };
  assert.equal(stageBoxToLocal(box, { ...at, transform: 'matrix(0.866, 0.5, -0.5, 0.866, 0, 0)' }), null);
  assert.equal(stageBoxToLocal(box, { ...at, transform: 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)' }), null);
  assert.equal(stageBoxToLocal(box, { ...at, wrapWidth: 0 }), null);
});

test('占位符的几何:超出预算的层用这一帧的位置矩形,不记下来;换不出矩形时照老办法定位,不沿用上一段的', () => {
  resetPlaceholderGeometry();
  const size = { width: 640, height: 360 };
  let over = { x: 10, y: 20, w: 300, h: 200 };
  let stream = null;
  setOverBoxSource(() => over);
  setStreamBoxSource(() => stream);
  assert.deepEqual(geometryFor('a', size), { kind: 'solid', box: { left: 10, top: 20, width: 300, height: 200 } });
  // 下一段没量过(或者包裹层转了,舞台坐标换不过来):回到老办法 —— 没有别的框就是徽标,不是上一段的矩形
  over = null;
  assert.deepEqual(geometryFor('a', size), { kind: 'badge', center: { x: 320, y: 180 } });
  // 预算以内的流的框照旧记着(流停了也留着);超出预算的那一帧矩形在的时候先用它
  stream = { x: 1, y: 2, w: 30, h: 40 };
  assert.deepEqual(geometryFor('a', size), { kind: 'solid', box: { left: 1, top: 2, width: 30, height: 40 } });
  stream = null;
  assert.deepEqual(geometryFor('a', size).box, { left: 1, top: 2, width: 30, height: 40 }, '预算以内的流的框留着');
  over = { x: 50, y: 60, w: 70, h: 80 };
  assert.deepEqual(geometryFor('a', size).box, { left: 50, top: 60, width: 70, height: 80 });
  over = null;
  assert.deepEqual(geometryFor('a', size).box, { left: 1, top: 2, width: 30, height: 40 }, '超出预算的矩形没有了:回到原来记着的那一个,不是刚才那一帧的');
  setOverBoxSource(() => null);
  setStreamBoxSource(() => null);
  resetPlaceholderGeometry();
});

test('超出预算的组流:整组只有一个矩形,只让这一拍要显示占位符的成员里最上面的那一张显示', () => {
  const wanted = (ids) => new Map(ids.map((id) => [id, 'pending']));
  assert.deepEqual([...keepTopOfGroups(wanted(['a', 'b', 'c', 'x']), [['a', 'b', 'c']]).keys()], ['c', 'x'], '最后一个在最上面;组外的不动');
  assert.deepEqual([...keepTopOfGroups(wanted(['a', 'b', 'x']), [['a', 'b', 'c']]).keys()], ['b', 'x'], '最上面那张这一拍不显示(没挂着):留它下面最近的一张');
  assert.deepEqual([...keepTopOfGroups(wanted(['a', 'x']), [['a', 'b']]).keys()], ['a', 'x']);
  assert.deepEqual([...keepTopOfGroups(wanted(['a', 'b', 'c', 'd']), [['a', 'b'], ['c', 'd']]).keys()], ['b', 'd']);
  assert.deepEqual([...keepTopOfGroups(wanted(['a', 'b']), []).keys()], ['a', 'b'], '这一帧没有位置矩形的组不在表里:各自照老办法定位');
});

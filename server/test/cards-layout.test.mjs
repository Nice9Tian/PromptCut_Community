/*
 * D4(b) `/api/cards/layout`(预渲染的整场景实体框)。
 *
 * 纯计算那部分直接测(素材段的框、回包成型);要开浏览器的那部分把
 * `bakeFrames` / `captureSnapshot` 两个模块替掉,只验「一次请求只渲一遍」
 * 和 `{ screenshot: false }` + 钩子确实传下去了。
 *
 * 跑法:`node --experimental-test-module-mocks --test server/test/cards-layout.test.mjs`
 * 带 `PC_STAGE_TEST_URL` 时最后一条会真打一台 dev server(不带就整条跳过)。
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const bakeCalls = [];
const captureCalls = [];
let measured = [];

mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: {
    openBakery: async () => { throw new Error('openBakery is not used by the layout path'); },
    findFfmpeg: async () => 'ffmpeg',
    bakeFrames: async (_bakery, opts) => {
      bakeCalls.push(opts);
      for (const frame of opts.snapshotFrames || []) await opts.onSnapshot?.(frame, `<div data-pc-scene="" data-frame="${frame}"></div>`, []);
    },
  },
});
mock.module(new URL('../bakery/capture-snapshot.mjs', import.meta.url).href, {
  exports: {
    captureSnapshot: async (_bakery, html, screenshot, options = {}) => {
      captureCalls.push({ html, screenshot, options });
      // 真实实现在 fonts.ready 之后 prepareFrameMedia 之前跑钩子;这里只把返回值透出来
      return options.afterFonts ? await options.afterFonts({ evaluate: async () => measured }) : Buffer.alloc(0);
    },
  },
});

const { FramePipeline, layoutClips, frameContentBox, measureEntityRects } = await import('../frame-pipeline.mjs');

const stage = { width: 1920, height: 1080 };

test('素材段的 contentBox 就是它的 frameCss 框', () => {
  // 没有 frame = 铺满舞台(resolveFrameSize 的默认值)
  assert.deepEqual(frameContentBox(undefined, stage), { left: 0, top: 0, width: 1920, height: 1080 });
  // 锚点在左上角:(x, y) 就是左上角
  assert.deepEqual(frameContentBox({ x: 100, y: 50, w: 640, h: 360 }, stage), { left: 100, top: 50, width: 640, height: 360 });
  // 锚点在正中:左上角 = (x, y) 减去半个框
  assert.deepEqual(frameContentBox({ x: 960, y: 540, w: 640, h: 360, anchor: [0.5, 0.5] }, stage), { left: 640, top: 360, width: 640, height: 360 });
  // 只给了一边的宽高:另一边铺满
  assert.deepEqual(frameContentBox({ w: 800 }, stage), { left: 0, top: 0, width: 800, height: 1080 });
  // 取整,和页面侧 roundBox 一致
  assert.deepEqual(frameContentBox({ x: 10.4, y: 10.6, w: 100.5, h: 99.4 }, stage), { left: 10, top: 11, width: 101, height: 99 });
});

const project = {
  width: 1920, height: 1080, fps: 30, duration: 4,
  tracks: [{ id: 't1', clips: [
    { id: 'card-a', cardId: 'scene-3d', start: 0, end: 2, frame: { x: 0, y: 0, w: 1920, h: 1080 } },
    { id: 'card-b', cardId: 'odometer', start: 2, end: 4, frame: { x: 0, y: 0, w: 1920, h: 1080 } },
    { id: 'media-a', start: 0, end: 4, frame: { x: 200, y: 100, w: 800, h: 450 } },
  ] }],
};

test('回包成型:卡片按量到的实体框,素材段按项目数据,找不到 / 不在画面上都带 contentNote', () => {
  const list = [{ clipId: 'card-a', rect: { left: 0, top: 0, width: 1920, height: 1080 }, bounds: { left: 704.2, top: 268.8, width: 512.4, height: 541.1 } }];
  const { stage: st, clips, cardIds } = layoutClips(project, ['card-a', 'card-b', 'media-a', 'nope'], list, 1);
  assert.deepEqual(st, stage);
  assert.deepEqual(cardIds, ['card-a', 'card-b']);
  // 量到了:bounds 优先于包裹层 rect,且取整
  assert.deepEqual(clips['card-a'].contentBox, { left: 704, top: 269, width: 512, height: 541 });
  assert.equal(clips['card-a'].contentNote, undefined);
  // 这一刻不在画面上:null + 说明,别被当成「没内容」
  assert.equal(clips['card-b'].contentBox, null);
  assert.match(clips['card-b'].contentNote, /不在画面上/);
  // 素材段:不进快照,等于它的 frameCss 框
  assert.deepEqual(clips['media-a'].contentBox, { left: 200, top: 100, width: 800, height: 450 });
  assert.equal(clips['nope'].contentBox, null);
  assert.match(clips['nope'].contentNote, /找不到 clip nope/);
});

test('量不到实体范围时退回包裹层外框;不传 clipIds 返回全部片段(卡片 + 素材段)', () => {
  const list = [{ clipId: 'card-a', rect: { left: 1, top: 2, width: 3, height: 4 }, bounds: null }];
  const { clips } = layoutClips(project, null, list, 0);
  assert.deepEqual(Object.keys(clips).sort(), ['card-a', 'card-b', 'media-a']);
  assert.deepEqual(clips['card-a'].contentBox, { left: 1, top: 2, width: 3, height: 4 });
});

/** 只挡住磁盘和浏览器,layout / layoutNow 本身跑真的 */
function stubbed(entryProject, html = new Map()) {
  const service = new FramePipeline({ root: '.', origin: () => '' });
  const entry = { key: 'k', project: entryProject, dir: '.', html, controls: new Map(), recordVersion: 0 };
  const bakery = { page: { evaluate: async () => measured } };
  service.entry = async () => entry;
  service.acquire = async () => bakery;
  service.release = () => {};
  service.save = async () => {};
  return { service, entry };
}

test('一次请求只渲一遍,和问了几个 clipId 无关;第二次命中 entry.html 不再渲', async () => {
  bakeCalls.length = 0; captureCalls.length = 0;
  const clips = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, cardId: 'odometer', start: 0, end: 4, frame: { x: i, y: 0, w: 100, h: 100 } }));
  const big = { ...project, tracks: [{ id: 't1', clips }] };
  measured = clips.map((c, i) => ({ clipId: c.id, rect: { left: i, top: 0, width: 100, height: 100 }, bounds: { left: i + 10, top: 10, width: 40, height: 40 } }));
  const { service, entry } = stubbed(big);

  const first = await service.layout(big, { t: 1, clipIds: clips.map(c => c.id) });
  assert.equal(bakeCalls.length, 1, '30 个 clipId 只触发一次预渲染渲染');
  assert.equal(captureCalls.length, 1, '一次请求只注一次快照');
  assert.deepEqual([...bakeCalls[0].snapshotFrames], [30], 'round(1 × 30)');
  assert.equal(bakeCalls[0].snapshotOnly, true, 'layout 不产 PNG');
  assert.equal(first.frame, 30);
  assert.equal(first.t, 1);
  assert.equal(first.baked, true);
  assert.deepEqual(first.stage, stage);
  assert.equal(Object.keys(first.clips).length, 30);
  assert.deepEqual(first.clips['c0'].contentBox, { left: 10, top: 10, width: 40, height: 40 });
  // 钩子和 screenshot: false 确实传到了 captureSnapshot
  assert.equal(captureCalls[0].options.screenshot, false);
  assert.equal(typeof captureCalls[0].options.afterFonts, 'function');
  // 冻出来的这一帧被 record 进 entry.html,下一次就该命中
  assert.equal(entry.html.has(30), true);

  const second = await service.layout(big, { t: 1, clipIds: ['c0'] });
  assert.equal(bakeCalls.length, 1, '命中 entry.html 就不再 bake');
  assert.equal(captureCalls.length, 2, '还是要注一次快照才量得到');
  assert.equal(second.baked, false);
  assert.deepEqual(second.clips['c0'].contentBox, { left: 10, top: 10, width: 40, height: 40 });
});

test('像素已经有了也不短路:entry.html 没有这一帧照样冻一张出来量', async () => {
  bakeCalls.length = 0; captureCalls.length = 0;
  measured = [{ clipId: 'card-a', rect: { left: 0, top: 0, width: 1920, height: 1080 }, bounds: { left: 8, top: 8, width: 64, height: 64 } }];
  const { service, entry } = stubbed(project);
  // MOV 命中的那条路只喂像素,这里连 mov 都不看
  entry.mov = { lookup: async () => Buffer.alloc(10), ready: Promise.resolve() };
  const out = await service.layout(project, { t: 0, clipIds: ['card-a'] });
  assert.equal(bakeCalls.length, 1);
  assert.deepEqual(out.clips['card-a'].contentBox, { left: 8, top: 8, width: 64, height: 64 });
});

test('只问素材段时一趟浏览器都不开', async () => {
  bakeCalls.length = 0; captureCalls.length = 0;
  const { service } = stubbed(project);
  const out = await service.layout(project, { t: 1, clipIds: ['media-a'] });
  assert.equal(bakeCalls.length, 0);
  assert.equal(captureCalls.length, 0);
  assert.deepEqual(out.clips['media-a'].contentBox, { left: 200, top: 100, width: 800, height: 450 });
});

test('t 夹在项目时长内,帧号按 round(t × fps)', async () => {
  bakeCalls.length = 0;
  measured = [];
  const { service } = stubbed(project);
  assert.equal((await service.layout(project, { t: -5, clipIds: ['card-a'] })).frame, 0);
  assert.equal((await service.layout(project, { t: 999, clipIds: ['card-a'] })).frame, 119, 'floor(4 × 30) - 1');
  assert.equal((await service.layout(project, { t: 1.49, clipIds: ['card-a'] })).frame, 45);
});

/* ---------------- D3:see_frames 每帧附的实体矩形 ---------------- */

test('D3 entityRects:缺的帧一次 bakeFrames 补齐,每帧注一次快照、不截图,钩子就是 measureEntityRects', async () => {
  bakeCalls.length = 0; captureCalls.length = 0;
  measured = [{ clipId: 'card-a', box: [0, 0, 1920, 1080], solid: [10, 20, 30, 40] }];
  const { service, entry } = stubbed(project, new Map([[15, '<div data-pc-scene=""></div>']]));
  const out = await service.entityRects(project, [0.5, 1, 1, 999]);
  assert.deepEqual([...out.keys()], [15, 30, 119], '去重、夹进时长、按帧号排');
  assert.equal(bakeCalls.length, 1, '缺的两帧合成一趟');
  assert.deepEqual(bakeCalls[0].targetFrames, [30, 119]);
  assert.equal(bakeCalls[0].snapshotOnly, true);
  assert.equal(captureCalls.length, 3, '每帧一次');
  for (const call of captureCalls) {
    assert.equal(call.options.screenshot, false);
    assert.equal(call.options.afterFonts, measureEntityRects);
  }
  assert.deepEqual(out.get(30), measured);
  assert.equal(entry.html.has(119), true, '补出来的快照 record 进去,下次命中');
});

test('D3 entityRects:页面没挂 __pcSolid(钩子回 null)时那一帧是 null,不是空数组', async () => {
  measured = null;
  const { service } = stubbed(project, new Map([[0, '<div></div>']]));
  const out = await service.entityRects(project, [0]);
  assert.equal(out.get(0), null);
});

/*
 * measureEntityRects 的页面函数:拿一棵假 DOM 直接跑(page.evaluate = 就地调用),
 * 只验「solid 什么时候是 null」—— bounds 的数值是 solid.ts 自己的事。
 */
class FakeRect {
  constructor(left, top, width, height) { Object.assign(this, { left, top, width, height, right: left + width, bottom: top + height }); }
}
function el(tag, attrs = {}, rect = [0, 0, 0, 0], children = []) {
  const node = {
    tagName: tag, children, attrs, rect: new FakeRect(...rect),
    hasAttribute: n => n in attrs, getAttribute: n => (n in attrs ? String(attrs[n]) : null),
    getBoundingClientRect: () => node.rect,
    querySelector: sel => {
      const id = /\[data-pc-clip="(.+)"\]/.exec(sel)?.[1];
      const find = n => (n.attrs['data-pc-clip'] === id ? n : n.children.map(find).find(Boolean));
      return node.children.map(find).find(Boolean) || null;
    },
  };
  return node;
}
async function runMeasure(root, list) {
  const saved = { document: globalThis.document, window: globalThis.window, DOMRect: globalThis.DOMRect, CSS: globalThis.CSS };
  globalThis.document = { querySelector: () => root };
  globalThis.window = { __pcSolid: { rectsWithBounds: () => list, isSolid: n => !!n.attrs.solid } };
  globalThis.DOMRect = FakeRect;
  globalThis.CSS = { escape: s => s };
  try { return await measureEntityRects({ evaluate: fn => fn() }); }
  finally { Object.assign(globalThis, saved); }
}

test('D3 measureEntityRects:有实体给 bounds,整张卡没画 / 实体全在舞台外 / 只有组流平面 都给 null', async () => {
  const full = new FakeRect(0, 0, 1920, 1080);
  const root = el('DIV', { 'data-pc-scene': '' }, [0, 0, 1920, 1080], [
    el('DIV', { 'data-pc-clip': 'painted' }, [0, 0, 1920, 1080], [el('DIV', {}, [0, 0, 1920, 1080], [el('SPAN', { solid: 1 }, [100, 200, 300.4, 50.6])])]),
    el('DIV', { 'data-pc-clip': 'empty' }, [0, 0, 1920, 1080], [el('DIV', {}, [0, 0, 500, 500])]),
    el('DIV', { 'data-pc-clip': 'offstage' }, [0, 0, 1920, 1080], [el('SPAN', { solid: 1 }, [2000, 0, 100, 100])]),
    el('DIV', { 'data-pc-clip': 'group' }, [0, 0, 1920, 1080], [el('CANVAS', { 'data-pc-group-plane': '' }, [0, 0, 1920, 1080])]),
    el('DIV', { 'data-pc-clip': 'plane' }, [0, 0, 1920, 1080], [el('IMG', { 'data-pc-snapshot-plane': '' }, [10, 10, 20, 20])]),
    // 快照里 canvas 换成的 <img>:外框在舞台上,但实体那一块(画布像素 3900.. → 舞台 1950..)在舞台外
    el('DIV', { 'data-pc-clip': 'painted-off' }, [0, 0, 1920, 1080], [el('IMG', { solid: 1, 'data-pc-painted-box': '3900,0,10,10', width: 3840, height: 1080 }, [0, 0, 1920, 1080])]),
  ]);
  const list = ['painted', 'empty', 'offstage', 'group', 'plane', 'painted-off'].map(clipId => ({ clipId, rect: full, bounds: clipId === 'painted' ? new FakeRect(100, 200, 300.4, 50.6) : full }));
  const out = await runMeasure(root, list);
  const by = Object.fromEntries(out.map(r => [r.clipId, r]));
  assert.deepEqual(by.painted, { clipId: 'painted', box: [0, 0, 1920, 1080], solid: [100, 200, 300, 51] }, '取整');
  assert.equal(by.empty.solid, null, '没有实体元素');
  assert.equal(by.offstage.solid, null, '实体全在舞台外');
  assert.equal(by.group.solid, null, '组流平面不算这张卡的实体');
  assert.deepEqual(by.plane.solid, [0, 0, 1920, 1080], '快照 / 流 / 代理平面算实体');
  assert.equal(by['painted-off'].solid, null, '按 data-pc-painted-box 那一块判');
  // 页面上没挂 __pcSolid
  globalThis.window = {};
  const saved = globalThis.document;
  globalThis.document = { querySelector: () => root };
  try { assert.equal(await measureEntityRects({ evaluate: fn => fn() }), null); }
  finally { globalThis.document = saved; delete globalThis.window; }
});

/* 真打一台 dev server(PC_STAGE_TEST_URL=http://127.0.0.1:5214);不设就跳过。 */
test('集成:/api/cards/layout 对真实项目返回整数框', { skip: !process.env.PC_STAGE_TEST_URL }, async () => {
  const origin = process.env.PC_STAGE_TEST_URL.replace(/\/+$/, '');
  const live = {
    width: 1920, height: 1080, fps: 30, duration: 3, tracks: [{ id: 't1', clips: [
      { id: 'live-card', cardId: 'odometer', start: 0, end: 3, frame: { x: 0, y: 0, w: 1920, h: 1080 } },
      { id: 'live-media', start: 0, end: 3, frame: { x: 120, y: 60, w: 640, h: 360 } },
    ] }], media: [],
  };
  const res = await fetch(`${origin}/api/cards/layout`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: live, t: 1, clipIds: ['live-card', 'live-media'] }) });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const data = JSON.parse(text);
  assert.deepEqual(data.stage, { width: 1920, height: 1080 });
  assert.equal(data.frame, 30);
  assert.deepEqual(data.clips['live-media'].contentBox, { left: 120, top: 60, width: 640, height: 360 });
  const box = data.clips['live-card'].contentBox;
  assert.ok(box && Object.values(box).every(Number.isInteger), `contentBox 要是整数:${JSON.stringify(data.clips['live-card'])}`);
});

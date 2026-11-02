/*
 * D4(b) `/api/cards/layout` (whole scene entity box for prerender).
 *
 * The pure computation part is tested directly (media clip boxes, response formatting); the part
 * that requires opening a browser replaces two modules `bakeFrames` / `captureSnapshot`, only
 * verifying "renders once per request" and that `{ screenshot: false }` + hooks are indeed passed
 * down.
 *
 * How to run: `node --experimental-test-module-mocks --test server/test/cards-layout.test.mjs`
 * When `PC_STAGE_TEST_URL` is set, the last test will actually hit a dev server (skipped entirely
 * if not set).
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
      // Real implementation runs hooks after fonts.ready and before prepareFrameMedia; here only pass
      // through the return value
      return options.afterFonts ? await options.afterFonts({ evaluate: async () => measured }) : Buffer.alloc(0);
    },
  },
});

const { FramePipeline, layoutClips, frameContentBox, measureEntityRects } = await import('../frame-pipeline.mjs');

const stage = { width: 1920, height: 1080 };

test('A media clip\'s contentBox is its frameCss box', () => {
  // No frame = fill the stage (resolveFrameSize default value)
  assert.deepEqual(frameContentBox(undefined, stage), { left: 0, top: 0, width: 1920, height: 1080 });
  // Anchor point at top-left: (x, y) is the top-left corner
  assert.deepEqual(frameContentBox({ x: 100, y: 50, w: 640, h: 360 }, stage), { left: 100, top: 50, width: 640, height: 360 });
  // Anchor point at center: top-left = (x, y) minus half the box
  assert.deepEqual(frameContentBox({ x: 960, y: 540, w: 640, h: 360, anchor: [0.5, 0.5] }, stage), { left: 640, top: 360, width: 640, height: 360 });
  // Width or height given for only one side: the other side fills
  assert.deepEqual(frameContentBox({ w: 800 }, stage), { left: 0, top: 0, width: 800, height: 1080 });
  // Rounded, consistent with page-side roundBox
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

test('Response shape: cards use the measured entity box, media clips use project data, and not found / not in frame both carry contentNote', () => {
  const list = [{ clipId: 'card-a', rect: { left: 0, top: 0, width: 1920, height: 1080 }, bounds: { left: 704.2, top: 268.8, width: 512.4, height: 541.1 } }];
  const { stage: st, clips, cardIds } = layoutClips(project, ['card-a', 'card-b', 'media-a', 'nope'], list, 1);
  assert.deepEqual(st, stage);
  assert.deepEqual(cardIds, ['card-a', 'card-b']);
  // Measured: bounds takes precedence over wrapper layer rect, and rounded
  assert.deepEqual(clips['card-a'].contentBox, { left: 704, top: 269, width: 512, height: 541 });
  assert.equal(clips['card-a'].contentNote, undefined);
  // Not on screen at this moment: null + explanation, not to be mistaken for "no content"
  assert.equal(clips['card-b'].contentBox, null);
  assert.match(clips['card-b'].contentNote, /not on screen/);
  // Media clip: does not enter snapshots, equals its frameCss box
  assert.deepEqual(clips['media-a'].contentBox, { left: 200, top: 100, width: 800, height: 450 });
  assert.equal(clips['nope'].contentBox, null);
  assert.match(clips['nope'].contentNote, /clip nope not found/);
});

test('When the entity extent cannot be measured, fall back to the wrapper layer\'s outer box; without clipIds, return all clips (cards + media clips)', () => {
  const list = [{ clipId: 'card-a', rect: { left: 1, top: 2, width: 3, height: 4 }, bounds: null }];
  const { clips } = layoutClips(project, null, list, 0);
  assert.deepEqual(Object.keys(clips).sort(), ['card-a', 'card-b', 'media-a']);
  assert.deepEqual(clips['card-a'].contentBox, { left: 1, top: 2, width: 3, height: 4 });
});

/** Only stubs out disk and browser, layout / layoutNow themselves run for real */
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

test('A single request renders only once, regardless of how many clipIds are asked; a second request hits entry.html and does not render again', async () => {
  bakeCalls.length = 0; captureCalls.length = 0;
  const clips = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, cardId: 'odometer', start: 0, end: 4, frame: { x: i, y: 0, w: 100, h: 100 } }));
  const big = { ...project, tracks: [{ id: 't1', clips }] };
  measured = clips.map((c, i) => ({ clipId: c.id, rect: { left: i, top: 0, width: 100, height: 100 }, bounds: { left: i + 10, top: 10, width: 40, height: 40 } }));
  const { service, entry } = stubbed(big);

  const first = await service.layout(big, { t: 1, clipIds: clips.map(c => c.id) });
  assert.equal(bakeCalls.length, 1, '30 clipIds trigger only one prerender');
  assert.equal(captureCalls.length, 1, 'A single request injects a snapshot only once');
  assert.deepEqual([...bakeCalls[0].snapshotFrames], [30], 'round(1 × 30)');
  assert.equal(bakeCalls[0].snapshotOnly, true, 'layout produces no PNG');
  assert.equal(first.frame, 30);
  assert.equal(first.t, 1);
  assert.equal(first.baked, true);
  assert.deepEqual(first.stage, stage);
  assert.equal(Object.keys(first.clips).length, 30);
  assert.deepEqual(first.clips['c0'].contentBox, { left: 10, top: 10, width: 40, height: 40 });
  // Hooks and screenshot: false are indeed passed to captureSnapshot
  assert.equal(captureCalls[0].options.screenshot, false);
  assert.equal(typeof captureCalls[0].options.afterFonts, 'function');
  // This frozen frame is recorded into entry.html and should hit next time
  assert.equal(entry.html.has(30), true);

  const second = await service.layout(big, { t: 1, clipIds: ['c0'] });
  assert.equal(bakeCalls.length, 1, 'Once entry.html is hit, it does not bake again');
  assert.equal(captureCalls.length, 2, 'A snapshot still has to be injected before it can be measured');
  assert.equal(second.baked, false);
  assert.deepEqual(second.clips['c0'].contentBox, { left: 10, top: 10, width: 40, height: 40 });
});

test('Do not short-circuit even when the pixels already exist: if entry.html lacks this frame, still freeze one to measure', async () => {
  bakeCalls.length = 0; captureCalls.length = 0;
  measured = [{ clipId: 'card-a', rect: { left: 0, top: 0, width: 1920, height: 1080 }, bounds: { left: 8, top: 8, width: 64, height: 64 } }];
  const { service, entry } = stubbed(project);
  // The MOV hit path only feeds pixels; here mov is not even inspected
  entry.mov = { lookup: async () => Buffer.alloc(10), ready: Promise.resolve() };
  const out = await service.layout(project, { t: 0, clipIds: ['card-a'] });
  assert.equal(bakeCalls.length, 1);
  assert.deepEqual(out.clips['card-a'].contentBox, { left: 8, top: 8, width: 64, height: 64 });
});

test('Asking only for media clips does not open the browser at all', async () => {
  bakeCalls.length = 0; captureCalls.length = 0;
  const { service } = stubbed(project);
  const out = await service.layout(project, { t: 1, clipIds: ['media-a'] });
  assert.equal(bakeCalls.length, 0);
  assert.equal(captureCalls.length, 0);
  assert.deepEqual(out.clips['media-a'].contentBox, { left: 200, top: 100, width: 800, height: 450 });
});

test('t is clamped to the project duration, frame number is round(t × fps)', async () => {
  bakeCalls.length = 0;
  measured = [];
  const { service } = stubbed(project);
  assert.equal((await service.layout(project, { t: -5, clipIds: ['card-a'] })).frame, 0);
  assert.equal((await service.layout(project, { t: 999, clipIds: ['card-a'] })).frame, 119, 'floor(4 × 30) - 1');
  assert.equal((await service.layout(project, { t: 1.49, clipIds: ['card-a'] })).frame, 45);
});

/* ---------------- D3:see_frames entity rectangles attached to each frame ---------------- */

test('D3 entityRects: missing frames are filled by a single bakeFrames, one snapshot is injected per frame with no screenshot, and the hook is measureEntityRects', async () => {
  bakeCalls.length = 0; captureCalls.length = 0;
  measured = [{ clipId: 'card-a', box: [0, 0, 1920, 1080], solid: [10, 20, 30, 40] }];
  const { service, entry } = stubbed(project, new Map([[15, '<div data-pc-scene=""></div>']]));
  const out = await service.entityRects(project, [0.5, 1, 1, 999]);
  assert.deepEqual([...out.keys()], [15, 30, 119], 'Deduplicated, clamped into the duration, sorted by frame number');
  assert.equal(bakeCalls.length, 1, 'The two missing frames are merged into one run');
  assert.deepEqual(bakeCalls[0].targetFrames, [30, 119]);
  assert.equal(bakeCalls[0].snapshotOnly, true);
  assert.equal(captureCalls.length, 3, 'Once per frame');
  for (const call of captureCalls) {
    assert.equal(call.options.screenshot, false);
    assert.equal(call.options.afterFonts, measureEntityRects);
  }
  assert.deepEqual(out.get(30), measured);
  assert.equal(entry.html.has(119), true, 'The newly produced snapshot is recorded, so the next call hits');
});

test('D3 entityRects: when the page has no __pcSolid attached (hook returns null), that frame is null, not an empty array', async () => {
  measured = null;
  const { service } = stubbed(project, new Map([[0, '<div></div>']]));
  const out = await service.entityRects(project, [0]);
  assert.equal(out.get(0), null);
});

/*
 * Page function of measureEntityRects: runs directly with a mock DOM (page.evaluate = invoked in
 * place), only verifying "when solid is null": the value of bounds is solid.ts's own business.
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

test('D3 measureEntityRects: bounds when there are entities; null when the whole card is not painted / all entities are off stage / there is only a group stream plane', async () => {
  const full = new FakeRect(0, 0, 1920, 1080);
  const root = el('DIV', { 'data-pc-scene': '' }, [0, 0, 1920, 1080], [
    el('DIV', { 'data-pc-clip': 'painted' }, [0, 0, 1920, 1080], [el('DIV', {}, [0, 0, 1920, 1080], [el('SPAN', { solid: 1 }, [100, 200, 300.4, 50.6])])]),
    el('DIV', { 'data-pc-clip': 'empty' }, [0, 0, 1920, 1080], [el('DIV', {}, [0, 0, 500, 500])]),
    el('DIV', { 'data-pc-clip': 'offstage' }, [0, 0, 1920, 1080], [el('SPAN', { solid: 1 }, [2000, 0, 100, 100])]),
    el('DIV', { 'data-pc-clip': 'group' }, [0, 0, 1920, 1080], [el('CANVAS', { 'data-pc-group-plane': '' }, [0, 0, 1920, 1080])]),
    el('DIV', { 'data-pc-clip': 'plane' }, [0, 0, 1920, 1080], [el('IMG', { 'data-pc-snapshot-plane': '' }, [10, 10, 20, 20])]),
    // <img> replacing canvas in snapshot: outer box is on stage, but the entity part (canvas pixels
    // 3900.. → stage 1950..) is off-stage
    el('DIV', { 'data-pc-clip': 'painted-off' }, [0, 0, 1920, 1080], [el('IMG', { solid: 1, 'data-pc-painted-box': '3900,0,10,10', width: 3840, height: 1080 }, [0, 0, 1920, 1080])]),
  ]);
  const list = ['painted', 'empty', 'offstage', 'group', 'plane', 'painted-off'].map(clipId => ({ clipId, rect: full, bounds: clipId === 'painted' ? new FakeRect(100, 200, 300.4, 50.6) : full }));
  const out = await runMeasure(root, list);
  const by = Object.fromEntries(out.map(r => [r.clipId, r]));
  assert.deepEqual(by.painted, { clipId: 'painted', box: [0, 0, 1920, 1080], solid: [100, 200, 300, 51] }, 'Rounded to integers');
  assert.equal(by.empty.solid, null, 'No entity elements');
  assert.equal(by.offstage.solid, null, 'All entities are off stage');
  assert.equal(by.group.solid, null, 'A group stream plane does not count as this card\'s entity');
  assert.deepEqual(by.plane.solid, [0, 0, 1920, 1080], 'Snapshot / stream / proxy planes count as entities');
  assert.equal(by['painted-off'].solid, null, 'Judged by the data-pc-painted-box region');
  // __pcSolid is not attached on the page
  globalThis.window = {};
  const saved = globalThis.document;
  globalThis.document = { querySelector: () => root };
  try { assert.equal(await measureEntityRects({ evaluate: fn => fn() }), null); }
  finally { globalThis.document = saved; delete globalThis.window; }
});

/* Actually hits a dev server (PC_STAGE_TEST_URL=http://127.0.0.1:5214); skips if not set. */
test('Integration: /api/cards/layout returns integer boxes for a real project', { skip: !process.env.PC_STAGE_TEST_URL }, async () => {
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
  assert.ok(box && Object.values(box).every(Number.isInteger), `contentBox must be integers: ${JSON.stringify(data.clips['live-card'])}`);
});

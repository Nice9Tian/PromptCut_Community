/**
 * Push-frame supplementary drawing (`server/bakery/bake.mjs` header): for pushed frames where images
 * are not captured, which ticks draw, which do not draw, and whether dropped images enter artifacts.
 * Run with a mock bakery (without launching Chrome), recording which types of ticks were emitted in
 * each frame:
 *   n = a tick without screenshot, J = dropped JPEG (supplementary draw, or the tick drawn before
 *       snapshot generation), P = image-capturing PNG.
 *
 * Pinned behaviors:
 *   - Pushed frames: add one J tick if screen has changes; add two ticks for the first frame of
 *     this pass (same as the first image-capturing frame);
 *   - Frames where screen is static (`__pcStaticProbe` determines static, and no tick in this frame
 *     reports `hasDamage`) are not supplemented; static but reporting changes are still supplemented;
 *   - Supplemented frames are treated as "captured": the immediately following image-capturing
 *     frame does not need to drop one first; after static unsupplemented frames, image-capturing
 *     frames still drop one first as usual;
 *   - Paths that capture images on every frame (full segments, full-density segments following a
 *     lease) have zero J ticks;
 *   - Dropped images are not passed to `onFrame`; when `pushDraw: false` (or `PROMPTCUT_PUSH_DRAW=0`),
 *     no ticks are supplemented, same as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { PNG } from 'pngjs';
import { bakeFrames, bakeStream, createStepper, drawDiscarded, pushDrawEnabled, pushDrawNeeded, PUSH_DRAW_SHOT } from '../bakery/bake.mjs';

const png = (() => { const p = new PNG({ width: 4, height: 2 }); p.data.fill(200); return PNG.sync.write(p); })();
const FPS = 30;

/**
 * `staticFrames`: these frames are determined static by `__pcStaticProbe` (remaining frames have
 * a running animation); `damageFrames`: ticks without screenshot in these frames report `hasDamage`.
 * `log.beats`: records `T<frameNumber>` (dispatched time) and the type of each tick in order of occurrence.
 */
function fakeBakery({ staticFrames = [], damageFrames = [], duration = 10 } = {}) {
  const still = new Set(staticFrames), damaged = new Set(damageFrames);
  const log = { beats: [], setFrameWindow: 0 };
  let frame = 0;
  const bakery = {
    log,
    page: {
      async evaluate(fn, arg) {
        const src = String(fn);
        if (src.includes('__pcTimeline')) return { fps: FPS, width: 64, height: 32, duration };
        if (src.includes('__pcSetFrameWindow')) { log.setFrameWindow++; return undefined; }
        if (src.includes('__pcCreateSnapshot')) return { html: `<i data-f="${frame}"></i>`, lossy: 0, controls: null };
        if (src.includes('__pcStaticProbe')) return still.has(frame) ? { anims: 0, finished: 0, raf: 0, mut: 0, video: false, canvas: false } : { anims: 1, finished: 0, raf: 0, mut: 0, video: false, canvas: false };
        if (src.includes('__pcSetT')) { frame = Math.round(arg.sec * FPS); log.beats.push(`T${frame}`); return { raf: 0, mut: 0 }; }
        if (src.includes('data-pc-pixel-map')) return false;
        return undefined;
      },
      async setViewport() {},
      viewport: () => ({ width: 64, height: 32, deviceScaleFactor: 1 }),
      url: () => 'http://127.0.0.1/?export=1',
    },
    client: { async send() {} },
    async beginFrame(extra = {}) {
      const format = extra.screenshot?.format;
      log.beats.push(format === 'png' ? 'P' : format === 'jpeg' ? 'J' : 'n');
      if (format === 'png') return { screenshotData: png.toString('base64'), hasDamage: true };
      if (format === 'jpeg') return { screenshotData: 'AA==', hasDamage: true };
      return { hasDamage: damaged.has(frame) };
    },
    async waitNet() {},
  };
  return bakery;
}

/**
 * In the pass after warm-up, how many J ticks and P ticks each frame emits.
 * `warmSteps`: how many times time was dispatched during warm-up (default 4: 3 warm-up frames +
 * 1 frame after remount).
 */
function perFrame(log, warmSteps = 4) {
  const out = new Map();
  let steps = 0, cur = null;
  for (const b of log.beats) {
    if (b[0] === 'T') { steps++; cur = steps > warmSteps ? Number(b.slice(1)) : null; if (cur !== null && !out.has(cur)) out.set(cur, { J: 0, P: 0 }); continue; }
    if (cur !== null && (b === 'J' || b === 'P')) out.get(cur)[b]++;
  }
  return Object.fromEntries([...out].map(([f, c]) => [f, `${'J'.repeat(c.J)}${'P'.repeat(c.P)}`]));
}

async function bake(bakery, opts) {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-push-draw-test-'));
  const frames = [];
  const log = console.log;
  console.log = () => {};
  try {
    const result = await bakeFrames(bakery, { out, fps: FPS, fullFrame: true, quiet: true, writeFrames: false, staticSkip: false, onFrame: async (i, buf) => { frames.push([i, buf]); }, ...opts });
    return { result, frames };
  } finally {
    console.log = log;
    await fs.rm(out, { recursive: true, force: true });
  }
}

test('pushDrawNeeded: always draw when nothing has been drawn in this pass; draw while the picture is changing; when static, draw only if a change was reported and the previous frame was not drawn (a change reported after the previous frame was drawn is an echo)', () => {
  assert.equal(pushDrawNeeded({ isStatic: true, damaged: false, drawnBefore: false, previousDrawn: false }), true);
  assert.equal(pushDrawNeeded({ isStatic: false, damaged: false, drawnBefore: true, previousDrawn: true }), true);
  assert.equal(pushDrawNeeded({ isStatic: true, damaged: true, drawnBefore: true, previousDrawn: false }), true);
  assert.equal(pushDrawNeeded({ isStatic: true, damaged: true, drawnBefore: true, previousDrawn: true }), false);
  assert.equal(pushDrawNeeded({ isStatic: true, damaged: false, drawnBefore: true, previousDrawn: false }), false);
});

test('pushDrawEnabled: on by default; PROMPTCUT_PUSH_DRAW=0 turns it off; if the caller passes pushDraw, that takes precedence', () => {
  assert.equal(pushDrawEnabled({}, {}), true);
  assert.equal(pushDrawEnabled({}, { PROMPTCUT_PUSH_DRAW: '0' }), false);
  assert.equal(pushDrawEnabled({ pushDraw: true }, { PROMPTCUT_PUSH_DRAW: '0' }), true);
  assert.equal(pushDrawEnabled({ pushDraw: false }, {}), false);
  assert.deepEqual(PUSH_DRAW_SHOT, { format: 'jpeg', quality: 0 });
});

test('drawDiscarded: one tick for a screenshot JPEG; two ticks on prime; if no picture is handed back, resend in place, at most four ticks, without an error', async () => {
  const a = fakeBakery();
  assert.equal(await drawDiscarded(a, false), 1);
  assert.equal(await drawDiscarded(a, true), 2);
  assert.deepEqual(a.log.beats, ['J', 'J', 'J']);
  let n = 0;
  const empty = { async beginFrame(extra) { n++; assert.deepEqual(extra.screenshot, PUSH_DRAW_SHOT); return {}; } };
  assert.equal(await drawDiscarded(empty, false), 4);
  assert.equal(n, 4);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(drawDiscarded(a, false, controller.signal), e => e.cancelled);
});

test('bakeFrames exports only one segment: of the pushed frames, changed ones get one extra tick, the first frame gets two, static ones get none; discarded ones do not go into onFrame', async () => {
  const bakery = fakeBakery({ staticFrames: [2, 3] });
  const { result, frames } = await bake(bakery, { frames: '4-5', pushDraw: true });
  assert.deepEqual(perFrame(bakery.log), { 0: 'JJ', 1: 'J', 2: '', 3: '', 4: 'PP', 5: 'P' },
    'frame 0 (first frame of this pass) gets two ticks, frame 1 gets one, static frames 2 and 3 get none; for frame 4 the previous frame was not drawn, so one picture is still discarded first as before');
  assert.deepEqual(frames.map(([i]) => i), [4, 5]);
  assert.ok(frames.every(([, buf]) => Buffer.from(buf).equals(png)), 'only the captured PNG is handed out');
  assert.equal(result.pushDrawn, 3);
});

test('bakeFrames: a frame that got an extra draw counts as "captured", so the capture frame right after it no longer drops one first; a static frame that reports a visual change gets an extra draw only if the previous frame was not drawn', async () => {
  const bakery = fakeBakery({ staticFrames: [2, 3], damageFrames: [2, 3] });
  const { result } = await bake(bakery, { frames: '4-5', pushDraw: true });
  // Frame 2: previous frame (1) was just drawn, reported change is an echo, do not supplement;
  // Frame 3: previous frame was not drawn, supplement
  assert.deepEqual(perFrame(bakery.log), { 0: 'JJ', 1: 'J', 2: '', 3: 'J', 4: 'P', 5: 'P' });
  assert.equal(result.pushDrawn, 4);
});

test('bakeFrames: when turned off (pushDraw: false), no extra tick is added at all, and the capture frames are the same as before', async () => {
  const bakery = fakeBakery({ staticFrames: [2, 3] });
  const { result, frames } = await bake(bakery, { frames: '4-5', pushDraw: false });
  assert.deepEqual(perFrame(bakery.log), { 0: '', 1: '', 2: '', 3: '', 4: 'PP', 5: 'P' });
  assert.deepEqual(frames.map(([i]) => i), [4, 5]);
  assert.equal(result.pushDrawn, 0);
});

test('bakeFrames with every frame of the whole range captured: not a single extra tick is run (the byte-for-byte baseline relies on this one)', async () => {
  const on = fakeBakery({ staticFrames: [1] });
  const off = fakeBakery({ staticFrames: [1] });
  const a = await bake(on, { frames: '0-3', pushDraw: true });
  await bake(off, { frames: '0-3', pushDraw: false });
  assert.deepEqual(perFrame(on.log), { 0: 'PP', 1: 'P', 2: 'P', 3: 'P' });
  assert.deepEqual(on.log.beats, off.log.beats, 'on and off are identical tick by tick');
  assert.equal(a.result.pushDrawn, 0);
});

test('bakeFrames in a pass that only generates snapshots (like get_layout): frames that are pushed through get an extra draw, and if the snapshot frame was preceded by a draw, it draws just one tick', async () => {
  const bakery = fakeBakery({ staticFrames: [1] });
  const snapshots = [];
  const { frames } = await bake(bakery, { fullFrame: false, targetFrames: [3], snapshotOnly: true, snapshotFrames: new Set([3]), onSnapshot: (n, html) => { snapshots.push([n, html]); }, pushDraw: true });
  // Frame 3's tick was drawn before generating snapshots (`flushFrameLoop`), not supplementary draw;
  // frame 2 was supplemented, so it only draws one tick
  assert.deepEqual(perFrame(bakery.log), { 0: 'JJ', 1: '', 2: 'J', 3: 'J' });
  assert.deepEqual(snapshots, [[3, '<i data-f="3"></i>']]);
  assert.deepEqual(frames, []);
});

// With screenshot rectangle (all streams in product have it): rectangle is set before warm-up,
// and the tick dropped during that rectangle setup does not fall into any frame
const seg = (n, extra = {}) => ({ streamSignature: 'S', fromFrame: n * 15, toFrame: n * 15 + 14, stride: 1, fps: FPS, mountFrame: 0, clip: { x: 0, y: 0, w: 32, h: 16 }, ...extra });

test('bakeStream with a broken lease: replayed frames get an extra draw (two ticks for the first frame), after which the first capture no longer drops one first; dropped captures do not go into onFrame', async () => {
  const bakery = fakeBakery({ staticFrames: [24, 25] });
  const frames = [];
  const stats = await bakeStream(bakery, { ...seg(2), mountFrame: 20, onFrame: async (f, shot) => { frames.push(f); assert.ok(Buffer.from(shot).equals(png)); } });
  const per = perFrame(bakery.log);
  assert.equal(per[20], 'JJ');
  for (const f of [21, 22, 23, 26, 27, 28, 29]) assert.equal(per[f], 'J', `replayed frame ${f} gets one extra tick`);
  for (const f of [24, 25]) assert.equal(per[f], '', `static frame ${f} gets no extra tick`);
  for (let f = 30; f <= 44; f++) assert.equal(per[f], 'P', `frame ${f} takes only one capture`);
  assert.deepEqual(frames, Array.from({ length: 15 }, (_, i) => 30 + i));
  assert.deepEqual({ replayed: stats.replayed, captured: stats.captured, pushDrawn: stats.pushDrawn }, { replayed: 10, captured: 15, pushDrawn: 9 });
});

test('bakeStream with a sparse segment: only the first frame is captured, and each remaining frame with a visual change gets one extra tick; the next segment continues the lease, and its first frame no longer drops one first', async () => {
  const bakery = fakeBakery({ staticFrames: [5, 6] });
  const frames = [];
  const first = await bakeStream(bakery, { ...seg(0), stride: 15, onFrame: async (f) => { frames.push(f); } });
  const next = await bakeStream(bakery, { ...seg(1), stride: 15, onFrame: async (f) => { frames.push(f); } });
  const per = perFrame(bakery.log);
  assert.equal(per[0], 'PP', 'the first capture of this lease still drops one first');
  for (let f = 1; f <= 14; f++) assert.equal(per[f], f === 5 || f === 6 ? '' : 'J');
  assert.equal(per[15], 'P');
  assert.deepEqual(frames, [0, 15]);
  assert.equal(first.pushDrawn, 12);
  assert.equal(next.reset, false);
  assert.equal(next.pushDrawn, 14);
});

test('bakeStream with a full-density segment that continues the lease: no extra tick at all; when turned off, replay gets no extra draw either, and the first capture still drops one first', async () => {
  const dense = fakeBakery();
  await bakeStream(dense, { ...seg(0), onFrame: async () => {} });
  const again = await bakeStream(dense, { ...seg(1), onFrame: async () => {} });
  assert.deepEqual(Object.values(perFrame(dense.log)).filter(x => x.includes('J')), []);
  assert.equal(again.pushDrawn, 0);
  const off = fakeBakery();
  const stats = await bakeStream(off, { ...seg(2), mountFrame: 20, pushDraw: false, onFrame: async () => {} });
  const per = perFrame(off.log);
  assert.deepEqual(Object.values(per).filter(x => x.includes('J')), []);
  assert.equal(per[30], 'PP');
  assert.equal(stats.pushDrawn, 0);
});

test('createStepper: records whether the ticks of this frame reported a visual change (step.last), without changing the return value', async () => {
  const bakery = fakeBakery({ staticFrames: [7], damageFrames: [7, 8] });
  const step = createStepper(bakery, { fps: FPS });
  assert.deepEqual(step.last, { frame: null, damaged: false, isStatic: false });
  assert.equal(await step(7, false), true);
  assert.deepEqual(step.last, { frame: 7, damaged: true, isStatic: true });
  assert.equal(await step(9, false), false);
  assert.deepEqual(step.last, { frame: 9, damaged: false, isStatic: false });
});

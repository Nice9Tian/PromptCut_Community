/**
 * Stream lease (R8 / G4) of `bakeStream` and crop rectangle of `captureFrame`, run with a fake
 * bakery (does not start Chrome).
 *
 * Pin down the "continuous production" items in acceptance check:
 *   - Continuous production of 10 segments pays only one page switch, calls `__pcSetFrameWindow`
 *     only once, and `clipIds` for that call is always null;
 *   - Segment skip / stream switch / lease dirtied (`dirty`) all treated as broken lease, remount;
 *   - Sparse segments (captures only first frame per segment, stride is frame count of one segment)
 *     captures only 1 frame out of 15;
 *   - Capture rectangle sends `Emulation.setDeviceMetricsOverride` (with `viewport`) only once when
 *     changed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { bakeStream, dirtyStreamLease, createStepper } from '../bakery/bake.mjs';
import { captureFrame, applyCaptureClip, forgetCaptureClip } from '../bakery/capture-frame.mjs';

const png = (() => { const p = new PNG({ width: 4, height: 2 }); p.data.fill(200); return PNG.sync.write(p); })();

function fakeBakery() {
  const log = { setFrameWindow: [], metrics: [], shots: 0, setT: [], beginFrames: 0 };
  const bakery = {
    log,
    page: {
      async evaluate(fn, arg) {
        const src = String(fn);
        if (src.includes('__pcTimeline')) return { fps: 30, width: 1920, height: 1080, duration: 10 };
        if (src.includes('__pcSetFrameWindow')) { log.setFrameWindow.push({ src, arg }); return undefined; }
        if (src.includes('__pcSetT')) { log.setT.push(arg.sec); return { raf: 0, mut: 0 }; }
        return null;
      },
      async setViewport() {},
      viewport: () => ({ width: 1920, height: 1080, deviceScaleFactor: 1 }),
    },
    client: { async send(method, params) { if (method === 'Emulation.setDeviceMetricsOverride') log.metrics.push(params); } },
    async beginFrame(extra = {}) {
      log.beginFrames++;
      if (extra.screenshot?.format === 'png') { log.shots++; return { screenshotData: png.toString('base64') }; }
      return {};
    },
    async waitNet() {},
  };
  return bakery;
}

const seg = (n, extra = {}) => ({ streamSignature: 'S', fromFrame: n * 15, toFrame: n * 15 + 14, stride: 1, fps: 30, mountFrame: 0,
  clip: { x: 10, y: 20, w: 64, h: 32 }, ...extra });

test('ten contiguous segments pay one remount and call __pcSetFrameWindow once, with clipIds null', async () => {
  const bakery = fakeBakery();
  const frames = [];
  let resets = 0;
  for (let n = 0; n < 10; n++) {
    const stats = await bakeStream(bakery, { ...seg(n), onFrame: async (f) => { frames.push(f); } });
    if (stats.reset) resets++;
  }
  assert.equal(resets, 1);
  assert.equal(bakery.log.setFrameWindow.length, 1);
  assert.match(bakery.log.setFrameWindow[0].src, /__pcSetFrameWindow\(null,/, 'The active criterion passed to FrameScene on mount: clipIds is always null');
  assert.deepEqual(frames, Array.from({ length: 150 }, (_, i) => i));
  // Capture rectangle is set only the first time
  assert.equal(bakery.log.metrics.length, 1);
  assert.deepEqual(bakery.log.metrics[0].viewport, { x: 10, y: 20, width: 64, height: 32, scale: 1 });
});

test('a skipped segment, another stream or a dirty lease breaks the lease; a remount replays from the mount frame', async () => {
  const bakery = fakeBakery();
  await bakeStream(bakery, { ...seg(0), onFrame: async () => {} });
  assert.equal((await bakeStream(bakery, { ...seg(2), onFrame: async () => {} })).reset, true, 'Segment jump');
  assert.equal((await bakeStream(bakery, { ...seg(3), streamSignature: 'OTHER', onFrame: async () => {} })).reset, true, 'Stream switch');
  dirtyStreamLease(bakery);
  const dirty = await bakeStream(bakery, { ...seg(4), streamSignature: 'OTHER', mountFrame: 50, onFrame: async () => {} });
  assert.equal(dirty.reset, true, 'The lease was dirtied by another call');
  assert.equal(dirty.replayed, 60 - 50, 'Replay from the mount frame (no screenshots) up to just before this segment');
  assert.equal(bakery.log.setFrameWindow.length, 4);
  // Page replaced (`bakery.reset` opened a new page): stepper in lease bound to old page, also counts
  // as broken
  bakery.page = { ...bakery.page };
  assert.equal((await bakeStream(bakery, { ...seg(5), streamSignature: 'OTHER', onFrame: async () => {} })).reset, true, 'Page changed');
});

test('a sparse segment (stride = one segment) captures one screenshot for a 15-frame segment; the lease still steps every frame', async () => {
  const bakery = fakeBakery();
  const frames = [];
  const stats = await bakeStream(bakery, { ...seg(0), stride: 15, onFrame: async (f) => { frames.push(f); } });
  assert.deepEqual(frames, [0]);
  assert.equal(stats.captured, 1);
  assert.deepEqual(bakery.log.setT.filter((_, i) => i >= 4), Array.from({ length: 15 }, (_, i) => i / 30), 'After warm-up, push frame by frame 0..14');
  const next = await bakeStream(bakery, { ...seg(1), stride: 15, onFrame: async () => {} });
  assert.equal(next.reset, false);
});

test('bakeStream rejects a bad range and honours abort between frames', async () => {
  const bakery = fakeBakery();
  await assert.rejects(bakeStream(bakery, { ...seg(0), fromFrame: 5, toFrame: 4 }), /frame range/);
  const controller = new AbortController();
  let n = 0;
  await assert.rejects(bakeStream(bakery, { ...seg(0), signal: controller.signal, onFrame: async () => { if (++n === 3) controller.abort(); } }), e => e.cancelled);
  assert.equal(n, 3);
});

test('createStepper keeps the bakeFrames step contract (sets time, settles, pins animations)', async () => {
  const bakery = fakeBakery();
  const step = createStepper(bakery, { fps: 25, directFrameAt: f => f + 1 });
  const isStatic = await step(10, false);
  assert.equal(isStatic, false, 'Will not declare static when the probe returns null');
  assert.deepEqual(bakery.log.setT, [10 / 25]);
});

test('captureFrame with clip applies the viewport once; clip null restores the full viewport', async () => {
  const bakery = fakeBakery();
  const shot = { format: 'png' };
  await captureFrame(bakery, shot, undefined, { prime: false, clip: { x: 0, y: 0, w: 100, h: 50 } });
  await captureFrame(bakery, shot, undefined, { prime: false, clip: { x: 0, y: 0, w: 100, h: 50 } });
  assert.equal(bakery.log.metrics.length, 1);
  await captureFrame(bakery, shot, undefined, { prime: false, clip: null });
  assert.equal(bakery.log.metrics.length, 2);
  assert.equal(bakery.log.metrics[1].viewport, undefined);
  forgetCaptureClip(bakery);
  await applyCaptureClip(bakery, null);
  assert.equal(bakery.log.metrics.length, 3, 'After forgetting, the same rectangle must be sent again');
  await assert.rejects(applyCaptureClip(bakery, { x: 0, y: 0, w: 3, h: 2 }), /even/);
  // Legacy callers that do not pass clip do not send any extra CDP calls
  const before = bakery.log.metrics.length;
  await captureFrame(bakery, shot, undefined, { prime: false });
  assert.equal(bakery.log.metrics.length, before);
});

/**
 * `bakeStream` 的流租约(R8 / G4)和 `captureFrame` 的裁剪矩形,用一个假的 bakery 跑(不起 Chrome)。
 *
 * 钉住验收里「连续生产」那几条:
 *   - 连续生产 10 个分段只付一次换页、只调一次 `__pcSetFrameWindow`,而且那一次的 `clipIds` 恒为 null;
 *   - 跳段 / 换流 / 租约被弄脏(`dirty`)都当断租约处理,重新挂载;
 *   - 稀疏分段(每个分段只截第一帧,stride 是一个分段的帧数)15 帧只截 1 张;
 *   - 截图矩形只在变了的时候发一次 `Emulation.setDeviceMetricsOverride`(带 `viewport`)。
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
  assert.match(bakery.log.setFrameWindow[0].src, /__pcSetFrameWindow\(null,/, '挂载交给 FrameScene 的活跃判据:clipIds 恒为 null');
  assert.deepEqual(frames, Array.from({ length: 150 }, (_, i) => i));
  // 截图矩形只在第一次设
  assert.equal(bakery.log.metrics.length, 1);
  assert.deepEqual(bakery.log.metrics[0].viewport, { x: 10, y: 20, width: 64, height: 32, scale: 1 });
});

test('a skipped segment, another stream or a dirty lease breaks the lease; a remount replays from the mount frame', async () => {
  const bakery = fakeBakery();
  await bakeStream(bakery, { ...seg(0), onFrame: async () => {} });
  assert.equal((await bakeStream(bakery, { ...seg(2), onFrame: async () => {} })).reset, true, '跳段');
  assert.equal((await bakeStream(bakery, { ...seg(3), streamSignature: 'OTHER', onFrame: async () => {} })).reset, true, '换流');
  dirtyStreamLease(bakery);
  const dirty = await bakeStream(bakery, { ...seg(4), streamSignature: 'OTHER', mountFrame: 50, onFrame: async () => {} });
  assert.equal(dirty.reset, true, '租约被别的调用弄脏');
  assert.equal(dirty.replayed, 60 - 50, '从挂载帧起回放(不截图)到这一段之前');
  assert.equal(bakery.log.setFrameWindow.length, 4);
  // 页面被换掉(`bakery.reset` 开了一个新 page):租约里的 stepper 绑的是旧页面,也算断
  bakery.page = { ...bakery.page };
  assert.equal((await bakeStream(bakery, { ...seg(5), streamSignature: 'OTHER', onFrame: async () => {} })).reset, true, '换了页面');
});

test('a sparse segment (stride = one segment) captures one screenshot for a 15-frame segment; the lease still steps every frame', async () => {
  const bakery = fakeBakery();
  const frames = [];
  const stats = await bakeStream(bakery, { ...seg(0), stride: 15, onFrame: async (f) => { frames.push(f); } });
  assert.deepEqual(frames, [0]);
  assert.equal(stats.captured, 1);
  assert.deepEqual(bakery.log.setT.filter((_, i) => i >= 4), Array.from({ length: 15 }, (_, i) => i / 30), '预热之后逐帧推 0..14');
  const next = await bakeStream(bakery, { ...seg(1), stride: 15, onFrame: async () => {} });
  assert.equal(next.reset, false);
});

test('bakeStream rejects a bad range and honours abort between frames', async () => {
  const bakery = fakeBakery();
  await assert.rejects(bakeStream(bakery, { ...seg(0), fromFrame: 5, toFrame: 4 }), /帧区间/);
  const controller = new AbortController();
  let n = 0;
  await assert.rejects(bakeStream(bakery, { ...seg(0), signal: controller.signal, onFrame: async () => { if (++n === 3) controller.abort(); } }), e => e.cancelled);
  assert.equal(n, 3);
});

test('createStepper keeps the bakeFrames step contract (sets time, settles, pins animations)', async () => {
  const bakery = fakeBakery();
  const step = createStepper(bakery, { fps: 25, directFrameAt: f => f + 1 });
  const isStatic = await step(10, false);
  assert.equal(isStatic, false, '探针回 null 时不敢判静止');
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
  assert.equal(bakery.log.metrics.length, 3, '忘掉之后同一个矩形也要重发');
  await assert.rejects(applyCaptureClip(bakery, { x: 0, y: 0, w: 3, h: 2 }), /even/);
  // 不传 clip 的老调用方一次 CDP 都不多发
  const before = bakery.log.metrics.length;
  await captureFrame(bakery, shot, undefined, { prime: false });
  assert.equal(bakery.log.metrics.length, before);
});

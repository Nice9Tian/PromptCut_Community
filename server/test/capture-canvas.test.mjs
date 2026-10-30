/**
 * 画布直取(渲染重构「己一」,`docs/plan/prerender-products-contract.md` 第 6.1、6.2 节)Node 一侧的单测:
 * `server/bakery/capture-canvas.mjs`。跑:`npm test -- server/test/capture-canvas.test.mjs`
 *
 *   - PNG 解成 RGBA:五种滤波、RGB / RGBA 两种颜色类型,和 pngjs 解出来的逐字节相同;认不了的回 null;
 *   - 页面压掉全透明游程(`src/render/gl/canvasGrab.ts` 的 `packTransparentRuns`)再还原,逐字节相同;越界的数据抛;
 *   - 两张图的差:预乘色、不透明度的平均差,明显不同的像素数;全透明处 RGB 不算数;
 *   - 实体框:和截图那条路的 `pngAlphaBox` 量出同一个框;
 *   - 一个分段怎么定走哪条路(`directSegmentCapture`):**先取画布、后截图**;过了实测走直取;画布外面还有东西(比出差别)
 *     这条流从此走截图并记诊断;不比截图快的分段照旧截图并歇几个分段;中途取不到的那一帧改截图、不交空图;
 *     `always` 档不看快慢。
 * 不用 Chrome:预渲染间是假的,页面钩子的回答由测试给。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import {
  decodePngRgba, unpackCanvasPixels, compareRgba, rgbaAlphaBox, grabCanvas, directSegmentCapture, newDirectRecord,
  directCaptureMode, directBadLimit, DIRECT_BAD_DIFF, DIRECT_COOLDOWN_SEGMENTS, DIRECT_MAX_FILL,
} from '../bakery/capture-canvas.mjs';
import { packTransparentRuns } from '../../src/render/gl/canvasGrab.ts';
import { pngAlphaBox } from '../frame-stream.mjs';

/** 合成一张 straight RGBA:几块不透明 / 半透明的色块,其余全透明(全透明处 RGB 为 0,和 getImageData 给的一样) */
function synth(width, height, seed = 1, fill = 0.2) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return (s >>> 16) & 255; };
  const data = Buffer.alloc(width * height * 4);
  const blocks = Math.max(1, Math.round(fill * 10));
  for (let b = 0; b < blocks; b++) {
    const x0 = rnd() % Math.max(1, width - 8), y0 = rnd() % Math.max(1, height - 6);
    const w = 3 + (rnd() % 12), h = 2 + (rnd() % 8);
    for (let y = y0; y < Math.min(height, y0 + h); y++) for (let x = x0; x < Math.min(width, x0 + w); x++) {
      const i = (y * width + x) * 4;
      const a = b % 2 ? 255 : 1 + (rnd() % 254);
      data[i] = rnd(); data[i + 1] = rnd(); data[i + 2] = rnd(); data[i + 3] = a;
    }
  }
  return data;
}
const pngOf = (data, width, height, options = {}) => {
  const png = new PNG({ width, height });
  data.copy(png.data);
  return PNG.sync.write(png, options);
};
const pack = (rgba) => {
  // 页面那一侧拿到的是对齐到 4 字节的 Uint8ClampedArray;Buffer 可能落在池子里的任意偏移上,先拷一份
  const packed = packTransparentRuns(new Uint8ClampedArray(rgba));
  return packed ? Buffer.from(packed) : null;
};

test('decodePngRgba:五种滤波、RGBA 和 RGB 都和 pngjs 解出来的逐字节相同;认不了的回 null', () => {
  const width = 37, height = 23;
  const data = synth(width, height, 7, 0.9);
  for (const filterType of [0, 1, 2, 3, 4, -1]) {
    const decoded = decodePngRgba(pngOf(data, width, height, { filterType }));
    assert.ok(decoded, `滤波 ${filterType} 解得开`);
    assert.equal(decoded.width, width);
    assert.equal(decoded.height, height);
    assert.equal(Buffer.compare(decoded.data, data), 0, `滤波 ${filterType} 逐字节相同`);
  }
  // RGB(颜色类型 2):不透明度补 255
  const opaque = Buffer.from(data);
  for (let i = 3; i < opaque.length; i += 4) opaque[i] = 255;
  const rgb = decodePngRgba(pngOf(opaque, width, height, { colorType: 2, inputHasAlpha: true }));
  assert.equal(Buffer.compare(rgb.data, opaque), 0, 'RGB 的 PNG 解成不透明的 RGBA');
  // 认不了的:不是 PNG、截断、16 位
  assert.equal(decodePngRgba(Buffer.from('not a png at all, definitely not a png')), null);
  assert.equal(decodePngRgba(pngOf(data, width, height).subarray(0, 60)), null);
  assert.equal(decodePngRgba('string'), null);
});

test('packTransparentRuns ↔ unpackCanvasPixels:还原出来逐字节相同;压完不比原样小回 null;越界的数据抛', () => {
  const width = 64, height = 48;
  for (const seed of [1, 2, 3]) {
    const rgba = synth(width, height, seed, 0.3);
    const packed = pack(rgba);
    assert.ok(packed, '稀疏的画面压得动');
    assert.ok(packed.length < rgba.length / 2, `压完明显变小(${packed.length} / ${rgba.length})`);
    assert.equal(Buffer.compare(unpackCanvasPixels(packed, width, height), rgba), 0);
  }
  // 整张全透明:一个游程头,还原出全 0
  const empty = Buffer.alloc(width * height * 4);
  const packedEmpty = pack(empty);
  assert.equal(packedEmpty.length, 8);
  assert.equal(Buffer.compare(unpackCanvasPixels(packedEmpty, width, height), empty), 0);
  // 整张不透明:压不动,原样交
  const full = Buffer.alloc(width * height * 4, 200);
  assert.equal(pack(full), null);
  // 逐像素交替:头比像素还多,同样原样交
  const alt = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 2) alt.fill(255, i * 4, i * 4 + 4);
  assert.equal(pack(alt), null);
  // 越界 / 不完整
  const bad = Buffer.alloc(16);
  bad.writeUInt32LE(width * height - 1, 0); bad.writeUInt32LE(2, 4);
  assert.throws(() => unpackCanvasPixels(bad, width, height), /越界/);
  assert.throws(() => unpackCanvasPixels(Buffer.alloc(5), width, height), /不完整/);
});

test('compareRgba:按预乘色和不透明度比;全透明处 RGB 不算数;明显不同的像素另数', () => {
  const width = 10, height = 10;
  const a = Buffer.alloc(width * height * 4), b = Buffer.alloc(width * height * 4);
  assert.deepEqual(compareRgba(a, b, width, height), { color: 0, alpha: 0, bad: 0, pixels: 100 });
  // 全透明处 RGB 不同:不算差别
  b[0] = 255; b[1] = 255; b[2] = 255;
  assert.equal(compareRgba(a, b, width, height).color, 0);
  // 一个像素从全透明变成不透明的白:不透明度差 255 / 100,预乘色差 255 × 3 / 300
  b[3] = 255;
  const one = compareRgba(a, b, width, height);
  assert.equal(one.alpha, 2.55);
  assert.equal(one.color, 2.55);
  assert.equal(one.bad, 1);
  // 半透明处颜色差按预乘算:同样差 100 的 straight 色,不透明度 51(五分之一)时预乘差是 20
  const c = Buffer.alloc(width * height * 4), d = Buffer.alloc(width * height * 4);
  c[4] = 100; c[7] = 51; d[4] = 200; d[7] = 51;
  const half = compareRgba(c, d, width, height);
  assert.equal(half.alpha, 0);
  assert.ok(Math.abs(half.color - 20 / 300) < 1e-9);
  assert.equal(half.bad, 0, `差 20 没到 ${DIRECT_BAD_DIFF},不算明显不同`);
  assert.throws(() => compareRgba(a.subarray(0, 8), b, width, height));
  assert.equal(directBadLimit(1920, 1080), 103);
  assert.equal(directBadLimit(64, 64), 4, '小矩形有个底数');
});

test('rgbaAlphaBox:和截图那条路的 pngAlphaBox 量出同一个框', () => {
  const width = 80, height = 60;
  for (const seed of [11, 12, 13]) {
    const rgba = synth(width, height, seed, 0.2);
    assert.deepEqual(rgbaAlphaBox(rgba, width, height), pngAlphaBox(pngOf(rgba, width, height)));
  }
  assert.equal(rgbaAlphaBox(Buffer.alloc(width * height * 4), width, height), null);
});

test('directCaptureMode:缺省 always;0 / off 关;auto 看快慢', () => {
  assert.equal(directCaptureMode({}), 'always');
  assert.equal(directCaptureMode({ PROMPTCUT_STREAM_DIRECT: '1' }), 'always');
  assert.equal(directCaptureMode({ PROMPTCUT_STREAM_DIRECT: '0' }), 'off');
  assert.equal(directCaptureMode({ PROMPTCUT_STREAM_DIRECT: 'off' }), 'off');
  assert.equal(directCaptureMode({ PROMPTCUT_STREAM_DIRECT: 'auto' }), 'auto');
  assert.equal(directCaptureMode({ PROMPTCUT_STREAM_DIRECT: 'always' }), 'always');
});

/* ------------------------------------------------------------ 假的预渲染间 */

const RECT = { x: 40, y: 20, w: 64, h: 48 };

/**
 * 页面钩子的回答由 `answer(frame, opts)` 给:回 `{ rgba }`(这一帧画布里的像素)或 `{ reason }`(取不到)。
 * `log` 记下每一步的先后(`grab` / `shot`),核对「先取画布、后截图」。
 */
function fakeBakery(answer, log) {
  let frame = 0;
  return {
    setFrame: (n) => { frame = n; },
    page: {
      evaluate: async (_fn, clipId, rect, opts) => {
        log.push(`grab:${frame}`);
        assert.equal(clipId, 'clip-c');
        assert.deepEqual(rect, RECT);
        const a = answer(frame, opts);
        if (a.reason) return { ok: false, reason: a.reason, bytes: a.bytes, readMs: 1, packMs: 0 };
        const packed = pack(a.rgba);
        const bytes = packed ?? a.rgba;
        if (opts.maxBytes !== undefined && bytes.length > opts.maxBytes) return { ok: false, reason: 'dense', bytes: bytes.length, readMs: 1, packMs: 0 };
        return { ok: true, w: rect.w, h: rect.h, packed: !!packed, b64: bytes.toString('base64'), bytes: bytes.length, readMs: a.readMs ?? 1, packMs: 0 };
      },
    },
  };
}
/** 跑一个分段:`shots(frame)` 是这一帧截图会截到的像素;`delay` 让截图慢一点(量快慢用) */
async function runSegment(capture, bakery, log, { frames, shots, primed = () => false, shotDelayMs = 0 }) {
  const out = [];
  for (const frame of frames) {
    bakery.setFrame(frame);
    const shoot = async () => {
      log.push(`shot:${frame}`);
      if (shotDelayMs) await new Promise((r) => setTimeout(r, shotDelayMs));
      return pngOf(shots(frame), RECT.w, RECT.h);
    };
    out.push(await capture(frame, shoot, { primed: primed(frame) }));
  }
  return out;
}
const frameOf = (n) => synth(RECT.w, RECT.h, 100 + n, 0.2);

test('grabCanvas:压过的像素还原成整张 RGBA;尺寸对不上、数据坏了都不算取到', async () => {
  const log = [];
  const rgba = frameOf(1);
  const ok = await grabCanvas(fakeBakery(() => ({ rgba }), log), 'clip-c', RECT);
  assert.equal(ok.ok, true);
  assert.equal(Buffer.compare(ok.rgba, rgba), 0);
  assert.equal(ok.width, RECT.w);
  assert.ok(ok.readMs >= 0 && ok.moveMs >= 0);
  const miss = await grabCanvas(fakeBakery(() => ({ reason: 'gl-frame' }), log), 'clip-c', RECT);
  assert.deepEqual([miss.ok, miss.reason], [false, 'gl-frame']);
  const noHook = await grabCanvas({ page: { evaluate: async () => ({ ok: false, reason: 'no-hook' }) } }, 'clip-c', RECT);
  assert.equal(noHook.reason, 'no-hook');
  const wrong = await grabCanvas({ page: { evaluate: async () => ({ ok: true, w: 2, h: 2, packed: false, b64: '', bytes: 0 }) } }, 'clip-c', RECT);
  assert.equal(wrong.reason, 'bad-size');
  const garbage = await grabCanvas({ page: { evaluate: async () => ({ ok: true, w: RECT.w, h: RECT.h, packed: true, b64: Buffer.alloc(5).toString('base64'), bytes: 5 }) } }, 'clip-c', RECT);
  assert.equal(garbage.reason, 'bad-data');
});

test('一个分段:第一帧先取画布、后截图,比过了余下的帧只取画布、不截图', async () => {
  const log = [], record = newDirectRecord();
  const bakery = fakeBakery((frame) => ({ rgba: frameOf(frame) }), log);
  const capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record, always: true });
  const out = await runSegment(capture, bakery, log, { frames: [30, 31, 32, 33], shots: frameOf });
  assert.deepEqual(log, ['grab:30', 'shot:30', 'grab:31', 'grab:32', 'grab:33'], '只有第一帧截图,而且在取画布之后');
  for (const [i, frame] of [30, 31, 32, 33].entries()) {
    assert.equal(out[i].width, RECT.w);
    assert.equal(Buffer.compare(out[i].rgba, frameOf(frame)), 0, `第 ${frame} 帧交出去的是画布的像素`);
  }
  assert.equal(record.failed, null);
  assert.deepEqual([record.segments, record.frames, record.checks, record.misses], [1, 4, 1, 0]);
  assert.deepEqual([record.last.frame, record.last.pass, record.last.color, record.last.bad], [30, true, 0, 0]);
});

test('画布外面还有别的元素(截图比画布多出一块):这条流从此走截图,记一条诊断,交出去的是 PNG', async () => {
  const log = [], record = newDirectRecord(), notes = [];
  const withExtra = (frame) => {
    const rgba = Buffer.from(frameOf(frame));
    // 画布之外的一个元素:一块 20×10 的不透明色块
    for (let y = 30; y < 40; y++) for (let x = 5; x < 25; x++) rgba.fill(255, (y * RECT.w + x) * 4, (y * RECT.w + x) * 4 + 4);
    return rgba;
  };
  const bakery = fakeBakery((frame) => ({ rgba: frameOf(frame) }), log);
  const capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record, note: (m) => notes.push(m) });
  const out = await runSegment(capture, bakery, log, { frames: [0, 1, 2], shots: withExtra });
  assert.deepEqual(log, ['grab:0', 'shot:0', 'shot:1', 'shot:2'], '第一帧比出差别以后,余下的帧不再问画布');
  for (const [i, frame] of [0, 1, 2].entries()) {
    assert.ok(Buffer.isBuffer(out[i]), '交出去的是截图');
    assert.equal(Buffer.compare(decodePngRgba(out[i]).data, withExtra(frame)), 0);
  }
  assert.equal(record.failed, 'differs');
  assert.equal(record.last.pass, false);
  assert.ok(record.last.bad > record.last.badLimit, '明显不同的像素超了');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /画布直取没过.*照旧走截图/);
  assert.deepEqual([record.segments, record.frames], [0, 0]);
});

test('平均差在 1 以内、但有一小块明显不同(稀疏画面里的一个小元素):照样不过', async () => {
  const log = [], record = newDirectRecord();
  const withDot = (frame) => {
    const rgba = Buffer.from(frameOf(frame));
    // 3×3 的不透明小块:不透明度平均差 255 × 9 / 3072 = 0.75,不到 1
    for (let y = 0; y < 3; y++) for (let x = 60; x < 63; x++) rgba.fill(255, (y * RECT.w + x) * 4, (y * RECT.w + x) * 4 + 4);
    return rgba;
  };
  const bakery = fakeBakery((frame) => ({ rgba: frameOf(frame) }), log);
  const capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record });
  // 让那 9 个像素原来是全透明的(换一张没有画到右上角的底图不容易保证,直接核对结论)
  await runSegment(capture, bakery, log, { frames: [0], shots: withDot });
  assert.ok(record.last.alpha <= 1 && record.last.color <= 1, `平均差没超(颜色 ${record.last.color}、不透明度 ${record.last.alpha})`);
  assert.ok(record.last.bad > record.last.badLimit, '但明显不同的像素超了');
  assert.equal(record.failed, 'differs');
});

test('画布认不出来(不止一张):这条流不直取;这一帧碰巧取不到(平面帧号对不上)只让这个分段走截图', async () => {
  // 不止一张画布:判死
  let log = [], record = newDirectRecord();
  let bakery = fakeBakery(() => ({ reason: 'canvas-count:2' }), log);
  let capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record });
  let out = await runSegment(capture, bakery, log, { frames: [0, 1], shots: frameOf });
  assert.equal(record.failed, 'canvas-count:2');
  assert.ok(out.every(Buffer.isBuffer));
  // 帧号对不上:不判死
  log = []; record = newDirectRecord();
  bakery = fakeBakery(() => ({ reason: 'gl-frame' }), log);
  capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record });
  out = await runSegment(capture, bakery, log, { frames: [0, 1], shots: frameOf });
  assert.equal(record.failed, null, '下个分段还会再试');
  assert.equal(record.misses, 1);
  assert.deepEqual(log, ['grab:0', 'shot:0', 'shot:1']);
  assert.ok(out.every(Buffer.isBuffer), '这个分段交出去的都是截图,没有空图');
});

test('分段中途某一帧取不到:这一帧改截图、解成 RGBA 再交,不交空图也不换格式;截图也解不开就抛', async () => {
  const log = [], record = newDirectRecord();
  const bakery = fakeBakery((frame) => (frame === 2 ? { reason: 'gl-frame' } : { rgba: frameOf(frame) }), log);
  const capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record, always: true });
  const out = await runSegment(capture, bakery, log, { frames: [0, 1, 2, 3], shots: frameOf });
  assert.deepEqual(log, ['grab:0', 'shot:0', 'grab:1', 'grab:2', 'shot:2', 'grab:3']);
  assert.ok(out.every((x) => x.rgba && x.width === RECT.w), '四帧都是原始像素');
  assert.equal(Buffer.compare(out[2].rgba, frameOf(2)), 0, '取不到的那一帧是截图解出来的,不是空图');
  assert.deepEqual([record.misses, record.frames, record.segments], [1, 3, 1]);
  // 截图也解不开
  const bakery2 = fakeBakery((frame) => (frame === 1 ? { reason: 'gl-frame' } : { rgba: frameOf(frame) }), []);
  const capture2 = directSegmentCapture(bakery2, { clipId: 'clip-c', rect: RECT, record: newDirectRecord(), always: true });
  bakery2.setFrame(0);
  await capture2(0, async () => pngOf(frameOf(0), RECT.w, RECT.h), { primed: false });
  bakery2.setFrame(1);
  await assert.rejects(capture2(1, async () => Buffer.from('broken'), { primed: false }), /截图也解不开/);
});

test('auto 档:直取不比截图快的分段照旧截图,并歇几个分段;画面太满的连搬都不搬', async () => {
  // 直取慢(页面读像素报 500 毫秒)、截图快:这个分段走截图
  let log = [], record = newDirectRecord();
  let bakery = fakeBakery((frame) => ({ rgba: frameOf(frame), readMs: 500 }), log);
  let capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record, always: false });
  let out = await runSegment(capture, bakery, log, { frames: [0, 1], shots: frameOf });
  assert.deepEqual(log, ['grab:0', 'shot:0', 'shot:1']);
  assert.ok(out.every(Buffer.isBuffer));
  assert.equal(record.failed, null, '过了实测,只是不划算,不算不过');
  assert.deepEqual([record.slowSegments, record.cooldown, record.segments], [1, DIRECT_COOLDOWN_SEGMENTS, 0]);
  assert.equal(record.last.pass, true);
  assert.ok(record.last.grabMs >= 500 && record.last.shotMs < 500);
  // 直取快、截图慢:走直取
  log = []; record = newDirectRecord();
  bakery = fakeBakery((frame) => ({ rgba: frameOf(frame), readMs: 0 }), log);
  capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record, always: false });
  out = await runSegment(capture, bakery, log, { frames: [0, 1], shots: frameOf, shotDelayMs: 120 });
  assert.deepEqual(log, ['grab:0', 'shot:0', 'grab:1']);
  assert.deepEqual([record.slowSegments, record.cooldown, record.segments, record.frames], [0, 0, 1, 2]);
  // 直取每帧比截图快,但这个分段只剩一帧可省,抵不过实测自己多花的那一张截图:照旧截图
  log = []; record = newDirectRecord();
  bakery = fakeBakery((frame) => ({ rgba: frameOf(frame), readMs: 0 }), log);
  capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record, captures: 2, always: false });
  out = await runSegment(capture, bakery, log, { frames: [0, 1], shots: frameOf, shotDelayMs: 40 });
  assert.deepEqual(log, ['grab:0', 'shot:0', 'shot:1']);
  assert.ok(record.last.grabMs < record.last.shotMs, '单看每帧是直取快');
  assert.deepEqual([record.slowSegments, record.segments], [1, 0], '但省下的抵不过实测多花的');
  // 截图那一次先丢了一张(primed):每帧的截图耗时按一半算;稀疏的分段每帧都要先丢一张,按两倍算
  log = []; record = newDirectRecord();
  bakery = fakeBakery((frame) => ({ rgba: frameOf(frame), readMs: 0 }), log);
  capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record, always: false });
  await runSegment(capture, bakery, log, { frames: [0], shots: frameOf, shotDelayMs: 100, primed: () => true });
  const halved = record.last.shotMs;
  record = newDirectRecord();
  capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record, stride: 15, always: false });
  await runSegment(capture, bakery, log, { frames: [0], shots: frameOf, shotDelayMs: 100, primed: () => true });
  assert.ok(record.last.shotMs > halved * 1.5, `稀疏的分段按两倍算(${record.last.shotMs} 对 ${halved})`);
  // 画面太满:压完超过原始大小的 DIRECT_MAX_FILL,不搬、不比,这个分段走截图
  log = []; record = newDirectRecord();
  const full = Buffer.alloc(RECT.w * RECT.h * 4, 200);
  bakery = fakeBakery(() => ({ rgba: full }), log);
  capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record, always: false });
  out = await runSegment(capture, bakery, log, { frames: [0, 1], shots: () => full });
  assert.deepEqual(log, ['grab:0', 'shot:0', 'shot:1']);
  assert.deepEqual([record.checks, record.slowSegments, record.cooldown, record.last.reason], [0, 1, DIRECT_COOLDOWN_SEGMENTS, 'dense']);
  assert.ok(full.length > RECT.w * RECT.h * 4 * DIRECT_MAX_FILL);
  // always 档:太满也搬,不看快慢
  log = []; record = newDirectRecord();
  bakery = fakeBakery(() => ({ rgba: full }), log);
  capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record, always: true });
  out = await runSegment(capture, bakery, log, { frames: [0, 1], shots: () => full });
  assert.deepEqual(log, ['grab:0', 'shot:0', 'grab:1']);
  assert.ok(out.every((x) => x.rgba));
});

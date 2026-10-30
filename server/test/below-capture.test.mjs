/**
 * 依赖下层的流的差分取层(渲染重构「戊二」的「下层二」,`docs/plan/prerender-products-contract.md` 第 5.3 节)的单测。
 * 跑:`npm test -- server/test/below-capture.test.mjs`
 *
 *   - 算那一层的算式(`diffLayer`):两张相同、下层全透明、下层完全不透明、下层半透明、量化噪声、毛玻璃的掩码、裁切;
 *   - 取两张时下层状态一致的保证(`belowSegmentCapture`,配真的 `bakeStream`、假的预渲染间):上张、藏、下张、撤的先后,
 *     中间不推时间;藏了一定撤;每个分段第一帧的两条实测,和它们没过时怎么办;目标卡不在页面上的帧;改到矩形外面的帧;
 *   - 接到生产者上(`StreamProducer.runSegment`,真的 ffmpeg):`kind: 'below'` 的流截图矩形恒为整个画面、等素材就位、
 *     稀疏那一趟量出实体框、第二趟收紧;解出来盖回下层等于带目标卡的画面;收紧矩形不够大时放大重来;单卡流走的路不变;
 *   - 键:`BELOW_STREAM_VERSION` 是 1;`capture-below.mjs` 进截图代码的指纹、不进生成快照的代码指纹。
 * 需要 ffmpeg 的几条在没有 ffmpeg 的机器上跳过。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { bakeStream } from '../bakery/bake.mjs';
import { dropStreamEncoderSpares } from '../bakery/ffmpeg.mjs';
import { diffLayer, glassMask, changedOutside, layerOutside, belowSegmentCapture, newBelowRecord, pageHideTarget, pageShowTarget, DIFF_TOLERANCE } from '../bakery/capture-below.mjs';
import { StreamProducer, planStreams, SEGMENT_FRAMES, SPARSE_STRIDE } from '../frame-stream.mjs';
import { BELOW_STREAM_VERSION } from '../card-identity.mjs';
import { captureCode, snapshotCode, invalidateFrameCode } from '../frame-code.mjs';
import { createReadyHub } from '../ready-index.mjs';

const ffmpegOk = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
after(() => dropStreamEncoderSpares());

/* ------------------------------------------------------------ 参照实现(和产品代码各写各的) */

/** 确定的伪随机数 */
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const px = (r, g, b, a) => [r, g, b, a];
const image = (pixels) => Buffer.from(pixels.flat());
/** 一层(预乘色,0～1)按普通的叠加盖在 straight RGBA 的一个像素上,回预乘色的结果(满分 255) */
function over(layer, lower) {
  const la = lower[3] / 255, keep = 1 - layer.a;
  return [0, 1, 2].map(k => (layer.c[k] + lower[k] / 255 * la * keep) * 255).concat([(layer.a + la * keep) * 255]);
}
const premul = (p) => [p[0] * p[3] / 255, p[1] * p[3] / 255, p[2] * p[3] / 255, p[3]];
/** 预乘色(满分 255)四舍五入成 straight RGBA 的 8 位像素(截图给的就是这种) */
function toStraight(q) {
  const a = Math.round(q[3]);
  if (a <= 0) return [0, 0, 0, 0];
  return [0, 1, 2].map(k => Math.max(0, Math.min(255, Math.round(q[k] / a * 255)))).concat([Math.min(255, a)]);
}
/** 把算出来的 S(straight RGBA,8 位)盖回 `lower`,和 `upper` 比:回最大的通道差(预乘色,满分 255) */
function backError(layerPx, lowerPx, upperPx) {
  const a = layerPx[3] / 255;
  const got = over({ a, c: [0, 1, 2].map(k => layerPx[k] / 255 * a) }, lowerPx);
  const want = premul(upperPx);
  return Math.max(...got.map((v, k) => Math.abs(v - want[k])));
}
const pixelAt = (buf, i) => [buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2], buf[i * 4 + 3]];
/** 一行像素算一遍,回每个像素的 S 和盖回去的最大差 */
function solve(upperPixels, lowerPixels, options = {}) {
  const n = upperPixels.length;
  const out = diffLayer(image(upperPixels), image(lowerPixels), n, 1, options);
  const layer = Array.from({ length: n }, (_, i) => pixelAt(out.rgba, i));
  return { out, layer, errors: layer.map((s, i) => backError(s, lowerPixels[i], upperPixels[i])) };
}
/** 契约第 5.3 节原来的算式(不透明度取各条下限里最大的),只算不透明度 */
function contractAlpha(upperPx, lowerPx) {
  const ra = upperPx[3] / 255, la = lowerPx[3] / 255;
  let a = la < 1 ? (ra - la) / (1 - la) : 0;
  for (let k = 0; k < 3; k++) {
    const rc = upperPx[k] / 255 * ra, lc = lowerPx[k] / 255 * la;
    if (lc > 0) a = Math.max(a, 1 - rc / lc);
    if (lc < 1) a = Math.max(a, (rc - lc) / (1 - lc));
  }
  return Math.max(0, Math.min(1, a));
}

/* ------------------------------------------------------------ 算式 */

test('BD-same 两张相同:那一层全透明', () => {
  const rand = rng(1);
  const pixels = Array.from({ length: 400 }, () => px(Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256)));
  const { out } = solve(pixels, pixels);
  assert.equal(out.changed, 0);
  assert.ok(out.rgba.every(v => v === 0));
  assert.deepEqual([out.width, out.height], [400, 1]);
});

test('BD-lower-clear 下层全透明:那一层就是带目标卡的画面本身', () => {
  const rand = rng(2);
  const upper = Array.from({ length: 300 }, () => px(Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), 1 + Math.floor(rand() * 255)));
  // 下层全透明时截图里它的颜色恒为 0;颜色是别的值也一样(全透明处颜色不算数)
  for (const lowerColor of [0, 200]) {
    const lower = upper.map(() => px(lowerColor, lowerColor, lowerColor, 0));
    const { out } = solve(upper, lower);
    assert.equal(Buffer.compare(out.rgba, image(upper)), 0);
    assert.equal(out.changed, 300);
  }
  // 带目标卡的画面也全透明的像素:透明
  assert.ok(solve([px(9, 9, 9, 0)], [px(0, 0, 0, 0)]).out.rgba.every(v => v === 0));
});

test('BD-lower-solid 下层完全不透明、目标卡是一片阴影:那一层是黑色、不透明度就是阴影的深浅,盖回去差不过一级', () => {
  const rand = rng(3);
  const shade = 0.3;
  const lower = [], upper = [];
  for (let i = 0; i < 2000; i++) {
    const l = px(Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), 255);
    lower.push(l);
    upper.push(toStraight(over({ a: shade, c: [0, 0, 0] }, l)));
  }
  const { layer, errors } = solve(upper, lower);
  assert.ok(Math.max(...errors) <= 1.5, `盖回去最大差 ${Math.max(...errors)}`);
  // 有一个通道够亮的像素上,不透明度量得准:离 0.3 × 255 = 76.5 不超过 3 级
  const bright = layer.filter((_, i) => Math.max(lower[i][0], lower[i][1], lower[i][2]) >= 128);
  assert.ok(bright.length > 1000);
  for (const s of bright) assert.ok(Math.abs(s[3] - shade * 255) <= 3, `不透明度 ${s[3]}`);
  // 颜色是黑的(预乘以后不超过 2 级)
  for (const s of bright) assert.ok(Math.max(s[0], s[1], s[2]) * s[3] / 255 <= 2, `颜色 ${s}`);
});

test('BD-noise-solid 量化噪声(下层不透明):很暗的通道差一级,不许把整个像素顶成不透明', () => {
  // 纯绿的下层,红蓝两个通道只有 1、2 级;压暗三成以后它们四舍五入到 0 或 1
  const lower = [px(1, 255, 1, 255), px(2, 255, 0, 255), px(1, 250, 2, 255), px(0, 255, 0, 255)];
  const upper = lower.map(l => toStraight(over({ a: 0.3, c: [0, 0, 0] }, l)));
  assert.deepEqual(upper[0], [1, 179, 1, 255]);
  // 同一幅画面换一种取整(截掉小数而不是四舍五入):1 × 0.7 = 0.7 变成 0,差不到一级
  const noisy = lower.map(l => px(Math.floor(l[0] * 0.7), Math.floor(l[1] * 0.7), Math.floor(l[2] * 0.7), 255));
  assert.deepEqual(noisy[0], [0, 178, 0, 255]);
  for (const set of [upper, noisy]) {
    const { layer, errors } = solve(set, lower);
    for (const s of layer) assert.ok(Math.abs(s[3] - 76.5) <= 3, `不透明度 ${s[3]} 应当在 76 上下`);
    assert.ok(Math.max(...errors) <= 1.5, `盖回去最大差 ${Math.max(...errors)}`);
  }
  // 对照:不放宽(容差 0,即契约原来的算式)时,同样的像素被顶成完全不透明
  const strict = solve(noisy, lower, { tolerance: 0 }).layer;
  assert.equal(strict[0][3], 255);
  assert.equal(contractAlpha(noisy[0], lower[0]), 1);
});

test('BD-contract 下层不透明、容差为 0 时,不透明度就是契约第 5.3 节的算式(各条下限里最大的)', () => {
  const rand = rng(4);
  for (let i = 0; i < 500; i++) {
    const l = px(Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), 255);
    const u = px(Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), 255);
    const got = solve([u], [l], { tolerance: 0 }).layer[0][3];
    const same = u.every((v, k) => v === l[k]);
    assert.equal(got, same ? 0 : Math.round(contractAlpha(u, l) * 255), `R ${u} L ${l}`);
  }
  // 放宽以后只会更小,而且不会小过头:盖回去的颜色最多差一级多一点
  for (let i = 0; i < 500; i++) {
    const l = px(Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), 255);
    const u = px(Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), 255);
    const relaxed = solve([u], [l]);
    assert.ok(relaxed.layer[0][3] <= Math.round(contractAlpha(u, l) * 255));
    assert.ok(relaxed.errors[0] <= 1.5, `R ${u} L ${l} 差 ${relaxed.errors[0]}`);
  }
  assert.equal(DIFF_TOLERANCE, 1 / 255);
});

test('BD-overlay 任意一层盖在任意下层上(不透明、半透明、全透明都有):算出来的那一层盖回去和原画面差在两级以内', () => {
  const rand = rng(5);
  const lower = [], upper = [];
  for (let i = 0; i < 6000; i++) {
    const kind = i % 3;
    const la = kind === 0 ? 255 : kind === 1 ? 1 + Math.floor(rand() * 254) : Math.floor(rand() * 40);
    const l = la ? px(Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), la) : px(0, 0, 0, 0);
    const a = rand() < 0.15 ? 1 : rand();
    const layer = { a, c: [rand() * a, rand() * a, rand() * a] };
    lower.push(l);
    upper.push(toStraight(over(layer, l)));
  }
  const { layer, errors } = solve(upper, lower);
  let worst = 0, at = -1;
  errors.forEach((e, i) => { if (e > worst) { worst = e; at = i; } });
  assert.ok(worst <= 2, `最大差 ${worst.toFixed(2)}:R ${upper[at]} L ${lower[at]} S ${layer[at]}`);
  const mean = errors.reduce((s, e) => s + e, 0) / errors.length;
  assert.ok(mean <= 0.6, `平均 ${mean}`);
});

test('BD-noise-faint 量化噪声(下层几乎全透明):颜色对不上不许顶出一个不透明的像素', () => {
  // 实测碰到的像素:下层是不透明度 1/255 的蓝,带目标卡的画面是不透明度 1/255 的黑(预乘以后两个都是 0)
  const lower = [px(0, 0, 255, 1), px(0, 64, 128, 4), px(10, 10, 10, 128)];
  const upper = [px(0, 0, 0, 1), px(0, 60, 128, 4), px(9, 9, 9, 128)];
  const { layer, errors } = solve(upper, lower);
  for (const s of layer) assert.ok(s[3] <= 2, `不透明度 ${s[3]}`);
  assert.ok(Math.max(...errors) <= 1.5);
  // 对照:契约原来的算式在第一个像素上给出完全不透明(盖回去不透明度差 254 级)
  assert.equal(contractAlpha(upper[0], lower[0]), 1);
});

test('BD-lower-half 下层半透明、目标卡是真的盖上去的一层:不透明度那条式子和颜色的下限不打架时两条都成立', () => {
  // 白字(不透明度 0.6)上面压一层深色半透明:R 的不透明度 = a + 0.6 × (1 − a)
  const l = px(255, 255, 255, 153);
  const layer = { a: 0.676, c: [0.04, 0.045, 0.06] };
  const u = toStraight(over(layer, l));
  const got = solve([u], [l]);
  assert.ok(Math.abs(got.layer[0][3] - 0.676 * 255) <= 2, `不透明度 ${got.layer[0][3]}`);
  assert.ok(got.errors[0] <= 1.5);
});

test('BD-glass 毛玻璃的外框里、下层完全不透明的像素:那一层就是带目标卡的画面(不透明);框外和下层不是不透明的像素照常算', () => {
  // 一行 8 个像素,玻璃盖住中间 4 个(第 2～5 个)
  const lower = [px(200, 30, 30, 255), px(200, 30, 30, 255), px(200, 30, 30, 255), px(40, 200, 40, 255), px(40, 200, 40, 255), px(90, 90, 90, 128), px(40, 200, 40, 255), px(40, 200, 40, 255)];
  const upper = lower.map((l, i) => (i === 2 ? l : toStraight(over({ a: 0.4, c: [0, 0, 0] }, l))));
  const glass = [{ x: 2, y: 0, w: 4, h: 1 }];
  const { layer, errors, out } = solve(upper, lower, { glass });
  // 框里、下层不透明:第 2 个(两张相同)、第 3、4 个 —— 都是 R 本身、不透明度 255
  for (const i of [2, 3, 4]) assert.deepEqual(layer[i], [upper[i][0], upper[i][1], upper[i][2], 255], `第 ${i} 个`);
  // 框里、下层半透明(第 5 个):不能取 1,照常算
  assert.ok(layer[5][3] < 255 && layer[5][3] > 0);
  // 框外:照最小的不透明度(这里是一层 0.4 的黑,最小的就是它自己)
  for (const i of [0, 1, 6, 7]) assert.ok(Math.abs(layer[i][3] - 0.4 * 255) <= 4, `第 ${i} 个不透明度 ${layer[i][3]}`);
  assert.ok(Math.max(...errors) <= 1.5);
  assert.equal(out.changed, 8);
  // 没有掩码时第 2 个是透明的
  assert.equal(solve(upper, lower).layer[2][3], 0);
});

test('BD-mask 毛玻璃的掩码:圆角矩形,像素中心在里面的才算;半径超过边长时按比例缩', () => {
  const area = { x: 10, y: 20, w: 40, h: 30 };
  const mask = glassMask([{ x: 20, y: 25, w: 20, h: 20, radii: [[8, 8], [8, 8], [8, 8], [8, 8]] }], area);
  const at = (x, y) => mask[(y - area.y) * area.w + (x - area.x)];
  assert.equal(at(30, 35), 1, '中心');
  assert.equal(at(20, 35), 1, '左边中点');
  assert.equal(at(39, 35), 1, '右边最后一列');
  assert.equal(at(40, 35), 0, '右边外面');
  assert.equal(at(20, 25), 0, '左上角被圆角切掉');
  assert.equal(at(39, 44), 0, '右下角被圆角切掉');
  assert.equal(at(23, 27), 1, '圆角里面');
  assert.equal(at(19, 35), 0);
  // 没有圆角:整块
  const square = glassMask([{ x: 20, y: 25, w: 20, h: 20 }], area);
  assert.equal(square.reduce((s, v) => s + v, 0), 400);
  // 半径比边长的一半还大:缩成一个圆
  const round = glassMask([{ x: 20, y: 25, w: 20, h: 20, radii: [[50, 50], [50, 50], [50, 50], [50, 50]] }], area);
  const filled = round.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(filled - Math.PI * 100) <= 12, `圆的面积 ${filled}`);
  // 伸到区域外面的部分裁掉;带小数的坐标不出界
  const partial = glassMask([{ x: 0.5, y: 10.25, w: 20.5, h: 15.5 }], area);
  assert.equal(partial.reduce((s, v) => s + v, 0), 11 * 6);
});

test('BD-crop 只交出一块:和整张算完再裁逐字节相同;矩形不在画面里就抛', () => {
  const rand = rng(6);
  const W = 24, H = 16;
  const lower = Buffer.alloc(W * H * 4), upper = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const l = px(Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), i % 5 === 0 ? 0 : i % 3 === 0 ? 120 : 255);
    const u = i % 4 === 0 ? l : toStraight(over({ a: 0.5, c: [0.1, 0.2, 0.3] }, l));
    lower.set(l, i * 4); upper.set(u, i * 4);
  }
  const glass = [{ x: 6, y: 4, w: 10, h: 8 }];
  const whole = diffLayer(upper, lower, W, H, { glass });
  const crop = { x: 5, y: 3, w: 12, h: 10 };
  const part = diffLayer(upper, lower, W, H, { crop, glass });
  const expected = Buffer.alloc(crop.w * crop.h * 4);
  for (let y = 0; y < crop.h; y++) whole.rgba.copy(expected, y * crop.w * 4, ((y + crop.y) * W + crop.x) * 4, ((y + crop.y) * W + crop.x + crop.w) * 4);
  assert.equal(Buffer.compare(part.rgba, expected), 0);
  assert.deepEqual([part.width, part.height], [12, 10]);
  assert.throws(() => diffLayer(upper, lower, W, H, { crop: { x: 20, y: 0, w: 8, h: 4 } }), /不在画面里/);
  assert.throws(() => diffLayer(upper.subarray(0, 100), lower, W, H), /比画面小/);
});

test('BD-outside 交出去的矩形外面两张有没有不同:回那些像素的包围盒', () => {
  const W = 20, H = 12;
  const lower = Buffer.alloc(W * H * 4, 7);
  const crop = { x: 6, y: 4, w: 8, h: 4 };
  const upper = Buffer.from(lower);
  assert.equal(changedOutside(upper, lower, W, H, crop), null);
  // 矩形里面改:不算
  upper[(5 * W + 8) * 4] = 99;
  assert.equal(changedOutside(upper, lower, W, H, crop), null);
  // 上方一个、同一行左边一个、右边一个
  upper[(1 * W + 15) * 4 + 3] = 99;
  upper[(6 * W + 2) * 4 + 1] = 99;
  upper[(7 * W + 17) * 4 + 2] = 99;
  assert.deepEqual(changedOutside(upper, lower, W, H, crop), { x: 2, y: 1, w: 16, h: 7 });
});

test('BD-outside-layer 矩形外面逐字节不同、算出来却仍是全透明的像素不算改到了外面;真有东西的才算', () => {
  const W = 20, H = 12;
  const crop = { x: 6, y: 4, w: 8, h: 4 };
  // 下层是不透明度 1/255 的蓝(几乎全透明)
  const lower = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) lower.set([0, 0, 255, 1], i * 4);
  // 外面几个像素颜色变成了黑(预乘以后和原来一样是 0):逐字节不同,但算出来的那一层是透明的
  const faint = Buffer.from(lower);
  for (const [x, y] of [[2, 1], [17, 7], [3, 10]]) faint.set([0, 0, 0, 1], (y * W + x) * 4);
  assert.ok(changedOutside(faint, lower, W, H, crop));
  assert.equal(layerOutside(faint, lower, W, H, crop), null);
  // 外面有一个真的盖了东西的像素:算
  const real = Buffer.from(faint);
  real.set([200, 200, 200, 180], (9 * W + 16) * 4);
  assert.deepEqual(layerOutside(real, lower, W, H, crop), { x: 16, y: 9, w: 1, h: 1 });
  // 矩形里面再怎么变都不算
  const inside = Buffer.from(lower);
  inside.set([10, 10, 10, 255], (5 * W + 8) * 4);
  assert.equal(layerOutside(inside, lower, W, H, crop), null);
});

/* ------------------------------------------------------------ 取两张 */

const STAGE = { width: 96, height: 64 };
const pngOf = (data, width, height) => { const png = new PNG({ width, height }); data.copy(png.data); return PNG.sync.write(png); };
const cropOf = (data, rect) => {
  const out = Buffer.alloc(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y++) data.copy(out, y * rect.w * 4, ((rect.y + y) * STAGE.width + rect.x) * 4, ((rect.y + y) * STAGE.width + rect.x + rect.w) * 4);
  return out;
};
/** 下层在第 `frame` 帧的画面:不透明的竖条纹往右走,左下角一块半透明;`drift` 不为 0 时整体再挪几列(模拟「多走了一步」) */
function lowerPixels(frame, drift = 0) {
  const data = Buffer.alloc(STAGE.width * STAGE.height * 4);
  for (let y = 0; y < STAGE.height; y++) for (let x = 0; x < STAGE.width; x++) {
    const i = (y * STAGE.width + x) * 4, band = Math.floor((x + frame * 2 + drift * 5) / 8) % 3;
    data[i] = band === 0 ? 230 : 20; data[i + 1] = band === 1 ? 230 : 30; data[i + 2] = band === 2 ? 230 : 40; data[i + 3] = 255;
    if (x < 16 && y >= 48) { data[i + 3] = 100; }
  }
  return data;
}
/** 目标卡这一帧的框(`slide` 为真时它每帧往右挪一点) */
const targetBox = (frame, slide) => ({ x: 30 + (slide ? frame * 2 : 0), y: 20, w: 24, h: 16 });
/** 带目标卡的画面:框里是「滤过的下层」(这里取整块的平均色再压暗)加一行白字,框外一圈 4 像素的阴影 */
function upperPixels(frame, { drift = 0, slide = false } = {}) {
  const data = lowerPixels(frame, drift);
  const box = targetBox(frame, slide);
  for (let y = box.y - 4; y < box.y + box.h + 4; y++) for (let x = box.x - 4; x < box.x + box.w + 4; x++) {
    if (x < 0 || y < 0 || x >= STAGE.width || y >= STAGE.height) continue;
    const i = (y * STAGE.width + x) * 4;
    const inside = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
    if (inside) {
      const text = y === box.y + 6 && x % 3 === 0, tone = (frame % 5) * 12;
      data[i] = text ? 255 : 60 + tone; data[i + 1] = text ? 255 : 62 + tone; data[i + 2] = text ? 255 : 70 + tone; data[i + 3] = 255;
    } else {
      data[i] = Math.round(data[i] * 0.7); data[i + 1] = Math.round(data[i + 1] * 0.7); data[i + 2] = Math.round(data[i + 2] * 0.7);
    }
  }
  return data;
}

/**
 * 假的预渲染间,配真的 `bakeStream`。页面的状态只有:当前帧、目标卡藏没藏、截过几张图。
 *   present(frame)  这一帧页面上有没有目标卡
 *   stale           藏起来以后的第一张截图给的还是藏之前的画面(合成器里上一拍的旧图)
 *   drifting        下层每截一张图就多走一步(不该有的页面)
 *   stuck           藏不住(算出来的不透明度不是 0)
 *   failLower       藏着的时候截图抛错
 *   slide           目标卡每帧往右挪
 */
function fakeBakery({ present = () => true, stale = false, drifting = false, stuck = false, failLower = false, slide = false } = {}) {
  const log = [];
  let frame = 0, hidden = false, shots = 0, staleNext = false, clip = { x: 0, y: 0, ...{ w: STAGE.width, h: STAGE.height } };
  const bakery = {
    log,
    page: {
      async evaluate(fn, ...args) {
        if (fn === pageHideTarget) {
          log.push(`hide:${frame}:${args[0]}`);
          if (!present(frame)) return { ok: true, absent: true, reason: null, glass: [] };
          if (stuck) return { ok: false, absent: false, reason: 'not-hidden', glass: [] };
          hidden = true; staleNext = stale;
          const box = targetBox(frame, slide);
          return { ok: true, absent: false, reason: null, glass: [{ x: box.x, y: box.y, w: box.w, h: box.h }] };
        }
        if (fn === pageShowTarget) { log.push(`show:${frame}`); hidden = false; return true; }
        const src = String(fn);
        if (src.includes('__pcTimeline')) return { fps: 30, ...STAGE, duration: 2 };
        if (src.includes('__pcSetT')) { frame = Math.round(args[0].sec * 30); log.push(`step:${frame}`); return { raf: 0, mut: 0 }; }
        if (src.includes('__pcPrepareFrameMedia')) { log.push(`media:${frame}`); return null; }
        return null;
      },
      async setViewport() {},
      viewport: () => ({ ...STAGE, deviceScaleFactor: 1 }),
    },
    client: { async send(method, params) { if (method === 'Emulation.setDeviceMetricsOverride') clip = params.viewport ? { x: params.viewport.x, y: params.viewport.y, w: params.viewport.width, h: params.viewport.height } : { x: 0, y: 0, w: STAGE.width, h: STAGE.height }; } },
    async beginFrame(extra = {}) {
      // 画一张丢掉的(`frame-stream.mjs` 的 `BELOW_DISCARD_SHOT`):只记下在哪一帧画过
      if (extra.screenshot?.format === 'jpeg') {
        if (extra.screenshot?.quality === 1) log.push(`draw:${frame}`);
        return { screenshotData: 'ok' };
      }
      if (extra.screenshot?.format !== 'png') return {};
      if (hidden && failLower) throw new Error('截图坏了');
      const drift = drifting ? shots : 0;
      shots++;
      let visible = present(frame) && !hidden;
      if (hidden && staleNext) { visible = true; staleNext = false; }
      log.push(`shot:${frame}:${visible ? 'upper' : 'lower'}:${clip.w}x${clip.h}`);
      const full = visible ? upperPixels(frame, { drift, slide }) : lowerPixels(frame, drift);
      return { screenshotData: pngOf(cropOf(full, clip), clip.w, clip.h).toString('base64') };
    },
    async waitNet() {},
    async reset() { bakery.page = { ...bakery.page }; hidden = false; },
  };
  return bakery;
}
const VIEW = { x: 0, y: 0, w: STAGE.width, h: STAGE.height };
/** 一个分段:真的 `bakeStream` 加 `belowSegmentCapture`。回每帧交出来的东西 */
async function capture(bakery, { from = 0, to = 4, stride = 1, rect = VIEW, record = newBelowRecord(), verify = true, signature = 'S', notes = [] } = {}) {
  const frames = new Map();
  await bakeStream(bakery, { streamSignature: signature, fromFrame: from, toFrame: to, stride, fps: 30, mountFrame: 0, clip: VIEW,
    capture: belowSegmentCapture(bakery, { clipId: 'target', view: VIEW, rect, record, verify, note: m => notes.push(m) }),
    onFrame: async (frame, shot) => { frames.set(frame, shot); } });
  return { frames, record, notes };
}
/** 从 `mark` 起的操作(去掉预热那一段) */
const opsOf = (bakery, frame) => {
  const start = bakery.log.lastIndexOf(`step:${frame}`);
  const next = bakery.log.indexOf(`step:${frame + 1}`, start + 1);
  return bakery.log.slice(start + 1, next < 0 ? undefined : next);
};

test('BD-order 取两张的先后:上张、藏、下张、撤;两张之间不推时间;每个分段第一帧多截两张做实测', async () => {
  const bakery = fakeBakery();
  const { frames, record } = await capture(bakery, { from: 0, to: 4 });
  // 第 0 帧(分段第一帧):上张(前面没截过,先丢一张)→ 藏 → 下张 → 再截一张(实测)→ 撤 → 再截一张(实测)
  assert.deepEqual(opsOf(bakery, 0), ['shot:0:upper:96x64', 'shot:0:upper:96x64', 'hide:0:target', 'shot:0:lower:96x64', 'shot:0:lower:96x64', 'show:0', 'shot:0:upper:96x64']);
  // 之后每帧:上张 → 藏 → 下张 → 撤
  for (const f of [1, 2, 3, 4]) assert.deepEqual(opsOf(bakery, f), [`shot:${f}:upper:96x64`, `hide:${f}:target`, `shot:${f}:lower:96x64`, `show:${f}`], `第 ${f} 帧`);
  // 两张之间没有推过时间:每一次藏和它后面最近的一次撤之间没有 step
  const hideAt = bakery.log.map((op, i) => (op.startsWith('hide:') ? i : -1)).filter(i => i >= 0);
  for (const i of hideAt) {
    const until = bakery.log.findIndex((op, j) => j > i && op.startsWith('show:'));
    assert.ok(until > i);
    assert.ok(bakery.log.slice(i, until).every(op => !op.startsWith('step:')), '藏着的时候推了时间');
  }
  assert.equal(bakery.log.filter(op => op.startsWith('hide:')).length, bakery.log.filter(op => op.startsWith('show:')).length);
  assert.deepEqual([record.frames, record.checks, record.absent, record.failed, record.primeLower], [5, 1, 0, null, false]);
  assert.deepEqual(record.last, { frame: 0, lowerStable: true, upperStable: true });
  // 交出来的每一帧盖回这一帧的下层,等于这一帧带目标卡的画面
  for (const [f, shot] of frames) {
    assert.deepEqual([shot.width, shot.height], [96, 64]);
    const lower = lowerPixels(f), upper = upperPixels(f);
    let worst = 0;
    for (let i = 0; i < 96 * 64; i++) worst = Math.max(worst, backError(pixelAt(shot.rgba, i), pixelAt(lower, i), pixelAt(upper, i)));
    assert.ok(worst <= 1.5, `第 ${f} 帧盖回去最大差 ${worst}`);
    // 目标卡没有改动的地方全透明:框和阴影以外一个不透明的像素都没有
    const box = targetBox(f, false);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) {
      const near = x >= box.x - 4 && x < box.x + box.w + 4 && y >= box.y - 4 && y < box.y + box.h + 4;
      if (!near) assert.equal(shot.rgba[(y * 96 + x) * 4 + 3], 0, `(${x},${y}) 应当透明`);
    }
    // 毛玻璃的框里(下层不透明)是不透明的
    assert.equal(shot.rgba[((box.y + 2) * 96 + box.x + 2) * 4 + 3], 255);
  }
  // 不做实测时第一帧也只有四步
  const plain = fakeBakery();
  await capture(plain, { from: 0, to: 0, verify: false });
  assert.deepEqual(opsOf(plain, 0), ['shot:0:upper:96x64', 'shot:0:upper:96x64', 'hide:0:target', 'shot:0:lower:96x64', 'show:0']);
});

test('BD-absent 目标卡还没入场的帧:什么都不藏,交出一张全透明的;实测留到它在场的第一帧', async () => {
  const bakery = fakeBakery({ present: frame => frame >= 3 });
  const { frames, record } = await capture(bakery, { from: 0, to: 4 });
  for (const f of [0, 1, 2]) {
    assert.ok(frames.get(f).rgba.every(v => v === 0));
    assert.ok(!opsOf(bakery, f).some(op => op.startsWith('show:')), '没藏就不用撤');
    assert.equal(opsOf(bakery, f).filter(op => op.includes(':lower:')).length, f === 0 ? 2 : 1, '只有 bakeStream 自己那一次截图');
  }
  assert.deepEqual(opsOf(bakery, 3), ['shot:3:upper:96x64', 'hide:3:target', 'shot:3:lower:96x64', 'shot:3:lower:96x64', 'show:3', 'shot:3:upper:96x64']);
  assert.deepEqual([record.frames, record.absent, record.checks], [5, 3, 1]);
  assert.equal(record.last.frame, 3);
  assert.ok(frames.get(3).rgba.some(v => v !== 0));
});

test('BD-stale 藏起来以后第一张截到的是旧画面:实测比出来,这个分段失败;这条流以后每张下张先丢一张再截', async () => {
  const record = newBelowRecord(), notes = [];
  const bakery = fakeBakery({ stale: true });
  await assert.rejects(capture(bakery, { from: 0, to: 4, record, notes }), e => e.code === 'lower-unstable');
  assert.equal(record.primeLower, true);
  assert.equal(record.failed, null, '不判死这条流');
  assert.deepEqual(record.last, { frame: 0, lowerStable: false, upperStable: true });
  assert.ok(notes.some(m => /连截两张不相同/.test(m)));
  assert.equal(bakery.log.filter(op => op.startsWith('hide:')).length, bakery.log.filter(op => op.startsWith('show:')).length, '失败了也撤掉');
  // 重来:每张下张先丢一张,实测通过,交出来的那一层是对的
  const again = fakeBakery({ stale: true });
  const { frames } = await capture(again, { from: 0, to: 2, record, signature: 'S2' });
  assert.deepEqual(opsOf(again, 1), ['shot:1:upper:96x64', 'hide:1:target', 'shot:1:upper:96x64', 'shot:1:lower:96x64', 'show:1']);
  assert.equal(record.last.lowerStable, true);
  const lower = lowerPixels(1), upper = upperPixels(1);
  let worst = 0;
  for (let i = 0; i < 96 * 64; i++) worst = Math.max(worst, backError(pixelAt(frames.get(1).rgba, i), pixelAt(lower, i), pixelAt(upper, i)));
  assert.ok(worst <= 1.5);
});

test('BD-drift 下层每多一拍就多走一步的页面:撤掉以后上张变了,这条流判死,不交出算错的帧', async () => {
  const record = newBelowRecord(), notes = [];
  const bakery = fakeBakery({ drifting: true });
  await assert.rejects(capture(bakery, { from: 0, to: 4, record, notes }), e => e.code === 'upper-changed');
  assert.equal(record.failed, 'upper-changed');
  assert.ok(notes.some(m => /不再产/.test(m)));
  assert.equal(bakery.log.filter(op => op.startsWith('hide:')).length, bakery.log.filter(op => op.startsWith('show:')).length);
  // 判死以后再来:第一帧就抛,不再藏
  const again = fakeBakery({ drifting: true });
  await assert.rejects(capture(again, { from: 15, to: 16, record, signature: 'S2' }), e => e.code === 'upper-changed');
  assert.equal(again.log.filter(op => op.startsWith('hide:')).length, 0);
});

test('BD-stuck 藏不住、或者藏着的时候截图出错:抛错;藏了的一定撤', async () => {
  const stuck = fakeBakery({ stuck: true });
  await assert.rejects(capture(stuck, { from: 0, to: 1 }), e => e.code === 'not-hidden');
  const broken = fakeBakery({ failLower: true });
  await assert.rejects(capture(broken, { from: 0, to: 1 }), /截图坏了/);
  assert.deepEqual(broken.log.filter(op => /^(hide|show):/.test(op)), ['hide:0:target', 'show:0']);
});

test('BD-rect 交出去的矩形比截图矩形小:两张照旧截整幅,交出去的是裁过的;目标卡改到矩形外面就抛,带上那一块的位置', async () => {
  const rect = { x: 24, y: 14, w: 40, h: 30 };
  const bakery = fakeBakery();
  const { frames } = await capture(bakery, { from: 0, to: 2, rect });
  assert.ok(bakery.log.filter(op => op.startsWith('shot:')).every(op => op.endsWith(':96x64')), '截图一直是整幅');
  const whole = await capture(fakeBakery(), { from: 0, to: 2 });
  for (const f of [0, 1, 2]) {
    assert.deepEqual([frames.get(f).width, frames.get(f).height], [40, 30]);
    assert.equal(Buffer.compare(frames.get(f).rgba, cropOf(whole.frames.get(f).rgba, rect)), 0, `第 ${f} 帧和整幅算完再裁相同`);
  }
  // 目标卡每帧往右挪 2 像素:到第 4 帧阴影的右边出了矩形(矩形右边界是 64,阴影右边到 30 + 8 + 24 + 4 = 66)
  const record = newBelowRecord();
  const sliding = fakeBakery({ slide: true });
  await assert.rejects(capture(sliding, { from: 0, to: 6, rect, record }), (e) => {
    assert.equal(e.code, 'below-overflow');
    assert.deepEqual(e.box, { x: 64, y: 16, w: 2, h: 24 });
    return true;
  });
  assert.equal(record.overflows, 1);
  assert.equal(record.failed, null);
  assert.throws(() => belowSegmentCapture(fakeBakery(), { clipId: 'target', view: rect, rect: VIEW }), /不在截图矩形/);
});

/* ------------------------------------------------------------ 接到生产者上 */

const ENV_FP = '0123456789abcdef';
const control = (clipId, start, end, caps) => ({
  clipId, key: `K-${clipId}`, snapshotKey: `S-${clipId}`, cacheContentKey: `C-${clipId}`, capabilities: caps, compositing: caps.compositing, frameMode: caps.frameMode,
  start, end, count: Math.ceil((end - start) * 30), sampling: { firstFrame: Math.ceil(start * 30), fps: { numerator: '30', denominator: '1' }, phase: { numerator: '0', denominator: '1' } },
});
const GLASS_CAPS = { compositing: 'belowDependent', frameMode: 'direct', canvasHeavy: false };
const PLAIN_CAPS = { compositing: 'independent', frameMode: 'stateful', canvasHeavy: false };
const projectOf = ({ media = false } = {}) => ({ ...STAGE, fps: 30, duration: 2, media: media ? [{ id: 'm', kind: 'video', name: 'v.mp4', url: '/v.mp4' }] : [],
  tracks: [
    { id: 't-top', clips: [{ id: 'target', cardId: 'glass', start: 0, end: 2 }] },
    { id: 't-low', clips: [{ id: 'low', cardId: 'plain', start: 0, end: 2 }, ...(media ? [{ id: 'video', mediaId: 'm', start: 0, end: 2 }] : [])] },
  ] });

async function producerFor(project, { below = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-below-capture-'));
  const pipeline = { root, ready: createReadyHub(), prerenderPicked: () => true, captureCode: () => 'C', emptyUrl: () => 'about:blank' };
  const producer = new StreamProducer(pipeline, { env: { PROMPTCUT_STREAM_PREWARM: '0', PROMPTCUT_STREAM_DIRECT: 'off' } });
  producer.attachRoute();
  producer.ffmpeg = 'ffmpeg';
  producer.encoderName = 'libx264';
  const clipIds = project.tracks.flatMap(track => track.clips.map(c => c.id));
  const cardPlan = clipIds.map(id => control(id, 0, 2, id === 'target' ? GLASS_CAPS : PLAIN_CAPS));
  const specs = planStreams({ key: 'E', project, cardPlan }, { envFingerprint: ENV_FP, below });
  const stateOf = (spec) => {
    // `queueOnly`:自动生产不碰这条流(测试里没有真的预渲染间给它借),分段由下面的 `run` 一个一个产
    const state = { spec, manifest: producer.freshManifest(spec), isolated: {}, generation: 0, entryKey: 'E', aliases: new Set(), reserved: new Set(), failures: new Map(), measured: null, measuredSegments: new Set(), queueOnly: true };
    producer.streams.set(spec.streamKey, state);
    return state;
  };
  const run = async (bakery, state, segment, stride) => {
    const task = { state, segment, stride };
    assert.equal(await producer.runSegment(bakery, task), true);
    await task.job;
    const seg = state.manifest.segments[segment];
    assert.ok(seg, `分段 ${segment} 落盘了(${producer.log.map(l => l.message).join(' | ')})`);
    return seg;
  };
  const close = async () => { await producer.close(); await fs.rm(root, { recursive: true, force: true }); };
  return { producer, specs, stateOf, run, close, root };
}
/** ffmpeg 解一个分段成 RGB(上半预乘色、隔 8 行、下半不透明度) */
function decode(dir, init, seg) {
  const file = path.join(dir, 'dec.mp4');
  fsSync.writeFileSync(file, Buffer.concat([init, seg]));
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 1 << 28, windowsHide: true });
}

test('BD-produce 生产者产依赖下层的流:截图恒为整幅、等素材就位;稀疏那一趟量出实体框、第二趟收紧;解出来盖回下层等于带目标卡的画面', { skip: !ffmpegOk }, async () => {
  const project = projectOf({ media: true });
  const { producer, specs, stateOf, run, close } = await producerFor(project);
  try {
    const spec = specs.find(s => s.kind === 'below');
    assert.ok(spec, '计划里有这条流');
    assert.equal(spec.hasMedia, true);
    assert.deepEqual(spec.clipIds, ['target']);
    const state = stateOf(spec);
    const bakery = fakeBakery();
    const segments = [0, 1, 2, 3];
    for (const n of segments) await run(bakery, state, n, SPARSE_STRIDE);
    // 实体框:目标卡的框加阴影是 x 26..57、y 16..39;外扩 8、夹回画面、凑成偶数
    assert.deepEqual(state.measured, { x: 26, y: 16, w: 32, h: 24 });
    assert.deepEqual(state.manifest.tight, { x: 18, y: 8, w: 48, h: 40 });
    assert.ok(bakery.log.filter(op => op.startsWith('shot:')).every(op => op.endsWith(':96x64')), '稀疏那一趟截的是整幅');
    assert.ok(bakery.log.some(op => op.startsWith('media:')), '截图前等了素材');
    // 稀疏那一趟每个分段只取分段的第一帧:第 1、3 帧没有取,第 15 帧(第 1 段的第一帧)取了
    assert.ok(!bakery.log.includes('hide:1:target') && !bakery.log.includes('hide:3:target') && bakery.log.includes('hide:0:target') && bakery.log.includes('hide:15:target'));
    const sparseHides = bakery.log.filter(op => op.startsWith('hide:')).length;
    assert.equal(sparseHides, 4, '四个分段各一张');
    // 每个分段的位置矩形记在清单里(平面坐标:这种流是舞台坐标),就是那一张里目标卡改动的那一块
    for (const n of segments) assert.deepEqual(state.manifest.segments[n].box, { x: 26, y: 16, w: 32, h: 24 }, `分段 ${n} 的位置矩形`);
    assert.ok(segments.every(n => state.manifest.segments[n].stride === SEGMENT_FRAMES), '稀疏分段的间隔记的是分段的帧数');
    for (const n of segments) await run(bakery, state, n, 1);
    assert.ok(bakery.log.filter(op => op.startsWith('shot:')).every(op => op.endsWith(':96x64')), '第二趟截的仍是整幅(不把截图矩形收紧)');
    const status = producer.status().streams[0];
    assert.equal(status.kind, 'below');
    assert.deepEqual([status.below.failed, status.below.primeLower, status.below.overflows, status.below.absent], [null, false, 0, 0]);
    assert.equal(status.below.checks, 8, '两趟、每个分段各实测一次');
    assert.equal(status.below.frames, 4 + 60);
    assert.equal(status.below.glassFrames, 64);
    // 补密以后位置矩形还在(沿用稀疏分段的)
    for (const n of segments) assert.deepEqual(state.manifest.segments[n].box, { x: 26, y: 16, w: 32, h: 24 });
    // 解第 1 个分段:每一帧盖回这一帧的下层,和这一帧带目标卡的画面比(收紧矩形里)
    const seg = state.manifest.segments[1];
    const init = state.manifest.inits[seg.init];
    assert.deepEqual(init.rect, { x: 18, y: 8, w: 48, h: 40 });
    assert.deepEqual([init.width, init.height], [48, 2 * (40 + 8)]);
    const dir = producer.store.dir(spec.streamKey);
    const raw = decode(dir, await fs.readFile(producer.store.initFile(spec.streamKey, seg.init)), await fs.readFile(path.join(dir, seg.file)));
    const rect = init.rect, frameBytes = rect.w * 2 * (rect.h + 8) * 3;
    assert.equal(raw.length, SEGMENT_FRAMES * frameBytes);
    /** 第 k 张解出来的画面盖回第 `f` 帧的下层,和第 `truth` 帧带目标卡的画面比(平均差) */
    const errorAgainst = (k, f, truth = f) => {
      const picture = raw.subarray(k * frameBytes, (k + 1) * frameBytes), lower = lowerPixels(f), upper = upperPixels(truth);
      let sum = 0, n = 0;
      for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
        const o = (y * rect.w + x) * 3, i = ((y + rect.y) * STAGE.width + x + rect.x) * 4;
        const a = picture[(rect.h + 8) * rect.w * 3 + o], keep = 1 - a / 255;
        for (let c = 0; c < 3; c++) { sum += Math.abs(Math.min(picture[o + c], a) + lower[i + c] * keep - upper[i + c]); n++; }
      }
      return sum / n;
    };
    for (let k = 0; k < SEGMENT_FRAMES; k++) {
      const same = errorAgainst(k, 15 + k), other = errorAgainst(k, 15 + k, 15 + ((k + 7) % SEGMENT_FRAMES));
      assert.ok(same <= 6, `第 ${15 + k} 帧盖回去平均差 ${same.toFixed(2)}`);
      assert.ok(other > 3 * same && other > 15, `对照(别的时刻)明显更大:${other.toFixed(2)} 对 ${same.toFixed(2)}`);
    }
  } finally { await close(); }
});

test('BD-widen 收紧矩形不够大(稀疏那一趟没量到的帧里目标卡走到了外面):放大矩形、这个分段重来,不算失败', { skip: !ffmpegOk }, async () => {
  const { producer, specs, stateOf, run, close } = await producerFor(projectOf());
  try {
    const spec = specs.find(s => s.kind === 'below');
    assert.equal(spec.hasMedia, false);
    const state = stateOf(spec);
    // 目标卡每帧往右挪 2 像素;稀疏那一趟只量分段的第一帧(第 0 帧),第 14 帧比量到的最右边多出 28 像素。把收紧矩形设小,让它露出来
    const bakery = fakeBakery({ slide: true });
    await run(bakery, state, 0, SPARSE_STRIDE);
    assert.deepEqual(state.measured, { x: 26, y: 16, w: 32, h: 24 });
    state.manifest.tight = { x: 24, y: 14, w: 60, h: 28 };
    const before = producer.stats.failures;
    await assert.rejects(producer.runSegment(bakery, { state, segment: 0, stride: 1 }), e => e.code === 'below-overflow' && e.cancelled === true);
    assert.equal(producer.stats.failures, before, '不记失败');
    assert.ok(state.manifest.tight.x + state.manifest.tight.w >= 86 + 8, `放大到 ${JSON.stringify(state.manifest.tight)}`);
    assert.ok(producer.log.some(l => /收紧矩形放大到/.test(l.message)));
    assert.equal(state.below.overflows >= 1, true);
    assert.equal(bakery.streamLease, null, '租约作废,下一次重灌页面');
    // 再来:一直放大到装得下为止(每次只多看到一帧),最后产出来
    let seg = null;
    for (let attempt = 0; attempt < 8 && !seg; attempt++) {
      const task = { state, segment: 0, stride: 1 };
      try { if (await producer.runSegment(bakery, task)) { await task.job; seg = state.manifest.segments[0]; } } catch (error) { if (error.code !== 'below-overflow') throw error; }
    }
    assert.ok(seg && seg.stride === 1, '放大以后产出来了');
    assert.deepEqual(state.manifest.inits[seg.init].rect, state.manifest.tight);
    assert.ok(state.manifest.tight.x + state.manifest.tight.w >= 30 + 28 + 24 + 4, '装得下第 14 帧的阴影');
  } finally { await close(); }
});

test('BD-noreplay 成员和下层都是 remotion 式的(`replay: false`):接不上前一段也不从挂载帧回放;有 motion 式的下层就回放', { skip: !ffmpegOk }, async () => {
  // 下层是 motion 式的卡:回放
  const stateful = await producerFor(projectOf());
  try {
    const spec = stateful.specs.find(s => s.kind === 'below');
    assert.equal(spec.replay, true);
    const bakery = fakeBakery();
    await stateful.run(bakery, stateful.stateOf(spec), 2, SPARSE_STRIDE);
    assert.ok(bakery.log.includes('step:0') && bakery.log.includes('step:29'), '从挂载帧推到这个分段');
    assert.equal(stateful.producer.status().streams[0].replayedFrames, 30);
  } finally { await stateful.close(); }
  // 下层只有素材(纯素材段按时间直接取帧),目标卡是 remotion 式:不回放
  const direct = await producerFor({ ...STAGE, fps: 30, duration: 2, media: [{ id: 'm', kind: 'video', name: 'v.mp4', url: '/v.mp4' }],
    tracks: [{ id: 't-top', clips: [{ id: 'target', cardId: 'glass', start: 0, end: 2 }] }, { id: 't-low', clips: [{ id: 'video', mediaId: 'm', start: 0, end: 2 }] }] });
  try {
    const spec = direct.specs.find(s => s.kind === 'below');
    assert.equal(spec.replay, false);
    assert.deepEqual(spec.belowClipIds, ['video']);
    const bakery = fakeBakery();
    await direct.run(bakery, direct.stateOf(spec), 2, SPARSE_STRIDE);
    const stepped = bakery.log.filter(op => op.startsWith('step:')).map(op => Number(op.slice(5)));
    assert.equal(Math.min(...stepped), 30, '直接落在这个分段的第一帧');
    assert.equal(direct.producer.status().streams.find(s => s.kind === 'below').replayedFrames, 0);
    // 两张照样取、实测照样做
    assert.equal(direct.producer.status().streams.find(s => s.kind === 'below').below.checks, 1);
  } finally { await direct.close(); }
});

test('BD-failed 实测判死的流:自动生产记成失败不再白付一次重灌,队列的任务报不可重试', { skip: !ffmpegOk }, async () => {
  const { producer, specs, stateOf, close } = await producerFor(projectOf());
  try {
    const spec = specs.find(s => s.kind === 'below');
    const state = stateOf(spec);
    const bakery = fakeBakery({ drifting: true });
    await assert.rejects(producer.runSegment(bakery, { state, segment: 0, stride: SPARSE_STRIDE }), e => e.code === 'upper-changed');
    assert.equal(state.below.failed, 'upper-changed');
    assert.equal(producer.status().streams[0].below.failed, 'upper-changed');
    let resets = 0;
    const counting = { ...bakery, reset: async () => { resets++; } };
    await assert.rejects(producer.runSegment(counting, { state, segment: 1, stride: SPARSE_STRIDE }), e => e.code === 'below-capture-failed' && e.retryable === false);
    assert.equal(resets, 0);
    producer.pipeline.leaseStreamBakery = async () => counting;
    producer.pipeline.returnStreamBakery = () => {};
    await assert.rejects(producer.produceRange({ key: 'E', project: projectOf() }, spec, { from: 0, to: 0 }), e => e.code === 'below-capture-failed' && e.retryable === false);
  } finally { await close(); }
});

test('BD-draw 要回放的依赖下层的流:推过去而不取图的每一拍都画一张丢掉(稀疏分段里第一帧以外的帧、断租约以后回放的帧),不进编码器;不回放的流不画', { skip: !ffmpegOk }, async () => {
  const { producer, specs, stateOf, run, close } = await producerFor(projectOf({ media: true }));
  try {
    const spec = specs.find(s => s.kind === 'below');
    assert.equal(spec.replay, true, '下层是 motion 式的卡:要回放');
    const state = stateOf(spec);
    const bakery = fakeBakery();
    // 画过一张丢掉的帧。换截图矩形时 `bakeStream` 自己也会画一张(在推第一帧之前,帧号还是上一趟留下的),不算:从这一趟推的第一帧之后数
    const draws = from => { const ops = bakery.log.slice(from); const first = ops.findIndex(op => op.startsWith('step:')); return ops.slice(Math.max(0, first)).filter(op => op.startsWith('draw:')).map(op => Number(op.split(':')[1])); };
    const hides = from => bakery.log.slice(from).filter(op => op.startsWith('hide:')).map(op => Number(op.split(':')[1]));
    // 稀疏:第 0、1 段。每段只取第一帧,其余 14 帧各画一张丢掉
    let mark = bakery.log.length;
    await run(bakery, state, 0, SPARSE_STRIDE);
    await run(bakery, state, 1, SPARSE_STRIDE);
    assert.deepEqual(hides(mark), [0, 15], '取图的只有两个分段的第一帧');
    assert.deepEqual(draws(mark), [...Array.from({ length: 14 }, (_, i) => 1 + i), ...Array.from({ length: 14 }, (_, i) => 16 + i)], '别的帧各画一张');
    assert.deepEqual([state.manifest.segments[0].samples, state.manifest.segments[1].samples], [15, 15], '丢掉的那些不进分段:样本数照旧');
    // 满密度、接着租约:每一帧都是要取的,一张都不用丢
    for (const n of [0, 1]) delete state.manifest.segments[n];
    bakery.streamLease = null;
    mark = bakery.log.length;
    await run(bakery, state, 0, 1);
    await run(bakery, state, 1, 1);
    assert.equal(hides(mark).length, 30);
    // 满密度、断了租约单独产第 2 段:从挂载帧回放到第 29 帧,每一拍画一张;第 30 帧起才取图
    bakery.streamLease = null;
    mark = bakery.log.length;
    const before = state.replayedFrames ?? 0;
    await run(bakery, state, 2, 1);
    assert.deepEqual(draws(mark), Array.from({ length: 30 - spec.mountFrame }, (_, i) => spec.mountFrame + i), '回放的每一帧都画过,第 30 帧起不再丢');
    assert.deepEqual(hides(mark), Array.from({ length: 15 }, (_, i) => 30 + i));
    assert.equal(state.manifest.segments[2].samples, 15);
    assert.equal((state.replayedFrames ?? 0) - before, 30 - spec.mountFrame, '回放的帧数照旧记(丢掉的那些不算取了的帧)');
    assert.ok(bakery.log.slice(mark).filter(op => op.startsWith('media:')).every(op => Number(op.split(':')[1]) >= 30), '素材只在真要取的帧前面等');
    assert.equal(producer.status().streams[0].capture.discarded, 28 + 30 - spec.mountFrame);
  } finally { await close(); }
});

test('BD-card 单卡流走的路不变:每帧只截一张、不藏任何东西、不等素材、截图矩形照旧是它自己的矩形', { skip: !ffmpegOk }, async () => {
  const { producer, specs, stateOf, run, close } = await producerFor(projectOf({ media: true }));
  try {
    const spec = specs.find(s => s.kind === 'card');
    assert.deepEqual(spec.clipIds, ['low']);
    const state = stateOf(spec);
    const bakery = fakeBakery();
    await run(bakery, state, 0, 1);
    assert.equal(bakery.log.filter(op => /^(hide|show|media):/.test(op)).length, 0);
    assert.equal(bakery.log.filter(op => op.startsWith('shot:')).length, 16, '第一帧先丢一张,之后每帧一张');
    assert.equal(producer.status().streams.find(s => s.kind === 'card').below, null);
    // 开关关着:计划里没有依赖下层的流
    const off = await producerFor(projectOf({ media: true }), { below: false });
    assert.deepEqual(off.specs.map(s => s.kind), ['card']);
    await off.close();
  } finally { await close(); }
});

/* ------------------------------------------------------------ 键 */

test('BD-keys BELOW_STREAM_VERSION 是 2;capture-below.mjs 进截图代码的指纹(流的 codeVersion),不进生成快照的代码指纹', async () => {
  assert.equal(BELOW_STREAM_VERSION, 2);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-frame-code-below-'));
  try {
    const file = 'server/bakery/capture-below.mjs';
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), 'a');
    const capture0 = captureCode(root), snapshot0 = snapshotCode(root);
    fsSync.writeFileSync(path.join(root, file), 'b');
    invalidateFrameCode(root);
    assert.notEqual(captureCode(root), capture0, '改了它,流的代码指纹跟着变');
    assert.equal(snapshotCode(root), snapshot0, '生成快照的代码指纹不变');
  } finally { invalidateFrameCode(root); await fs.rm(root, { recursive: true, force: true }); }
});

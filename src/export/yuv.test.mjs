/**
 * RGBA → I420(BT.601 有限范围):和 ffmpeg 的 `-pix_fmt yuv420p` 同一个换算(`yuv.ts`)。
 * 跑:node --test src/export/yuv.test.mjs;有 ffmpeg 时另和 ffmpeg 的换算逐字节比(误差 ≤ 1)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rgbaToI420 } from './yuv.ts';

const solid = (w, h, [r, g, b]) => { const a = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) a.set([r, g, b, 255], i * 4); return a; };

test('YUV1 纯色:红、白、黑、灰的 Y/U/V 与 BT.601 有限范围的公式一致', () => {
  const at = (rgb) => { const o = rgbaToI420(solid(2, 2, rgb), 2, 2); return [o[0], o[4], o[5]]; };
  assert.deepEqual(at([255, 0, 0]), [81, 90, 240]);
  assert.deepEqual(at([255, 255, 255]), [235, 128, 128]);
  assert.deepEqual(at([0, 0, 0]), [16, 128, 128]);
  assert.deepEqual(at([128, 128, 128]), [126, 128, 128]);
});

test('YUV2 奇数宽高:色度平面按 ceil 算,边上按最后一个像素补;缓冲可复用', () => {
  const o = rgbaToI420(solid(3, 3, [0, 0, 255]), 3, 3);
  assert.equal(o.length, 9 + 4 + 4);
  const again = rgbaToI420(solid(3, 3, [0, 0, 255]), 3, 3, o);
  assert.equal(again, o, '够大的缓冲原样复用');
});

let ffmpeg = null;
try { ffmpeg = await (await import('../../server/bakery/ffmpeg.mjs')).findFfmpeg(); } catch { ffmpeg = null; }
test('YUV3 和 ffmpeg 的 rgba → yuv420p(缺省矩阵)逐字节比,误差 ≤ 1', { skip: ffmpeg ? false : '找不到 ffmpeg' }, () => {
  const w = 64, h = 32;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set([(x * 4) & 255, (y * 8) & 255, ((x + y) * 3) & 255, 255], (y * w + x) * 4);
  // 色度只比平坦的块:ffmpeg 的色度下采样滤波和 2×2 平均不同,这里比亮度全平面 + 纯色块的色度
  const r = spawnSync(ffmpeg, ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', '-', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], { input: Buffer.from(rgba), maxBuffer: 1 << 24 });
  assert.equal(r.status, 0, String(r.stderr));
  const ref = r.stdout;
  const mine = rgbaToI420(rgba, w, h);
  let worst = 0;
  for (let i = 0; i < w * h; i++) worst = Math.max(worst, Math.abs(ref[i] - mine[i]));
  assert.ok(worst <= 1, `亮度最大误差 ${worst}`);
  const flat = solid(16, 16, [200, 60, 30]);
  const r2 = spawnSync(ffmpeg, ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '16x16', '-i', '-', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], { input: Buffer.from(flat), maxBuffer: 1 << 20 });
  const m2 = rgbaToI420(flat, 16, 16);
  for (let i = 0; i < m2.length; i++) assert.ok(Math.abs(r2.stdout[i] - m2[i]) <= 1, `第 ${i} 个字节:ffmpeg ${r2.stdout[i]} / 这里 ${m2[i]}`);
});

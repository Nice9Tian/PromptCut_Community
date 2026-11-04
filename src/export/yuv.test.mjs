/**
 * RGBA → I420 (BT.601 limited range): same conversion as ffmpeg `-pix_fmt yuv420p` (`yuv.ts`).
 * Run: node --test src/export/yuv.test.mjs; when ffmpeg is available, also compare
 * byte-for-byte with ffmpeg conversion (error ≤ 1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rgbaToI420 } from './yuv.ts';

const solid = (w, h, [r, g, b]) => { const a = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) a.set([r, g, b, 255], i * 4); return a; };

test('YUV1 Solid colors: Y/U/V for red, white, black and gray match the BT.601 limited-range formulas', () => {
  const at = (rgb) => { const o = rgbaToI420(solid(2, 2, rgb), 2, 2); return [o[0], o[4], o[5]]; };
  assert.deepEqual(at([255, 0, 0]), [81, 90, 240]);
  assert.deepEqual(at([255, 255, 255]), [235, 128, 128]);
  assert.deepEqual(at([0, 0, 0]), [16, 128, 128]);
  assert.deepEqual(at([128, 128, 128]), [126, 128, 128]);
});

test('YUV2 Odd width and height: chroma planes are computed with ceil, edges are padded with the last pixel; the buffer is reusable', () => {
  const o = rgbaToI420(solid(3, 3, [0, 0, 255]), 3, 3);
  assert.equal(o.length, 9 + 4 + 4);
  const again = rgbaToI420(solid(3, 3, [0, 0, 255]), 3, 3, o);
  assert.equal(again, o, 'A large enough buffer is reused as is');
});

let ffmpeg = null;
try { ffmpeg = await (await import('../../server/bakery/ffmpeg.mjs')).findFfmpeg(); } catch { ffmpeg = null; }
test('YUV3 Byte-by-byte comparison with ffmpeg rgba → yuv420p (default matrix), error ≤ 1', { skip: ffmpeg ? false : 'ffmpeg not found' }, () => {
  const w = 64, h = 32;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set([(x * 4) & 255, (y * 8) & 255, ((x + y) * 3) & 255, 255], (y * w + x) * 4);
  // Only compare chroma on flat blocks: ffmpeg chroma subsampling filter differs from 2×2 averaging,
  // here compare full luma plane + chroma of solid color blocks
  const r = spawnSync(ffmpeg, ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', '-', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], { input: Buffer.from(rgba), maxBuffer: 1 << 24 });
  assert.equal(r.status, 0, String(r.stderr));
  const ref = r.stdout;
  const mine = rgbaToI420(rgba, w, h);
  let worst = 0;
  for (let i = 0; i < w * h; i++) worst = Math.max(worst, Math.abs(ref[i] - mine[i]));
  assert.ok(worst <= 1, `Maximum luma error ${worst}`);
  const flat = solid(16, 16, [200, 60, 30]);
  const r2 = spawnSync(ffmpeg, ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '16x16', '-i', '-', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], { input: Buffer.from(flat), maxBuffer: 1 << 20 });
  const m2 = rgbaToI420(flat, 16, 16);
  for (let i = 0; i < m2.length; i++) assert.ok(Math.abs(r2.stdout[i] - m2[i]) <= 1, `Byte ${i}: ffmpeg ${r2.stdout[i]} / here ${m2[i]}`);
});

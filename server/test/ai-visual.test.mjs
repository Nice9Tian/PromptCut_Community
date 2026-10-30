import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GIF_FRAMES,
  sampleTimes,
  stableStringify,
  specKey,
  newVisualId,
  isVisualId,
  safeFileName,
  formatValue,
  diffClips,
  saveImage,
  writeJson,
  readJson,
  gifPaths,
  encodeGif,
  findFfmpeg,
  contentCrop
} from '../ai-visual.mjs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PNG } from 'pngjs';

test('sampleTimes', () => {
  const times = sampleTimes({ start: 0, end: 8 });
  assert.equal(times.length, 8);
  assert.deepEqual(times, [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5]);
  
  assert.deepEqual(sampleTimes({ start: 2, end: 1 }), [2]);
  assert.deepEqual(sampleTimes({ start: 1, end: 1 }), [1]);
});

test('specKey', () => {
  const o1 = { project: { a: 1, b: 2 }, clipId: '123' };
  const o2 = { clipId: '123', project: { b: 2, a: 1 } };
  const k1 = specKey(o1.project, o1.clipId);
  const k2 = specKey(o2.project, o2.clipId);
  assert.equal(k1, k2);
  assert.equal(k1.length, 16);
  assert.match(k1, /^[0-9a-f]{16}$/);

  const k3 = specKey({ a: 1 }, '123');
  assert.notEqual(k1, k3);
});

test('isVisualId & safeFileName', () => {
  const id = newVisualId();
  assert.ok(isVisualId(id));
  assert.equal(isVisualId('x-abc123'), false);
  assert.equal(isVisualId('v-ABC123'), false);
  assert.equal(isVisualId('v-ab'), false);

  const validName = '0123456789abcdef0123456789abcdef.png';
  assert.equal(safeFileName(validName), validName);
  assert.equal(safeFileName('../x.png'), null);
  assert.equal(safeFileName('0123456789ABCDEF0123.png'), null);
  assert.equal(safeFileName('0123456789abcdef.exe'), null);
  assert.equal(safeFileName('0123456789abcdef.txt'), null);
});

test('formatValue', () => {
  assert.equal(formatValue(undefined), '(无)');
  assert.equal(formatValue(1.5), '1.5');
  assert.equal(formatValue(2), '2');
  assert.equal(formatValue(1.23456), '1.235');
  
  const longStr = 'a'.repeat(100);
  const formattedLong = formatValue(longStr);
  assert.equal(formattedLong.length, 81);
  assert.ok(formattedLong.endsWith('…'));

  const obj = { k: 'v' };
  assert.equal(formatValue(obj), '{"k":"v"}');
});

test('diffClips', () => {
  const before = {
    start: 0,
    end: 10,
    params: { a: 1, b: 2 },
    frame: { x: 100, y: 200 }
  };
  const after = {
    start: 5,
    end: 10,
    params: { a: 9, b: 3 },
    frame: { x: 150, y: 200 }
  };
  
  const diffs = diffClips(before, after);
  assert.deepEqual(diffs.map(d => d.key), ['start', 'params.a', 'params.b', 'frame.x']);
  assert.equal(diffs[0].from, '0');
  assert.equal(diffs[0].to, '5');
  assert.equal(diffs[1].from, '1');
  assert.equal(diffs[1].to, '9');
  assert.equal(diffs[2].from, '2');
  assert.equal(diffs[2].to, '3');
  assert.equal(diffs[3].from, '100');
  assert.equal(diffs[3].to, '150');

  assert.deepEqual(diffClips(before, before), []);
  assert.deepEqual(diffClips(null, after), []);

  const bParts = { ...before, parts: [{ id: 1 }] };
  const aParts = { ...before, parts: [{ id: 2 }] };
  const partsDiff = diffClips(bParts, aParts);
  assert.deepEqual(partsDiff, [{ key: 'parts', from: '(原部件)', to: '(改动了部件)' }]);
});

test('saveImage', async (t) => {
  const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ai-visual-test-'));
  t.after(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  const base64 = Buffer.from('hello').toString('base64');
  
  const res1 = await saveImage(tmpDir, { mime: 'image/jpeg', base64 });
  assert.ok(res1.name.endsWith('.jpg'));
  
  const res2 = await saveImage(tmpDir, { mime: 'image/jpeg', base64 });
  assert.equal(res1.name, res2.name);
  
  const files = await fsPromises.readdir(tmpDir);
  assert.equal(files.length, 1);

  const resWebp = await saveImage(tmpDir, { mime: 'image/webp', base64: Buffer.from('webp').toString('base64') });
  assert.ok(resWebp.name.endsWith('.webp'));
  
  const resUnknown = await saveImage(tmpDir, { mime: 'unknown/type', base64: Buffer.from('unknown').toString('base64') });
  assert.ok(resUnknown.name.endsWith('.png'));
});

test('writeJson & readJson', async (t) => {
  const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ai-visual-test-json-'));
  t.after(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  const data = { a: 1, b: "test" };
  await writeJson(tmpDir, 'test.json', data);
  const readBack = await readJson(tmpDir, 'test.json');
  assert.deepEqual(readBack, data);

  const notFound = await readJson(tmpDir, 'not-exist.json');
  assert.equal(notFound, null);
});

/** 透明底上画若干不透明矩形 [x0, y0, x1, y1](含端点) */
function framePng(W, H, rects, opaque = false) {
  const png = new PNG({ width: W, height: H });
  png.data.fill(0);
  if (opaque) for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  for (const [x0, y0, x1, y1] of rects) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) png.data[((W * y + x) << 2) + 3] = 255;
  }
  return PNG.sync.write(png);
}

test('contentCrop:取 8 帧里出现过区域的并集,留边、按舞台比例、不小于 1/4 宽、不出界', async () => {
  const W = 384, H = 216;
  // 进场从左边飞到右边:两帧的位置都得框进去
  const crop = await contentCrop([framePng(W, H, [[40, 90, 60, 110]]), framePng(W, H, [[150, 95, 170, 115]])]);
  assert.ok(crop);
  assert.ok(crop.x <= 40 && crop.x + crop.w >= 171, `横向要框住 40..170:${JSON.stringify(crop)}`);
  assert.ok(crop.y <= 90 && crop.y + crop.h >= 116, `纵向要框住 90..115:${JSON.stringify(crop)}`);
  assert.ok(Math.abs(crop.w / crop.h - W / H) < 0.05, '比例和舞台一样');
  assert.ok(crop.w >= W / 4, '不小于 1/4 宽');
  assert.ok(crop.x >= 0 && crop.y >= 0 && crop.x + crop.w <= W && crop.y + crop.h <= H, '不出界');

  // 很小的一块:按最小宽度放大裁框,贴边时往里挪而不是出界
  const tiny = await contentCrop([framePng(W, H, [[0, 0, 3, 3]])]);
  assert.deepEqual([tiny.x, tiny.y, tiny.w >= W / 4], [0, 0, true]);
});

test('contentCrop:全透明、整屏不透明、几乎整屏 —— 都不裁', async () => {
  const W = 384, H = 216;
  assert.equal(await contentCrop([framePng(W, H, [])]), null);
  assert.equal(await contentCrop([framePng(W, H, [], true)]), null);
  assert.equal(await contentCrop([framePng(W, H, [[2, 2, W - 3, H - 3]])]), null);
});

test('encodeGif', async (t) => {
  const ff = findFfmpeg();
  if (!ff) {
    t.skip('没有 ffmpeg');
    return;
  }

  const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ai-visual-test-gif-'));
  t.after(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  const frames = [];
  for (let i = 0; i < 8; i++) {
    const png = new PNG({ width: 64, height: 36 });
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        const idx = (png.width * y + x) << 2;
        png.data[idx] = i * 30;                 // R
        png.data[idx + 1] = 255 - i * 30;       // G
        png.data[idx + 2] = (i * 70) % 256;     // B
        png.data[idx + 3] = 255;                // A
      }
    }
    frames.push(PNG.sync.write(png));
  }

  const outGif = path.join(tmpDir, 'out.gif');
  const outGrid = path.join(tmpDir, 'out-grid.png');

  const res = await encodeGif({ ffmpeg: ff, frames, outGif, outGrid, width: 64, fps: 4 });
  assert.equal(res.gif, outGif);
  assert.equal(res.grid, outGrid);

  const gifBuffer = await fsPromises.readFile(outGif);
  assert.equal(gifBuffer.toString('utf8', 0, 4), 'GIF8');

  const gridBuffer = await fsPromises.readFile(outGrid);
  const gridPng = PNG.sync.read(gridBuffer);
  assert.ok(gridPng.width > 0);
}, { timeout: 60000 });

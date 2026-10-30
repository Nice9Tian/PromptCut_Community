// 预览视频的像素活挪到 worker 线程(`server/bakery/frame-video.mjs`,`docs/archive/agent-reports/AGENT-uc-latency.md`):结果与主线程上做的逐字节相同
import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { createConverter } from '../bakery/frame-video.mjs';
import { opaqueFrame } from '../bakery/frame-video-worker.mjs';

/** 一张带透明、半透明与不透明像素的 PNG */
function samplePng(width, height, seed) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) << 2;
      png.data[i] = (x * 7 + seed) & 255;
      png.data[i + 1] = (y * 5 + seed * 3) & 255;
      png.data[i + 2] = (x + y + seed) & 255;
      png.data[i + 3] = x < width / 3 ? 0 : x < (2 * width) / 3 ? 128 : 255;
    }
  }
  return PNG.sync.write(png);
}

test('FV1 worker 线程压出来的帧与主线程上的 opaqueFrame 逐字节相同,多帧按顺序回', async () => {
  const converter = createConverter();
  try {
    const frames = [samplePng(96, 54, 1), samplePng(96, 54, 2), samplePng(40, 40, 3)];
    const out = await Promise.all(frames.map((f) => converter.convert(f)));
    for (let i = 0; i < frames.length; i++) {
      assert.ok(Buffer.isBuffer(out[i]));
      assert.deepEqual(out[i], opaqueFrame(frames[i]), `第 ${i} 帧`);
      const back = PNG.sync.read(out[i]);
      for (let p = 3; p < back.data.length; p += 4) assert.equal(back.data[p], 255, '压完不透明');
    }
    // 调用方的 Buffer 没被转交走,之后还能用
    assert.ok(frames[0].length > 0 && PNG.sync.read(frames[0]).width === 96);
  } finally {
    await converter.close();
  }
});

test('FV2 关掉之后再转退回主线程,结果不变', async () => {
  const converter = createConverter();
  const frame = samplePng(32, 18, 9);
  const first = await converter.convert(frame);
  await converter.close();
  const again = await converter.convert(frame);
  assert.deepEqual(again, first);
});

test('FV3 直接 import 时找得到 worker 脚本,真在 worker 线程里做', async () => {
  const converter = createConverter();
  try {
    await converter.convert(samplePng(16, 9, 4));
    assert.equal(converter.mode, 'worker');
  } finally {
    await converter.close();
  }
});

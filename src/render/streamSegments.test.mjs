import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STREAM_SEGMENT_FRAMES, isStreamOrigin, streamSegmentOf, streamSegmentFirstFrame, streamSegmentLastFrame, streamSegmentFrameCount,
  streamSampleOf, streamSegmentSpan,
} from './streamSegments.mjs';
import { STREAM_SEGMENT_FRAMES as FFMPEG_SEGMENT_FRAMES } from '../../server/bakery/ffmpeg.mjs';
import { STREAM_SEGMENT } from '../../server/frame-playback.mjs';
import { SEGMENT_FRAMES as PRODUCER_SEGMENT_FRAMES } from '../../server/frame-stream.mjs';

test('分段的帧数只有一个数:编码器(ffmpeg.mjs)、生产者、排程用的都是它', () => {
  assert.equal(STREAM_SEGMENT_FRAMES, 15);
  assert.equal(FFMPEG_SEGMENT_FRAMES, STREAM_SEGMENT_FRAMES, 'server/bakery/ffmpeg.mjs 的 GOP 长度要和分段的帧数一致');
  assert.equal(STREAM_SEGMENT, STREAM_SEGMENT_FRAMES);
  assert.equal(PRODUCER_SEGMENT_FRAMES, STREAM_SEGMENT_FRAMES);
});

test('分段从这条流自己的第一帧起数:片段从第 100 帧开始,第 0 段是 100～114,第 1 段是 115～129', () => {
  const origin = 100;
  assert.equal(streamSegmentOf(100, origin), 0);
  assert.equal(streamSegmentOf(114, origin), 0);
  assert.equal(streamSegmentOf(115, origin), 1);
  assert.equal(streamSegmentOf(129, origin), 1);
  assert.equal(streamSegmentOf(130, origin), 2);
  assert.equal(streamSegmentFirstFrame(0, origin), 100);
  assert.equal(streamSegmentFirstFrame(1, origin), 115);
  assert.equal(streamSegmentLastFrame(0, origin), 114);
  assert.equal(streamSampleOf(100, origin), 0);
  assert.equal(streamSampleOf(114, origin), 14);
  assert.equal(streamSampleOf(115, origin), 0);
  assert.equal(streamSampleOf(122, origin), 7);
  // 第一帧是 0 的流和原来按项目帧号分段是同一回事
  for (const f of [0, 1, 14, 15, 29, 30, 449]) {
    assert.equal(streamSegmentOf(f, 0), Math.floor(f / 15));
    assert.equal(streamSampleOf(f, 0), f % 15);
  }
});

test('早于第一帧的帧没有分段(负数),不会落进第 0 段', () => {
  assert.equal(streamSegmentOf(99, 100), -1);
  assert.equal(streamSegmentOf(85, 100), -1);
  assert.equal(streamSegmentOf(84, 100), -2);
  assert.equal(streamSegmentOf(0, 100), -7);
  // 负数段里样本序号照样落在 0..14
  assert.equal(streamSampleOf(99, 100), 14);
  assert.equal(streamSampleOf(85, 100), 0);
});

test('每一帧恰好落在一个分段的一个样本上,来回换算对得上(逐帧核对)', () => {
  for (const origin of [0, 1, 7, 15, 100, 101, 449]) {
    const last = origin + 73;
    const { firstSegment, lastSegment } = streamSegmentSpan(origin, last);
    assert.equal(firstSegment, 0);
    let covered = 0;
    for (let n = firstSegment; n <= lastSegment; n++) {
      const from = streamSegmentFirstFrame(n, origin), to = streamSegmentLastFrame(n, origin, last);
      assert.equal(streamSegmentFrameCount(n, origin, last), to - from + 1);
      for (let f = from; f <= to; f++) {
        assert.equal(streamSegmentOf(f, origin), n, `第 ${f} 帧(第一帧 ${origin})`);
        assert.equal(streamSampleOf(f, origin), f - from);
        covered++;
      }
    }
    assert.equal(covered, last - origin + 1, '从第一帧到最后一帧每一帧都有、只有一次');
  }
});

test('末段到这条流自己的最后一帧为止,可以不满 15 帧;时长正好是 15 的倍数时末段是满的', () => {
  // 100～149:50 帧 → 4 段,末段 5 帧
  assert.deepEqual(streamSegmentSpan(100, 149), { originFrame: 100, firstSegment: 0, lastSegment: 3 });
  assert.equal(streamSegmentLastFrame(3, 100, 149), 149);
  assert.equal(streamSegmentFrameCount(3, 100, 149), 5);
  assert.equal(streamSegmentFrameCount(2, 100, 149), 15);
  assert.equal(streamSegmentFrameCount(4, 100, 149), 0, '整段都在最后一帧之后:没有这一段');
  // 100～144:45 帧 → 3 段,都是满的
  assert.deepEqual(streamSegmentSpan(100, 144), { originFrame: 100, firstSegment: 0, lastSegment: 2 });
  assert.equal(streamSegmentFrameCount(2, 100, 144), 15);
  // 只有一帧的流
  assert.deepEqual(streamSegmentSpan(100, 100), { originFrame: 100, firstSegment: 0, lastSegment: 0 });
  assert.equal(streamSegmentFrameCount(0, 100, 100), 1);
});

test('分段号和每段几帧只看这条流有多少帧,和它摆在时间轴的哪里无关(给「挪动以后流不失效」留的口子)', () => {
  const shape = (origin, frames) => {
    const last = origin + frames - 1;
    const { lastSegment } = streamSegmentSpan(origin, last);
    return Array.from({ length: lastSegment + 1 }, (_, n) => streamSegmentFrameCount(n, origin, last));
  };
  for (const frames of [1, 14, 15, 16, 50, 90]) {
    const base = shape(0, frames);
    for (const origin of [1, 7, 15, 100, 12345]) assert.deepEqual(shape(origin, frames), base, `${frames} 帧的流摆在第 ${origin} 帧`);
  }
});

test('isStreamOrigin:只认非负整数', () => {
  for (const ok of [0, 1, 100]) assert.equal(isStreamOrigin(ok), true);
  for (const bad of [-1, 1.5, NaN, '100', null, undefined, {}]) assert.equal(isStreamOrigin(bad), false);
});

test('守门:分段帧数这个 15 只许在 streamSegments.mjs 定义(编码器的 GOP 长度在 bakery/ffmpeg.mjs 另有一份,上面核过同值);别处要用就 import', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const hits = [];
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.name === 'node_modules' || item.name === 'test' || item.name === 'catalog') continue;
      const file = path.join(dir, item.name);
      if (item.isDirectory()) { walk(file); continue; }
      if (!/\.(mjs|ts|tsx)$/.test(item.name) || /\.test\.|\.d\.mts$/.test(item.name)) continue;
      const text = fs.readFileSync(file, 'utf8');
      // 「某个名字里带 SEGMENT / STRIDE 的常量 = 15」
      if (/\b(?:const|let|var)\s+[A-Z_]*(?:SEGMENT|STRIDE)[A-Z_]*\s*=\s*15\b/.test(text)) hits.push(path.relative(ROOT, file).replaceAll('\\', '/'));
    }
  };
  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'server'));
  // A3 之后闭源的那几摊在 cloud/ 下（公开仓库里没有这个目录）；这道检查原来就管着它们，搬走以后也要接着管
  for (const d of ['cloud/src', 'cloud/server']) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  assert.deepEqual(hits.sort(), ['server/bakery/ffmpeg.mjs', 'src/render/streamSegments.mjs']);
  // 已经删掉的快照网格不该再回来
  assert.equal(fs.existsSync(path.join(ROOT, 'src/render/snapshotGrid.mjs')), false);
});

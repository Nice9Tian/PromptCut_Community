import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STREAM_SEGMENT_FRAMES, isStreamOrigin, streamSegmentOf, streamSegmentFirstFrame, streamSegmentLastFrame, streamSegmentFrameCount,
  streamSampleOf, streamSegmentSpan,
} from './streamSegments.mjs';
import { STREAM_SEGMENT_FRAMES as FFMPEG_SEGMENT_FRAMES } from '../../server/bakery/ffmpeg.mjs';
import { STREAM_SEGMENT } from '../../server/frame-playback.mjs';
import { SEGMENT_FRAMES as PRODUCER_SEGMENT_FRAMES } from '../../server/frame-stream.mjs';

test('the segment frame count is a single number: the encoder (ffmpeg.mjs), the producer and the scheduler all use it', () => {
  assert.equal(STREAM_SEGMENT_FRAMES, 15);
  assert.equal(FFMPEG_SEGMENT_FRAMES, STREAM_SEGMENT_FRAMES, 'the GOP length in server/bakery/ffmpeg.mjs must match the segment frame count');
  assert.equal(STREAM_SEGMENT, STREAM_SEGMENT_FRAMES);
  assert.equal(PRODUCER_SEGMENT_FRAMES, STREAM_SEGMENT_FRAMES);
});

test('segments are counted from this stream\'s own first frame: if the clip starts at frame 100, segment 0 is 100-114 and segment 1 is 115-129', () => {
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
  // A stream whose first frame is 0 is the same as the original segmentation by project frame number
  for (const f of [0, 1, 14, 15, 29, 30, 449]) {
    assert.equal(streamSegmentOf(f, 0), Math.floor(f / 15));
    assert.equal(streamSampleOf(f, 0), f % 15);
  }
});

test('a frame before the first frame has no segment (negative) and does not fall into segment 0', () => {
  assert.equal(streamSegmentOf(99, 100), -1);
  assert.equal(streamSegmentOf(85, 100), -1);
  assert.equal(streamSegmentOf(84, 100), -2);
  assert.equal(streamSegmentOf(0, 100), -7);
  // Sample indices in negative segments still fall in 0..14
  assert.equal(streamSampleOf(99, 100), 14);
  assert.equal(streamSampleOf(85, 100), 0);
});

test('each frame lands on exactly one sample of one segment, and converting back and forth matches (checked frame by frame)', () => {
  for (const origin of [0, 1, 7, 15, 100, 101, 449]) {
    const last = origin + 73;
    const { firstSegment, lastSegment } = streamSegmentSpan(origin, last);
    assert.equal(firstSegment, 0);
    let covered = 0;
    for (let n = firstSegment; n <= lastSegment; n++) {
      const from = streamSegmentFirstFrame(n, origin), to = streamSegmentLastFrame(n, origin, last);
      assert.equal(streamSegmentFrameCount(n, origin, last), to - from + 1);
      for (let f = from; f <= to; f++) {
        assert.equal(streamSegmentOf(f, origin), n, `frame ${f} (first frame ${origin})`);
        assert.equal(streamSampleOf(f, origin), f - from);
        covered++;
      }
    }
    assert.equal(covered, last - origin + 1, 'every frame from the first to the last is present, exactly once');
  }
});

test('the last segment ends at this stream\'s own last frame and may have fewer than 15 frames; when the duration is an exact multiple of 15, the last segment is full', () => {
  // 100~149: 50 frames → 4 segments, last segment 5 frames
  assert.deepEqual(streamSegmentSpan(100, 149), { originFrame: 100, firstSegment: 0, lastSegment: 3 });
  assert.equal(streamSegmentLastFrame(3, 100, 149), 149);
  assert.equal(streamSegmentFrameCount(3, 100, 149), 5);
  assert.equal(streamSegmentFrameCount(2, 100, 149), 15);
  assert.equal(streamSegmentFrameCount(4, 100, 149), 0, 'the whole segment is after the last frame: there is no such segment');
  // 100~144: 45 frames → 3 segments, all full
  assert.deepEqual(streamSegmentSpan(100, 144), { originFrame: 100, firstSegment: 0, lastSegment: 2 });
  assert.equal(streamSegmentFrameCount(2, 100, 144), 15);
  // Stream with only one frame
  assert.deepEqual(streamSegmentSpan(100, 100), { originFrame: 100, firstSegment: 0, lastSegment: 0 });
  assert.equal(streamSegmentFrameCount(0, 100, 100), 1);
});

test('segment index and frames per segment depend only on how many frames the stream has, not on where it sits on the timeline (leaves room for "stream stays valid after moving")', () => {
  const shape = (origin, frames) => {
    const last = origin + frames - 1;
    const { lastSegment } = streamSegmentSpan(origin, last);
    return Array.from({ length: lastSegment + 1 }, (_, n) => streamSegmentFrameCount(n, origin, last));
  };
  for (const frames of [1, 14, 15, 16, 50, 90]) {
    const base = shape(0, frames);
    for (const origin of [1, 7, 15, 100, 12345]) assert.deepEqual(shape(origin, frames), base, `stream of ${frames} frames placed at frame ${origin}`);
  }
});

test('isStreamOrigin: accepts only non-negative integers', () => {
  for (const ok of [0, 1, 100]) assert.equal(isStreamOrigin(ok), true);
  for (const bad of [-1, 1.5, NaN, '100', null, undefined, {}]) assert.equal(isStreamOrigin(bad), false);
});

test('gatekeeper: the segment frame count 15 may be defined only in streamSegments.mjs (the encoder\'s GOP length has its own copy in bakery/ffmpeg.mjs, checked above to be the same value); elsewhere, import it', async () => {
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
      // "A constant with SEGMENT / STRIDE in its name = 15"
      if (/\b(?:const|let|var)\s+[A-Z_]*(?:SEGMENT|STRIDE)[A-Z_]*\s*=\s*15\b/.test(text)) hits.push(path.relative(ROOT, file).replaceAll('\\', '/'));
    }
  };
  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'server'));
  // After A3, the closed-source parts live under cloud/ (this directory does not exist in the public
  // repository); this check originally guarded them, and must continue guarding them after the move
  for (const d of ['cloud/src', 'cloud/server']) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  assert.deepEqual(hits.sort(), ['server/bakery/ffmpeg.mjs', 'src/render/streamSegments.mjs']);
  // Deleted snapshot grids should not return
  assert.equal(fs.existsSync(path.join(ROOT, 'src/render/snapshotGrid.mjs')), false);
});

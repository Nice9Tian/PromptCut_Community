/**
 * Unit tests for track stream segment muxing. Run: node --test src/render/streamMux.test.mjs
 *
 * Three things:
 *   1. Muxed initialization segments and media segments can be read back by page-side demuxing
 *      (`streamPlayer.ts`), with byte-for-byte identical samples;
 *   2. Functions used by server to verify segments (`server/frame-stream.mjs`) also accept them;
 *   3. Create real H.264 using ffmpeg; after muxing, ffprobe can read it and frame count matches
 *      (machines without ffmpeg skip and report reason).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildStreamInit, buildStreamSegment, codecOfAvcC, SAMPLE_FLAGS_SYNC, SAMPLE_FLAGS_NON_SYNC } from './streamMux.ts';
import { parseInit, parseSegment, SEGMENT_FRAMES } from './streamPlayer.ts';
import { splitFmp4, initInfo, segmentInfo, topLevelBoxes } from '../../server/frame-stream.mjs';
import { STREAM_SEGMENT_FRAMES } from '../../server/bakery/ffmpeg.mjs';

const AVCC = Uint8Array.from([1, 0x64, 0x00, 0x32, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x32, 0x01, 0x00, 0x03, 0x68, 0xee, 0x3c]);
const sample = (n, fill) => { const d = new Uint8Array(n); d.fill(fill); new DataView(d.buffer).setUint32(0, n - 4); return d; };
const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

test('segment frame count: the page, the server and the muxer use the same number', () => {
  assert.equal(SEGMENT_FRAMES, 15);
  assert.equal(STREAM_SEGMENT_FRAMES, SEGMENT_FRAMES);
});

test('init segment: the page side can read back the codec string, parameter sets, and width and height', () => {
  const init = buildStreamInit({ width: 1920, height: 2176, fps: 30, avcC: AVCC });
  const got = parseInit(ab(init));
  assert.equal(got.codec, 'avc1.640032');
  assert.equal(got.codec, codecOfAvcC(AVCC));
  assert.deepEqual([...got.description], [...AVCC]);
  assert.equal(got.width, 1920);
  assert.equal(got.height, 2176);
  assert.deepEqual(topLevelBoxes(Buffer.from(init)).map((b) => b.type), ['ftyp', 'moov']);
});

test('init segment: the server can read the codec string, width and height, and timescale (= fps)', () => {
  const info = initInfo(Buffer.from(buildStreamInit({ width: 704, height: 864, fps: 25, avcC: AVCC })));
  assert.deepEqual(info, { codec: 'avc1.640032', width: 704, height: 864, timescale: 25 });
});

test('segment: samples read back on the page side are byte-identical to the input, and keyframes are flagged correctly', () => {
  const samples = Array.from({ length: SEGMENT_FRAMES }, (_, i) => ({ data: sample(40 + i * 7, i + 1), isSync: i === 0 }));
  const seg = buildStreamSegment({ sequence: 3, baseDecodeTime: 2 * SEGMENT_FRAMES, samples });
  const table = parseSegment(ab(seg));
  assert.equal(table.length, SEGMENT_FRAMES);
  table.forEach((s, i) => {
    assert.equal(s.size, samples[i].data.length, `size of sample ${i}`);
    assert.equal(s.isSync, i === 0, `whether sample ${i} is a keyframe`);
    assert.deepEqual([...seg.subarray(s.offset, s.offset + s.size)], [...samples[i].data], `bytes of sample ${i}`);
  });
  assert.deepEqual(topLevelBoxes(Buffer.from(seg)).map((b) => b.type), ['moof', 'mdat']);
});

test('segment: the server\'s validation function accepts it (one moof, correct sample count, segment starts with a keyframe)', () => {
  const samples = Array.from({ length: 7 }, (_, i) => ({ data: sample(30 + i, 9), isSync: i === 0 }));
  assert.deepEqual(segmentInfo(Buffer.from(buildStreamSegment({ sequence: 1, baseDecodeTime: 0, samples }))), { moofs: 1, sampleCount: 7, firstSampleIsSync: true });
});

test('an init segment plus several segments concatenated: the server\'s split function splits them back to the original', () => {
  const init = buildStreamInit({ width: 320, height: 656, fps: 30, avcC: AVCC });
  const segs = [0, 1, 2].map((n) => buildStreamSegment({ sequence: n + 1, baseDecodeTime: n * SEGMENT_FRAMES, samples: Array.from({ length: SEGMENT_FRAMES }, (_, i) => ({ data: sample(20 + n + i, n + 1), isSync: i === 0 })) }));
  const whole = Buffer.concat([Buffer.from(init), ...segs.map((s) => Buffer.from(s))]);
  const split = splitFmp4(whole);
  assert.deepEqual([...split.init], [...init]);
  assert.equal(split.segments.length, 3);
  split.segments.forEach((s, n) => assert.deepEqual([...s], [...segs[n]]));
  assert.deepEqual(split.dropped, []);
});

test('the two sample flag values: keyframes do not carry the "non-sync" bit, the rest do', () => {
  assert.equal(SAMPLE_FLAGS_SYNC & 0x00010000, 0);
  assert.notEqual(SAMPLE_FLAGS_NON_SYNC & 0x00010000, 0);
});

test('rejected: segment not starting with a keyframe, empty segment, empty sample, bad avcC, odd width and height', () => {
  const ok = { data: sample(16, 1), isSync: true };
  assert.throws(() => buildStreamSegment({ sequence: 1, baseDecodeTime: 0, samples: [{ ...ok, isSync: false }] }), /keyframe/);
  assert.throws(() => buildStreamSegment({ sequence: 1, baseDecodeTime: 0, samples: [] }), /no samples/);
  assert.throws(() => buildStreamSegment({ sequence: 1, baseDecodeTime: 0, samples: [ok, { data: new Uint8Array(0), isSync: false }] }), /empty/);
  assert.throws(() => buildStreamSegment({ sequence: 0, baseDecodeTime: 0, samples: [ok] }), /sequence/);
  assert.throws(() => buildStreamSegment({ sequence: 1, baseDecodeTime: -1, samples: [ok] }), /baseDecodeTime/);
  assert.throws(() => buildStreamInit({ width: 320, height: 656, fps: 30, avcC: new Uint8Array([0, 1, 2]) }), /avcC/);
  assert.throws(() => buildStreamInit({ width: 0, height: 656, fps: 30, avcC: AVCC }), /width/);
  assert.throws(() => buildStreamInit({ width: 70000, height: 656, fps: 30, avcC: AVCC }), /width\/height/);
});

/* ---------------------------------------------------------------- Real H.264: created with ffmpeg, read with ffprobe */

let ffmpeg = null;
try { ffmpeg = await (await import('../../server/bakery/ffmpeg.mjs')).findFfmpeg(); } catch { ffmpeg = null; }
const ffprobe = ffmpeg ? ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe')) : null;
const skip = ffmpeg && ffprobe && spawnSync(ffprobe, ['-version'], { windowsHide: true }).status === 0 ? false : 'ffmpeg / ffprobe not found on this machine';

/** Annex B (start code delimited) → NAL units */
function nalUnits(buf) {
  const starts = [];
  for (let i = 0; i + 3 <= buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) { starts.push({ at: i + 3, code: i > 0 && buf[i - 1] === 0 ? i - 1 : i }); i += 2; }
  }
  return starts.map((s, k) => buf.subarray(s.at, k + 1 < starts.length ? starts[k + 1].code : buf.length));
}

test('real H.264: two segments of 15 frames each, after muxing ffprobe reads 30 frames with the right width, height and codec', { skip }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-streammux-'));
  try {
    const W = 320, H = 2 * 160 + 16, FPS = 30, FRAMES = 2 * SEGMENT_FRAMES;
    const raw = path.join(tmp, 'a.h264');
    const made = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=${W}x${H}:rate=${FPS}`, '-frames:v', String(FRAMES),
      '-c:v', 'libx264', '-preset', 'veryfast', '-g', String(SEGMENT_FRAMES), '-keyint_min', String(SEGMENT_FRAMES), '-sc_threshold', '0', '-bf', '0',
      '-x264-params', 'aud=1', '-pix_fmt', 'yuv420p', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', raw], { windowsHide: true });
    assert.equal(made.status, 0, String(made.stderr));

    // Split frames by Access Unit Delimiter (type 9); extract parameter sets (7, 8) to construct
    // avcC, keep only picture data in samples, convert to length-prefixed
    let sps = null, pps = null;
    const frames = [];
    let cur = null;
    for (const nal of nalUnits(fs.readFileSync(raw))) {
      const type = nal[0] & 0x1f;
      if (type === 9) { if (cur) frames.push(cur); cur = { nals: [], key: false }; continue; }
      if (type === 7) { sps ??= nal; continue; }
      if (type === 8) { pps ??= nal; continue; }
      if (type === 6) continue;
      if (!cur) cur = { nals: [], key: false };
      if (type === 5) cur.key = true;
      cur.nals.push(nal);
    }
    if (cur) frames.push(cur);
    assert.equal(frames.length, FRAMES, 'number of frames extracted');
    assert.ok(sps && pps, 'the bitstream contains parameter sets');
    const avcC = Uint8Array.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 0xff, ...sps, 1, pps.length >> 8, pps.length & 0xff, ...pps]);
    const toSample = (f) => {
      const data = new Uint8Array(f.nals.reduce((s, n) => s + 4 + n.length, 0));
      let o = 0;
      for (const n of f.nals) { new DataView(data.buffer).setUint32(o, n.length); data.set(n, o + 4); o += 4 + n.length; }
      return { data, isSync: f.key };
    };

    const init = buildStreamInit({ width: W, height: H, fps: FPS, avcC });
    const segs = [0, 1].map((n) => buildStreamSegment({ sequence: n + 1, baseDecodeTime: n * SEGMENT_FRAMES, samples: frames.slice(n * SEGMENT_FRAMES, (n + 1) * SEGMENT_FRAMES).map(toSample) }));
    const file = path.join(tmp, 'out.mp4');
    fs.writeFileSync(file, Buffer.concat([Buffer.from(init), ...segs.map((s) => Buffer.from(s))]));

    const probe = spawnSync(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,nb_read_frames,r_frame_rate', '-of', 'json', file], { encoding: 'utf8', windowsHide: true });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stderr.trim(), '', 'ffprobe reported no errors');
    const stream = JSON.parse(probe.stdout).streams[0];
    assert.equal(stream.codec_name, 'h264');
    assert.equal(stream.width, W);
    assert.equal(stream.height, H);
    assert.equal(Number(stream.nb_read_frames), FRAMES);
    assert.equal(stream.r_frame_rate, `${FPS}/1`);

    // A single segment paired with initialization segment can also be decoded (player fetches segment by segment)
    const one = path.join(tmp, 'one.mp4');
    fs.writeFileSync(one, Buffer.concat([Buffer.from(init), Buffer.from(segs[1])]));
    const p2 = spawnSync(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', one], { encoding: 'utf8', windowsHide: true });
    assert.equal(p2.status, 0, p2.stderr);
    assert.equal(Number(p2.stdout.trim().replace(/,$/, '')), SEGMENT_FRAMES);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

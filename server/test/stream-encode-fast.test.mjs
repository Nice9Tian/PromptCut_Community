/**
 * Unit test for track stream segment encoding speedup (`docs/archive/agent-reports/AGENT-perf-encode.md`):
 *   - YUV fed to encoder from new filterchain is byte-for-byte identical to legacy code
 *     (`streamFilterIdentity`) (two tails: yuv420p, nv12);
 *   - Encoding parameter hash in segment signature unchanged (existing segments on disk not invalidated);
 *   - Judgment of `endsWithCompleteMfra`;
 *   - Pre-spawned encoding processes: replenished after claim, output is byte-for-byte identical
 *     to on-demand spawned processes, `finish()` yields bytes upon seeing mfra; ffmpeg errors reported
 *     as usual; no processes remain when switch is turned off;
 *   - fMP4 encoded by full command line (no packet buffering at input + new filterchain) is byte-for-byte
 *     identical to pre-rewrite command line; starts immediately once frames arrive
 *     (`docs/archive/agent-reports/AGENT-perf-encode-2.md`).
 * Cases requiring ffmpeg are skipped on machines without ffmpeg.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { PNG } from 'pngjs';
import {
  streamFilter, streamFilterIdentity, STREAM_ENCODERS, openStreamSegmentEncoder, endsWithCompleteMfra,
  dropStreamEncoderSpares, streamEncoderSpareCount, streamPrewarmEnabled, streamSegmentArgs, streamFilterThreads,
} from '../bakery/ffmpeg.mjs';
import { encoderParamsHash, splitFmp4, segmentInfo } from '../frame-stream.mjs';

const ffmpegOk = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
after(() => dropStreamEncoderSpares());

/** Synthetic frame: random RGBA (all alpha and color combinations) + gradient + transparent/opaque blocks */
function synthPngs(width, height, count, seed0 = 7) {
  let seed = seed0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 16) & 255; };
  const out = [];
  for (let f = 0; f < count; f++) {
    const png = new PNG({ width, height });
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const band = Math.floor((y * 4) / height);
      if (band === 0) { png.data[i] = rnd(); png.data[i + 1] = rnd(); png.data[i + 2] = rnd(); png.data[i + 3] = rnd(); }
      else if (band === 1) { png.data[i] = (x * 3 + f) & 255; png.data[i + 1] = (y * 5) & 255; png.data[i + 2] = (x ^ y) & 255; png.data[i + 3] = x & 255; }
      else if (band === 2) { png.data[i] = 200; png.data[i + 1] = 30; png.data[i + 2] = 90; png.data[i + 3] = x < width / 2 ? 0 : 255; }
      else { png.data[i] = rnd(); png.data[i + 1] = rnd(); png.data[i + 2] = rnd(); png.data[i + 3] = (x + y + f) & 1 ? 255 : rnd(); }
    }
    out.push(PNG.sync.write(png));
  }
  return out;
}

/**
 * Same batch of PNGs through filterchain, getting raw YUV before encoder (`threads`: slice
 * threads, 0 = ffmpeg default)
 */
function filtered(filter, pngs, threads = 0) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-filter_complex_threads', String(threads), '-reinit_filter', '0', '-f', 'image2pipe', '-c:v', 'png',
    '-framerate', '30', '-i', 'pipe:0', '-filter_complex', filter, '-f', 'rawvideo', 'pipe:1'],
  { input: Buffer.concat(pngs), maxBuffer: 1 << 28, windowsHide: true });
}

test('The new filter chain only drops the intermediate conversion; literally it is still G3\'s steps', () => {
  const f = streamFilter('yuv420p');
  assert.match(f, /^\[0:v\]format=gbrap,split=2\[p\]\[a\];\[p\]premultiply=inplace=1,/);
  assert.doesNotMatch(f, /premultiply=inplace=1,split/, 'Splitting after premultiply makes an unpremultiply pass get inserted automatically before alphaextract');
  assert.match(f, /scale=out_range=tv:out_color_matrix=bt709,format=yuv420p$/);
  assert.match(streamFilter('nv12'), /format=nv12$/);
  assert.notEqual(streamFilter('yuv420p'), streamFilterIdentity('yuv420p'));
});

test('Filter slice thread count: capped at 8 by core count', () => {
  assert.equal(streamFilterThreads(16, {}), 8);
  assert.equal(streamFilterThreads(32), 8);
  assert.equal(streamFilterThreads(8), 8);
  assert.equal(streamFilterThreads(4), 4);
  assert.equal(streamFilterThreads(1), 1);
  assert.equal(streamFilterThreads(0), 1);
  assert.equal(streamFilterThreads(NaN), 1);
  assert.equal(streamFilterThreads(16, { PROMPTCUT_STREAM_FILTER_THREADS: '0' }), 0, '0 = leave it to ffmpeg');
  assert.equal(streamFilterThreads(16, { PROMPTCUT_STREAM_FILTER_THREADS: '12' }), 12);
  assert.equal(streamFilterThreads(16, { PROMPTCUT_STREAM_FILTER_THREADS: 'x' }), 8, 'Ignored if not a number');
});

test('The encoding-parameter hash in the segment signature is the same as before the rewrite (existing segments are not invalidated)', () => {
  // Value calculated from streamFilter literal before rewrite (main 2c7cee2)
  assert.equal(encoderParamsHash('libx264'), 'de84562fd4660af1');
  assert.equal(encoderParamsHash('h264_mf'), 'e8429af745c908c0');
  assert.equal(encoderParamsHash('h264_nvenc'), '71b4b8bd213000a1');
});

test('The YUV that the new filter chain feeds the encoder is byte-identical to the old formulation\'s', { skip: !ffmpegOk && 'No ffmpeg', timeout: 120_000 }, () => {
  for (const [w, h] of [[256, 64], [330, 190]]) {
    const pngs = synthPngs(w, h, 3, w + h);
    for (const pixFmt of new Set(Object.values(STREAM_ENCODERS).map(s => s.pixFmt))) {
      const a = filtered(streamFilterIdentity(pixFmt), pngs);
      const b = filtered(streamFilter(pixFmt), pngs);
      assert.equal(a.length, 3 * w * 2 * (h + 8) * 1.5, `${w}x${h} ${pixFmt}: frame size`);
      assert.ok(a.equals(b), `${w}x${h} ${pixFmt}: new and old filter chains produce different output`);
      // Slice thread count does not alter output (CLI caps at 8 by core count, slice count varies by machine)
      for (const threads of [1, 3]) assert.ok(filtered(streamFilter(pixFmt), pngs, threads).equals(a), `${w}x${h} ${pixFmt}: output differs with ${threads} slices`);
    }
  }
});

/* ------------------------------------------------------------ mfra finalization check */

const box = (type, size = 8) => { const b = Buffer.alloc(size); b.writeUInt32BE(size, 0); b.write(type, 4, 'latin1'); return b; };

test('endsWithCompleteMfra: counts only if it ends exactly with a complete mfra', () => {
  const body = [box('ftyp', 16), box('moov', 24), box('moof', 32), box('mdat', 40)];
  assert.equal(endsWithCompleteMfra(Buffer.concat([...body, box('mfra', 20)])), true);
  assert.equal(endsWithCompleteMfra(Buffer.concat(body)), false, 'trailer not written yet');
  assert.equal(endsWithCompleteMfra(Buffer.concat([...body, box('mfra', 20)]).subarray(0, 16 + 24 + 32 + 40 + 12)), false, 'Only half of mfra is present');
  assert.equal(endsWithCompleteMfra(Buffer.concat([...body, box('mfra', 20), Buffer.from([0, 0])])), false, 'There are bytes after mfra');
  assert.equal(endsWithCompleteMfra(Buffer.alloc(0)), false);
  const large = Buffer.alloc(24); large.writeUInt32BE(1, 0); large.write('mfra', 4, 'latin1'); large.writeBigUInt64BE(24n, 8);
  assert.equal(endsWithCompleteMfra(Buffer.concat([box('ftyp', 16), large])), true, '64-bit size');
  const zero = box('mfra', 8); zero.writeUInt32BE(0, 0);
  assert.equal(endsWithCompleteMfra(Buffer.concat([box('ftyp', 16), zero])), false, 'Size 0 (to end of file) does not count as an ending');
});

/* ------------------------------------------------------------ Pre-spawned encoding processes */

async function encode(pngs, opts) {
  const enc = openStreamSegmentEncoder('ffmpeg', { encoder: 'libx264', fps: 30, ...opts });
  for (const png of pngs) await enc.write(png);
  return enc.finish();
}

test('Switch: on by default, PROMPTCUT_STREAM_PREWARM=0 turns it off', () => {
  assert.equal(streamPrewarmEnabled({}), true);
  assert.equal(streamPrewarmEnabled({ PROMPTCUT_STREAM_PREWARM: '0' }), false);
  assert.equal(streamPrewarmEnabled({ PROMPTCUT_STREAM_PREWARM: '1' }), true);
});

test('Pre-started process: after one is taken another is started to replace it, output is byte-identical to one started on demand, and the bytes handed over by finish end with mfra', { skip: !ffmpegOk && 'No ffmpeg', timeout: 120_000 }, async () => {
  dropStreamEncoderSpares();
  const pngs = synthPngs(320, 180, 15, 99);
  const cold = await encode(pngs, { prewarm: false });
  assert.equal(streamEncoderSpareCount(), 0, 'With the switch off, no spare process is started');
  const first = await encode(pngs, { prewarm: true });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(streamEncoderSpareCount(), 1, 'After opening one, the pool refilled one');
  const second = await encode(pngs, { prewarm: true });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(streamEncoderSpareCount(), 1, 'Each time one is taken another is refilled, so the pool always keeps just one');
  for (const [name, out] of [['cold', cold], ['first', first], ['second', second]]) {
    assert.ok(endsWithCompleteMfra(out.bytes), `${name}: ends with mfra`);
    assert.equal(out.written, 15);
    const { init, segments } = splitFmp4(out.bytes);
    assert.ok(init.length > 0, `${name}: has init`);
    assert.equal(segments.length, 1);
    const info = segmentInfo(segments[0]);
    assert.equal(info.sampleCount, 15, `${name}: 15 samples`);
    assert.equal(info.firstSampleIsSync, true);
  }
  assert.ok(first.bytes.equals(cold.bytes), 'Output of the pre-started process matches the on-demand one');
  assert.ok(second.bytes.equals(cold.bytes), 'Output of the spare process that was taken matches the on-demand one');
  dropStreamEncoderSpares();
  assert.equal(streamEncoderSpareCount(), 0);
});

test('When ffmpeg fails, finish still reports the error as before (same for a spare process)', { skip: !ffmpegOk && 'No ffmpeg', timeout: 60_000 }, async () => {
  dropStreamEncoderSpares();
  for (const prewarm of [false, true, true]) {
    const enc = openStreamSegmentEncoder('ffmpeg', { encoder: 'libx264', fps: 30, prewarm });
    await enc.write(Buffer.from('this is not a png at all'.repeat(64))).catch(() => {});
    await assert.rejects(enc.finish(), /ffmpeg\(libx264\) exit code|EPIPE|EOF/, `prewarm=${prewarm}`);
  }
  dropStreamEncoderSpares();
});

/* ------------------------------------------------------------ Full command line */

/**
 * Full CLI before rewrite (main e27fa520): default 5 MB probe, frame-level multithreading,
 * `streamFilterIdentity` chain
 */
function legacySegmentArgs(fps = 30) {
  return ['-y', '-hide_banner', '-loglevel', 'error',
    '-reinit_filter', '0', '-f', 'image2pipe', '-c:v', 'png', '-framerate', String(fps), '-i', 'pipe:0',
    '-filter_complex', streamFilterIdentity('yuv420p'),
    ...STREAM_ENCODERS.libx264.args,
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-video_track_timescale', String(fps),
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-an',
    '-f', 'mp4', 'pipe:1'];
}

test('The fMP4 encoded by the whole command line is byte-identical to before the rewrite', { skip: !ffmpegOk && 'No ffmpeg', timeout: 180_000 }, () => {
  const run = (args, pngs) => execFileSync('ffmpeg', args, { input: Buffer.concat(pngs), maxBuffer: 1 << 28, windowsHide: true });
  for (const [w, h] of [[320, 180], [642, 362]]) {
    const pngs = synthPngs(w, h, 15, w * 7 + h);
    const before = run(legacySegmentArgs(30), pngs);
    const after = run(streamSegmentArgs({ encoder: 'libx264', fps: 30 }), pngs);
    assert.ok(before.length > 1000, `${w}x${h}: old command line produced output`);
    assert.ok(after.equals(before), `${w}x${h}: fMP4 differs between new and old command lines (${after.length} vs ${before.length})`);
  }
});

test('Starts working as soon as a frame arrives: before stdin is closed, the encoder is already emitting bytes', { skip: !ffmpegOk && 'No ffmpeg', timeout: 60_000 }, async () => {
  dropStreamEncoderSpares();
  const pngs = synthPngs(320, 180, 15, 5);
  const enc = openStreamSegmentEncoder('ffmpeg', { encoder: 'libx264', fps: 30, prewarm: false });
  // Feed only 3 frames without closing stdin: before rewrite ffmpeg had to read 5 MB before starting;
  // not enough for the full segment, so this stays 0
  for (const png of pngs.slice(0, 3)) await enc.write(png);
  const deadline = Date.now() + 20_000;
  while (enc.received === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  assert.ok(enc.received > 0, 'Fed 3 frames with stdin not closed, ffmpeg has not emitted a single byte yet (the input side is buffering packets)');
  for (const png of pngs.slice(3)) await enc.write(png);
  const out = await enc.finish();
  const { segments } = splitFmp4(out.bytes);
  assert.equal(segmentInfo(segments[0]).sampleCount, 15);
});

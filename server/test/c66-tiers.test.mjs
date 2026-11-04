/**
 * C6.6 two-tier generation (`docs/plan/c66-design.md` Sections 2 and 8 "small-size asset command"
 * and "faststart check", generation side for acceptance check T1 and T6).
 * Run: node --test server/test/c66-tiers.test.mjs
 *
 * Written purely against the design doc without inspecting implementation. Name and shape of the
 * module under test are assumption K1 (see file header of `c66-kit.mjs`).
 * Samples are generated on the fly with ffmpeg (1080p 2 s, delayed moov, ProRes, MKV, 120 fps,
 * odd dimensions, display rotation, no audio track, image, audio).
 * Checks strictly use the test's own methods (ffprobe, custom top-level box parsing, stream
 * packet data md5), without relying on the check from the module under test.
 * When the module under test is absent, each test case fails individually and reports the reason.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  tempDir, makeSamples, loadTiers, ffmpeg, probe, streamHashes, videoPackets, boxFaststart, sha256File, HEX64,
} from './c66-kit.mjs';

const DIR = tempDir('pc-c66-tiers-');
let S = null;
let samplesError = null;
before(async () => {
  try { S = await makeSamples(path.join(DIR)); } catch (err) { samplesError = err; }
});
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

function samples() {
  if (samplesError) assert.fail(`sample generation failed (ffmpeg on this machine?): ${samplesError.message}`);
  return S;
}
let seq = 0;
const work = () => { const d = path.join(DIR, `w${++seq}`); fs.mkdirSync(d, { recursive: true }); return d; };
const fpsOf = (s) => { const [a, b] = String(s || '0/1').split('/').map(Number); return b ? a / b : 0; };

/** Common requirements for small-size asset: ≤ 800×600, even dimensions, H.264, yuv420p, mp4 container, faststart */
function assertSmallBasics(p, file, what) {
  assert.ok(p.video, `${what}: the small-size asset must have a video stream`);
  assert.equal(p.video.codec_name, 'h264', `${what}: the small-size asset is H.264`);
  assert.equal(p.video.pix_fmt, 'yuv420p', `${what}: the small-size asset is yuv420p`);
  const { width: w, height: h } = p.video;
  assert.ok(w <= 800 && h <= 600, `${what}: small-size asset ${w}×${h} must be within 800×600`);
  assert.equal(w % 2, 0, `${what}: width ${w} must be even`);
  assert.equal(h % 2, 0, `${what}: height ${h} must be even`);
  assert.match(p.format.format_name, /mp4|mov/, `${what}: the small-size asset is in an mp4 container`);
  assert.equal(boxFaststart(file), true, `${what}: the small-size asset has faststart (moov before mdat)`);
}

async function small(input, what) {
  const tiers = await loadTiers();
  const output = path.join(work(), 'small.mp4');
  await tiers.makeSmall({ ffmpeg: await ffmpeg(), input, output });
  assert.ok(fs.existsSync(output), `${what}: makeSmallTier must write the small-size asset to output`);
  const p = await probe(output);
  assertSmallBasics(p, output, what);
  return { p, output };
}

// ------------------------------------------------------------------ T1 small-size asset parameters

test('C66-T1-01 1080p → small-size asset ≤ 800×600 with even dimensions, H.264 yuv420p, faststart, proportional scaling, frame rate follows the original-size asset, AAC about 64k', async () => {
  const s = samples();
  const { p } = await small(s.hd, '1080p');
  const { width: w, height: h } = p.video;
  assert.ok(Math.abs(w / h - 16 / 9) < 0.02, `proportional scaling: ${w}×${h}`);
  assert.ok(w >= 796 || h >= 596, `scaled to touch the bounds (as large as possible within 800×600): ${w}×${h}`);
  assert.ok(Math.abs(fpsOf(p.video.avg_frame_rate) - 30) < 0.5, `frame rate follows the original-size asset at 30: ${p.video.avg_frame_rate}`);
  assert.ok(p.audio, 'the source has an audio track, so the small-size asset must have one');
  assert.equal(p.audio.codec_name, 'aac', 'the small-size asset\'s audio track is AAC');
  const br = Number(p.audio.bit_rate);
  assert.ok(br > 0 && br <= 80_000, `small-size asset audio bitrate is about 64k: ${br}`);
});

test('C66-T1-02 120 fps, no audio track → small-size asset frame rate capped at 60; it can also be produced without an audio track (-map 0:a:0?)', async () => {
  const s = samples();
  const { p, output } = await small(s.fps120, '120fps');
  const fps = fpsOf(p.video.avg_frame_rate);
  assert.ok(fps <= 61, `frame rate capped at 60 (the average frame rate of VFR is computed from timestamps, leaving a margin of 1 frame): ${p.video.avg_frame_rate}`);
  const n = await videoPackets(output);
  assert.ok(n <= 62 && n >= 50, `a 1 s 120 fps source is decimated to about 60 frames: ${n}`);
  assert.equal(p.audio, undefined, 'the source has no audio track, and neither does the small-size asset');
});

test('C66-T1-03 source already within 800×600 (640×360) → not enlarged', async () => {
  const s = samples();
  const { p } = await small(s.noAudio, '640x360');
  assert.equal(p.video.width, 640);
  assert.equal(p.video.height, 360);
});

test('C66-T1-04 odd dimensions 1001×777, yuv444p → small-size asset with even dimensions, yuv420p, proportional', async () => {
  const s = samples();
  const { p } = await small(s.odd, '1001x777');
  const { width: w, height: h } = p.video;
  assert.ok(Math.abs(w / h - 1001 / 777) < 0.02, `proportional: ${w}×${h}`);
});

test('C66-T1-05 1080p with a display rotation of 90° → the rotation is baked into the pixels (-autorotate), and the small-size asset is portrait and no longer carries a rotation', async () => {
  const s = samples();
  const { p } = await small(s.portrait, 'rotation');
  const { width: w, height: h } = p.video;
  assert.ok(h > w, `portrait frame: ${w}×${h}`);
  assert.ok(Math.abs(w / h - 1080 / 1920) < 0.02, `proportional: ${w}×${h}`);
  const rot = (p.video.side_data_list ?? []).find((d) => 'rotation' in d)?.rotation ?? 0;
  assert.equal(Number(rot) % 360, 0, `the small-size asset no longer carries a display rotation: ${rot}`);
});

// ------------------------------------------------------------------ T1 faststart check

test('C66-T1-06 faststart detection follows the top-level box order: leading moov → true, trailing → false, MKV / image → not applicable (null)', async () => {
  const s = samples();
  const { hasFaststart } = await loadTiers();
  assert.equal(await hasFaststart(s.hd), true, 'hd.mp4 has a leading moov');
  assert.equal(await hasFaststart(s.lateMoov), false, 'late.mp4 has a trailing moov');
  assert.equal(await hasFaststart(s.prores), false, 'ProRes MOV (mov defaults to a trailing moov)');
  assert.equal(await hasFaststart(s.mkv), null, 'MKV is not handled');
});

test('C66-T1-07 faststart detection hops through the top-level boxes one by one: 64-bit largesize, size 0 running to the end of the file, and the text "moov" embedded inside mdat are all judged correctly', async () => {
  const { hasFaststart } = await loadTiers();
  const d = work();
  const box = (type, payload = Buffer.alloc(0)) => {
    const h = Buffer.alloc(8);
    h.writeUInt32BE(8 + payload.length, 0);
    h.write(type, 4, 'latin1');
    return Buffer.concat([h, payload]);
  };
  const ftyp = box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2', 'latin1'));
  // mdat uses 64-bit largesize, followed by moov
  const large = Buffer.alloc(16 + 8);
  large.writeUInt32BE(1, 0); large.write('mdat', 4, 'latin1'); large.writeBigUInt64BE(24n, 8);
  const f1 = path.join(d, 'large.mp4');
  fs.writeFileSync(f1, Buffer.concat([ftyp, large, box('moov', Buffer.alloc(8))]));
  assert.equal(await hasFaststart(f1), false, 'the largesize mdat comes before moov');
  // moov comes first, mdat size = 0 (extends to end of file)
  const zero = Buffer.alloc(8 + 32); zero.writeUInt32BE(0, 0); zero.write('mdat', 4, 'latin1');
  const f2 = path.join(d, 'zero.mp4');
  fs.writeFileSync(f2, Buffer.concat([ftyp, box('moov', Buffer.alloc(8)), zero]));
  assert.equal(await hasFaststart(f2), true, 'moov first, mdat running to the end of the file');
  // The four characters "moov" appear in mdat payload: only skipping by box checks it correctly
  const f3 = path.join(d, 'fake.mp4');
  fs.writeFileSync(f3, Buffer.concat([ftyp, box('mdat', Buffer.from('xxxx\0\0\0\x08moovyyyy', 'latin1')), box('moov', Buffer.alloc(8))]));
  assert.equal(await hasFaststart(f3), false, 'the text "moov" inside the mdat payload does not count');
});

// ------------------------------------------------------------------ T1 original-size asset: remux only

test('C66-T1-08 ensureFaststart: an existing faststart is left alone; a trailing moov is remuxed into a new file (encoding unchanged, source file untouched); MKV is not handled', async () => {
  const s = samples();
  const { ensureFaststart } = await loadTiers();
  const f = await ffmpeg();

  const a = await ensureFaststart({ ffmpeg: f, input: s.hd, workDir: work() });
  assert.equal(path.resolve(a.path), path.resolve(s.hd), 'already faststart: use the source file as is');
  assert.equal(a.remuxed, false);

  const before = sha256File(s.lateMoov);
  const b = await ensureFaststart({ ffmpeg: f, input: s.lateMoov, workDir: work() });
  assert.equal(b.remuxed, true, 'a trailing moov must be remuxed');
  assert.notEqual(path.resolve(b.path), path.resolve(s.lateMoov), 'remux writes a new file and does not overwrite the source file');
  assert.equal(sha256File(s.lateMoov), before, 'the source file is byte-for-byte unchanged');
  assert.equal(boxFaststart(b.path), true, 'after remuxing, moov is before mdat');
  assert.deepEqual(await streamHashes(b.path), await streamHashes(s.lateMoov), 'packet data of every stream is identical (only moov is moved, no transcoding)');

  const c = await ensureFaststart({ ffmpeg: f, input: s.mkv, workDir: work() });
  assert.equal(path.resolve(c.path), path.resolve(s.mkv), 'MKV is not handled');
  assert.equal(c.remuxed, false);
});

test('C66-T1-09 remux failure (ffmpeg fails to start / errors) → does not throw, keeps the source file as the original-size asset', async () => {
  const s = samples();
  const { ensureFaststart } = await loadTiers();
  const before = sha256File(s.lateMoov);
  // Using node as ffmpeg: it does not recognize ffmpeg arguments and inevitably exits non-zero
  const r = await ensureFaststart({ ffmpeg: process.execPath, input: s.lateMoov, workDir: work() });
  assert.equal(path.resolve(r.path), path.resolve(s.lateMoov), 'on failure the original-size asset is the source file');
  assert.equal(r.remuxed, false);
  assert.equal(sha256File(s.lateMoov), before, 'the source file is untouched');
  const r2 = await ensureFaststart({ ffmpeg: path.join(DIR, 'no-such-ffmpeg.exe'), input: s.lateMoov, workDir: work() });
  assert.equal(path.resolve(r2.path), path.resolve(s.lateMoov), 'the source file is likewise kept when ffmpeg does not exist');
});

// ------------------------------------------------------------------ T1 end-to-end: tiers two hashes

test('C66-T1-10 prepareTiers (1080p that already has faststart): the original-size asset is the source file bytes, the small-size asset has a different hash; both hashes are the sha256 of their files', async () => {
  const s = samples();
  const { prepare } = await loadTiers();
  const r = await prepare({ ffmpeg: await ffmpeg(), input: s.hd, kind: 'video', workDir: work() });
  assert.match(r.original.hash, HEX64);
  assert.equal(r.original.hash, sha256File(r.original.path), 'original.hash is the sha256 of its file');
  assert.equal(r.original.hash, sha256File(s.hd), 'no transcoding, no remux needed: the original-size asset bytes equal the source file');
  assert.ok(r.small, 'a video must have a small-size asset');
  assert.match(r.small.hash, HEX64);
  assert.equal(r.small.hash, sha256File(r.small.path), 'small.hash is the sha256 of its file');
  assert.notEqual(r.small.hash, r.original.hash);
  assertSmallBasics(await probe(r.small.path), r.small.path, 'small-size asset from prepareTiers');
  const keys = Object.keys(r).filter((k) => r[k] !== undefined).sort();
  assert.deepEqual(keys.filter((k) => !['original', 'small'].includes(k)), [], `the return value has only the two tiers, with no fields such as sync status: ${keys}`);
});

test('C66-T1-11 prepareTiers (trailing moov): the original-size asset = the remux result, identified by its hash; encoding is the same as the source file', async () => {
  const s = samples();
  const { prepare } = await loadTiers();
  const r = await prepare({ ffmpeg: await ffmpeg(), input: s.lateMoov, kind: 'video', workDir: work() });
  assert.notEqual(r.original.hash, sha256File(s.lateMoov), 'the remux result counts as the new original-size asset');
  assert.equal(r.original.hash, sha256File(r.original.path));
  assert.equal(boxFaststart(r.original.path), true);
  assert.deepEqual(await streamHashes(r.original.path), await streamHashes(s.lateMoov), 'the original-size asset\'s encoding is unchanged');
  const [po, ps] = [await probe(r.original.path), await probe(s.lateMoov)];
  for (const k of ['codec_name', 'profile', 'width', 'height', 'pix_fmt']) assert.equal(po.video[k], ps.video[k], `original-size asset ${k} is the same as the source`);
  assert.ok(r.small, 'must have a small-size asset');
});

test('C66-T1-12 video only: images and audio have no small-size asset', async () => {
  const s = samples();
  const { prepare } = await loadTiers();
  const f = await ffmpeg();
  const img = await prepare({ ffmpeg: f, input: s.png, kind: 'image', workDir: work() });
  assert.equal(img.small, undefined, 'images do not produce a small-size asset');
  assert.equal(img.original.hash, sha256File(s.png), 'images are ingested as is');
  const aud = await prepare({ ffmpeg: f, input: s.m4a, kind: 'audio', workDir: work() });
  assert.equal(aud.small, undefined, 'audio does not produce a small-size asset');
  assert.equal(aud.original.hash, sha256File(aud.original.path));
});

// ------------------------------------------------------------------ T6 generation side: ProRes

test('C66-T6-01 ProRes MOV: the original-size asset is not transcoded (still ProRes, same packet data), plus an H.264 small-size asset', async () => {
  const s = samples();
  const { prepare } = await loadTiers();
  const r = await prepare({ ffmpeg: await ffmpeg(), input: s.prores, kind: 'video', workDir: work() });
  const po = await probe(r.original.path);
  assert.equal(po.video.codec_name, 'prores', 'the original-size asset is still ProRes');
  assert.deepEqual(await streamHashes(r.original.path), await streamHashes(s.prores), 'the original-size asset\'s encoding is unchanged');
  assert.ok(r.small, 'must have a small-size asset');
  assertSmallBasics(await probe(r.small.path), r.small.path, 'small-size asset of ProRes');
});

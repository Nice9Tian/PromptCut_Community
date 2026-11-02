/**
 * Custom MP4 muxer (`docs/plan/c10a-contract.md` Section 11 [ruling]): readable by ffprobe, with
 * correct frame count, duration, and codec.
 * Run: node --test src/export/mp4Mux.test.mjs
 *
 * Samples are created with ffmpeg (H.264 Annex B, AAC ADTS), unpacked into the shape WebCodecs
 * would give (AVCC length-prefixed access units + avcC; raw AAC frames + AudioSpecificConfig),
 * handed to the muxer, and read back with ffprobe. Machines without ffmpeg skip (reporting reason).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Mp4Muxer, MemorySink } from './mp4Mux.ts';

let ffmpeg = null;
try { ffmpeg = await (await import('../../server/bakery/ffmpeg.mjs')).findFfmpeg(); } catch { ffmpeg = null; }
const ffprobe = ffmpeg ? ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe')) : null;
const skip = ffmpeg ? false : 'ffmpeg not found on this machine';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-mp4mux-'));

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'buffer', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} exit code ${r.status}: ${String(r.stderr).slice(-600)}`);
  return r.stdout;
}
function probe(file) {
  const out = run(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,profile,width,height,nb_read_frames,duration,sample_rate,channels,avg_frame_rate:format=duration,format_name', '-of', 'json', file]);
  return JSON.parse(String(out));
}

/** Annex B → NAL units */
function nals(buf) {
  const out = [];
  let i = 0, start = -1;
  while (i + 3 <= buf.length) {
    const sc3 = buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1;
    const sc4 = i + 4 <= buf.length && buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1;
    if (sc3 || sc4) {
      if (start >= 0) out.push(buf.subarray(start, i));
      i += sc4 ? 4 : 3;
      start = i;
      continue;
    }
    i++;
  }
  if (start >= 0) out.push(buf.subarray(start));
  // Strip trailing zeros (leading zeros of the next start code)
  return out.map((n) => { let e = n.length; while (e > 0 && n[e - 1] === 0) e--; return n.subarray(0, e); }).filter((n) => n.length);
}

/** Generate an H.264 segment (with AUD framing), unpack into access units and avcC */
function makeH264({ w, h, fps, frames, gop }) {
  const file = path.join(TMP, `v-${w}x${h}-${fps}.h264`);
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc=size=${w}x${h}:rate=${fps}`, '-frames:v', String(frames),
    '-c:v', 'libx264', '-profile:v', 'high', '-bf', '0', '-g', String(gop), '-pix_fmt', 'yuv420p', '-x264-params', 'aud=1', '-f', 'h264', file]);
  const units = nals(fs.readFileSync(file));
  let sps = null, pps = null;
  const aus = [];
  let cur = null;
  for (const n of units) {
    const type = n[0] & 0x1f;
    if (type === 9) { cur = { nals: [], key: false }; aus.push(cur); continue; }
    if (type === 7) { sps ??= n; continue; }
    if (type === 8) { pps ??= n; continue; }
    if (!cur) { cur = { nals: [], key: false }; aus.push(cur); }
    if (type === 5) cur.key = true;
    if (type === 6) continue; // Discard SEI
    cur.nals.push(n);
  }
  const avcC = Uint8Array.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 0xff, ...sps, 1, pps.length >> 8, pps.length & 0xff, ...pps]);
  const samples = aus.filter((a) => a.nals.length).map((a) => {
    const size = a.nals.reduce((s, n) => s + 4 + n.length, 0);
    const out = new Uint8Array(size);
    let at = 0;
    for (const n of a.nals) {
      out[at] = n.length >>> 24; out[at + 1] = (n.length >>> 16) & 0xff; out[at + 2] = (n.length >>> 8) & 0xff; out[at + 3] = n.length & 0xff;
      out.set(n, at + 4);
      at += 4 + n.length;
    }
    return { data: out, key: a.key };
  });
  return { avcC, samples };
}

/** Generate an AAC segment (ADTS), unpack into raw frames and AudioSpecificConfig */
function makeAac({ sampleRate, channels, seconds }) {
  const file = path.join(TMP, `a-${sampleRate}-${channels}.aac`);
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${sampleRate}`, '-t', String(seconds),
    '-ac', String(channels), '-c:a', 'aac', '-f', 'adts', file]);
  const buf = fs.readFileSync(file);
  const frames = [];
  let asc = null;
  for (let i = 0; i + 7 <= buf.length;) {
    assert.equal(buf[i], 0xff, 'ADTS sync word');
    const protectionAbsent = buf[i + 1] & 1;
    const profile = (buf[i + 2] >> 6) & 3;
    const freqIdx = (buf[i + 2] >> 2) & 0xf;
    const chan = ((buf[i + 2] & 1) << 2) | (buf[i + 3] >> 6);
    const len = ((buf[i + 3] & 3) << 11) | (buf[i + 4] << 3) | (buf[i + 5] >> 5);
    const head = protectionAbsent ? 7 : 9;
    asc ??= Uint8Array.from([((profile + 1) << 3) | (freqIdx >> 1), ((freqIdx & 1) << 7) | (chan << 3)]);
    frames.push(buf.subarray(i + head, i + len));
    i += len;
  }
  return { asc, frames };
}

function mux({ video, audio, fps, w, h }) {
  const sink = new MemorySink();
  const m = new Mp4Muxer({ sink,
    video: { codec: 'avc1.640028', width: w, height: h, fps, avcC: video.avcC },
    audio: audio ? { codec: 'mp4a.40.2', sampleRate: audio.sampleRate, channels: audio.channels, asc: audio.asc } : null });
  // Interleave by presentation time: one video frame, then write audio frames up to this point
  // (same as the two encoders alternately emitting chunks during export)
  let ai = 0;
  video.samples.forEach((s, i) => {
    m.addVideoChunk(s.data, { timestampUs: Math.round((i * 1e6) / fps), key: s.key });
    if (audio) {
      const until = ((i + 1) * 1e6) / fps;
      while (ai < audio.frames.length && (ai * 1024 * 1e6) / audio.sampleRate < until) {
        m.addAudioChunk(audio.frames[ai], { timestampUs: Math.round((ai * 1024 * 1e6) / audio.sampleRate), durationUs: (1024 * 1e6) / audio.sampleRate });
        ai++;
      }
    }
  });
  if (audio) for (; ai < audio.frames.length; ai++) m.addAudioChunk(audio.frames[ai], { durationUs: (1024 * 1e6) / audio.sampleRate });
  return { m, sink };
}

test('MX1 Video track only: ffprobe can read h264, and the frame count, duration and dimensions are correct', { skip }, async () => {
  const fps = 30, frames = 90, w = 320, h = 240;
  const video = makeH264({ w, h, fps, frames, gop: 30 });
  assert.equal(video.samples.length, frames);
  const { m, sink } = mux({ video, fps, w, h });
  const size = await m.finalize();
  assert.equal(size, sink.size);
  const file = path.join(TMP, 'mx1.mp4');
  fs.writeFileSync(file, sink.bytes());
  const info = probe(file);
  const v = info.streams.find((s) => s.codec_type === 'video');
  assert.equal(v.codec_name, 'h264');
  assert.equal(Number(v.nb_read_frames), frames);
  assert.equal(v.width, w);
  assert.equal(v.height, h);
  assert.equal(v.avg_frame_rate, '30/1');
  assert.ok(Math.abs(Number(v.duration) - 3) < 1e-3, `Duration ${v.duration}`);
  assert.ok(Math.abs(Number(info.format.duration) - 3) < 1e-3);
  assert.equal(info.streams.length, 1);
  // Decode once to confirm data itself is not corrupted (ffmpeg decoding to null does not error)
  run(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-']);
});

test('MX2 Video + AAC audio: both tracks readable, with correct frame count, duration and codec', { skip }, async () => {
  const fps = 25, frames = 50, w = 640, h = 360;
  const video = makeH264({ w, h, fps, frames, gop: 25 });
  const aac = makeAac({ sampleRate: 48000, channels: 2, seconds: 2 });
  const { m, sink } = mux({ video, audio: { ...aac, sampleRate: 48000, channels: 2 }, fps, w, h });
  await m.finalize();
  const file = path.join(TMP, 'mx2.mp4');
  fs.writeFileSync(file, sink.bytes());
  const info = probe(file);
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  assert.equal(v.codec_name, 'h264');
  assert.equal(Number(v.nb_read_frames), frames);
  assert.ok(Math.abs(Number(v.duration) - 2) < 1e-3, `Video duration ${v.duration}`);
  assert.equal(a.codec_name, 'aac');
  assert.equal(Number(a.sample_rate), 48000);
  assert.equal(a.channels, 2);
  assert.equal(Number(a.nb_read_frames), aac.frames.length);
  assert.ok(Math.abs(Number(a.duration) - (aac.frames.length * 1024) / 48000) < 1e-3, `Audio duration ${a.duration}`);
  run(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-']);
});

test('MX3 60 fps, portrait dimensions, keyframes: stss lists only keyframes, and ffprobe can count the keyframes', { skip }, async () => {
  const fps = 60, frames = 120, w = 360, h = 640;
  const video = makeH264({ w, h, fps, frames, gop: 60 });
  const { m, sink } = mux({ video, fps, w, h });
  await m.finalize();
  const file = path.join(TMP, 'mx3.mp4');
  fs.writeFileSync(file, sink.bytes());
  const info = probe(file);
  const v = info.streams[0];
  assert.equal(Number(v.nb_read_frames), frames);
  assert.ok(Math.abs(Number(v.duration) - 2) < 1e-3);
  const keys = String(run(ffprobe, ['-v', 'error', '-select_streams', 'v', '-skip_frame', 'nokey', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file])).trim();
  assert.equal(Number(keys), video.samples.filter((s) => s.key).length);
  assert.equal(Number(keys), 2);
});

test('MX4 Writes land by position: write mdat first, then go back and fill in the length; MemorySink assembles correctly', async () => {
  const sink = new MemorySink();
  const m = new Mp4Muxer({ sink, video: { codec: 'avc1.42E028', width: 16, height: 16, fps: 30, avcC: Uint8Array.of(1, 0x42, 0, 0x28, 0xff, 0xe0, 0) } });
  m.addVideoChunk(Uint8Array.of(0, 0, 0, 1, 0x65), { timestampUs: 0, key: true });
  m.addVideoChunk(Uint8Array.of(0, 0, 0, 1, 0x41), { timestampUs: 33333, key: false });
  await m.finalize();
  const b = sink.bytes();
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ftypSize = dv.getUint32(0);
  assert.equal(String.fromCharCode(...b.subarray(4, 8)), 'ftyp');
  assert.equal(dv.getUint32(ftypSize), 1, 'mdat uses a 64-bit length');
  assert.equal(String.fromCharCode(...b.subarray(ftypSize + 4, ftypSize + 8)), 'mdat');
  const mdatSize = Number(dv.getBigUint64(ftypSize + 8));
  assert.equal(mdatSize, 16 + 10, 'mdat length = header 16 + two samples 10');
  assert.equal(String.fromCharCode(...b.subarray(ftypSize + mdatSize + 4, ftypSize + mdatSize + 8)), 'moov');
  assert.throws(() => new Mp4Muxer({ sink, video: { codec: 'vp09.00.10.08', width: 16, height: 16, fps: 30, avcC: new Uint8Array() } }), /Only H\.264 can be muxed/);
});

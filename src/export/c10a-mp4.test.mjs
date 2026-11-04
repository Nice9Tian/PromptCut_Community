/**
 * C10a MP4 muxer for online page frame-by-frame export (`docs/plan/c10a-contract.md` Section 11
 * [ruling] "custom minimal muxer", Section 12 "MP4 muxing").
 * Run: node --test src/export/c10a-mp4.test.mjs
 *
 * Encoding is out of test scope (browser VideoEncoder / AudioEncoder): samples are encoded on the fly
 * by ffmpeg into H.264 Annex B and AAC ADTS; the test unpacks them into the shape WebCodecs hands
 * to the muxer (AVCC length-prefixed access units + avcC; AAC frames stripped of ADTS headers +
 * AudioSpecificConfig), feeds them to the muxer, and verifies output with ffprobe / ffmpeg: readable,
 * frame count, duration, codec, keyframes, and decoded frames match the source stream frame by frame.
 *
 * For muxer name and calling conventions, see K5 in `server/test/c10a-kit.mjs`; skip the entire
 * suite when not found under `src/export/`.
 */
import "../testing/registerTs.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  skipIf, findMuxer, muxerBytes, fakeChunk, annexBToAvcc, adtsToRaw, run, ffprobeOf, tempDir, repoUrl,
} from "../../server/test/c10a-kit.mjs";

const muxer = await findMuxer();
if (muxer?.error) {
  test("C10A-MP4-00 The muxer loads in node", () => { assert.fail(`${muxer.file} exports a muxer but it cannot be loaded: ${muxer.error?.stack ?? muxer.error}`); });
}
const { findFfmpeg } = await import(repoUrl("server/bakery/ffmpeg.mjs"));
const ffmpeg = await findFfmpeg().catch(() => null);
const skip = skipIf(!muxer?.make, "MP4 muxer under src/export/ (K5)") || (ffmpeg ? false : "ffmpeg is not installed on this machine");
const it = (name, fn) => test(name, { skip }, fn);

const DIR = tempDir("pc-c10a-mp4-");
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

/** ffmpeg produces H.264 Annex B: no B-frames, one slice per frame, fixed GOP */
async function h264({ w, h, fps, seconds, gop, name }) {
  const out = path.join(DIR, `${name}.h264`);
  await run(ffmpeg, ["-y", "-hide_banner", "-v", "error", "-f", "lavfi", "-i", `testsrc2=size=${w}x${h}:rate=${fps}`, "-t", String(seconds),
    "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-bf", "0", "-g", String(gop), "-keyint_min", String(gop), "-sc_threshold", "0",
    "-x264-params", "slices=1:sliced-threads=0", "-f", "h264", out]);
  return { file: out, ...annexBToAvcc(fs.readFileSync(out)) };
}

async function aac({ seconds, rate = 48000, channels = 2, name }) {
  const out = path.join(DIR, `${name}.aac`);
  await run(ffmpeg, ["-y", "-hide_banner", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=${rate}`, "-t", String(seconds),
    "-ac", String(channels), "-c:a", "aac", "-b:a", "96k", "-f", "adts", out]);
  return adtsToRaw(fs.readFileSync(out));
}

/** Feed the muxer in WebCodecs style, returning output file path */
async function mux({ video, audio, w, h, fps, name }) {
  const m = muxer.make({
    video: { codec: "avc", width: w, height: h, frameRate: fps },
    ...(audio ? { audio: { codec: "aac", sampleRate: audio.sampleRate, numberOfChannels: audio.channels } } : {}),
    fastStart: "in-memory",
  });
  const frameUs = 1e6 / fps;
  const aFrameUs = audio ? (1024 * 1e6) / audio.sampleRate : 0;
  // Interleaved feeding: in timestamp order, simulating muxing while encoding
  const events = [];
  video.samples.forEach((s, i) => events.push({ kind: "v", i, ts: Math.round(i * frameUs) }));
  audio?.frames.forEach((f, i) => events.push({ kind: "a", i, ts: Math.round(i * aFrameUs) }));
  events.sort((a, b) => a.ts - b.ts || (a.kind === "v" ? -1 : 1));
  for (const e of events) {
    if (e.kind === "v") {
      const s = video.samples[e.i];
      const chunk = fakeChunk({ type: s.key ? "key" : "delta", timestamp: e.ts, duration: Math.round(frameUs), data: s.data });
      const meta = e.i === 0 ? { decoderConfig: { codec: video.codec, codedWidth: w, codedHeight: h, description: new Uint8Array(video.avcC) } } : undefined;
      await m.addVideoChunk(chunk, meta);
    } else {
      const chunk = fakeChunk({ type: "key", timestamp: e.ts, duration: Math.round(aFrameUs), data: audio.frames[e.i] });
      const meta = e.i === 0 ? { decoderConfig: { codec: "mp4a.40.2", sampleRate: audio.sampleRate, numberOfChannels: audio.channels, description: new Uint8Array(audio.asc) } } : undefined;
      await m.addAudioChunk(chunk, meta);
    }
  }
  const bytes = await muxerBytes(m, m.finalize());
  const file = path.join(DIR, `${name}.mp4`);
  fs.writeFileSync(file, bytes);
  return file;
}

async function probe(file) {
  const { out } = await run(ffprobeOf(ffmpeg), ["-v", "error", "-count_packets", "-show_streams", "-show_format", "-of", "json", file]);
  const j = JSON.parse(out);
  return { video: j.streams.find((s) => s.codec_type === "video"), audio: j.streams.find((s) => s.codec_type === "audio"), streams: j.streams, format: j.format };
}

/** Decoded per-frame md5 (`-f framemd5`), keeping only the hash column */
async function frameMd5(file, fmt = []) {
  const { out } = await run(ffmpeg, ["-v", "error", ...fmt, "-i", file, "-map", "0:v:0", "-f", "framemd5", "-"]);
  return out.split(/\r?\n/).filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").at(-1).trim());
}

/** Decode the entire video; no errors allowed in stderr */
async function decodesClean(file) {
  const { err } = await run(ffmpeg, ["-v", "error", "-i", file, "-f", "null", "-"]);
  assert.equal(err.trim(), "", `Decode errors: ${err.slice(0, 600)}`);
}

/** Top-level box types (test's own parsing) */
function topBoxes(file) {
  const buf = fs.readFileSync(file);
  const types = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(off + 8));
    else if (size === 0) size = buf.length - off;
    if (size < 8) break;
    types.push(type);
    off += size;
  }
  return { types, end: off, length: buf.length };
}

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} and ${b} differ by more than ${tol}`);

it("C10A-MP4-01 Video only: ffprobe can read it, H.264, dimensions, 30 frames, 1 second, 30 fps; decodes without errors and matches the source stream frame by frame", async () => {
  const w = 320, h = 240, fps = 30;
  const video = await h264({ w, h, fps, seconds: 1, gop: 15, name: "v30" });
  assert.equal(video.samples.length, 30, "The samples themselves are 30 frames");
  const file = await mux({ video, w, h, fps, name: "v30" });
  const box = topBoxes(file);
  assert.equal(box.types[0], "ftyp", `First box: ${box.types}`);
  assert.ok(box.types.includes("moov") && box.types.includes("mdat"), `box: ${box.types}`);
  assert.equal(box.end, box.length, "The boxes exactly fill the file");
  const p = await probe(file);
  assert.equal(p.streams.length, 1, "Only one track");
  assert.equal(p.video.codec_name, "h264");
  assert.equal(p.video.width, w);
  assert.equal(p.video.height, h);
  assert.equal(Number(p.video.nb_read_packets), 30, "Frame count");
  near(Number(p.format.duration), 1.0, 1 / fps + 0.001, "Duration");
  const [n, d] = p.video.avg_frame_rate.split("/").map(Number);
  near(n / d, fps, 0.05, "Frame rate");
  await decodesClean(file);
  assert.deepEqual(await frameMd5(file), await frameMd5(video.file, ["-f", "h264"]), "The decoded picture matches the source stream frame by frame");
});

it("C10A-MP4-02 Video + AAC: two tracks, H.264 and AAC (48 kHz stereo), audio and video durations both about 2 seconds", async () => {
  const w = 640, h = 360, fps = 30;
  const video = await h264({ w, h, fps, seconds: 2, gop: 30, name: "av" });
  const audio = await aac({ seconds: 2, name: "av" });
  const file = await mux({ video, audio, w, h, fps, name: "av" });
  const p = await probe(file);
  assert.equal(p.streams.length, 2);
  assert.equal(p.video.codec_name, "h264");
  assert.equal(Number(p.video.nb_read_packets), 60);
  assert.equal(p.audio.codec_name, "aac");
  assert.equal(p.audio.profile, "LC");
  assert.equal(Number(p.audio.sample_rate), 48000);
  assert.equal(Number(p.audio.channels), 2);
  assert.equal(Number(p.audio.nb_read_packets), audio.frames.length, "Not a single AAC frame is missing");
  near(Number(p.video.duration), 2.0, 1 / fps + 0.001, "Video duration");
  near(Number(p.audio.duration), audio.frames.length * 1024 / 48000, 0.03, "Audio duration");
  near(Number(p.format.duration), 2.0, 0.1, "File duration");
  await decodesClean(file);
});

it("C10A-MP4-03 25 fps, GOP 10: keyframes land on frames 0, 10, 20…, frame count 50, duration 2 seconds", async () => {
  const w = 320, h = 180, fps = 25;
  const video = await h264({ w, h, fps, seconds: 2, gop: 10, name: "k25" });
  const file = await mux({ video, w, h, fps, name: "k25" });
  const { out } = await run(ffprobeOf(ffmpeg), ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", file]);
  const packets = out.trim().split(/\r?\n/).map((l) => { const [t, flags] = l.split(","); return { t: Number(t), key: flags.includes("K") }; });
  assert.equal(packets.length, 50);
  assert.deepEqual(packets.map((p, i) => (p.key ? i : -1)).filter((i) => i >= 0), [0, 10, 20, 30, 40], "Keyframes match what the encoder reported");
  packets.forEach((p, i) => near(p.t, i / fps, 0.002, `Timestamp of frame ${i}`));
  const p = await probe(file);
  near(Number(p.format.duration), 2.0, 1 / fps + 0.001, "Duration");
  await decodesClean(file);
});

it("C10A-MP4-04 60 fps half a second: 30 frames, 0.5 seconds (timestamps at high frame rates do not drift)", async () => {
  const w = 256, h = 144, fps = 60;
  const video = await h264({ w, h, fps, seconds: 0.5, gop: 60, name: "v60" });
  const file = await mux({ video, w, h, fps, name: "v60" });
  const p = await probe(file);
  assert.equal(Number(p.video.nb_read_packets), 30);
  near(Number(p.format.duration), 0.5, 1 / fps + 0.001, "Duration");
  const [n, d] = p.video.avg_frame_rate.split("/").map(Number);
  near(n / d, fps, 0.1, "Frame rate");
  await decodesClean(file);
});

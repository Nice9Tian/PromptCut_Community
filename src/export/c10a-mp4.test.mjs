/**
 * C10a 在线页面逐帧导出的 MP4 封装器（`docs/plan/c10a-contract.md` 第 11 节〔裁〕「自写最小封装器」、第 12 节「MP4 封装」）。
 * 跑：node --test src/export/c10a-mp4.test.mjs
 *
 * 编码不在测试范围里（浏览器的 VideoEncoder / AudioEncoder）：样本由 ffmpeg 现场编成 H.264 Annex B 与 AAC ADTS，
 * 测试自己拆成 WebCodecs 交给封装器的形状（AVCC 长度前缀的访问单元 + avcC；去掉 ADTS 头的 AAC 帧 + AudioSpecificConfig），
 * 喂给封装器，产物用 ffprobe / ffmpeg 核对：读得出、帧数、时长、编码、关键帧，解出来的画面与源码流逐帧相同。
 *
 * 封装器的名字与调用约定见 `server/test/c10a-kit.mjs` 的 K5；`src/export/` 下找不到时整组 skip。
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
  test("C10A-MP4-00 封装器载得进 node", () => { assert.fail(`${muxer.file} 导出了封装器却载不进来：${muxer.error?.stack ?? muxer.error}`); });
}
const { findFfmpeg } = await import(repoUrl("server/bakery/ffmpeg.mjs"));
const ffmpeg = await findFfmpeg().catch(() => null);
const skip = skipIf(!muxer?.make, "src/export/ 下的 MP4 封装器（K5）") || (ffmpeg ? false : "本机没有 ffmpeg");
const it = (name, fn) => test(name, { skip }, fn);

const DIR = tempDir("pc-c10a-mp4-");
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

/** ffmpeg 出 H.264 Annex B：没有 B 帧、一帧一个 slice、固定 GOP */
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

/** 按 WebCodecs 的方式喂封装器，回产物文件路径 */
async function mux({ video, audio, w, h, fps, name }) {
  const m = muxer.make({
    video: { codec: "avc", width: w, height: h, frameRate: fps },
    ...(audio ? { audio: { codec: "aac", sampleRate: audio.sampleRate, numberOfChannels: audio.channels } } : {}),
    fastStart: "in-memory",
  });
  const frameUs = 1e6 / fps;
  const aFrameUs = audio ? (1024 * 1e6) / audio.sampleRate : 0;
  // 交错喂：按时间戳先后，模拟边编边封
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

/** 解码出来的每帧 md5（`-f framemd5`），只留哈希列 */
async function frameMd5(file, fmt = []) {
  const { out } = await run(ffmpeg, ["-v", "error", ...fmt, "-i", file, "-map", "0:v:0", "-f", "framemd5", "-"]);
  return out.split(/\r?\n/).filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").at(-1).trim());
}

/** 解码全片，stderr 里不许有错误 */
async function decodesClean(file) {
  const { err } = await run(ffmpeg, ["-v", "error", "-i", file, "-f", "null", "-"]);
  assert.equal(err.trim(), "", `解码有错误：${err.slice(0, 600)}`);
}

/** 顶层 box 类型（测试自己的解析） */
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

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}：${a} 与 ${b} 相差超过 ${tol}`);

it("C10A-MP4-01 只有视频：ffprobe 读得出，H.264、尺寸、30 帧、1 秒、30 fps；解码无错、逐帧与源码流相同", async () => {
  const w = 320, h = 240, fps = 30;
  const video = await h264({ w, h, fps, seconds: 1, gop: 15, name: "v30" });
  assert.equal(video.samples.length, 30, "样本本身是 30 帧");
  const file = await mux({ video, w, h, fps, name: "v30" });
  const box = topBoxes(file);
  assert.equal(box.types[0], "ftyp", `第一个 box：${box.types}`);
  assert.ok(box.types.includes("moov") && box.types.includes("mdat"), `box：${box.types}`);
  assert.equal(box.end, box.length, "box 恰好铺满文件");
  const p = await probe(file);
  assert.equal(p.streams.length, 1, "只有一条轨");
  assert.equal(p.video.codec_name, "h264");
  assert.equal(p.video.width, w);
  assert.equal(p.video.height, h);
  assert.equal(Number(p.video.nb_read_packets), 30, "帧数");
  near(Number(p.format.duration), 1.0, 1 / fps + 0.001, "时长");
  const [n, d] = p.video.avg_frame_rate.split("/").map(Number);
  near(n / d, fps, 0.05, "帧率");
  await decodesClean(file);
  assert.deepEqual(await frameMd5(file), await frameMd5(video.file, ["-f", "h264"]), "解出来的画面与源码流逐帧相同");
});

it("C10A-MP4-02 视频 + AAC：两条轨，H.264 与 AAC（48 kHz 双声道），音视频时长都约 2 秒", async () => {
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
  assert.equal(Number(p.audio.nb_read_packets), audio.frames.length, "AAC 帧一个不少");
  near(Number(p.video.duration), 2.0, 1 / fps + 0.001, "视频时长");
  near(Number(p.audio.duration), audio.frames.length * 1024 / 48000, 0.03, "音频时长");
  near(Number(p.format.duration), 2.0, 0.1, "文件时长");
  await decodesClean(file);
});

it("C10A-MP4-03 25 fps、GOP 10：关键帧落在第 0、10、20… 帧，帧数 50、时长 2 秒", async () => {
  const w = 320, h = 180, fps = 25;
  const video = await h264({ w, h, fps, seconds: 2, gop: 10, name: "k25" });
  const file = await mux({ video, w, h, fps, name: "k25" });
  const { out } = await run(ffprobeOf(ffmpeg), ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", file]);
  const packets = out.trim().split(/\r?\n/).map((l) => { const [t, flags] = l.split(","); return { t: Number(t), key: flags.includes("K") }; });
  assert.equal(packets.length, 50);
  assert.deepEqual(packets.map((p, i) => (p.key ? i : -1)).filter((i) => i >= 0), [0, 10, 20, 30, 40], "关键帧与编码器给的一致");
  packets.forEach((p, i) => near(p.t, i / fps, 0.002, `第 ${i} 帧的时间戳`));
  const p = await probe(file);
  near(Number(p.format.duration), 2.0, 1 / fps + 0.001, "时长");
  await decodesClean(file);
});

it("C10A-MP4-04 60 fps 半秒：30 帧、0.5 秒（高帧率的时间戳不漂）", async () => {
  const w = 256, h = 144, fps = 60;
  const video = await h264({ w, h, fps, seconds: 0.5, gop: 60, name: "v60" });
  const file = await mux({ video, w, h, fps, name: "v60" });
  const p = await probe(file);
  assert.equal(Number(p.video.nb_read_packets), 30);
  near(Number(p.format.duration), 0.5, 1 / fps + 0.001, "时长");
  const [n, d] = p.video.avg_frame_rate.split("/").map(Number);
  near(n / d, fps, 0.1, "帧率");
  await decodesClean(file);
});

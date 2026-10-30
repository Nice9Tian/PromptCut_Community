/**
 * 轨道流分段封装的单测。跑:node --test src/render/streamMux.test.mjs
 *
 * 三件事:
 *   1. 封出来的初始化段、分段,页面侧的解封装(`streamPlayer.ts`)读得回来,样本逐字节相同;
 *   2. 服务端核对分段用的那几个函数(`server/frame-stream.mjs`)也认;
 *   3. 用 ffmpeg 造一段真的 H.264,封装后 ffprobe 读得出、帧数对(没有 ffmpeg 的机器跳过并报原因)。
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

test('分段帧数:页面、服务端、封装三处是同一个数', () => {
  assert.equal(SEGMENT_FRAMES, 15);
  assert.equal(STREAM_SEGMENT_FRAMES, SEGMENT_FRAMES);
});

test('初始化段:页面侧读得回编码串、参数集和宽高', () => {
  const init = buildStreamInit({ width: 1920, height: 2176, fps: 30, avcC: AVCC });
  const got = parseInit(ab(init));
  assert.equal(got.codec, 'avc1.640032');
  assert.equal(got.codec, codecOfAvcC(AVCC));
  assert.deepEqual([...got.description], [...AVCC]);
  assert.equal(got.width, 1920);
  assert.equal(got.height, 2176);
  assert.deepEqual(topLevelBoxes(Buffer.from(init)).map((b) => b.type), ['ftyp', 'moov']);
});

test('初始化段:服务端读得出编码串、宽高与时间刻度(= fps)', () => {
  const info = initInfo(Buffer.from(buildStreamInit({ width: 704, height: 864, fps: 25, avcC: AVCC })));
  assert.deepEqual(info, { codec: 'avc1.640032', width: 704, height: 864, timescale: 25 });
});

test('分段:页面侧读回的样本与送进去的逐字节相同,关键帧标对', () => {
  const samples = Array.from({ length: SEGMENT_FRAMES }, (_, i) => ({ data: sample(40 + i * 7, i + 1), isSync: i === 0 }));
  const seg = buildStreamSegment({ sequence: 3, baseDecodeTime: 2 * SEGMENT_FRAMES, samples });
  const table = parseSegment(ab(seg));
  assert.equal(table.length, SEGMENT_FRAMES);
  table.forEach((s, i) => {
    assert.equal(s.size, samples[i].data.length, `第 ${i} 个样本的大小`);
    assert.equal(s.isSync, i === 0, `第 ${i} 个样本是不是关键帧`);
    assert.deepEqual([...seg.subarray(s.offset, s.offset + s.size)], [...samples[i].data], `第 ${i} 个样本的字节`);
  });
  assert.deepEqual(topLevelBoxes(Buffer.from(seg)).map((b) => b.type), ['moof', 'mdat']);
});

test('分段:服务端的核对函数认(一个 moof、样本数对、段首是关键帧)', () => {
  const samples = Array.from({ length: 7 }, (_, i) => ({ data: sample(30 + i, 9), isSync: i === 0 }));
  assert.deepEqual(segmentInfo(Buffer.from(buildStreamSegment({ sequence: 1, baseDecodeTime: 0, samples }))), { moofs: 1, sampleCount: 7, firstSampleIsSync: true });
});

test('初始化段加若干分段拼在一起,服务端的拆分函数拆得回原样', () => {
  const init = buildStreamInit({ width: 320, height: 656, fps: 30, avcC: AVCC });
  const segs = [0, 1, 2].map((n) => buildStreamSegment({ sequence: n + 1, baseDecodeTime: n * SEGMENT_FRAMES, samples: Array.from({ length: SEGMENT_FRAMES }, (_, i) => ({ data: sample(20 + n + i, n + 1), isSync: i === 0 })) }));
  const whole = Buffer.concat([Buffer.from(init), ...segs.map((s) => Buffer.from(s))]);
  const split = splitFmp4(whole);
  assert.deepEqual([...split.init], [...init]);
  assert.equal(split.segments.length, 3);
  split.segments.forEach((s, n) => assert.deepEqual([...s], [...segs[n]]));
  assert.deepEqual(split.dropped, []);
});

test('样本标志的两个取值:关键帧不带「非同步」位,其余带', () => {
  assert.equal(SAMPLE_FLAGS_SYNC & 0x00010000, 0);
  assert.notEqual(SAMPLE_FLAGS_NON_SYNC & 0x00010000, 0);
});

test('拒收:段首不是关键帧、空分段、空样本、坏的 avcC、奇怪的宽高', () => {
  const ok = { data: sample(16, 1), isSync: true };
  assert.throws(() => buildStreamSegment({ sequence: 1, baseDecodeTime: 0, samples: [{ ...ok, isSync: false }] }), /关键帧/);
  assert.throws(() => buildStreamSegment({ sequence: 1, baseDecodeTime: 0, samples: [] }), /没有样本/);
  assert.throws(() => buildStreamSegment({ sequence: 1, baseDecodeTime: 0, samples: [ok, { data: new Uint8Array(0), isSync: false }] }), /空的/);
  assert.throws(() => buildStreamSegment({ sequence: 0, baseDecodeTime: 0, samples: [ok] }), /sequence/);
  assert.throws(() => buildStreamSegment({ sequence: 1, baseDecodeTime: -1, samples: [ok] }), /baseDecodeTime/);
  assert.throws(() => buildStreamInit({ width: 320, height: 656, fps: 30, avcC: new Uint8Array([0, 1, 2]) }), /avcC/);
  assert.throws(() => buildStreamInit({ width: 0, height: 656, fps: 30, avcC: AVCC }), /width/);
  assert.throws(() => buildStreamInit({ width: 70000, height: 656, fps: 30, avcC: AVCC }), /宽高/);
});

/* ---------------------------------------------------------------- 真的 H.264:ffmpeg 造、ffprobe 读 */

let ffmpeg = null;
try { ffmpeg = await (await import('../../server/bakery/ffmpeg.mjs')).findFfmpeg(); } catch { ffmpeg = null; }
const ffprobe = ffmpeg ? ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe')) : null;
const skip = ffmpeg && ffprobe && spawnSync(ffprobe, ['-version'], { windowsHide: true }).status === 0 ? false : '这台机器找不到 ffmpeg / ffprobe';

/** Annex B(起始码分隔)→ NAL 单元 */
function nalUnits(buf) {
  const starts = [];
  for (let i = 0; i + 3 <= buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) { starts.push({ at: i + 3, code: i > 0 && buf[i - 1] === 0 ? i - 1 : i }); i += 2; }
  }
  return starts.map((s, k) => buf.subarray(s.at, k + 1 < starts.length ? starts[k + 1].code : buf.length));
}

test('真的 H.264:两段各 15 帧,封装后 ffprobe 读出 30 帧、宽高与编码对', { skip }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-streammux-'));
  try {
    const W = 320, H = 2 * 160 + 16, FPS = 30, FRAMES = 2 * SEGMENT_FRAMES;
    const raw = path.join(tmp, 'a.h264');
    const made = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=${W}x${H}:rate=${FPS}`, '-frames:v', String(FRAMES),
      '-c:v', 'libx264', '-preset', 'veryfast', '-g', String(SEGMENT_FRAMES), '-keyint_min', String(SEGMENT_FRAMES), '-sc_threshold', '0', '-bf', '0',
      '-x264-params', 'aud=1', '-pix_fmt', 'yuv420p', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', raw], { windowsHide: true });
    assert.equal(made.status, 0, String(made.stderr));

    // 按访问单元分隔符(类型 9)切帧;参数集(7、8)抽出来拼 avcC,样本里只留图像数据,改成长度前缀
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
    assert.equal(frames.length, FRAMES, '切出来的帧数');
    assert.ok(sps && pps, '码流里有参数集');
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
    assert.equal(probe.stderr.trim(), '', 'ffprobe 没有报任何错');
    const stream = JSON.parse(probe.stdout).streams[0];
    assert.equal(stream.codec_name, 'h264');
    assert.equal(stream.width, W);
    assert.equal(stream.height, H);
    assert.equal(Number(stream.nb_read_frames), FRAMES);
    assert.equal(stream.r_frame_rate, `${FPS}/1`);

    // 单独一段配上初始化段也解得出(播放器就是一段一段取的)
    const one = path.join(tmp, 'one.mp4');
    fs.writeFileSync(one, Buffer.concat([Buffer.from(init), Buffer.from(segs[1])]));
    const p2 = spawnSync(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', one], { encoding: 'utf8', windowsHide: true });
    assert.equal(p2.status, 0, p2.stderr);
    assert.equal(Number(p2.stdout.trim().replace(/,$/, '')), SEGMENT_FRAMES);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

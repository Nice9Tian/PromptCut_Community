/**
 * C6.6 两档生成（`docs/plan/c66-design.md` 第 2 节、第 8 节「素材小尺寸命令」「faststart 判定」，验收 T1、T6 的生成一侧）。
 * 跑：node --test server/test/c66-tiers.test.mjs
 *
 * 只照设计稿写，没看实现。被测模块的名字与形状是假设 K1（见 `c66-kit.mjs` 文件头）。
 * 样本用 ffmpeg 现场生成（1080p 2 s、晚置 moov、ProRes、MKV、120 fps、奇数尺寸、显示旋转、无音轨、图片、音频）。
 * 检查一律用测试自己的办法（ffprobe、自写的顶层 box 解析、按流包数据 md5），不用被测模块的判定。
 * 被测模块不存在时每条用例各自失败、报原因。
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
  if (samplesError) assert.fail(`样本生成失败（本机 ffmpeg？）：${samplesError.message}`);
  return S;
}
let seq = 0;
const work = () => { const d = path.join(DIR, `w${++seq}`); fs.mkdirSync(d, { recursive: true }); return d; };
const fpsOf = (s) => { const [a, b] = String(s || '0/1').split('/').map(Number); return b ? a / b : 0; };

/** 素材小尺寸的共同要求：≤ 800×600、偶数、H.264、yuv420p、mp4 容器、faststart */
function assertSmallBasics(p, file, what) {
  assert.ok(p.video, `${what}：素材小尺寸要有视频流`);
  assert.equal(p.video.codec_name, 'h264', `${what}：素材小尺寸是 H.264`);
  assert.equal(p.video.pix_fmt, 'yuv420p', `${what}：素材小尺寸是 yuv420p`);
  const { width: w, height: h } = p.video;
  assert.ok(w <= 800 && h <= 600, `${what}：素材小尺寸 ${w}×${h} 要在 800×600 以内`);
  assert.equal(w % 2, 0, `${what}：宽 ${w} 要是偶数`);
  assert.equal(h % 2, 0, `${what}：高 ${h} 要是偶数`);
  assert.match(p.format.format_name, /mp4|mov/, `${what}：素材小尺寸是 mp4 容器`);
  assert.equal(boxFaststart(file), true, `${what}：素材小尺寸带 faststart（moov 在 mdat 前）`);
}

async function small(input, what) {
  const tiers = await loadTiers();
  const output = path.join(work(), 'small.mp4');
  await tiers.makeSmall({ ffmpeg: await ffmpeg(), input, output });
  assert.ok(fs.existsSync(output), `${what}：makeSmallTier 要把素材小尺寸写到 output`);
  const p = await probe(output);
  assertSmallBasics(p, output, what);
  return { p, output };
}

// ------------------------------------------------------------------ T1 素材小尺寸参数

test('C66-T1-01 1080p → 素材小尺寸 ≤ 800×600 偶数、H.264 yuv420p、faststart、等比、帧率跟素材原尺寸、AAC 约 64k', async () => {
  const s = samples();
  const { p } = await small(s.hd, '1080p');
  const { width: w, height: h } = p.video;
  assert.ok(Math.abs(w / h - 16 / 9) < 0.02, `等比缩放：${w}×${h}`);
  assert.ok(w >= 796 || h >= 596, `缩到贴边（800×600 以内尽量大）：${w}×${h}`);
  assert.ok(Math.abs(fpsOf(p.video.avg_frame_rate) - 30) < 0.5, `帧率跟素材原尺寸 30：${p.video.avg_frame_rate}`);
  assert.ok(p.audio, '源有音轨，素材小尺寸要带音轨');
  assert.equal(p.audio.codec_name, 'aac', '素材小尺寸音轨是 AAC');
  const br = Number(p.audio.bit_rate);
  assert.ok(br > 0 && br <= 80_000, `素材小尺寸音频码率约 64k：${br}`);
});

test('C66-T1-02 120 fps、无音轨 → 素材小尺寸帧率上限 60；没有音轨也能生成（-map 0:a:0?）', async () => {
  const s = samples();
  const { p, output } = await small(s.fps120, '120fps');
  const fps = fpsOf(p.video.avg_frame_rate);
  assert.ok(fps <= 61, `帧率上限 60（VFR 的平均帧率按时间戳算，留 1 帧余量）：${p.video.avg_frame_rate}`);
  const n = await videoPackets(output);
  assert.ok(n <= 62 && n >= 50, `1 s 的 120 fps 源抽到约 60 帧：${n}`);
  assert.equal(p.audio, undefined, '源没音轨，素材小尺寸也没有');
});

test('C66-T1-03 源已在 800×600 以内（640×360）→ 不放大', async () => {
  const s = samples();
  const { p } = await small(s.noAudio, '640x360');
  assert.equal(p.video.width, 640);
  assert.equal(p.video.height, 360);
});

test('C66-T1-04 奇数尺寸 1001×777、yuv444p → 素材小尺寸偶数尺寸、yuv420p、等比', async () => {
  const s = samples();
  const { p } = await small(s.odd, '1001x777');
  const { width: w, height: h } = p.video;
  assert.ok(Math.abs(w / h - 1001 / 777) < 0.02, `等比：${w}×${h}`);
});

test('C66-T1-05 显示旋转 90° 的 1080p → 旋转落进像素（-autorotate），素材小尺寸是竖的、不再带旋转', async () => {
  const s = samples();
  const { p } = await small(s.portrait, '旋转');
  const { width: w, height: h } = p.video;
  assert.ok(h > w, `竖画面：${w}×${h}`);
  assert.ok(Math.abs(w / h - 1080 / 1920) < 0.02, `等比：${w}×${h}`);
  const rot = (p.video.side_data_list ?? []).find((d) => 'rotation' in d)?.rotation ?? 0;
  assert.equal(Number(rot) % 360, 0, `素材小尺寸不再带显示旋转：${rot}`);
});

// ------------------------------------------------------------------ T1 faststart 判定

test('C66-T1-06 faststart 判定按顶层 box 顺序：前置 moov → true，晚置 → false，MKV / 图片 → 不适用（null）', async () => {
  const s = samples();
  const { hasFaststart } = await loadTiers();
  assert.equal(await hasFaststart(s.hd), true, 'hd.mp4 前置 moov');
  assert.equal(await hasFaststart(s.lateMoov), false, 'late.mp4 晚置 moov');
  assert.equal(await hasFaststart(s.prores), false, 'ProRes MOV（mov 缺省晚置 moov）');
  assert.equal(await hasFaststart(s.mkv), null, 'MKV 不处理');
});

test('C66-T1-07 faststart 判定是逐个跳读顶层 box：64 位 largesize、size 0 到文件尾、mdat 里夹着 "moov" 字样都判对', async () => {
  const { hasFaststart } = await loadTiers();
  const d = work();
  const box = (type, payload = Buffer.alloc(0)) => {
    const h = Buffer.alloc(8);
    h.writeUInt32BE(8 + payload.length, 0);
    h.write(type, 4, 'latin1');
    return Buffer.concat([h, payload]);
  };
  const ftyp = box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2', 'latin1'));
  // mdat 用 64 位 largesize，后面才是 moov
  const large = Buffer.alloc(16 + 8);
  large.writeUInt32BE(1, 0); large.write('mdat', 4, 'latin1'); large.writeBigUInt64BE(24n, 8);
  const f1 = path.join(d, 'large.mp4');
  fs.writeFileSync(f1, Buffer.concat([ftyp, large, box('moov', Buffer.alloc(8))]));
  assert.equal(await hasFaststart(f1), false, 'largesize 的 mdat 在 moov 前');
  // moov 在前，mdat 的 size = 0（到文件尾）
  const zero = Buffer.alloc(8 + 32); zero.writeUInt32BE(0, 0); zero.write('mdat', 4, 'latin1');
  const f2 = path.join(d, 'zero.mp4');
  fs.writeFileSync(f2, Buffer.concat([ftyp, box('moov', Buffer.alloc(8)), zero]));
  assert.equal(await hasFaststart(f2), true, 'moov 在前、mdat 到文件尾');
  // mdat 的负载里出现 "moov" 四个字：只按 box 跳读才判得对
  const f3 = path.join(d, 'fake.mp4');
  fs.writeFileSync(f3, Buffer.concat([ftyp, box('mdat', Buffer.from('xxxx\0\0\0\x08moovyyyy', 'latin1')), box('moov', Buffer.alloc(8))]));
  assert.equal(await hasFaststart(f3), false, 'mdat 负载里的 "moov" 字样不算');
});

// ------------------------------------------------------------------ T1 素材原尺寸：只重封装

test('C66-T1-08 ensureFaststart：已有 faststart 不动；晚置 moov 重封装成新文件（编码不变、源文件不动）；MKV 不处理', async () => {
  const s = samples();
  const { ensureFaststart } = await loadTiers();
  const f = await ffmpeg();

  const a = await ensureFaststart({ ffmpeg: f, input: s.hd, workDir: work() });
  assert.equal(path.resolve(a.path), path.resolve(s.hd), '已有 faststart：原样用源文件');
  assert.equal(a.remuxed, false);

  const before = sha256File(s.lateMoov);
  const b = await ensureFaststart({ ffmpeg: f, input: s.lateMoov, workDir: work() });
  assert.equal(b.remuxed, true, '晚置 moov 要重封装');
  assert.notEqual(path.resolve(b.path), path.resolve(s.lateMoov), '重封装写新文件，不覆盖源文件');
  assert.equal(sha256File(s.lateMoov), before, '源文件一个字节不变');
  assert.equal(boxFaststart(b.path), true, '重封装后 moov 在 mdat 前');
  assert.deepEqual(await streamHashes(b.path), await streamHashes(s.lateMoov), '每条流的包数据一致（只挪 moov，不转码）');

  const c = await ensureFaststart({ ffmpeg: f, input: s.mkv, workDir: work() });
  assert.equal(path.resolve(c.path), path.resolve(s.mkv), 'MKV 不处理');
  assert.equal(c.remuxed, false);
});

test('C66-T1-09 重封装失败（ffmpeg 起不来 / 出错）→ 不抛，保留源文件当素材原尺寸', async () => {
  const s = samples();
  const { ensureFaststart } = await loadTiers();
  const before = sha256File(s.lateMoov);
  // 拿 node 当 ffmpeg：它不认 ffmpeg 的参数，必然非零退出
  const r = await ensureFaststart({ ffmpeg: process.execPath, input: s.lateMoov, workDir: work() });
  assert.equal(path.resolve(r.path), path.resolve(s.lateMoov), '失败时素材原尺寸就是源文件');
  assert.equal(r.remuxed, false);
  assert.equal(sha256File(s.lateMoov), before, '源文件不动');
  const r2 = await ensureFaststart({ ffmpeg: path.join(DIR, 'no-such-ffmpeg.exe'), input: s.lateMoov, workDir: work() });
  assert.equal(path.resolve(r2.path), path.resolve(s.lateMoov), 'ffmpeg 不存在时同样保留源文件');
});

// ------------------------------------------------------------------ T1 整条：tiers 两个哈希

test('C66-T1-10 prepareTiers（已 faststart 的 1080p）：素材原尺寸就是源文件字节、素材小尺寸另一哈希；两个哈希都是文件的 sha256', async () => {
  const s = samples();
  const { prepare } = await loadTiers();
  const r = await prepare({ ffmpeg: await ffmpeg(), input: s.hd, kind: 'video', workDir: work() });
  assert.match(r.original.hash, HEX64);
  assert.equal(r.original.hash, sha256File(r.original.path), 'original.hash 是它文件的 sha256');
  assert.equal(r.original.hash, sha256File(s.hd), '不转码、不需重封装：素材原尺寸字节与源文件相同');
  assert.ok(r.small, '视频要有素材小尺寸');
  assert.match(r.small.hash, HEX64);
  assert.equal(r.small.hash, sha256File(r.small.path), 'small.hash 是它文件的 sha256');
  assert.notEqual(r.small.hash, r.original.hash);
  assertSmallBasics(await probe(r.small.path), r.small.path, 'prepareTiers 的素材小尺寸');
  const keys = Object.keys(r).filter((k) => r[k] !== undefined).sort();
  assert.deepEqual(keys.filter((k) => !['original', 'small'].includes(k)), [], `回包只有两档，没有同步状态之类的字段：${keys}`);
});

test('C66-T1-11 prepareTiers（晚置 moov）：素材原尺寸 = 重封装结果、按它的哈希；编码与源文件相同', async () => {
  const s = samples();
  const { prepare } = await loadTiers();
  const r = await prepare({ ffmpeg: await ffmpeg(), input: s.lateMoov, kind: 'video', workDir: work() });
  assert.notEqual(r.original.hash, sha256File(s.lateMoov), '重封装的结果算新的素材原尺寸');
  assert.equal(r.original.hash, sha256File(r.original.path));
  assert.equal(boxFaststart(r.original.path), true);
  assert.deepEqual(await streamHashes(r.original.path), await streamHashes(s.lateMoov), '素材原尺寸编码不变');
  const [po, ps] = [await probe(r.original.path), await probe(s.lateMoov)];
  for (const k of ['codec_name', 'profile', 'width', 'height', 'pix_fmt']) assert.equal(po.video[k], ps.video[k], `素材原尺寸 ${k} 与源相同`);
  assert.ok(r.small, '要有素材小尺寸');
});

test('C66-T1-12 只对视频做：图片、音频没有素材小尺寸', async () => {
  const s = samples();
  const { prepare } = await loadTiers();
  const f = await ffmpeg();
  const img = await prepare({ ffmpeg: f, input: s.png, kind: 'image', workDir: work() });
  assert.equal(img.small, undefined, '图片不生成素材小尺寸');
  assert.equal(img.original.hash, sha256File(s.png), '图片原样入库');
  const aud = await prepare({ ffmpeg: f, input: s.m4a, kind: 'audio', workDir: work() });
  assert.equal(aud.small, undefined, '音频不生成素材小尺寸');
  assert.equal(aud.original.hash, sha256File(aud.original.path));
});

// ------------------------------------------------------------------ T6 生成一侧：ProRes

test('C66-T6-01 ProRes MOV：素材原尺寸不转码（仍是 ProRes、包数据相同），另有 H.264 素材小尺寸', async () => {
  const s = samples();
  const { prepare } = await loadTiers();
  const r = await prepare({ ffmpeg: await ffmpeg(), input: s.prores, kind: 'video', workDir: work() });
  const po = await probe(r.original.path);
  assert.equal(po.video.codec_name, 'prores', '素材原尺寸仍是 ProRes');
  assert.deepEqual(await streamHashes(r.original.path), await streamHashes(s.prores), '素材原尺寸编码不变');
  assert.ok(r.small, '要有素材小尺寸');
  assertSmallBasics(await probe(r.small.path), r.small.path, 'ProRes 的素材小尺寸');
});

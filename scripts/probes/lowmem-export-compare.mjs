/**
 * 浏览器逐帧导出与桌面导出逐帧比(`docs/plan/c10a-contract.md` 第 12 节「和桌面导出逐帧比,误差范围在报告里写明」)。
 *
 *   node scripts/probes/lowmem-export-compare.mjs --origin http://127.0.0.1:5640 [--frames 45] [--out <dir>]
 *
 * 桌面运行环境的 dev server 上:同一个项目(几张内置卡 + 一段带声音的视频),
 *   - 浏览器那一路:`window.__pcIo.exportVideoBrowser()`(`src/export/browserExport.ts`,和在线页面同一份流水;
 *     这里没有渲染节点的层表,重卡照活渲 —— 比的是合成与编码本身);
 *   - 桌面那一路:`exportVideo()` → 预渲染进程的 `/api/export`(Chrome beginFrame 截图 + ffmpeg)。
 * 两份 MP4 都解成逐帧 RGB,算每帧的平均绝对误差(0～255)和 PSNR,另报帧数、时长、编码。
 * 输出:最后一行一行 JSON;`ok` 只看两份都导得出、帧数一致(误差只报数,不设门槛 —— 门槛由主会话定)。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { devOrigin, flagArg } from './probe-connect.mjs';
import { findFfmpeg } from '../../server/bakery/ffmpeg.mjs';

const args = process.argv.slice(2);
const origin = devOrigin(args);
const FRAMES = Number(flagArg('frames', '45', args));
const RUN = Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-lowmem-compare-${RUN}`));
await fs.mkdir(OUT, { recursive: true });
const fails = [];
const check = (c, l, x) => { if (!c) fails.push(l + (x === undefined ? '' : ' :: ' + JSON.stringify(x).slice(0, 300))); return !!c; };
const ffmpeg = await findFfmpeg();
const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'));
function run(cmd, a) {
  const r = spawnSync(cmd, a, { encoding: 'buffer', windowsHide: true, maxBuffer: 2 * 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} 退出码 ${r.status}:${String(r.stderr).slice(-600)}`);
  return r.stdout;
}
const probeInfo = (file) => JSON.parse(String(run(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,nb_read_frames,duration', '-of', 'json', file])));

// 一段带声音的视频,导进本机素材库(经编辑器的导入接口)
const media = path.join(OUT, 'clip.mp4');
run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
  '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-metadata', `comment=${RUN}`, media]);

const out = { ok: false, origin, out: OUT, frames: FRAMES };
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 900000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  await page.goto(origin + '/?editor&nosetup=1', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(async () => !!(await import('/src/editor/stageBridge.ts')).frontStage(), { timeout: 180000, polling: 500 });
  const bytes = await fs.readFile(media);
  const setup = await page.evaluate(async (b64, run) => {
    const { actions, getState } = await import('/src/store/project.ts');
    actions.newProject('compare-' + run);
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const io = await import('/src/editor/io/index.ts');
    await io.importVideoFiles([new File([arr], 'clip-' + run + '.mp4', { type: 'video/mp4' })]);
    for (let i = 0; i < 100 && getState().project.media.some((m) => m.pending || !m.url); i++) await new Promise((r) => setTimeout(r, 200));
    const m = getState().project.media[0];
    const hasClip = getState().project.tracks.some((t) => t.clips.some((c) => c.mediaId === m.id));
    if (!hasClip) actions.addMediaClip(m.id, 0, { duration: 3 });
    const pill = actions.addClipOnNewTrack({ index: 0, cardId: 'punch-pill', start: 0, duration: 3 });
    actions.setClipParams(pill.id, { text: '逐帧比对 ' + run });
    actions.setClipFrame(pill.id, { x: 960, y: 540, w: 960, h: 540, anchor: [0.5, 0.5] });
    const cap = actions.addClipOnNewTrack({ index: 0, cardId: 'chapter-bar', start: 0, duration: 3 });
    void cap;
    actions.seek(0);
    const p = getState().project;
    return { media: p.media.map((x) => ({ url: x.url, hash: x.hash })), clips: p.tracks.flatMap((t) => t.clips.map((c) => c.cardId || 'media')), duration: p.duration };
  }, bytes.toString('base64'), RUN);
  out.setup = setup;

  // 浏览器那一路
  const t0 = Date.now();
  const b = await page.evaluate(async (n) => window.__pcIo.exportVideoBrowser({ maxFrames: n }), FRAMES);
  out.browser = { ms: Date.now() - t0, result: b.result };
  const browserMp4 = path.join(OUT, 'browser.mp4');
  await fs.writeFile(browserMp4, Buffer.from(b.base64, 'base64'));

  // 桌面那一路:/api/export 的前 FRAMES 帧
  const t1 = Date.now();
  const d = await page.evaluate(async (n) => {
    const io = await import('/src/editor/io/index.ts');
    const r = await io.exportVideo({ frames: `0-${n - 1}` });
    const blob = await io.fetchExportFile(r.id, 'preview.mp4');
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  }, FRAMES);
  out.desktop = { ms: Date.now() - t1 };
  const desktopMp4 = path.join(OUT, 'desktop.mp4');
  await fs.writeFile(desktopMp4, Buffer.from(d, 'base64'));

  const bi = probeInfo(browserMp4), di = probeInfo(desktopMp4);
  out.browser.ffprobe = bi.streams;
  out.desktop.ffprobe = di.streams;
  const bv = bi.streams.find((s) => s.codec_type === 'video'), dv = di.streams.find((s) => s.codec_type === 'video');
  check(bv?.codec_name === 'h264' && Number(bv.nb_read_frames) === FRAMES, '浏览器导出:h264、帧数', bv);
  check(!!bi.streams.find((s) => s.codec_type === 'audio' && s.codec_name === 'aac'), '浏览器导出:有 AAC 音轨', bi.streams);
  check(dv && Number(dv.nb_read_frames) >= FRAMES, '桌面导出:帧数', dv);

  // 逐帧误差(两边都缩到 960×540、RGB24,避开色度抽样的格子差)
  const W = 960, H = 540, N = FRAMES;
  const raw = (file) => run(ffmpeg, ['-v', 'error', '-i', file, '-frames:v', String(N), '-vf', `scale=${W}:${H}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const A = raw(browserMp4), B = raw(desktopMp4);
  const per = [];
  const fsz = W * H * 3;
  for (let i = 0; i < N && (i + 1) * fsz <= Math.min(A.length, B.length); i++) {
    let sum = 0, sq = 0, big = 0;
    for (let j = i * fsz; j < (i + 1) * fsz; j++) { const e = Math.abs(A[j] - B[j]); sum += e; sq += e * e; if (e > 32) big++; }
    const mae = sum / fsz, mse = sq / fsz;
    per.push({ i, mae: +mae.toFixed(2), psnr: mse ? +(10 * Math.log10((255 * 255) / mse)).toFixed(2) : 99, over32: +(big / fsz * 100).toFixed(3) });
  }
  const worst = [...per].sort((x, y) => y.mae - x.mae)[0];
  out.diff = { frames: per.length, meanMae: +(per.reduce((s, p) => s + p.mae, 0) / per.length).toFixed(2), minPsnr: Math.min(...per.map((p) => p.psnr)),
    meanPsnr: +(per.reduce((s, p) => s + p.psnr, 0) / per.length).toFixed(2), worst, sample: per.filter((p) => p.i % 15 === 0) };
  // 截两张同一帧的图对照
  for (const [name, file] of [['browser', browserMp4], ['desktop', desktopMp4]]) {
    run(ffmpeg, ['-y', '-v', 'error', '-i', file, '-vf', `select=eq(n\\,${worst.i})`, '-frames:v', '1', path.join(OUT, `${name}-f${worst.i}.png`)]);
  }
  check(per.length === FRAMES, '逐帧比完了', per.length);
} catch (e) {
  fails.push('探针异常:' + (e?.stack || e));
} finally {
  await browser.close().catch(() => {});
}
out.fails = fails;
out.ok = fails.length === 0;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);

/**
 * Frame-by-frame comparison between browser export and desktop export (`docs/plan/c10a-contract.md`
 * Section 12, "Compare frame-by-frame with desktop export, specify error tolerance in the report").
 *
 *   node scripts/probes/lowmem-export-compare.mjs --origin http://127.0.0.1:5640 [--frames 45] [--out <dir>]
 *
 * On desktop environment dev server: for the same project (several built-in cards + a video with audio),
 *   - Browser path: `window.__pcIo.exportVideoBrowser()` (`src/export/browserExport.ts`, same pipeline
 *     as online page; without render node layer table here, heavy cards still live render: what is
 *     compared is compositing and encoding themselves);
 *   - Desktop path: `exportVideo()` → prerender process `/api/export` (Chrome beginFrame screenshot + ffmpeg).
 * Both MP4s are decoded to frame-by-frame RGB, calculating mean absolute error (0-255) and PSNR
 * per frame, plus reporting frame count, duration, and encoding.
 * Output: last line is a single JSON line; `ok` only checks that both exports succeed and frame
 * counts match (error values are reported without setting gates: the gate is set by the lead session).
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
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} exit code ${r.status}: ${String(r.stderr).slice(-600)}`);
  return r.stdout;
}
const probeInfo = (file) => JSON.parse(String(run(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,nb_read_frames,duration', '-of', 'json', file])));

// A video with audio, imported into the local media library (via the editor's import interface)
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

  // Browser path
  const t0 = Date.now();
  const b = await page.evaluate(async (n) => window.__pcIo.exportVideoBrowser({ maxFrames: n }), FRAMES);
  out.browser = { ms: Date.now() - t0, result: b.result };
  const browserMp4 = path.join(OUT, 'browser.mp4');
  await fs.writeFile(browserMp4, Buffer.from(b.base64, 'base64'));

  // Desktop path: the first FRAMES frames of /api/export
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
  check(bv?.codec_name === 'h264' && Number(bv.nb_read_frames) === FRAMES, 'Browser export: h264, frame count', bv);
  check(!!bi.streams.find((s) => s.codec_type === 'audio' && s.codec_name === 'aac'), 'Browser export: has an AAC audio track', bi.streams);
  check(dv && Number(dv.nb_read_frames) >= FRAMES, 'Desktop export: frame count', dv);

  // Frame-by-frame error (both scaled to 960×540, RGB24 to avoid chroma subsampling grid differences)
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
  // Capture two images of the same frame for comparison
  for (const [name, file] of [['browser', browserMp4], ['desktop', desktopMp4]]) {
    run(ffmpeg, ['-y', '-v', 'error', '-i', file, '-vf', `select=eq(n\\,${worst.i})`, '-frames:v', '1', path.join(OUT, `${name}-f${worst.i}.png`)]);
  }
  check(per.length === FRAMES, 'Frame-by-frame comparison finished', per.length);
} catch (e) {
  fails.push('Probe exception:' + (e?.stack || e));
} finally {
  await browser.close().catch(() => {});
}
out.fails = fails;
out.ok = fails.length === 0;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);

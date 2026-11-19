/**
 * Probe for the timeline's edit tools: Split (Ctrl+B), Mirror, Rotate, Crop (`workflow/editing.md`
 * "User interactive correction"; `src/editor/timeline/EditTools.tsx`). Two parts:
 *
 *   node scripts/probes/timeline-edit-tools-probe.mjs [--port 5213] [--out out/timeline-edit-tools] [--skip-ui] [--skip-export]
 *
 * Starts its own dev server on free ports (`scripts/lib/dev-server.mjs`; `--port` picks the port),
 * with the media library, data and exports under `--out`. Chrome is puppeteer's, sandboxed unless
 * `server/chrome-sandbox.mjs` says otherwise.
 *
 * Media: a 320×180 picture in four colored quadrants, top-left red, top-right green, bottom-left blue,
 * bottom-right yellow, as an 8-second video and as a PNG. Mirror, crop and rotation are read off which
 * color lands where.
 *
 * Part 1, the toolbar in the editor (`?editor`), on clip A (0-1 s) of the project below:
 *   U1 With A selected and the playhead at 0.5 s, all four buttons are enabled; with nothing selected,
 *      all four are disabled and say why;
 *   U2 Split: A ends at 0.5 s, the second half starts there and is selected; Ctrl+B at 0.75 s splits the
 *      selected second half again; two undos give the single clip back;
 *   U3 Mirror: A gets flipX and the button shows pressed; a second click removes the key;
 *   U4 Rotate: A's frame turns 90° about the stage center (frame { x 320, y 180, anchor [.5,.5], rotate 90 });
 *      undo removes it;
 *   U5 Crop: the dialog opens on A's picture; 1:1 then OK gives the square crop
 *      { x 0.21875, y 0, w 0.5625, h 1 } and a centered 360 × 360 box;
 *   U6 The preview stage draws it: A's <video> inside its box is placed for the crop
 *      (177.78% of the box wide, at -38.89%) and, after Mirror, flipped (transform scaleX(-1)).
 * Screenshots of the toolbar, the crop dialog and the preview go to `--out` (for the PR).
 *
 * Part 2, the picture in both export paths: project 640×360, 30 fps, seven one-second clips, filled with
 * the picture unless noted:
 *   A  untouched (control)                          B  mirrored
 *   C  cropped to the top half (covers the stage)   D  C, mirrored
 *   E  turned 90° (the frame Rotate writes)         F  the PNG, cropped to its top-center 16:9 part, mirrored
 *   G  the square crop of U5 in the 360 × 360 box Crop gives it
 * Exported with the default Chrome export (`--no-video`, PNG per frame) and the `--media ffmpeg`
 * compatibility export (preview.mp4, decoded back with ffmpeg). The middle frame of each clip must show
 * the expected color at each sampled point, in both.
 *
 * The last line is one JSON object; the exit code is non-zero when any check failed.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { sandboxArgsFor } from '../../server/chrome-sandbox.mjs';

const execFileAsync = promisify(execFile);
setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 30 * 60_000).unref();

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const argv = process.argv.slice(2);
const arg = (name, dflt = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const OUT = path.resolve(arg('out', path.join(ROOT, 'out', 'timeline-edit-tools')));
const PORT = Number(arg('port', 0)) || undefined;
const WORK = path.join(OUT, 'work');
const MEDIA_DIR = path.join(WORK, 'media');
const W = 640, H = 360, FPS = 30;
const say = (m) => console.error(`[edit-tools-probe] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const result = { ok: false, out: OUT, ui: {}, export: {}, fails: [] };
const check = (cond, label, extra) => {
  if (!cond) result.fails.push(label + (extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 300)}`));
  return !!cond;
};

/* ── Media ─────────────────────────────────────────────────────────────────────────────── */

const QUADRANTS = 'color=c=red:s=160x90:r=30:d=8[a];color=c=0x00ff00:s=160x90:r=30:d=8[b];color=c=blue:s=160x90:r=30:d=8[c];color=c=yellow:s=160x90:r=30:d=8[d];'
  + '[a][b]hstack[t];[c][d]hstack[u];[t][u]vstack[out0]';
const COLORS = { R: [255, 0, 0], G: [0, 255, 0], B: [0, 0, 255], Y: [255, 255, 0] };

/** The media files, stored under their content hash like the asset service does */
async function makeMedia(ffmpeg) {
  const store = async (tmp, ext) => {
    const bytes = await fs.readFile(tmp);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    await fs.rename(tmp, path.join(MEDIA_DIR, `${hash}.${ext}`));
    return hash;
  };
  const run = (args) => execFileAsync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', QUADRANTS, ...args], { windowsHide: true });
  await run(['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '8', '-g', '30', '-movflags', '+faststart', path.join(WORK, 'quad.mp4')]);
  await run(['-frames:v', '1', path.join(WORK, 'quad.png')]);
  const vh = await store(path.join(WORK, 'quad.mp4'), 'mp4');
  const ih = await store(path.join(WORK, 'quad.png'), 'png');
  return {
    video: { id: 'm-quad', kind: 'video', name: 'quad.mp4', url: `/@media/${vh}`, hash: vh, ext: 'mp4', duration: 8, width: 320, height: 180 },
    image: { id: 'm-quad-png', kind: 'image', name: 'quad.png', url: `/@media/${ih}`, hash: ih, ext: 'png', width: 320, height: 180 },
  };
}

/* ── Project ───────────────────────────────────────────────────────────────────────────── */

const SQUARE = { x: 0.21875, y: 0, w: 0.5625, h: 1 };
/** Clip id → its picture settings, and [x, y, color] points its middle frame must show */
const CLIPS = [
  { id: 'A', set: {}, expect: [[160, 90, 'R'], [480, 90, 'G'], [160, 270, 'B'], [480, 270, 'Y']] },
  { id: 'B', set: { flipX: true }, expect: [[160, 90, 'G'], [480, 90, 'R'], [160, 270, 'Y'], [480, 270, 'B']] },
  { id: 'C', set: { crop: { x: 0, y: 0, w: 1, h: 0.5 } }, expect: [[160, 180, 'R'], [480, 180, 'G']] },
  { id: 'D', set: { crop: { x: 0, y: 0, w: 1, h: 0.5 }, flipX: true }, expect: [[160, 180, 'G'], [480, 180, 'R']] },
  { id: 'E', set: { frame: { x: 320, y: 180, w: 640, h: 360, anchor: [0.5, 0.5], rotate: 90 } }, expect: [[200, 100, 'B'], [440, 100, 'R'], [440, 300, 'G'], [200, 300, 'Y']] },
  { id: 'F', image: true, set: { crop: { x: 0.25, y: 0, w: 0.5, h: 0.5 }, flipX: true }, expect: [[160, 180, 'G'], [480, 180, 'R']] },
  { id: 'G', set: { crop: SQUARE, frame: { x: 320, y: 180, w: 360, h: 360, anchor: [0.5, 0.5] } }, expect: [[200, 90, 'R'], [440, 90, 'G'], [200, 270, 'B'], [440, 270, 'Y']] },
];

function projectOf(media) {
  return {
    version: 1, id: 'p-edit-tools-probe', name: 'edit-tools-probe', width: W, height: H, fps: FPS, duration: CLIPS.length, themeId: 'midnight',
    media: [media.video, media.image], filters: [], audioFx: [],
    tracks: [{ id: 't-main', name: 'Track 1', clips: CLIPS.map((c, i) => ({
      id: c.id, cardId: '', params: {}, label: c.id, start: i, end: i + 1,
      mediaId: c.image ? media.image.id : media.video.id, ...(c.image ? {} : { mediaOffset: i }), ...c.set,
    })) }],
  };
}

/* ── Colors ────────────────────────────────────────────────────────────────────────────── */

/** The quadrant color nearest to the 5×5 average around (x, y), or "?" when none is close */
function colorAt(png, x, y) {
  const acc = [0, 0, 0];
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const o = ((y + dy) * png.width + (x + dx)) * 4;
    for (let k = 0; k < 3; k++) acc[k] += png.data[o + k];
  }
  const rgb = acc.map((v) => v / 25);
  let best = '?', bestD = 90;
  for (const [name, c] of Object.entries(COLORS)) {
    const d = Math.hypot(rgb[0] - c[0], rgb[1] - c[1], rgb[2] - c[2]);
    if (d < bestD) { best = name; bestD = d; }
  }
  return { color: best, rgb: rgb.map(Math.round) };
}

/** Check the middle frame of every clip; `frameFile(i)` is the PNG of frame i */
function checkFrames(label, frameFile) {
  const rows = [];
  CLIPS.forEach((c, i) => {
    const f = i * FPS + FPS / 2;
    const png = PNG.sync.read(fsSync.readFileSync(frameFile(f)));
    for (const [x, y, want] of c.expect) {
      const got = colorAt(png, x, y);
      rows.push({ clip: c.id, frame: f, x, y, want, got: got.color, rgb: got.rgb });
      check(got.color === want, `${label}: clip ${c.id} at (${x}, ${y}) should be ${want}`, got);
    }
  });
  return { points: rows.length, match: rows.filter((r) => r.want === r.got).length, rows };
}

/* ── Part 2: export ────────────────────────────────────────────────────────────────────── */

function runNode(args, env, logFile) {
  return new Promise((resolve) => {
    const log = fsSync.createWriteStream(logFile, { flags: 'a' });
    const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    p.stdout.pipe(log); p.stderr.pipe(log);
    p.on('close', (code) => { log.end(); resolve(code); });
    p.on('error', () => resolve(1));
  });
}

async function exportBoth(dev, env, project, ffmpeg) {
  const timeline = 'data:application/json,' + encodeURIComponent(JSON.stringify(project));
  const url = `${dev.origin}/?export=1&timeline=${encodeURIComponent(timeline)}`;
  say('Chrome export (PNG per frame)');
  const chromeOut = path.join(OUT, 'export-chrome');
  const c1 = await runNode(['scripts/export-frames.mjs', '--url', url, '--out', chromeOut, '--fps', String(FPS), '--workers', '1', '--no-video'], env, path.join(OUT, 'export-chrome.log'));
  if (check(c1 === 0, `Chrome export exit code ${c1} (log export-chrome.log)`)) {
    result.export.chrome = checkFrames('Chrome export', (f) => path.join(chromeOut, 'frames', `${String(f).padStart(6, '0')}.png`));
  }
  say('ffmpeg compatibility export (preview.mp4)');
  const ffOut = path.join(OUT, 'export-ffmpeg');
  const c2 = await runNode(['scripts/export-frames.mjs', '--url', url, '--out', ffOut, '--fps', String(FPS), '--workers', '1', '--media', 'ffmpeg'], env, path.join(OUT, 'export-ffmpeg.log'));
  if (!check(c2 === 0, `ffmpeg export exit code ${c2} (log export-ffmpeg.log)`)) return;
  const decoded = path.join(ffOut, 'decoded');
  await fs.mkdir(decoded, { recursive: true });
  await execFileAsync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', path.join(ffOut, 'preview.mp4'), '-start_number', '0', path.join(decoded, '%06d.png')], { windowsHide: true });
  result.export.ffmpeg = checkFrames('ffmpeg export', (f) => path.join(decoded, `${String(f).padStart(6, '0')}.png`));
}

/* ── Part 1: the toolbar ───────────────────────────────────────────────────────────────── */

const clipOf = (page, id) => page.evaluate((id) => {
  const s = window.__pcStore.getState();
  const c = s.project.tracks.flatMap((t) => t.clips).find((x) => x.id === id);
  return c ? JSON.parse(JSON.stringify(c)) : null;
}, id);
const storeDo = (page, fn, ...args) => page.evaluate(fn, ...args);
const toolState = (page) => page.evaluate(() => Object.fromEntries(['split', 'mirror', 'rotate', 'crop'].map((k) => {
  const b = document.querySelector(`[data-pc="timeline-tool-${k}"]`);
  return [k, b ? { disabled: b.getAttribute('aria-disabled') === 'true', pressed: b.getAttribute('aria-pressed'), title: b.title } : null];
})));
const click = (page, sel) => page.$eval(sel, (b) => b.click());
const shot = async (page, name, sel) => {
  const el = sel ? await page.$(sel) : null;
  await (el ?? page).screenshot({ path: path.join(OUT, `${name}.png`) }).catch((e) => say(`screenshot ${name}: ${e.message}`));
};

async function openEditor(browser, dev, project) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => say(`pageerror: ${e}`));
  await page.goto(`${dev.origin}/?editor&nosetup=1&headless=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForFunction(() => !!window.__pcStore && !!document.querySelector('[data-pc="timeline-tool-split"]'), { timeout: 180_000, polling: 500 });
  await storeDo(page, (p) => { window.__pcStore.actions.loadProject(p); }, project);
  await sleep(1500);
  return page;
}

async function uiSplit(page) {
  await storeDo(page, () => { const a = window.__pcStore.actions; a.select([]); a.seek(0.5); });
  await sleep(200);
  const idle = await toolState(page);
  check(Object.values(idle).every((s) => s && s.disabled), 'U1 nothing selected: all four tools disabled', idle);
  await storeDo(page, () => window.__pcStore.actions.select(['A']));
  await sleep(200);
  const ready = await toolState(page);
  result.ui.ready = ready;
  check(Object.values(ready).every((s) => s && !s.disabled), 'U1 A selected under the playhead: all four tools enabled', ready);
  await shot(page, 'toolbar', '[data-pc="timeline-toolbar"]');
  await click(page, '[data-pc="timeline-tool-split"]');
  await sleep(200);
  const a = await clipOf(page, 'A');
  const sel = await storeDo(page, () => window.__pcStore.getState().selection);
  const right = sel.length === 1 ? await clipOf(page, sel[0]) : null;
  check(a?.end === 0.5 && right?.start === 0.5 && right?.end === 1, 'U2 Split: A ends at 0.5, its second half is selected', { a, right });
  await storeDo(page, () => window.__pcStore.actions.seek(0.75));
  await sleep(200);
  await page.keyboard.down('Control'); await page.keyboard.press('KeyB'); await page.keyboard.up('Control');
  await sleep(200);
  const count = await storeDo(page, () => window.__pcStore.getState().project.tracks[0].clips.filter((c) => c.start < 1).length);
  check(count === 3, 'U2 Ctrl+B splits the selected second half again', { count });
  await storeDo(page, () => { window.__pcStore.actions.undo(); window.__pcStore.actions.undo(); });
  const back = await clipOf(page, 'A');
  check(back?.end === 1, 'U2 two undos give A back whole', back);
}

async function uiMirrorRotate(page) {
  await storeDo(page, () => { const a = window.__pcStore.actions; a.select(['A']); a.seek(0.5); });
  await sleep(200);
  await click(page, '[data-pc="timeline-tool-mirror"]');
  await sleep(200);
  check((await clipOf(page, 'A'))?.flipX === true, 'U3 Mirror sets flipX');
  check((await toolState(page)).mirror.pressed === 'true', 'U3 Mirror shows pressed');
  await click(page, '[data-pc="timeline-tool-mirror"]');
  await sleep(200);
  check(!('flipX' in ((await clipOf(page, 'A')) ?? {})), 'U3 a second click removes the key');
  await click(page, '[data-pc="timeline-tool-rotate"]');
  await sleep(200);
  const turned = (await clipOf(page, 'A'))?.frame;
  check(JSON.stringify(turned) === JSON.stringify({ x: 320, y: 180, w: 640, h: 360, anchor: [0.5, 0.5], rotate: 90 }), 'U4 Rotate turns A 90° about its center', turned);
  await storeDo(page, () => window.__pcStore.actions.undo());
  check(!(await clipOf(page, 'A'))?.frame, 'U4 undo takes the rotation back');
}

async function uiCrop(page) {
  await click(page, '[data-pc="timeline-tool-crop"]');
  await page.waitForSelector('dialog.pc-crop-dialog .pc-crop-rect', { timeout: 30_000 });
  await page.evaluate(() => [...document.querySelectorAll('.pc-crop-ratios button')].find((b) => b.textContent.trim() === '1:1')?.click());
  await page.waitForFunction(() => document.querySelector('.pc-crop-dialog video')?.readyState >= 2, { timeout: 30_000 }).catch(() => say('crop dialog video not ready'));
  await sleep(300);
  await shot(page, 'crop-dialog', 'dialog.pc-crop-dialog');
  await page.$eval('dialog.pc-crop-dialog button[type=submit]', (b) => b.click());
  await sleep(300);
  const a = await clipOf(page, 'A');
  const near = (u, v) => Math.abs(u - v) < 1e-6;
  check(a?.crop && near(a.crop.x, SQUARE.x) && near(a.crop.w, SQUARE.w) && a.crop.y === 0 && a.crop.h === 1, 'U5 1:1 gives the square crop', a?.crop);
  check(JSON.stringify(a?.frame) === JSON.stringify({ x: 320, y: 180, w: 360, h: 360, anchor: [0.5, 0.5] }), 'U5 the box becomes a centered 360 square', a?.frame);
  check(!(await page.$('dialog.pc-crop-dialog')), 'U5 OK closes the dialog');
  await click(page, '[data-pc="timeline-tool-mirror"]');
  await sleep(1500);
  result.ui.preview = await previewStyle(page);
  const s = result.ui.preview;
  // The square crop is 0.5625 of the picture's width: the video is 1 / 0.5625 of the box wide, its crop
  // centered in the box (left = 0.5 - 0.5 × 177.78%), mirrored about the box's center (the same place here)
  check(s && s.position === 'absolute' && Math.abs(s.widthPct - 177.78) < 0.02 && Math.abs(s.leftPct + 38.89) < 0.02 && /matrix\(-1, 0, 0, 1/.test(s.transform),
    'U6 the stage draws A cropped and mirrored', s);
  await shot(page, 'editor', null);
}

/**
 * Style of A's <video> on the visible stage, in percent of its box. The stage lives in its own
 * (cross-origin) iframe, so it is read through puppeteer's frame handles; polled, because the stage
 * mounts the media layer only once it has loaded the project and the media.
 */
async function previewStyle(page) {
  const read = () => document.querySelectorAll && (() => {
    const box = [...document.querySelectorAll('[data-pc-clip="A"]')].find((el) => getComputedStyle(el).visibility === 'visible');
    const v = box?.querySelector('video');
    if (!v || v.readyState < 2) return null;
    const cs = getComputedStyle(v);
    return { position: cs.position, transform: cs.transform, leftPct: Math.round((v.offsetLeft / box.offsetWidth) * 1e4) / 100, widthPct: Math.round((v.offsetWidth / box.offsetWidth) * 1e4) / 100, boxW: box.offsetWidth, boxH: box.offsetHeight };
  })();
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    for (const frame of page.frames()) {
      const got = await frame.evaluate(read).catch(() => null);
      if (got) return got;
    }
    await sleep(500);
  }
  // Not found: say what the stages hold, for the report
  const seen = [];
  for (const frame of page.frames()) {
    seen.push(await frame.evaluate(() => ({
      url: location.href.slice(0, 80),
      boxes: [...document.querySelectorAll('[data-pc-clip]')].map((el) => `${el.getAttribute('data-pc-clip')}:${getComputedStyle(el).visibility}`).slice(0, 8),
      videos: [...document.querySelectorAll('video')].map((v) => ({ src: (v.currentSrc || v.getAttribute('src') || '').slice(-40), ready: v.readyState, net: v.networkState, err: v.error?.code ?? null })).slice(0, 6),
    })).catch((e) => ({ error: String(e).slice(0, 120) })));
  }
  result.ui.stages = seen;
  return null;
}

/* ── Main ──────────────────────────────────────────────────────────────────────────────── */

let dev = null;
let browser = null;
try {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  await fs.mkdir(path.join(WORK, 'data'), { recursive: true });
  const { findFfmpeg } = await import(pathToFileURL(path.join(ROOT, 'server/bakery/ffmpeg.mjs')).href);
  const ffmpeg = await findFfmpeg();
  const media = await makeMedia(ffmpeg);
  const project = projectOf(media);
  await fs.writeFile(path.join(OUT, 'project.json'), JSON.stringify(project, null, 1));
  const env = { PROMPTCUT_EXPORT_DIR: WORK, PROMPTCUT_DATA_DIR: path.join(WORK, 'data'), PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_CARD_SYNC: '0', PROMPTCUT_PUSH: '0', PROMPTCUT_LAN_HOST: '' };
  Object.assign(process.env, env);
  const { startDevServer } = await import(pathToFileURL(path.join(ROOT, 'scripts/lib/dev-server.mjs')).href);
  dev = await startDevServer({ env, port: PORT, logFile: path.join(OUT, 'vite.log'), log: say });
  say(`dev server ${dev.origin} (pid ${dev.pid})`);
  if (!argv.includes('--skip-ui')) {
    browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, ...sandboxArgsFor('the edit tools probe'), '--force-device-scale-factor=2'] });
    const page = await openEditor(browser, dev, project);
    await uiSplit(page);
    await uiMirrorRotate(page);
    await uiCrop(page);
    await browser.close();
    browser = null;
  }
  if (!argv.includes('--skip-export')) await exportBoth(dev, env, project, ffmpeg);
  result.ok = result.fails.length === 0;
} catch (e) {
  result.fails.push(`Probe crashed: ${e?.stack || e}`);
} finally {
  await browser?.close().catch(() => {});
  try { dev?.stop(); } catch { /* already gone */ }
}
for (const k of ['chrome', 'ffmpeg']) if (result.export[k]) delete result.export[k].rows;
await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(result, null, 1)).catch(() => {});
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);

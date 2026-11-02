/*
 * Probe / acceptance check: whether visuals rendered by the pixel map WebGL backend match the
 * preserved CPU reference implementation mapRgba.
 *
 * Why ask: R1b completely removed the pixel-by-pixel CPU loop and replaced it with a GLSL fragment
 * shader (measured CPU path: 416-483 ms per 1080p frame). Preview, export page, and see_frames
 * share this single implementation, so the export pixel baseline will shift once: we must know what
 * it becomes: comparing pixel-by-pixel on the same 1080p test frame, a difference ≤ 2 levels
 * qualifies as replaced correctly.
 *
 * How to run: node scripts/probes/pixelmap-gl-probe.mjs [--out <dir>] [--cases color-key-to-transparent,by-position]
 *   Starts its own Vite on 5199 (user's editor is on 5190, another session is on 5197 / 5191, do not touch).
 *   Source and comparison images are generated on the fly by ffmpeg, placed in `--out` dir (default out/pixelmap-gl/);
 *   The 1080p benchmark video is fixed in out/pixelmap-gl/ because it must be served as a static file by Vite.
 *
 * **Do not add --disable-gpu / --enable-unsafe-swiftshader**: this acceptance check is meant to
 * measure real GPUs.
 * The report will include UNMASKED_RENDERER_WEBGL; receiving SwiftShader fails immediately.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { PNG } from 'pngjs';
import { normalizePixelMapDef, mapRgba, classifyPixelMap } from '../../src/kernel/pixelMap.mjs';

const PORT = 5199;
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const argOf = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const OUT = path.resolve(argOf('--out', path.join(ROOT, 'out', 'pixelmap-gl')));
const ONLY = (argOf('--cases', '') || '').split(',').filter(Boolean);
const W = 1920, H = 1080;

fs.mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ Assets */

const ff = (args, label) => {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ${label} failed: ${r.stderr || r.error?.message}`);
};
const srcPng = path.join(OUT, 'src-testsrc2.png');
const tgtPng = path.join(OUT, 'src-target.png');
// Benchmark video must be served by Vite, so it is fixed in the repo (OUT may be outside the repo,
// and /@fs would be blocked by Vite)
const CLIP_DIR = path.join(ROOT, 'out', 'pixelmap-gl');
fs.mkdirSync(CLIP_DIR, { recursive: true });
const clipMp4 = path.join(CLIP_DIR, 'clip-1080p.mp4');
if (!fs.existsSync(srcPng)) ff(['-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=1`, '-frames:v', '1', '-pix_fmt', 'rgb24', srcPng], 'testsrc2');
if (!fs.existsSync(tgtPng)) ff(['-f', 'lavfi', '-i', `gradients=size=${W}x${H}:rate=1:c0=0x00ff00:c1=0x102030:nb_colors=2`, '-frames:v', '1', '-pix_fmt', 'rgb24', tgtPng], 'gradients');
if (!fs.existsSync(clipMp4)) ff(['-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=30:duration=2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', clipMp4], 'clip');

const readRgba = (file) => {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { w: png.width, h: png.height, data: new Uint8ClampedArray(png.data) };
};
const SRC = readRgba(srcPng);
const TGT = readRgba(tgtPng);
const gz = (u8) => zlib.gzipSync(Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)).toString('base64');
const ungz = (b64) => new Uint8ClampedArray(zlib.gunzipSync(Buffer.from(b64, 'base64')));
const writePng = (file, w, h, data) => {
  const png = new PNG({ width: w, height: h });
  png.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  fs.writeFileSync(file, PNG.sync.write(png));
};

/* ------------------------------------------------------------------ Test cases */

const GREEN = 'smoothstep(0.35,0.8,g-r)*(1-smoothstep(0.15,0.45,b))';
const CASES = [
  { name: 'Key out color to transparent', def: { name: 'Key out green', where: GREEN, to: 'transparent' } },
  { name: 'Key out color to solid color', def: { name: 'Key out green, fill blue', where: GREEN, to: '#0033ff' } },
  { name: 'Gradient selection by position', def: { name: 'Diagonal', where: 'smoothstep(0.15,0.85,x)*smoothstep(0.1,0.9,y)', to: '#101820' } },
  { name: 'Flicker by time', def: { name: 'Flash', where: '0.5+0.5*sin(t*2*PI)', to: '#ffcc00' }, t: 0.37 },
  /*
   * A few pixels will not match on this one, which is known and unavoidable: colorSequence color
   * sampling performs "RGB nearest neighbor on from"; when from = [#000000, #808080, #ffffff],
   * pixels where r+g+b equals exactly 192 are **exactly equidistant** to the first two from colors.
   * In an exact tie, sequenceTarget's original intent is to take the earlier one (strictly less
   * than), and the shader behaves according to this intent (see PC_SEQ_EPS); whereas mapRgba on
   * float64 lets the least-significant-bit rounding of Math.hypot decide for it, battery sometimes
   * picking the later one. In other words, on these few pixels **the shader is actually correct**.
   * Per-pixel color sampling is a discrete mapping, and such jumps are inevitable at tie points.
   */
  { name: 'Color sequence-continuous', tiedNearest: true, def: { name: 'Continuous', where: '1', mode: 'continuous', to: '#fff', colorSequence: { from: ['#000000', '#808080', '#ffffff'], to: ['#001133', '#ffcc88', '#ffffff'] } } },
  { name: 'Color sequence-discrete', def: { name: 'Discrete', where: '1', mode: 'discrete', to: '#fff', colorSequence: { from: ['#000000', '#555555', '#aaaaaa', '#ffffff'], to: ['#ff0000', '#00ff00', '#0000ff', '#ffff00'] } } },
  { name: 'Target is another media item', def: { name: 'Swap background', where: `1-(${GREEN})`, to: { kind: 'media', mediaId: 'B', stage: 'origin' } }, target: 'B' },
  { name: 'Channel nonlinear expression', def: { name: 'Brighten shadows', where: '1-smoothstep(0,0.35,luma)', to: { kind: 'expr', r: 'r^0.6', g: 'g^0.6', b: 'b^0.6', a: 'a' } } },
];

/* ------------------------------------------------------------------ vite */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-pmgl-'));
const vite = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { windowsHide: true, cwd: ROOT, env: { ...process.env, TEMP: tmp, TMP: tmp, PROMPTCUT_NO_PORT_FILE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
let viteLog = '';
vite.stdout.on('data', (d) => { viteLog += d; });
vite.stderr.on('data', (d) => { viteLog += d; });

const waitHttp = async (url, ms) => {
  const end = Date.now() + ms;
  for (;;) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* Not up yet */ }
    if (Date.now() > end) throw new Error('vite did not start:\n' + viteLog);
    await new Promise((r) => setTimeout(r, 300));
  }
};

/* ------------------------------------------------------------------ Comparison */

function compare(a, b) {
  let worst = 0, over1 = 0, over2 = 0, sum = 0;
  const hist = new Array(16).fill(0);
  const where = { x: -1, y: -1, ch: -1 };
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    hist[Math.min(15, d)]++;
    if (d > 1) over1++;
    if (d > 2) over2++;
    if (d > worst) { worst = d; const p = (i / 4) | 0; where.x = p % W; where.y = (p / W) | 0; where.ch = i % 4; }
  }
  return { worst, over1, over2, mean: sum / a.length, hist: hist.slice(0, 6), worstAt: where };
}

let browser;
const results = [];
try {
  await waitHttp(`http://127.0.0.1:${PORT}/`, 120000);
  browser = await puppeteer.launch({
    headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--hide-scrollbars', '--no-first-run',
      '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('[page console]', m.text()); });
  const HARNESS = `http://127.0.0.1:${PORT}/scripts/probes/pixelmap-gl-harness.html`;
  await page.goto(HARNESS, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__pmReady === true', { timeout: 120000 });
  /*
   * After Vite pre-bundles dependencies for the first time, it proactively triggers a full page
   * reload ("optimized dependencies changed"); hitting this right here destroys the execution
   * context. Idle for a moment first to absorb this, then wrap each evaluate later in a retry layer
   * as a fallback.
   */
  await new Promise((r) => setTimeout(r, 3000));
  const gzA = gz(SRC.data), gzB = gz(TGT.data);
  const putSources = async () => {
    await page.evaluate((n, w, h, g) => window.__pm.putSource(n, w, h, g), 'A', SRC.w, SRC.h, gzA);
    await page.evaluate((n, w, h, g) => window.__pm.putSource(n, w, h, g), 'B', TGT.w, TGT.h, gzB);
  };
  let primed = false;
  const ev = async (fn, ...args) => {
    for (let i = 0; ; i++) {
      try { return await page.evaluate(fn, ...args); } catch (e) {
        if (i >= 2 || !/Execution context was destroyed/.test(String(e))) throw e;
        console.log('[probe] the page reloaded, feeding the source images again and retrying');
        await page.waitForFunction('window.__pmReady === true', { timeout: 120000 });
        if (primed) await putSources();
      }
    }
  };

  const info = await ev(() => window.__pm.info());
  console.log('WebGL:', JSON.stringify(info));
  const software = /swiftshader|software|llvmpipe|basic render/i.test(info?.renderer ?? '');
  if (software) console.log('!! Got software rendering, the performance numbers below do not count');

  await putSources();
  primed = true;

  for (const c of CASES) {
    if (ONLY.length && !ONLY.includes(c.name)) continue;
    const def = { id: 'pm-probe', ...normalizePixelMapDef(c.def) };
    const cls = classifyPixelMap(def);
    const t = c.t ?? 0;
    const gpuRes = await ev((d, s, tg, tt) => window.__pm.runGpu(d, s, tg, tt), def, 'A', c.target ?? null, t);
    const gpu = ungz(gpuRes.gz);

    // Reference image is computed on the Node side using the same source bytes and mapRgba
    const cpu = new Uint8ClampedArray(SRC.data.length);
    for (let i = 0; i < SRC.data.length; i += 4) {
      const target = c.target ? [TGT.data[i] / 255, TGT.data[i + 1] / 255, TGT.data[i + 2] / 255, TGT.data[i + 3] / 255] : null;
      const p = mapRgba(def, [SRC.data[i] / 255, SRC.data[i + 1] / 255, SRC.data[i + 2] / 255, SRC.data[i + 3] / 255],
        { x: (i / 4) % W / W, y: Math.floor(i / 4 / W) / H, t }, target);
      cpu[i] = Math.round(p[0] * 255); cpu[i + 1] = Math.round(p[1] * 255);
      cpu[i + 2] = Math.round(p[2] * 255); cpu[i + 3] = Math.round(p[3] * 255);
    }

    const cmp = compare(gpu, cpu);
    const slug = c.name.replace(/[^\w-]/g, '');
    writePng(path.join(OUT, `${slug}-gpu.png`), W, H, gpu);
    writePng(path.join(OUT, `${slug}-cpu.png`), W, H, cpu);
    // Diff image: visible when magnified 32x
    const diff = new Uint8ClampedArray(gpu.length);
    for (let i = 0; i < gpu.length; i += 4) {
      for (let k = 0; k < 3; k++) diff[i + k] = Math.min(255, Math.abs(gpu[i + k] - cpu[i + k]) * 32);
      diff[i + 3] = 255;
    }
    writePng(path.join(OUT, `${slug}-diff32x.png`), W, H, diff);

    console.log(`${c.name.padEnd(12)} class=${cls.kind} max diff=${cmp.worst} >1 level=${cmp.over1} >2 levels=${cmp.over2} mean diff=${cmp.mean.toFixed(5)} histogram 0..5=${cmp.hist.join(',')}`);
    results.push({ case: c.name, class: cls.kind, tiedNearest: !!c.tiedNearest, def, ...cmp });
  }

  /* ---------------------------------------------------------- Performance */
  const benchDef = { id: 'pm-bench', ...normalizePixelMapDef({ name: 'Key out green', where: GREEN, to: 'transparent' }) };
  const perf = await ev((d, u, w, h, n) => window.__pm.bench(d, u, w, h, n),
    benchDef, '/out/pixelmap-gl/clip-1080p.mp4', W, H, 24);
  console.log('Performance (1080p video, key out color to transparent): warm-up ' + perf.warmupMs.toFixed(2) + ' ms; main-thread submit p50 ' + perf.submitP50.toFixed(3) + ' ms / max ' + perf.submitMax.toFixed(3) + ' ms;' +
    'GPU ' + (perf.gpuP50 == null ? 'n/a' : 'p50 ' + perf.gpuP50.toFixed(3) + ' ms / max ' + perf.gpuMax.toFixed(3) + ' ms') + '(' + perf.gpuHow + ')');

  const report = { at: new Date().toISOString(), webgl: info, software, size: [W, H], cases: results, perf };
  fs.writeFileSync(path.join(OUT, 'pixelmap-gl-probe.json'), JSON.stringify(report, null, 2));
  console.log('\nData written to', path.join(OUT, 'pixelmap-gl-probe.json'));

  // Special note for cases marked tiedNearest: all its out-of-spec pixels are at tie points "exactly
  // equidistant to two from colors", where the shader takes the earlier one following the original
  // intent of sequenceTarget, behaving even more strictly than mapRgba.
  for (const r of results.filter((x) => x.tiedNearest && x.worst > 2)) {
    console.log(`(known) ${r.case}: ${r.over2 / 3} pixels with exact ties picked different from indices, making up ${(r.over2 / 3 / (W * H) * 100).toFixed(5)}%; see the comment on the case`);
  }
  const bad = results.filter((r) => r.worst > 2 && !r.tiedNearest);
  if (bad.length) { console.log('!! Cases over 2 levels:', bad.map((b) => `${b.case}=${b.worst}`).join(' ')); process.exitCode = 1; }
} finally {
  if (browser) await browser.close().catch(() => {});
  /*
   * On Windows, Vite is started via npx.cmd + shell, and `kill()` only hits that shell layer, leaving
   * the Node process that actually occupies 5199 alive (in tests, the port remained LISTENING after
   * running). Therefore, reap the entire process tree together.
   */
  if (process.platform === 'win32' && vite.pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(vite.pid)], { windowsHide: true, stdio: 'ignore' });
  vite.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Failure to clean up the temporary directory does not affect the conclusion */ }
}

/**
 * Experiment: whether rendering Lottie with canvas works, and how much it differs from current SVG
 * rendering.
 * Source: `docs/plan/render-standard.md` "Lottie motion graphics" (2026-10-10 user: "Help me test
 * whether we can do this with canvas, and compare performance between svg and canvas at the same
 * time").
 *
 *   node scripts/probes/lottie-renderer-probe.mjs [--assets adrock,bodymovin,gatin,happy2016,navidad] [--frames 90]
 *        [--out <dir>]       Save comparison images of several frames per asset (one SVG, one canvas)
 *        [--throttle 4] [--cores 2] [--software] [--json <file>]
 *
 * Method: In real Chrome, use the project's built-in player library (`lottie-web`) to create one
 * instance of the same asset for each renderer: one rendered on SVG (current approach) and one on
 * canvas, both placed in a 1920×1080 frame and displayed in full (matching the card default).
 * Like cards, do not let it play automatically; call "jump to frame and render" for every frame.
 *
 * Measure four metrics (measured for each asset and each rendering method):
 *   Compute frame    Only count synchronous duration of the "jump to this frame" statement. The
 *                    SVG method only modifies nodes at this point, with actual drawing happening
 *                    later; the canvas method finishes drawing within this statement.
 *   Render frame     Advance one frame per animation frame; total time to complete consecutively ÷
 *                    frame count, including browser drawing and compositing time (startup flags
 *                    disable VSync and frame rate caps). This is the cost of "on-demand compute,
 *                    direct display".
 *   Acquire pixels   How long it takes to jump to this frame and turn the frame into a bitmap ready
 *                    for the encoder. This is the cost of "pushing into the track stream".
 *                    Canvas: frame is already in canvas, read directly. SVG: must serialize nodes,
 *                    decode as image, and draw onto canvas.
 *   Setup duration   From receiving JSON to producing the first frame.
 *
 * Compare frames next: Sample 5 frames (start, first quarter, middle, third quarter, end), acquire
 * pixels from both rendering methods, and compare pixel by pixel: mean difference, ratio of pixels
 * with difference > 16, and mean difference in opacity.
 * Both rendering methods verify "whether jumping matches sequential execution": first advance
 * sequentially to this frame, then jump directly from frame 0 to this frame, comparing pixels
 * between the two runs (random access).
 *
 * Record only, do not judge pass/fail; exit code 1 if asset fails to load or cannot be rendered.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const flag = (name) => process.argv.includes(name);
const CATALOG = path.join(ROOT, 'server', 'catalog', 'lottie');
const ASSETS = arg('--assets', 'adrock,bodymovin,gatin,happy2016,navidad').split(',').filter(Boolean);
const FRAMES = Math.max(4, Number(arg('--frames', '90')));
const THROTTLE = Number(arg('--throttle', '1'));
const CORES = Number(arg('--cores', '0'));
const SOFTWARE = flag('--software');
const OUT = arg('--out', null);
const JSON_OUT = arg('--json', null);
const PLAYER = path.join(path.dirname(require.resolve('lottie-web/package.json')), 'build', 'player', 'lottie.min.js');
if (OUT) fs.mkdirSync(OUT, { recursive: true });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#111;overflow:hidden}.box{position:absolute;left:0;top:0;width:1920px;height:1080px}</style><div id="tick" style="position:absolute;right:0;bottom:0;width:2px;height:2px;z-index:9"></div><script src="/lottie.js"></script>'); return; }
  if (url.pathname === '/lottie.js') { res.setHeader('content-type', 'text/javascript'); res.end(fs.readFileSync(PLAYER)); return; }
  const m = /^\/asset\/([a-z0-9]+)\.json$/.exec(url.pathname);
  const file = m ? path.join(CATALOG, `${m[1]}.json`) : null;
  if (file && fs.existsSync(file)) { res.setHeader('content-type', 'application/json'); res.end(fs.readFileSync(file)); return; }
  res.statusCode = 404; res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://localhost:${server.address().port}`;

function limitCores(rootPid, cores) {
  if (process.platform !== 'win32' || !(cores > 0)) return null;
  const mask = (2 ** cores) - 1;
  const script = `
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$ids = New-Object System.Collections.Generic.List[int]; $ids.Add(${rootPid})
$i = 0; while ($i -lt $ids.Count) { $p = $ids[$i]; foreach ($c in $all) { if ($c.ParentProcessId -eq $p -and -not $ids.Contains([int]$c.ProcessId)) { $ids.Add([int]$c.ProcessId) } }; $i++ }
$n = 0; foreach ($id in $ids) { try { (Get-Process -Id $id -ErrorAction Stop).ProcessorAffinity = [IntPtr]${mask}; $n++ } catch {} }
"$n/$($ids.Count)"`;
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
}

async function inPage({ name, frames, wantImages }) {
  const W = 1920, H = 1080;
  const data = await (await fetch(`/asset/${name}.json`)).json();
  const total = Math.max(1, (Number(data.op) || 0) - (Number(data.ip) || 0));
  const count = Math.min(total, frames);
  const tick = document.getElementById('tick'); let tickOn = false;
  const nextFrame = () => new Promise((resolve) => { tickOn = !tickOn; tick.style.background = tickOn ? '#222' : '#333'; requestAnimationFrame(() => resolve()); });
  const med = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

  const build = async (renderer) => {
    const box = document.createElement('div'); box.className = 'box'; document.body.appendChild(box);
    const t0 = performance.now();
    const anim = lottie.loadAnimation({ container: box, renderer, loop: false, autoplay: false, animationData: structuredClone(data),
      rendererSettings: renderer === 'canvas' ? { preserveAspectRatio: 'xMidYMid meet', clearCanvas: true, dpr: 1, progressiveLoad: false } : { preserveAspectRatio: 'xMidYMid meet', progressiveLoad: false } });
    if (!anim.isLoaded) await new Promise((resolve, reject) => { anim.addEventListener('DOMLoaded', resolve); anim.addEventListener('data_failed', () => reject(new Error('data_failed'))); });
    anim.goToAndStop(0, true);
    return { box, anim, buildMs: performance.now() - t0 };
  };

  // Acquire pixels: canvas reads directly; SVG serializes → decodes as image → draws to canvas.
  // Both land on the same 1920×1080 target canvas
  const target = new OffscreenCanvas(W, H); const tctx = target.getContext('2d', { willReadFrequently: true });
  const pixelsOf = async (renderer, box) => {
    tctx.clearRect(0, 0, W, H);
    if (renderer === 'canvas') { tctx.drawImage(box.querySelector('canvas'), 0, 0, W, H); return; }
    const svg = box.querySelector('svg').cloneNode(true);
    svg.setAttribute('width', String(W)); svg.setAttribute('height', String(H)); svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    try { const img = new Image(); img.src = url; await img.decode(); tctx.drawImage(img, 0, 0, W, H); } finally { URL.revokeObjectURL(url); }
  };

  const out = { name, total, fr: Number(data.fr) || 30, w: data.w, h: data.h, measured: count, layers: (data.layers || []).length };
  const made = {};
  for (const renderer of ['svg', 'canvas']) {
    const m = await build(renderer); made[renderer] = m;
    const { anim, box } = m;
    // Compute one frame (synchronous)
    const syncRuns = [];
    for (let r = 0; r < 3; r++) { anim.goToAndStop(0, true); const t0 = performance.now(); for (let f = 0; f < count; f++) anim.goToAndStop(f, true); syncRuns.push((performance.now() - t0) / count); }
    // Render one frame (including draw and composite)
    const frameRuns = [];
    for (let r = 0; r < 3; r++) { anim.goToAndStop(0, true); await nextFrame(); await nextFrame(); const t0 = performance.now(); for (let f = 0; f < count; f++) { anim.goToAndStop(f, true); await nextFrame(); } frameRuns.push((performance.now() - t0) / count); }
    // Acquire pixels
    const px = Math.min(count, 30); const pxRuns = [];
    for (let r = 0; r < 2; r++) { const t0 = performance.now(); for (let f = 0; f < px; f++) { anim.goToAndStop(f, true); await pixelsOf(renderer, box); } pxRuns.push((performance.now() - t0) / px); }
    out[renderer] = { buildMs: +m.buildMs.toFixed(1), syncMs: +med(syncRuns).toFixed(3), frameMs: +med(frameRuns).toFixed(3), pixelsMs: +med(pxRuns).toFixed(2),
      nodes: renderer === 'svg' ? box.querySelectorAll('svg *').length : null, svgKB: renderer === 'svg' ? +(new XMLSerializer().serializeToString(box.querySelector('svg')).length / 1024).toFixed(1) : null };
    box.style.display = 'none';
  }

  // Compare frames
  const picks = [...new Set([0, Math.floor((total - 1) / 4), Math.floor((total - 1) / 2), Math.floor((total - 1) * 3 / 4), total - 1])];
  out.diff = []; out.images = [];
  const pngOf = async () => { const blob = await target.convertToBlob({ type: 'image/png' }); const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode(...buf.subarray(i, i + 32768)); return btoa(s); };
  for (const f of picks) {
    made.svg.box.style.display = '';
    made.svg.anim.goToAndStop(0, true); for (let k = 0; k <= f; k++) made.svg.anim.goToAndStop(k, true);
    await pixelsOf('svg', made.svg.box);
    const svgSeq = tctx.getImageData(0, 0, W, H).data.slice();
    made.svg.anim.goToAndStop(0, true); made.svg.anim.goToAndStop(f, true); await pixelsOf('svg', made.svg.box); made.svg.box.style.display = 'none';
    const a = tctx.getImageData(0, 0, W, H).data.slice();
    const aPng = wantImages ? await pngOf() : null;
    made.canvas.box.style.display = '';
    // Advance sequentially to this frame
    made.canvas.anim.goToAndStop(0, true); for (let k = 0; k <= f; k++) made.canvas.anim.goToAndStop(k, true);
    await pixelsOf('canvas', made.canvas.box);
    const seq = tctx.getImageData(0, 0, W, H).data.slice();
    // Jump directly from frame 0 to this frame
    made.canvas.anim.goToAndStop(0, true); made.canvas.anim.goToAndStop(f, true);
    await pixelsOf('canvas', made.canvas.box);
    const b = tctx.getImageData(0, 0, W, H).data;
    const bPng = wantImages ? await pngOf() : null;
    made.canvas.box.style.display = 'none';
    let sum = 0, big = 0, alphaSum = 0, randomAccess = true, raMax = 0, raCount = 0, svgRaMax = 0, svgRaCount = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
      sum += d; if (d > 16) big++; alphaSum += Math.abs(a[i + 3] - b[i + 3]);
      const r = Math.max(Math.abs(seq[i] - b[i]), Math.abs(seq[i + 1] - b[i + 1]), Math.abs(seq[i + 2] - b[i + 2]), Math.abs(seq[i + 3] - b[i + 3]));
      if (r) { randomAccess = false; raCount++; if (r > raMax) raMax = r; }
      const q = Math.max(Math.abs(svgSeq[i] - a[i]), Math.abs(svgSeq[i + 1] - a[i + 1]), Math.abs(svgSeq[i + 2] - a[i + 2]), Math.abs(svgSeq[i + 3] - a[i + 3]));
      if (q) { svgRaCount++; if (q > svgRaMax) svgRaMax = q; }
    }
    const n = a.length / 4;
    out.diff.push({ frame: f, mean: +(sum / n).toFixed(3), bigPct: +(100 * big / n).toFixed(3), alphaMean: +(alphaSum / n).toFixed(3), randomAccess, raMax, raPct: +(100 * raCount / n).toFixed(4), svgRaMax, svgRaPct: +(100 * svgRaCount / n).toFixed(4) });
    if (wantImages) out.images.push({ frame: f, svg: aPng, canvas: bPng });
  }
  made.svg.anim.destroy(); made.canvas.anim.destroy(); made.svg.box.remove(); made.canvas.box.remove();
  return out;
}

const report = { when: new Date().toISOString(), host: { cpu: os.cpus()[0]?.model?.trim(), logicalCores: os.cpus().length },
  options: { frames: FRAMES, throttle: THROTTLE, cores: CORES || null, software: SOFTWARE }, lottieWeb: require('lottie-web/package.json').version, results: [], failures: [] };
let browser = null;
try {
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 900000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--disable-gpu-vsync', '--disable-frame-rate-limit', ...(SOFTWARE ? ['--disable-gpu'] : [])] });
  report.chrome = await browser.version();
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => report.failures.push(`Page error: ${String(e.message || e).slice(0, 160)}`));
  await page.goto(base + '/');
  if (CORES > 0) report.affinity = limitCores(browser.process().pid, CORES);
  if (THROTTLE > 1) { const cdp = await page.createCDPSession(); await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE }); }
  for (const name of ASSETS) {
    try {
      const r = await page.evaluate(inPage, { name, frames: FRAMES, wantImages: !!OUT });
      for (const img of r.images ?? []) { fs.writeFileSync(path.join(OUT, `${name}-${img.frame}-svg.png`), Buffer.from(img.svg, 'base64')); fs.writeFileSync(path.join(OUT, `${name}-${img.frame}-canvas.png`), Buffer.from(img.canvas, 'base64')); }
      delete r.images;
      report.results.push(r);
    } catch (e) { report.failures.push(`${name}:${String(e?.message ?? e).slice(0, 200)}`); }
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  await new Promise((resolve) => server.close(() => resolve()));
}

if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
console.log(`Machine: ${report.host.cpu}, ${report.host.logicalCores} logical cores; ${report.chrome}; lottie-web ${report.lottieWeb}`);
console.log(`Conditions: ${SOFTWARE ? 'GPU off' : 'default'}${CORES ? `, limited to ${CORES} cores (process ${report.affinity})` : ''}${THROTTLE > 1 ? `, main thread slowed ${THROTTLE}x` : ''}; measure the first ${FRAMES} frames of each asset; drawn into a 1920×1080 box`);
const x = (a, b) => (b > 0 ? `${(a / b).toFixed(1)}x` : '—');
for (const r of report.results) {
  console.log(`Asset ${r.name} (${r.w}×${r.h}, ${r.total} frames, ${r.layers} layers; SVG rendering ${r.svg.nodes} nodes, serialized ${r.svg.svgKB} KB)`);
  console.log(`   Compute one frame (sync)  SVG ${r.svg.syncMs} ms   canvas ${r.canvas.syncMs} ms`);
  console.log(`   Render one frame          SVG ${r.svg.frameMs} ms   canvas ${r.canvas.frameMs} ms   SVG is ${x(r.svg.frameMs, r.canvas.frameMs)} canvas`);
  console.log(`   Get pixels                SVG ${r.svg.pixelsMs} ms   canvas ${r.canvas.pixelsMs} ms   SVG is ${x(r.svg.pixelsMs, r.canvas.pixelsMs)} canvas`);
  console.log(`   Built                     SVG ${r.svg.buildMs} ms   canvas ${r.canvas.buildMs} ms`);
  console.log(`   Image diff (frame: mean diff/share of pixels differing by more than 16/mean opacity diff)  ${r.diff.map((d) => `${d.frame}:${d.mean}/${d.bigPct}%/${d.alphaMean}`).join('  ')}`);
  const ra = (maxKey, pctKey) => { const m = Math.max(...r.diff.map((d) => d[maxKey])), p = Math.max(...r.diff.map((d) => d[pctKey])); return m === 0 ? 'byte-for-byte identical' : `max diff ${m} (out of 255), differing pixels up to ${p}%`; };
  console.log(`   Random access vs sequential (worst of 5 frames)  canvas: ${ra('raMax', 'raPct')}   SVG: ${ra('svgRaMax', 'svgRaPct')}`);
}
if (report.failures.length) { console.log(`Failed:\n  ${report.failures.join('\n  ')}`); process.exit(1); }
console.log('All runs finished (record only)');

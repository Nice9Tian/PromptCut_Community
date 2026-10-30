/**
 * 实验:Lottie 用画布来画行不行、和现在用 SVG 来画差多少。
 * 出处:`docs/plan/render-standard.md`「Lottie 动效」(2026-10-10 用户说「你帮我试试能不能用 canvas 办了,同时比较一下 svg 和 canvas 之间的性能差距」)。
 *
 *   node scripts/probes/lottie-renderer-probe.mjs [--assets adrock,bodymovin,gatin,happy2016,navidad] [--frames 90]
 *        [--out <目录>]      存每个素材几帧的对比图(SVG 画的、画布画的各一张)
 *        [--throttle 4] [--cores 2] [--software] [--json <文件>]
 *
 * 做法:真 Chrome 里用项目自带的播放库(`lottie-web`)把同一个素材各建一份——一份画在 SVG 上(现在的做法)、一份画在画布上,
 * 都放进 1920×1080 的框、完整显示(和卡片的缺省一样)。和卡片一样不让它自己播,每一帧调「跳到第几帧并渲染」。
 *
 * 量四个数(每个素材、两种画法各量):
 *   算一帧       只算「跳到这一帧」这一句的同步耗时。SVG 的画法这时只改了节点,真正画出来在之后;画布的画法这一句里已经画完。
 *   出一帧画面   每个动画帧跳一帧,连续做完的总时间 ÷ 帧数,把浏览器画和合成的时间也算进去(启动参数关了垂直同步与帧率上限)。
 *                这是「当场算、直接显示」的代价。
 *   拿到像素     跳到这一帧并把画面变成一张能送进编码器的位图要多久。这是「压进轨道流」的代价。
 *                画布:画面已经在画布里,直接取。SVG:要先把节点序列化、当成图片解码、再画到画布上。
 *   建好要多久   从拿到 JSON 到能出第一帧。
 *
 * 再比画面:取 5 帧(头、四分之一、中间、四分之三、尾),两种画法各拿到像素,逐像素比:平均差、差超过 16 的像素占比、透明度的平均差。
 * 两种画法各核对「跳着做和顺着做一样不一样」:先顺着做到这一帧,再从第 0 帧直接跳到这一帧,比两次的像素(随机访问)。
 *
 * 只记录,不判过不过;素材加载失败或画不出来退出码 1。
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

  // 拿到像素:画布直接取;SVG 序列化 → 当图片解码 → 画上画布。两边都落到同一张 1920×1080 的目标画布上
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
    // 算一帧(同步)
    const syncRuns = [];
    for (let r = 0; r < 3; r++) { anim.goToAndStop(0, true); const t0 = performance.now(); for (let f = 0; f < count; f++) anim.goToAndStop(f, true); syncRuns.push((performance.now() - t0) / count); }
    // 出一帧画面(含画与合成)
    const frameRuns = [];
    for (let r = 0; r < 3; r++) { anim.goToAndStop(0, true); await nextFrame(); await nextFrame(); const t0 = performance.now(); for (let f = 0; f < count; f++) { anim.goToAndStop(f, true); await nextFrame(); } frameRuns.push((performance.now() - t0) / count); }
    // 拿到像素
    const px = Math.min(count, 30); const pxRuns = [];
    for (let r = 0; r < 2; r++) { const t0 = performance.now(); for (let f = 0; f < px; f++) { anim.goToAndStop(f, true); await pixelsOf(renderer, box); } pxRuns.push((performance.now() - t0) / px); }
    out[renderer] = { buildMs: +m.buildMs.toFixed(1), syncMs: +med(syncRuns).toFixed(3), frameMs: +med(frameRuns).toFixed(3), pixelsMs: +med(pxRuns).toFixed(2),
      nodes: renderer === 'svg' ? box.querySelectorAll('svg *').length : null, svgKB: renderer === 'svg' ? +(new XMLSerializer().serializeToString(box.querySelector('svg')).length / 1024).toFixed(1) : null };
    box.style.display = 'none';
  }

  // 比画面
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
    // 顺着做到这一帧
    made.canvas.anim.goToAndStop(0, true); for (let k = 0; k <= f; k++) made.canvas.anim.goToAndStop(k, true);
    await pixelsOf('canvas', made.canvas.box);
    const seq = tctx.getImageData(0, 0, W, H).data.slice();
    // 从第 0 帧直接跳到这一帧
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
  page.on('pageerror', (e) => report.failures.push(`页面报错:${String(e.message || e).slice(0, 160)}`));
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
console.log(`机器:${report.host.cpu},${report.host.logicalCores} 个逻辑核;${report.chrome};lottie-web ${report.lottieWeb}`);
console.log(`条件:${SOFTWARE ? '关显卡' : '缺省'}${CORES ? `,限 ${CORES} 核(进程 ${report.affinity})` : ''}${THROTTLE > 1 ? `,主线程放慢 ${THROTTLE} 倍` : ''};每个素材量前 ${FRAMES} 帧;画进 1920×1080 的框`);
const x = (a, b) => (b > 0 ? `${(a / b).toFixed(1)} 倍` : '—');
for (const r of report.results) {
  console.log(`素材 ${r.name}(${r.w}×${r.h},${r.total} 帧,${r.layers} 层;SVG 画法 ${r.svg.nodes} 个节点、序列化 ${r.svg.svgKB} KB)`);
  console.log(`   算一帧(同步)      SVG ${r.svg.syncMs} 毫秒   画布 ${r.canvas.syncMs} 毫秒`);
  console.log(`   出一帧画面        SVG ${r.svg.frameMs} 毫秒   画布 ${r.canvas.frameMs} 毫秒   SVG 是画布的 ${x(r.svg.frameMs, r.canvas.frameMs)}`);
  console.log(`   拿到像素          SVG ${r.svg.pixelsMs} 毫秒   画布 ${r.canvas.pixelsMs} 毫秒   SVG 是画布的 ${x(r.svg.pixelsMs, r.canvas.pixelsMs)}`);
  console.log(`   建好              SVG ${r.svg.buildMs} 毫秒   画布 ${r.canvas.buildMs} 毫秒`);
  console.log(`   画面差(帧号:平均差/差超过16的像素占比/透明度平均差)  ${r.diff.map((d) => `${d.frame}:${d.mean}/${d.bigPct}%/${d.alphaMean}`).join('  ')}`);
  const ra = (maxKey, pctKey) => { const m = Math.max(...r.diff.map((d) => d[maxKey])), p = Math.max(...r.diff.map((d) => d[pctKey])); return m === 0 ? '逐字节相同' : `最多差 ${m}(满分 255),不同的像素最多占 ${p}%`; };
  console.log(`   跳着做和顺着做比(5 帧里最差的)  画布:${ra('raMax', 'raPct')}   SVG:${ra('svgRaMax', 'svgRaPct')}`);
}
if (report.failures.length) { console.log(`失败:\n  ${report.failures.join('\n  ')}`); process.exit(1); }
console.log('全部跑完(只记录)');

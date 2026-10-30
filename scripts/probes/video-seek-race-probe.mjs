/**
 * 视频 seek 竞态的最小复现(不起 dev server、不走导出管线):受帧控制的 chrome-headless-shell 里一个不挂进文档的
 * <video>,照 `src/render/cards/mediaSource.ts` 的写法「设 currentTime → 等 seeked → 读当前帧」连做若干遍,
 * 数「seeked 之后当场读到的不是目标那一帧」有几次。读帧同时用 `new VideoFrame(video).timestamp` 和
 * `createImageBitmap` 的像素(第 n 帧整幅灰度 16 × (n mod 16)),两边互证。
 *
 *   node scripts/probes/video-seek-race-probe.mjs [--port 6211] [--loops 20] [--hogs 0] [--mode seeked|fixed]
 *
 *   --mode seeked  取帧只等 seeked(改前的写法)
 *   --mode fixed   取帧直接用 `src/render/cards/mediaSource.ts` 的 `CardMediaSource`(经 Vite 中间件按源码加载)
 *   --hogs N       另起 N 个占满一个核的 node 进程
 *   --busy         页面上放一块每拍重画的 1280×720 WebGL 画布,beginFrame 带截图(让合成与光栅线程忙起来;不加时复现不出)
 *   --settle MS    每次取帧后隔多久再取下一帧(默认 30;0 = 紧接着取,更接近导出)
 *
 * 取帧期间 Node 侧每 4 ms 发一拍 beginFrame(与 `server/bakery/frame-ready.mjs` 的 waitFrameReady 同样的节奏)。
 * 输出最后一行 JSON:`{ ok, seeks, stale, wrongPixel, samples }`;退出码 0 当且仅当 stale 与 wrongPixel 都是 0。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { createServer as createViteServer } from 'vite';
import { findFfmpeg } from '../../server/bakery/ffmpeg.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const PORT = Number(opt('--port', 6211));
const LOOPS = Number(opt('--loops', 20));
const HOGS = Number(opt('--hogs', 0));
const MODE = opt('--mode', 'seeked');
const BUSY = args.includes('--busy');
const SETTLE = Number(opt('--settle', 30));
const WORK = path.join(os.tmpdir(), `pc-seek-race-${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`);
fs.mkdirSync(WORK, { recursive: true });

const hogs = [];
const stopHogs = () => { for (const h of hogs.splice(0)) { try { h.kill(); } catch { /* 已退出 */ } } };
process.on('exit', stopHogs);

const ffmpeg = await findFfmpeg();
const mp4 = path.join(WORK, 'src.mp4');
const r = spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=64x64:r=30:d=3',
  '-vf', "format=rgb24,geq=r='16*mod(N\\,16)':g='16*mod(N\\,16)':b='16*mod(N\\,16)',format=yuv420p",
  '-c:v', 'libx264', '-crf', '4', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { encoding: 'utf8', windowsHide: true });
if (r.status !== 0) throw new Error(r.stderr);
const bytes = fs.readFileSync(mp4);

/* 页面:判据写在这里,修法改了要同步 */
const PAGE = `<!doctype html><meta charset="utf-8"><body><script>
const LEAD = 0.002;
const video = document.createElement('video');
video.muted = true; video.preload = 'auto'; video.playsInline = true;
window.ready = new Promise((res, rej) => { video.addEventListener('loadeddata', res, { once: true }); video.addEventListener('error', rej, { once: true }); });
video.src = '/src.mp4';
const canvas = new OffscreenCanvas(1, 1), ctx = canvas.getContext('2d', { willReadFrequently: true });
const level = (bitmap) => { ctx.drawImage(bitmap, 28, 28, 8, 8, 0, 0, 1, 1); const p = ctx.getImageData(0, 0, 1, 1).data; return Math.round(p[0] / 16) % 16; };
const stamp = (v) => { const f = new VideoFrame(v); const t = f.timestamp, d = f.duration; f.close(); return { t, d }; };
const seekOnly = (target) => new Promise((res) => { video.addEventListener('seeked', res, { once: true }); video.currentTime = target; });
window.__seekedFrame = async (time) => {
  const target = time + LEAD;
  if (Math.abs(video.currentTime - target) > 1e-5) await seekOnly(target);
  return createImageBitmap(video, { premultiplyAlpha: 'none' });
};
if (location.hash === '#busy') {
  const c = document.createElement('canvas'); c.width = 1280; c.height = 720; c.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh';
  document.body.appendChild(c);
  const gl = c.getContext('webgl2');
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, '#version 300 es\\nin vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }'));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, '#version 300 es\\nprecision highp float; uniform float t; out vec4 o; void main(){ vec2 u = gl_FragCoord.xy/720.; float a=0.; for(int i=0;i<40;i++){ a += sin(u.x*float(i)+t)*cos(u.y*float(i)-t); } o = vec4(fract(a),fract(a*.5),fract(a*.25),1.); }'));
  gl.linkProgram(prog); gl.useProgram(prog);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  let t = 0; const draw = () => { gl.uniform1f(gl.getUniformLocation(prog, 't'), t += .1); gl.drawArrays(gl.TRIANGLES, 0, 3); requestAnimationFrame(draw); }; draw();
}
window.run = async (times, mode, SETTLE_MS) => {
  await window.ready;
  const out = [];
  for (const time of times) {
    const bitmap = mode === 'fixed' ? await window.__fixedFrame(time) : await window.__seekedFrame(time);
    const v = mode === 'fixed' ? await window.__fixedVideo() : video;
    const now = stamp(v);
    const lvl = level(bitmap); bitmap.close();
    await new Promise((res) => setTimeout(res, SETTLE_MS));
    const later = stamp(v);
    out.push([time, now.t, now.d, lvl, later.t]);
  }
  return out;
};
</script>
<script type="module">
if (location.search.includes('fixed')) {
  const { CardMediaSource } = await import('/src/render/cards/mediaSource.ts');
  const source = new CardMediaSource(), media = { url: '/src.mp4', kind: 'video' };
  window.__fixedFrame = (time) => source.frame(media, time);
  window.__fixedVideo = () => source.sources.get(media.url);
  window.__fixedWaits = () => source.settleWaits;
  await source.frame(media, 0).then((b) => b.close());
}
window.fixedReady = true;
</script>`;

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const vite = await createViteServer({ root: REPO, configFile: false, appType: 'custom', logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });
const server = http.createServer((req, res) => {
  if (req.url.split('?')[0] === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); return; }
  if (req.url === '/src.mp4') {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const start = Number(m[1]), end = m[2] ? Number(m[2]) : bytes.length - 1;
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 });
      res.end(bytes.subarray(start, end + 1));
    } else { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': bytes.length }); res.end(bytes); }
    return;
  }
  vite.middlewares(req, res, () => { res.writeHead(404); res.end(); });
});
await new Promise((res) => server.listen(PORT, '127.0.0.1', res));

const CHROME_ARGS = ['--window-position=-32000,-32000', '--no-first-run', '--no-default-browser-check',
  '--enable-begin-frame-control', '--run-all-compositor-stages-before-draw', '--hide-scrollbars',
  '--disable-gpu', '--disable-gpu-rasterization', '--disable-gpu-compositing', '--font-render-hinting=none',
  '--force-device-scale-factor=1', '--disable-partial-raster', '--disable-threaded-animation', '--enable-unsafe-swiftshader',
  ...(process.env.PROBE_CHROME_ARGS ? process.env.PROBE_CHROME_ARGS.split(/\s+/).filter(Boolean) : [])];
const browser = await puppeteer.launch({ headless: 'shell', protocolTimeout: 120000, args: CHROME_ARGS });
const result = { ok: false, mode: MODE, hogs: HOGS, loops: LOOPS, seeks: 0, stale: 0, wrongPixel: 0, samples: [] };
try {
  const bs = await browser.target().createCDPSession();
  const { targetId } = await bs.send('Target.createTarget', { url: 'about:blank', enableBeginFrameControl: true, width: 1280, height: 720 });
  const target = await browser.waitForTarget((t) => t._targetId === targetId);
  const page = await target.page();
  const client = await page.createCDPSession();
  let tick = 1000;
  const beginFrame = () => client.send('HeadlessExperimental.beginFrame', { frameTimeTicks: (tick += 1000 / 60), interval: 1000 / 60,
    ...(BUSY ? { screenshot: { format: 'png', optimizeForSpeed: true } } : { noDisplayUpdates: true }) }).catch(() => {});
  let pumping = true;
  const pump = (async () => { while (pumping) { await beginFrame(); await new Promise((res) => setTimeout(res, 4)); } })();
  await page.goto(`http://127.0.0.1:${PORT}/${MODE === 'fixed' ? '?fixed' : ''}${BUSY ? '#busy' : ''}`);
  await page.waitForFunction(() => window.fixedReady === true, { timeout: 60000 });
  await page.evaluate(() => window.ready);
  for (let i = 0; i < HOGS; i++) hogs.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore', windowsHide: true }));
  // ①素材效果卡 rate 0.5 offset 0.35 与 rate 0.5 offset 0 两段的取帧时刻
  const times = [];
  for (const offset of [0.35, 0]) for (let n = 0; n < 60; n++) times.push(offset + 0.5 * n / 30);
  for (let loop = 0; loop < LOOPS; loop++) {
    const rows = await page.evaluate((t, m, st) => window.run(t, m, st), times, MODE, SETTLE);
    for (const [time, ts, dur, lvl, later] of rows) {
      result.seeks++;
      const want = Math.floor(time * 30 + 1e-6);
      const gotByTs = Math.round(ts * 30 / 1e6);
      const stale = gotByTs !== want, wrongPixel = lvl !== want % 16;
      if (stale) result.stale++;
      if (wrongPixel) result.wrongPixel++;
      if ((stale || wrongPixel) && result.samples.length < 12) result.samples.push({ loop, time: +time.toFixed(4), want, gotByTs, pixel: lvl, laterByTs: Math.round(later * 30 / 1e6), duration: dur });
    }
    console.log(`[seek-race] loop ${loop + 1}/${LOOPS}: seeks=${result.seeks} stale=${result.stale} wrongPixel=${result.wrongPixel}`);
  }
  if (MODE === 'fixed') {
    // 核对确实生效(返回 true/false,而不是读不出帧时的 null):否则 fixed 等于没修
    result.coversCheck = await page.evaluate(async () => (await import('/src/render/cards/mediaSource.ts')).currentFrameCovers(await window.__fixedVideo()));
    if (result.coversCheck !== true) result.stale++;
    result.settleWaits = await page.evaluate(() => window.__fixedWaits());
  }
  pumping = false; await pump;
} finally {
  stopHogs();
  await browser.close().catch(() => {});
  server.close();
  await vite.close().catch(() => {});
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* 留给系统清 */ }
}
result.ok = result.stale === 0 && result.wrongPixel === 0;
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);

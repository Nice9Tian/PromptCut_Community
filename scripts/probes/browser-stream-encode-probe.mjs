/**
 * Real-world test of generating track streams on the browser side: actually encodes in Chrome using
 * `src/render/streamEncode.ts`, demuxes with `streamPlayer.ts` plus `VideoDecoder` to decode back,
 * and compares frame-by-frame against source graphics.
 *
 *   node scripts/probes/browser-stream-encode-probe.mjs [options]
 *
 *   --size 1920x1080      Width and height of the card frame (even numbers), multiple sets allowed:
 *                         --size 960x540,1920x1080
 *   --frames 90           Number of frames to encode
 *   --fps 30
 *   --software            CPU only: disable GPU in Chrome (--disable-gpu), encoder requests
 *                         "prefer-software"
 *   --cores 2             Limit the entire Chrome process tree to the first N CPU cores (simulates
 *                         low-spec machines; Windows only)
 *   --throttle 4          Slow down the main thread further by a factor (CDP CPU throttling) to
 *                         simulate slower cores
 *   --json <file>         Save results to a separate JSON file
 *
 * Pass criteria (exit code 1 if any condition is not met):
 *   - Every set encodes successfully; output frame count = input frame count, segment count =
 *     ceil(frame count / 15), and the first sample of each segment is a keyframe;
 *   - Decoded frame count is identical;
 *   - Average error of color half (premultiplied color) and alpha half compared to source graphics
 *     is ≤ 3/255, 99th percentile ≤ 12/255 (lossy compression, pixel-identical match not required);
 *   - Color half is black where fully transparent (premultiplied color convention): average value
 *     of those pixels is ≤ 3/255.
 * Speed is recorded only, not treated as a pass condition (`docs/semantics/guide_files/verification.md`
 * "Record elapsed time only, do not treat as a gate").
 *
 * The page is opened via a local temporary HTTP server (only localhost counts as a secure context,
 * and WebCodecs requires a secure context); the server only serves the three source files needed
 * this time, with TypeScript types stripped on the fly using sucrase. Port is allocated by the
 * system, listening only on 127.0.0.1, and shut down after running.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { transform } from 'sucrase';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const flag = (name) => process.argv.includes(name);

const SIZES = String(arg('--size', '960x540,1920x1080')).split(',').map((s) => s.trim().split('x').map(Number));
const FRAMES = Number(arg('--frames', '90'));
const FPS = Number(arg('--fps', '30'));
const SOFTWARE = flag('--software');
const CORES = Number(arg('--cores', '0'));
const THROTTLE = Number(arg('--throttle', '1'));
const JSON_OUT = arg('--json', null);

/* ---------------------------------------------------------------- Temporary server: three source files + an empty page */

const MODULES = { '/m/streamEncode.js': 'src/render/streamEncode.ts', '/m/streamMux.js': 'src/render/streamMux.ts', '/m/streamPlayer.js': 'src/render/streamPlayer.ts' };
const moduleSource = (rel) => transform(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { transforms: ['typescript'], disableESTransforms: true }).code
  .replace(/from "\.\/(streamMux|streamPlayer|streamEncode)\.ts"/g, 'from "./$1.js"');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><title>stream encode probe</title>'); return; }
  const rel = MODULES[url.pathname];
  if (rel) { res.setHeader('content-type', 'text/javascript; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.end(moduleSource(rel)); return; }
  res.statusCode = 404; res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://localhost:${server.address().port}`;

/* ---------------------------------------------------------------- Limit Chrome process tree to the first N cores */

function limitCores(rootPid, cores) {
  if (process.platform !== 'win32' || !(cores > 0)) return { applied: false, reason: process.platform !== 'win32' ? 'Only done on Windows' : 'Not requested' };
  const mask = (2 ** cores) - 1;
  // Process tree: root process and all its descendants (Chrome GPU, render, and utility processes
  // are all spawned by the root process)
  const script = `
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$ids = New-Object System.Collections.Generic.List[int]; $ids.Add(${rootPid})
$i = 0; while ($i -lt $ids.Count) { $p = $ids[$i]; foreach ($c in $all) { if ($c.ParentProcessId -eq $p -and -not $ids.Contains([int]$c.ProcessId)) { $ids.Add([int]$c.ProcessId) } }; $i++ }
$n = 0; foreach ($id in $ids) { try { (Get-Process -Id $id -ErrorAction Stop).ProcessorAffinity = [IntPtr]${mask}; $n++ } catch {} }
"$n/$($ids.Count)"`;
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
  return { applied: true, cores, mask, processes: out };
}

/* ---------------------------------------------------------------- Section running in the page */

async function inPage({ width, height, frames, fps, software }) {
  const { openStreamEncoder, packedSize, STREAM_HALF_PAD } = await import('/m/streamEncode.js');
  const { parseInit, parseSegment, chunkTimestamp, SEGMENT_FRAMES } = await import('/m/streamPlayer.js');

  // Source graphics: animation with transparency (moving gradient blocks, translucent circle, a line
  // of text); each frame can be redrawn by frame number
  const src = new OffscreenCanvas(width, height);
  const g = src.getContext('2d');
  const paint = (i) => {
    g.clearRect(0, 0, width, height);
    const x = Math.round(((i * 11) % Math.max(1, width - width / 3)));
    const grad = g.createLinearGradient(x, 0, x + width / 3, height / 2);
    grad.addColorStop(0, `hsl(${(i * 4) % 360} 80% 55%)`); grad.addColorStop(1, 'hsl(40 95% 60%)');
    g.fillStyle = grad; g.fillRect(x, height / 6, width / 3, height / 3);
    g.fillStyle = 'rgba(40, 160, 255, 0.45)'; g.beginPath(); g.arc(width / 2, height * 0.68, height / 5 + (i % 20), 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.92)'; g.font = `600 ${Math.round(height / 12)}px sans-serif`; g.fillText(`轨道流 ${String(i).padStart(3, '0')}`, width / 12, height * 0.93);
  };

  let init = null; const segs = [];
  const t0 = performance.now();
  const enc = await openStreamEncoder({ width, height, fps, ...(software ? { hardwareAcceleration: 'prefer-software' } : {}), onInit: (i) => { init = i; }, onSegment: (s) => { segs.push(s); } });
  let paintMs = 0;
  for (let i = 0; i < frames; i++) { const a = performance.now(); paint(i); paintMs += performance.now() - a; await enc.add(src); }
  const done = await enc.finish();
  const totalMs = performance.now() - t0;

  // Structure check: segment count, sample count per segment, segment-initial keyframe
  const problems = [];
  const wantSegs = Math.ceil(frames / SEGMENT_FRAMES);
  if (segs.length !== wantSegs) problems.push(`Segment count ${segs.length}, expected ${wantSegs}`);
  const packed = packedSize(width, height);
  const cfg = parseInit(init.bytes.buffer.slice(init.bytes.byteOffset, init.bytes.byteOffset + init.bytes.byteLength));
  if (cfg.width !== packed.width || cfg.height !== packed.height) problems.push(`Width and height in the init segment ${cfg.width}×${cfg.height}, expected ${packed.width}×${packed.height}`);

  // Decode back and compare frame-by-frame against source graphics
  const out = new OffscreenCanvas(packed.width, packed.height); const og = out.getContext('2d', { willReadFrequently: true });
  const ref = new OffscreenCanvas(width, height); const rg = ref.getContext('2d', { willReadFrequently: true });
  const stat = { n: 0, colorSum: 0, alphaSum: 0, blackSum: 0, blackN: 0, colorHist: new Uint32Array(256), alphaHist: new Uint32Array(256), colorMax: 0, alphaMax: 0 };
  const compare = (frame, index) => {
    og.drawImage(frame, 0, 0);
    const top = og.getImageData(0, 0, width, height).data;
    const bottom = og.getImageData(0, height + STREAM_HALF_PAD, width, height).data;
    paint(index); rg.clearRect(0, 0, width, height); rg.drawImage(src, 0, 0);
    const want = rg.getImageData(0, 0, width, height).data;      // Non-premultiplied RGBA
    const step = 4 * 7;                                           // Sample one every 7 pixels, enough for evaluation
    for (let p = 0; p < want.length; p += step) {
      const a = want[p + 3];
      for (let c = 0; c < 3; c++) {
        const premul = Math.round((want[p + c] * a) / 255);
        const d = Math.abs(top[p + c] - premul);
        stat.colorSum += d; stat.colorHist[d]++; if (d > stat.colorMax) stat.colorMax = d;
        if (a === 0) { stat.blackSum += top[p + c]; stat.blackN++; }
      }
      const da = Math.abs(bottom[p] - a);
      stat.alphaSum += da; stat.alphaHist[da]++; if (da > stat.alphaMax) stat.alphaMax = da;
      stat.n++;
    }
  };
  // Compare and close decoded frames immediately: holding about a dozen unclosed frames in the
  // decoder at once will freeze (the hard constraint noted in the `streamPlayer.ts` header)
  let decoded = 0; let decodeError = null;
  const dec = new VideoDecoder({ output: (f) => { try { compare(f, Math.round((f.timestamp * fps) / 1e6)); decoded++; } catch (e) { decodeError = String(e); } finally { f.close(); } }, error: (e) => { decodeError = String(e); } });
  dec.configure({ codec: cfg.codec, codedWidth: cfg.width, codedHeight: cfg.height, description: cfg.description });
  const t1 = performance.now();
  for (const seg of segs) {
    const buf = seg.bytes.buffer.slice(seg.bytes.byteOffset, seg.bytes.byteOffset + seg.bytes.byteLength);
    const table = parseSegment(buf);
    if (table.length !== seg.samples) problems.push(`Segment ${seg.index} demuxed to ${table.length} samples, expected ${seg.samples}`);
    if (!table[0]?.isSync) problems.push(`The first sample of segment ${seg.index} is not a keyframe`);
    table.forEach((s, i) => dec.decode(new EncodedVideoChunk({ type: s.isSync ? 'key' : 'delta', timestamp: chunkTimestamp(seg.index * SEGMENT_FRAMES + i, fps), data: new Uint8Array(buf, s.offset, s.size) })));
    await dec.flush();                                            // Decode segment by segment
  }
  dec.close();
  const decodeMs = performance.now() - t1;
  if (decodeError) problems.push(`Decode error: ${decodeError}`);
  if (decoded !== frames) problems.push(`Decoded back ${decoded} frames, expected ${frames}`);

  const pct = (hist, total, q) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * q) return v; } return 255; };
  const colorTotal = stat.n * 3;
  const bytes = segs.reduce((s, x) => s + x.bytes.length, 0) + init.bytes.length;
  return {
    size: `${width}x${height}`, packed: `${packed.width}x${packed.height}`, frames, segments: segs.length, mode: done.mode, codec: done.codec,
    encodeFps: +(frames / ((totalMs - paintMs) / 1000)).toFixed(1), msPerFrame: +((totalMs - paintMs) / frames).toFixed(2), totalMs: Math.round(totalMs), paintMs: Math.round(paintMs),
    kib: Math.round(bytes / 1024), kbps: Math.round((bytes * 8) / (frames / fps) / 1000),
    decoded, decodeFps: +(decoded / (decodeMs / 1000)).toFixed(1),
    colorMean: +(stat.colorSum / colorTotal).toFixed(3), colorP99: pct(stat.colorHist, colorTotal, 0.99), colorMax: stat.colorMax,
    alphaMean: +(stat.alphaSum / stat.n).toFixed(3), alphaP99: pct(stat.alphaHist, stat.n, 0.99), alphaMax: stat.alphaMax,
    transparentColorMean: stat.blackN ? +(stat.blackSum / stat.blackN).toFixed(3) : null,
    problems,
  };
}

/* ---------------------------------------------------------------- Run */

const report = { when: new Date().toISOString(), host: { cpu: os.cpus()[0]?.model?.trim(), logicalCores: os.cpus().length, memGiB: Math.round(os.totalmem() / 2 ** 30), platform: `${os.platform()} ${os.release()}` },
  options: { sizes: SIZES.map((s) => s.join('x')), frames: FRAMES, fps: FPS, software: SOFTWARE, cores: CORES || null, throttle: THROTTLE }, results: [], failures: [] };
let browser = null;
try {
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 600000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', ...(SOFTWARE ? ['--disable-gpu'] : [])] });
  report.chrome = await browser.version();
  if (CORES > 0) report.affinityAtLaunch = limitCores(browser.process().pid, CORES);
  const page = await browser.newPage();
  await page.goto(base + '/');
  if (CORES > 0) report.affinityAfterPage = limitCores(browser.process().pid, CORES);     // Newly spawned render processes will inherit it; scan again here to catch those already running
  report.page = await page.evaluate(() => ({ secure: isSecureContext, cores: navigator.hardwareConcurrency, hasEncoder: typeof VideoEncoder === 'function' }));
  if (THROTTLE > 1) { const cdp = await page.createCDPSession(); await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE }); }
  for (const [width, height] of SIZES) {
    let r;
    try { r = await page.evaluate(inPage, { width, height, frames: FRAMES, fps: FPS, software: SOFTWARE }); }
    catch (err) { r = { size: `${width}x${height}`, problems: [`Encoding failed: ${String(err?.message ?? err).split('\n')[0]}`] }; }
    const fails = [...(r.problems ?? [])];
    if (r.decoded !== undefined) {
      if (r.colorMean > 3) fails.push(`Color-half mean error ${r.colorMean} > 3`);
      if (r.colorP99 > 12) fails.push(`Color-half 99th-percentile error ${r.colorP99} > 12`);
      if (r.alphaMean > 3) fails.push(`Alpha mean error ${r.alphaMean} > 3`);
      if (r.alphaP99 > 12) fails.push(`Alpha 99th-percentile error ${r.alphaP99} > 12`);
      if (r.transparentColorMean !== null && r.transparentColorMean > 3) fails.push(`Color-half mean ${r.transparentColorMean} > 3 where fully transparent (should be black)`);
    }
    r.pass = fails.length === 0;
    report.results.push(r);
    for (const f of fails) report.failures.push(`${r.size}:${f}`);
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}

const row = (r) => r.decoded === undefined ? `${r.size}  ${r.problems.join(';')}`
  : `${r.size.padEnd(10)} packed ${r.packed.padEnd(10)} ${r.mode.padEnd(9)} ${r.codec}  encode ${String(r.encodeFps).padStart(6)} fps (${r.msPerFrame} ms/frame)  ${String(r.kbps).padStart(6)} kbps  decoded ${r.decoded}/${r.frames}  color error mean ${r.colorMean} p99 ${r.colorP99} max ${r.colorMax}  alpha error mean ${r.alphaMean} p99 ${r.alphaP99} max ${r.alphaMax}  color at transparent ${r.transparentColorMean}  ${r.pass ? 'pass' : 'fail'}`;
console.log(`Machine: ${report.host.cpu}, ${report.host.logicalCores} logical cores, ${report.host.memGiB} GiB; ${report.chrome}`);
console.log(`Conditions: ${SOFTWARE ? 'CPU only (GPU off, software encoding)' : 'Default (use the GPU if present)'}${CORES ? `, limited to ${CORES} cores (processes ${report.affinityAfterPage?.processes}), page sees ${report.page?.cores} cores` : ''}${THROTTLE > 1 ? `, main thread slowed ${THROTTLE}x` : ''}; ${FRAMES} frames, ${FPS} fps`);
for (const r of report.results) console.log(row(r));
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
if (report.failures.length) { console.log('Failed:\n  ' + report.failures.join('\n  ')); process.exitCode = 1; } else console.log('All passed');

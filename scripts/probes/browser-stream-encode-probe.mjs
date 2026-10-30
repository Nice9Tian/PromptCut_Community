/**
 * 浏览器侧生成轨道流的实测:真的在 Chrome 里用 `src/render/streamEncode.ts` 压,再用 `streamPlayer.ts` 的解封装
 * 加 `VideoDecoder` 解回来,逐帧和原画比。
 *
 *   node scripts/probes/browser-stream-encode-probe.mjs [选项]
 *
 *   --size 1920x1080      卡片画面的宽高(偶数),可以给多组:--size 960x540,1920x1080
 *   --frames 90           压多少帧
 *   --fps 30
 *   --software            只用处理器:Chrome 关掉显卡(--disable-gpu),编码器要「prefer-software」
 *   --cores 2             把整个 Chrome 进程树限制在前 N 个处理器核上(模拟低配机;只在 Windows 上做)
 *   --throttle 4          主线程再按倍数放慢(CDP 的处理器节流),模拟更慢的核
 *   --json <文件>         结果另存一份 JSON
 *
 * 判过的标准(任一不满足退出码 1):
 *   - 每组都压得出来,出来的帧数 = 送进去的帧数,段数 = ceil(帧数 / 15),每段第一个样本是关键帧;
 *   - 解回来的帧数相同;
 *   - 色半区(预乘色)与透明度半区,和原画比的平均误差 ≤ 3/255、99% 分位 ≤ 12/255(有损压缩,不要求逐像素相同);
 *   - 全透明的地方色半区是黑的(预乘色的约定):那些像素的平均值 ≤ 3/255。
 * 速度只记录,不当通过条件(`docs/semantics/guide_files/verification.md`「耗时只记录,不当闸门」)。
 *
 * 页面经本机的一个临时 HTTP 服务打开(localhost 才算安全上下文,WebCodecs 要安全上下文);服务只发这次要用的三个源码文件,
 * TypeScript 当场用 sucrase 去掉类型。端口由系统分配,只听 127.0.0.1,跑完关掉。
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

/* ---------------------------------------------------------------- 临时服务:三个源码文件 + 一张空页面 */

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

/* ---------------------------------------------------------------- 把 Chrome 进程树限制在前 N 个核上 */

function limitCores(rootPid, cores) {
  if (process.platform !== 'win32' || !(cores > 0)) return { applied: false, reason: process.platform !== 'win32' ? '只在 Windows 上做' : '没要求' };
  const mask = (2 ** cores) - 1;
  // 进程树:根进程和它所有的子孙(Chrome 的显卡进程、渲染进程、工具进程都是根进程起的)
  const script = `
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$ids = New-Object System.Collections.Generic.List[int]; $ids.Add(${rootPid})
$i = 0; while ($i -lt $ids.Count) { $p = $ids[$i]; foreach ($c in $all) { if ($c.ParentProcessId -eq $p -and -not $ids.Contains([int]$c.ProcessId)) { $ids.Add([int]$c.ProcessId) } }; $i++ }
$n = 0; foreach ($id in $ids) { try { (Get-Process -Id $id -ErrorAction Stop).ProcessorAffinity = [IntPtr]${mask}; $n++ } catch {} }
"$n/$($ids.Count)"`;
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
  return { applied: true, cores, mask, processes: out };
}

/* ---------------------------------------------------------------- 页面里跑的那一段 */

async function inPage({ width, height, frames, fps, software }) {
  const { openStreamEncoder, packedSize, STREAM_HALF_PAD } = await import('/m/streamEncode.js');
  const { parseInit, parseSegment, chunkTimestamp, SEGMENT_FRAMES } = await import('/m/streamPlayer.js');

  // 原画:带透明的动画(渐变色块在动、半透明的圆、一行字),每帧都能按帧号重画出来
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

  // 结构核对:段数、每段样本数、段首关键帧
  const problems = [];
  const wantSegs = Math.ceil(frames / SEGMENT_FRAMES);
  if (segs.length !== wantSegs) problems.push(`段数 ${segs.length},应为 ${wantSegs}`);
  const packed = packedSize(width, height);
  const cfg = parseInit(init.bytes.buffer.slice(init.bytes.byteOffset, init.bytes.byteOffset + init.bytes.byteLength));
  if (cfg.width !== packed.width || cfg.height !== packed.height) problems.push(`初始化段里的宽高 ${cfg.width}×${cfg.height},应为 ${packed.width}×${packed.height}`);

  // 解回来,逐帧和原画比
  const out = new OffscreenCanvas(packed.width, packed.height); const og = out.getContext('2d', { willReadFrequently: true });
  const ref = new OffscreenCanvas(width, height); const rg = ref.getContext('2d', { willReadFrequently: true });
  const stat = { n: 0, colorSum: 0, alphaSum: 0, blackSum: 0, blackN: 0, colorHist: new Uint32Array(256), alphaHist: new Uint32Array(256), colorMax: 0, alphaMax: 0 };
  const compare = (frame, index) => {
    og.drawImage(frame, 0, 0);
    const top = og.getImageData(0, 0, width, height).data;
    const bottom = og.getImageData(0, height + STREAM_HALF_PAD, width, height).data;
    paint(index); rg.clearRect(0, 0, width, height); rg.drawImage(src, 0, 0);
    const want = rg.getImageData(0, 0, width, height).data;      // 非预乘的 RGBA
    const step = 4 * 7;                                           // 每 7 个像素取一个,够判了
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
  // 解出来的帧当场比、当场关:解码器手里同时留着十来帧没关就会卡死(`streamPlayer.ts` 文件头记的那条硬约束)
  let decoded = 0; let decodeError = null;
  const dec = new VideoDecoder({ output: (f) => { try { compare(f, Math.round((f.timestamp * fps) / 1e6)); decoded++; } catch (e) { decodeError = String(e); } finally { f.close(); } }, error: (e) => { decodeError = String(e); } });
  dec.configure({ codec: cfg.codec, codedWidth: cfg.width, codedHeight: cfg.height, description: cfg.description });
  const t1 = performance.now();
  for (const seg of segs) {
    const buf = seg.bytes.buffer.slice(seg.bytes.byteOffset, seg.bytes.byteOffset + seg.bytes.byteLength);
    const table = parseSegment(buf);
    if (table.length !== seg.samples) problems.push(`第 ${seg.index} 段解封装出 ${table.length} 个样本,应为 ${seg.samples}`);
    if (!table[0]?.isSync) problems.push(`第 ${seg.index} 段的第一个样本不是关键帧`);
    table.forEach((s, i) => dec.decode(new EncodedVideoChunk({ type: s.isSync ? 'key' : 'delta', timestamp: chunkTimestamp(seg.index * SEGMENT_FRAMES + i, fps), data: new Uint8Array(buf, s.offset, s.size) })));
    await dec.flush();                                            // 一段一段解
  }
  dec.close();
  const decodeMs = performance.now() - t1;
  if (decodeError) problems.push(`解码出错:${decodeError}`);
  if (decoded !== frames) problems.push(`解回 ${decoded} 帧,应为 ${frames}`);

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

/* ---------------------------------------------------------------- 跑 */

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
  if (CORES > 0) report.affinityAfterPage = limitCores(browser.process().pid, CORES);     // 新起的渲染进程会继承,这里再扫一遍兜住已经起来的
  report.page = await page.evaluate(() => ({ secure: isSecureContext, cores: navigator.hardwareConcurrency, hasEncoder: typeof VideoEncoder === 'function' }));
  if (THROTTLE > 1) { const cdp = await page.createCDPSession(); await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE }); }
  for (const [width, height] of SIZES) {
    let r;
    try { r = await page.evaluate(inPage, { width, height, frames: FRAMES, fps: FPS, software: SOFTWARE }); }
    catch (err) { r = { size: `${width}x${height}`, problems: [`没压出来:${String(err?.message ?? err).split('\n')[0]}`] }; }
    const fails = [...(r.problems ?? [])];
    if (r.decoded !== undefined) {
      if (r.colorMean > 3) fails.push(`色半区平均误差 ${r.colorMean} > 3`);
      if (r.colorP99 > 12) fails.push(`色半区 99% 分位误差 ${r.colorP99} > 12`);
      if (r.alphaMean > 3) fails.push(`透明度平均误差 ${r.alphaMean} > 3`);
      if (r.alphaP99 > 12) fails.push(`透明度 99% 分位误差 ${r.alphaP99} > 12`);
      if (r.transparentColorMean !== null && r.transparentColorMean > 3) fails.push(`全透明处色半区平均 ${r.transparentColorMean} > 3(应为黑)`);
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
  : `${r.size.padEnd(10)} 拼合 ${r.packed.padEnd(10)} ${r.mode.padEnd(9)} ${r.codec}  压 ${String(r.encodeFps).padStart(6)} 帧/秒 (${r.msPerFrame} 毫秒/帧)  ${String(r.kbps).padStart(6)} kbps  解回 ${r.decoded}/${r.frames}  色误差 均 ${r.colorMean} p99 ${r.colorP99} 最大 ${r.colorMax}  透明度误差 均 ${r.alphaMean} p99 ${r.alphaP99} 最大 ${r.alphaMax}  透明处色 ${r.transparentColorMean}  ${r.pass ? '过' : '不过'}`;
console.log(`机器:${report.host.cpu},${report.host.logicalCores} 个逻辑核,${report.host.memGiB} GiB;${report.chrome}`);
console.log(`条件:${SOFTWARE ? '只用处理器(关显卡、软件编码)' : '缺省(有显卡就用)'}${CORES ? `,限制在 ${CORES} 个核(进程 ${report.affinityAfterPage?.processes}),页面看到 ${report.page?.cores} 个核` : ''}${THROTTLE > 1 ? `,主线程放慢 ${THROTTLE} 倍` : ''};${FRAMES} 帧,${FPS} fps`);
for (const r of report.results) console.log(row(r));
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
if (report.failures.length) { console.log('不过:\n  ' + report.failures.join('\n  ')); process.exitCode = 1; } else console.log('全部通过');

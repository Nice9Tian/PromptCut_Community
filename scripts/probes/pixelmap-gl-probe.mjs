/*
 * Probe / 验收:像素映射的 WebGL 后端画出来的,和保留下来的 CPU 参考实现 mapRgba 是不是同一张画面。
 *
 * 为什么要问:R1b 把逐像素的 CPU 循环整体删掉、换成 GLSL 片元着色器(实测 CPU 路线 1080p 每帧
 * 416～483 ms)。预览、导出页、see_frames 三处共用这一份,所以导出的像素基线会变一次 ——
 * 变成什么样必须有数:同一帧 1080p 测试图上逐像素比,差 ≤ 2 级才算换对了。
 *
 * 跑法:node scripts/probes/pixelmap-gl-probe.mjs [--out <目录>] [--cases 抠色到透明,按位置]
 *   自己起 vite 5199(用户的编辑台在 5190、另一个会话在 5197 / 5191,别碰)。
 *   源图和对照图由 ffmpeg 现做,放在 --out 目录里(默认 out/pixelmap-gl/);
 *   跑分用的 1080p 视频固定放 out/pixelmap-gl/,因为它要由 vite 当静态文件发出去。
 *
 * **不能加 --disable-gpu / --enable-unsafe-swiftshader**:这条验收就是要量真 GPU。
 * 报告里会写 UNMASKED_RENDERER_WEBGL,拿到 SwiftShader 就直接判失败。
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

/* ------------------------------------------------------------------ 素材 */

const ff = (args, label) => {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ${label} 失败:${r.stderr || r.error?.message}`);
};
const srcPng = path.join(OUT, 'src-testsrc2.png');
const tgtPng = path.join(OUT, 'src-target.png');
// 跑分用的视频要由 vite 服务,所以固定放在仓库里(OUT 可能在仓库外,/@fs 会被 vite 挡掉)
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

/* ------------------------------------------------------------------ 用例 */

const GREEN = 'smoothstep(0.35,0.8,g-r)*(1-smoothstep(0.15,0.45,b))';
const CASES = [
  { name: '抠色到透明', def: { name: '抠绿', where: GREEN, to: 'transparent' } },
  { name: '抠色到纯色', def: { name: '抠绿填蓝', where: GREEN, to: '#0033ff' } },
  { name: '按位置渐变选区', def: { name: '斜向', where: 'smoothstep(0.15,0.85,x)*smoothstep(0.1,0.9,y)', to: '#101820' } },
  { name: '按时间闪烁', def: { name: '闪', where: '0.5+0.5*sin(t*2*PI)', to: '#ffcc00' }, t: 0.37 },
  /*
   * 这一条会有几个像素对不上,是已知且不可避免的:colorSequence 取色是「对 from 做 RGB 最近邻」,
   * from = [#000000, #808080, #ffffff] 时,r+g+b 恰好等于 192 的像素到前两个 from 色**精确等距**。
   * 精确并列时 sequenceTarget 的本意是取靠前那个(严格小于),着色器按这个本意办(见 PC_SEQ_EPS);
   * 而 mapRgba 在 float64 上让 Math.hypot 的末位舍入替它决定,于是有时取了后一个。
   * 换句话说这几个像素上**着色器才是对的**。逐像素取色是离散映射,并列点上必然有这种跳变。
   */
  { name: '颜色序列-continuous', tiedNearest: true, def: { name: '连续', where: '1', mode: 'continuous', to: '#fff', colorSequence: { from: ['#000000', '#808080', '#ffffff'], to: ['#001133', '#ffcc88', '#ffffff'] } } },
  { name: '颜色序列-discrete', def: { name: '离散', where: '1', mode: 'discrete', to: '#fff', colorSequence: { from: ['#000000', '#555555', '#aaaaaa', '#ffffff'], to: ['#ff0000', '#00ff00', '#0000ff', '#ffff00'] } } },
  { name: '目标是另一段素材', def: { name: '换底', where: `1-(${GREEN})`, to: { kind: 'media', mediaId: 'B', stage: 'origin' } }, target: 'B' },
  { name: '通道非线性表达式', def: { name: '暗部提亮', where: '1-smoothstep(0,0.35,luma)', to: { kind: 'expr', r: 'r^0.6', g: 'g^0.6', b: 'b^0.6', a: 'a' } } },
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
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* 还没起来 */ }
    if (Date.now() > end) throw new Error('vite 没起来:\n' + viteLog);
    await new Promise((r) => setTimeout(r, 300));
  }
};

/* ------------------------------------------------------------------ 比对 */

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
  page.on('pageerror', (e) => console.log('[页面错误]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('[页面 console]', m.text()); });
  const HARNESS = `http://127.0.0.1:${PORT}/scripts/probes/pixelmap-gl-harness.html`;
  await page.goto(HARNESS, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__pmReady === true', { timeout: 120000 });
  /*
   * vite 第一次预打包依赖之后会主动让页面整体重载(「optimized dependencies changed」),
   * 正好撞在这里就会把执行上下文打掉。先静置一会儿把这一下吃掉,后面每次 evaluate 再兜一层重试。
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
        console.log('[probe] 页面重载了,重新灌源图再来一次');
        await page.waitForFunction('window.__pmReady === true', { timeout: 120000 });
        if (primed) await putSources();
      }
    }
  };

  const info = await ev(() => window.__pm.info());
  console.log('WebGL:', JSON.stringify(info));
  const software = /swiftshader|software|llvmpipe|basic render/i.test(info?.renderer ?? '');
  if (software) console.log('!! 拿到的是软件渲染,下面的性能数字不算数');

  await putSources();
  primed = true;

  for (const c of CASES) {
    if (ONLY.length && !ONLY.includes(c.name)) continue;
    const def = { id: 'pm-probe', ...normalizePixelMapDef(c.def) };
    const cls = classifyPixelMap(def);
    const t = c.t ?? 0;
    const gpuRes = await ev((d, s, tg, tt) => window.__pm.runGpu(d, s, tg, tt), def, 'A', c.target ?? null, t);
    const gpu = ungz(gpuRes.gz);

    // 参考图在 node 这边用同一份源字节、同一个 mapRgba 算
    const cpu = new Uint8ClampedArray(SRC.data.length);
    for (let i = 0; i < SRC.data.length; i += 4) {
      const target = c.target ? [TGT.data[i] / 255, TGT.data[i + 1] / 255, TGT.data[i + 2] / 255, TGT.data[i + 3] / 255] : null;
      const p = mapRgba(def, [SRC.data[i] / 255, SRC.data[i + 1] / 255, SRC.data[i + 2] / 255, SRC.data[i + 3] / 255],
        { x: (i / 4) % W / W, y: Math.floor(i / 4 / W) / H, t }, target);
      cpu[i] = Math.round(p[0] * 255); cpu[i + 1] = Math.round(p[1] * 255);
      cpu[i + 2] = Math.round(p[2] * 255); cpu[i + 3] = Math.round(p[3] * 255);
    }

    const cmp = compare(gpu, cpu);
    const slug = c.name.replace(/[^\w一-龥-]/g, '');
    writePng(path.join(OUT, `${slug}-gpu.png`), W, H, gpu);
    writePng(path.join(OUT, `${slug}-cpu.png`), W, H, cpu);
    // 差值图:放大 32 倍看得见
    const diff = new Uint8ClampedArray(gpu.length);
    for (let i = 0; i < gpu.length; i += 4) {
      for (let k = 0; k < 3; k++) diff[i + k] = Math.min(255, Math.abs(gpu[i + k] - cpu[i + k]) * 32);
      diff[i + 3] = 255;
    }
    writePng(path.join(OUT, `${slug}-diff32x.png`), W, H, diff);

    console.log(`${c.name.padEnd(12)} 类=${cls.kind} 最大差=${cmp.worst} >1级=${cmp.over1} >2级=${cmp.over2} 均差=${cmp.mean.toFixed(5)} 直方图0..5=${cmp.hist.join(',')}`);
    results.push({ case: c.name, class: cls.kind, tiedNearest: !!c.tiedNearest, def, ...cmp });
  }

  /* ---------------------------------------------------------- 性能 */
  const benchDef = { id: 'pm-bench', ...normalizePixelMapDef({ name: '抠绿', where: GREEN, to: 'transparent' }) };
  const perf = await ev((d, u, w, h, n) => window.__pm.bench(d, u, w, h, n),
    benchDef, '/out/pixelmap-gl/clip-1080p.mp4', W, H, 24);
  console.log('性能(1080p 视频,抠色到透明):预热 ' + perf.warmupMs.toFixed(2) + ' ms;主线程提交 p50 ' + perf.submitP50.toFixed(3) + ' ms / max ' + perf.submitMax.toFixed(3) + ' ms;' +
    'GPU ' + (perf.gpuP50 == null ? 'n/a' : 'p50 ' + perf.gpuP50.toFixed(3) + ' ms / max ' + perf.gpuMax.toFixed(3) + ' ms') + '(' + perf.gpuHow + ')');

  const report = { at: new Date().toISOString(), webgl: info, software, size: [W, H], cases: results, perf };
  fs.writeFileSync(path.join(OUT, 'pixelmap-gl-probe.json'), JSON.stringify(report, null, 2));
  console.log('\n数据写到', path.join(OUT, 'pixelmap-gl-probe.json'));

  // 标了 tiedNearest 的用例单独说:它超标的像素全在「到两个 from 色精确等距」的并列点上,
  // 那里着色器按 sequenceTarget 的本意取靠前那个,反而比 mapRgba 更守规矩。
  for (const r of results.filter((x) => x.tiedNearest && x.worst > 2)) {
    console.log(`(已知)${r.case}:${r.over2 / 3} 个精确并列的像素取了不同的 from 下标,占 ${(r.over2 / 3 / (W * H) * 100).toFixed(5)}%;见用例上的注释`);
  }
  const bad = results.filter((r) => r.worst > 2 && !r.tiedNearest);
  if (bad.length) { console.log('!! 超过 2 级的用例:', bad.map((b) => `${b.case}=${b.worst}`).join(' ')); process.exitCode = 1; }
} finally {
  if (browser) await browser.close().catch(() => {});
  /*
   * Windows 上 vite 是经 npx.cmd + shell 起的,`kill()` 只打到那层 shell,真正占着 5199 的
   * node 会活下来(实测跑完之后端口还 LISTENING)。所以整棵进程树一起收。
   */
  if (process.platform === 'win32' && vite.pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(vite.pid)], { windowsHide: true, stdio: 'ignore' });
  vite.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响结论 */ }
}

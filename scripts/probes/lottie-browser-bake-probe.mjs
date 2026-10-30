/**
 * 探针:浏览器节点为拿像素而当场生成一张卡的快照并画成位图,这一步对 Lottie 卡要多少体积和时间,和别的内置卡比在什么量级。
 * 出处:`docs/plan/render-refactor-task.md`「癸」的「浏览器节点现在按卡片 id 把 Lottie 排除在外……要不要放开,由执行方评估后写进报告」。
 *
 *   node scripts/probes/lottie-browser-bake-probe.mjs [--dist dist-online] [--port-base 27270] [--size 1920x1080] [--frames 40] [--jumps 20]
 *        [--lottie demo,adrock,bodymovin,gatin,happy2016,navidad] [--others punch-pill,odometer,checklist,focus-card,growth-curve,chapter-bar,entity-chips,mu-number-ticker]
 *        [--fidelity] [--json <文件>]
 *
 * 要先有在线构建:`npx vite build --mode online`(产出 `dist-online/`,含 `catalog/`)。
 *
 * 做法照 `stateful-seek-cost-probe.mjs`:起静态服务(父页一个源、舞台另一个源),父页照 stageRpc 协议把后台舞台切到「生成快照」的活,灌进一个只有一张卡的
 * 工程,然后调产品自己的 `bakeFrame`——就是在线页面的浏览器节点产单卡轨道流时,每一帧向舞台要像素用的那个调用
 * (`src/online/pageStreams.ts` 的 `bakeStream`):舞台在这一帧上 `createSnapshot`(把这张卡此刻的 DOM 连同算好的样式整个写成 HTML),
 * 再按 `bound` 把 HTML 画成位图(`renderSnapshotBitmap`:包进 SVG foreignObject、解码、画到画布,位图随事件转移给父页),HTML 字节本身丢掉(`html: false`)。
 * 每一帧回包里的:
 *   ms        舞台一侧这一帧的总耗时(拨时间、等就绪、生成快照、画位图);
 *   pixelsMs  其中把 HTML 画成位图那一步;
 *   bytes     这张卡这一帧的快照 HTML 有多大(原始字节)——旧理由里的「超过 300 KB 的体积上限」就是拿它比的;
 *   wall      父页从发出请求到收到回复的时间。
 * `--fidelity`:另核「当场生成快照再画成位图」画出来的 Lottie 和真的导出页画出来的是不是同一个画面(逐像素)。参照是一台隔离的开发服务器上的导出页
 * (`FramePipeline.bakery` + `bakeFrames`,1920×1080 透明底的 PNG),对照的是同一帧、同一个矩形(整个画框)的位图;每张 Lottie 卡取 3 帧。
 * 每张卡两组:顺推(第 0、1、2…… 帧连着要;direct 的卡每帧直接拨,有状态的卡接着上一帧推一步)和直接跳(仅 Lottie 卡:每次先 `bakeCancel`,
 * 再要全长里随机抽的帧)。只记录,不判过不过;任何一次 `bakeFrame` 失败退出码 1。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的导出目录 / 数据目录(--fidelity 会起一台隔离的开发服务器)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { PNG } from 'pngjs';
import { flagArg, serve, sleep } from './probe-connect.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = path.resolve(flagArg('dist', path.join(ROOT, 'dist-online')));
const BASE = Number(flagArg('port-base', '27270'));
const [W, H] = flagArg('size', '1920x1080').split('x').map(Number);
const FRAMES = Number(flagArg('frames', '40'));
const JUMPS = Number(flagArg('jumps', '20'));
const JSON_OUT = flagArg('json', null);
const FIDELITY = process.argv.includes('--fidelity');
const FPS = 30;
const LOTTIE = [
  { name: 'demo', cardId: 'lottie', seconds: 2, params: {} },
  { name: 'adrock', cardId: 'lottie-adrock', seconds: 13.07, params: {} },
  { name: 'bodymovin', cardId: 'lottie-bodymovin', seconds: 3.43, params: {} },
  { name: 'gatin', cardId: 'lottie-gatin', seconds: 3.2, params: {} },
  { name: 'happy2016', cardId: 'lottie-happy2016', seconds: 3.3, params: {} },
  { name: 'navidad', cardId: 'lottie-navidad', seconds: 5, params: {} },
];
const EMPTY_JSON = JSON.stringify({ v: '5.7.4', fr: 30, ip: 0, op: 60, w: 1920, h: 1080, nm: 'empty', ddd: 0, assets: [], layers: [] });
const lottieWant = (flagArg('lottie', LOTTIE.map((c) => c.name).join(','))).split(',').filter(Boolean);
const othersWant = (flagArg('others', 'punch-pill,odometer,checklist,focus-card,growth-curve,chapter-bar,entity-chips,mu-number-ticker')).split(',').filter(Boolean);
const CARDS = [
  { name: 'empty-lottie', kind: 'lottie', cardId: 'lottie', seconds: 2, params: { json: EMPTY_JSON } },
  ...LOTTIE.filter((c) => lottieWant.includes(c.name)).map((c) => ({ ...c, kind: 'lottie' })),
  ...othersWant.map((id) => ({ name: id, kind: 'other', cardId: id, seconds: Math.max(2, FRAMES / FPS + 1), params: {} })),
];
if (!fs.existsSync(path.join(DIST, 'stage.html'))) { console.error(`没有在线构建:${DIST}(先跑 npx vite build --mode online)`); process.exit(2); }

const projectOf = (card) => ({
  id: `bake-${card.name}`, name: '浏览器节点生成快照探针', width: W, height: H, fps: FPS, duration: card.seconds,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [{ id: 'tr', name: card.name, hidden: false, clips: [{ id: 'clip', kind: 'card', cardId: card.cardId, start: 0, end: card.seconds, params: card.params }] }],
});

const PARENT_HTML = `<!doctype html><meta charset=utf-8><title>bake parent</title>
<body style="margin:0"><iframe id=bg style="position:absolute;left:0;top:0;width:960px;height:540px;border:0;opacity:0;pointer-events:none"></iframe>
<script>
let ready = null, stageWin = null, stageOrigin = '*', seq = 0; const waiting = new Map();
window.__bitmaps = new Map(); window.__keepBitmaps = false;
window.__bitmapPng = async (n) => { const bm = window.__bitmaps.get(n); if (!bm) return null; const c = new OffscreenCanvas(bm.width, bm.height); c.getContext('2d').drawImage(bm, 0, 0); const blob = await c.convertToBlob({ type: 'image/png' }); const buf = new Uint8Array(await blob.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000)); try { bm.close(); } catch {} window.__bitmaps.delete(n); return btoa(bin); };
addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'pc-stage-ready') { ready = d.hostCapabilities || {}; return; }
  if (e.source !== stageWin) return;
  if (d.type === 'bake-frame') { if (window.__keepBitmaps && d.pixels?.bitmap) { window.__bitmaps.set(d.localFrame, d.pixels.bitmap); return; } try { d.pixels?.bitmap?.close(); } catch {} return; }
  if (d.type === 'pc-rpc-reply') { const w = waiting.get(d.id); if (w) { waiting.delete(d.id); d.ok ? w.res(d.result) : w.rej(new Error(d.error)); } }
});
window.__rpc = (method, ...args) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); stageWin.postMessage({ type: 'pc-rpc', id, method, args }, stageOrigin); });
window.__timed = async (method, ...args) => { const t0 = performance.now(); const r = await window.__rpc(method, ...args); return { wall: performance.now() - t0, r }; };
window.__setup = async (src) => { ready = null; const f = document.getElementById('bg'); f.src = src; stageWin = f.contentWindow; stageOrigin = new URL(src).origin;
  const t0 = performance.now(); while (!ready) { if (performance.now() - t0 > 60000) throw new Error('舞台 60 秒没就绪'); await new Promise((r) => setTimeout(r, 50)); } stageWin = f.contentWindow; return ready; };
</script>`;

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png', '.webp': 'image/webp' };
const handler = (req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Origin-Agent-Cluster', '?1');
  res.setHeader('Cache-Control', 'no-store');
  if (u.pathname === '/probe-parent') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(PARENT_HTML); }
  // 在线构建把 Lottie 素材放在根下的 /catalog/ (随 editor/ 一起部署,舞台源下也提供)
  let rel = u.pathname.startsWith('/editor/') ? u.pathname.slice('/editor/'.length) : u.pathname.startsWith('/catalog/') ? u.pathname.slice(1) : null;
  if (rel === null) { res.statusCode = 404; return res.end(); }
  if (!rel) rel = 'index.html';
  const file = path.join(DIST, decodeURIComponent(rel));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
};

const q = (xs, p) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null; };
const r2 = (x) => (x === null || x === undefined ? null : +x.toFixed(2));
const sum = (xs) => ({ n: xs.length, med: r2(q(xs, 0.5)), p90: r2(q(xs, 0.9)), max: r2(q(xs, 1)) });
const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const report = { when: new Date().toISOString(), host: { cpu: os.cpus()[0]?.model?.trim(), logicalCores: os.cpus().length }, size: `${W}x${H}`, frames: FRAMES, jumps: JUMPS, cards: [], failures: [] };
const servers = await Promise.all([serve(BASE, handler, '127.0.0.1'), serve(BASE + 2, handler, '127.0.0.1')]);
let browser = null;
try {
  const defaults = await puppeteer.defaultArgs({ headless: true });
  browser = await puppeteer.launch({ headless: true, defaultViewport: null, protocolTimeout: 600000,
    ignoreDefaultArgs: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', ...defaults.filter((a) => a.startsWith('--disable-features='))],
    args: [...PROBE_CHROME_ARGS, '--window-size=1100,820'] });
  report.chrome = await browser.version();
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 640 });
  page.on('pageerror', (e) => report.failures.push(`页面报错:${String(e.message || e).slice(0, 160)}`));
  await page.goto(`http://127.0.0.1:${BASE}/probe-parent`, { waitUntil: 'load' });
  await page.evaluate((src) => window.__setup(src), `http://127.0.0.1:${BASE + 2}/editor/stage.html?stage=1&id=B&preview=stage&dual=1&lm=0`);
  await sleep(1000);
  const rect = { x: 0, y: 0, w: W - (W % 2), h: H - (H % 2) };
  const bake = async (card, localFrame) => {
    const { wall, r } = await page.evaluate((req) => window.__timed('bakeFrame', req), { session: 'bake', clipId: 'clip', localFrame, mode: 'seq', small: false, html: false, pixels: { rect } });
    if (!r?.ok) { report.failures.push(`${card.name} 第 ${localFrame} 帧:${r?.reason}${r?.detail ? ` ${String(r.detail).slice(0, 100)}` : ''}`); return null; }
    return { wall, ms: r.ms, pixelsMs: r.pixelsMs ?? 0, readyMs: r.readyMs, bytes: r.bytes, remounted: r.remounted };
  };
  for (const card of CARDS) {
    process.stderr.write(`── ${card.name}\n`);
    await page.evaluate(() => window.__rpc('setRole', 'back', { job: 'bake' }));
    await page.evaluate((p) => window.__rpc('setProject', p, { reset: true }), projectOf(card));
    await page.evaluate(() => window.__rpc('bakeCancel'));
    const total = Math.floor(card.seconds * FPS);
    const row = { name: card.name, cardId: card.cardId, kind: card.kind, clipFrames: total };
    const seq = [];
    for (let n = 0; n < Math.min(FRAMES, total); n++) { const b = await bake(card, n); if (b && n > 0) seq.push(b); }
    row.seq = { frames: seq.length, ms: sum(seq.map((x) => x.ms)), pixelsMs: sum(seq.map((x) => x.pixelsMs)), wall: sum(seq.map((x) => x.wall)),
      htmlKB: { med: r2((q(seq.map((x) => x.bytes), 0.5) ?? 0) / 1024), max: r2((q(seq.map((x) => x.bytes), 1) ?? 0) / 1024) }, continued: seq.filter((x) => !x.remounted).length };
    if (card.kind === 'lottie') {
      const rnd = mulberry32(20261014);
      const picks = []; for (let i = 0; i < JUMPS * 40 && picks.length < Math.min(JUMPS, total); i++) { const n = Math.floor(rnd() * total); if (!picks.includes(n)) picks.push(n); }
      const jumps = [];
      for (const n of picks) { await page.evaluate(() => window.__rpc('bakeCancel')); const b = await bake(card, n); if (b) jumps.push(b); }
      row.jump = { frames: jumps.length, ms: sum(jumps.map((x) => x.ms)), pixelsMs: sum(jumps.map((x) => x.pixelsMs)), wall: sum(jumps.map((x) => x.wall)),
        htmlKB: { med: r2((q(jumps.map((x) => x.bytes), 0.5) ?? 0) / 1024), max: r2((q(jumps.map((x) => x.bytes), 1) ?? 0) / 1024) } };
    }
    report.cards.push(row);
    process.stderr.write(`   顺推 ${JSON.stringify(row.seq)}\n` + (row.jump ? `   直接跳 ${JSON.stringify(row.jump)}\n` : ''));
  }
  if (FIDELITY) {
    const { startIsolatedEditor } = await import('./preview-stop-lib.mjs');
    const { FramePipeline } = await import('../../server/frame-pipeline.mjs');
    const { bakeFrames } = await import('../../server/bakery/bake.mjs');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-lottie-fid-'));
    const dev = await startIsolatedEditor({ port: BASE + 5, work });
    const devOrigin = dev.origin.replace(/\/+$/, '');
    report.fidelity = [];
    try {
      for (const card of CARDS.filter((c) => c.kind === 'lottie' && c.name !== 'empty-lottie')) {
        const total = Math.floor(card.seconds * FPS);
        const frames = [Math.floor(total * 0.2), Math.floor(total * 0.5), Math.floor(total * 0.8)];
        process.stderr.write('── 保真 ' + card.name + ' ' + frames.join(',') + '\n');
        // 在线构建的后台舞台:当场生成快照、画成位图
        await page.evaluate(() => window.__rpc('setRole', 'back', { job: 'bake' }));
        await page.evaluate((pr) => window.__rpc('setProject', pr, { reset: true }), projectOf(card));
        await page.evaluate(() => { window.__keepBitmaps = true; window.__bitmaps.clear(); });
        const bakedPng = {};
        for (const n of frames) {
          await page.evaluate(() => window.__rpc('bakeCancel'));
          const b = await bake(card, n);
          if (!b) continue;
          bakedPng[n] = await page.evaluate((k) => window.__bitmapPng(k), n);
        }
        await page.evaluate(() => { window.__keepBitmaps = false; });
        // 导出页:同一帧
        const svc = new FramePipeline({ root: path.join(work, 'lib-' + card.name), origin: () => devOrigin, dataRoot: work });
        let bakery = null;
        const exportDir = path.join(work, 'exp-' + card.name);
        try {
          bakery = await svc.bakery(projectOf(card));
          await bakeFrames(bakery, { out: exportDir, targetFrames: frames, quiet: true });
        } finally { await bakery?.close().catch(() => {}); await svc.close().catch(() => {}); }
        for (const n of frames) {
          const row = { card: card.name, frame: n };
          const exp = path.join(exportDir, 'frames', String(n).padStart(6, '0') + '.png');
          if (!bakedPng[n] || !fs.existsSync(exp)) { row.error = !bakedPng[n] ? '没取到位图' : '没有导出的 PNG'; report.fidelity.push(row); continue; }
          const a = PNG.sync.read(Buffer.from(bakedPng[n], 'base64')), e = PNG.sync.read(fs.readFileSync(exp));
          row.size = [a.width, a.height]; row.exportSize = [e.width, e.height];
          if (a.width !== e.width || a.height !== e.height) { row.error = '尺寸不同'; report.fidelity.push(row); continue; }
          let differ = 0, ink = 0, maxDiff = 0, over8 = 0, alphaOnly = 0;
          for (let i = 0; i < a.data.length; i += 4) {
            const aa = a.data[i + 3], ea = e.data[i + 3];
            if (aa || ea) ink++;
            if (!aa && !ea) continue;
            const d = Math.max(Math.abs(a.data[i] * aa / 255 - e.data[i] * ea / 255), Math.abs(a.data[i + 1] * aa / 255 - e.data[i + 1] * ea / 255), Math.abs(a.data[i + 2] * aa / 255 - e.data[i + 2] * ea / 255), Math.abs(aa - ea));
            if (d > 0) differ++;
            if (d > 8) over8++;
            if (d > maxDiff) maxDiff = d;
          }
          Object.assign(row, { ink, differ, over8, maxDiff: +maxDiff.toFixed(1), differFrac: ink ? +(differ / ink).toFixed(5) : 0, over8Frac: ink ? +(over8 / ink).toFixed(5) : 0 });
          fs.mkdirSync(path.join(path.dirname(JSON_OUT || 'out/x'), 'lottie-bake-fidelity'), { recursive: true });
          fs.writeFileSync(path.join(path.dirname(JSON_OUT || 'out/x'), 'lottie-bake-fidelity', card.name + '-' + n + '-bitmap.png'), Buffer.from(bakedPng[n], 'base64'));
          fs.copyFileSync(exp, path.join(path.dirname(JSON_OUT || 'out/x'), 'lottie-bake-fidelity', card.name + '-' + n + '-export.png'));
          report.fidelity.push(row);
          process.stderr.write('   ' + JSON.stringify(row) + '\n');
        }
      }
    } finally { try { await dev.stop(); } catch { /* 已停 */ } try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 留着 */ } }
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const s of servers) await new Promise((resolve) => s.close(() => resolve()));
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: report.failures.length === 0, failures: report.failures, cards: report.cards }));
process.exit(report.failures.length ? 1 : 0);

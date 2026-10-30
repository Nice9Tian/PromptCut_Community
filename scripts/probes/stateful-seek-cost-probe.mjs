/**
 * 实验:有状态的卡(motion 式)在在线页面的后台舞台里,「直接跳到第 N 帧」要花多久。
 * 出处:`docs/plan/render-standard.md`(2026-10-10 用户要量:motion 式的卡要不要整张不拆开,取决于跳到指定时间的代价)。
 *
 *   node scripts/probes/stateful-seek-cost-probe.mjs [--dist dist-online] [--port-base 5760]
 *        [--cards punch-pill,odometer,checklist] [--seconds 20] [--targets 30,60,120,240,480,599] [--rounds 3]
 *        [--throttle 4] [--json <文件>]
 *        [--verify 150,240]   另核对:顺着做到第 N 帧的快照,和直接跳到第 N 帧的快照是不是同一份
 *                             (用 `compareSnapshotHtml`,样式数值带容差);给了就不量耗时。
 *                             这一项只报第一处不同;要把所有不同处分档、比像素、看同一帧几次是否一样,
 *                             用 `stateful-seq-vs-jump-probe.mjs`
 *
 * 要先有在线构建:`npx vite build --mode online`(产出 `dist-online/`)。
 *
 * 做法:起静态服务(父页一个源、舞台另一个源,和线上的双舞台同形),父页照 stageRpc 协议把后台舞台切到生成快照的活,
 * 灌进一个只有一张卡的工程,然后调产品自己的 `bakeFrame`:
 *
 *   顺着做   第 0、1、2…29 帧连着要:每帧接着上一帧推一步、生成一张快照。得到「不跳、顺着做」每帧多久;
 *   跳着做   每次先 `bakeCancel`(忘掉上一帧),再要第 N 帧:舞台从挂载帧重新挂载、一步一步推到第 N 帧、生成一张快照。
 *            得到「跳到第 N 帧」总共多久。减去第 0 帧那一次(只挂载、不推),就是推 N 步花的时间。
 *
 * 推帧时舞台每推一帧让出一次主线程(产品的做法,为了不卡住前台),这部分算在里面:量的就是用户机器上真实会花的时间。
 * 只记录,不判过不过;任何一次 `bakeFrame` 失败退出码 1。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { flagArg, serve, sleep } from './probe-connect.mjs';
import { compareSnapshotHtml } from '../../src/render/snapshotCompare.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = path.resolve(flagArg('dist', path.join(ROOT, 'dist-online')));
const BASE = Number(flagArg('port-base', '5760'));
const CARDS = flagArg('cards', 'punch-pill,odometer,checklist').split(',').filter(Boolean);
const SECONDS = Number(flagArg('seconds', '20'));
const ROUNDS = Math.max(1, Number(flagArg('rounds', '3')));
const THROTTLE = Number(flagArg('throttle', '1'));
const JSON_OUT = flagArg('json', null);
const FPS = 30;
const LAST = SECONDS * FPS - 1;
const TARGETS = flagArg('targets', '30,60,120,240,480,599').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= LAST);
const SEQ_FRAMES = 30;
const VERIFY = (flagArg('verify', '') || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= LAST).sort((a, b) => a - b);
if (!fs.existsSync(path.join(DIST, 'stage.html'))) { console.error(`没有在线构建:${DIST}(先跑 npx vite build --mode online)`); process.exit(2); }

const projectOf = (cardId) => ({
  id: `seek-${cardId}`, name: '跳帧代价探针', width: 1920, height: 1080, fps: FPS, duration: SECONDS,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [{ id: 'tr', name: cardId, hidden: false, clips: [{ id: 'clip', kind: 'card', cardId, start: 0, end: SECONDS, params: {} }] }],
});

const PARENT_HTML = `<!doctype html><meta charset=utf-8><title>seek parent</title>
<body style="margin:0"><iframe id=bg style="position:absolute;left:0;top:0;width:960px;height:540px;border:0;opacity:0;pointer-events:none"></iframe>
<script>
let ready = null, stageWin = null, stageOrigin = '*', seq = 0; const waiting = new Map();
const htmlOf = new Map(); const pending = new Set();
window.__html = async (n) => { await Promise.allSettled([...pending]); const h = htmlOf.get(n) ?? null; htmlOf.delete(n); return h; };
addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'pc-stage-ready') { ready = d.hostCapabilities || {}; return; }
  if (e.source !== stageWin) return;
  if (d.type === 'bake-frame') { const job = (async () => { const html = d.htmlGz ? await new Response(new Blob([d.htmlGz]).stream().pipeThrough(new DecompressionStream('gzip'))).text() : new TextDecoder().decode(d.htmlRaw); htmlOf.set(d.localFrame, html); })(); pending.add(job); job.finally(() => pending.delete(job)); return; }
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
  let p = u.pathname.startsWith('/editor/') ? u.pathname.slice('/editor/'.length) : null;
  if (p === null) { res.statusCode = 404; return res.end(); }
  if (!p) p = 'index.html';
  const file = path.join(DIST, decodeURIComponent(p));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
};

const med = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const r1 = (x) => (x === null || x === undefined ? null : +x.toFixed(1));

const report = { when: new Date().toISOString(), host: { cpu: os.cpus()[0]?.model?.trim(), logicalCores: os.cpus().length },
  options: { seconds: SECONDS, fps: FPS, targets: TARGETS, rounds: ROUNDS, throttle: THROTTLE }, cards: [], failures: [] };
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
  if (THROTTLE > 1) {
    // 放慢的是舞台那个文档(跨源、独立进程):对每个页面目标都设
    for (const target of browser.targets()) { try { const cdp = await target.createCDPSession(); await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE }); } catch { /* 不是页面目标 */ } }
  }
  const bake = async (clipId, localFrame) => {
    const { wall, r } = await page.evaluate((req) => window.__timed('bakeFrame', req), { session: 'seek', clipId, localFrame, mode: 'seq', small: false });
    if (!r?.ok) { report.failures.push(`${clipId} 第 ${localFrame} 帧:${r?.reason}${r?.detail ? ` ${String(r.detail).slice(0, 80)}` : ''}`); return null; }
    return { wall, ms: r.ms, readyMs: r.readyMs, remounted: r.remounted, bytes: r.bytes, hash: r.hash };
  };
  for (const cardId of CARDS) {
    const project = projectOf(cardId);
    await page.evaluate(() => window.__rpc('setRole', 'back', { job: 'bake' }));
    await page.evaluate((p) => window.__rpc('setProject', p, { reset: true }), project);
    const row = { cardId, seq: null, mount: null, jumps: [], verify: [] };
    if (VERIFY.length) {
      // 顺着做到最大的那一帧,沿途记下要核对的帧的哈希;再逐个直接跳过去比
      const want = new Map();
      await page.evaluate(() => window.__rpc('bakeCancel'));
      const htmlAt = (n) => page.evaluate((k) => window.__html(k), n);
      const diff = (a, b) => { if (a === null || b === null) return '没拿到快照'; const r = compareSnapshotHtml(a, b); if (r.same) return null; const decl = (t) => new Map(String(t ?? '').split(';').map((x) => { const i = x.indexOf(':'); return [x.slice(0, i).trim(), x.slice(i + 1).trim()]; })); const x = decl(r.expected), y = decl(r.actual); const ds = [...new Set([...x.keys(), ...y.keys()])].filter((k) => x.get(k) !== y.get(k)).slice(0, 3).map((k) => `${k}: ${String(x.get(k)).slice(0, 48)} → ${String(y.get(k)).slice(0, 48)}`); return `${r.reason ?? '不同'}${ds.length ? ' | ' + ds.join(' ; ') : `:${String(r.expected ?? '').slice(0, 40)} / ${String(r.actual ?? '').slice(0, 40)}`}`; };
      for (let n = 0; n <= VERIFY.at(-1); n++) { const b = await bake('clip', n); if (!b) break; if (VERIFY.includes(n)) want.set(n, await htmlAt(n)); else await htmlAt(n); }
      for (const n of VERIFY) {
        await page.evaluate(() => window.__rpc('bakeCancel'));
        const b = await bake('clip', n); const h1 = b ? await htmlAt(n) : null;
        // 同一帧连着跳两次,排除「这张卡本身每次都不一样」
        await page.evaluate(() => window.__rpc('bakeCancel'));
        const b2 = await bake('clip', n); const h2 = b2 ? await htmlAt(n) : null;
        const why = diff(want.get(n) ?? null, h1);
        row.verify.push({ frame: n, same: why === null, why, jumpStable: diff(h1, h2) === null });
      }
      report.cards.push(row);
      continue;
    }
    // 顺着做:第 0 帧是挂载,之后 29 帧各推一步
    const seq = [];
    await page.evaluate(() => window.__rpc('bakeCancel'));
    for (let n = 0; n < SEQ_FRAMES; n++) { const b = await bake('clip', n); if (b && n > 0) seq.push(b); }
    row.seq = { frames: seq.length, wallMs: r1(med(seq.map((x) => x.wall))), stageMs: r1(med(seq.map((x) => x.ms))), continued: seq.filter((x) => !x.remounted).length, htmlKB: r1((med(seq.map((x) => x.bytes)) ?? 0) / 1024) };
    // 只挂载、不推(第 0 帧,每次都先忘掉上一帧)
    const mounts = [];
    for (let k = 0; k < ROUNDS; k++) { await page.evaluate(() => window.__rpc('bakeCancel')); const b = await bake('clip', 0); if (b) mounts.push(b); }
    row.mount = { wallMs: r1(med(mounts.map((x) => x.wall))), stageMs: r1(med(mounts.map((x) => x.ms))) };
    for (const target of TARGETS) {
      const runs = [];
      for (let k = 0; k < ROUNDS; k++) { await page.evaluate(() => window.__rpc('bakeCancel')); const b = await bake('clip', target); if (b) runs.push(b); }
      const wall = med(runs.map((x) => x.wall));
      row.jumps.push({ frame: target, sec: +(target / FPS).toFixed(1), wallMs: r1(wall), stageMs: r1(med(runs.map((x) => x.ms))), readyMs: r1(med(runs.map((x) => x.readyMs))),
        perStepMs: wall === null || row.mount.wallMs === null ? null : +((wall - row.mount.wallMs) / target).toFixed(2), remounted: runs.every((x) => x.remounted) });
    }
    report.cards.push(row);
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const s of servers) await new Promise((resolve) => s.close(() => resolve()));
}

if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
console.log(`机器:${report.host.cpu},${report.host.logicalCores} 个逻辑核;${report.chrome}${THROTTLE > 1 ? `;主线程放慢 ${THROTTLE} 倍` : ''}`);
console.log(`每张卡一个 ${SECONDS} 秒的片段(${FPS} 帧/秒,共 ${LAST + 1} 帧);每个数取 ${ROUNDS} 次的中位数;时间是父页从发出请求到收到回复`);
for (const c of report.cards) {
  if (c.verify.length) { console.log(`卡 ${c.cardId}:` + c.verify.map((v) => `第 ${v.frame} 帧(${(v.frame / FPS).toFixed(1)} 秒)${v.same ? ' 相同' : (v.jumpStable ? ' 不同' : ' 不同(两次跳也互不相同)') + `〔${v.why}〕`}`).join(';')); continue; }
  console.log(`卡 ${c.cardId}:顺着做每帧 ${c.seq.wallMs} 毫秒(${c.seq.continued}/${c.seq.frames} 帧是接着推的,快照 ${c.seq.htmlKB} KB);只挂载不推 ${c.mount.wallMs} 毫秒`);
  for (const j of c.jumps) console.log(`   跳到第 ${String(j.frame).padStart(3)} 帧(${String(j.sec).padStart(4)} 秒)  ${String(j.wallMs).padStart(8)} 毫秒   平均每推一步 ${j.perStepMs} 毫秒${j.remounted ? '' : '   (没有重新挂载,数字不可比)'}`);
}
if (report.failures.length) { console.log(`失败:\n  ${report.failures.join('\n  ')}`); process.exit(1); }
console.log('全部跑完(只记录耗时)');

/**
 * 改舞台推帧的公共代码(`src/render/pinAnimations.ts`、`src/render/stageClock.ts`)前后,舞台各条路逐帧生成的快照变没变。
 * 出处:渲染重构「推帧一致性」(`docs/archive/agent-reports/AGENT-rr-push-exact.md`):这两处是可见舞台、测量、后台生成快照共用的,
 * 改了以后各条路受多大影响要量出来,不靠读代码推断。
 *
 *   node scripts/probes/stage-push-before-after-probe.mjs --before <改之前的在线构建> --after <改之后的在线构建>
 *        [--port-base 27590]                  用 +0(父页的源)、+2(舞台的源);两份构建先后用同一对端口
 *        [--cards <卡片 id,逗号分隔>]         缺省是那 14 张有状态的内置卡加 `terminal-3d`
 *        [--last 150] [--fps 30] [--seconds 20]   每条路从第 0 帧逐帧做到第几帧
 *        [--paths front,measure,bake]         要走哪几条路(另有 booleans,见下)
 *        [--json <文件>] [--out <目录>]        --out 把改前改后不相同的快照存下来
 *
 * 在线构建:`npx vite build --mode online --outDir <目录> --emptyOutDir`(改之前的那一份在改之前的树里构建)。
 *
 * 三条路,每张卡每条路重新载入一次舞台,工程是只有这一张卡的 20 秒片段:
 *
 *   front    可见舞台逐帧走:角色切成可见(`setRole('front')`),`setTime(帧号 / 帧率)` 一帧一帧往后拨(每次不到一秒,
 *            走的是舞台里「连续播放」那一支:`clock.advanceTo` 同步推一步、钉动画),等舞台自己的补拍做完(真实的一帧),
 *            再在舞台文档里调 `__pcCreateSnapshot()`。这是用户暂停着一帧一帧走时可见舞台的活渲画面。
 *   measure  测量的快照趟:后台舞台 `render(t, { jump: true, probe: 'snapshot' })`,从挂载帧逐帧推、每帧生成快照发回来
 *            (`probe-frame` 事件)。产品里这一趟按一拍预算截断,所以只有头几帧;两份构建取到的帧数不一样时只比都有的。
 *   bake     后台舞台为浏览器节点逐帧生成快照(`bakeFrame`,顺着做)。
 *   booleans 测量的两趟布尔探针(`render(t, { jump: true, probe: 'booleans' })`):这张卡判没判成「只推自己子树的时间就行」(`vtOk`)、
 *            「可定位」(`seekOk`)。缺省不走,`--paths` 里写上才走;只报改前改后各是什么。
 *
 * 报告:每张卡每条路,改前改后逐帧比(口径同 `snapshotCompare.mjs`:标签、属性、文本逐字比,样式数值 1e-6 容差),
 * 写出相同几帧、不同几帧、哪些帧不同、第一处差在哪;另报每份构建里 front 与 bake 两条路对不对得上(同一帧两条路的快照比)。
 * 这个探针只量、不判:改前改后不同不算失败(改的就是它)。退出码:页面报错或某条路没跑出来退出 1;没有构建退出 2;其余 0。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { flagArg, serve, sleep } from './probe-connect.mjs';
import { compareSnapshotHtml } from '../../src/render/snapshotCompare.mjs';

const BEFORE = flagArg('before', null);
const AFTER = flagArg('after', null);
const BASE = Number(flagArg('port-base', '27590'));
const CARDS = flagArg('cards', 'punch-pill,odometer,checklist,mu-word-rotate,mu-typing,mu-number-ticker,mu-circular-progress,mu-animated-shiny-text,growth-curve,step-timeline,rank-bars,type-shift,chapter-bar,blur-text,terminal-3d')
  .split(',').map((s) => s.trim()).filter(Boolean);
const SECONDS = Number(flagArg('seconds', '20'));
const FPS = Math.max(1, Number(flagArg('fps', '30')));
const LAST = Math.min(SECONDS * FPS - 1, Math.max(1, Number(flagArg('last', '150'))));
const PATHS = flagArg('paths', 'front,measure,bake').split(',').map((s) => s.trim()).filter(Boolean);
const JSON_OUT = flagArg('json', null);
const OUT = flagArg('out', null);
for (const [name, dir] of [['--before', BEFORE], ['--after', AFTER]]) {
  if (!dir || !fs.existsSync(path.join(dir, 'stage.html'))) { console.error(`${name} 要给一份在线构建的目录(里面有 stage.html):${dir}`); process.exit(2); }
}

/** React 自动生成的元素编号:每重新挂载一次就换一个号,按出现顺序重排以后再比(同 `stateful-seq-vs-jump-probe.mjs`) */
const REACT_ID = /_r_[0-9a-z]+_|:r[0-9a-z]+:|«r[0-9a-z]+»/g;
const renumberIds = (html) => { const seen = new Map(); return html.replace(REACT_ID, (m) => { if (!seen.has(m)) seen.set(m, `_r_#${seen.size}_`); return seen.get(m); }); };
const sameHtml = (a, b) => {
  if (a === b) return { same: true };
  const r = compareSnapshotHtml(renumberIds(a), renumberIds(b));
  const clip = (v) => { const s = String(v ?? '(无)'); return s.length > 70 ? `${s.slice(0, 70)}…` : s; };
  return r.same ? { same: true } : { same: false, why: `${r.reason}${r.expected !== undefined || r.actual !== undefined ? `:${clip(r.expected)} → ${clip(r.actual)}` : ''}` };
};

const projectOf = (cardId) => ({
  id: `ba-${cardId}`, name: '改前改后对照', width: 1920, height: 1080, fps: FPS, duration: SECONDS,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [{ id: 'tr', name: cardId, hidden: false, clips: [{ id: 'clip', kind: 'card', cardId, start: 0, end: SECONDS, params: {} }] }],
});

/** 父页:舞台 iframe 铺在原位、看得见(可见舞台那条路要真实的帧);收 `bake-frame`、`probe-frame` */
const PARENT_HTML = `<!doctype html><meta charset=utf-8><title>before-after parent</title>
<body style="margin:0"><iframe id=st style="position:absolute;left:0;top:0;width:960px;height:540px;border:0"></iframe>
<script>
let ready = null, stageWin = null, stageOrigin = '*', seq = 0; const waiting = new Map();
const frames = new Map(); const pending = new Set();
const gunzip = async (buf) => new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
window.__frames = async () => { await Promise.allSettled([...pending]); const out = [...frames.entries()]; frames.clear(); return out; };
addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'pc-stage-ready') { ready = d.hostCapabilities || {}; return; }
  if (e.source !== stageWin) return;
  if (d.type === 'bake-frame' || d.type === 'probe-frame') {
    const job = (async () => { const html = d.htmlGz ? await gunzip(d.htmlGz) : d.htmlRaw ? new TextDecoder().decode(d.htmlRaw) : d.html; frames.set(d.localFrame, html); })();
    pending.add(job); job.finally(() => pending.delete(job)); return;
  }
  if (d.type === 'pc-rpc-reply') { const w = waiting.get(d.id); if (w) { waiting.delete(d.id); d.ok ? w.res(d.result) : w.rej(new Error(d.error)); } }
});
window.__rpc = (method, ...args) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); stageWin.postMessage({ type: 'pc-rpc', id, method, args }, stageOrigin); });
window.__setup = async (src) => { ready = null; frames.clear(); const f = document.getElementById('st'); f.src = src; stageWin = f.contentWindow; stageOrigin = new URL(src).origin;
  const t0 = performance.now(); while (!ready) { if (performance.now() - t0 > 60000) throw new Error('舞台 60 秒没就绪'); await new Promise((r) => setTimeout(r, 50)); } stageWin = f.contentWindow; return ready; };
</script>`;

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png', '.webp': 'image/webp' };
const handlerFor = (dist) => (req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Origin-Agent-Cluster', '?1');
  res.setHeader('Cache-Control', 'no-store');
  if (u.pathname === '/probe-parent') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(PARENT_HTML); }
  let p = u.pathname.startsWith('/editor/') ? u.pathname.slice('/editor/'.length) : null;
  if (p === null) { res.statusCode = 404; return res.end(); }
  if (!p) p = 'index.html';
  const file = path.join(dist, decodeURIComponent(p));
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
};

const failures = [];
const guard = (what, job) => { let timer; return Promise.race([job, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} 5 分钟没有结果`)), 300000); })]).finally(() => clearTimeout(timer)); };

/** 在一份构建上把每张卡的几条路各走一遍;回 { 卡: { 路: Map(帧 → HTML) } } */
async function runBuild(label, dist) {
  const servers = await Promise.all([serve(BASE, handlerFor(path.resolve(dist)), '127.0.0.1'), serve(BASE + 2, handlerFor(path.resolve(dist)), '127.0.0.1')]);
  const out = {};
  let browser = null;
  try {
    const defaults = await puppeteer.defaultArgs({ headless: true });
    browser = await puppeteer.launch({ headless: true, defaultViewport: null, protocolTimeout: 900000,
      ignoreDefaultArgs: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', ...defaults.filter((a) => a.startsWith('--disable-features='))],
      args: [...PROBE_CHROME_ARGS, '--window-size=1100,820'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 640 });
    page.on('pageerror', (e) => failures.push(`${label} 页面报错:${String(e.message || e).slice(0, 160)}`));
    await page.goto(`http://127.0.0.1:${BASE}/probe-parent`, { waitUntil: 'load' });
    await page.bringToFront();
    const rpc = (method, ...args) => guard(`${label} 舞台调用 ${method}`, page.evaluate((m, a) => window.__rpc(m, ...a), method, args));
    const stageFrame = () => page.frames().find((f) => f.url().includes('/editor/stage.html')) ?? null;
    const load = async () => {
      await guard('载入舞台', page.evaluate((src) => window.__setup(src), `http://127.0.0.1:${BASE + 2}/editor/stage.html?stage=1&id=B&preview=stage&dual=1&lm=0`));
      await sleep(400);
    };
    const taken = async () => new Map(await page.evaluate(() => window.__frames()));
    for (const cardId of CARDS) {
      out[cardId] = {};
      for (const how of PATHS) {
        await load();
        const got = new Map();
        try {
          if (how === 'front') {
            await rpc('setRole', 'front');
            await rpc('setProject', projectOf(cardId), { reset: true });
            for (let n = 0; n <= LAST; n++) {
              await rpc('setTime', n / FPS);
              // 舞台的补拍排在微任务里;再等真实的一帧,让这一帧排下的提交和动画事件都落地
              const html = await guard('取快照', stageFrame().evaluate(async (clipId) => {
                const raf = window.__pcRealRaf || window.requestAnimationFrame.bind(window);
                const wait = window.__pcRealSetTimeout || window.setTimeout.bind(window);
                await new Promise((r) => { let done = false; const go = () => { if (!done) { done = true; r(); } }; raf(() => raf(go)); wait(go, 250); });
                const snap = window.__pcCreateSnapshot();
                return snap.controls.find((c) => c.id === clipId)?.html ?? null;
              }, 'clip'));
              if (html !== null) got.set(n, html);
            }
          } else if (how === 'measure') {
            await rpc('setRole', 'back', { job: 'probe' });
            await rpc('setProject', projectOf(cardId), { reset: true });
            await rpc('render', LAST / FPS, { jump: true, probe: 'snapshot' });
            for (const [n, html] of await taken()) got.set(n, html);
          } else if (how === 'booleans') {
            await rpc('setRole', 'back', { job: 'probe' });
            await rpc('setProject', projectOf(cardId), { reset: true });
            const r = await rpc('render', (SECONDS * FPS - 1) / FPS, { jump: true, probe: 'booleans' });
            if (!r?.booleans) failures.push(`${label} ${cardId} booleans:${JSON.stringify(r).slice(0, 120)}`);
            else got.set(0, JSON.stringify({ vtOk: r.booleans.vtOk, seekOk: r.booleans.seekOk }));
          } else if (how === 'bake') {
            await rpc('setRole', 'back', { job: 'bake' });
            await rpc('setProject', projectOf(cardId), { reset: true });
            await rpc('bakeCancel');
            for (let n = 0; n <= LAST; n++) {
              const r = await rpc('bakeFrame', { session: 'ba', clipId: 'clip', localFrame: n, mode: 'seq', small: false });
              if (!r?.ok) { failures.push(`${label} ${cardId} bake 第 ${n} 帧:${r?.reason}`); break; }
            }
            for (const [n, html] of await taken()) got.set(n, html);
          }
        } catch (e) {
          failures.push(`${label} ${cardId} ${how}:${String(e?.message || e).slice(0, 200)}`);
        }
        out[cardId][how] = got;
        console.error(`[${label}] ${cardId} ${how}:${got.size} 帧`);
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const s of servers) await new Promise((resolve) => { s.close(() => resolve()); s.closeAllConnections?.(); });
  }
  return out;
}

const before = await runBuild('改前', BEFORE);
const after = await runBuild('改后', AFTER);
if (OUT) fs.mkdirSync(OUT, { recursive: true });

/** 两组「帧 → HTML」逐帧比(只比两边都有的帧) */
const compare = (a, b, label) => {
  const frames = [...a.keys()].filter((n) => b.has(n)).sort((x, y) => x - y);
  const differ = [];
  let first = null;
  for (const n of frames) {
    const r = sameHtml(a.get(n), b.get(n));
    if (r.same) continue;
    differ.push(n);
    first ??= `第 ${n} 帧:${r.why}`;
    if (OUT && label) { fs.writeFileSync(path.join(OUT, `${label}-${n}-a.html`), a.get(n)); fs.writeFileSync(path.join(OUT, `${label}-${n}-b.html`), b.get(n)); }
  }
  return { compared: frames.length, same: frames.length - differ.length, differ, first };
};
const brief = (r) => (r.compared === 0 ? '没有可比的帧' : r.differ.length === 0 ? `${r.compared} 帧全部相同` : `${r.compared} 帧里 ${r.differ.length} 帧不同(${r.differ.slice(0, 24).join('、')}${r.differ.length > 24 ? '…' : ''})`);

const report = { when: new Date().toISOString(), host: { cpu: os.cpus()[0]?.model?.trim(), logicalCores: os.cpus().length },
  options: { before: BEFORE, after: AFTER, cards: CARDS, last: LAST, fps: FPS, paths: PATHS }, cards: [], failures };
console.log(`每张卡一个 ${SECONDS} 秒的片段(${FPS} 帧/秒),每条路从第 0 帧逐帧做到第 ${LAST} 帧`);
for (const cardId of CARDS) {
  const row = { cardId, beforeVsAfter: {}, frontVsBake: {} };
  console.log(`卡 ${cardId}`);
  for (const how of PATHS) {
    if (how === 'booleans') {
      const x = before[cardId][how]?.get(0) ?? '没量出来', y = after[cardId][how]?.get(0) ?? '没量出来';
      row.booleans = { before: x, after: y, same: x === y };
      console.log(`   booleans 改前 ${x};改后 ${y}${x === y ? '' : '  ← 变了'}`);
      continue;
    }
    const r = compare(before[cardId][how] ?? new Map(), after[cardId][how] ?? new Map(), `${cardId}-${how}`);
    row.beforeVsAfter[how] = r;
    console.log(`   ${how.padEnd(7)} 改前对改后:${brief(r)}${r.first ? `〔${r.first}〕` : ''}`);
  }
  if (PATHS.includes('front') && PATHS.includes('bake')) {
    for (const [label, set] of [['改前', before], ['改后', after]]) {
      const r = compare(set[cardId].front ?? new Map(), set[cardId].bake ?? new Map(), null);
      row.frontVsBake[label] = r;
      console.log(`   ${label}:可见舞台逐帧走 对 后台生成快照:${brief(r)}${r.first ? `〔${r.first}〕` : ''}`);
    }
  }
  report.cards.push(row);
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
if (failures.length) { console.log(`失败:\n  ${failures.join('\n  ')}`); process.exit(1); }

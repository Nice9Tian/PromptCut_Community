/**
 * Experiment: how long it takes to "jump directly to frame N" for stateful cards (motion-style) in
 * the background stage of the online page.
 * Source: `docs/plan/render-standard.md` (user wanted measurements, 2026-10-10: whether to keep
 * motion-style cards whole without splitting depends on the cost of jumping to a specified time).
 *
 *   node scripts/probes/stateful-seek-cost-probe.mjs [--dist dist-online] [--port-base 5760]
 *        [--cards punch-pill,odometer,checklist] [--seconds 20] [--targets 30,60,120,240,480,599] [--rounds 3]
 *        [--throttle 4] [--json <file>]
 *        [--verify 150,240]   Also verify: whether the snapshot generated sequentially to frame N
 *                             and the snapshot jumping directly to frame N are identical (using
 *                             `compareSnapshotHtml`, style values allow tolerance); elapsed time is
 *                             not measured when provided.
 *                             This item only reports the first difference; to classify all
 *                             differences into tiers, compare pixels, and check consistency across
 *                             runs for the same frame, use `stateful-seq-vs-jump-probe.mjs`.
 *
 * Requires an online build first: `npx vite build --mode online` (outputs `dist-online/`).
 *
 * Approach: start static servers (one origin for parent page, another for stage, matching the
 * online dual stage layout); parent page switches background stage to snapshot generation task
 * per stageRpc protocol, feeds in a project with only one card, then calls product's own `bakeFrame`:
 *
 *   Sequential  Request frames 0, 1, 2...29 in sequence: each frame advances one step from the
 *               previous frame and generates a snapshot. Yields time per frame for "sequential
 *               without jumps";
 *   Jump        Call `bakeCancel` first each time (forget the previous frame), then request frame N:
 *               stage remounts from mount frame, advances step by step to frame N, and generates a
 *               snapshot. Yields total time to "jump to frame N". Subtracting frame 0 (mount only,
 *               no push) gives the time spent pushing N steps.
 *
 * When pushing frames, stage yields the main thread once for each frame pushed (product's approach
 * to avoid blocking foreground), which is included: what is measured is time that will actually be
 * spent on user machines.
 * Records only, without pass/fail judgment; exits with code 1 on any `bakeFrame` failure.
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
if (!fs.existsSync(path.join(DIST, 'stage.html'))) { console.error(`No online build: ${DIST} (run npx vite build --mode online first)`); process.exit(2); }

const projectOf = (cardId) => ({
  id: `seek-${cardId}`, name: 'Frame jump cost probe', width: 1920, height: 1080, fps: FPS, duration: SECONDS,
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
  const t0 = performance.now(); while (!ready) { if (performance.now() - t0 > 60000) throw new Error('stage not ready within 60 seconds'); await new Promise((r) => setTimeout(r, 50)); } stageWin = f.contentWindow; return ready; };
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
  page.on('pageerror', (e) => report.failures.push(`Page error: ${String(e.message || e).slice(0, 160)}`));
  await page.goto(`http://127.0.0.1:${BASE}/probe-parent`, { waitUntil: 'load' });
  await page.evaluate((src) => window.__setup(src), `http://127.0.0.1:${BASE + 2}/editor/stage.html?stage=1&id=B&preview=stage&dual=1&lm=0`);
  await sleep(1000);
  if (THROTTLE > 1) {
    // What is throttled is the stage document (cross-origin, separate process): set for each page
    // target
    for (const target of browser.targets()) { try { const cdp = await target.createCDPSession(); await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE }); } catch { /* Not a page target */ } }
  }
  const bake = async (clipId, localFrame) => {
    const { wall, r } = await page.evaluate((req) => window.__timed('bakeFrame', req), { session: 'seek', clipId, localFrame, mode: 'seq', small: false });
    if (!r?.ok) { report.failures.push(`${clipId} frame ${localFrame}: ${r?.reason}${r?.detail ? ` ${String(r.detail).slice(0, 80)}` : ''}`); return null; }
    return { wall, ms: r.ms, readyMs: r.readyMs, remounted: r.remounted, bytes: r.bytes, hash: r.hash };
  };
  for (const cardId of CARDS) {
    const project = projectOf(cardId);
    await page.evaluate(() => window.__rpc('setRole', 'back', { job: 'bake' }));
    await page.evaluate((p) => window.__rpc('setProject', p, { reset: true }), project);
    const row = { cardId, seq: null, mount: null, jumps: [], verify: [] };
    if (VERIFY.length) {
      // Run sequentially up to the largest frame, recording hashes of frames to verify along the way;
      // then jump directly to each and compare
      const want = new Map();
      await page.evaluate(() => window.__rpc('bakeCancel'));
      const htmlAt = (n) => page.evaluate((k) => window.__html(k), n);
      const diff = (a, b) => { if (a === null || b === null) return 'No snapshot obtained'; const r = compareSnapshotHtml(a, b); if (r.same) return null; const decl = (t) => new Map(String(t ?? '').split(';').map((x) => { const i = x.indexOf(':'); return [x.slice(0, i).trim(), x.slice(i + 1).trim()]; })); const x = decl(r.expected), y = decl(r.actual); const ds = [...new Set([...x.keys(), ...y.keys()])].filter((k) => x.get(k) !== y.get(k)).slice(0, 3).map((k) => `${k}: ${String(x.get(k)).slice(0, 48)} → ${String(y.get(k)).slice(0, 48)}`); return `${r.reason ?? 'different'}${ds.length ? ' | ' + ds.join(' ; ') : `:${String(r.expected ?? '').slice(0, 40)} / ${String(r.actual ?? '').slice(0, 40)}`}`; };
      for (let n = 0; n <= VERIFY.at(-1); n++) { const b = await bake('clip', n); if (!b) break; if (VERIFY.includes(n)) want.set(n, await htmlAt(n)); else await htmlAt(n); }
      for (const n of VERIFY) {
        await page.evaluate(() => window.__rpc('bakeCancel'));
        const b = await bake('clip', n); const h1 = b ? await htmlAt(n) : null;
        // Jump to the same frame twice in succession to rule out "this card itself differs every time"
        await page.evaluate(() => window.__rpc('bakeCancel'));
        const b2 = await bake('clip', n); const h2 = b2 ? await htmlAt(n) : null;
        const why = diff(want.get(n) ?? null, h1);
        row.verify.push({ frame: n, same: why === null, why, jumpStable: diff(h1, h2) === null });
      }
      report.cards.push(row);
      continue;
    }
    // Sequential: frame 0 is mount, followed by 29 frames each pushed one step
    const seq = [];
    await page.evaluate(() => window.__rpc('bakeCancel'));
    for (let n = 0; n < SEQ_FRAMES; n++) { const b = await bake('clip', n); if (b && n > 0) seq.push(b); }
    row.seq = { frames: seq.length, wallMs: r1(med(seq.map((x) => x.wall))), stageMs: r1(med(seq.map((x) => x.ms))), continued: seq.filter((x) => !x.remounted).length, htmlKB: r1((med(seq.map((x) => x.bytes)) ?? 0) / 1024) };
    // Mount only, no push (frame 0, forgetting the previous frame each time)
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
console.log(`Machine: ${report.host.cpu}, ${report.host.logicalCores} logical cores; ${report.chrome}${THROTTLE > 1 ? `; main thread slowed down ${THROTTLE}x` : ''}`);
console.log(`One ${SECONDS}-second clip per card (${FPS} fps, ${LAST + 1} frames in total); each number is the median of ${ROUNDS} runs; the time is measured in the parent page from sending the request to receiving the reply`);
for (const c of report.cards) {
  if (c.verify.length) { console.log(`Card ${c.cardId}:` + c.verify.map((v) => `Frame ${v.frame} (${(v.frame / FPS).toFixed(1)} s)${v.same ? ' identical' : (v.jumpStable ? ' different' : ' different (two jumps also differ from each other)') + `[${v.why}]`}`).join(';')); continue; }
  console.log(`Card ${c.cardId}: running in order takes ${c.seq.wallMs} ms per frame (${c.seq.continued}/${c.seq.frames} frames continued from the previous frame, snapshot ${c.seq.htmlKB} KB); mounting without stepping takes ${c.mount.wallMs} ms`);
  for (const j of c.jumps) console.log(`   Jump to frame ${String(j.frame).padStart(3)} (${String(j.sec).padStart(4)} s)  ${String(j.wallMs).padStart(8)} ms   average ${j.perStepMs} ms per step${j.remounted ? '' : '   (not remounted, the numbers are not comparable)'}`);
}
if (report.failures.length) { console.log(`Failed:\n  ${report.failures.join('\n  ')}`); process.exit(1); }
console.log('All finished (timings are only recorded)');

/**
 * Whether snapshots generated frame by frame along each stage path changed before and after modifying
 * common stage frame push code (`src/render/pinAnimations.ts`, `src/render/stageClock.ts`).
 * Origin: render refactor "Frame Push Consistency" (`docs/archive/agent-reports/AGENT-rr-push-exact.md`):
 * these two locations are shared across visible stage, measurement, and background snapshot generation;
 * how much each path is affected after changes must be measured, not deduced by reading code.
 *
 *   node scripts/probes/stage-push-before-after-probe.mjs --before <online build before> --after <online build after>
 *        [--port-base 27590]                  uses +0 (parent page origin), +2 (stage origin); both builds use same ports in succession
 *        [--cards <card ids, comma-separated>] default is those 14 stateful built-in cards plus `terminal-3d`
 *        [--last 150] [--fps 30] [--seconds 20]   up to which frame each path processes frame by frame from frame 0
 *        [--paths front,measure,bake]         which paths to run (booleans also available, see below)
 *        [--json <file>] [--out <dir>]        --out saves snapshots that differ before and after changes
 *
 * Online build: `npx vite build --mode online --outDir <dir> --emptyOutDir` (build the pre-change copy in the pre-change tree).
 *
 * Three paths; each card reloads the stage once per path; project is a 20-second clip with only this card:
 *
 *   front    Visible stage advances frame by frame: role switched to visible (`setRole('front')`),
 *            scrubbing forward frame by frame with `setTime(frame / fps)` (under one second each time,
 *            taking the "continuous playback" branch in stage: `clock.advanceTo` synchronously pushes
 *            one step, pinning animations); wait for stage's own catch-up tick to finish (a real frame),
 *            then call `__pcCreateSnapshot()` in the stage document. This is the live render frame
 *            of the visible stage when user scrubs frame by frame while paused.
 *   measure  Measurement snapshot pass: background stage `render(t, { jump: true, probe: 'snapshot' })`,
 *            advancing frame by frame from mount frame, generating snapshots each frame and sending them
 *            back (`probe-frame` event). In production, this pass is truncated by a one-tick budget, so
 *            only the first few frames exist; when the two builds yield different frame counts, compare
 *            only common frames.
 *   bake     Background stage generates snapshots frame by frame for browser nodes (`bakeFrame`, sequentially).
 *   booleans Two boolean probe passes for measurement (`render(t, { jump: true, probe: 'booleans' })`):
 *            whether this card is classified as "only advancing its own subtree time is sufficient"
 *            (`vtOk`) and "seekable" (`seekOk`). Not run by default, runs only when specified in `--paths`;
 *            only reports values before and after.
 *
 * Report: for each card and each path, compare frame by frame before and after (matching the criteria
 * of `snapshotCompare.mjs`: compare tags, attributes, text verbatim, style values with 1e-6 tolerance),
 * reporting count of identical frames, count of differing frames, which frames differ, and where the first
 * difference is; also reports whether front and bake paths match in each build (snapshot comparison of
 * the same frame across both paths). This probe only measures and does not judge: differences before and
 * after changes are not considered failures (that is what was changed). Exit code: page error or a path
 * failed to run exits 1; missing build exits 2; otherwise 0.
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
  if (!dir || !fs.existsSync(path.join(dir, 'stage.html'))) { console.error(`${name} needs the directory of an online build (containing stage.html): ${dir}`); process.exit(2); }
}

/** React auto-generated element IDs: changes on each remount, reordered by appearance order before comparison (same as `stateful-seq-vs-jump-probe.mjs`) */
const REACT_ID = /_r_[0-9a-z]+_|:r[0-9a-z]+:|«r[0-9a-z]+»/g;
const renumberIds = (html) => { const seen = new Map(); return html.replace(REACT_ID, (m) => { if (!seen.has(m)) seen.set(m, `_r_#${seen.size}_`); return seen.get(m); }); };
const sameHtml = (a, b) => {
  if (a === b) return { same: true };
  const r = compareSnapshotHtml(renumberIds(a), renumberIds(b));
  const clip = (v) => { const s = String(v ?? '(none)'); return s.length > 70 ? `${s.slice(0, 70)}…` : s; };
  return r.same ? { same: true } : { same: false, why: `${r.reason}${r.expected !== undefined || r.actual !== undefined ? `:${clip(r.expected)} → ${clip(r.actual)}` : ''}` };
};

const projectOf = (cardId) => ({
  id: `ba-${cardId}`, name: 'Before and after comparison', width: 1920, height: 1080, fps: FPS, duration: SECONDS,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [{ id: 'tr', name: cardId, hidden: false, clips: [{ id: 'clip', kind: 'card', cardId, start: 0, end: SECONDS, params: {} }] }],
});

/** Parent page: stage iframe placed in original position and visible (visible stage path requires real frames); receives `bake-frame` and `probe-frame` */
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
  const t0 = performance.now(); while (!ready) { if (performance.now() - t0 > 60000) throw new Error('stage not ready within 60 seconds'); await new Promise((r) => setTimeout(r, 50)); } stageWin = f.contentWindow; return ready; };
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
const guard = (what, job) => { let timer; return Promise.race([job, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} produced no result in 5 minutes`)), 300000); })]).finally(() => clearTimeout(timer)); };

/** Run each path for every card on a single build; return { card: { path: Map(frame → HTML) } } */
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
    page.on('pageerror', (e) => failures.push(`${label} page error: ${String(e.message || e).slice(0, 160)}`));
    await page.goto(`http://127.0.0.1:${BASE}/probe-parent`, { waitUntil: 'load' });
    await page.bringToFront();
    const rpc = (method, ...args) => guard(`${label} stage call ${method}`, page.evaluate((m, a) => window.__rpc(m, ...a), method, args));
    const stageFrame = () => page.frames().find((f) => f.url().includes('/editor/stage.html')) ?? null;
    const load = async () => {
      await guard('Load stage', page.evaluate((src) => window.__setup(src), `http://127.0.0.1:${BASE + 2}/editor/stage.html?stage=1&id=B&preview=stage&dual=1&lm=0`));
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
              // Stage catch-up ticks are queued in a microtask; then wait for a real frame so that commits
              // and animation events scheduled in this frame both settle
              const html = await guard('Get snapshot', stageFrame().evaluate(async (clipId) => {
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
              if (!r?.ok) { failures.push(`${label} ${cardId} bake frame ${n}: ${r?.reason}`); break; }
            }
            for (const [n, html] of await taken()) got.set(n, html);
          }
        } catch (e) {
          failures.push(`${label} ${cardId} ${how}:${String(e?.message || e).slice(0, 200)}`);
        }
        out[cardId][how] = got;
        console.error(`[${label}] ${cardId} ${how}: ${got.size} frames`);
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const s of servers) await new Promise((resolve) => { s.close(() => resolve()); s.closeAllConnections?.(); });
  }
  return out;
}

const before = await runBuild('Before', BEFORE);
const after = await runBuild('After', AFTER);
if (OUT) fs.mkdirSync(OUT, { recursive: true });

/** Compare two sets of "frame → HTML" frame by frame (only comparing frames present on both sides) */
const compare = (a, b, label) => {
  const frames = [...a.keys()].filter((n) => b.has(n)).sort((x, y) => x - y);
  const differ = [];
  let first = null;
  for (const n of frames) {
    const r = sameHtml(a.get(n), b.get(n));
    if (r.same) continue;
    differ.push(n);
    first ??= `Frame ${n}: ${r.why}`;
    if (OUT && label) { fs.writeFileSync(path.join(OUT, `${label}-${n}-a.html`), a.get(n)); fs.writeFileSync(path.join(OUT, `${label}-${n}-b.html`), b.get(n)); }
  }
  return { compared: frames.length, same: frames.length - differ.length, differ, first };
};
const brief = (r) => (r.compared === 0 ? 'No frames to compare' : r.differ.length === 0 ? `All ${r.compared} frames are identical` : `${r.differ.length} of ${r.compared} frames differ (${r.differ.slice(0, 24).join(', ')}${r.differ.length > 24 ? '…' : ''})`);

const report = { when: new Date().toISOString(), host: { cpu: os.cpus()[0]?.model?.trim(), logicalCores: os.cpus().length },
  options: { before: BEFORE, after: AFTER, cards: CARDS, last: LAST, fps: FPS, paths: PATHS }, cards: [], failures };
console.log(`One ${SECONDS}-second clip per card (${FPS} fps), each path goes frame by frame from frame 0 to frame ${LAST}`);
for (const cardId of CARDS) {
  const row = { cardId, beforeVsAfter: {}, frontVsBake: {} };
  console.log(`Card ${cardId}`);
  for (const how of PATHS) {
    if (how === 'booleans') {
      const x = before[cardId][how]?.get(0) ?? 'not measured', y = after[cardId][how]?.get(0) ?? 'not measured';
      row.booleans = { before: x, after: y, same: x === y };
      console.log(`   booleans before ${x}; after ${y}${x === y ? '' : '  ← changed'}`);
      continue;
    }
    const r = compare(before[cardId][how] ?? new Map(), after[cardId][how] ?? new Map(), `${cardId}-${how}`);
    row.beforeVsAfter[how] = r;
    console.log(`   ${how.padEnd(7)} before vs after: ${brief(r)}${r.first ? `[${r.first}]` : ''}`);
  }
  if (PATHS.includes('front') && PATHS.includes('bake')) {
    for (const [label, set] of [['Before', before], ['After', after]]) {
      const r = compare(set[cardId].front ?? new Map(), set[cardId].bake ?? new Map(), null);
      row.frontVsBake[label] = r;
      console.log(`   ${label}: visible stage stepping frame by frame vs generate snapshots in the background: ${brief(r)}${r.first ? `[${r.first}]` : ''}`);
    }
  }
  report.cards.push(row);
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
if (failures.length) { console.log(`Failed:\n  ${failures.join('\n  ')}`); process.exit(1); }

/*
 * Stage-side acceptance check probe for R9 "shared WebGL renderer for canvas cards".
 *
 *   node scripts/probes/gl-stage-probe.mjs --origin http://127.0.0.1:5240 [--out out/gl-stage] [--only direct,editor]
 *
 * Two sections:
 *
 * **Direct** (does not go through editor; opens a stage page directly at the top level
 * `http://<stage-port>/?stage=1&id=A&preview=stage`, driven via `window.__pcStage`):
 *   - Route 1 context count: 0 live WebGL contexts on the stage main thread, exactly 1 in its Worker;
 *   - 20 `scene-3d` cards with different parameters active simultaneously, not triggering
 *     `webglcontextlost`, with bitmaps pasted to all 20 planes;
 *   - 3 cards referencing the same texture: 1 `THREE.Texture` in Worker, uploaded once;
 *   - Tick: clicking timeline once when paused emits only one tick; K3(a) synchronous `advanceTo`
 *     (forward < 0.5 s) emits only one tick after finishing;
 *   - Snapshot: generating snapshots under `back` role, three card is a non-empty `<img>`,
 *     `lossy = 0`; artificially modifying `data-pc-gl-frame` → `lossy` counts it;
 *   - Capability fallback: when `?glOffscreen=0`, canvas cards render on main thread (1 context
 *     on main thread, no Worker), comparing frame pixel-by-pixel with the Worker path.
 *
 * **Editor** (`/?editor&headless=1&preview=stage`, two cross-origin stages):
 *   - Route 2 (`project.glRoute = 'shared'`): both stage documents use ports passed from the
 *     parent page, 0 contexts on main thread, 1 in the parent page's shared Worker;
 *     after sending `setRole('back')` to `B`, `B`'s atlas in shared Worker is released,
 *     `A` remains untouched, `stageId` unchanged;
 *   - Playback: `sec` difference of `frame` is always 1/fps; when Worker deliberately sleeps for
 *     100 ms, stage waits without dropping frames, and main document detects stutter (audio paused);
 *   - Frame catch-up (K5 route 1): classify as heavy, `vtOk` `scene-3d`, the tick caught up after
 *     `setTime(t, { settle: true })`:
 *     the moment `.pc-settling` is removed, the plane already has the target frame bitmap
 *     (`data-pc-gl-frame` = local frame number of wrapper layer); intermediate frame catch-up
 *     steps do not emit `beat`.
 *
 * Images saved in `--out` (default out/gl-stage/): worker.png / main.png (fallback) / twenty.png /
 * editor-front.png.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { PNG } from 'pngjs';
import { flagArg, devOrigin } from './probe-connect.mjs';

const origin = devOrigin();
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const out = path.resolve(flagArg('out', path.join(ROOT, 'out', 'gl-stage')));
const only = (flagArg('only', '') || '').split(',').filter(Boolean);
const wants = (n) => !only.length || only.includes(n);
fs.mkdirSync(out, { recursive: true });

const fails = [];
const result = { origin, cases: {} };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`); return cond; };

/** Count WebGL contexts in each document: wrap getContext; live = not lost */
function COUNT_GL() {
  const list = [];
  const wrap = (proto) => {
    if (!proto || proto.__pcGlWrapped) return;
    const orig = proto.getContext;
    proto.getContext = function (type, ...rest) {
      const c = orig.call(this, type, ...rest);
      if (c && /webgl/i.test(String(type)) && !list.includes(c)) list.push(c);
      return c;
    };
    proto.__pcGlWrapped = true;
  };
  wrap(HTMLCanvasElement.prototype);
  if (typeof OffscreenCanvas !== 'undefined') wrap(OffscreenCanvas.prototype);
  window.__pcGlCtxAlive = () => list.filter((c) => !c.isContextLost()).length;
  window.__pcGlCtxCreated = () => list.length;
}

const { ports } = await (await fetch(origin + '/api/stage/ports')).json();
const u = new URL(origin);
const stageOrigin = `${u.protocol}//${u.hostname}:${ports[0]}`;

const card = (id, over = {}, frame) => ({ id, cardId: 'scene-3d', start: 0, end: 4, params: {
  shape: 'knot', color: '#8ab4ff', metal: 0.6, rough: 0.25, size: 0.55, spinY: 0.15, spinX: 0, tilt: -18, light: 'studio', fov: 0, wire: 'no', texture: '', ...over }, ...(frame ? { frame } : {}) });
const projectOf = (clips, extra = {}) => ({ version: 1, id: 'gl-stage', name: 'gl-stage', width: 960, height: 540, fps: 30, duration: 4, themeId: 'default', media: [],
  tracks: clips.map((c, i) => ({ id: `t${i}`, clips: [c] })), ...extra });
const SHAPES = ['knot', 'cube', 'sphere', 'torus', 'cone', 'cylinder', 'crystal'];
const grid = (n, cols, over = () => ({})) => Array.from({ length: n }, (_, i) => {
  const w = 960 / cols, rows = Math.ceil(n / cols), h = 540 / rows;
  return card(`c${i}`, { shape: SHAPES[i % SHAPES.length], color: `#${(((i * 2654435761) >>> 8) & 0xffffff | 0x404040).toString(16).padStart(6, "0")}`, spinY: 0.1 + i * 0.03, ...over(i) },
    { x: (i % cols) * w, y: Math.floor(i / cols) * h, w, h });
});

const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 240000,
  args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--disable-gpu-vsync', '--disable-frame-rate-limit'],
});


/**
 * Write cost records for scene-3d manually (same as playback-probe): `heavy` = classify as heavy,
 * `vtOk` (K5 route 1 frame catch-up); otherwise classify as light (live render during playback).
 * Records land in out/card-costs.json on the dev server and persist across rounds, so rewrite
 * according to desired weight at the start of each section.
 */
const SET_COSTS = async ({ heavy }) => {
  const { getState } = await import('/src/store/project.ts');
  const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
  const { setPlanCosts } = await import('/src/editor/planDispatch.ts');
  const project = getState().project;
  const { identityKeys } = clipIdentityOf(project);
  const existing = (await (await fetch('/api/data/costs')).json())?.costs ?? [];
  // Reuse the device written by the K1 resident probe for **these cards** (same device overwrites;
  // changing it only adds a record while the real measured one remains)
  const mine = new Set(Object.values(identityKeys));
  const device = existing.find((r) => mine.has(r.identityKey))?.device ?? existing[0]?.device ?? 'gl-stage-probe';
  const seen = new Set();
  const records = [];
  for (const tr of project.tracks) for (const clip of tr.clips) {
    const key = identityKeys[clip.id];
    if (clip.cardId !== 'scene-3d' || !key || seen.has(key)) continue;
    seen.add(key);
    records.push({ identityKey: key, device, mode: 'dev', fps: project.fps, stepMs: 1, stepMaxMs: 1, inlineMs: 1, rasterMs: 1, serializeMs: 1,
      catchUpMs: heavy ? 10 : 0, kind: heavy ? 'stepped' : 'random', vtOk: true, seekOk: !heavy, seekMs: heavy ? null : 1, capped: heavy, demoted: false, measuredAt: Date.now() });
  }
  const put = await (await fetch('/api/data/costs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records }) })).json();
  const after = await (await fetch('/api/data/costs')).json();
  const tuning = after?.tuning ?? null;
  // Provide the entire costs together (if only these records are passed, the resident probe's next
  // GET will overwrite them)
  setPlanCosts(after?.costs ?? records, tuning);
  await new Promise((r) => setTimeout(r, 100));
  const stored = (after?.costs ?? []).filter((r) => mine.has(r.identityKey)).map((r) => ({ key: r.identityKey, device: r.device === device, capped: r.capped, kind: r.kind }));
  return { n: records.length, put, stored };
};

/** Wait for this stage to paste bitmaps to all gl planes (every plane has data-pc-gl-frame equal to the wrapper layer's local frame number) */
const WAIT_PAINTED = async (n) => {
  // setTimeout / performance.now on the stage page are virtual clocks (stopped when paused);
  // polling always uses the real ones
  const now = window.__pcRealNow ?? (() => performance.now());
  const later = (ms) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, ms));
  const t0 = now();
  for (;;) {
    const planes = [...document.querySelectorAll('[data-pc-gl-plane]')];
    const ok = planes.length >= n && planes.every((p) => p.getAttribute('data-pc-gl-frame') !== null
      && p.getAttribute('data-pc-gl-frame') === p.closest('[data-pc-local-frame]')?.getAttribute('data-pc-local-frame'));
    if (ok) return { planes: planes.length, ms: now() - t0 };
    if (now() - t0 > 60000) return { planes: planes.length, timeout: true, frames: planes.map((p) => p.getAttribute('data-pc-gl-frame')) };
    await later(30);
  }
};

async function openStage(query = '') {
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  await page.evaluateOnNewDocument(COUNT_GL);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${stageOrigin}/?stage=1&id=A&preview=stage${query}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => !!window.__pcStage, { timeout: 180000 });
  return { page, errors };
}

const shot = async (page, file) => {
  const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 960, height: 540 }, omitBackground: true });
  fs.writeFileSync(path.join(out, file), buf);
  return PNG.sync.read(buf);
};

try {
  /* ============================================================ Direct */
  if (wants('direct')) {
    /* ---- Route 1: context count + 3 cards with the same texture ---- */
    const texUrl = '/@media/gl-migrate-texture.png';
    {
      const { page, errors } = await openStage();
      const project = projectOf([
        card('k1', { texture: texUrl, shape: 'sphere' }, { x: 0, y: 0, w: 320, h: 270 }),
        card('k2', { texture: texUrl, shape: 'cube' }, { x: 320, y: 0, w: 320, h: 270 }),
        card('k3', { texture: texUrl, shape: 'torus' }, { x: 640, y: 0, w: 320, h: 270 }),
        card('k4', { shape: 'knot' }, { x: 0, y: 270, w: 960, h: 270 }),
      ]);
      await page.evaluate((p) => window.__pcStage.setProject(p), project);
      await page.evaluate(() => window.__pcStage.setTime(0.5));
      const painted = await page.evaluate(WAIT_PAINTED, 4);
      const diag = await page.evaluate(() => window.__pcStageDiag().gl);
      const worker = await page.evaluate(() => window.__pcGlWorkerDiag());
      const mainAlive = await page.evaluate(() => window.__pcGlCtxAlive?.() ?? null);
      const mainCreated = await page.evaluate(() => window.__pcGlCtxCreated?.() ?? null);
      await shot(page, 'worker.png');
      result.cases.route1 = { painted, diag: { mode: diag.mode, route: diag.route, beats: diag.beats }, worker, mainAlive, mainCreated, errors };
      check(!painted.timeout, 'Route 1: all 4 gl planes were painted with the current frame\'s bitmap', painted);
      check(diag.mode === 'worker', 'Route 1: glHost uses its own Worker', diag.mode);
      check(mainAlive === 0, 'Route 1: the stage main thread has 0 live WebGL contexts', { mainAlive, mainCreated });
      check(worker?.contexts === 1, 'Route 1: exactly 1 context in the Worker', worker);
      check(worker?.threeTextures === 1 && worker?.uploads === 1, 'The same texture is referenced by 3 cards: one THREE.Texture, uploaded once', worker);

      /* ---- Tick: clicking timeline once emits only one tick; synchronous advanceTo emits only one tick after finishing ---- */
      const beats0 = diag.beats;
      await page.evaluate(() => window.__pcStage.setTime(2.0));
      await page.evaluate(WAIT_PAINTED, 4);
      const beats1 = (await page.evaluate(() => window.__pcStageDiag().gl)).beats;
      await page.evaluate(() => window.__pcStage.setTime(2.3)); // Forward 0.3 s: continuous path, synchronous advanceTo pushes 9 frames
      await page.evaluate(WAIT_PAINTED, 4);
      const beats2 = (await page.evaluate(() => window.__pcStageDiag().gl)).beats;
      result.cases.beatCount = { beats0, beats1, beats2 };
      check(beats1 - beats0 === 1, 'One click on the timeline (far jump) emits only one beat', { beats0, beats1 });
      check(beats2 - beats1 === 1, 'K3(a) synchronous advanceTo (forward 0.3 s = 9 frames) emits one beat only after it ends', { beats1, beats2 });

      /* ---- Snapshots: generate snapshots under back role ---- */
      await page.evaluate(() => window.__pcStage.setRole('back'));
      const probeReply = await page.evaluate(() => window.__pcStage.setTime(1.0, { probe: true }));
      const snap = await page.evaluate(() => {
        const s = window.__pcCreateSnapshot();
        return { lossy: s.lossy, imgs: s.controls.map((c) => (c.html.match(/<img[^>]*src="data:image\/png;base64,/g) || []).length), sizes: s.controls.map((c) => c.html.length) };
      });
      const tampered = await page.evaluate(() => {
        const p = document.querySelector('[data-pc-gl-plane]');
        p.setAttribute('data-pc-gl-frame', '99999');
        return window.__pcCreateSnapshot().lossy;
      });
      result.cases.snapshot = { probeReply, snap, tampered };
      check(snap.lossy === 0 && snap.imgs.every((n) => n >= 1), 'Generate snapshots: the three cards are non-empty <img>, lossy = 0', snap);
      check(tampered === 1, 'Change a card\'s data-pc-gl-frame to a mismatched value: lossy counts it (= 1)', tampered);
      check(typeof probeReply?.stepMs === 'number', 'The setTime({ probe }) reply carries stepMs (including the beat → done round trip)', probeReply);
      await page.close();
    }

    /* ---- 20 three.js cards active simultaneously ---- */
    {
      const { page, errors } = await openStage();
      const lost = [];
      page.on('console', (m) => { if (/context lost|CONTEXT_LOST/i.test(m.text())) lost.push(m.text()); });
      await page.evaluate((p) => window.__pcStage.setProject(p), projectOf(grid(20, 5)));
      await page.evaluate(() => window.__pcStage.setTime(1.2));
      const painted = await page.evaluate(WAIT_PAINTED, 20);
      const worker = await page.evaluate(() => window.__pcGlWorkerDiag());
      const mainAlive = await page.evaluate(() => window.__pcGlCtxAlive?.() ?? null);
      await shot(page, 'twenty.png');
      result.cases.twenty = { painted, worker, mainAlive, lost, errors };
      check(!painted.timeout && painted.planes === 20, '20 scene-3d cards active at once: all 20 planes were painted with bitmaps', painted);
      check(worker?.contextLost === 0 && worker?.contexts === 1 && lost.length === 0, '20 cards do not trigger webglcontextlost, still 1 context in the Worker', { worker, lost });
      check(mainAlive === 0, '20 cards: the stage main thread has 0 live WebGL contexts', mainAlive);
      await page.close();
    }

    /* ---- Capability fallback: ?glOffscreen=0 ---- */
    {
      const project = projectOf([card('k4', { shape: 'knot' }, { x: 0, y: 0, w: 960, h: 540 })]);
      const run = async (query, file) => {
        const { page, errors } = await openStage(query);
        await page.evaluate((p) => window.__pcStage.setProject(p), project);
        await page.evaluate(() => window.__pcStage.setTime(1.5));
        const painted = await page.evaluate(WAIT_PAINTED, 1);
        const diag = await page.evaluate(() => window.__pcStageDiag().gl);
        const caps = await page.evaluate(async () => (await import('/src/render/stageRpc.ts')).detectHostCapabilities());
        const mainAlive = await page.evaluate(() => window.__pcGlCtxAlive?.() ?? null);
        const img = await shot(page, file);
        await page.close();
        return { painted, mode: diag.mode, offscreenGl: caps.offscreenGl, mainAlive, img, errors };
      };
      const w = await run('', 'fallback-worker.png');
      const m = await run('&glOffscreen=0', 'fallback-main.png');
      let diff = 0, maxd = 0;
      for (let i = 0; i < w.img.data.length; i++) { const d = Math.abs(w.img.data[i] - m.img.data[i]); if (d) { diff++; maxd = Math.max(maxd, d); } }
      result.cases.fallback = { worker: { ...w, img: undefined }, main: { ...m, img: undefined }, diffBytes: diff, maxDiff: maxd };
      check(m.offscreenGl === false && m.mode === 'main', 'Capability fallback: with offscreenGl forced to false, glHost runs on the main thread', { offscreenGl: m.offscreenGl, mode: m.mode });
      check(!m.painted.timeout, 'Capability fallback: the beat / done protocol is unchanged, planes are still painted with the current frame', m.painted);
      check(m.mainAlive === 1, 'Capability fallback: exactly 1 context on the main thread (the one that replaces the Worker\'s)', m.mainAlive);
      check(diff === 0, 'Capability fallback: the picture is pixel-identical to the Worker route', { diff, maxd });
    }
  }

  /* ============================================================ Editor */
  if (wants('editor')) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });
    await page.evaluateOnNewDocument(COUNT_GL);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(origin + '/?editor&headless=1&preview=stage', { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForSelector('iframe[data-pc="stage-frame"]', { timeout: 180000 });
    await page.waitForFunction(async () => (await import('/src/editor/stageBridge.ts')).backRole() === 'back', { timeout: 180000, polling: 500 });
    const frameOf = (id) => page.frames().find((f) => f.url().includes('stage=1') && f.url().includes(`id=${id}`));
    const build = async (n, route) => page.evaluate(async ({ n, route }) => {
      await import('/src/cards/index.ts');
      const { actions, getState } = await import('/src/store/project.ts');
      actions.newProject('gl-stage-probe');
      actions.setProjectMeta({ fps: 30, duration: 6 });
      for (let i = 0; i < n; i++) actions.addCardClip('scene-3d', 0, { duration: 6 });
      actions.editCardProject((p) => ({ ...p, glRoute: route }));
      const ids = getState().project.tracks.flatMap((t) => t.clips.filter((c) => c.cardId === 'scene-3d').map((c) => c.id));
      // Change color each round: cost records land on dev server by identityKey (including params) and
      // persist across rounds; changing params avoids collisions with previous round writes
      const salt = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
      ids.forEach((id, i) => actions.setClipParams(id, { shape: ['knot', 'cube', 'torus'][i % 3], spinY: 0.2 + i * 0.1, color: '#' + salt }, { merge: true }));
      actions.seek(0.5);
      return ids;
    }, { n, route });
    const waitProbeIdle = () => page.waitForFunction(async () => (await import('/src/editor/probeRunner.ts')).probeProgress().running === false,
      { timeout: 300000, polling: 300 }).catch(() => {});

    /* ---- Route 2: context count, ports, release ---- */
    const ids = await build(3, 'shared');
    await waitProbeIdle();
    const fronts = await page.evaluate(() => window.__pcPreviewDiag?.().frontId);
    const fa = frameOf(fronts);
    await page.evaluate(async (t) => { const { actions } = await import('/src/store/project.ts'); actions.seek(t); }, 1.0);
    const painted = await fa.evaluate(WAIT_PAINTED, 3);
    const other = fronts === 'A' ? 'B' : 'A';
    const fb = frameOf(other);
    const dA = await fa.evaluate(() => window.__pcStageDiag().gl);
    const dB = await fb.evaluate(() => window.__pcStageDiag().gl);
    const mainA = await fa.evaluate(() => window.__pcGlCtxAlive?.() ?? null);
    const mainB = await fb.evaluate(() => window.__pcGlCtxAlive?.() ?? null);
    const shared = await page.evaluate(() => window.__pcSharedGlDiag?.() ?? null);
    const parentAlive = await page.evaluate(() => window.__pcGlCtxAlive?.() ?? null);
    const buf = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(out, 'editor-front.png'), buf);
    result.cases.route2 = { front: fronts, painted, dA: { mode: dA.mode, route: dA.route, stageId: dA.stageId }, dB: { mode: dB.mode, route: dB.route, stageId: dB.stageId }, mainA, mainB, shared, parentAlive };
    check(!painted.timeout, 'Route 2: all 3 planes of the visible stage were painted with the current frame', painted);
    check(dA.mode === 'port' && dA.route === 'shared', 'Route 2: the visible stage uses the port handed over by the parent page', dA.mode);
    check(mainA === 0 && mainB === 0, 'Route 2: both stage documents have 0 live contexts on the main thread', { mainA, mainB });
    check(shared?.contexts === 1, 'Route 2: 1 context in the parent page\'s shared Worker', shared);
    // Also render once on the background stage (normally it renders only during probes / catch-up runs),
    // then setRole('back') to release its portion
    await fb.evaluate(async () => {
      const { getState } = await import('/src/store/project.ts').catch(() => ({ getState: null }));
      void getState;
    }).catch(() => {});
    const projectNow = await page.evaluate(async () => (await import('/src/store/project.ts')).getState().project);
    await fb.evaluate(async (p) => { await window.__pcStage.setProject(p, { reset: true }); await window.__pcStage.setTime(1.0); }, projectNow);
    await fb.evaluate(WAIT_PAINTED, 3);
    const before = await page.evaluate(() => window.__pcSharedGlDiag());
    await fb.evaluate(() => window.__pcStage.setRole('back'));
    await new Promise((r) => setTimeout(r, 200));
    const after = await page.evaluate(() => window.__pcSharedGlDiag());
    const dB2 = await fb.evaluate(() => window.__pcStageDiag().gl);
    result.cases.release = { before: before?.atlas, after: after?.atlas, stageIdAfter: dB2.stageId, releases: dB2.releases };
    check(!!before?.atlas?.[other] && !!before?.atlas?.[fronts], `Before release: the shared Worker holds one atlas each for ${fronts} / ${other}`, before?.atlas);
    check(!after?.atlas?.[other] && !!after?.atlas?.[fronts], `After setRole('back') is sent to ${other}: its atlas is released, ${fronts}'s is untouched`, after?.atlas);
    check(dB2.stageId === other && dB2.mode === 'port', 'stageId does not change with the role and the port stays the same', dB2);

    /* ---- Playback ticks + Worker sleeps 100 ms ---- */
    await build(3, 'perDocument');
    await waitProbeIdle();
    result.cases.lightCosts = await page.evaluate(SET_COSTS, { heavy: false });
    const front = frameOf(await page.evaluate(() => window.__pcPreviewDiag?.().frontId));
    await front.evaluate(WAIT_PAINTED, 3);
    const recordPlay = async (ms) => {
      await page.evaluate(() => {
        window.__glFrames = [];
        if (!window.__glRec) {
          window.__glRec = true;
          window.addEventListener('message', (e) => { if (e.data?.type === 'frame') window.__glFrames.push({ sec: e.data.sec, at: performance.now() }); });
        }
      });
      await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(0); actions.play(); });
      await new Promise((r) => setTimeout(r, ms / 2));
      const mid = await page.evaluate(() => window.__pcPreviewDiag?.());
      const midStage = await frameOf(mid?.frontId ?? 'A').evaluate(() => {
        const d = window.__pcStageDiag();
        const id = document.querySelector('[data-pc-gl-plane]')?.getAttribute('data-pc-gl-plane');
        return { suppressed: d.suppressed, at: id ? window.__pcStagePipelineAt?.(id, d.t) : null, byClip: id ? window.__pcStagePlan?.()?.byClip?.get(id) ?? null : null };
      });
      await new Promise((r) => setTimeout(r, ms / 2));
      await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.pause(); });
      await new Promise((r) => setTimeout(r, 300));
      const frames = await page.evaluate(() => window.__glFrames);
      const secDiffs = frames.slice(1).map((f, i) => +(f.sec - frames[i].sec).toFixed(6));
      const gaps = frames.slice(1).map((f, i) => f.at - frames[i].at);
      return { mid: { front: mid?.frontId, ...midStage }, n: frames.length, badSec: secDiffs.filter((d) => Math.abs(d - 1 / 30) > 1e-6).length, gapMean: gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length), gapMin: Math.min(...gaps), gapMax: Math.max(...gaps) };
    };
    const normal = await recordPlay(2000);
    const glNormal = await front.evaluate(() => window.__pcStageDiag().gl);
    for (const id of ['A', 'B']) await frameOf(id).evaluate(() => { window.__pcGlDebugSleepMs = 100; });
    const slowBefore = await front.evaluate(() => { const d = window.__pcStageDiag(); return { beats: d.gl.beats, suppressed: d.suppressed }; });
    const slow = await recordPlay(2000);
    slow.glBeats = (await front.evaluate(() => window.__pcStageDiag().gl.beats)) - slowBefore.beats;
    slow.suppressedBefore = slowBefore.suppressed;
    const stall = await page.evaluate(() => window.__pcPreviewDiag?.());
    for (const id of ['A', 'B']) await frameOf(id).evaluate(() => { window.__pcGlDebugSleepMs = 0; });
    const rt = [...glNormal.roundTrips].sort((a, b) => a - b);
    result.cases.play = { normal, slow, stallCount: stall?.mediaStallCount, gapMax: stall?.mediaGapMaxMs,
      roundTrip: { p50: rt[Math.floor(rt.length / 2)], p90: rt[Math.floor(rt.length * 0.9)], max: rt[rt.length - 1], timeouts: glNormal.timeouts } };
    check(normal.n > 20 && normal.badSec === 0, 'Playback: the sec difference between frames is always 1/fps', normal);
    check(slow.n > 5 && slow.badSec === 0 && slow.gapMin >= 95, 'Worker sleeps 100 ms: the stage waits for it and does not skip frames (sec difference is still 1/fps, arrival gap ≥ 100 ms)', slow);
    check((stall?.mediaStallCount ?? 0) > 0, 'Worker sleeps 100 ms: the main document detects a stall (pauses audio / media after 40 ms)', stall);

    /* ---- Frame catch-up (K5 route 1) ---- */
    const setCosts = await page.evaluate(SET_COSTS, { heavy: true });
    const fstage = frameOf(await page.evaluate(() => window.__pcPreviewDiag?.().frontId));
    const catchup = await fstage.evaluate(async () => {
      const clipId = document.querySelector('[data-pc-gl-plane]').getAttribute('data-pc-gl-plane');
      const sp = window.__pcStagePlan?.();
      const planInfo = { at3: window.__pcStagePipelineAt?.(clipId, 3.0), vtOk: sp?.byClip?.get(clipId)?.vtOk ?? null, hasPlan: !!sp?.plan };
      const wrap = () => document.querySelector(`[data-pc-clip="${clipId}"]`);
      const beats0 = window.__pcStageDiag().gl.beats;
      let sawSettling = false;
      let settlingBeats = null;
      const unset = [];
      const obs = new MutationObserver(() => {
        const w = wrap();
        if (!w) return;
        if (w.classList.contains('pc-settling')) {
          if (!sawSettling) settlingBeats = window.__pcStageDiag().gl.beats;
          sawSettling = true;
          return;
        }
        if (sawSettling && !unset.length) {
          const plane = w.querySelector('[data-pc-gl-plane]');
          unset.push({ glFrame: plane?.getAttribute('data-pc-gl-frame'), localFrame: w.getAttribute('data-pc-local-frame'), beats: window.__pcStageDiag().gl.beats });
        }
      });
      obs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
      await window.__pcStage.setTime(3.0, { settle: true });
      const now = window.__pcRealNow, later = (ms) => new Promise((r) => window.__pcRealSetTimeout(r, ms));
      const t0 = now();
      while (!unset.length && now() - t0 < 10000) await later(20);
      obs.disconnect();
      return { clipId, planInfo, sawSettling, settlingBeats, unset: unset[0] ?? null, beats0, beatsEnd: window.__pcStageDiag().gl.beats };
    });
    result.cases.catchup = { setCosts, ...catchup };
    check(catchup.sawSettling, 'Frame catch-up: canvas cards classified as heavy with vtOk entered .pc-settling (K5 first route)', catchup);
    check(!!catchup.unset && catchup.unset.glFrame === catchup.unset.localFrame, 'Frame catch-up: at the moment .pc-settling is removed, the plane already holds the target frame\'s bitmap (gl-frame = local frame number)', catchup.unset);
    // setTime's own tick + caught-up tick; intermediate steps (3 s × 30 frames = 90 steps) emit no ticks
    // From entering .pc-settling to removal: only the caught-up tick (intermediate steps of
    // 3 s × 30 frames = 90 steps emit no ticks)
    // After entering .pc-settling: setTime's own settle tick (card is hidden by .pc-settling, rendering
    // the mount frame) + caught-up tick; 90 intermediate steps emit no ticks
    check(catchup.unset && catchup.settlingBeats !== null && catchup.unset.beats - catchup.settlingBeats <= 2, 'Frame catch-up intermediate steps emit no beat (between entering and removing .pc-settling there are ≤ 2 beats: the setTime beat + the catch-up beat)', catchup);
    result.cases.editorErrors = errors;
    await page.close();
  }
} finally {
  await browser.close().catch(() => {});
}

fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ ...result, fails }, null, 2));
console.log(JSON.stringify(result, (k, v) => (k === 'roundTrips' ? undefined : v), 2).slice(0, 6000));
console.log(fails.length ? `FAIL ${fails.length}:\n  ${fails.join('\n  ')}` : 'PASS all');
console.log('Output:', out);
process.exitCode = fails.length ? 1 : 0;

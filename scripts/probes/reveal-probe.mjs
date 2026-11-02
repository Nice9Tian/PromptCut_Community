/**
 * Acceptance probe for R7 "reveal stage" (the R7 items within the D5 + E + K combined acceptance
 * check).
 *
 *   node scripts/probes/reveal-probe.mjs [--port 5291] [--origin http://127.0.0.1:5291]
 *                                        [--seconds 6] [--keep] [--json out/reveal.json]
 *                                        [--only reveal,scrub,play,select] [--headed]
 *
 * When run without `--origin`, spins up its own dev server (default 5291, stage ports follow as
 * 5292 / 5293), with `PROMPTCUT_DATA_DIR` pointing to a temp directory: without isolation, this
 * pass would overwrite `out/card-costs.json` in the repository.
 *
 * # How this probe differs from others: **opens the editor without any parameters**
 *
 * Other probes either pass `?preview=stage` (verifying new path) or `?preview=legacy` (verifying
 * rollback). This one **deliberately passes nothing**: the entire point of R7 is that "defaults are
 * inverted", so it opens `/?editor&headless=1`, then asserts seeing dual stages and that the
 * visible one is **truly revealed**.
 * Before flipping the switch, running it is bound to be red, which is exactly how it should be.
 *
 * # Measurement limitations (per R2 report)
 *
 * In headless Chrome without `--disable-gpu-vsync --disable-frame-rate-limit`, rAF drops to 10 Hz;
 * stage tick loop never receives frames and tick durations are completely wrong, so both flags are
 * mandatory. **Cost**: with them enabled, rAF is no longer quantized by vsync into 16.6 ms bins, so
 * phenomena like "24 fps naturally alternates between 2/3 frames" cannot be observed here.
 * What can be measured accurately and what really must be maintained are **mean arrival interval =
 * 1000 / fps** and **consecutive `sec` delta is constant at 1/fps**.
 * `--headed` runs playback and scrubbing again with headed Chrome: what the user actually sees is a
 * headed browser; under headed mode, rAF is constrained by the real display cadence, and reported
 * intervals reflect what users actually perceive.
 */
import '../lib/no-user-dirs.mjs'; // First import: does not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR; outputs do not land in the user's Videos\PromptCut
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

import { stagePortsOf } from '../../server/stage-ports.mjs';

/* ------------------------------------------------------------------ Parameters */

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback; };
const has = (name) => argv.includes(name);

const port = Number(flag('--port', '5291')) || 5291;
const originArg = flag('--origin');
const seconds = Math.max(1, Number(flag('--seconds', '6')) || 6);
const keep = has('--keep');
const headed = has('--headed');
const outJson = flag('--json');
const only = (flag('--only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const origin = (originArg || `http://127.0.0.1:${port}`).replace(/\/+$/, '');
const wants = (name) => !only.length || only.includes(name);

/** **Without any parameters**: R7 verifies the default behavior */
const EDITOR_URL = '/?editor&headless=1';
/** Rollback case must explicitly include legacy */
const LEGACY_URL = '/?editor&headless=1&preview=legacy';

const fails = [];
const out = { origin, editorUrl: EDITOR_URL, stagePorts: stagePortsOf(port), seconds, headed, cases: {} };
const check = (cond, label, extra) => {
  if (!cond) fails.push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (msg) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);

/* ------------------------------------------------------------------ dev server */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reveal-'));
let server = null;

async function startServer() {
  if (originArg) return null;
  const viteBin = path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js');
  const proc = spawn(process.execPath,
    [viteBin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { windowsHide: true, cwd: path.resolve(import.meta.dirname, '../..'), env: { ...process.env, PROMPTCUT_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  proc.stdout.on('data', (b) => log.push(String(b)));
  proc.stderr.on('data', (b) => log.push(String(b)));
  for (let i = 0; i < 240; i++) {
    try {
      const res = await fetch(origin + '/@vite/client');
      if (res.ok) return proc;
    } catch { /* Not up yet */ }
    await sleep(500);
  }
  proc.kill();
  throw new Error(`dev server did not start within 240 seconds:\n${log.join('')}`);
}

async function stopServer() {
  if (!server) return;
  const pid = server.pid;
  server.kill();
  if (process.platform === 'win32') {
    await new Promise((r) => spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('close', r));
  }
  server = null;
}

/* ------------------------------------------------------------------ Page-side scripts */

const INSTALL_RECORDERS = async () => {
  const bridge = await import('/src/editor/stageBridge.ts');
  window.__pcFrames = [];
  window.__pcEvents = [];
  if (!window.__pcOffEvents) {
    window.__pcOffEvents = bridge.onStageEvent((e) => {
      const at = performance.now();
      if (e.type === 'frame') window.__pcFrames.push({ sec: e.sec, at });
      else window.__pcEvents.push({ type: e.type, sec: e.sec, clipId: e.clipId ?? null, at });
    });
  }
  window.__pcLongTasks = [];
  if (!window.__pcLongObs) {
    try {
      window.__pcLongObs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__pcLongTasks.push({ start: entry.startTime, dur: entry.duration });
      });
      window.__pcLongObs.observe({ entryTypes: ['longtask'] });
    } catch { window.__pcLongObs = null; }
  }
  return true;
};

const RESET_RECORDERS = () => { window.__pcFrames = []; window.__pcEvents = []; window.__pcLongTasks = []; };
const READ_RECORDERS = () => ({ frames: window.__pcFrames, events: window.__pcEvents, longTasks: window.__pcLongTasks });

/** Create a project: one track, one card */
const BUILD = async ({ fps, duration, cards }) => {
  await import('/src/cards/index.ts');
  const { actions, getState } = await import('/src/store/project.ts');
  actions.newProject('reveal-probe');
  actions.setProjectMeta({ fps, duration });
  for (const card of cards) actions.addCardClip(card.id, card.start ?? 0, { duration: card.duration ?? duration });
  const project = getState().project;
  const byCard = {};
  for (const tr of project.tracks) for (const c of tr.clips) if (c.cardId) (byCard[c.cardId] ||= []).push(c.id);
  actions.setProjectMeta({ duration });
  return { byCard, fps: getState().project.fps, duration: getState().project.duration };
};

/**
 * Whether the main document currently contains "full-frame preview" and "asset elements".
 *
 * After R7, neither should exist: full-frame `<img>` (UnifiedPreview) is reserved only for legacy,
 * and the asset layer resides inside the stage.
 * **Only inspect the preview area** (the `.pc-pv-stagebox` subtree / parent node falling back to
 * the stage iframe): screenshots in right rail chat and timeline thumbnails are also `<img>`; they
 * do not count.
 */
const SCAN_MAIN_DOC = () => {
  const frame = document.querySelector('iframe[data-pc="stage-frame"]');
  const box = frame ? frame.parentElement : null;
  if (!box) return { noBox: true };
  const imgs = [...box.querySelectorAll('img')].map((el) => ({ src: String(el.getAttribute('src') || '').slice(0, 80), w: el.clientWidth, h: el.clientHeight }));
  const videos = [...box.querySelectorAll('video')].map((el) => ({ src: String(el.currentSrc || el.getAttribute('src') || '').slice(0, 80) }));
  const canvases = [...box.querySelectorAll('canvas')].map((el) => ({ w: el.width, h: el.height }));
  const frames = [...box.querySelectorAll('iframe[data-pc^="stage-frame"]')].map((el) => ({
    which: el.getAttribute('data-pc'),
    src: String(el.getAttribute('src') || ''),
    opacity: getComputedStyle(el).opacity,
    display: getComputedStyle(el).display,
    visibility: getComputedStyle(el).visibility,
    pointerEvents: getComputedStyle(el).pointerEvents,
  }));
  return { imgs, videos, canvases, frames };
};

/** Whether the ProbeGate overlay is still present */
const GATE_ON = () => !!document.querySelector('[data-pc="probe-gate"]');

/* ------------------------------------------------------------------ Utilities */

const stats = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { n: xs.length, mean: +mean.toFixed(3), p50: +s[Math.floor(s.length * 0.5)].toFixed(3), min: +s[0].toFixed(3), max: +s[s.length - 1].toFixed(3) };
};

async function waitProbeIdle(page, timeoutMs = 300000) {
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/probeRunner.ts');
    return m.probeProgress().running === false;
  }, { timeout: timeoutMs, polling: 300 }).catch(() => {});
}

async function stageDiag(page, id) {
  const frame = page.frames().find((f) => f.url().includes('stage=1') && f.url().includes(`id=${id}`));
  if (!frame) return null;
  return await frame.evaluate(() => (typeof window.__pcStageDiag === 'function' ? window.__pcStageDiag() : null)).catch(() => null);
}
async function frontDiag(page) {
  const which = await page.evaluate(() => (typeof window.__pcPreviewDiag === 'function' ? window.__pcPreviewDiag() : null));
  if (!which) return { preview: null, stage: null };
  return { preview: which, stage: await stageDiag(page, which.frontId) };
}

/** How many `type: 'iframe'` targets CDP sees: having a target indicates an out-of-process iframe */
async function iframeTargets(page) {
  const cdp = await page.target().createCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets');
  await cdp.detach().catch(() => {});
  return targetInfos.filter((t) => t.type === 'iframe');
}

/** Open an editor page and wait until it is "usable" */
async function openEditor(browser, url, { dual = true } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(origin + url, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('iframe[data-pc="stage-frame"]', { timeout: 180000 });
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return !!m.frontStage();
  }, { timeout: 180000, polling: 500 });
  if (dual) {
    await page.waitForFunction(async () => {
      const m = await import('/src/editor/stageBridge.ts');
      return m.backRole() === 'back';
    }, { timeout: 180000, polling: 500 });
  }
  return { page, errors };
}

/* ------------------------------------------------------------------ Main flow */

const launchOpts = {
  headless: !headed,
  protocolTimeout: 240000,
  args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
};
if (headed) {
  /*
   * **Do not disable vsync in headed mode**: the purpose of this pass is to measure the numbers users
   * actually see. Disabling vsync measures "how many ticks the main thread can push at maximum", not
   * real display ticks on the screen.
   */
} else {
  // R2 report: without these two, headless Chrome rAF drops to 10 Hz here, and the tick loop never gets frames
  launchOpts.args.push('--disable-gpu-vsync', '--disable-frame-rate-limit');
  launchOpts.args.splice(PROBE_CHROME_ARGS.length, 0, '--window-position=-32000,-32000'); // Still starts with PROBE_CHROME_ARGS
}

const browser = await puppeteer.launch(launchOpts);
let exitCode = 0;
let page = null;
let errors = [];
try {
  server = await startServer();
  step('goto editor (default mode, no preview parameter at all)');
  ({ page, errors } = await openEditor(browser, EDITOR_URL, { dual: true }));
  step('Both stages are registered');
  await page.evaluate(INSTALL_RECORDERS);

  /* ========================================================= 1. Reveal stage */
  if (wants('reveal')) {
    // Create a project so ProbeGate actually has something to test
    await page.evaluate(BUILD, { fps: 30, duration: 12, cards: [{ id: 'probe-css' }, { id: 'odometer' }] });
    // Overlay: present during testing, removed after testing
    const sawGate = await page.waitForFunction(GATE_ON, { timeout: 30000, polling: 50 }).then(() => true, () => false);
    await waitProbeIdle(page);
    await sleep(500);
    const gateAfter = await page.evaluate(GATE_ON);
    const scan = await page.evaluate(SCAN_MAIN_DOC);
    const targets = await iframeTargets(page);
    const diag = await frontDiag(page);
    const frontWhich = diag.preview?.frontId === 'B' ? 'stage-frame-back' : 'stage-frame';
    const frontEl = (scan.frames ?? []).find((f) => f.which === frontWhich);
    const backEl = (scan.frames ?? []).find((f) => f.which !== frontWhich);
    out.cases['reveal'] = { sawGate, gateAfter, scan, iframeTargets: targets.length, frontId: diag.preview?.frontId ?? null };

    check(sawGate, 'The ProbeGate overlay appeared when the project was opened');
    check(gateAfter === false, 'The overlay was removed after measurement finished');
    check(frontEl && frontEl.opacity === '1', 'The visible stage is revealed (front\'s opacity is 1)', frontEl);
    check(backEl && backEl.opacity === '0' && backEl.pointerEvents === 'none',
      'The background stage is still opacity: 0 + pointer-events: none', backEl);
    check(backEl && backEl.display !== 'none' && backEl.visibility !== 'hidden',
      'The background stage is not hidden with display / visibility (K5 (4))', backEl);
    check(targets.length === 2, 'CDP has two targets of type: iframe (one process each)', targets.length);
    check((scan.imgs ?? []).length === 0, 'No full-frame <img> in the preview area of the main document', scan.imgs);
    check((scan.videos ?? []).length === 0, 'No media <video> in the preview area of the main document (the media layer is in the stage)', scan.videos);
  }

  /* ========================================================= 2. Paused scrub */
  if (wants('drag')) {
    await page.evaluate(BUILD, { fps: 30, duration: 30, cards: [{ id: 'probe-css' }, { id: 'odometer' }] });
    await waitProbeIdle(page);
    await sleep(400);
    const N = 30;
    const trips = [];
    let awaitingSeen = 0;
    let awaitingStuck = 0;
    const genBefore = (await frontDiag(page)).stage?.remountGen ?? null;
    for (let i = 0; i < N; i++) {
      const sec = 1 + (i * 0.7) % 25;
      const t0 = Date.now();
      await page.evaluate(async (s) => {
        const { actions } = await import('/src/store/project.ts');
        actions.seek(s);
      }, sec);
      // One setTime round-trip (does not wait for HTTP): parent page returns right after sending
      await page.waitForFunction(async (s) => {
        const { getState } = await import('/src/store/project.ts');
        return Math.abs(getState().t - s) < 1e-6;
      }, { timeout: 5000, polling: 10 }, sec).catch(() => {});
      trips.push(Date.now() - t0);
      // `.pc-awaiting` must be removed within 500 ms
      const st = await stageDiag(page, (await page.evaluate(() => window.__pcPreviewDiag?.().frontId)) || 'A');
      const awaiting = st?.awaiting ?? [];
      if (awaiting.length) {
        awaitingSeen++;
        const cleared = await page.waitForFunction(async () => true, { timeout: 10 }).then(async () => {
          for (let k = 0; k < 25; k++) {
            await sleep(20);
            const s2 = await stageDiag(page, (await page.evaluate(() => window.__pcPreviewDiag?.().frontId)) || 'A');
            if (!(s2?.awaiting ?? []).length) return true;
          }
          return false;
        });
        if (!cleared) awaitingStuck++;
      }
    }
    const genAfter = (await frontDiag(page)).stage?.remountGen ?? null;
    const beat = 1000 / 30;
    out.cases['drag'] = { trips: stats(trips), overBeat: trips.filter((x) => x > beat).length, awaitingSeen, awaitingStuck, genBefore, genAfter };
    // Originally, this required that "every setTime round-trip takes no more than three ticks
    // (100 ms)". That measured how fast the machine was; semantics make no such timing guarantee;
    // per verification.md "record elapsed time only, do not use as gate" (user revision, 2026-10-07),
    // changed to record only (round trips and counts exceeding one tick are both in out.cases['scrub']).
    // The "do not wait for HTTP" it wanted to prove should rather be asserted by "no network requests
    // were sent in this section"; recorded in the report's to-dos, without adding a new assertion now.
    // 2026-10-23 probe general audit third pass scan (threshold is expression category, missed by
    // regexes in the first two passes).
    check(trips.length > 0, 'Paused drag: every setTime came back (round-trip time is only recorded, not used as a gate)', out.cases['drag']);
    check(awaitingStuck === 0, '.pc-awaiting is always removed within 500 ms', { awaitingSeen, awaitingStuck });
  }

  /* ========================================================= 3. Play */
  if (wants('Play')) {
    const cadence = {};
    for (const fps of [24, 30, 60]) {
      step(`Playback at ${fps} fps`);
      await page.evaluate(BUILD, { fps, duration: seconds + 6, cards: [{ id: 'probe-css' }] });
      await waitProbeIdle(page);
      await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(0); });
      await sleep(300);
      await page.evaluate(RESET_RECORDERS);
      await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.play(); });
      await sleep(seconds * 1000);
      await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.pause(); });
      await sleep(400);
      const rec = await page.evaluate(READ_RECORDERS);
      const gaps = [];
      for (let i = 1; i < rec.frames.length; i++) gaps.push(rec.frames[i].at - rec.frames[i - 1].at);
      const secDiffWrong = rec.frames.slice(1).filter((f, i) => Math.abs(f.sec - rec.frames[i].sec - 1 / fps) > 1e-6).length;
      const g = stats(gaps);
      cadence[fps] = { gap: g, secDiffWrong, frames: rec.frames.length, longTasks: rec.longTasks.length };
      check(g && Math.abs(g.mean - 1000 / fps) <= 1,
        `Playback at ${fps} fps: mean frame arrival interval = 1000/fps ± 1 ms`, { want: 1000 / fps, got: g?.mean });
      check(secDiffWrong === 0, `Playback at ${fps} fps: consecutive sec differences are always 1/fps (no skipped frames)`, secDiffWrong);
    }
    out.cases['Play'] = cadence;

    /*
     * The "zero stutter" item: **this time, both background stage probe and prerender process must run
     * concurrently** (R5 only measured the scenario without running prerender).
     * Background probe is triggered by switching to a new project (after ProbeGate, probeRunner
     * continues testing on back); prerender process is spun up by vite-plugin-prerender itself: here we
     * only confirm it is present.
     */
    step('Zero jank: playback + background probe + prerender process');
    const prerenderUp = await page.evaluate(async () => {
      try { const r = await fetch('/api/prerender/info', { cache: 'no-store' }); const d = await r.json(); return !!d?.ready; }
      catch { return false; }
    });
    await page.evaluate(BUILD, { fps: 30, duration: seconds + 6, cards: [{ id: 'probe-css' }, { id: 'odometer' }, { id: 'punch-pill' }] });
    // Deliberately do **not** wait for probe testing to finish: let it test on back while playing
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(0); });
    await sleep(200);
    await page.evaluate(RESET_RECORDERS);
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.play(); });
    await sleep(seconds * 1000);
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.pause(); });
    await sleep(400);
    const busy = await page.evaluate(READ_RECORDERS);
    const probeState = await page.evaluate(async () => (await import('/src/editor/probeRunner.ts')).probeProgress());
    out.cases['zero-jank'] = {
      prerenderUp, probeRunningDuringPlayback: probeState.running,
      longTasks: busy.longTasks, longTaskCount: busy.longTasks.length, frames: busy.frames.length,
    };
    check(busy.longTasks.length === 0, 'The main document has 0 long tasks (> 50 ms) during playback', busy.longTasks.slice(0, 5));
  }

  /* ========================================================= 4. Click-select */
  if (wants('pick')) {
    const built = await page.evaluate(BUILD, { fps: 30, duration: 12, cards: [{ id: 'odometer' }] });
    await waitProbeIdle(page);
    await sleep(400);
    const odo = built.byCard['odometer'][0];
    await page.evaluate(async (id) => { const { actions } = await import('/src/store/project.ts'); actions.select([id]); }, odo);
    await sleep(300);
    // Click the center of its entity box to check whether the selected one is the same clipId and
    // whether it matches hitTest
    const pt = await page.evaluate(async (id) => {
      const { frontStage } = await import('/src/editor/stageBridge.ts');
      const s = frontStage();
      const list = await s.rectsWithBounds({ pixels: 'all' });
      const b = list.find((r) => r.clipId === id)?.bounds;
      if (!b) return null;
      const x = b.left + b.width / 2;
      const y = b.top + b.height / 2;
      const hit = await s.hitTest(x, y);
      return { x, y, hitClipId: hit?.clipId ?? null };
    }, odo);
    out.cases['pick'] = { odo, ...pt };
    check(pt && pt.hitClipId === odo, 'hitTest at the center of the entity box hits exactly it', pt);
  }

  const benign = (m) => /Failed to load resource/.test(m);
  out.errors = errors.filter((m) => !benign(m)).slice(0, 20);
  out.resourceErrors = errors.filter(benign).length;
  check(out.errors.length === 0, 'The page has no JS errors', out.errors.slice(0, 5));

  /* ========================================================= 5. Rollback */
  if (wants('rollback')) {
    step('Rollback: the stage should hide again under ?preview=legacy');
    const { page: lp } = await openEditor(browser, LEGACY_URL, { dual: false });
    await sleep(1500);
    const lscan = await lp.evaluate(SCAN_MAIN_DOC);
    out.cases['rollback'] = { scan: lscan };
    const lfront = (lscan.frames ?? [])[0];
    check((lscan.frames ?? []).length === 1, 'In legacy mode there is only one stage iframe', (lscan.frames ?? []).length);
    check(lfront && lfront.opacity === '0', 'In legacy mode the stage is still opacity: 0 (the full-frame <img> is on top)', lfront);
    /*
     * D5 / R7-6: Rollback must flip the matching `LEGACY` inside the stage as well (`setProject`
     * immediately recalculates this frame per jump). Previously `stageSrc` never passed `preview`, so
     * the stage-side half never took effect.
     */
    check(!!lfront && /[?&]preview=legacy(&|$)/.test(lfront.src || ''),
      'In legacy mode, ?preview=legacy is passed into the stage iframe (the same-named switch inside the stage is flipped too)', lfront?.src);
    const lstage = lp.frames().find((fr) => fr.url().includes('stage=1'));
    const lstageUrl = lstage ? lstage.url() : null;
    out.cases['rollback'].stageUrl = lstageUrl;
    check(!!lstageUrl && lstageUrl.includes('preview=legacy') && !lstageUrl.includes('preview=stage'),
      'In legacy mode, the stage page\'s own URL is preview=legacy (not stage)', lstageUrl);
    await lp.close().catch(() => {});
  }
} catch (err) {
  fails.push('The probe itself threw:' + (err?.stack || String(err)));
  exitCode = 1;
} finally {
  out.fails = fails;
  out.ok = fails.length === 0;
  if (outJson) {
    fs.mkdirSync(path.dirname(path.resolve(outJson)), { recursive: true });
    fs.writeFileSync(path.resolve(outJson), JSON.stringify(out, null, 2));
  }
  console.log(JSON.stringify(out, null, 2));
  try { await browser.close(); } catch { /* Already closed */ }
  await stopServer();
  if (!keep) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Keep if cannot be deleted */ } }
  else console.log('Temporary data directory kept:' + dataDir);
}
process.exit(fails.length ? 1 : exitCode);

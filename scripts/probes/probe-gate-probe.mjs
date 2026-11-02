/**
 * Acceptance check for K1 resident probe (R4b): **finish testing each card under loading overlay
 * before entering editor**.
 *
 *   node scripts/probes/probe-gate-probe.mjs [--port 5251] [--cards 20] [--keep]
 *                                            [--origin http://127.0.0.1:5251]
 *                                            [--json out/probe-gate.json]
 *
 * Without `--origin`, **start a dev server itself** (defaults to 5251, stage ports 5252 / 5253
 * accordingly), and point `PROMPTCUT_DATA_DIR` to a temporary directory: the drop target of
 * `out/card-costs.json` is determined by `costsDir(root)` in `server/costs-store.mjs`
 * (`PROMPTCUT_DATA_DIR || <root>/out`), and without isolation this pass would overwrite real
 * results in repository `out/`. Shut down the server and delete the temporary directory when
 * finished (`--keep` preserves them for inspection).
 *
 * # Acceptance check items (task brief section K acceptance + R4b task brief)
 *
 * 1. Load a project with N **untested** cards: overlay stays until all N items are measured;
 * 2. `out/card-costs.json` has N entries, each with four numbers (`stepMs` / `inlineMs` / `rasterMs` /
 *    `serializeMs`) + `catchUpMs` + `mode` + `demoted: false`;
 * 3. **On second open, overlay does not appear for a single frame** (install MutationObserver
 *    before document creation; not a single frame can slip through);
 * 4. During the probe, median frame interval of **visible stage** measured with `__pcRealRaf` ≤ 20 ms
 *    (`__pcRealRaf` is real rAF saved before `stageClock` takeover; `requestAnimationFrame` in the
 *    page was replaced with a queue drained only by `clock.tick`, and using it hangs indefinitely);
 * 5. Three benchmark cases across two boolean probe passes: `probe-css` → `vtOk` and `seekOk`;
 *    particle card → `vtOk`; `probe-motion-js` → `vtOk: false`;
 * 6. **Project modified mid-probe**: queue reordered by new project, and **does not push all cards
 *    from full project together** (verifies "switch to reduced project before `render`": only one
 *    card wrapper layer on background stage at any time);
 * 7. **fps dropdown in project options** (pinned architecture 7): four tiers are 24 / 25 / 30 / 60,
 *    new projects default to 30; after switching to 60, **overlay re-runs**, and `fps` field in
 *    re-measured cost record is 60.
 *
 * # Regarding the frame interval item
 *
 * R2 report noted: on this machine, without `--disable-gpu-vsync --disable-frame-rate-limit`, main
 * thread pauses cannot be measured: rAF is pinned to 16.7 ms by VSync, so even a 10 ms stall on the
 * main thread is invisible. We follow that here and include both flags; with them, rAF intervals
 * reflect true main-thread availability.
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

const port = Number(flag('--port', '5251')) || 5251;
const originArg = flag('--origin');
const wantCards = Math.max(1, Number(flag('--cards', '20')) || 20);
const keep = has('--keep');
const outJson = flag('--json');
const origin = (originArg || `http://127.0.0.1:${port}`).replace(/\/+$/, '');

/**
 * **With `headless=1`**: `Editor.tsx:148-158` injects 10 demo cards when a project has zero cards,
 * and only `?headless=1` skips them. Without it, "round 1" measures those 10 demo cards; by the
 * time the 20 cards for acceptance check are created, the overlay should no longer appear
 * (K1: newly added cards are tested in background catch-up without blocking the UI), making item 1
 * of acceptance check impossible to verify. `headless` only affects demo cards, asset migration
 * dialog, and left rail warmup, and is unrelated to probe, stage, or cost records.
 */
const EDITOR_URL = '/?editor&headless=1&preview=stage';

const fails = [];
const out = { origin, editorUrl: EDITOR_URL, stagePorts: stagePortsOf(port) };
const check = (cond, label, extra) => {
  if (!cond) fails.push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ dev server */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-probe-gate-'));
const costsFile = path.join(dataDir, 'card-costs.json');
let server = null;

async function startServer() {
  if (originArg) return null;   // Attach to the instance started by someone else (isolation of out/ is caller's responsibility then)
  /*
   * Run vite bin directly with node instead of `npx`: on Windows, spawning a .cmd without shell
   * gives EINVAL, while with shell one must worry about spaces in paths. The bin location is
   * resolved by Node itself (worktree has no node_modules, so resolution traverses up directories
   * to find the copy in the main repository).
   */
  // `vite/bin/vite.js` is not in package.json exports; resolve package root and construct path manually
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
  server.kill();
  // On Windows, npx spawns an extra node process; killing parent process does not always kill child process
  if (process.platform === 'win32') {
    await new Promise((r) => spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('close', r));
  }
  server = null;
}

/* ------------------------------------------------------------------ Page-side scripts */

/**
 * Install an observer **before document creation** to record whether `[data-pc="probe-gate"]`
 * ever appeared. Item 3 of acceptance check ("does not appear for a single frame on second open")
 * relies on it: polling cannot measure accurately because overlay might flicker between polls.
 */
const GATE_WATCHER = () => {
  window.__gateSeen = false;
  window.__gateNow = false;
  const scan = () => {
    const el = document.querySelector('[data-pc="probe-gate"]');
    window.__gateNow = !!el;
    if (el) window.__gateSeen = true;
  };
  // `evaluateOnNewDocument` runs **before** documentElement exists, so it observes document itself
  new MutationObserver(scan).observe(document, { childList: true, subtree: true });
  scan();
};

/** Create a project with N untested cards. Cards are taken from registry, prioritizing the three boolean benchmark cases */
const BUILD_PROJECT = async ({ want, pinned }) => {
  await import('/src/cards/index.ts');
  const { allCards } = await import('/src/kernel/registry.ts');
  const { actions, getState } = await import('/src/store/project.ts');
  const ids = allCards().map((c) => c.id);
  const picked = [];
  for (const id of pinned) if (ids.includes(id) && !picked.includes(id)) picked.push(id);
  for (const id of ids) {
    if (picked.length >= want) break;
    // Over 50 particle cards, keep only the designated one; composite cards have no visuals of their own
    if (picked.includes(id) || id === 'composite' || (id.startsWith('particles-') && !pinned.includes(id))) continue;
    picked.push(id);
  }
  actions.newProject('probe-gate');
  // Each card occupies the same 4-second clip on its own track: matches offline probe --clip-sec 4 so numbers can be compared
  for (const id of picked) actions.addCardClip(id, 0, { duration: 4 });
  return { picked, clips: getState().project.tracks.flatMap((t) => t.clips.length) };
};

/* ------------------------------------------------------------------ Main flow */

const browser = await puppeteer.launch({
  headless: true,
  args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    /*
     * R2 report: on this machine, main thread pauses cannot be measured without these two flags:
     * rAF is pinned to 16.7 ms by VSync, so even a 10 ms stall on the main thread is invisible.
     * Item 4 of acceptance check specifically asks whether "visible stage is being held back".
     */
    '--disable-gpu-vsync', '--disable-frame-rate-limit'],
});
let exitCode = 0;
try {
  server = await startServer();

  /* ---------------- First open: overlay should stay until all measurements complete ---------------- */
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.evaluateOnNewDocument(GATE_WATCHER);
  await page.goto(origin + EDITOR_URL, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('iframe[data-pc="stage-frame"]', { timeout: 180000 });
  // Both cross-origin stages registered (E1)
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return m.backRole() === 'back';
  }, { timeout: 180000, polling: 500 });

  const built = await page.evaluate(BUILD_PROJECT, { want: wantCards, pinned: ['probe-css', 'probe-motion-js', 'particles-snow'] });
  out.cards = built.picked;
  check(built.picked.length === wantCards, `The project has ${wantCards} cards`, built.picked.length);

  // Overlay appears (cards to test is non-zero)
  await page.waitForFunction(() => window.__gateSeen === true, { timeout: 60000, polling: 100 }).catch(() => {});
  out.gateAppearedFirstOpen = await page.evaluate(() => window.__gateSeen);
  check(out.gateAppearedFirstOpen, 'The overlay appeared on the first open');

  /*
   * Measure frame interval of visible stage during probe (item 4). Use `__pcRealRaf` from **stage
   * iframe itself**: requestAnimationFrame in page was replaced by stageClock with a queue drained
   * only by clock.tick.
   */
  const frontFrame = () => page.frames().find((f) => f.url().includes('stage=1') && f.url().includes('id=A'));
  const rafTask = frontFrame()
    ? frontFrame().evaluate(async () => {
      const raf = window.__pcRealRaf || window.requestAnimationFrame.bind(window);
      const now = window.__pcRealNow || (() => Date.now());
      const gaps = [];
      let last = now();
      const until = last + 6000;
      await new Promise((done) => {
        const tick = () => {
          const t = now();
          gaps.push(t - last);
          last = t;
          if (t < until) raf(tick); else done();
        };
        raf(tick);
      });
      gaps.shift();
      const s = gaps.slice().sort((a, b) => a - b);
      return { n: s.length, p50: s[Math.floor(s.length * 0.5)] ?? null, p90: s[Math.floor(s.length * 0.9)] ?? null, max: s[s.length - 1] ?? null };
    }).catch(() => null)
    : Promise.resolve(null);

  // Measurement finished: running in progress drops back to false (overlay removed)
  const t0 = Date.now();
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/probeRunner.ts');
    const p = m.probeProgress();
    return p.running === false && p.done > 0;
  }, { timeout: 900000, polling: 500 });
  out.firstRunMs = Date.now() - t0;
  out.progress = await page.evaluate(async () => {
    const m = await import('/src/editor/probeRunner.ts');
    return m.probeProgress();
  });
  out.gateStillUp = await page.evaluate(() => window.__gateNow);
  check(!out.gateStillUp, 'The overlay was removed after measurement finished');

  out.raf = await rafTask;
  if (out.raf && out.raf.n > 30) {
    check(typeof out.raf.p50 === 'number', 'The median frame interval of the visible stage was measured during the probe (record only; formerly required ≤ 20 ms: timing is only recorded, not used as a gate (verification.md, user decision, 2026-10-07); patched in the second scan pass of the 2026-10-23 full probe audit)', out.raf);
  } else {
    out.rafNote = 'Not enough frames were measured (the probe ran too fast or the stage iframe was not found), skipping this check';
  }

  /* ---------------- Records: N entries, all expected fields present in each ---------------- */
  await page.waitForFunction(() => fetch('/api/data/costs').then((r) => r.json()).then((d) => (d?.costs?.length ?? 0) > 0), { timeout: 60000, polling: 500 }).catch(() => {});
  const costs = await page.evaluate(async () => (await (await fetch('/api/data/costs')).json()));
  out.recordCount = costs?.costs?.length ?? 0;
  out.device = costs?.costs?.[0]?.device ?? null;
  check(out.recordCount === wantCards, `There are ${wantCards} cost records`, out.recordCount);
  const bad = (costs?.costs ?? []).filter((r) =>
    !Number.isFinite(r.stepMs) || !Number.isFinite(r.inlineMs) || !Number.isFinite(r.rasterMs)
    || !Number.isFinite(r.serializeMs) || !Number.isFinite(r.catchUpMs)
    || (r.mode !== 'dev' && r.mode !== 'build') || r.demoted !== false);
  check(bad.length === 0, 'Every record carries four numbers + catchUpMs + mode + demoted: false', bad.map((r) => r.identityKey));
  out.records = (costs?.costs ?? []).map((r) => ({
    identityKey: r.identityKey, kind: r.kind, stepMs: r.stepMs, stepMaxMs: r.stepMaxMs, inlineMs: r.inlineMs,
    rasterMs: r.rasterMs, serializeMs: r.serializeMs, catchUpMs: r.catchUpMs, capped: !!r.capped,
    vtOk: r.vtOk, seekOk: r.seekOk, seekMs: r.seekMs, mode: r.mode, demoted: r.demoted,
  }));

  // Also inspect persisted copy on disk (in isolated temporary directory)
  if (!originArg) {
    out.costsFile = costsFile;
    out.costsFileExists = fs.existsSync(costsFile);
    check(out.costsFileExists, 'out/card-costs.json is written in an isolated temp directory and does not touch the repo\'s out/');
  }

  /* ---------------- Three benchmark cases for boolean probe ---------------- */
  out.verdicts = await page.evaluate(async (ids) => {
    await import('/src/cards/index.ts');
    const { getCard, userCardSources } = await import('/src/kernel/registry.ts');
    const { projectCardGraph } = await import('/src/kernel/cardGraph.mjs');
    const { getState } = await import('/src/store/project.ts');
    const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
    void getCard; void userCardSources; void projectCardGraph;
    const project = getState().project;
    const { identityKeys } = clipIdentityOf(project);
    const byClip = {};
    for (const tr of project.tracks) for (const c of tr.clips) if (c.cardId) byClip[c.cardId] = identityKeys[c.id];
    const costs = (await (await fetch('/api/data/costs')).json()).costs ?? [];
    const byKey = new Map(costs.map((r) => [r.identityKey, r]));
    const outv = {};
    for (const id of ids) {
      const r = byKey.get(byClip[id]);
      outv[id] = r ? { vtOk: r.vtOk, seekOk: r.seekOk, seekMs: r.seekMs, kind: r.kind } : null;
    }
    return outv;
  }, ['probe-css', 'probe-motion-js', 'particles-snow']);
  check(out.verdicts['probe-css']?.vtOk === true && out.verdicts['probe-css']?.seekOk === true,
    'A card with only CSS / WAAPI animation has vtOk and seekOk', out.verdicts['probe-css']);
  check(out.verdicts['particles-snow']?.vtOk === true, 'particle card vtOk', out.verdicts['particles-snow']);
  check(out.verdicts['probe-motion-js']?.vtOk === false, 'A JS-driven card has vtOk false', out.verdicts['probe-motion-js']);

  /* ---------------- setPlan: table reached stage, pipelineAt can be queried ---------------- */
  out.plan = await page.evaluate(async () => {
    const m = await import('/src/editor/planDispatch.ts');
    const plan = m.currentPlan();
    return plan ? { segments: plan.segments.length, prerender: [...plan.prerenderSet].length } : null;
  });
  const front = frontFrame();
  out.stagePlan = front ? await front.evaluate(() => {
    const p = window.__pcStagePlan?.();
    return p ? { segments: p.plan.segments.length, prerender: [...p.plan.prerenderSet].length, costs: p.costs.length } : null;
  }).catch(() => null) : null;
  check(!!out.stagePlan && out.stagePlan.segments === out.plan?.segments,
    'setPlan sent the same table to the visible stage', { parent: out.plan, stage: out.stagePlan });

  /* ---------------- Second open: overlay does not appear for a single frame ---------------- */
  const page2 = await browser.newPage();
  await page2.setViewport({ width: 1600, height: 1000 });
  await page2.evaluateOnNewDocument(GATE_WATCHER);
  await page2.goto(origin + EDITOR_URL, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page2.waitForSelector('iframe[data-pc="stage-frame"]', { timeout: 180000 });
  await page2.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return m.backRole() === 'back';
  }, { timeout: 180000, polling: 500 });
  // Same set of cards, same set of identity keys
  await page2.evaluate(BUILD_PROJECT, { want: wantCards, pinned: ['probe-css', 'probe-motion-js', 'particles-snow'] });
  await page2.waitForFunction(async () => {
    const m = await import('/src/editor/probeRunner.ts');
    return m.probeProgress().running === false;
  }, { timeout: 120000, polling: 200 }).catch(() => {});
  await sleep(2000);
  out.secondOpen = await page2.evaluate(async () => {
    const m = await import('/src/editor/probeRunner.ts');
    return { gateSeen: window.__gateSeen, progress: m.probeProgress() };
  });
  check(out.secondOpen.gateSeen === false, 'The overlay does not appear for even one frame on the second open', out.secondOpen);
  check(out.secondOpen.progress.total === 0, 'The second time, no card needs measuring (all records hit)', out.secondOpen.progress);
  await page2.close();

  /* ---------------- Project modified mid-probe: queue reorders, does not push full project ---------------- */
  const page3 = await browser.newPage();
  await page3.setViewport({ width: 1600, height: 1000 });
  await page3.evaluateOnNewDocument(GATE_WATCHER);
  await page3.goto(origin + EDITOR_URL, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page3.waitForSelector('iframe[data-pc="stage-frame"]', { timeout: 180000 });
  await page3.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return m.backRole() === 'back';
  }, { timeout: 180000, polling: 500 });
  /*
   * Use a different duration (6 seconds) to change all identity keys: `cardCostKey` includes
   * `durationFrames`, so switching clip duration for the same card creates an untested record,
   * allowing another run without clearing saved state.
   */
  await page3.evaluate(async ({ want }) => {
    await import('/src/cards/index.ts');
    const { allCards } = await import('/src/kernel/registry.ts');
    const { actions } = await import('/src/store/project.ts');
    const ids = allCards().map((c) => c.id).filter((id) => id !== 'composite' && !id.startsWith('particles-')).slice(0, want);
    actions.newProject('probe-gate-2');
    for (const id of ids) actions.addCardClip(id, 0, { duration: 6 });
  }, { want: wantCards });

  const backFrame = () => page3.frames().find((f) => f.url().includes('stage=1') && f.url().includes('id=B'));
  // After probe starts running, watch for a while how many card wrapper layers exist on background stage
  await page3.waitForFunction(async () => {
    const m = await import('/src/editor/probeRunner.ts');
    return m.probeProgress().running === true;
  }, { timeout: 60000, polling: 100 }).catch(() => {});
  const wrapCounts = [];
  for (let i = 0; i < 25; i++) {
    const f = backFrame();
    if (f) {
      const n = await f.evaluate(() => document.querySelectorAll('[data-pc-clip]:not([data-pc-media])').length).catch(() => null);
      if (typeof n === 'number') wrapCounts.push(n);
    }
    await sleep(120);
  }
  out.backWrapCounts = wrapCounts;
  const maxWrap = wrapCounts.length ? Math.max(...wrapCounts) : 0;
  check(wrapCounts.length > 0 && maxWrap <= 1,
    'At any moment there is only one card clip on the background stage (swap to the reduced project first, then render)', { maxWrap, wrapCounts });

  // Switch project mid-flight: queue should reorder by new project instead of continuing to test old project cards
  const beforeSwap = await page3.evaluate(async () => (await import('/src/editor/probeRunner.ts')).probeProgress());
  await page3.evaluate(async () => {
    const { actions } = await import('/src/store/project.ts');
    actions.newProject('probe-gate-3');
    actions.addCardClip('probe-css', 0, { duration: 9 });
    actions.addCardClip('probe-motion-js', 0, { duration: 9 });
  });
  await sleep(1500);
  const afterSwap = await page3.evaluate(async () => (await import('/src/editor/probeRunner.ts')).probeProgress());
  out.replan = { beforeSwap, afterSwap };
  check(afterSwap.total <= 2, 'After the project is swapped, the queue is rearranged for the new project (only the two cards of the new project remain)', out.replan);
  await page3.waitForFunction(async () => (await import('/src/editor/probeRunner.ts')).probeProgress().running === false,
    { timeout: 180000, polling: 300 }).catch(() => {});
  await page3.close();

  /* ---------------- fps dropdown in project options: switching to 60 re-runs overlay (pinned architecture 7) ---------------- */
  const page4 = await browser.newPage();
  await page4.setViewport({ width: 1600, height: 1000 });
  await page4.evaluateOnNewDocument(GATE_WATCHER);
  await page4.goto(origin + EDITOR_URL, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page4.waitForSelector('iframe[data-pc="stage-frame"]', { timeout: 180000 });
  await page4.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return m.backRole() === 'back';
  }, { timeout: 180000, polling: 500 });
  // Place only two cards: this section runs two probe rounds (30 fps round, 60 fps round); too slow with more cards
  await page4.evaluate(async () => {
    await import('/src/cards/index.ts');
    const { actions } = await import('/src/store/project.ts');
    actions.newProject('probe-gate-fps');
    actions.addCardClip('probe-css', 0, { duration: 3 });
    actions.addCardClip('probe-motion-js', 0, { duration: 3 });
  });
  // Finish the 30 fps round first (first round blocks with overlay anyway)
  await page4.waitForFunction(async () => (await import('/src/editor/probeRunner.ts')).probeProgress().running === false,
    { timeout: 180000, polling: 300 }).catch(() => {});
  await sleep(500);

  /*
   * When Claude Code / agy / codex is not installed on this machine, AI panel automatically opens
   * settings dialog whose `.ais-backdrop` covers whole page: without closing it, no button in top
   * bar can be clicked. Press Esc, up to three times.
   */
  for (let i = 0; i < 3; i++) {
    if (!(await page4.evaluate(() => !!document.querySelector('.ais-backdrop')))) break;
    await page4.keyboard.press('Escape');
    await sleep(300);
  }
  // Open project settings dialog, find fps dropdown
  await page4.click('.pc-proj-btn');
  await page4.waitForSelector('.pc-proj-item', { timeout: 10000 });
  const openedSettings = await page4.evaluate(() => {
    const item = [...document.querySelectorAll('.pc-proj-item')].find((b) => (b.textContent || '').includes('Project settings'));
    if (!item) return false;
    item.click();
    return true;
  });
  check(openedSettings, 'The project menu has "Project settings…"');
  await page4.waitForSelector('select[data-pc="fps-select"]', { timeout: 10000 }).catch(() => {});
  out.fpsSelect = await page4.evaluate(() => {
    const el = document.querySelector('select[data-pc="fps-select"]');
    if (!el) return null;
    return { value: el.value, options: [...el.options].map((o) => Number(o.value)) };
  });
  check(!!out.fpsSelect, 'pinned architecture 7: the project options have an fps dropdown', out.fpsSelect);
  check(!!out.fpsSelect && JSON.stringify(out.fpsSelect.options) === JSON.stringify([24, 25, 30, 60]),
    'The fps dropdown has four options: 24 / 25 / 30 / 60', out.fpsSelect);
  check(!!out.fpsSelect && Number(out.fpsSelect.value) === 30, 'A new project defaults to 30', out.fpsSelect);

  // Switch to 60 and confirm: overlay should reappear from this moment
  await page4.evaluate(() => { window.__gateSeen = false; });
  await page4.select('select[data-pc="fps-select"]', '60');
  await page4.evaluate(() => {
    const ok = document.querySelector('.pc-dialog .pc-btn--primary');
    ok?.click();
  });
  out.fpsAfterConfirm = await page4.evaluate(async () => (await import('/src/store/project.ts')).getState().project.fps);
  check(out.fpsAfterConfirm === 60, 'After confirming, the project\'s fps is 60', out.fpsAfterConfirm);

  const regated = await page4.waitForFunction(() => window.__gateSeen === true, { timeout: 60000, polling: 50 })
    .then(() => true, () => false);
  out.gateAfterFpsChange = regated;
  check(regated, 'After switching fps, the overlay runs again (pinned architecture 7 / rendering 5)');
  await page4.waitForFunction(async () => (await import('/src/editor/probeRunner.ts')).probeProgress().running === false,
    { timeout: 180000, polling: 300 }).catch(() => {});
  await sleep(800);
  const costsAfterFps = JSON.parse(fs.readFileSync(costsFile, 'utf8'));
  const list60 = (Array.isArray(costsAfterFps) ? costsAfterFps : costsAfterFps.costs || []).filter((r) => r.fps === 60);
  out.costs60 = { count: list60.length, sample: list60.slice(0, 2).map((r) => ({ fps: r.fps, stepMs: r.stepMs, identityKey: r.identityKey })) };
  check(list60.length >= 2, 'After switching fps, the fps field of the re-measured cost records is 60', out.costs60);
  await page4.close();

  out.pageErrors = errors.filter((e) => !/favicon|React DevTools|Failed to load resource|ResizeObserver/i.test(e)).slice(0, 8);
} catch (err) {
  console.error(err && err.stack || err);
  fails.push('The probe itself threw:' + String(err && err.message || err));
  exitCode = 1;
} finally {
  await browser.close();
  await stopServer();
  if (!keep) {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Failing to delete is not considered a failure */ }
  }
}

out.pass = fails.length === 0;
out.fails = fails;
console.log(JSON.stringify(out, null, 2));
if (outJson) {
  const file = path.resolve(outJson);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\nWritten to ${file}`);
}
if (fails.length) {
  console.log('\nFailed:');
  for (const f of fails) console.log('  ' + f);
  exitCode = 1;
}
process.exit(exitCode);

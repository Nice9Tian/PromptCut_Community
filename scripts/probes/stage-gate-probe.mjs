/**
 * Real-browser probe for stage gates, crash records, guards, tier bubbles, and the inspection port
 * (step 3 of `docs/plan/online-browser-task.md`; semantics in `product/platforms.md` "Online browser",
 * implementation in `mechanism/platforms.md` "Three gates"). Headless Chrome opens the online-built
 * editor page and **actually kills the page process** (CDP `Page.crash`) to simulate crashes,
 * then reloads to see which tier it stops at.
 *
 *   npx vite build --mode online
 *   node scripts/probes/stage-gate-probe.mjs [--dist dist-online] [--base-port 5870] [--out <dir>] [--only S1,S3]
 *
 * Ports: editor page base, two stages base+1 / +2, document service base+3, asset service base+4
 * (default 5870-5874). Local isolated hosted setup (`lib/mobile-env.mjs`), no remote connection.
 * Only two ports are read in the page: `window.__pcGates()` (inspection port data) and
 * `[data-pc="tier-bubble"]` (bubble). `?gateHold=<step>` (acceptance check only) pauses the stage
 * gate after recording that step, while the probe kills the page process; `?gates=1` opens the
 * read-only inspection port.
 *
 * Scenes (each scene uses a fresh browser context = completely clean page local storage,
 * unless noted as continuing from previous):
 *   S1  Fresh open on PC: tests from low to high up to tier 3 "top-spec mode"; bubble text follows
 *       user decision and disappears automatically after a few seconds; final step in crash
 *       record is "Tier 3 running"
 *   S2  Normal refresh following S1 (clean exit recorded): not counted as crash; previous test
 *       succeeded, crash count is 0
 *   S3  Kill page process while testing each renderer set -> reload stops at tier 2 "standard
 *       mode", 1 crash, 30-minute guard; bubble shows "standard mode"
 *   S4  Following S3: reopen within guard, stops at tier 2, does not test
 *   S5  Following S4: move guard to the past (simulating 30 minutes elapsed) -> test from scratch
 *       up to tier 3; normal refresh again -> successful test once, reset to zero
 *   S6  Kill while testing background stage -> stops at tier 1 "lite mode" (one stage, no
 *       background stage)
 *   S7  Kill while opening visible stage (before visible stage ready) -> lowest tier "low-spec mode"
 *   S8  Kill after switching to background (visibilitychange hidden) -> not counted as crash
 *   S9  With guard and crash record, change software version in record to old (simulating
 *       upgrade) -> reset to zero, test from scratch
 *   S10 Android phone (Chromium, reports 4 GB) -> does not test, stops at one stage, mobile
 *       identity; reports 8 GB -> tests
 *   S11 On PC, kill only background stage process (stage crashed, page remains) -> supervisor
 *       reloads that instance, remains at tier 3; repeated crashes -> handshake fault tolerance
 *       falls back to single stage for current session only: no crash record left, reloads and
 *       tests as normal
 *   S12 iPad (desktop identity + multi-touch): initially tested as PC; kill while testing
 *       background stage -> reload stops at tier 1, identity re-classified as mobile
 *   S13 Two tabs: open second tab while first is still open; second does not treat first as crashed
 *   S14 Read-only inspection port: `?gates=1` shows tier, stage gates, crash records, without credentials
 *   S15 Lowest tier (`?tier=low`): cards suppressed during playback, no on-demand render; after
 *       stopping, catches up frame-by-frame per layer (no time limit)
 *   S16 Baseline card cannot run (stage CPU throttled 30x; any slower exceeds bubble wait limit
 *       and risks inconclusive results): enters lowest tier "low-spec mode"
 *   S17 Kill page process while testing a card -> on reload, this card is among crashed cards and
 *       is not re-tested, treated directly as heavy card
 *   S18 Kill while loading original-size asset (during recorded period) -> reload lowers decoding
 *       ceiling by one level
 *   S19 Decoding ceiling: browser only claims capable of decoding 720p (simulating weak
 *       device) -> ceiling 720p; visible in inspection port
 *   S20 Dual stage, project already has cost records tested by other devices: on open, runs bounds
 *       search testing only a few demarcation cards (resident probe waits first); afterwards,
 *       resident probe runs catch-up tests in background and switches to judging by cost records;
 *       single stage (`?tier=lite`) writes to document service after testing (all online
 *       browsers write after testing)
 *
 * Output: progress written to stderr; last line of stdout is JSON `{ ok, fails, scenes }`;
 * screenshots in --out.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { flagArg } from './probe-connect.mjs';
import { startMobileEnv, emptyProject, DEVICES } from './lib/mobile-env.mjs';

const args = process.argv.slice(2);
const DIST = path.resolve(flagArg('dist', 'dist-online', args));
const BASE = Number(flagArg('base-port', '5870', args));
const OUT = path.resolve(flagArg('out', path.join(os.tmpdir(), `stage-gate-${Date.now().toString(36)}`), args));
const ONLY = (flagArg('only', '', args) || '').split(',').filter(Boolean);
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const scenes = {};
const say = (...a) => process.stderr.write(`[stage-gate] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`);
const check = (scene, cond, label, extra) => {
  if (!cond) fails.push(`${scene} ${label}${extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 600)}`}`);
  (scenes[scene] ??= { checks: 0, failed: 0 }).checks++;
  if (!cond) scenes[scene].failed++;
  return !!cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeoutMs = 60_000, everyMs = 150) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(everyMs);
  }
}

const IPAD = {
  ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  viewport: { width: 1180, height: 820, deviceScaleFactor: 2, isMobile: false, hasTouch: true },
};

const env = await startMobileEnv({ dist: DIST, basePort: BASE, docPort: BASE + 3, assetPort: BASE + 4, name: 'stage-gate-probe' });
// Puts a built-in card (punchline pill, 0-4 s) and registrations for two video assets (1080p, 4K;
// registration only, no bytes: asset gate recording and decoding ceiling only check registrations)
// in the project
const seedProject = emptyProject('stage-gate-probe');
seedProject.tracks[0].clips.push({ id: 'pill-1', cardId: 'punch-pill', start: 0, end: 4, params: { text: '基准' } });
const HH = (c) => c.repeat(64);
seedProject.media = [
  { id: 'm-1080', kind: 'video', name: '1080.mp4', url: `/@media/${HH('1')}`, hash: HH('1'), ext: 'mp4', width: 1920, height: 1080, duration: 4, tiers: { original: HH('1'), small: HH('2') } },
  { id: 'm-4k', kind: 'video', name: '4k.mp4', url: `/@media/${HH('3')}`, hash: HH('3'), ext: 'mp4', width: 3840, height: 2160, duration: 4, tiers: { original: HH('3'), small: HH('4') } },
];
await env.seed(seedProject);
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 90_000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--autoplay-policy=no-user-gesture-required'] });

/** New context and page; `device` is mobile-env device name or 'ipad'; `memory` overrides navigator.deviceMemory */
async function newPage(device = 'desktop', { memory } = {}) {
  let page;
  if (device === 'ipad') {
    page = await env.newPage(browser, 'none');
    await page.setViewport(IPAD.viewport);
    await page.cdp.send('Emulation.setUserAgentOverride', { userAgent: IPAD.ua });
    await page.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  } else {
    page = await env.newPage(browser, device);
  }
  // Bubble displays for only a few seconds: record text it showed from document start (it may have
  // appeared and dismissed while entering the project and waiting for gates to finish)
  await page.evaluateOnNewDocument(() => {
    if (window.top !== window) return;
    window.__sgBubbles = [];
    const seen = () => { const t = document.querySelector('[data-pc="tier-bubble"]')?.textContent; if (t && window.__sgBubbles.at(-1) !== t) window.__sgBubbles.push(t); };
    new MutationObserver(seen).observe(document, { childList: true, subtree: true, characterData: true });
  });
  if (memory !== undefined) await page.evaluateOnNewDocument((m) => { try { Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => m, configurable: true }); } catch { /* Cannot be changed */ } }, memory);
  return page;
}
const gates = (page) => page.evaluate(() => (typeof window.__pcGates === 'function' ? window.__pcGates() : null)).catch(() => null);
const waitDone = async (page, ms = 90_000) => {
  const g = await until(async () => { const x = await gates(page); return x?.tier?.online && x.tier.gate === 'done' && x.step?.kind === 'running' ? x : null; }, ms);
  if (!g) say('Timed out waiting for the gates to finish', { url: page.url(), gates: await gates(page) });
  return g;
};
const bubbleText = (page, ms = 30_000) => until(() => page.evaluate(() => document.querySelector('[data-pc="tier-bubble"]')?.textContent ?? window.__sgBubbles?.at(-1) ?? null).catch(() => null), ms, 100);
async function enter(page, query = '') {
  await env.enter(page, { layout: 'desktop' });
  if (query) await page.goto(`${env.origin}/editor?layout=desktop&${query}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
}
async function reload(page, query) {
  const url = `${env.origin}/editor?layout=desktop${query ? `&${query}` : ''}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
}
/** Actually kills the render process of the page (top-level document); uses a new CDP session after returning */
async function crashPage(page) {
  const crashed = new Promise((resolve) => { page.once('error', () => resolve(true)); setTimeout(() => resolve(false), 15_000); });
  const cdp = await page.createCDPSession();
  // `Page.crash` returns no response (render process is gone immediately): do not wait for it,
  // wait for page "Page crashed!" event
  void cdp.send('Page.crash').catch(() => {});
  const ok = await crashed;
  if (!ok) fails.push('No page crash event within 15 seconds after Page.crash');
  return ok;
}
/** After a crash, user clicks "Reload" (same tab) */
async function reloadAfterCrash(page, query) {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 }).catch(async () => { await reload(page, query); });
}
const tabStep = (g) => g?.step;
/** CPU throttling: page and two stages (cross-origin stages are separate render processes, each set individually) */
async function throttleAll(page, rate) {
  await page.cdp?.send('Emulation.setCPUThrottlingRate', { rate }).catch(() => {});
  for (const t of browser.targets()) {
    if (!t.url().includes(`:${BASE + 1}/`) && !t.url().includes(`:${BASE + 2}/`)) continue;
    const c = await t.createCDPSession().catch(() => null);
    await c?.send('Emulation.setCPUThrottlingRate', { rate }).catch(() => {});
  }
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {});
const want = (id) => !ONLY.length || ONLY.includes(id);
const TEXT = {
  top: 'This device is running in top-spec mode', standard: 'This device is running in standard mode',
  lite: 'This device is running in lite mode: complex effects are handed off to cloud rendering', low: 'This device is running in low-spec mode: playback only shows frames that are already rendered',
};
async function holdAndCrash(scene, page, what) {
  await reload(page, `gateHold=${what}`);
  const reached = await until(async () => { const g = await gates(page); return g?.step?.kind === 'stage' && g.step.what === what ? g : null; }, 90_000, 50);
  check(scene, !!reached, `stopped at the "${what}" step (gateHold)`, await gates(page));
  await crashPage(page);
  await reloadAfterCrash(page, `gateHold=${what}`);
}

try {
  /* ---------------------------------------------------------------- S1-S5: PC */
  if (want('S1') || want('S2') || want('S3') || want('S4') || want('S5')) {
    const page = await newPage('desktop');
    await enter(page);
    let g = await waitDone(page);
    check('S1', g?.tier?.reached === 3 && g.tier.target === 3 && !g.tier.lowest, 'Fresh open: reaches level 3', g?.tier);
    check('S1', g?.decision?.reason === 'trial', 'try from low to high', g?.decision);
    check('S1', g?.judged?.crashed === false, 'not judged as crashed');
    check('S1', tabStep(g)?.kind === 'running' && tabStep(g).level === 3, 'the last step is level 3 running', tabStep(g));
    const steps = (g?.log?.history ?? []).length;
    check('S1', steps >= 1, 'the inspection port lists each past judgment');
    const b1 = await bubbleText(page);
    check('S1', b1 === TEXT.top, 'Bubble: top-spec mode', b1);
    await shot(page, 'S1-bubble');
    const gone = await until(() => page.$('[data-pc="tier-bubble"]').then((e) => !e), 15_000, 200);
    check('S1', !!gone, 'the bubble disappears on its own after a few seconds');
    const iframes = await page.$$eval('iframe[data-pc^="stage-frame"]', (els) => els.map((e) => ({ pc: e.dataset.pc, src: e.getAttribute('src') })));
    check('S1', iframes.length === 2 && iframes.every((f) => /[?&]gl=shared/.test(f.src)), 'two stages; the URL is built from the starting route (shared) and does not change because level 3 is tried', iframes);
    scenes.S1.tier = g?.tier;
    // Baseline card for on-demand render gate, decoding ceiling for asset gate (step 4): tests
    // complete, conclusions enter inspection port
    const gb = await until(async () => { const x = await gates(page); return x?.tier?.benchmark !== 'pending' ? x : null; }, 60_000);
    check('S1', gb?.tier?.benchmark === 'ok' && typeof gb.benchmark?.stepMs === 'number', 'the baseline card was measured and runs', gb?.benchmark);
    check('S1', typeof gb?.media?.decode?.maxPixels === 'number', 'the decode limit was measured once on open', gb?.media?.decode);
    scenes.S1.benchmark = gb?.benchmark;
    scenes.S1.decode = gb?.media?.decode;

    // S2 Normal refresh
    await reload(page);
    g = await waitDone(page);
    check('S2', g?.judged?.crashed === false, 'a normal refresh is not counted as a crash', g?.judged);
    check('S2', g?.log?.device?.stage?.crashes === 0, 'crash count 0', g?.log?.device?.stage);
    check('S2', g?.tier?.reached === 3, 'still reaches level 3');

    // S3 Kill while testing each set
    await holdAndCrash('S3', page, 'try-separate');
    g = await waitDone(page);
    check('S3', g?.judged?.crashed === true && g.judged.step?.what === 'try-separate', 'judged as crashed, crashed while trying separate sets', g?.judged);
    check('S3', g?.decision?.reason === 'crash' && g.tier.target === 2 && g.tier.reached === 2, 'stops at level 2, no trial', g?.tier);
    const st = g?.log?.device?.stage;
    check('S3', st?.crashes === 1 && st.guardUntil && Math.abs(st.guardUntil - Date.now() - 30 * 60_000) < 120_000, '1 crash, guard for 30 minutes', st);
    const b3 = await bubbleText(page);
    check('S3', b3 === TEXT.standard, 'Bubble: standard mode', b3);
    await shot(page, 'S3-standard');
    scenes.S3.sessionKept = g?.judged?.fromTab === g?.tab ? 'same-tab' : 'other-tab';

    // S4 Within guard
    await reload(page);
    g = await waitDone(page);
    check('S4', g?.decision?.reason === 'guard' && g.tier.target === 2, 'Within the guard: stops at level 2, no trial', g?.decision);

    // S5 Guard expired: test from scratch; refresh after successful test to reset
    await page.evaluate(() => { const k = 'pc.online.crashLog'; const l = JSON.parse(localStorage.getItem(k)); l.device.stage.guardUntil = Date.now() - 1000; localStorage.setItem(k, JSON.stringify(l)); });
    await reload(page);
    g = await waitDone(page);
    check('S5', g?.decision?.reason === 'trial' && g.tier.reached === 3, 'Past the guard: tries from the start up to level 3', g?.decision);
    check('S5', g?.log?.device?.stage?.crashes === 1, 'the crash count is still there at this point (a trial counts as successful when the next load is not judged as crashed)');
    await reload(page);
    g = await waitDone(page);
    check('S5', g?.log?.device?.stage?.crashes === 0 && g.log.device.stage.guardUntil === null, 'one successful trial: reset to zero', g?.log?.device?.stage);

    // S9 Upgrade reset (first create a record with crash and guard)
    if (want('S9') || !ONLY.length) {
      await page.evaluate(() => { const k = 'pc.online.crashLog'; const l = JSON.parse(localStorage.getItem(k)); l.device.stage = { reached: 1, lowest: false, crashes: 3, guardUntil: Date.now() + 3600_000, tried: false }; l.device.version = 'older-build'; localStorage.setItem(k, JSON.stringify(l)); });
      await reload(page);
      g = await waitDone(page);
      check('S9', g?.decision?.reason === 'trial' && g.log.device.stage.crashes <= 0 && g.tier.reached === 3, 'software version changed: reset to zero, try from the start', g?.decision);
    }
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S6 Kill while testing background stage */
  if (want('S6')) {
    const page = await newPage('desktop');
    await enter(page);
    await waitDone(page);
    await holdAndCrash('S6', page, 'try-back');
    const g = await waitDone(page);
    check('S6', g?.judged?.crashed && g.tier.target === 1 && !g.tier.lowest, 'stops at level 1 (lite)', g?.tier);
    const frames = await page.$$eval('iframe[data-pc^="stage-frame"]', (els) => els.map((e) => e.dataset.pc));
    check('S6', frames.length === 1, 'only one stage', frames);
    const b = await bubbleText(page);
    check('S6', b === TEXT.lite, 'Bubble: lite mode', b);
    await shot(page, 'S6-lite');
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S7 Kill while opening visible stage */
  if (want('S7')) {
    const page = await newPage('desktop');
    await enter(page);
    await waitDone(page);
    await holdAndCrash('S7', page, 'open-visible');
    const g = await waitDone(page);
    check('S7', g?.judged?.crashed && g.tier.lowest === 'stage' && g.tier.target === 1, 'lowest tier (not even one stage holds up)', g?.tier);
    const src = await page.$eval('iframe[data-pc="stage-frame"]', (e) => e.getAttribute('src')).catch(() => '');
    check('S7', /[?&]lowest=1/.test(src) && /[?&]compact=1/.test(src), 'the stage starts at the lowest tier from the beginning (media uses only the small size)', src);
    const b = await bubbleText(page);
    check('S7', b === TEXT.low, 'Bubble: low-spec mode', b);
    await shot(page, 'S7-low');
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S8 Reclaimed in background not counted as crash */
  if (want('S8')) {
    const page = await newPage('desktop');
    await enter(page);
    await waitDone(page);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await sleep(300);
    const g0 = await gates(page);
    const mine = g0?.log?.tabs?.[g0.tab];
    check('S8', mine?.background === true, 'recorded that it was in the background', mine);
    await crashPage(page);
    await reloadAfterCrash(page);
    const g = await waitDone(page);
    check('S8', g?.judged?.crashed === false && g.decision.reason === 'trial', 'reclaimed in the background: not counted as a crash', g?.judged);
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S10 Android */
  if (want('S10')) {
    for (const [mem, expect] of [[4, 'fixed'], [8, 'trial']]) {
      const page = await newPage('phone', { memory: mem });
      await enter(page);
      const g = await waitDone(page);
      if (expect === 'fixed') {
        check('S10', g?.decision?.reason === 'android-memory' && g.tier.target === 1, `Android ${mem} GB: stops at one stage, no trial`, g?.decision);
        check('S10', g?.tier?.identity === 'phone', 'identity is phone');
        const b = await bubbleText(page);
        check('S10', b === TEXT.lite, 'Bubble: lite mode', b);
        await shot(page, 'S10-android-4g');
      } else {
        check('S10', g?.decision?.reason === 'trial', `Android ${mem} GB: trial`, g?.decision);
      }
      await page.browserContext().close();
    }
  }

  /* ---------------------------------------------------------------- S11 On PC, kill only the background stage process */
  if (want('S11')) {
    const page = await newPage('desktop');
    await enter(page);
    let g = await waitDone(page);
    const before = g?.tier?.reached;
    const stageBTarget = () => browser.targets().find((t) => t.url().includes(`:${BASE + 2}/`) && /[?&]id=B/.test(t.url()));
    const crashB = async () => {
      const t = await until(() => stageBTarget(), 30_000, 200);
      if (!t) return false;
      const cdp = await t.createCDPSession().catch(() => null);
      void cdp?.send('Page.crash').catch(() => {});
      return true;
    };
    check('S11', !!stageBTarget(), 'the background stage is a separate render process (OOPIF target)');
    // First crash: supervisor reloads that instance with full page, shakes hands back to restore
    // dual stage (existing approach); page and tier unaffected, leaves no crash record
    await crashB();
    const watch1 = await until(() => page.evaluate(() => window.__pcStageWatch?.()).then((w) => (w && w.reloads >= 1 ? w : null)), 90_000, 500);
    check('S11', !!watch1, 'the stage crashed but the page is still there: the watcher reloads that stage', watch1);
    g = await until(async () => { const x = await gates(page); return x?.tier?.reached === 3 ? x : null; }, 60_000, 500);
    check('S11', g?.tier?.target === 3 && g.step?.kind === 'running' && g.step.level === 3, 'after reloading that stage it is still level 3, the crash record is untouched', g?.step);
    // Repeated crashes (supervisor reloads reach limit): handshake fault tolerance falls back to single
    // stage, for current session only
    for (let i = 0; i < 4; i++) {
      const w = await page.evaluate(() => window.__pcStageWatch?.()).catch(() => null);
      if (w?.fellBack) break;
      await until(() => page.evaluate(() => { const x = window.__pcStageWatch?.(); return x && x.B === 'ok' ? x : null; }), 60_000, 500);
      await crashB();
      await until(() => page.evaluate((n) => { const x = window.__pcStageWatch?.(); return x && (x.reloads > n || x.fellBack) ? x : null; }, (w?.reloads ?? 0)), 90_000, 500);
    }
    g = await until(async () => { const x = await gates(page); return x?.tier?.target === 1 ? x : null; }, 120_000, 500);
    check('S11', !!g && g.tier.reached === 1, `Repeated crashes: handshake fault tolerance falls back to a single stage (previously level ${before})`, g?.tier ?? await gates(page));
    check('S11', g?.step?.kind === 'running' && g.step.level === 1, 'current attempt only: the last step is level 1 running, with no "crashed while trying…" left behind', g?.step);
    await reload(page);
    g = await waitDone(page);
    check('S11', g?.judged?.crashed === false && g.decision.reason === 'trial' && g.tier.reached === 3, 'reloading tries as usual, not counted as a crash', g?.decision);
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S12 iPad */
  if (want('S12')) {
    const page = await newPage('ipad');
    await enter(page);
    let g = await waitDone(page);
    check('S12', g?.tier?.identity === 'desktop', 'iPad gets a trial: treated as a desktop first', g?.tier);
    await holdAndCrash('S12', page, 'try-back');
    g = await waitDone(page);
    check('S12', g?.tier?.target === 1 && g.tier.identity === 'phone', 'iPad stops at level 1: identity reclassified as phone', g?.tier);
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S13 Two tabs */
  if (want('S13')) {
    const page = await newPage('desktop');
    await enter(page);
    await waitDone(page);
    const second = await page.browserContext().newPage();
    await second.setViewport(DEVICES.desktop.viewport);
    await second.goto(`${env.origin}/editor?layout=desktop`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    // New tab has no session recovery record: does it still open stage gate when staying on start page?
    // Gate is attached only on editor page, read crash record directly here
    await sleep(3000);
    const log = await second.evaluate(() => JSON.parse(localStorage.getItem('pc.online.crashLog') || 'null'));
    const last = log?.history?.at(-1);
    check('S13', log && last && last.crashed === false, 'second tab: the first one that is still open is not counted as crashed', last);
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S14 Inspection port */
  if (want('S14')) {
    const page = await newPage('desktop');
    await enter(page);
    await reload(page, 'gates=1');
    await waitDone(page);
    const rows = await until(() => page.$$eval('[data-pc="gate-viewer"] td[data-pc-gate-row]', (els) => els.map((e) => [e.dataset.pcGateRow, e.textContent])), 30_000);
    check('S14', rows && rows.length >= 8, 'the inspection port has the results of each gate', rows);
    const json = await page.evaluate(() => JSON.stringify(window.__pcGates()));
    check('S14', !/ticket|password|token|"key":"[A-Za-z0-9_-]{43}"/i.test(json), 'the inspection port contains no credentials', json.slice(0, 200));
    await shot(page, 'S14-viewer');
    await page.browserContext().close();
  }
  /* ---------------------------------------------------------------- S15 Lowest tier: no on-demand render during playback, draw layer by layer when stopped */
  if (want('S15')) {
    const page = await newPage('desktop');
    await enter(page);
    await reload(page, 'tier=low');
    const g = await waitDone(page);
    check('S15', g?.tier?.lowest === 'stage' && g.decision.reason === 'forced', 'forced lowest tier', g?.tier);
    await until(() => page.evaluate(() => !!window.__pcStore && !!window.__pcPreviewDiag), 30_000);
    await page.evaluate(() => { window.__pcStore.actions.seek(1); window.__pcStore.actions.play(); });
    const playing = await until(() => page.evaluate(() => { const d = window.__pcPreviewDiag(); return window.__pcStore.getState().playing && d.suppressed.includes('pill-1') ? d : null; }), 20_000, 100);
    check('S15', !!playing, 'cards are suppressed during playback (no on-demand render; show the prerender output, or a placeholder if there is none)', await page.evaluate(() => window.__pcPreviewDiag().suppressed));
    await sleep(800);
    await page.evaluate(() => window.__pcStore.actions.pause());
    const settled = await until(() => page.evaluate(() => { const r = window.__pcPreviewDiag().lastSettle; return r && r.ok && r.drawn.some((x) => x.clipId === 'pill-1') ? r : null; }), 60_000, 200);
    check('S15', !!settled && settled.timeoutMs === null, 'after stopping, catch up one frame layer by layer until it is painted, no time limit', settled ?? await page.evaluate(() => window.__pcPreviewDiag().lastSettle));
    // The rendered layer is visible and contains content (not under `.pc-settling`, not suppressed,
    // not an empty wrapper)
    const look = await until(async () => {
      const f = page.frames().find((x) => /[?&]stage=1/.test(x.url()));
      const v = f ? await f.evaluate(() => {
        const w = document.querySelector('[data-pc-clip="pill-1"]:not([data-pc-media])');
        if (!w) return null;
        const r = w.getBoundingClientRect();
        const cs = getComputedStyle(w);
        const hiddenUp = !!w.closest('.pc-settling') || !!w.closest('.pc-suppressed');
        const text = (w.textContent ?? '').trim().slice(0, 40);
        return { cls: w.className, hiddenUp, visibility: cs.visibility, opacity: cs.opacity, kids: w.querySelectorAll('*').length, text, w: Math.round(r.width), h: Math.round(r.height) };
      }).catch(() => null) : null;
      return v && !v.hiddenUp && v.visibility === 'visible' && v.kids > 2 && v.text ? v : null;
    }, 20_000, 200);
    scenes.S15 = { ...(scenes.S15 ?? { checks: 0, failed: 0 }), look };
    check('S15', !!look, 'after stopping, the layer that was painted is visible and has content', look);
    await shot(page, 'S15-low-settled');
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S16 Baseline card cannot run */
  if (want('S16')) {
    const page = await newPage('desktop');
    await enter(page);
    await waitDone(page);
    // Stage gate stops at "one set of each renderer ready" step, throttles both stages by 30x, then
    // unblocks: tests baseline card after completion
    await reload(page, 'gateHold=separate-ready');
    await until(async () => { const x = await gates(page); return x?.step?.kind === 'stage' && x.step.what === 'separate-ready' ? x : null; }, 90_000, 100);
    await throttleAll(page, 30);
    await page.evaluate(() => window.__pcGateRelease?.());
    const g = await until(async () => { const x = await gates(page); return x?.tier?.benchmark && x.tier.benchmark !== 'pending' ? x : null; }, 240_000, 500);
    await throttleAll(page, 1);
    scenes.S16 = { ...(scenes.S16 ?? { checks: 0, failed: 0 }), benchmark: g?.benchmark, tier: g?.tier, step: (await gates(page))?.step, driverError: (await gates(page))?.driverError };
    check('S16', g?.tier?.benchmark === 'slow' && g.tier.lowest === 'benchmark', 'the baseline card cannot run: lowest tier', g?.benchmark);
    const b = await bubbleText(page, 30_000);
    check('S16', b === TEXT.low, 'Bubble: low-spec mode', b);
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S17 Kill while testing a card */
  if (want('S17')) {
    const page = await newPage('desktop');
    await page.cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    await enter(page);
    const measuring = await until(async () => { const x = await gates(page); return x?.step?.kind === 'measure' && x.step.key !== '@benchmark' ? x : null; }, 120_000, 30);
    check('S17', !!measuring, 'waits until a card is being measured (resident probe)', await gates(page));
    if (measuring) {
      const mine = measuring.log?.tabs?.[measuring.tab];
      say('S17 measuring card', { key: measuring.step.key, alive: mine?.alive, now: Date.now() });
      const t0 = Date.now();
      const ok = await crashPage(page);
      say('S17 kill page', { ok, ms: Date.now() - t0 });
      // The new render process after a crash has no throttling (old CDP session is disconnected, no longer sending)
      const t1 = Date.now();
      await reloadAfterCrash(page);
      say('S17 reload', { ms: Date.now() - t1, sinceMeasure: Date.now() - t0 });
      const g = await waitDone(page);
      const key = measuring.step.key;
      check('S17', g?.judged?.crashed && g.judged.step?.kind === 'measure' && g.log.device.heavyCards.includes(key), 'this card is recorded as a card that crashed when measured', { judged: g?.judged, device: g?.log?.device, history: g?.log?.history });
      check('S17', g?.decision?.reason === 'trial', 'not counted as a stage crash: the stage is tried as usual', g?.decision);
      await sleep(8000);
      const after = await page.evaluate((k) => ({ probed: window.__pcPreviewDiag().probeRun, heavy: window.__pcGates().log.device.heavyCards.includes(k) }), key);
      const probedAgain = JSON.stringify(after.probed ?? '').includes(key);
      check('S17', !probedAgain, 'it is not measured again', after.probed);
      const heavy = await page.evaluate(() => [...(window.__pcPlanDebug?.()?.prerenderSet ?? [])]).catch(() => null);
      scenes.S17.heavyPlan = heavy;
    }
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S18 Kill when loading original size */
  if (want('S18')) {
    const page = await newPage('desktop');
    await enter(page);
    let g = await until(async () => { const x = await gates(page); return x?.step?.kind === 'media' ? x : null; }, 60_000, 50);
    check('S18', !!g, 'a record was left before loading the original size ("Load media original size")', await gates(page));
    const before = g?.media?.decode;
    await crashPage(page);
    await reloadAfterCrash(page);
    g = await waitDone(page);
    const decode = await until(async () => (await gates(page))?.media?.decode, 30_000);
    check('S18', g?.judged?.step?.kind === 'media' && g.log.device.media.lowered === 1, 'judged as crashed at loading the original size, the decode limit is lowered by one step', g?.log?.device);
    check('S18', decode && before && decode.index === Math.min(4, before.measured + 1), 'the effective limit is one step lower', { before, decode });
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S19 Simulate decoding limit of weak devices */
  if (want('S19')) {
    const page = await newPage('desktop');
    await page.evaluateOnNewDocument(() => {
      if (window.top !== window) return;
      const mc = navigator.mediaCapabilities;
      if (!mc) return;
      mc.decodingInfo = async (cfg) => ({ supported: true, smooth: (cfg?.video?.width ?? 0) <= 1280, powerEfficient: true });
    });
    await enter(page);
    const decode = await until(async () => (await gates(page))?.media?.decode, 30_000);
    check('S19', decode?.name === '720p' && decode.maxPixels === 1280 * 720, 'decode limit 720p', decode);
    const sig = await page.evaluate(() => window.__pcGates().step);
    scenes.S19.step = sig;
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S20 Binary search only tests a few when records exist */
  if (want('S20')) {
    // First tested by a single-stage page and written to document service (when bounds search has no records,
    // test one by one; write all after testing)
    const a = await newPage('desktop');
    await enter(a);
    await reload(a, 'tier=lite');
    await waitDone(a);
    const searched = await until(() => a.evaluate(() => { const x = window.__pcCostSearch?.(); return x?.outcome ? x : null; }), 120_000, 500);
    check('S20', !!searched && searched.outcome.measured.some((m) => !m.cached), 'single stage: cards without a record are measured one by one', searched?.outcome);
    await sleep(3000);
    await a.browserContext().close();
    // Then open a new context (another device) with two stages: records read → bounds search only tests
    // a few in the background stage; resident probe then runs catch-up tests in the background
    const b = await newPage('desktop');
    await enter(b);
    await waitDone(b);
    const ds = await until(() => b.evaluate(() => window.__pcDualSearch?.() ?? null), 120_000, 500);
    check('S20', !!ds && ds.records >= 1 && ds.measurements <= ds.keys.length + 4, 'two stages, with records: bounds search draws the line (only a few cards measured)', ds);
    const settled = await until(() => b.evaluate(() => { const d = window.__pcPreviewDiag?.(); return d && d.probeRun && !d.probeRun.running && d.probeRun.done >= 1 ? d.probeRun : null; }), 120_000, 500);
    check('S20', !!settled, 'the resident probe then finishes the remaining measurements in the background', settled);
    scenes.S20.dual = ds;
    await b.browserContext().close();
  }

} catch (e) {
  fails.push(`Exception: ${String(e?.stack ?? e).slice(0, 800)}`);
} finally {
  await browser.close().catch(() => {});
  await env.close().catch(() => {});
}

const result = { ok: fails.length === 0, fails, scenes, out: OUT };
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(fails.length ? 1 : 0);

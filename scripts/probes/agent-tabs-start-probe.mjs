/**
 * AI panel Agent tabs separated by project + probe for start page when there are no sessions
 * (user decision, 2026-10-22: A09 all sessions can be closed, start page shown when there are
 * no sessions; A10 tab manifests separated by project).
 * Real Chrome (puppeteer), editor `?editor&aimock=1&nosetup=1`: AI panel uses page built-in mock
 * stream, does not call real models, consumes no quota, and requires no model backend.
 *
 * Usage:
 *   node scripts/probes/agent-tabs-start-probe.mjs [--port 5980] [--out out/agent-tabs-start-probe] [--origin http://127.0.0.1:N] [--keep]
 *
 * Defaults to starting an editor (`vite --port <port> --strictPort`, stages occupy +1, +2;
 * PROMPTCUT_NO_PORT_FILE=1; session / work / data / AI config directories all point to temp directories),
 * terminating its spawned process tree upon completion. `--origin` uses an existing external
 * editor (starts no processes).
 *
 * Acceptance check (one JSON line per item, last line { summary }, exit code 1 on failure):
 *   S1 New project comes in: right vertical rail has only "Start" (draft), AI panel shows start
 *      page with guidance animation (light spot, arrow, pulsating input box stroke);
 *      no Agent tabs, storage has no manifest for this project, no chat requests sent.
 *   S2 Click preset "Make an animation telling me what I can do with this software": that sentence
 *      appears in edit box, send button starts flashing (composer.is-guide-send); no session created yet.
 *   S3 Click send: only now does Agent 1 tab appear (internal id is "ProjectID_AgentID"),
 *      start page is replaced with chat containing that user message; "Start" is gone from vertical rail.
 *   S4 Project A opens Agent 2; switch to new project B: vertical rail is B's own (start page with
 *      guidance animation), A's two tabs are not seen; B clicks send to get B's Agent 1;
 *      switch back to A: Agent 1 and Agent 2 are still there.
 *   S5 Close all tabs of A (last x is clickable, no longer prompting "Keep at least one"): returns
 *      to start page without guidance animation (only presets and edit box), clicking preset still
 *      puts that sentence into edit box; all-closed is recorded per project: B still has guidance animation.
 *   S6 Refresh page and load A's project object back: A is still the "all closed" start page
 *      (without animation); load B back: Agent 1 is still there.
 *   S7 prefers-reduced-motion: guidance animation is completely disabled (light spot, arrow,
 *      stroke all have no animation).
 *   (For start page and mobile app Agent tab in online build, see agent-tabs-start-mobile-probe.mjs.)
 * Screenshots written to --out: s1-start-animated.png, s2-after-preset.png, s3-after-send.png,
 *   s4-rail-a.png, s4-rail-b.png, s4-rail-a-again.png, s5-cleared.png, s5-cleared-after-preset.png,
 *   s6-reload-cleared.png, s8-mobile-agent.png.
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { flagArg } from './probe-connect.mjs';
import { startDevServer, REPO } from '../lib/dev-server.mjs';

const PORT = Number(flagArg('port', 5980));
if (PORT < 5980 || PORT > 5989) throw new Error(`Port ${PORT} is not in the 5980-5989 range assigned to this probe`);
const OUT = path.resolve(REPO, flagArg('out', 'out/agent-tabs-start-probe'));
const KEEP = process.argv.includes('--keep');
const GIVEN_ORIGIN = flagArg('origin', null);
fs.mkdirSync(OUT, { recursive: true });

const PRESET = 'Make an animation that tells me what I can do with the software';
const results = [];
const check = (name, ok, extra = {}) => {
  const r = { check: name, ok: !!ok, ...extra };
  results.push(r);
  console.log(JSON.stringify(r));
  return !!ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
}

let server = null;
let tmp = null;
let browser = null;
try {
  let origin = GIVEN_ORIGIN;
  if (!origin) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-agent-tabs-start-'));
    server = await startDevServer({
      port: PORT,
      logFile: path.join(tmp, 'vite.log'),
      env: {
        PROMPTCUT_NO_PORT_FILE: '1',
        PROMPTCUT_PUSH: '0',
        PROMPTCUT_CHATS_DIR: path.join(tmp, 'chats'),
        PROMPTCUT_WORK_DIR: path.join(tmp, 'work'),
        PROMPTCUT_DATA_DIR: path.join(tmp, 'data'),
        PROMPTCUT_AI_CONFIG: path.join(tmp, 'ai.json'),
      },
    });
    origin = server.origin;
  }

  browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1440, height: 900 },
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--force-device-scale-factor=1'],
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e)));
  page.on('dialog', (d) => { void d.accept().catch(() => {}); });
  const chatRequests = [];
  page.on('request', (r) => { if (/\/api\/ai\/chat|\/agent\/v1\//.test(r.url())) chatRequests.push(r.url()); });
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${origin}/?editor&aimock=1&nosetup=1`, { waitUntil: 'domcontentloaded' });
  await waitFor(() => page.$('[data-pc="ai-start"]'), 120_000, 'start page');
  await waitFor(() => page.evaluate(() => !!window.__pcStore), 60_000, 'window.__pcStore');
  await sleep(800);

  const projectId = () => page.evaluate(() => window.__pcStore.getState().project.id);
  const railTabs = () => page.evaluate(() => [...document.querySelectorAll('nav[data-pc="right-rail"] [data-pc-agent-tab]')].map((b) => ({
    id: b.getAttribute('data-pc-agent-tab'),
    draft: b.getAttribute('data-pc-agent-draft') === '1',
    label: b.querySelector('.pc-rr-label')?.textContent ?? '',
    on: b.classList.contains('is-on'),
  })));
  const startState = () => page.evaluate(() => {
    const el = document.querySelector('[data-pc="ai-start"]');
    const visible = (n) => !!n && n.getClientRects().length > 0;
    const composer = [...document.querySelectorAll('[data-pc="ai-composer"]')].find(visible) ?? null;
    return {
      start: visible(el),
      animated: el?.getAttribute('data-pc-start-animated') === '1',
      orb: visible(document.querySelector('[data-pc="ai-start-orb"]')),
      cue: visible(document.querySelector('[data-pc="ai-start-cue"]')),
      guide: composer?.getAttribute('data-pc-guide') ?? null,
      text: [...document.querySelectorAll('[data-pc="ai-input"]')].find(visible)?.value ?? null,
    };
  });
  const storedList = (pid) => page.evaluate((pid) => localStorage.getItem(`pc.agentTabs:${pid}`), pid);
  // After loading project, the card measurement overlay ("Measuring cards") covers the entire UI
  // for a few seconds: wait for it to dismiss before taking screenshots
  const shot = async (name, selector = null) => {
    await waitFor(() => page.evaluate(() => !document.body.innerText.includes('Measuring card')), 60_000, 'measurement overlay removed').catch(() => {});
    await sleep(300);
    return selector ? page.$(selector).then((h) => h?.screenshot({ path: path.join(OUT, name) })) : page.screenshot({ path: path.join(OUT, name) });
  };
  const clickVisible = async (sel) => {
    const ok = await page.evaluate((sel) => {
      const el = [...document.querySelectorAll(sel)].find((n) => n.getClientRects().length > 0);
      if (!el) return false;
      el.click();
      return true;
    }, sel);
    if (!ok) throw new Error(`Cannot click ${sel}`);
  };

  /* ── S1 New project comes in: start page with guidance animation ── */
  const pidA = await projectId();
  const s1rail = await railTabs();
  const s1 = await startState();
  check('S1.rail-only-start', s1rail.length === 1 && s1rail[0].draft && s1rail[0].label === 'Start' && s1rail[0].id.startsWith(`${pidA}_`), { s1rail });
  check('S1.start-page-animated', s1.start && s1.animated && s1.orb && s1.cue && s1.guide === 'input', s1);
  check('S1.no-list-stored', (await storedList(pidA)) === null);
  check('S1.no-chat-request', chatRequests.length === 0, { chatRequests });
  await shot('s1-start-animated.png');

  /* ── S2 Click preset ── */
  await clickVisible('[data-pc="ai-start-preset"]');
  await waitFor(async () => (await startState()).text === PRESET, 5000, 'preset goes into the input box');
  const s2 = await startState();
  check('S2.preset-in-input', s2.text === PRESET, s2);
  check('S2.send-button-guided', s2.guide === 'send', s2);
  check('S2.still-no-session', (await railTabs()).every((t) => t.draft) && (await storedList(pidA)) === null && chatRequests.length === 0);
  await shot('s2-after-preset.png');

  /* ── S3 Click send: Agent 1 is created only now ── */
  await clickVisible('[data-pc="ai-send"]');
  await waitFor(async () => (await railTabs()).some((t) => !t.draft), 8000, 'Agent 1 tab');
  const s3rail = await railTabs();
  check('S3.agent1-created', s3rail.length === 1 && !s3rail[0].draft && s3rail[0].label === 'Agent 1' && s3rail[0].id.startsWith(`${pidA}_`), { s3rail });
  await waitFor(() => page.evaluate((txt) => [...document.querySelectorAll('[data-pc-msg]')].some((n) => n.textContent.includes(txt)), PRESET), 8000, 'the user\'s message');
  check('S3.message-sent-in-session', true);
  check('S3.start-page-gone', !(await startState()).start);
  const a1 = s3rail[0].id;
  const stored3 = JSON.parse((await storedList(pidA)) ?? 'null');
  check('S3.list-stored-per-project', !!stored3 && stored3.tabs.length === 1 && stored3.tabs[0].id === a1 && stored3.cleared === false, stored3);
  // Wait for mock stream to finish, avoiding confirmation prompt when closing the tab
  await waitFor(() => page.evaluate(() => !document.querySelector('[data-pc="ai-stop"]')), 30_000, 'fake stream finished');
  await shot('s3-after-send.png');

  /* ── S4 Project A opens Agent 2; switch to B; B clicks send; switch back to A ── */
  await clickVisible('[data-pc="agent-tab-add"]');
  await waitFor(async () => (await railTabs()).length === 2, 5000, 'Agent 2');
  const s4a = await railTabs();
  check('S4.A-has-two', s4a.map((t) => t.label).join() === 'Agent 1,Agent 2', { s4a });
  await shot('s4-rail-a.png', 'nav[data-pc="right-rail"]');
  await shot('s4-page-a.png');
  const projA = await page.evaluate(() => JSON.parse(JSON.stringify(window.__pcStore.getState().project)));
  await page.evaluate(() => window.__pcStore.actions.newProject('Project B'));
  await waitFor(async () => (await railTabs()).some((t) => t.draft), 8000, 'B\'s start page');
  const pidB = await projectId();
  const s4b = await railTabs();
  const s4bStart = await startState();
  check('S4.B-own-list', pidB !== pidA && s4b.length === 1 && s4b[0].draft && s4b[0].id.startsWith(`${pidB}_`), { s4b });
  check('S4.B-start-animated', s4bStart.start && s4bStart.animated && s4bStart.orb, s4bStart);
  await shot('s4-rail-b.png', 'nav[data-pc="right-rail"]');
  await shot('s4-page-b.png');
  await clickVisible('[data-pc="ai-start-preset"]');
  await clickVisible('[data-pc="ai-send"]');
  await waitFor(async () => (await railTabs()).some((t) => !t.draft), 8000, 'B\'s Agent 1');
  const s4b2 = await railTabs();
  check('S4.B-agent1', s4b2.length === 1 && s4b2[0].label === 'Agent 1' && s4b2[0].id.startsWith(`${pidB}_`) && s4b2[0].id !== a1, { s4b2 });
  const projB = await page.evaluate(() => JSON.parse(JSON.stringify(window.__pcStore.getState().project)));
  await waitFor(() => page.evaluate(() => !document.querySelector('[data-pc="ai-stop"]')), 30_000, 'B fake stream finished');
  await page.evaluate((p) => window.__pcStore.actions.loadProject(p), projA);
  await waitFor(async () => (await railTabs()).length === 2, 8000, 'switch back to A');
  const s4a2 = await railTabs();
  check('S4.A-back', s4a2.map((t) => t.label).join() === 'Agent 1,Agent 2' && s4a2.every((t) => t.id.startsWith(`${pidA}_`)), { s4a2 });
  await shot('s4-rail-a-again.png', 'nav[data-pc="right-rail"]');

  /* ── S5 Close all tabs of A ── */
  const lastCloseDisabled = [];
  for (let i = 0; i < 2; i++) {
    const info = await page.evaluate(() => {
      const xs = [...document.querySelectorAll('nav[data-pc="right-rail"] .pc-rr-x')];
      const x = xs[xs.length - 1];
      return x ? { disabled: x.disabled, title: x.title, n: xs.length } : null;
    });
    lastCloseDisabled.push(info);
    await page.evaluate(() => {
      const xs = [...document.querySelectorAll('nav[data-pc="right-rail"] .pc-rr-x')];
      xs[xs.length - 1]?.click();
    });
    await sleep(400);
  }
  check('S5.last-close-enabled', lastCloseDisabled[1]?.n === 1 && lastCloseDisabled[1]?.disabled === false && !/keep at least/.test(lastCloseDisabled[1]?.title ?? ''), { lastCloseDisabled });
  await waitFor(async () => (await railTabs()).every((t) => t.draft), 8000, 'back to the start page');
  const s5 = await startState();
  const s5rail = await railTabs();
  check('S5.back-to-start-no-animation', s5rail.length === 1 && s5rail[0].draft && s5.start && !s5.animated && !s5.orb && !s5.cue && s5.guide === null, { s5, s5rail });
  const stored5 = JSON.parse((await storedList(pidA)) ?? 'null');
  check('S5.cleared-remembered-for-A', !!stored5 && stored5.tabs.length === 0 && stored5.cleared === true, stored5);
  await shot('s5-cleared.png');
  await clickVisible('[data-pc="ai-start-preset"]');
  await waitFor(async () => (await startState()).text === PRESET, 5000, 'preset goes into the input box after the glow is turned off');
  const s5b = await startState();
  check('S5.preset-works-when-cleared', s5b.text === PRESET && s5b.guide === 'send' && !s5b.animated, s5b);
  await shot('s5-cleared-after-preset.png');
  // "All-closed" is recorded per project: B still has guidance animation (switch over to verify before
  // B's Agent 1 is closed: B still has sessions, so only verify storage did not record all-closed for B)
  const storedB = JSON.parse((await storedList(pidB)) ?? 'null');
  check('S5.cleared-is-per-project', !!storedB && storedB.cleared === false && storedB.tabs.length === 1, storedB);

  /* ── S6 Load project back after refresh ── */
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(() => page.evaluate(() => !!window.__pcStore), 120_000, 'store after refresh');
  await sleep(1500);
  await page.evaluate((p) => window.__pcStore.actions.loadProject(p), projA);
  await waitFor(async () => (await railTabs()).some((t) => t.id.startsWith(`${pidA}_`)), 10_000, 'A loaded after refresh');
  await waitFor(() => page.$('[data-pc="ai-start"]'), 10_000, 'A\'s start page');
  const s6 = await startState();
  check('S6.A-still-cleared-after-reload', s6.start && !s6.animated && !s6.orb, s6);
  await shot('s6-reload-cleared.png');
  await page.evaluate((p) => window.__pcStore.actions.loadProject(p), projB);
  await waitFor(async () => (await railTabs()).some((t) => !t.draft && t.id.startsWith(`${pidB}_`)), 10_000, 'B loaded after refresh');
  const s6b = await railTabs();
  check('S6.B-agent1-restored-after-reload', s6b.length === 1 && s6b[0].label === 'Agent 1', { s6b });

  /* ── S7 Reduced motion: guidance animations all disabled ── */
  await page.evaluate(() => window.__pcStore.actions.newProject('Project C'));
  await waitFor(async () => (await startState()).animated, 8000, 'C\'s start page');
  const anim = () => page.evaluate(() => {
    const name = (sel) => { const n = document.querySelector(sel); return n ? getComputedStyle(n).animationName : null; };
    const composer = [...document.querySelectorAll('[data-pc="ai-composer"]')].find((n) => n.getClientRects().length > 0);
    return { core: name('.pc-start-orb-core'), ring: name('.pc-start-orb-ring'), cue: name('.pc-start-cue'), composer: composer ? getComputedStyle(composer).animationName : null };
  });
  const motionOn = await anim();
  check('S7.animation-runs-normally', Object.values(motionOn).every((v) => v && v !== 'none'), motionOn);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await sleep(300);
  const motionOff = await anim();
  check('S7.reduced-motion-stops-all', Object.values(motionOff).every((v) => v === 'none'), motionOff);

  check('page-errors', pageErrors.length === 0, { pageErrors: pageErrors.slice(0, 5) });
} catch (e) {
  check('probe-ran', false, { error: String(e?.stack ?? e).slice(0, 800) });
} finally {
  try { await browser?.close(); } catch {}
  try { server?.stop(); } catch {}
  if (tmp && !KEEP) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
}
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ summary: { ok: failed.length === 0, passes: results.length - failed.length, fails: failed.map((r) => r.check), shots: OUT } }));
process.exit(failed.length ? 1 : 0);

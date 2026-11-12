// First import protects user directories and the shared port file before any fixture import.
import '../lib/no-user-dirs.mjs';
/**
 * Acceptance probe for Vibe mode "Detail editing" preview zoom & pan bounds + top-right Fit control (issue #15).
 *
 * Usage:
 *   node scripts/probes/vibe-preview-zoom-probe.mjs [--port 5220] [--origin http://127.0.0.1:5220] [--out <dir>] [--keep]
 *
 * Dedicated port range: 5220-5229 (dev server uses PORT, PORT+1, PORT+2; never touches 5190-5192).
 *
 * Acceptance checks:
 *   Z0 Side-panel mini preview (`[data-pc="start-ext-stage"]`) does not show the editor zoom badge.
 *   Z1 Initial DetailEdit state: `[data-pc="preview-zoom"]` sits in the top-right corner of
 *      `[data-pc="start-detail-stage"]`, displays `100%`, `Fit` button is disabled, and `.pc-pv-frame`
 *      matches all four edges of the stage frame within <= 1px.
 *   Z2 Wheel zoom-out at `100%` keeps zoom at `100%` (>= 100%) and keeps all four edges fitted.
 *   Z3 Wheel zoom-in increases percentage above `100%` (120%, 173%), enables `Fit`, pins the cursor anchor,
 *      and keeps all four edges covering the stage frame.
 *   Z4 Aggressive left-drag and middle-drag panning toward all four directions (+x, -x, +y, -y), off-center
 *      zoom-in/out, and resizing the timeline seam keep all four edges of `.pc-pv-frame` covering the stage.
 *   Z5 Clicking `[data-pc="preview-zoom-fit"]` restores `100%`, disables `Fit`, and restores exact fitted bounds.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { flagArg } from './probe-connect.mjs';
import { startDevServer } from '../lib/dev-server.mjs';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 8 * 60_000).unref();

const PORT = Number(flagArg('port', 5220));
const GIVEN_ORIGIN = flagArg('origin', null);
if (!GIVEN_ORIGIN && (!Number.isInteger(PORT) || PORT < 5220 || PORT > 5227)) {
  throw new Error(`--port ${PORT} is outside the 5220-5227 range (PORT..PORT+2 must stay within 5220-5229 and never touch 5190-5192)`);
}
const KEEP = process.argv.includes('--keep');
const OUT = path.resolve(flagArg('out', path.join(os.tmpdir(), 'vibe-preview-zoom-shots')));
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const out = { ok: false, port: PORT, out: OUT };
const check = (cond, label, extra) => {
  if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 450)));
  return !!cond;
};
const near = (a, b, tol = 1.25) => Math.abs(a - b) <= tol;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
let tmp = null;
let browser = null;

try {
  let origin = GIVEN_ORIGIN;
  if (!origin) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-vibe-zoom-probe-'));
    server = await startDevServer({
      port: PORT,
      logFile: path.join(tmp, 'vite.log'),
      env: {
        PROMPTCUT_NO_PORT_FILE: '1',
        PROMPTCUT_PUSH: '0',
        PROMPTCUT_PROJECTS_DIR: path.join(tmp, 'projects'),
        PROMPTCUT_CHATS_DIR: path.join(tmp, 'chats'),
        PROMPTCUT_WORK_DIR: path.join(tmp, 'work'),
        PROMPTCUT_DATA_DIR: path.join(tmp, 'data'),
        PROMPTCUT_AI_CONFIG: path.join(tmp, 'ai.json'),
      },
    });
    origin = server.origin;
  }
  out.origin = origin;

  browser = await puppeteer.launch({
    headless: 'new',
    args: [...PROBE_CHROME_ARGS, '--window-size=1440,960', '--no-first-run'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 960 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e?.message ?? e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

  const sel = (pc) => `[data-pc="${pc}"]`;
  const clickPc = async (pc) => {
    await page.waitForSelector(sel(pc), { timeout: 60_000 });
    await page.click(sel(pc));
  };

  /** Read live geometry of stage, video frame, and top-right zoom bar */
  const readState = () => page.evaluate(() => {
    const rectOf = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
    };
    const stageEl = document.querySelector('[data-pc="start-detail-stage"]');
    const frameEl = stageEl?.querySelector('.pc-pv-frame') ?? null;
    const barEl = stageEl?.querySelector('[data-pc="preview-zoom"]') ?? null;
    const pctEl = stageEl?.querySelector('[data-pc="preview-zoom-pct"]') ?? null;
    const fitEl = stageEl?.querySelector('[data-pc="preview-zoom-fit"]') ?? null;
    const pctText = pctEl?.textContent?.trim() ?? null;
    const pctNum = pctText && pctText.endsWith('%') ? Number(pctText.slice(0, -1)) : NaN;
    return {
      stage: rectOf(stageEl),
      frame: rectOf(frameEl),
      bar: rectOf(barEl),
      pctText,
      pctNum,
      fitLabel: fitEl?.textContent?.trim() ?? null,
      fitDisabled: fitEl instanceof HTMLButtonElement ? fitEl.disabled : null,
      zoomedAttr: stageEl?.querySelector('[data-pc="preview-2d"]')?.getAttribute('data-zoomed') ?? null,
    };
  });

  const coversStage = (st, tol = 1.25) =>
    !!st.stage && !!st.frame &&
    st.frame.left <= st.stage.left + tol &&
    st.frame.right >= st.stage.right - tol &&
    st.frame.top <= st.stage.top + tol &&
    st.frame.bottom >= st.stage.bottom - tol;

  const matchesStage = (st, tol = 1.25) =>
    !!st.stage && !!st.frame &&
    near(st.frame.left, st.stage.left, tol) &&
    near(st.frame.right, st.stage.right, tol) &&
    near(st.frame.top, st.stage.top, tol) &&
    near(st.frame.bottom, st.stage.bottom, tol);

  /* -- Navigate to Vibe mode, create local project -- */
  await page.goto(`${origin}/?ui=vibe&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await clickPc('start-side-new');
  await page.waitForSelector(sel('new-project-local-confirm'), { timeout: 15_000 });
  await clickPc('new-project-local-confirm');
  await page.waitForSelector(sel('start-ext-detail'), { timeout: 60_000 });
  await sleep(900);

  /* Z0 Side-panel thumbnail stage does not render the DetailEdit zoom pill */
  const extHasZoom = await page.evaluate(() => !!document.querySelector('[data-pc="start-ext-stage"] [data-pc="preview-zoom"]'));
  out.Z0 = { extHasZoom };
  check(!extHasZoom, 'Z0 side-panel thumbnail stage should not mount preview-zoom', out.Z0);

  /* -- Enter Vibe mode editor ("Detail editing") -- */
  await clickPc('start-ext-detail');
  await page.waitForSelector(sel('start-detail-stage'), { timeout: 60_000 });
  await page.waitForSelector(sel('preview-zoom'), { timeout: 30_000 });
  await sleep(400); // Allow the 220ms ps-detail-in entrance animation to settle completely

  /* Z1 Initial 100% fitted view + top-right control placement */
  const s0 = await readState();
  await page.screenshot({ path: path.join(OUT, 'zoom-100-initial.png') });
  const inTopRight = !!s0.stage && !!s0.bar &&
    s0.stage.right - s0.bar.right >= 2 && s0.stage.right - s0.bar.right <= 20 &&
    s0.bar.top - s0.stage.top >= 2 && s0.bar.top - s0.stage.top <= 20 &&
    s0.bar.left > s0.stage.left + s0.stage.width * 0.5 &&
    s0.bar.bottom < s0.stage.top + s0.stage.height * 0.35;
  out.Z1 = { pctText: s0.pctText, fitLabel: s0.fitLabel, fitDisabled: s0.fitDisabled, inTopRight, stage: s0.stage, frame: s0.frame, bar: s0.bar };
  check(s0.pctText === '100%', 'Z1 initial zoom percentage is not 100%', out.Z1);
  check(!!s0.fitLabel && s0.fitLabel.length > 0, 'Z1 Fit button label is empty', out.Z1);
  check(s0.fitDisabled === true, 'Z1 Fit button should be disabled when already fitted at 100%', out.Z1);
  check(inTopRight, 'Z1 zoom control is not positioned in the top-right corner of the preview', out.Z1);
  check(matchesStage(s0), 'Z1 initial video frame does not match all four edges of the preview stage', out.Z1);

  /* Z2 Wheel zoom-out at 100% stays >= 100% and fitted */
  const cx = s0.stage.left + s0.stage.width * 0.5;
  const cy = s0.stage.top + s0.stage.height * 0.5;
  await page.mouse.move(cx, cy);
  await page.mouse.wheel({ deltaY: 360 });
  await page.mouse.move(s0.stage.left + 24, s0.stage.top + 24);
  await page.mouse.wheel({ deltaY: 600 });
  await sleep(120);
  const sOut = await readState();
  out.Z2 = { pctText: sOut.pctText, pctNum: sOut.pctNum, fitDisabled: sOut.fitDisabled, matches: matchesStage(sOut) };
  check(sOut.pctText === '100%' && sOut.pctNum >= 100, 'Z2 wheel zoom-out dropped below 100%', out.Z2);
  check(sOut.fitDisabled === true, 'Z2 zooming out at 100% unexpectedly turned off auto-fit', out.Z2);
  check(matchesStage(sOut), 'Z2 wheel zoom-out shrunk or shifted the video frame away from the preview bounds', out.Z2);

  /* Z3 Wheel zoom-in increases percentage > 100% and anchors at cursor */
  const anchorX = s0.stage.left + s0.stage.width * 0.28;
  const anchorY = s0.stage.top + s0.stage.height * 0.34;
  const uBefore = (anchorX - s0.frame.left) / s0.frame.width;
  const vBefore = (anchorY - s0.frame.top) / s0.frame.height;
  await page.mouse.move(anchorX, anchorY);
  await page.mouse.wheel({ deltaY: -120 });
  await sleep(80);
  const sIn1 = await readState();
  await page.mouse.wheel({ deltaY: -240 }); // 1.2 * 1.2^2 = 1.728 -> 173%
  await sleep(100);
  const sIn3 = await readState();
  const uAfter = (anchorX - sIn3.frame.left) / sIn3.frame.width;
  const vAfter = (anchorY - sIn3.frame.top) / sIn3.frame.height;
  out.Z3 = {
    step1Pct: sIn1.pctText,
    step3Pct: sIn3.pctText,
    fitDisabled: sIn3.fitDisabled,
    zoomedAttr: sIn3.zoomedAttr,
    anchorDrift: { du: Math.abs(uAfter - uBefore), dv: Math.abs(vAfter - vBefore) },
    covers: coversStage(sIn3),
  };
  check(sIn1.pctNum === 120, 'Z3 one wheel-up notch did not zoom to 120%', out.Z3);
  check(sIn3.pctNum === 173 && sIn3.pctNum > 100, 'Z3 three wheel-up notches did not zoom to 173%', out.Z3);
  check(sIn3.fitDisabled === false, 'Z3 Fit button did not enable after zooming in', out.Z3);
  check(sIn3.zoomedAttr === 'true', 'Z3 data-zoomed attribute was not set when zoomed > 100%', out.Z3);
  check(Math.abs(uAfter - uBefore) < 0.005 && Math.abs(vAfter - vBefore) < 0.005, 'Z3 cursor anchor drifted during wheel zoom-in', out.Z3);
  check(coversStage(sIn3), 'Z3 zoomed-in frame does not cover all four edges of the stage', out.Z3);

  /* Z4 Aggressive panning (left-drag & middle-drag), off-center zoom, and stage resize keep all 4 edges covering frame */
  const dragPan = async (dx, dy, button = 'left') => {
    const st = await readState();
    const sx = st.stage.left + st.stage.width * 0.5;
    const sy = st.stage.top + st.stage.height * 0.5;
    await page.mouse.move(sx, sy);
    await page.mouse.down({ button });
    await page.mouse.move(sx + dx, sy + dy, { steps: 10 });
    await page.mouse.up({ button });
    await sleep(60);
    return readState();
  };

  const panLeftEdge = await dragPan(1200, 900, 'left');     // Pull right+down -> left & top edges clamp at stage.left / stage.top
  const panRightEdge = await dragPan(-2400, -1800, 'left'); // Pull left+up -> right & bottom edges clamp at stage.right / stage.bottom
  const panMidA = await dragPan(1800, -1400, 'middle');     // Middle-button fling -> left & bottom clamp
  const panMidB = await dragPan(-1800, 1400, 'middle');     // Middle-button opposite fling -> right & top clamp
  await page.screenshot({ path: path.join(OUT, 'zoom-in-panned.png') });

  check(coversStage(panLeftEdge), 'Z4 left-drag (+x,+y) let video edge pull inside stage', panLeftEdge);
  check(near(panLeftEdge.frame.left, panLeftEdge.stage.left, 1.5) && near(panLeftEdge.frame.top, panLeftEdge.stage.top, 1.5),
    'Z4 left-drag (+x,+y) did not reach top-left video boundary cleanly', panLeftEdge);
  check(coversStage(panRightEdge), 'Z4 left-drag (-x,-y) let video edge pull inside stage', panRightEdge);
  check(near(panRightEdge.frame.right, panRightEdge.stage.right, 1.5) && near(panRightEdge.frame.bottom, panRightEdge.stage.bottom, 1.5),
    'Z4 left-drag (-x,-y) did not reach bottom-right video boundary cleanly', panRightEdge);
  check(coversStage(panMidA), 'Z4 middle-drag (+x,-y) let video edge pull inside stage', panMidA);
  check(coversStage(panMidB), 'Z4 middle-drag (-x,+y) let video edge pull inside stage', panMidB);

  // Off-center partial zoom-out near opposite corner keeps 4-edge coverage
  await page.mouse.move(panMidB.stage.left + 16, panMidB.stage.bottom - 16);
  await page.mouse.wheel({ deltaY: 120 }); // 173% -> 144%
  await sleep(80);
  const sPartialOut = await readState();
  check(sPartialOut.pctNum === 144, 'Z4 partial zoom-out from 173% did not land at 144%', sPartialOut);
  check(coversStage(sPartialOut), 'Z4 off-center zoom-out let video edge pull inside stage', sPartialOut);

  // Resize timeline grip while zoomed in and panned to corner: relative zoom % and 4-edge bounds must hold
  const gripBox = await page.$eval(sel('start-detail-grip'), (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(gripBox.x, gripBox.y);
  await page.mouse.down();
  await page.mouse.move(gripBox.x, gripBox.y - 110, { steps: 10 });
  await page.mouse.up();
  await sleep(150);
  const sResized = await readState();
  check(sResized.pctNum === 144 && sResized.pctNum >= 100, 'Z4 stage resize altered framed zoom percentage', sResized);
  check(coversStage(sResized), 'Z4 stage resize let zoomed video edge pull inside stage', sResized);

  out.Z4 = {
    panLeftOk: coversStage(panLeftEdge),
    panRightOk: coversStage(panRightEdge),
    panMidAOk: coversStage(panMidA),
    panMidBOk: coversStage(panMidB),
    partialOutPct: sPartialOut.pctText,
    resizedPct: sResized.pctText,
    resizedCovers: coversStage(sResized),
  };

  /* Z5 Clicking top-right "Fit" button restores 100% and exact fitted bounds */
  await clickPc('preview-zoom-fit');
  await sleep(120);
  const sFit = await readState();
  await page.screenshot({ path: path.join(OUT, 'zoom-after-fit.png') });
  out.Z5 = { pctText: sFit.pctText, fitDisabled: sFit.fitDisabled, zoomedAttr: sFit.zoomedAttr, matches: matchesStage(sFit) };
  check(sFit.pctText === '100%', 'Z5 clicking Fit did not restore 100%', out.Z5);
  check(sFit.fitDisabled === true, 'Z5 Fit button did not disable after restoring fitted view', out.Z5);
  check(sFit.zoomedAttr === null, 'Z5 data-zoomed attribute remained set after Fit', out.Z5);
  check(matchesStage(sFit), 'Z5 clicking Fit did not restore exact four-edge fitted bounds', out.Z5);

  out.errors = errors;
  check(errors.length === 0, 'Page logged uncaught or console errors', errors.slice(0, 5));
} catch (e) {
  fails.push(`Probe crashed: ${String(e?.stack ?? e).slice(0, 400)}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server && !KEEP) server.stop();
  if (tmp && !KEEP) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

out.fails = fails;
out.ok = fails.length === 0;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);

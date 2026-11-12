// First import protects user directories and the shared port file before any fixture import.
import '../lib/no-user-dirs.mjs';
/**
 * Acceptance probe for the draggable seam between stage and timeline in Vibe mode "Detail editing"
 * (issue #40, user raised 2026-10-26).
 *
 * Runs against the **real page**: the local desktop app route (`/?ui=vibe` → create local project →
 * chat page → side panel "Video" → "Detail editing"), real stage iframe, real timeline, without
 * connecting to cloud or account. Dev server is started beforehand by the caller; probe only connects to it:
 *
 *   PROMPTCUT_NO_PORT_FILE=1 PROMPTCUT_PROJECTS_DIR=<temp-dir> npx vite --port 5203 --strictPort --host 127.0.0.1
 *   node scripts/probes/vibe-detail-grip-probe.mjs [--origin http://127.0.0.1:5203] [--out <screenshot-dir>]
 *
 * The page includes `?nosetup=1`: on first launch without a configured local Agent, the "Configure Agent"
 * modal pops up, covering the entire page so the mouse cannot click the seam.
 *
 * Dev server additionally occupies "port + 1" and "port + 2" as stage ports (`guide_files/verification.md`
 * "Verification environment"). Provide a temporary directory for `PROMPTCUT_PROJECTS_DIR`: probe creates
 * an empty project inside; if unset, it falls back to `.pc-projects/` in the repository.
 *
 * Acceptance check (each item as one line in `fails` of the final JSON line):
 *   G1 Seam sits between transport controls and timeline: `[data-pc="start-detail-grip"]` exists,
 *      `role=separator`, `aria-orientation=horizontal`, tabbable (tabindex=0); its bottom edge
 *      aligns with top edge of timeline, and top edge sits below that row of transport controls.
 *   G2 No line drawn normally, highlights when hovered: line has `opacity: 0` at rest and `opacity: 1` on hover.
 *   G3 Draggable: drag up 120px, timeline height +120 (±3), stage above shortens accordingly, and
 *      page does not overflow vertically.
 *   G4 Stored locally: after release, `pc.start.detailTlH` equals the dragged height; collapsing and
 *      reopening detail editing retains this height.
 *   G5 Double-click reset: double-click the seam to return to default CSS height before dragging;
 *      the local entry is removed.
 *   G6 Keyboard adjustable: focus the seam, press ArrowUp 4 times for +32, Shift+ArrowDown once
 *      for -32 (up increases height, matching drag direction).
 *   G7 Drag bounds enforced: drag up 2000px reaches at most 70% of the page (stage still has room
 *      left); drag down 2000px no lower than 160px.
 * Screenshots: `grip-default.png`, `grip-hover.png`, `grip-tall.png`, `grip-short.png`.
 * Last line is a single JSON line: { ok, fails, ... }. Exit code 0 passes, 1 fails.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 10 * 60_000).unref();

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ORIGIN = arg('--origin', 'http://127.0.0.1:5203');
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'vibe-detail-grip-shots')));
fs.mkdirSync(OUT, { recursive: true });

/** 70% of page height is the grip upper bound (`TL_MAX_RATIO` in `DetailEdit.tsx`), minimum 160 (`TL_MIN_H`) */
const MAX_RATIO = 0.7;
const MIN_H = 160;
const KEY = 'pc.start.detailTlH';

const fails = [];
const out = { ok: false, out: OUT, origin: ORIGIN };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: 'new', args: [...PROBE_CHROME_ARGS, '--window-size=1440,980'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 980 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

const sel = (pc) => `[data-pc="${pc}"]`;
const click = async (pc) => { await page.waitForSelector(sel(pc), { timeout: 60_000 }); await page.click(sel(pc)); };

/** Geometry of the detail editing page: timeline, stage, seam, and full page */
const geo = () => page.evaluate(() => {
  const r = (pc) => { const el = document.querySelector(`[data-pc="${pc}"]`); if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) }; };
  const transport = (() => { const el = document.querySelector('.ps-detail-transport'); if (!el) return null; const b = el.getBoundingClientRect(); return { bottom: Math.round(b.bottom) }; })();
  return {
    tl: r('start-detail-tl'), stage: r('start-detail-stage'), grip: r('start-detail-grip'), root: r('start-detail'), transport,
    saved: (() => { try { return localStorage.getItem('pc.start.detailTlH'); } catch { return null; } })(),
    overflowY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
  };
});

const gripCenter = async () => {
  const b = await page.$eval(sel('start-detail-grip'), (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  return b;
};
/** Press down on the seam and drag dy pixels up (dy<0) or down */
const drag = async (dy) => {
  const { x, y } = await gripCenter();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy, { steps: 14 });
  await page.mouse.up();
  await sleep(150);
};

try {
  /* -- Real page: create a local project, enter chat page -- */
  await page.goto(`${ORIGIN}/?ui=vibe&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await click('start-side-new');
  await page.waitForSelector(sel('new-project-local-confirm'), { timeout: 15_000 });
  await click('new-project-local-confirm');
  await page.waitForSelector(sel('start-ext-detail'), { timeout: 60_000 });
  await sleep(1200);

  /* -- Enter detail editing -- */
  await click('start-ext-detail');
  await page.waitForSelector(sel('start-detail-tl'), { timeout: 60_000 });
  await sleep(600);
  const g0 = await geo();
  await page.screenshot({ path: path.join(OUT, 'grip-default.png') });

  /* G1 Seam sits between transport controls and timeline */
  const a11y = await page.$eval(sel('start-detail-grip'), (el) => ({
    role: el.getAttribute('role'), orient: el.getAttribute('aria-orientation'),
    tabindex: el.getAttribute('tabindex'), title: el.getAttribute('title'), h: Math.round(el.getBoundingClientRect().height),
  }));
  out.G1 = { ...a11y, gripBottom: g0.grip?.bottom, tlTop: g0.tl?.top, transportBottom: g0.transport?.bottom, defaultH: g0.tl?.h };
  check(!!g0.grip, 'G1 the grip is missing');
  check(a11y.role === 'separator' && a11y.orient === 'horizontal', 'G1 role / aria-orientation is wrong', a11y);
  check(a11y.tabindex === '0', 'G1 Tab cannot reach the grip', a11y);
  check(g0.grip && g0.tl && near(g0.grip.bottom, g0.tl.top, 1), 'G1 the grip\'s bottom edge is not flush with the timeline\'s top edge', out.G1);
  check(g0.grip && g0.transport && g0.grip.top >= g0.transport.bottom - 1, 'G1 the grip is not below the transport controls', out.G1);

  /* G2 No line drawn normally, highlights when hovered */
  const lineOpacity = () => page.$eval(sel('start-detail-grip'), (el) => getComputedStyle(el, '::after').opacity);
  const idleOpacity = await lineOpacity();
  const c = await gripCenter();
  await page.mouse.move(c.x, c.y);
  await sleep(250);
  const hoverOpacity = await lineOpacity();
  await page.screenshot({ path: path.join(OUT, 'grip-hover.png') });
  out.G2 = { idle: idleOpacity, hover: hoverOpacity };
  check(Number(idleOpacity) === 0, 'G2 the line is already lit when not dragging', out.G2);
  check(Number(hoverOpacity) === 1, 'G2 the line does not light up when the mouse is over it', out.G2);

  /* G3 Draggable */
  await drag(-120);
  const g1 = await geo();
  out.G3 = { before: { tl: g0.tl?.h, stage: g0.stage?.h }, after: { tl: g1.tl?.h, stage: g1.stage?.h }, overflowY: g1.overflowY };
  check(near(g1.tl.h, g0.tl.h + 120, 3), 'G3 dragging up 120px did not make the timeline 120 taller', out.G3);
  check(g1.stage.h < g0.stage.h, 'G3 the timeline got taller, but the stage above did not get shorter accordingly', out.G3);
  check(g1.overflowY === 0, 'G3 the page overflows vertically after the drag', out.G3);
  await page.screenshot({ path: path.join(OUT, 'grip-tall.png') });

  /* G4 Saved on this machine; still this height after collapsing and reopening */
  const dragged = g1.tl.h;
  check(Number(g1.saved) === dragged, 'G4 the height was not saved locally on release', { saved: g1.saved, dragged });
  await click('start-detail-close');
  await sleep(400);
  await click('start-ext-detail');
  await page.waitForSelector(sel('start-detail-tl'), { timeout: 30_000 });
  await sleep(500);
  const g2 = await geo();
  out.G4 = { saved: g1.saved, dragged, reopened: g2.tl?.h };
  check(near(g2.tl.h, dragged, 2), 'G4 after collapsing and reopening, the timeline did not return to the dragged height', out.G4);

  /* G5 Double-click reset */
  const c2 = await gripCenter();
  // Browsers recognize double-clicks by clickCount: click one by one, the second with clickCount: 2,
  // only then will dblclick fire (`page.mouse.click` twice does not count)
  await page.mouse.move(c2.x, c2.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await sleep(400);
  const g3 = await geo();
  out.G5 = { reset: g3.tl?.h, defaultH: g0.tl?.h, saved: g3.saved };
  check(near(g3.tl.h, g0.tl.h, 2), 'G5 double-click did not return to the default height', out.G5);
  check(g3.saved === null, 'G5 the local entry is still there after the double-click', out.G5);

  /* G6 Keyboard */
  await page.focus(sel('start-detail-grip'));
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowUp');
  await sleep(300);
  const g4 = await geo();
  await page.keyboard.down('Shift');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.up('Shift');
  await sleep(300);
  const g5 = await geo();
  out.G6 = { base: g3.tl?.h, up4: g4.tl?.h, shiftDown1: g5.tl?.h, saved: g5.saved };
  check(near(g4.tl.h, g3.tl.h + 32, 2), 'G6 Arrow Up four times did not add 32', out.G6);
  check(near(g5.tl.h, g4.tl.h - 32, 2), 'G6 Shift + Arrow Down once did not subtract 32', out.G6);
  check(Number(g5.saved) === g5.tl.h, 'G6 the keyboard adjustment was not saved locally', out.G6);

  /* G7 Bounded when dragged to the end */
  await drag(-2000);
  const g6 = await geo();
  await page.screenshot({ path: path.join(OUT, 'grip-tall-max.png') });
  await drag(2000);
  const g7 = await geo();
  await page.screenshot({ path: path.join(OUT, 'grip-short.png') });
  out.G7 = { rootH: g6.root?.h, maxTl: g6.tl?.h, cap: Math.round((g6.root?.h ?? 0) * MAX_RATIO), minTl: g7.tl?.h, stageAtMax: g6.stage?.h };
  check(g6.tl.h <= Math.round(g6.root.h * MAX_RATIO) + 2, 'G7 dragging up went past 70% of this page', out.G7);
  check(g6.stage.h > 0, 'G7 dragging to the limit squeezed the stage away', out.G7);
  check(near(g7.tl.h, MIN_H, 2), 'G7 dragging down did not stop at the minimum height of 160px', out.G7);

  out.errors = errors;
  check(errors.length === 0, ' The page has errors', errors.slice(0, 3));
} catch (e) {
  fails.push(`Run crashed: ${String(e).slice(0, 300)}`);
} finally {
  await browser.close().catch(() => {});
}

out.fails = fails;
out.ok = fails.length === 0;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);

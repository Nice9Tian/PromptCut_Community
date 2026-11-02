/**
 * Probe for non-empty and time-deterministic visuals when particle card is paused.
 *
 *   node scripts/probes/particles-paused-probe.mjs [--origin http://127.0.0.1:5860] [--out <dir>] [--config <URL>]
 *
 * Without `--origin`, check `PC_STAGE_TEST_URL`; if still absent, hit `dev-test` in `.claude/launch.json`.
 *
 * Open editor (`?editor&nosetup=1&preview=stage`), create project, insert a particle card (default
 * parameters; if `--config` is provided, fill into config), stop playhead at T seconds (not
 * playing), wait for the particle canvas in the visible stage iframe to appear, then:
 *   1. Read 2D pixels of canvas, count opaque pixels (alpha > 0): 0 (fully transparent) before
 *      fix, must be > 0 after fix;
 *   2. Jump elsewhere then back to T, read pixel hash again, compare with the first: visuals at the
 *      same timestamp are pixel-identical both times;
 *   3. Take hash at another timestamp T2, different from T: visuals indeed advance with time;
 *   4. Save images to `--out` (default `out/particles-paused/`): raw canvas pixels (`*-canvas.png`,
 *      transparent background) and visible stage iframe screenshot (`*-stage.png`).
 *
 * Output JSON conclusion to stdout; exit with non-zero if any item fails.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { devOrigin, flagArg } from './probe-connect.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const origin = devOrigin(args);
const OUT = path.resolve(flagArg('out', path.join(ROOT, 'out', 'particles-paused'), args));
const CONFIG = flagArg('config', '', args);
const T = 3, T2 = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); return cond; };

async function until(fn, timeoutMs, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(everyMs);
  }
}

await fs.mkdir(OUT, { recursive: true });
const out = { origin, config: CONFIG || null, T, T2 };
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 180000,
  args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1200 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(origin + '/?editor&nosetup=1&preview=stage', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return !!m.frontStage();
  }, { timeout: 120000, polling: 500 });
  const store = (src, ...a) => page.evaluate(async (src, a2) => {
    const { actions, getState } = await import('/src/store/project.ts');
    // eslint-disable-next-line no-new-func
    return new Function('actions', 'getState', 'args', src)(actions, getState, a2);
  }, src, a);

  const clipId = await store(`actions.newProject('particles-paused-' + Date.now());
    const c = actions.addCardClip('particles', 0, { duration: 10, params: args[0] ? { config: args[0] } : {} });
    actions.seek(${T});
    return c?.id;`, CONFIG);
  out.clipId = clipId;
  check(!!clipId, 'particle card added');

  const stageFrames = () => page.frames().filter((f) => /[?&]stage=1/.test(f.url()));
  const frontFrame = async () => {
    const id = await page.evaluate(() => window.__pcPreviewDiag?.().frontId ?? 'A').catch(() => 'A');
    const fs2 = stageFrames();
    return fs2.find((f) => f.url().includes(`id=${id}`)) ?? fs2[0] ?? null;
  };
  /** Pixel stats for particle canvas in visible stage: dimensions, opaque pixel count, sha1 */
  const readCanvas = async () => {
    const f = await frontFrame();
    if (!f) return null;
    return f.evaluate(async () => {
      const cs = [...document.querySelectorAll('canvas')].filter((c) => c.parentElement && c.parentElement.classList.contains('inset-0'));
      const c = cs[0];
      if (!c || !c.width) return null;
      const ctx = c.getContext('2d');
      if (!ctx) return { w: c.width, h: c.height, noCtx: true };
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let ink = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) ink++;
      const buf = await crypto.subtle.digest('SHA-1', d);
      const hash = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
      return { w: c.width, h: c.height, ink, hash, canvases: cs.length };
    });
  };
  const seekAndRead = async (t) => {
    await store(`actions.seek(${t});`);
    // Wait for visuals to stabilize: read the same hash twice consecutively
    let prev = null;
    const got = await until(async () => {
      const r = await readCanvas();
      if (r && prev && r.hash === prev.hash && r.w > 0) return r;
      prev = r;
      return null;
    }, 30000, 400);
    return got ?? prev;
  };

  /**
   * Save images: save raw canvas pixels as a PNG (transparent background), then wait for the
   * editor's "Measuring card" overlay to dismiss before taking a screenshot of the visible stage
   * iframe. The overlay covers the preview during K1 cost measurement (background stage pushes this
   * card frame-by-frame to measure duration); without waiting for it to dismiss, the screenshot
   * captures only the overlay.
   */
  const shoot = async (name) => {
    const f = await frontFrame();
    if (!f) return;
    const url = await f.evaluate(() => document.querySelector('.inset-0 > canvas')?.toDataURL('image/png') ?? null).catch(() => null);
    if (url) await fs.writeFile(path.join(OUT, `${name}-canvas.png`), Buffer.from(url.split(',')[1], 'base64'));
    await until(() => page.evaluate(() => !document.body.innerText.includes('Measuring card')), 90000, 500);
    const el = await f.frameElement();
    if (el) await el.screenshot({ path: path.join(OUT, `${name}-stage.png`) });
  };

  const a = await seekAndRead(T);
  out.first = a;
  await shoot(`t${T}-first`);
  check(!!a && a.w > 0, 'particle canvas is in place', a);
  check(!!a && a.ink > 0, `t=${T}s the particle image is non-empty when paused (opaque pixels > 0)`, a);

  const b = await seekAndRead(T2);
  out.other = b;
  check(!!b && b.ink > 0, `t=${T2}s the particle image is non-empty when paused`, b);
  check(!!a && !!b && a.hash !== b.hash, 'the image differs at different times', { a: a?.hash, b: b?.hash });

  const a2 = await seekAndRead(T);
  out.again = a2;
  await shoot(`t${T}-again`);
  check(!!a && !!a2 && a.hash === a2.hash, `jump away and back to t=${T}s, the two images are pixel-identical`, { a: a?.hash, a2: a2?.hash });
  out.pageErrors = errors.slice(-5);
} finally {
  await browser.close();
}
out.ok = fails.length === 0;
out.fails = fails;
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);

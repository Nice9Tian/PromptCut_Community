/**
 * Issue #13 real-browser WebGL verification probe (`Scene3DView`):
 *   1. Overlapping translucent boards sort back-to-front by camera-space depth, independent of
 *      track order (`trackId`), breaking equal-depth ties by track order.
 *   2. Clip `opacity`, `fadeIn`, `fadeOut`, and nested `@cut` segment envelopes produce the same
 *      opacity progression in 3D view as in 2D (`cardOpacityAt` / 2D stage).
 *   3. Moving a board across / past the camera near plane culls it cleanly without swelling to
 *      fill the frame before or after crossing.
 *
 * Usage:
 *   node scripts/probes/scene3d-opacity-cull-probe.mjs [--port 5240] [--origin http://127.0.0.1:5240] [--out <dir>]
 */
import '../lib/no-user-dirs.mjs';
import { spawn, spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

const PORT = Number(argOf('--port') ?? 5240);
const GIVEN_ORIGIN = argOf('--origin');
const KEEP_OUT = Boolean(argOf('--out'));
const TMP_DIR = path.join(os.tmpdir(), `pc-scene3d-issue13-${Date.now().toString(36)}`);
const OUT_DIR = argOf('--out') ? path.resolve(argOf('--out')) : path.join(TMP_DIR, 'shots');
const EXPORT_DIR = path.join(TMP_DIR, 'export');
const DATA_DIR = path.join(TMP_DIR, 'data');
const ARTIFACT_DIR = path.join(TMP_DIR, 'artifacts');

if (!GIVEN_ORIGIN && ((PORT >= 5190 && PORT <= 5192) || PORT < 1024)) {
  throw new Error(`--port ${PORT} is not allowed (must not touch 5190-5192)`);
}

const passes = [];
const fails = [];
const check = (cond, label, extra) => {
  (cond ? passes : fails).push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fsSync.existsSync(local)) return local;
  const pkgPath = require.resolve('vite/package.json');
  return path.join(path.dirname(pkgPath), 'bin', 'vite.js');
}

function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
}

const GL_CANVAS_SEL = '.pc-3d-checker canvas:not([data-pc-stream-plane])';

/**
 * Wait until Scene3DView has finished any pending foreground texture renders (`.pc-3d-note` absent)
 * and let two rAF ticks settle so the latest texture/material/cull state is drawn to the WebGL canvas.
 */
async function waitSceneReady(page, timeoutMs = 180000) {
  await sleep(200);
  const status = await page.evaluate(
    ({ limitMs, sel }) =>
      new Promise((resolve) => {
        const deadline = Date.now() + limitMs;
        const poll = () => {
          const canvas = document.querySelector(sel);
          const note = document.querySelector('.pc-3d-note');
          const noteText = note?.textContent?.trim() ?? '';
          const noteColor = note instanceof HTMLElement ? note.style.color : '';
          if (noteText && noteColor.includes('danger')) {
            resolve({
              ok: false,
              reason: 'error-banner',
              noteText,
              canvasSize: canvas ? [canvas.width, canvas.height] : null,
            });
            return;
          }
          if (canvas && canvas.width >= 64 && canvas.height >= 64 && !noteText) {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve({ ok: true })));
            return;
          }
          if (Date.now() >= deadline) {
            resolve({
              ok: false,
              reason: 'timeout',
              noteText,
              canvasSize: canvas ? [canvas.width, canvas.height] : null,
            });
            return;
          }
          setTimeout(poll, 200);
        };
        poll();
      }),
    { limitMs: timeoutMs, sel: GL_CANVAS_SEL },
  );
  if (!status.ok) {
    throw new Error(`waitSceneReady failed: ${JSON.stringify(status)}`);
  }
}

/**
 * Sample WebGL framebuffer pixels right after Scene3DView's `tick()` renders a frame.
 */
async function sampleScene3dWebGL(page) {
  return page.evaluate(
    (sel) =>
      new Promise((resolve, reject) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const canvas = document.querySelector(sel);
            if (!canvas) {
              reject(new Error('3D WebGL canvas not found'));
              return;
            }
            const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
            if (!gl) {
              reject(new Error('WebGL context unavailable'));
              return;
            }
            const w = gl.drawingBufferWidth;
            const h = gl.drawingBufferHeight;
            const cx = Math.floor(w / 2);
            const cy = Math.floor(h / 2);
            const center = new Uint8Array(4);
            gl.readPixels(cx, cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, center);

            const full = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, full);
            let redPixels = 0;
            let bluePixels = 0;
            let nonEmptyPixels = 0;
            const stride = 2;
            let sampled = 0;
            for (let y = 0; y < h; y += stride) {
              for (let x = 0; x < w; x += stride) {
                const idx = (y * w + x) * 4;
                const r = full[idx];
                const g = full[idx + 1];
                const b = full[idx + 2];
                const a = full[idx + 3];
                sampled++;
                if (a > 12) nonEmptyPixels++;
                if (a > 20 && r > 140 && g < 60 && b < 60) redPixels++;
                if (a > 20 && b > 140 && r < 60 && g < 80) bluePixels++;
              }
            }
            resolve({
              width: w,
              height: h,
              center: { r: center[0], g: center[1], b: center[2], a: center[3], alphaNorm: center[3] / 255 },
              redCoverage: sampled > 0 ? redPixels / sampled : 0,
              blueCoverage: sampled > 0 ? bluePixels / sampled : 0,
              nonEmptyCoverage: sampled > 0 ? nonEmptyPixels / sampled : 0,
            });
          });
        });
      }),
    GL_CANVAS_SEL,
  );
}

const BLANK_PILL_TEXT = '\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0';

let serverProc = null;
let browser = null;
const out = { port: PORT, outDir: OUT_DIR };

for (const d of [OUT_DIR, EXPORT_DIR, DATA_DIR, ARTIFACT_DIR]) {
  await fs.mkdir(d, { recursive: true });
}

try {
  let origin = GIVEN_ORIGIN;
  if (!origin) {
    origin = `http://127.0.0.1:${PORT}`;
    const env = {
      ...process.env,
      PROMPTCUT_EXPORT_DIR: EXPORT_DIR,
      PROMPTCUT_DATA_DIR: DATA_DIR,
      PROMPTCUT_ARTIFACT_DIR: ARTIFACT_DIR,
      PROMPTCUT_NO_PORT_FILE: '1',
    };
    const stderrLines = [];
    serverProc = spawn(process.execPath, [viteBin(), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env,
    });
    serverProc.stdout.resume();
    serverProc.stderr.on('data', (chunk) => {
      stderrLines.push(...String(chunk).split(/\r?\n/).filter(Boolean));
      if (stderrLines.length > 40) stderrLines.splice(0, stderrLines.length - 40);
    });
    out.serverStderr = stderrLines;

    const deadline = Date.now() + 150000;
    let prerenderReady = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${origin}/api/prerender/info`);
        if (res.ok) {
          const info = await res.json();
          if (info?.ready && info.url) {
            prerenderReady = true;
            out.prerender = info.url;
            break;
          }
        }
      } catch {}
      await sleep(400);
    }
    if (!prerenderReady) throw new Error(`Dev server / prerender startup timed out on ${origin}`);
  }
  out.origin = origin;

  browser = await puppeteer.launch({
    headless: true,
    args: [
      ...PROBE_CHROME_ARGS,
      '--window-position=-32000,-32000',
      '--no-first-run',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto(`${origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(
    async () => {
      const m = await import('/src/store/project.ts');
      return Boolean(m.getState().project);
    },
    { timeout: 120000, polling: 400 },
  );
  await page.waitForSelector('iframe[data-pc="stage-frame"]', { timeout: 120000 });
  await sleep(600);

  /* =========================================================================
   * CASE 1: Depth sorting of overlapping translucent boards (independent of trackId)
   * ========================================================================= */
  // Load Case 1 project BEFORE opening the 3D tab so hot-standby workers only render Case 1 cards
  await page.evaluate(async (pillText) => {
    const { actions } = await import('/src/store/project.ts');
    actions.loadProject({
      id: 'issue13-case1',
      version: 1,
      name: 'issue13-case1',
      width: 1920,
      height: 1080,
      fps: 30,
      duration: 5,
      camera3dFov: 40,
      media: [],
      tracks: [
        // Top track on timeline (higher trackOrder): Blue translucent board
        {
          id: 'track-top',
          name: 'Top Track',
          clips: [
            {
              id: 'blue-top',
              cardId: 'punch-pill',
              start: 0,
              end: 5,
              opacity: 0.65,
              params: { position: 'center', accent: '#0000ff', text: pillText },
              frame: { x: 960, y: 540, w: 900, h: 420, anchor: [0.5, 0.5], scale: 1.8, translateZ: -300 },
            },
          ],
        },
        // Bottom track on timeline (lower trackOrder): Red translucent board
        {
          id: 'track-bottom',
          name: 'Bottom Track',
          clips: [
            {
              id: 'red-bottom',
              cardId: 'punch-pill',
              start: 0,
              end: 5,
              opacity: 0.65,
              params: { position: 'center', accent: '#ff0000', text: pillText },
              frame: { x: 960, y: 540, w: 900, h: 420, anchor: [0.5, 0.5], scale: 1.8, translateZ: 300 },
            },
          ],
        },
      ],
    });
    actions.seek(2.0);
  }, BLANK_PILL_TEXT);

  // Switch to the 3D view tab
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('[data-pc="preview-tabs"] button')].find(
      (b) => b.textContent?.trim() === '3D',
    );
    btn?.click();
  });
  await page.waitForSelector(GL_CANVAS_SEL, { timeout: 60000 });

  await waitSceneReady(page);
  const case1RedFront = await sampleScene3dWebGL(page);
  if (KEEP_OUT) await page.screenshot({ path: path.join(OUT_DIR, 'case1-red-front.png') });

  // Swap depths ONLY (without changing track order!)
  await page.evaluate(async () => {
    const { actions } = await import('/src/store/project.ts');
    actions.setClipFrame('blue-top', { x: 960, y: 540, w: 900, h: 420, anchor: [0.5, 0.5], scale: 1.8, translateZ: 300 });
    actions.setClipFrame('red-bottom', { x: 960, y: 540, w: 900, h: 420, anchor: [0.5, 0.5], scale: 1.8, translateZ: -300 });
  });
  await waitSceneReady(page);
  const case1BlueFront = await sampleScene3dWebGL(page);
  if (KEEP_OUT) await page.screenshot({ path: path.join(OUT_DIR, 'case1-blue-front.png') });

  // Equal depth tie-breaker: top track ('blue-top') should win when translateZ is equal
  await page.evaluate(async () => {
    const { actions } = await import('/src/store/project.ts');
    actions.setClipFrame('blue-top', { x: 960, y: 540, w: 900, h: 420, anchor: [0.5, 0.5], scale: 1.8, translateZ: 0 });
    actions.setClipFrame('red-bottom', { x: 960, y: 540, w: 900, h: 420, anchor: [0.5, 0.5], scale: 1.8, translateZ: 0 });
  });
  await waitSceneReady(page);
  const case1EqualDepth = await sampleScene3dWebGL(page);

  out.case1 = {
    redFrontCenter: case1RedFront.center,
    blueFrontCenter: case1BlueFront.center,
    equalDepthCenter: case1EqualDepth.center,
  };
  check(
    case1RedFront.center.r > case1RedFront.center.b + 50 && case1RedFront.center.b > 20,
    'Case 1a: Bottom-track Red board at z=+300 composites in front of top-track Blue board at z=-300 (with Blue showing through)',
    case1RedFront.center,
  );
  check(
    case1BlueFront.center.b > case1BlueFront.center.r + 50 && case1BlueFront.center.r > 20,
    'Case 1b: Swapping translateZ (Blue z=+300, Red z=-300) swaps composited pixel colors without changing track order',
    case1BlueFront.center,
  );
  check(
    case1EqualDepth.center.b > case1EqualDepth.center.r + 50,
    'Case 1c: Equal depth (z=0) breaks ties by track order (top track Blue in front of bottom track Red)',
    case1EqualDepth.center,
  );

  /* =========================================================================
   * CASE 2: Fades, opacity & nested `@cut` segment envelopes match 2D
   * ========================================================================= */
  // Part 2A: Single clip with opacity: 0.8, fadeIn: 2.5, fadeOut: 1.5 on [0, 5]
  await page.evaluate(async (pillText) => {
    const { actions } = await import('/src/store/project.ts');
    actions.loadProject({
      id: 'issue13-case2a',
      version: 1,
      name: 'issue13-case2a',
      width: 1920,
      height: 1080,
      fps: 30,
      duration: 5,
      camera3dFov: 40,
      media: [],
      tracks: [
        {
          id: 't1',
          name: 'Track 1',
          clips: [
            {
              id: 'red-bottom',
              cardId: 'punch-pill',
              start: 0,
              end: 5,
              opacity: 0.8,
              fadeIn: 2.5,
              fadeOut: 1.5,
              params: { position: 'center', accent: '#ff0000', text: pillText },
              frame: { x: 960, y: 540, w: 900, h: 420, anchor: [0.5, 0.5], scale: 1.8, translateZ: 0 },
            },
          ],
        },
      ],
    });
    actions.seek(3.0);
  }, BLANK_PILL_TEXT);

  await waitSceneReady(page);

  const fadeSamples2A = [];
  for (const tVal of [0.0, 1.5, 2.0, 3.0, 4.25]) {
    const expected2d = await page.evaluate(async (sec) => {
      const { actions, getState } = await import('/src/store/project.ts');
      const { cardOpacityAt, flattenOverlay } = await import('/src/kernel/project.ts');
      actions.seek(sec);
      const clip = flattenOverlay(getState().project).clips.find((c) => c.id === 'red-bottom');
      return cardOpacityAt(clip, sec);
    }, tVal);
    if (expected2d > 0) {
      await waitSceneReady(page);
    } else {
      await sleep(250);
    }
    const glSample = await sampleScene3dWebGL(page);
    fadeSamples2A.push({
      t: tVal,
      expected2d: Number(expected2d.toFixed(4)),
      webglAlpha: Number(glSample.center.alphaNorm.toFixed(4)),
      center: glSample.center,
    });
    check(
      Math.abs(glSample.center.alphaNorm - expected2d) <= 0.03,
      `Case 2a: At t=${tVal}s, 3D WebGL alpha matches canonical 2D cardOpacityAt`,
      { t: tVal, expected2d, webglAlpha: glSample.center.alphaNorm, center: glSample.center },
    );
  }

  // Part 2B: Nested `@cut` segment envelope multiplies inner clip opacity (`0.75 * outerEnvelope(t)`)
  await page.evaluate(async (pillText) => {
    const { actions } = await import('/src/store/project.ts');
    actions.loadProject({
      id: 'issue13-case2b',
      version: 1,
      name: 'issue13-case2b',
      width: 1920,
      height: 1080,
      fps: 30,
      duration: 5,
      camera3dFov: 40,
      media: [],
      activeCutId: 'main-cut',
      cuts: [
        {
          id: 'main-cut',
          name: 'Main 3D Cut',
        },
        {
          id: 'nested-cut',
          name: 'Nested Cut',
          duration: 5,
          tracks: [
            {
              id: 'nt1',
              name: 'Inner Track',
              clips: [
                {
                  id: 'inner-pill',
                  cardId: 'punch-pill',
                  start: 0,
                  end: 5,
                  opacity: 0.75,
                  params: { position: 'center', accent: '#00ff00', text: pillText },
                  frame: { x: 960, y: 540, w: 900, h: 420, anchor: [0.5, 0.5], scale: 1.8 },
                },
              ],
            },
          ],
        },
      ],
      tracks: [
        {
          id: 'outer-t1',
          name: 'Outer Track',
          clips: [
            {
              id: 'seg-clip',
              cutId: 'nested-cut',
              cutOffset: 0,
              start: 0,
              end: 5,
              opacity: 0.8,
              fadeIn: 2.5,
              fadeOut: 1.5,
              frame: { x: 960, y: 540, w: 1920, h: 1080, anchor: [0.5, 0.5], translateZ: 0 },
            },
          ],
        },
      ],
    });
    actions.seek(3.0);
  }, BLANK_PILL_TEXT);

  await waitSceneReady(page);

  const fadeSamples2B = [];
  for (const [tVal, expectedCombined] of [
    [1.5, 0.75 * (0.8 * (1.5 / 2.5))],  // 0.75 * 0.48 = 0.36
    [3.0, 0.75 * 0.8],                  // 0.75 * 0.80 = 0.60
    [4.25, 0.75 * (0.8 * (0.75 / 1.5))], // 0.75 * 0.40 = 0.30
  ]) {
    await page.evaluate(async (sec) => {
      const { actions } = await import('/src/store/project.ts');
      actions.seek(sec);
    }, tVal);
    await waitSceneReady(page);
    const glSample = await sampleScene3dWebGL(page);
    fadeSamples2B.push({
      t: tVal,
      expectedCombined: Number(expectedCombined.toFixed(4)),
      webglAlpha: Number(glSample.center.alphaNorm.toFixed(4)),
      center: glSample.center,
    });
    check(
      Math.abs(glSample.center.alphaNorm - expectedCombined) <= 0.035,
      `Case 2b: Nested @cut segment at t=${tVal}s multiplies inner (0.75) × outer segment envelope`,
      { t: tVal, expectedCombined, webglAlpha: glSample.center.alphaNorm, center: glSample.center },
    );
  }
  out.case2 = { singleClip: fadeSamples2A, nestedCut: fadeSamples2B };

  /* =========================================================================
   * CASE 3: Culling boards passing into / behind the camera without swelling
   * ========================================================================= */
  await page.evaluate(async (pillText) => {
    const { actions } = await import('/src/store/project.ts');
    actions.loadProject({
      id: 'issue13-case3',
      version: 1,
      name: 'issue13-case3',
      width: 1920,
      height: 1080,
      fps: 30,
      duration: 5,
      camera3dFov: 40,
      media: [],
      tracks: [
        {
          id: 'front-track',
          name: 'Front Walkthrough Plane',
          clips: [
            {
              id: 'walk-red',
              cardId: 'punch-pill',
              start: 0,
              end: 5,
              opacity: 1,
              params: { position: 'center', accent: '#ff0000', text: pillText },
              frame: { x: 960, y: 540, w: 360, h: 180, anchor: [0.5, 0.5], scale: 0.7, translateZ: 0 },
            },
          ],
        },
        {
          id: 'back-track',
          name: 'Background Reference Plane',
          clips: [
            {
              id: 'blue-top',
              cardId: 'punch-pill',
              start: 0,
              end: 5,
              opacity: 1,
              params: { position: 'center', accent: '#0000ff', text: pillText },
              frame: { x: 960, y: 540, w: 900, h: 420, anchor: [0.5, 0.5], scale: 1.2, translateZ: -400 },
            },
          ],
        },
      ],
    });
    actions.seek(2.0);
  }, BLANK_PILL_TEXT);

  await waitSceneReady(page);

  // Camera at 1080p@40deg sits at d ≈ 1483.6px with nearClip ≈ 222.5px (cull boundary z ≈ 1261.1px).
  const sweepZ = [0, 600, 1100, 1270, 1400, 1480, 1484, 1650];
  const sweepResults = [];
  for (const z of sweepZ) {
    await page.evaluate(async (tz) => {
      const { actions } = await import('/src/store/project.ts');
      actions.setClipFrame('walk-red', {
        x: 960,
        y: 540,
        w: 360,
        h: 180,
        anchor: [0.5, 0.5],
        scale: 0.7,
        translateZ: tz,
      });
    }, z);
    await waitSceneReady(page);
    const sample = await sampleScene3dWebGL(page);
    sweepResults.push({
      translateZ: z,
      redCoverage: Number(sample.redCoverage.toFixed(5)),
      blueCoverage: Number(sample.blueCoverage.toFixed(5)),
      center: sample.center,
    });
  }
  out.case3 = sweepResults;

  const byZ = new Map(sweepResults.map((r) => [r.translateZ, r]));
  check(
    byZ.get(0).redCoverage > 0.002 &&
      byZ.get(600).redCoverage > byZ.get(0).redCoverage &&
      byZ.get(1100).redCoverage > byZ.get(600).redCoverage,
    'Case 3a: Before near plane (z=0 -> 600 -> 1100), board grows smoothly with perspective',
    [byZ.get(0), byZ.get(600), byZ.get(1100)],
  );
  check(
    sweepResults.every((r) => r.redCoverage < 0.55),
    'Case 3b: Board NEVER swells to fill the frame at any depth before, at, or after crossing the camera',
    sweepResults,
  );
  for (const culledZ of [1270, 1400, 1480, 1484, 1650]) {
    const r = byZ.get(culledZ);
    check(
      r.redCoverage === 0 && r.center.b > 180 && r.center.r < 20,
      `Case 3c: At translateZ=${culledZ} (near/behind camera), front Red board is cleanly culled and reveals Blue board behind`,
      r,
    );
  }

  out.pageErrors = pageErrors.filter(
    (e) => !/favicon|Download the React DevTools|Failed to load resource/i.test(e),
  );
  check(out.pageErrors.length === 0, 'Zero uncaught page errors during probe', out.pageErrors);
} catch (err) {
  fails.push('exception: ' + (err?.stack || err));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (serverProc) killTree(serverProc);
  if (!KEEP_OUT) await fs.rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
}

out.passes = passes;
out.fails = fails;
out.ok = fails.length === 0;
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);

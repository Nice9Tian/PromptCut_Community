/**
 * Shared setup for `seek-back-exact-probe.mjs` and `scrub-hold-snapshot-probe.mjs`, does not run
 * standalone.
 *
 *   - `startIsolatedEditor`: Start an isolated editor (`startDevServer` in
 *     `scripts/lib/dev-server.mjs`): output directory, data directory, and Vite dependency
 *     pre-bundling cache all point to repo `out/` or temp directory, without writing to the user
 *     directory or creating `node_modules` in the checkout directory;
 *   - `openEditorPage`: Headless Chrome opens `?editor&nosetup=1&preview=stage`, waits for the two
 *     stages to handshake; returns a set of functions to retrieve data from page / stage;
 *   - `decodePng` / `comparePixels`: Compare two equal-sized RGBAs pixel by pixel by premultiplied
 *     color.
 *
 * Child processes always use `windowsHide`; Chrome is headless and moved off-screen.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { startDevServer } from '../lib/dev-server.mjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until `fn` returns a truthy value; returns null on timeout (caller records failure itself). Wait timeout is only to prevent hangs */
export async function waitFor(fn, timeoutMs, everyMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(everyMs);
  }
}

/**
 * Start an isolated editor. `port` is the editor port, stage ports are +1 and +2; all three
 * consecutive numbers must be free (if occupied, `startDevServer` throws directly).
 * Returns `{ origin, stagePorts, stop, logFile }`.
 */
export async function startIsolatedEditor({ port, work }) {
  const exportDir = path.join(work, 'export');
  const dataDir = path.join(work, 'data');
  await fs.mkdir(exportDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  const logFile = path.join(work, 'vite.log');
  // Dependency pre-bundling caches are separated by port under repo out/: two editors started
  // at the same time do not compete for the same copy, and are warm on rerun
  const cacheDir = path.join(ROOT, 'out', 'probe-vite-cache', String(port));
  await fs.mkdir(cacheDir, { recursive: true });
  /*
   * Port being occupied is a transient failure: retry with backoff, not counted as failure.
   * When the specified ports fall in the system's dynamic port range, outbound connections from
   * other processes may temporarily occupy them (in testing, launching the probe immediately after
   * a full test run, `startDevServer` reported "not all free" on the spot, but they freed up after
   * a few seconds). If still occupied after 6 attempts (intervals of 3, 6, 9, 12, 15 s), rethrow
   * as-is.
   */
  let server = null;
  for (let attempt = 1; ; attempt++) {
    try {
      server = await startDevServer({
        port, logFile,
        env: { PROMPTCUT_EXPORT_DIR: exportDir, PROMPTCUT_DATA_DIR: dataDir, PROMPTCUT_VITE_CACHE_DIR: cacheDir },
      });
      break;
    } catch (e) {
      if (attempt >= 6 || !/not all free/.test(String(e?.message))) throw e;
      console.error(`[preview-stop-lib] ${e.message}; retrying in ${attempt * 3} seconds (attempt ${attempt})`);
      await sleep(attempt * 3000);
    }
  }
  return { origin: server.origin, stagePorts: server.stagePorts.map(String), stop: server.stop, logFile };
}

/**
 * Open the editor (dual stage) and wait for the visible stage and background stage to be in place.
 * Returns `{ browser, page, pageErrors, store, stageFrames, frontFrame, frontId, parentDiag }`.
 */
export async function openEditorPage(origin, { viewport = { width: 2560, height: 1600 } } = {}) {
  const browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
  await page.goto(origin + '/?editor&nosetup=1&preview=stage', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return !!m.frontStage() && m.backRole() === 'back';
  }, { timeout: 180000, polling: 500 });
  const ports = await (await fetch(origin + '/api/stage/ports')).json();
  const stagePorts = (ports.ports ?? []).slice(0, 2).map(String);
  /** Run code in the parent page using store `actions` / `getState` (`args` is the passed-in array) */
  const store = (src, ...a) => page.evaluate(async (src2, a2) => {
    const { actions, getState } = await import('/src/store/project.ts');
    // eslint-disable-next-line no-new-func
    return new Function('actions', 'getState', 'args', src2)(actions, getState, a2);
  }, src, a);
  const stageFrames = () => page.frames().filter((f) => /[?&]stage=1/.test(f.url()) && stagePorts.some((p) => f.url().includes(`:${p}/`)));
  const frontId = () => page.evaluate(() => window.__pcPreviewDiag?.().frontId ?? 'A');
  const frontFrame = async () => { const id = await frontId(); return stageFrames().find((f) => f.url().includes(`id=${id}`)) ?? null; };
  const parentDiag = () => page.evaluate(() => window.__pcPreviewDiag?.() ?? null);
  return { browser, page, pageErrors, stagePorts, store, stageFrames, frontFrame, frontId, parentDiag };
}

/** Cost record for this clip (in parent page dispatch table); merges `patch` if provided and writes back (for pinning heavy cards, changing `vtOk`) */
export function costRecordOf(page, clipId, patch = null, persist = false) {
  return page.evaluate(async (id, patch2, persist2) => {
    const { getState } = await import('/src/store/project.ts');
    const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
    const pd = await import('/src/editor/planDispatch.ts');
    const key = clipIdentityOf(getState().project).identityKeys[id];
    const costs = pd.currentCosts();
    const found = costs.find((r) => r.identityKey === key) ?? null;
    if (!patch2) return found;
    const rec = { ...(found ?? { identityKey: key, device: costs[0]?.device ?? 'probe' }), ...patch2 };
    pd.mergePlanCosts([rec]);
    if (persist2 && typeof rec.stepMs === 'number') {
      await fetch('/api/data/costs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records: [rec] }) });
    }
    return rec;
  }, clipId, patch, persist);
}

export function decodePng(dataUrl) {
  const png = PNG.sync.read(Buffer.from(dataUrl.split(',')[1], 'base64'));
  return { w: png.width, h: png.height, data: png.data };
}

/**
 * Compare two equal-sized RGBAs (non-premultiplied) by premultiplied color.
 *   - `diffPixels`: Number of pixels differing in any channel (including opacity); `identical`:
 *     none at all;
 *   - `meanAll`: Mean absolute difference across three color channels for all pixels (out of
 *     255); `meanContent`: counted only for pixels with opacity > 0 in either image;
 *   - `alphaMean`: Mean difference in opacity; `max`: maximum single-channel difference;
 *     `inkA` / `inkB`: number of pixels with opacity > 0 in each.
 */
export function comparePixels(a, b) {
  if (!a || !b || a.w !== b.w || a.h !== b.h) return { error: 'size', a: a && [a.w, a.h], b: b && [b.w, b.h] };
  let sum = 0, sumContent = 0, content = 0, alpha = 0, max = 0, inkA = 0, inkB = 0, diffPixels = 0;
  const n = a.w * a.h;
  for (let i = 0; i < n * 4; i += 4) {
    const aa = a.data[i + 3], ba = b.data[i + 3];
    if (aa) inkA++;
    if (ba) inkB++;
    let d = 0;
    let differs = aa !== ba;
    for (let c = 0; c < 3; c++) {
      if (a.data[i + c] !== b.data[i + c] && (aa || ba)) differs = true;
      const x = Math.abs((a.data[i + c] * aa) / 255 - (b.data[i + c] * ba) / 255);
      d += x;
      if (x > max) max = x;
    }
    if (differs) diffPixels++;
    sum += d;
    alpha += Math.abs(aa - ba);
    if (aa || ba) { content++; sumContent += d; }
  }
  return { w: a.w, h: a.h, identical: diffPixels === 0, diffPixels, meanAll: +(sum / (n * 3)).toFixed(4),
    meanContent: content ? +(sumContent / (content * 3)).toFixed(3) : 0, alphaMean: +(alpha / n).toFixed(4), max: Math.round(max), inkA, inkB };
}

export async function savePng(dir, name, dataUrl) {
  if (!dataUrl) return null;
  const file = path.join(dir, name);
  await fs.writeFile(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return file;
}

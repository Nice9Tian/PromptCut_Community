/**
 * "Blind authoring" acceptance check script for the card authoring guide (acceptance check for
 * task brief `docs/plan/render-refactor-task.md` "Bing": dispatch a subagent without context that
 * only reads `server/card-authoring-guide.md`, writes one remotion-style card and one motion-style
 * card, and both pass card creation checks and render correctly).
 *
 * Given two source files, it:
 *   1. Creates an overlay layer and data directory in a temp directory, starts its own dev server
 *      at this checkout root (card sync disabled), writes created cards only into the overlay
 *      layer, leaving not a single extra file in the checkout directory;
 *   2. Creates both cards via real `POST /api/cards/create` (what the Agent's `create_card` calls),
 *      and both must return 200;
 *   3. Renders in real Chrome (visual harness `scripts/probes/remotion-style-harness.html?css=1`,
 *      mounting only the card Component in a 1920×1080 box with the editor's own styles so cards
 *      written with Tailwind classes also lay out correctly):
 *        - For the remotion-style card: same approach as `remotion-style-probe.mjs`: render
 *          forward from frame 0 to frame N on one page (taking screenshots at several checkpoints),
 *          compare pixel-by-pixel against rendering that frame directly on a freshly opened page,
 *          and compare jumping backward across the same page; checkpoints must actually differ and
 *          the final frame must not be empty;
 *        - For the motion-style card: after mounting, play forward for several frames (waiting
 *          briefly on each frame so self-clocked animations like Motion advance), confirming the
 *          visual is changing and the final frame is not empty;
 *      Saves several screenshots to --out for each;
 *   4. Teardown: terminates only its own spawned process tree; deletes the temp directory by
 *      default.
 *
 * Usage (at repository root or worktree root):
 *   node scripts/probes/guide-blind-check.mjs --remotion <remotion-style card .tsx> --motion <motion-style card .tsx>
 *        [--port 7450] [--out <screenshot dir>] [--frames 90] [--motion-seconds 2] [--keep-temp]
 *
 * Ports: editor uses --port, occupies +1 and +2 as stage ports; all three consecutive ports must
 * be free. Does not touch resident ports 5190-5192, 58xx, 59xx.
 * Can also provide only one card (verifying only that type). The card Component must exist
 * (visual harness mounts only DOM cards).
 *
 * Criteria for the remotion-style card (decided 2026-10-13 in lead session after actual runs with
 * two blind-authored cards):
 *   - "Render forward" vs "jump backward" on the same page: must have **0** differing pixels. Two
 *     paths reaching the same t on the same page must produce pixel-identical images; this is the
 *     criterion for "a card is a pure function of time";
 *   - Fresh page "direct render" vs same page "render forward": allows a tiny tolerance: differing
 *     pixels not exceeding 5 / 100,000 of the total (103 pixels for 1920×1080), and maximum
 *     channel difference not exceeding 2. The output still prints actual pixel counts and maximum
 *     channel difference (`px`, `max` in `seqVsDirect` / `jumpVsDirect`), not omitting them just
 *     because tolerance passed.
 *   Reason (verified): comparing blind-counter at frames 20, 45, and 90: fresh page vs same page
 *   DOM (innerHTML) and each element's computed style are verbatim identical; two fresh pages also
 *   differ by 0-32 pixels (still 0-15 pixels after removing all opacity fade-ins), due to text
 *   antialiasing at large digit glyph edges, with max channel difference within 2.
 *   Therefore, these few pixels are caused by Chrome's per-page text rasterization/compositing
 *   history, not the card reading state from the previous frame (reading previous frames would
 *   differ by hundreds or thousands of pixels; `remotion-style-probe.mjs` stateful control card
 *   differed by 13619 pixels).
 *
 * Pass criteria: fails is empty, exit code 0; failure exit code 1; invalid usage or startup failure
 * exit code 2.
 * Output: progress written to stderr; stdout contains only the final JSON line: { ok, ..., fails: [] }.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const PORT = Number(arg('--port', '7450'));
const FRAMES = Number(arg('--frames', '90'));
const MOTION_SECONDS = Number(arg('--motion-seconds', '2'));
const FPS = 30;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(arg('--out', path.join(ROOT, 'out', 'guide-blind-check')));
const KEEP_TEMP = argv.includes('--keep-temp');
const REMOTION_FILE = arg('--remotion', null);
const MOTION_FILE = arg('--motion', null);

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const die = (message, code = 2) => { process.stdout.write(`${JSON.stringify({ ok: false, fails: [message] })}\n`); process.exit(code); };
if (!REMOTION_FILE && !MOTION_FILE) die('Usage: --remotion <file> and/or --motion <file>');
if ([5190, 5191, 5192].some((p) => p >= PORT && p <= PORT + 2) || (PORT >= 5800 && PORT < 6000)) die('This port range is taken by the user\'s always-on dev server or another probe, pick another');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what} (${ms} ms)`);
    await sleep(150);
  }
}

/** Read a card's source code and identify its id and declared style */
function loadCard(label, file, expectMode) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) die(`${label}: cannot find file ${abs}`);
  const source = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
  const id = /\bid:\s*["'`]([^"'`]+)["'`]/.exec(source)?.[1];
  const mode = /\bframeMode:\s*["'`](direct|stateful)["'`]/.exec(source)?.[1] ?? null;
  if (!id) die(`${label}: cannot read the id from the source`);
  return { label, file: abs, source, id, mode, expectMode };
}
const cardsToCheck = [
  REMOTION_FILE ? loadCard('remotion', REMOTION_FILE, 'direct') : null,
  MOTION_FILE ? loadCard('motion', MOTION_FILE, 'stateful') : null,
].filter(Boolean);
if (cardsToCheck.length === 2 && cardsToCheck[0].id === cardsToCheck[1].id) die('The two cards have the same id');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-guide-blind-'));
const OVERLAY = path.join(TMP, 'card-overrides');
const DATA = path.join(TMP, 'data');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(OVERLAY, { recursive: true });
const USER_DIR = path.join(ROOT, 'src', 'cards', 'user');
const userDirList = () => fs.readdirSync(USER_DIR).sort();
const RUN = Date.now().toString(36);

const fails = [];
const res = { runId: RUN, port: PORT, frames: FRAMES, cards: cardsToCheck.map((c) => ({ label: c.label, id: c.id, declared: c.mode })) };
const fail = (what, detail) => { fails.push(what); say('FAIL', { what, ...(detail ? { detail } : {}) }); };

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

/** Two screenshots: diff pixels px, max channel diff max (0-255), total total; px returns -1 on size diff */
function diffStats(a, b) {
  const pa = PNG.sync.read(a), pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return { px: -1, max: 255, total: pa.width * pa.height };
  let px = 0, max = 0;
  for (let i = 0; i < pa.data.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(pa.data[i + c] - pb.data[i + c]));
    if (d > 0) { px++; if (d > max) max = d; }
  }
  return { px, max, total: pa.width * pa.height };
}
const diffPixels = (a, b) => diffStats(a, b).px;
/** Tolerance of fresh page direct vs same page forward render: <= 5/100,000 of total, max channel diff <= 2 */
const TOLERANCE = { fraction: 5e-5, maxChannel: 2 };
const withinTolerance = (d) => d.px >= 0 && d.px <= Math.floor(d.total * TOLERANCE.fraction) && d.max <= TOLERANCE.maxChannel;
/** How many pixels are not the visual harness background color (whether the visual is empty) */
function inkPixels(buf) {
  const p = PNG.sync.read(buf);
  let n = 0;
  for (let i = 0; i < p.data.length; i += 4) if (p.data[i] !== 0x10 || p.data[i + 1] !== 0x14 || p.data[i + 2] !== 0x18) n++;
  return n;
}

let child = null;
let browser = null;
const listBefore = userDirList();
try {
  // ---------- 1. Editor (with overlay layer)
  const log = [];
  child = spawn(process.execPath, [viteBin(), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: {
      ...process.env,
      BROWSER: 'none',
      PROMPTCUT_DATA_DIR: DATA,
      PROMPTCUT_CARD_OVERRIDES: OVERLAY,
      PROMPTCUT_CARD_SYNC: '0',
      PROMPTCUT_PUSH: '0',
      PROMPTCUT_LAN_HOST: '',
      PROMPTCUT_DEVICE_ID: `guideblind-${RUN}`.padEnd(16, '0'),
      PROMPTCUT_DEVICE_NAME: 'guide-blind-check',
    },
  });
  const keep = (c) => { log.push(c.toString()); if (log.length > 400) log.shift(); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  say('spawn', { pid: child.pid });
  const origin = `http://127.0.0.1:${PORT}`;
  const HARNESS = `${origin}/scripts/probes/remotion-style-harness.html?css=1`;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`The editor exited: ${log.join('').slice(-600)}`);
    return fetch(HARNESS, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  }, 180_000, 'editor started');

  browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'],
  });
  res.chrome = await browser.version();
  const pageErrors = [];
  const consoleErrors = [];
  /** One page per test case: fresh document, fresh module instance, fully isolated from each other */
  const openHarness = async () => {
    const page = await browser.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e).slice(0, 300)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
    page.on('dialog', (d) => void d.dismiss());
    await page.goto(HARNESS, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__rsReady === true, { timeout: 120_000 });
    return page;
  };
  const shot = async (page) => Buffer.from(await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1920, height: 1080 } }));
  /** Wait for fonts and this frame to finish rendering (two animation frames) before taking screenshot */
  const settle = (page) => page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  const save = (name, buf) => { fs.writeFileSync(path.join(OUT, name), buf); return path.join(OUT, name); };

  const api = await openHarness();
  const post = (url, body) => api.evaluate(async (u, b) => {
    const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, url, body);

  // ---------- 2. Create cards (real /api/cards/create)
  res.created = [];
  for (const c of cardsToCheck) {
    if (c.mode !== c.expectMode) fail(`${c.label}-declared-${c.mode ?? 'none'}-expected-${c.expectMode}`);
    const r = await post('/api/cards/create', { id: c.id, source: c.source, projectId: `blind-${RUN}` });
    const stored = path.join(OVERLAY, 'src', 'cards', 'user', `${c.id}.tsx`);
    const inOverlay = fs.existsSync(stored) && fs.readFileSync(stored, 'utf8') === c.source;
    res.created.push({ label: c.label, id: c.id, status: r.status, inOverlay, errors: r.status === 200 ? undefined : (r.body?.errors ?? [r.body?.error]).slice(0, 12) });
    say('create', res.created.at(-1));
    if (r.status !== 200) fail(`${c.label}-create-status-${r.status}`, JSON.stringify(r.body?.errors ?? r.body?.error).slice(0, 800));
    else if (!inOverlay) fail(`${c.label}-create-not-in-overlay`);
    c.created = r.status === 200 && inOverlay;
  }
  if (JSON.stringify(userDirList()) !== JSON.stringify(listBefore)) fail('checkout-user-dir-changed');

  // ---------- 3a. Remotion-style: render forward to frame N vs direct render of frame N, compared pixel by pixel
  const rem = cardsToCheck.find((c) => c.label === 'remotion');
  if (rem?.created) {
    const url = `/src/cards/user/${rem.id}.tsx`;
    const checkpoints = [...new Set([0, 7, 20, 45, FRAMES])].filter((n) => n <= FRAMES).sort((a, b) => a - b);
    const t0 = Date.now();
    const seq = await openHarness();
    const info = await seq.evaluate((u) => window.__rs.load(u), url);
    await seq.evaluate(() => window.__rs.mount(0));
    const sequential = new Map();
    for (let n = 0; n <= FRAMES; n++) {
      if (n > 0) await seq.evaluate((t) => window.__rs.set(t), n / FPS);
      if (checkpoints.includes(n)) { await settle(seq); sequential.set(n, await shot(seq)); }
    }
    const jumped = new Map();
    for (const n of [...checkpoints].reverse()) {
      await seq.evaluate((t) => window.__rs.set(t), n / FPS);
      await settle(seq);
      jumped.set(n, await shot(seq));
    }
    const seqError = await seq.evaluate(() => window.__rs.error());
    await seq.close();
    if (seqError) fail('remotion-render-error', `${seqError.name}: ${seqError.message}`);
    const rows = [];
    const saved = [];
    for (const n of checkpoints) {
      const page = await openHarness();
      await page.evaluate((u) => window.__rs.load(u), url);
      await page.evaluate((t) => window.__rs.mount(t), n / FPS);
      await settle(page);
      const direct = await shot(page);
      const directError = await page.evaluate(() => window.__rs.error());
      await page.close();
      if (directError) fail(`remotion-f${n}-direct-render-error`, `${directError.name}: ${directError.message}`);
      const seqVsDirect = diffStats(sequential.get(n), direct), jumpVsDirect = diffStats(jumped.get(n), direct), seqVsJump = diffStats(sequential.get(n), jumped.get(n));
      const row = { frame: n, seqVsJump: seqVsJump.px, seqVsDirect: { px: seqVsDirect.px, max: seqVsDirect.max }, jumpVsDirect: { px: jumpVsDirect.px, max: jumpVsDirect.max }, ink: inkPixels(direct) };
      rows.push(row);
      saved.push(save(`remotion-${rem.id}-f${String(n).padStart(3, '0')}-direct.png`, direct));
      // Two paths on the same page must be pixel-identical; fresh-page direct render allows a tiny
      // tolerance (see file header)
      if (seqVsJump.px !== 0) { fail(`remotion-f${n}-same-page-sequential-vs-jump-differs-${seqVsJump.px}`); save(`remotion-${rem.id}-f${String(n).padStart(3, '0')}-sequential.png`, sequential.get(n)); save(`remotion-${rem.id}-f${String(n).padStart(3, '0')}-jumped.png`, jumped.get(n)); }
      if (!withinTolerance(seqVsDirect)) { fail(`remotion-f${n}-new-page-differs-${seqVsDirect.px}px-max${seqVsDirect.max}`); save(`remotion-${rem.id}-f${String(n).padStart(3, '0')}-sequential.png`, sequential.get(n)); }
      if (!withinTolerance(jumpVsDirect)) { fail(`remotion-f${n}-jump-vs-new-page-differs-${jumpVsDirect.px}px-max${jumpVsDirect.max}`); save(`remotion-${rem.id}-f${String(n).padStart(3, '0')}-jumped.png`, jumped.get(n)); }
    }
    const first = checkpoints[0], last = checkpoints.at(-1);
    const moving = Math.max(...checkpoints.slice(1).map((n) => diffPixels(sequential.get(first), sequential.get(n))));
    if (!(moving > 300)) fail(`remotion-not-moving-${moving}`);
    if (!(rows.at(-1).ink > 300)) fail(`remotion-last-frame-blank-${rows.at(-1).ink}`);
    res.remotion = { tolerance: { ...TOLERANCE, pixelsAt1080p: Math.floor(1920 * 1080 * TOLERANCE.fraction) }, id: rem.id, frozen: info.frozen, frameMode: info.frameMode, checkpoints, rows, movingPixels: moving, lastInk: rows.at(-1).ink, ms: Date.now() - t0, screenshots: saved };
    say('remotion', res.remotion);
  }

  // ---------- 3b. Motion-style: play forward for several frames, visual is changing and not empty
  const mot = cardsToCheck.find((c) => c.label === 'motion');
  if (mot?.created) {
    const url = `/src/cards/user/${mot.id}.tsx`;
    const t0 = Date.now();
    const page = await openHarness();
    const info = await page.evaluate((u) => window.__rs.load(u), url);
    await page.evaluate(() => window.__rs.mount(0));
    const steps = Math.max(4, Math.round(MOTION_SECONDS * 5));
    const shots = [];
    for (let i = 0; i <= steps; i++) {
      if (i > 0) {
        await sleep(200); // Let self-clocked animations like Motion advance
        await page.evaluate((t) => window.__rs.set(t), (i * 200) / 1000);
      }
      await settle(page);
      shots.push(await shot(page));
    }
    const err = await page.evaluate(() => window.__rs.error());
    await page.close();
    if (err) fail('motion-render-error', `${err.name}: ${err.message}`);
    const pick = [...new Set([0, Math.round(steps / 3), Math.round((2 * steps) / 3), steps])];
    const saved = pick.map((i) => save(`motion-${mot.id}-step${String(i).padStart(2, '0')}.png`, shots[i]));
    const inks = shots.map(inkPixels);
    let moving = 0;
    for (let i = 1; i < shots.length; i++) moving = Math.max(moving, diffPixels(shots[i - 1], shots[i]));
    const total = diffPixels(shots[0], shots.at(-1));
    if (!(Math.max(moving, total) > 300)) fail(`motion-not-moving-${Math.max(moving, total)}`);
    if (!(inks.at(-1) > 300)) fail(`motion-last-frame-blank-${inks.at(-1)}`);
    res.motion = { id: mot.id, frameMode: info.frameMode, steps, inks, maxStepDiff: moving, firstVsLast: total, ms: Date.now() - t0, screenshots: saved };
    say('motion', res.motion);
  }

  res.pageErrors = pageErrors;
  res.consoleErrors = consoleErrors.slice(0, 5);
  if (pageErrors.length) fail('page-errors', pageErrors.slice(0, 3).join(' | '));
  if (JSON.stringify(userDirList()) !== JSON.stringify(listBefore)) fail('checkout-user-dir-changed-at-end');
} catch (err) {
  fail('probe-crashed', String(err?.stack ?? err).slice(0, 600));
} finally {
  try { await browser?.close(); } catch { /* Already closed */ }
  if (child?.pid && child.exitCode === null) {
    // Terminate only the tree spawned by itself (the editor also has prerender processes and Chrome under it)
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    else child.kill('SIGKILL');
    say('stopped', { pid: child.pid });
  }
  if (!KEEP_TEMP) { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Left for the system to clean */ } }
}
process.stdout.write(`${JSON.stringify({ ok: fails.length === 0, ...res, out: OUT, fails })}\n`);
process.exit(fails.length === 0 ? 0 : 1);

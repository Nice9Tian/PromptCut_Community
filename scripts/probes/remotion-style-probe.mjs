/**
 * End-to-end probe for remotion-style framework (acceptance check for task brief
 * `docs/plan/render-refactor-task.md` "Yi"): real dev server, real Chrome.
 *
 * Usage (at repository root or worktree root):
 *   node scripts/probes/remotion-style-probe.mjs [--port 7440] [--out <screenshot-dir>] [--frames 90]
 *
 * Ports: editor uses --port, additionally takes +1 and +2 as stage ports; all three consecutive
 * numbers must be free. Does not touch user's resident 5190-5192.
 *
 * What it does (card source codes are taken from test fixtures
 * `server/test/fixtures/remotion-style/`, not entered into card library):
 *   1. Create overlay layer (PROMPTCUT_CARD_OVERRIDES) and data directory in a temp directory,
 *      start an editor at this checkout root (card sync disabled); all created cards are written
 *      to overlay layer, not a single file added to checkout directory;
 *   2. Desktop card creation path (`POST /api/cards/create`, called by Agent's create_card):
 *        - Violation example for each rule: returns 400, error message points out the violating line;
 *        - Three example cards written with framework and the one that "writes to top level via
 *          indirection": return 200, source code enters overlay layer;
 *      Desktop card editing (`POST /api/cards/edit`): adding a new violation returns 400 and points
 *      out line number;
 *   3. Existing cards load as usual: page loads full card set (`src/cards/index.ts`), not a single
 *      built-in card missing or skipped; built-in cards declared as remotion-style are present;
 *      four new cards are also present; built-in card module text does not append "lock read-only"
 *      snippet, while new cards do;
 *   4. Each of the three example cards: rendered sequentially from frame 0 to frame N (screenshots
 *      taken at checkpoints), pixel-identical to opening another page and rendering that frame
 *      directly; rendering later frames before earlier frames on same page (jumping backwards) is
 *      also identical to direct rendering; visual outputs between checkpoints indeed differ and are
 *      not empty;
 *   5. Control: a stateful card (fails card creation check, loaded directly from fixtures) compared
 *      the same way **must** show differences: proves this comparison method catches issues;
 *   6. Second read-only defense: after loading card that "writes to top level via indirection",
 *      card definition is frozen; renders normally when not writing, component throws TypeError
 *      on write;
 *   7. Teardown: only terminates process tree started by itself; temp directory deleted by default.
 *
 * Pass criteria: fails is empty. Output: progress written to stderr; stdout contains only the
 * last JSON line: { ok, ..., fails: [] }.
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
const PORT = Number(arg('--port', '7440'));
const FRAMES = Number(arg('--frames', '90'));
const FPS = 30;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(arg('--out', path.join(ROOT, 'out', 'remotion-style-probe')));
const KEEP_TEMP = argv.includes('--keep-temp');
fs.mkdirSync(OUT, { recursive: true });
if ([5190, 5191, 5192].some((p) => p >= PORT && p <= PORT + 2)) throw new Error('This range holds the ports of the user\'s resident dev servers, use another one');

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
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

const FIX = path.join(ROOT, 'server', 'test', 'fixtures', 'remotion-style');
const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8').replace(/\r\n/g, '\n');
const idOf = (source) => /\bid:\s*"([^"]+)"/.exec(source)[1];
const lineOf = (source, needle) => source.slice(0, source.indexOf(needle)).split('\n').length;

/** Violation example for each rule: file, text snippet in the violating line. */
const VIOLATIONS = [
  ['real-time.tsx', 'performance.now()'], ['timer.tsx', 'setTimeout('], ['frame-callback.tsx', 'requestAnimationFrame('],
  ['motion.tsx', '<motion.div'], ['presence.tsx', '<AnimatePresence>'], ['css-animation.tsx', 'transition: "opacity'],
  ['random.tsx', 'Math.random()'], ['state.tsx', 'useState(0)'], ['state-ref.tsx', 'frames.current += 1'],
  ['state-top-write.tsx', 'COUNTER.frames += 1'], ['state-global.tsx', 'window as'], ['top-level.tsx', 'let frames = 0'],
  ['import.tsx', 'from "lottie-web"'], ['frame-mode.tsx', 'frameMode: MODES[0]'],
];
const SAMPLES = ['rs-title-reveal.tsx', 'rs-bar-race.tsx', 'rs-orbit-canvas.tsx'];
const ALIAS = 'rs-alias-write.tsx';
/** Frames captured during sequential render; the last one is N. */
const CHECKPOINTS = [...new Set([0, 7, 20, 45, FRAMES])].filter((n) => n <= FRAMES).sort((a, b) => a - b);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-remotion-style-probe-'));
const OVERLAY = path.join(TMP, 'card-overrides');
const DATA = path.join(TMP, 'data');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(OVERLAY, { recursive: true });
const USER_DIR = path.join(ROOT, 'src', 'cards', 'user');
const userDirList = () => fs.readdirSync(USER_DIR).sort();
const RUN = Date.now().toString(36);

const fails = [];
const res = { runId: RUN, port: PORT, frames: FRAMES, checkpoints: CHECKPOINTS };
const fail = (what, detail) => { fails.push(what); say('FAIL', { what, ...(detail ? { detail } : {}) }); };

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

/** How many pixels differ between two screenshots; returns -1 if dimensions differ. */
function diffPixels(a, b) {
  const pa = PNG.sync.read(a), pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return -1;
  let n = 0;
  for (let i = 0; i < pa.data.length; i += 4) {
    if (pa.data[i] !== pb.data[i] || pa.data[i + 1] !== pb.data[i + 1] || pa.data[i + 2] !== pb.data[i + 2] || pa.data[i + 3] !== pb.data[i + 3]) n++;
  }
  return n;
}
/** How many pixels are not the background color (whether the frame is empty). */
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
      PROMPTCUT_DEVICE_ID: `remotionstyle-${RUN}`.padEnd(16, '0'),
      PROMPTCUT_DEVICE_NAME: 'remotion-style-probe',
    },
  });
  const keep = (c) => { log.push(c.toString()); if (log.length > 400) log.shift(); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  say('spawn', { pid: child.pid });
  const origin = `http://127.0.0.1:${PORT}`;
  const HARNESS = `${origin}/scripts/probes/remotion-style-harness.html`;
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
  /** One page per test case: fresh document, fresh module instance, fully isolated from each other */
  const openHarness = async () => {
    const page = await browser.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e).slice(0, 300)));
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

  const api = await openHarness();
  const post = (url, body) => api.evaluate(async (u, b) => {
    const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, url, body);

  // ---------- 2. Desktop card creation: reject violations and report line numbers, write compliant ones to disk
  res.rejected = [];
  for (const [file, needle] of VIOLATIONS) {
    const source = fixture(`violations/${file}`);
    const id = idOf(source);
    const r = await post('/api/cards/create', { id, source, projectId: `probe-${RUN}` });
    const line = lineOf(source, needle);
    const pointed = (r.body?.errors ?? []).find((e) => e.startsWith(`[Remotion-style] line ${line}:`)) ?? null;
    res.rejected.push({ file, status: r.status, line, error: pointed ? pointed.slice(0, 60) : null });
    if (r.status !== 400) fail(`create-${file}-status-${r.status}`);
    if (!pointed) fail(`create-${file}-no-line-${line}`, String(r.body?.error ?? '').slice(0, 300));
    if (fs.existsSync(path.join(OVERLAY, 'src', 'cards', 'user', `${id}.tsx`))) fail(`create-${file}-written`);
  }
  say('rejected', { count: res.rejected.length, sample: res.rejected[0] });
  res.created = [];
  for (const file of [...SAMPLES, ALIAS]) {
    const source = fixture(file);
    const id = idOf(source);
    const r = await post('/api/cards/create', { id, source, projectId: `probe-${RUN}` });
    const stored = path.join(OVERLAY, 'src', 'cards', 'user', `${id}.tsx`);
    const written = fs.existsSync(stored) && fs.readFileSync(stored, 'utf8') === source;
    res.created.push({ file, status: r.status, inOverlay: written });
    if (r.status !== 200) fail(`create-${file}-status-${r.status}`, String(r.body?.error ?? '').slice(0, 400));
    if (!written) fail(`create-${file}-not-in-overlay`);
  }
  say('created', { created: res.created });
  // Desktop card editing: add a new violation
  {
    const before = fixture('rs-bar-race.tsx');
    const find = '  const count = Math.max(';
    const replace = '  const jitter = Math.random();\n  const count = Math.max(';
    const r = await post('/api/cards/edit', { id: 'rs-bar-race', find, replace });
    const line = lineOf(before.replace(find, replace), 'Math.random()');
    const pointed = (r.body?.errors ?? []).find((e) => e.startsWith(`[Remotion-style] line ${line}: used random without a seed`)) ?? null;
    res.edit = { status: r.status, line, error: pointed ? pointed.slice(0, 60) : null };
    if (r.status !== 400 || !pointed) fail('edit-add-violation-not-rejected', String(r.body?.error ?? '').slice(0, 300));
    const ok = await post('/api/cards/edit', { id: 'rs-bar-race', find: 'name: "Random bar fluctuation"', replace: 'name: "Random bars"' });
    res.editRename = ok.status;
    if (ok.status !== 200) fail(`edit-rename-status-${ok.status}`, String(ok.body?.error ?? '').slice(0, 300));
  }
  if (JSON.stringify(userDirList()) !== JSON.stringify(listBefore)) fail('checkout-user-dir-changed');

  // ---------- 3. Existing cards load as usual
  {
    const page = await openHarness();
    const warnings = [];
    page.on('console', (m) => { const text = m.text(); if (/\[cards\/user\]|skipped|duplicate card id/.test(text)) warnings.push(text.slice(0, 200)); });
    const reg = await page.evaluate(async () => {
      await import('/src/cards/index.ts');
      const R = await import('/src/kernel/registry.ts');
      const all = R.allCards();
      return {
        total: all.length,
        bySource: all.reduce((acc, c) => { acc[c.source ?? '?'] = (acc[c.source ?? '?'] ?? 0) + 1; return acc; }, {}),
        direct: all.filter((c) => c.frameMode === 'direct').map((c) => c.id).sort(),
        user: all.filter((c) => c.source === 'user').map((c) => c.id).sort(),
        noComponent: all.filter((c) => typeof c.Component !== 'function' && typeof c.card !== 'function' && typeof c.audio !== 'function').map((c) => c.id),
      };
    });
    res.registry = { ...reg, warnings };
    say('registry', res.registry);
    // Count built-in cards from source: definitions in native, magicui, and probe card directories,
    // plus those generated from asset catalog
    const builtinTotal = reg.total - reg.user.length;
    if (builtinTotal < 101) fail(`builtin-cards-${builtinTotal}-lt-101`);
    for (const id of ['av-pulse', 'caption-track']) if (!reg.direct.includes(id)) fail(`builtin-direct-missing-${id}`);
    for (const id of ['rs-alias-write', 'rs-bar-race', 'rs-orbit-canvas', 'rs-title-reveal']) if (!reg.user.includes(id)) fail(`created-card-not-registered-${id}`);
    if (reg.noComponent.length) fail('cards-without-outlet', reg.noComponent.join(','));
    if (warnings.length) fail('card-load-warnings', warnings.join(' | '));
    // Module text: built-in cards do not append the "lock read-only" snippet, framework-written user cards do
    const text = (url) => page.evaluate((u) => fetch(u).then((r) => r.text()), url);
    const locked = {};
    for (const url of ['/src/cards/native/av-pulse.tsx', '/src/cards/native/caption-track.tsx', '/src/cards/user/mu-animated-shiny-text.tsx', '/src/cards/user/rs-title-reveal.tsx', '/src/cards/user/rs-alias-write.tsx']) {
      locked[url] = /__pcLockTopLevel/.test(await text(url));
    }
    res.lockAttached = locked;
    for (const [url, has] of Object.entries(locked)) if (has !== /\/user\/rs-/.test(url)) fail(`lock-attached-wrong-${url}`);
    await page.close();
  }

  // ---------- 4. Example cards: compare sequential render to frame N vs direct render of frame N, pixel by pixel
  res.samples = [];
  for (const file of SAMPLES) {
    const id = idOf(fixture(file));
    const url = `/src/cards/user/${id}.tsx`;
    const t0 = Date.now();
    // Sequential render: one page, single mount, frame by frame from frame 0 to frame N
    const seq = await openHarness();
    const info = await seq.evaluate((u) => window.__rs.load(u), url);
    if (!info.frozen || !info.defaultsFrozen) fail(`sample-${id}-not-locked`);
    await seq.evaluate(() => window.__rs.mount(0));
    const sequential = new Map();
    for (let n = 0; n <= FRAMES; n++) {
      if (n > 0) await seq.evaluate((t) => window.__rs.set(t), n / FPS);
      if (CHECKPOINTS.includes(n)) { await settle(seq); sequential.set(n, await shot(seq)); }
    }
    // Jump backwards on the same page: render later frames first, then earlier frames
    const jumped = new Map();
    for (const n of [...CHECKPOINTS].reverse()) {
      await seq.evaluate((t) => window.__rs.set(t), n / FPS);
      await settle(seq);
      jumped.set(n, await shot(seq));
    }
    const seqError = await seq.evaluate(() => window.__rs.error());
    await seq.close();
    if (seqError) fail(`sample-${id}-render-error`, seqError.message);
    // Direct render: open a new page for each checkpoint, mounted directly at that frame
    const rows = [];
    for (const n of CHECKPOINTS) {
      const page = await openHarness();
      await page.evaluate((u) => window.__rs.load(u), url);
      await page.evaluate((t) => window.__rs.mount(t), n / FPS);
      await settle(page);
      const direct = await shot(page);
      await page.close();
      const row = { frame: n, seqVsDirect: diffPixels(sequential.get(n), direct), jumpVsDirect: diffPixels(jumped.get(n), direct), ink: inkPixels(direct) };
      rows.push(row);
      fs.writeFileSync(path.join(OUT, `${id}-f${String(n).padStart(3, '0')}-direct.png`), direct);
      if (row.seqVsDirect !== 0) { fail(`sample-${id}-f${n}-sequential-differs-${row.seqVsDirect}`); fs.writeFileSync(path.join(OUT, `${id}-f${String(n).padStart(3, '0')}-sequential.png`), sequential.get(n)); }
      if (row.jumpVsDirect !== 0) { fail(`sample-${id}-f${n}-jump-differs-${row.jumpVsDirect}`); fs.writeFileSync(path.join(OUT, `${id}-f${String(n).padStart(3, '0')}-jumped.png`), jumped.get(n)); }
    }
    // Output is indeed moving, last frame is not empty
    const moving = diffPixels(sequential.get(CHECKPOINTS[1]), sequential.get(CHECKPOINTS.at(-1)));
    if (!(moving > 500)) fail(`sample-${id}-not-moving-${moving}`);
    if (!(rows.at(-1).ink > 2000)) fail(`sample-${id}-blank-${rows.at(-1).ink}`);
    res.samples.push({ id, rows, movingPixels: moving, ms: Date.now() - t0 });
    say('sample', res.samples.at(-1));
  }

  // ---------- 5. Control: stateful cards must show differences under the same comparison
  {
    const url = '/server/test/fixtures/remotion-style/rs-stateful-control.tsx';
    const seq = await openHarness();
    await seq.evaluate((u) => window.__rs.load(u), url);
    await seq.evaluate(() => window.__rs.mount(0, { text: '#' }));
    for (let n = 1; n <= 20; n++) await seq.evaluate((t) => window.__rs.set(t), n / FPS);
    await settle(seq);
    const sequential = await shot(seq);
    await seq.close();
    const page = await openHarness();
    await page.evaluate((u) => window.__rs.load(u), url);
    await page.evaluate((t) => window.__rs.mount(t, { text: '#' }), 20 / FPS);
    await settle(page);
    const direct = await shot(page);
    await page.close();
    const differs = diffPixels(sequential, direct);
    res.control = { differs };
    fs.writeFileSync(path.join(OUT, 'control-sequential.png'), sequential);
    fs.writeFileSync(path.join(OUT, 'control-direct.png'), direct);
    if (!(differs > 100)) fail(`control-not-detected-${differs}`);
    say('control', res.control);
  }

  // ---------- 6. Second read-only defense: writing to top level after load throws error immediately
  {
    const url = '/src/cards/user/rs-alias-write.tsx';
    const page = await openHarness();
    const info = await page.evaluate((u) => window.__rs.load(u), url);
    await page.evaluate(() => window.__rs.mount(0.5, { text: 'read-only' }));
    await settle(page);
    const quietError = await page.evaluate(() => window.__rs.error());
    const quietInk = inkPixels(await shot(page));
    await page.evaluate(() => window.__rs.unmount());
    const errors = {};
    for (const text of ['write-object', 'write-array']) {
      await page.evaluate((x) => window.__rs.mount(0.5, { text: x }), text);
      errors[text] = await page.evaluate(() => window.__rs.error());
      await page.evaluate(() => window.__rs.unmount());
    }
    // Not written: rendering again without writing still reads initial value
    await page.evaluate(() => window.__rs.mount(0.5, { text: 'read-only' }));
    const after = await page.evaluate(() => document.getElementById('stage').textContent);
    await page.close();
    res.lock = { frozen: info.frozen, defaultsFrozen: info.defaultsFrozen, componentFrozen: info.componentFrozen, quietError, quietInk, errors, after };
    say('lock', res.lock);
    if (!info.frozen || !info.defaultsFrozen || !info.componentFrozen) fail('lock-card-def-not-frozen');
    if (quietError) fail('lock-read-only-render-threw', quietError.message);
    if (!(quietInk > 200)) fail(`lock-read-only-render-blank-${quietInk}`);
    for (const [text, e] of Object.entries(errors)) if (!e || e.name !== 'TypeError') fail(`lock-${text}-did-not-throw`, JSON.stringify(e));
    if (after !== 'read-only01') fail(`lock-write-went-through-${after}`);
  }

  res.pageErrors = pageErrors;
  // In step 6, TypeError thrown by component is caught by stage, not counted as page error;
  // other page errors count as failures
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

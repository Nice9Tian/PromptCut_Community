/**
 * Whether user cards written with a remotion-style framework can be loaded and rendered correctly
 * in a real browser (Chrome) via the online page's own card runtime (transpilation in
 * `src/online/cardRuntime/`, loader, and the page's built-in module table) (task brief
 * `docs/plan/render-refactor-task.md` "Bing" item 7 first occurrence; when the framework was merged
 * ("Yi"), this part was only run in Node and was not verified in a real browser).
 *
 *   node scripts/probes/online-remotion-card-probe.mjs [--port 7450] [--out <screenshot-dir>] [--keep-temp]
 *
 * Method: start its own dev server at the root of this checkout (port --port, also occupying +1 and
 * +2; card sync turned off), and open the stage harness
 * `scripts/probes/online-runtime-harness.html` in real Chrome: it passes the card source code
 * supplied by the probe (shaped like synced user cards: key → text) to the online page's
 * `bundleCards` for transpilation (Sucrase, including the line locking read-only on load) and
 * `createCardLoader` for loading (`new Function`, page's built-in module table), then renders the
 * loaded card by t.
 *
 * **Not covered** (included in report): joining shared projects via account, content store
 * synchronization, cross-origin stage iframe, and Content Security Policy. Reason: the start page
 * of online build now only has the account entry (`OnlineStartPage` in `StartPage.tsx` only mounts
 * `AccountProjects`, and `data-pc="join-form"` is not in the online build); probes like
 * `online-card-exec-probe.mjs` that rely on `join-form` to join projects no longer work on main;
 * going through accounts requires a frozen official site plus a fixture on fixed 63xx ports
 * (`account-user-pages-probe.mjs`), which is out of scope this time.
 *
 * Four cards are placed in the project (all loaded as synced user cards):
 *   rs-title-reveal   Example card from test fixture, unmodified (spring, staggered entrance,
 *                     color transition, inline styles)
 *   rs-orbit-canvas   Example card from test fixture, unmodified (canvas; clear and redraw every
 *                     frame)
 *   rs-online-mark    Probe card: written with framework, writing values computed by interpolate /
 *                     random and "whether top-level object is read-only" into DOM data attributes
 *   rs-online-control Control: same card declared as motion-style (read-only not locked)
 *
 * # Acceptance check (each item "pass / fail"; last line is JSON `{ ok, pass, fail, fails, ... }`;
 *   exit code = whether there are any "fails")
 *
 * R1 All four cards transpile and load successfully (runtime state ready); the transpilation output
 *    of framework cards is followed by the line locking read-only on load, while the control card
 *    is not.
 * R2 Rendered: the text rendered by example cards (word-by-word bounce-in titles) is present; the
 *    canvas of the canvas card has pixels.
 * R3 Rendered correctly: probe card DOM data attributes (position, random numbers) match verbatim
 *    with calculations in this process using the same framework, one set for each of three t
 *    values; advancing to a later t then rewinding to an earlier one yields values identical to the
 *    first time.
 * R4 Read-only locked: "top-level object is read-only" is true in probe card; false in control card
 *    (motion-style); the loaded card definition is frozen.
 * R5 Canvas card redraws entirely every frame: canvas pixels differ between two different t values,
 *    and returning to a previous t is pixel-identical to before.
 * R6 The page has no errors.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { Easing, interpolate, random } from '../../src/kernel/remotionStyle/index.ts';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(arg('--port', 7450));
const OUT = path.resolve(arg('--out', path.join(ROOT, 'out', 'online-remotion-card-probe')));
const KEEP_TEMP = argv.includes('--keep-temp');
if ([5190, 5191, 5192].some((p) => p >= PORT && p <= PORT + 2) || (PORT >= 5800 && PORT < 6000)) {
  console.log(JSON.stringify({ ok: false, fails: ['This port range is taken by the user\'s always-on dev server or another probe, pick another'] }));
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
let pass = 0;
const short = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s === undefined ? '' : (s.length > 500 ? `${s.slice(0, 500)}…` : s); };
const check = (label, ok, detail) => { console.log(`${ok ? '  pass' : 'fail'}  ${label}${detail !== undefined ? `  [${short(detail)}]` : ''}`); if (ok) pass++; else fails.push(label); return !!ok; };
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

/* ------------------------------------------------------------------ Card source */
const FIX = path.join(ROOT, 'server', 'test', 'fixtures', 'remotion-style');
const fixture = (n) => fs.readFileSync(path.join(FIX, n), 'utf8').replace(/\r\n/g, '\n');
const markCard = (id, mode) => `/** Probe card: written with the framework, the computed values are written as DOM data attributes */
import type { CardDef, CardProps } from "../../kernel/types";
import { Easing, interpolate, random } from "../../kernel/remotionStyle";

interface Params { seed: number }

const CONFIG = { ease: Easing.out(Easing.cubic), span: 400 };

function OnlineMark({ params, t = 0 }: CardProps<Params>) {
  const x = interpolate(t, [0, 1], [0, CONFIG.span], { easing: CONFIG.ease });
  const r = random(params.seed, 1);
  return (
    <div
      data-rs-mark="${id}"
      data-rs-t={t.toFixed(4)}
      data-rs-x={x.toFixed(4)}
      data-rs-r={r.toFixed(6)}
      data-rs-readonly={String(Object.isFrozen(CONFIG))}
      style={{ position: "absolute", left: 100 + x, top: 400, width: 200, height: 200, borderRadius: 24, background: "hsl(" + Math.round(r * 360) + ", 80%, 60%)" }}
    />
  );
}

export const onlineMark: CardDef<Params> = {
  id: "${id}",
  name: "Online framework probe card",
  description: "Probe card written with the framework: a color block moves from left to right, and the data attributes record the computed values",
  source: "user",
  useWhen: "For probes only, not for real projects.",
  tags: ["probe"],
  frameMode: "${mode}",
  defaults: { seed: 5 },
  controls: [{ key: "seed", label: "Seed", type: "number", min: 0, max: 9999, step: 1 }],
  Component: OnlineMark,
};
`;
const U = 'src/cards/user/';
const CARDS = {
  'rs-title-reveal': fixture('rs-title-reveal.tsx'),
  'rs-orbit-canvas': fixture('rs-orbit-canvas.tsx'),
  'rs-online-mark': markCard('rs-online-mark', 'direct'),
  'rs-online-control': markCard('rs-online-control', 'stateful'),
};
const SOURCES = Object.fromEntries(Object.entries(CARDS).map(([id, body]) => [`${U}${id}.tsx`, body]));
const ENTRIES = Object.keys(SOURCES);
const CARD_IDS = Object.keys(CARDS);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-online-rs-'));
function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

let child = null, browser = null;
const summary = { out: OUT, port: PORT };
try {
  const log = [];
  fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
  fs.mkdirSync(path.join(TMP, 'overlay'), { recursive: true });
  child = spawn(process.execPath, [viteBin(), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, BROWSER: 'none', PROMPTCUT_DATA_DIR: path.join(TMP, 'data'), PROMPTCUT_CARD_OVERRIDES: path.join(TMP, 'overlay'), PROMPTCUT_CARD_SYNC: '0', PROMPTCUT_PUSH: '0', PROMPTCUT_LAN_HOST: '', PROMPTCUT_DEVICE_ID: 'onliners-probe-0001', PROMPTCUT_DEVICE_NAME: 'online-remotion-card-probe' },
  });
  const keep = (c) => { log.push(c.toString()); if (log.length > 400) log.shift(); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const HARNESS = `http://127.0.0.1:${PORT}/scripts/probes/online-runtime-harness.html`;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`The dev server exited: ${log.join('').slice(-600)}`);
    return fetch(HARNESS, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  }, 180_000, 'dev server is up');

  browser = await puppeteer.launch({
    headless: true, defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'],
  });
  summary.chrome = await browser.version();
  const pageErrors = [];
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e).slice(0, 300)));
  page.on('dialog', (d) => void d.dismiss());
  await page.goto(HARNESS, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__orsReady === true, { timeout: 120_000 });
  const settle = () => page.evaluate(async () => { await document.fonts.ready; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); });
  const clip = { x: 0, y: 0, width: 1920, height: 1080 };

  console.log('\n== R1 transpile, load');
  const loaded = await page.evaluate((s, e) => window.__ors.setSources(s, e), SOURCES, ENTRIES);
  summary.R1 = { runtime: await page.evaluate(() => window.__ors.runtime), ...loaded };
  check('R1 all four cards transpiled successfully', loaded.bundled.length === 4 && loaded.bundled.every((b) => b.ok), loaded.bundled);
  check('R1 all four cards loaded successfully (run state ready, all card definitions recognized)', loaded.loaded.length === 4 && loaded.loaded.every((l) => l.ok) && CARD_IDS.every((id) => loaded.cards.some((c) => c.id === id)), loaded.loaded);
  const lockOf = Object.fromEntries(loaded.bundled.map((b) => [b.entry.split('/').pop().replace('.tsx', ''), b.lockSuffix]));
  check('R1 in the transpile output: remotion-style cards that reference the framework (two example cards, the probe card) get the "read-only lock on load" line appended; the motion-style control card does not',
    lockOf['rs-title-reveal'] && lockOf['rs-orbit-canvas'] && lockOf['rs-online-mark'] && !lockOf['rs-online-control'], lockOf);

  console.log('\n== R2 it renders');
  await page.evaluate(() => window.__ors.mount('rs-title-reveal', 3));
  await settle();
  const title = await page.evaluate(() => ({ text: document.getElementById('stage').textContent, error: window.__ors.error() }));
  await page.screenshot({ path: path.join(OUT, 'online-title-t3.png'), clip });
  check('R2 the text drawn by the example card (default text "computed directly from t") is all there, no render errors', title.text === '由 t 直接算' && !title.error, title);
  await page.evaluate(() => window.__ors.unmount());
  /**
   * Canvas card visuals: compared using screenshot hash (calling getImageData on the canvas causes
   * Chrome to replace it with a software canvas, altering edge antialiasing, so reading pixels is
   * placed at the very end).
   */
  const shotHash = async (name) => { const buf = Buffer.from(await page.screenshot({ clip })); if (name) fs.writeFileSync(path.join(OUT, name), buf); return createHash('sha256').update(buf).digest('hex').slice(0, 16); };
  const inkOf = () => page.evaluate(() => {
    const c = document.querySelector('#stage canvas');
    if (!c) return null;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) ink++;
    return { ink };
  });
  await page.evaluate(() => window.__ors.mount('rs-orbit-canvas', 1));
  await settle();
  const h1 = await shotHash('online-orbit-t1.png');
  console.log('\n== R5 the canvas card redraws the whole canvas every frame');
  const seq = [h1];
  for (const t of [1, 2.5, 1, 2.5, 1]) { await page.evaluate((x) => window.__ors.set(x), t); await settle(); seq.push(await shotHash(t === 2.5 ? 'online-orbit-t25.png' : null)); }
  summary.R5seq = seq;
  check('R5 the canvas images differ at two different t values; returning to an earlier t (switching several times in a row) is pixel-identical to before', seq[0] === seq[1] && seq[0] === seq[3] && seq[0] === seq[5] && seq[2] === seq[4] && seq[0] !== seq[2], seq);
  const c1 = await inkOf();
  check('R2 the canvas card\'s canvas has pixels', (c1?.ink ?? 0) > 500, c1);
  await page.evaluate(() => window.__ors.unmount());


  console.log('\n== R3 drawn correctly');
  const ease = Easing.out(Easing.cubic);
  const expected = (t) => ({ x: interpolate(t, [0, 1], [0, 400], { easing: ease }).toFixed(4), r: random(5, 1).toFixed(6) });
  let mounted = false;
  const markAt = async (id, t) => {
    await page.evaluate((i, x, m) => { if (!m) window.__ors.mount(i, x); else window.__ors.set(x); }, id, t, mounted);
    mounted = true;
    await settle();
    return page.evaluate(() => { const m = document.querySelector('[data-rs-mark]'); return m ? { t: m.getAttribute('data-rs-t'), x: m.getAttribute('data-rs-x'), r: m.getAttribute('data-rs-r'), readonly: m.getAttribute('data-rs-readonly'), error: window.__ors.error() } : { error: window.__ors.error() }; });
  };
  const unmount = async () => { await page.evaluate(() => window.__ors.unmount()); mounted = false; };
  const TS = [0.5, 0.8, 1.6];
  const first = [];
  for (const t of TS) first.push(await markAt('rs-online-mark', t));
  const rows = first.map((m, i) => ({ t: TS[i], got: m, want: expected(TS[i]) }));
  summary.R3 = rows;
  check('R3 the values computed by interpolate / random in the probe card are character-for-character identical to those computed in this process with the same framework at the same t (three t values)', rows.every((r) => r.got.t === r.t.toFixed(4) && r.got.x === r.want.x && r.got.r === r.want.r), rows);
  check('R3 the positions at the three t values are all different', new Set(first.map((m) => m.x)).size === 3, first.map((m) => m.x));
  const again = [];
  for (const t of [...TS].reverse()) again.push(await markAt('rs-online-mark', t));
  again.reverse();
  check('R3 go to a later t and then back to an earlier one: the values at the same t are character-for-character identical to the first time (computed directly, independent of order)', again.every((m, i) => m.t === first[i].t && m.x === first[i].x && m.r === first[i].r), { first: first.map((m) => m.x), again: again.map((m) => m.x) });
  await page.screenshot({ path: path.join(OUT, 'online-mark-t16.png'), clip });
  await unmount();

  console.log('\n== R4 read-only lock');
  const ro = await markAt('rs-online-mark', 1);
  await unmount();
  const ctl = await markAt('rs-online-control', 1);
  await unmount();
  check('R4 Object.isFrozen(top-level constant object) is true in the probe card (remotion-style, referencing the framework): the read-only lock line added on load is hooked up in a real browser', ro.readonly === 'true', ro);
  check('R4 it is false in the control card (the same card declared as motion-style), so the true result above is not a freebie', ctl.readonly === 'false', ctl);
  const defs = Object.fromEntries(loaded.cards.map((c) => [c.id, c]));
  check('R4 loaded card definitions: the remotion-style one is frozen, the control card is not', defs['rs-online-mark']?.frozen === true && defs['rs-online-mark']?.defaultsFrozen === true && defs['rs-online-control']?.frozen === false, defs);

  console.log('\n== R6 no errors on the page');
  check('R6 no uncaught errors on the page', pageErrors.length === 0, pageErrors.slice(0, 3));
} catch (e) {
  check('the probe did not error midway', false, String(e?.stack ?? e).slice(0, 600));
} finally {
  await browser?.close().catch(() => {});
  if (child?.pid && child.exitCode === null) {
    // Only terminate the process tree spawned by itself
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    else child.kill('SIGKILL');
  }
  if (!KEEP_TEMP) { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Left for the system to clean */ } }
}
const ok = fails.length === 0;
console.log(JSON.stringify({ ok, pass, fail: fails.length, fails, ...summary }));
process.exit(ok ? 0 : 1);

/**
 * cutId probe for see_frames (user decision, 2026-10-21: can specify cut when viewing frames without
 * switching; `docs/semantics/product/agent.md` "Tools", `product/project-model.md` "Cuts"; report
 * `docs/archive/agent-reports/AGENT-cut-look-ui.md`).
 *
 *   node scripts/probes/cut-look-probe.mjs [--port 5970] --out <output-dir> [--keep]
 *
 * Starts a local editor process (+ the prerender process it starts, real Chrome); the project has
 * two cuts: cut 1 (active) is full-screen solid red, cut 2 (parked) is full-screen solid blue.
 * The solid card is temporarily written by the probe into `src/cards/user/cut-look-solid.tsx`
 * (deleted after running), with source taken from `fixtures/cloud-look/look-solid.tsx`.
 * Tools are always called via the local MCP endpoint `POST /api/mcp/call` (which is what desktop
 * CLI uses when calling tools via MCP). Run each of the two frame output paths once:
 *
 *   A Mirror path (no project replica bound: page only pushes project to data mirror,
 *     `runMirroredTool` in `instance.mjs`):
 *     A1 Active cut 1, see_frames with cutId of cut 2 → frame center is blue; response cut = cut 2
 *     A2 Version number and project in data mirror remain unchanged before and after (activeCutId is
 *        still cut 1, no writes occurred)
 *     A3 Without cutId → frame center is red; response cut = cut 1
 *     A4 cutId does not exist → explicitly errors "Cut not found", listing existing ones
 *   B Editor page + project replica path (actually opens the editor, page writes project into local
 *     document service and binds it; Agent server executes on the replica, `seeFrames` in
 *     `agent-exec.mjs` - which is also what hosted cloud tier and account mode run before
 *     generating frames):
 *     B1 With cutId of cut 2 → blue; response cut = cut 2
 *     B2 Project in page store is still the same object, activeCutId is still cut 1, playhead has
 *        not moved; version number in document service remains unchanged (no writes occurred)
 *     B3 Without cutId → red
 *     B4 Legacy name `switch_cut` is not in tools manifest; `user_interface_switch_cut` is present
 *        (same source as MCP tools manifest `tools/list`)
 *
 * Generated images are saved in `--out` directory: A1-cut2.png, A3-cut1.png, B1-cut2.png,
 * B3-cut1.png (lead session needs to inspect images directly).
 * One line of PASS/FAIL per assertion, the last line prints a JSON line; exits with code 1 on
 * failure. Port `--port` and three consecutive numbers +1, +2 must all be free (do not touch
 * 5190-5192).
 * Start services with PROMPTCUT_NO_PORT_FILE=1, outputs land in temporary directory
 * (`PROMPTCUT_EXPORT_DIR` / `PROMPTCUT_DATA_DIR`), deleted after running; `--keep` does not close
 * or delete.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PNG } from 'pngjs';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(arg('--port', 5970));
const KEEP = argv.includes('--keep');
const OUT = path.resolve(arg('--out', path.join(ROOT, 'out', 'cut-look-probe')));
const EDITOR = `http://127.0.0.1:${PORT}`;
const EXPORT_DIR = path.join(os.tmpdir(), `pc-cut-look-probe-${Date.now().toString(36)}`);
const DATA_DIR = path.join(EXPORT_DIR, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
setTimeout(() => { console.error('SCRIPT_TIMEOUT'); cleanup(); process.exit(124); }, 15 * 60_000).unref();

const results = {};
const fails = [];
const check = (key, cond, note, extra) => {
  results[key] = { ok: !!cond, note, ...(extra !== undefined ? { extra } : {}) };
  if (!cond) fails.push(`${key}: ${note}${extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : ''}`);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${key} ${note}${extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : ''}`);
};

/* ---------- Temporary solid card ---------- */
const CARD_ID = 'cut-look-solid';
const CARD_FILE = path.join(ROOT, 'src', 'cards', 'user', `${CARD_ID}.tsx`);
const fixture = fs.readFileSync(path.join(ROOT, 'scripts', 'probes', 'fixtures', 'cloud-look', 'look-solid.tsx'), 'utf8');
const cardSource = fixture
  .replace('id: "look-solid"', `id: "${CARD_ID}"`)
  .replace('export const lookSolid', 'export const cutLookSolid')
  .replace('function LookSolid', 'function CutLookSolid')
  .replace('Component: LookSolid', 'Component: CutLookSolid');
if (fs.existsSync(CARD_FILE)) throw new Error(`${CARD_FILE} already exists, not overwriting`);
fs.writeFileSync(CARD_FILE, cardSource);

/* ---------- Project: cut 1 red (active), cut 2 blue (parked, stopped at 1s last time) ---------- */
const solid = (id, color) => ({ id, cardId: CARD_ID, start: 0, end: 4, params: { color } });
const project = (id) => ({
  version: 1, id, name: 'Look at the frames of another cut', width: 640, height: 360, fps: 30, duration: 4, themeId: 'midnight',
  media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [],
  tracks: [{ id: 'tr-1', name: 'Track 1', clips: [solid('red', '#ff0000')] }],
  cuts: [
    { id: 'cut-1', name: 'Cut 1' },
    { id: 'cut-2', name: 'Cut 2', t: 1, duration: 4, transitions: [], tracks: [{ id: 'tr-2', name: 'Track 1', clips: [solid('blue', '#0000ff')] }] },
  ],
  activeCutId: 'cut-1',
});

/* ---------- Tools ---------- */
const json = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) };
};
const postJson = (url, body) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function until(label, fn, timeoutMs = 120000, everyMs = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > deadline) { fails.push(`Timeout: ${label}`); console.log(`FAIL timeout: ${label}`); return null; }
    await delay(everyMs);
  }
}
function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}
/** Call a tool via local MCP endpoint (same path routed from server/mcp-server.mjs) */
const callTool = (tool, args) => postJson(`${EDITOR}/api/mcp/call`, { tool, args });
/** Pixel at center of frame + save image */
function centerOf(result, file) {
  const b64 = result?.__image?.base64;
  if (!b64) return null;
  const buf = Buffer.from(b64, 'base64');
  fs.writeFileSync(path.join(OUT, file), buf);
  const png = PNG.sync.read(buf);
  const i = ((png.height >> 1) * png.width + (png.width >> 1)) * 4;
  return { r: png.data[i], g: png.data[i + 1], b: png.data[i + 2], a: png.data[i + 3], w: png.width, h: png.height, file: path.join(OUT, file) };
}
const isBlue = (p) => !!p && p.b > 200 && p.r < 60 && p.g < 60;
const isRed = (p) => !!p && p.r > 200 && p.g < 60 && p.b < 60;

let editor = null;
const editorLog = [];
let browser = null;
function cleanup() {
  try { if (fs.existsSync(CARD_FILE)) fs.unlinkSync(CARD_FILE); } catch { /* Best effort */ }
  if (KEEP) return;
  if (editor && editor.exitCode === null && editor.pid) {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(editor.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else editor.kill('SIGKILL');
  }
}

const out = { port: PORT, out: OUT };
try {
  editor = spawn(process.execPath, [viteBin(), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, PROMPTCUT_EXPORT_DIR: EXPORT_DIR, PROMPTCUT_DATA_DIR: DATA_DIR, PROMPTCUT_NO_PORT_FILE: '1' } });
  const keep = (c) => { editorLog.push(c.toString()); if (editorLog.length > 400) editorLog.shift(); };
  editor.stdout.on('data', keep);
  editor.stderr.on('data', keep);
  await until('editor process is up', async () => (await fetch(`${EDITOR}/api/prerender/info`).then((r) => r.ok, () => false)) || null, 180000);
  const prerender = await until('prerender process ready', async () => { const i = await json(`${EDITOR}/api/prerender/info`); return i.body?.ready && i.body.url ? i.body.url : null; }, 240000);
  if (!prerender) throw new Error('The prerender process did not start');

  /* ================= A Mirror path ================= */
  const PA = project('cut-look-A');
  const pushed = await postJson(`${EDITOR}/api/data/project`, { session: 'cut-look-A', localRev: 1, project: PA });
  await postJson(`${EDITOR}/api/data/playhead`, { session: 'cut-look-A', t: 2, playing: false });
  check('A0', pushed.ok && pushed.body?.ok, 'Push the project to the data mirror', pushed.body);
  const before = await json(`${EDITOR}/api/data/project`);

  const a1 = await callTool('see_frames', { source: 'timeline', cutId: 'cut-2' });
  const a1px = centerOf(a1.body?.result, 'A1-cut2.png');
  check('A1', a1.body?.ok && isBlue(a1px) && a1.body.result?.cut?.id === 'cut-2' && a1.body.result.cut.name === 'Cut 2',
    'Mirror path: with Cut 1 active, see_frames with the cutId of Cut 2 returns Cut 2 (blue); the response names Cut 2', { px: a1px, cut: a1.body?.result?.cut, t: a1.body?.result?.t, error: a1.body?.error });
  const afterA = await json(`${EDITOR}/api/data/project`);
  check('A2', afterA.body?.localRev === before.body?.localRev && afterA.body?.project?.activeCutId === 'cut-1' && JSON.stringify(afterA.body?.project) === JSON.stringify(before.body?.project),
    'Mirror path: the version number of the data mirror and the project are both unchanged, and activeCutId is still Cut 1', { before: before.body?.localRev, after: afterA.body?.localRev, active: afterA.body?.project?.activeCutId });
  const a3 = await callTool('see_frames', { source: 'timeline', t: 1 });
  const a3px = centerOf(a3.body?.result, 'A3-cut1.png');
  check('A3', a3.body?.ok && isRed(a3px) && a3.body.result?.cut?.id === 'cut-1', 'Mirror path: without a cutId, it returns Cut 1 (red)', { px: a3px, cut: a3.body?.result?.cut, error: a3.body?.error });
  const a4 = await callTool('see_frames', { source: 'timeline', cutId: 'cut-9' });
  check('A4', a4.body?.ok === false && /Cut "cut-9" not found/.test(a4.body?.error ?? '') && /Cut 2\(cut-2\)/.test(a4.body?.error ?? ''), 'cutId does not exist: reports a clear error and lists the existing cuts', { error: a4.body?.error });

  /* ================= B Editor page + project replica path ================= */
  browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--force-device-scale-factor=1'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('dialog', (d) => { void d.dismiss(); });
  await page.goto(`${EDITOR}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForFunction(() => !!window.__pcStore, { timeout: 120_000 });
  await delay(3000);
  const PB = project(`cut-look-B-${Date.now().toString(36)}`);
  await page.evaluate((p) => { window.__pcStore.actions.loadProject(p); window.__pcStore.actions.seek(0.5); }, PB);
  const bound = await until('the page binds the project copy', async () => {
    const s = await json(`${EDITOR}/api/agent/status`);
    return s.body?.bound && s.body.projectId === PB.id && s.body.link?.replica?.hasBody === true ? s.body : null;
  }, 90_000, 500);
  out.bound = bound ? { mode: bound.mode, projectId: bound.projectId, rev: bound.link?.replica?.rev ?? null } : null;
  check('B0', !!bound, 'The editor wrote the project into the local document service and bound the project copy (the Agent server executes on the copy)', out.bound);
  await page.evaluate(() => { window.__probeProjectRef = window.__pcStore.getState().project; });
  // Version number of replica and how many times Agent committed (describe in agent-exec.mjs):
  // should not change before or after viewing frames
  const revOf = async () => { const s = await json(`${EDITOR}/api/agent/status`); return { rev: s.body?.link?.replica?.rev ?? null, committed: s.body?.stats?.committed ?? null }; };
  const rev0 = await revOf();

  const b1 = await callTool('see_frames', { source: 'timeline', cutId: 'cut-2' });
  const b1px = centerOf(b1.body?.result, 'B1-cut2.png');
  check('B1', b1.body?.ok && isBlue(b1px) && b1.body.result?.cut?.id === 'cut-2', 'Copy path: with the cutId of Cut 2, it returns Cut 2 (blue)', { px: b1px, cut: b1.body?.result?.cut, rev: b1.body?.result?.rev, error: b1.body?.error });
  const pageState = await page.evaluate(() => {
    const s = window.__pcStore.getState();
    return { same: s.project === window.__probeProjectRef, active: s.project.activeCutId, t: s.t };
  });
  const rev1 = await revOf();
  check('B2', pageState.same && pageState.active === 'cut-1' && Math.abs(pageState.t - 0.5) < 1e-6 && Number.isInteger(rev0.rev) && rev1.rev === rev0.rev && rev1.committed === rev0.committed && b1.body?.result?.rev === rev0.rev,
    'Copy path: the project in the page store is the same object, the active cut is still Cut 1, the playhead did not move; the document service version number is unchanged (nothing was written)', { ...pageState, rev0, rev1 });
  const b3 = await callTool('see_frames', { source: 'timeline', t: 1 });
  const b3px = centerOf(b3.body?.result, 'B3-cut1.png');
  check('B3', b3.body?.ok && isRed(b3px) && b3.body.result?.cut?.id === 'cut-1', 'Copy path: without a cutId, it returns Cut 1 (red)', { px: b3px, cut: b3.body?.result?.cut, error: b3.body?.error });

  const { tools } = await import('../../server/mcp-tools.mjs');
  const names = new Set(tools.map((t) => t.name));
  check('B4', !names.has('switch_cut') && names.has('user_interface_switch_cut') && !!tools.find((t) => t.name === 'see_frames')?.inputSchema?.properties?.cutId,
    'Tool manifest: no old name switch_cut, has user_interface_switch_cut; see_frames accepts cutId');
  out.pageErrors = pageErrors.slice(0, 5);
} catch (e) {
  fails.push(`Exception: ${e?.stack ?? e}`);
  console.log('FAIL exception', e?.stack ?? e);
  out.editorLogTail = editorLog.slice(-30).join('').slice(-3000);
} finally {
  try { await browser?.close(); } catch { /* Closed */ }
  cleanup();
  if (!KEEP) { try { fs.rmSync(EXPORT_DIR, { recursive: true, force: true }); } catch { /* Child process may still be holding it */ } }
}
console.log(JSON.stringify({ ok: fails.length === 0, fails, out, results }));
process.exit(fails.length ? 1 : 0);

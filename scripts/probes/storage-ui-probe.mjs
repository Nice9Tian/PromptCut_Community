/**
 * UI probe for start page "Storage" section and title bar "Storage…" (storage footprint plan
 * `docs/plan/storage-plan.md` section 6 "UI").
 * Run from the worktree root directory:
 *
 *   node scripts/probes/storage-ui-probe.mjs [--port 5720] [--out <screenshot directory>]
 *
 * Things started (all started by this probe and stopped upon completion): an editor dev server
 * (`--port`, also occupying +1 and +2 as stage ports; it spawns its own prerender process), and
 * headless Chrome. Export directory and data directory are located in system temporary directory,
 * pre-populated with 3 exports (one complete, one duplicate name in the same second without
 * project.json, one incomplete) and one `export-vision-*`; does not touch desktop app's
 * `Videos\PromptCut`, does not write public port.json.
 *
 * Assertions:
 *   U1 "Storage" section is present; 3 export list items (`export-vision-*` excluded), newest
 *      first; when `/api/storage` does not yet exist (storage-cap not merged), the cache row
 *      displays "Temporarily unavailable", with no page errors;
 *   U2 After "Delete intermediate files only", that export's size decreases, intermediate files
 *      column is gone, and only final video, transparent layer, and project.json remain on disk;
 *   U3 After "Delete" (confirmation dialog), one fewer export remains, and that directory is gone;
 *   U4 Clicking title bar "File → Storage…" on start page scrolls to "Storage"; clicking from
 *      editor (`?editor`) also returns to start page and scrolls to "Storage";
 *   U5 Simulates `/api/storage*` with interception: displays usage and cap; after "Clear cache",
 *      shows freed space and the number decreases; requests to update cap match echoes;
 *   U6 Endpoint path validation: `..` and `export-vision-*` return 400 (avoids clicking real
 *      "Open containing folder", which opens Explorer on desktop);
 *   U7 (After 3-branch merge) Without interception: real `/api/storage` and `/api/exports` both
 *      succeed; export column = list total (updates immediately after deleting an export or
 *      intermediate files only); page's real "Clear cache" and cap change persist to server (frame
 *      store and `storage.json` are both in temporary directory). U1 now requires cache row to
 *      display numbers;
 *   U8 (Runs first, takes ~60s longer) Writes batch of frames into frame store, waits 60s, then
 *      opens start page: displays old numbers while server measures in background
 *      (`scanning: true`), then page refetches every few seconds, displaying real value within a
 *      dozen seconds. Sizes always based on 1024 (GB = 1024³).
 * The last line of the output is a single JSON line (`ok`, `fails`), with screenshots in --out.
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { createTimings } from './probe-timings.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const PORT = Number(arg('--port', 5720));
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'storage-ui-shots')));
const ORIGIN = `http://127.0.0.1:${PORT}`;
fs.mkdirSync(OUT, { recursive: true });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-storage-ui-'));
const EXPORTS = path.join(TMP, 'exports');
const DATA = path.join(TMP, 'data');
fs.mkdirSync(DATA, { recursive: true });

const fails = [];
/** Elapsed time is only recorded (docs/semantics/guide_files/verification.md "Record elapsed time only, do not treat as gate"): how long it took for the start page's usage number to automatically update to the real value is only written to the TIMINGS line, and does not determine pass/fail */
const timingLog = createTimings('storage-ui-probe');
const out = { ok: false, out: OUT, tmp: TMP };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 20_000, every = 150) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for: ${what}`);
    await sleep(every);
  }
}

function put(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
}
const MB = 1024 * 1024;
function makeExport(id, { preview = 0, overlay = 0, frames = 0, parts = 0, project = null }) {
  const dir = path.join(EXPORTS, id);
  fs.mkdirSync(dir, { recursive: true });
  if (preview) put(path.join(dir, 'preview.mp4'), preview);
  if (overlay) put(path.join(dir, 'overlay.mov'), overlay);
  for (let i = 0; i < frames; i++) put(path.join(dir, 'frames', `${String(i).padStart(5, '0')}.png`), MB);
  if (parts) put(path.join(dir, 'parts', 'part-0.mov'), parts);
  if (project) fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project));
  return dir;
}
// One complete export (with intermediate files), one duplicate name in the same second without project.json, one incomplete export (leftover from cancellation or failure), and temporary directory for vision tools
const FULL = 'export-20260920-101500';
const DUP = 'export-20260920-101500-2';
const HALF = 'export-20260921-080000';
makeExport(FULL, { preview: 3 * MB, overlay: 20 * MB, frames: 12, parts: 8 * MB, project: { name: 'Probe project A', id: 'p-probe-a' } });
makeExport(DUP, { preview: 2 * MB, overlay: 5 * MB, frames: 3 });
makeExport(HALF, { frames: 6, parts: 4 * MB, project: { name: 'Probe project B', id: 'p-probe-b' } });
makeExport('export-vision-probe-1', { preview: MB, project: { name: 'Should not appear' } });

async function portFree(p) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

let vite = null;
async function stopTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const k = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    k.once('error', resolve);
    k.once('exit', resolve);
  });
}

let browser = null;
try {
  for (const p of [PORT, PORT + 1, PORT + 2]) if (!(await portFree(p))) throw new Error(`port ${p} is in use`);
  // vite's exports does not export bin/; locate via package directory (same as viteBin in server/vite-plugin-prerender.ts); dependencies resolve upward to the main repository
  const viteBin = path.join(path.dirname(createRequire(path.join(ROOT, 'package.json')).resolve('vite/package.json')), 'bin', 'vite.js');
  const log = [];
  vite = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT,
    env: { ...process.env, PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_EXPORT_DIR: EXPORTS, PROMPTCUT_DATA_DIR: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  vite.stdout.on('data', (b) => { log.push(String(b)); if (log.length > 40) log.shift(); });
  vite.stderr.on('data', (b) => { log.push(String(b)); if (log.length > 40) log.shift(); });
  await until('dev server returns 200', async () => {
    if (vite.exitCode !== null) throw new Error(log.join(''));
    const r = await fetch(ORIGIN + '/', { signal: AbortSignal.timeout(2000) });
    await r.body?.cancel();
    return r.status === 200;
  }, 120_000, 300);

  // After merge, `/api/storage*` is real (editor process forwards to prerender process): wait for the prerender process to start and respond before opening the page
  const storageJson = async (p, init) => {
    const r = await fetch(ORIGIN + p, { ...init, signal: AbortSignal.timeout(30_000) });
    const body = await r.json().catch(() => null);
    return { status: r.status, body };
  };
  await until('real /api/storage answers ok', async () => (await storageJson('/api/storage')).body?.ok === true, 180_000, 500);
  const exportsSum = async () => {
    const r = await storageJson('/api/exports');
    const items = r.body?.items ?? [];
    return { ok: r.body?.ok === true, bytes: items.reduce((s, it) => s + it.bytes, 0), count: items.length, intermediateBytes: items.reduce((s, it) => s + it.intermediateBytes, 0) };
  };

  browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--no-sandbox'] });
  const pageErrors = [];
  const newPage = async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 860 });
    page.on('pageerror', (e) => pageErrors.push(String(e?.message || e)));
    page.on('dialog', (d) => { void d.accept(); });
    return page;
  };
  const rows = (page) => page.$$eval('[data-pc="storage-export"]', (els) => els.map((el) => ({
    id: el.getAttribute('data-export-id'),
    text: el.textContent,
    bytes: el.querySelector('[data-pc="storage-export-bytes"]')?.textContent ?? '',
    mid: el.querySelector('[data-pc="storage-export-mid"]')?.textContent ?? '',
    prune: !!el.querySelector('[data-pc="storage-export-prune"]'),
  })));
  const inView = (page) => page.$eval('[data-pc="start-storage"]', (el) => {
    // Scrolled into view: title is in upper half of viewport, or "Storage" is last section and container has scrolled to bottom (cannot scroll any further)
    const r = el.getBoundingClientRect();
    const main = el.closest('.sp-main');
    const atBottom = !!main && main.scrollTop > 0 && main.scrollTop + main.clientHeight >= main.scrollHeight - 2;
    return r.top >= 0 && r.top < window.innerHeight && (r.top < window.innerHeight * 0.5 || atBottom);
  });

  // ── U8 Open start page right after writing a batch of frames: number updates to real value within a dozen seconds ──
  // The GET above waiting for readiness already triggered a server measurement; then write a batch of
  // frames to the frame store (as if prerender just finished), wait past 60s (`SUMMARY_STALE_MS`), then
  // open the start page: first response returns old number with scanning: true; page refetches on its
  // own every few seconds until real value is displayed. No /api/storage requests are sent during
  // this period.
  {
    const readyAt = Date.now();
    const batchKey = [...Array(64)].map((_, i) => '0123456789abcdef'[(i * 7 + 3) % 16]).join('');
    for (let i = 0; i < 5; i++) put(path.join(EXPORTS, 'frame-library', batchKey, 'mov', 'frames', `${String(i).padStart(6, '0')}.png`), MB);
    await sleep(Math.max(0, readyAt + 62_000 - Date.now()));
    const p8 = await newPage();
    const texts = [];
    const t0 = Date.now();
    await p8.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
    const first = await until('the cache row', () => p8.$eval('[data-pc="storage-cache-bytes"]', (el) => el.textContent).catch(() => null), 20_000);
    texts.push(first);
    const settled = await until('the number becomes the real value', async () => {
      const t = await p8.$eval('[data-pc="storage-cache-bytes"]', (el) => el.textContent);
      if (texts.at(-1) !== t) texts.push(t);
      return t.startsWith('5.0M') ? t : null;
    }, 120_000, 250).catch(() => null); // Wait timeout is only to prevent hangs (originally 20s)
    const elapsedMs = Date.now() - t0;
    const server = (await storageJson('/api/storage')).body?.frameLibrary;
    out.U8 = { first, settled, elapsedMs, texts, serverBytes: server?.bytes, scanning: server?.scanning };
    await p8.$eval('[data-pc="start-storage"]', (el) => el.scrollIntoView());
    await p8.screenshot({ path: path.join(OUT, 'u8-fresh-bytes.png') });
    await p8.close();
    check(!first.startsWith('5.0M'), 'U8 shows the stale number right after opening (proves the later value comes from an automatic re-fetch, not from a measurement that happened to be done already)', out.U8);
    timingLog.record('U8 from opening the start page to the usage number becoming the real value', settled ? elapsedMs : null, { formerLimit: '< 20 s' });
    check(!!settled, 'U8 automatically becomes the real value 5.0M (duration is only recorded)', out.U8);
    check(server?.bytes === 5 * MB && server?.scanning === false, 'U8 server finished measuring: 5 MB, scanning false', out.U8);
  }

  // ── U1 ──
  const page = await newPage();
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await until('"Storage" section', () => page.$('[data-pc="start-storage"]'));
  await until('export list', async () => (await rows(page)).length > 0);
  await until('the cache row', () => page.$('[data-pc="storage-cache-unavailable"], [data-pc="storage-cache-bytes"]'));
  const r1 = await rows(page);
  out.U1 = { rows: r1.map((r) => r.id) };
  check(JSON.stringify(r1.map((r) => r.id)) === JSON.stringify([HALF, DUP, FULL]), 'U1 the list has 3 entries, newest first, vision not listed', r1.map((r) => r.id));
  check(!r1.some((r) => r.text.includes('Should not appear')), 'U1 vision not listed');
  check(r1[0].text.includes('Unfinished') && r1[0].text.includes('Probe project B'), 'U1 the incomplete export is labeled "Unfinished"', r1[0].text);
  check(r1[1].text.includes('Unknown project'), 'U1 an export without project.json is listed as "Unknown project"', r1[1].text);
  check(r1[2].text.includes('Final video') && r1[2].text.includes('Transparent layer') && r1[2].text.includes('Intermediate files'), 'U1 the complete export lists the final video, transparent layer and intermediate files', r1[2].text);
  const unavailable = await page.$('[data-pc="storage-cache-unavailable"]');
  out.U1.storageApi = unavailable ? 'unavailable' : 'present';
  check(!unavailable, 'U1 after the merge, /api/storage is real and the cache row shows a number');
  if (unavailable) {
    check(await page.$eval('[data-pc="storage-clear-cache"]', (b) => b.disabled), 'U1 "Clear cache" is grayed out when the data cannot be fetched');
  }
  // U7a Real /api/storage and /api/exports: both ok; export column follows the same rules as the list (vision excluded), numbers match
  {
    const s = await storageJson('/api/storage');
    const e = await exportsSum();
    const f = s.body?.frameLibrary;
    out.U7 = { storage: s.body, exportsList: e, cacheText: await page.$eval('[data-pc="storage-cache-bytes"]', (el) => el.textContent).catch(() => null) };
    check(s.status === 200 && s.body?.ok === true, 'U7 GET /api/storage ok', s);
    check(e.ok, 'U7 GET /api/exports ok');
    check(f && Number.isFinite(f.bytes) && Number.isFinite(f.capBytes) && Number.isFinite(f.diskBytes) && ['default', 'user'].includes(f.capSource), 'U7 frameLibrary fields are all present', f);
    check(Number.isFinite(s.body?.leftovers?.bytes), 'U7 leftovers.bytes is a number', s.body?.leftovers);
    check(JSON.stringify(s.body?.exports) === JSON.stringify({ bytes: e.bytes, count: e.count, intermediateBytes: e.intermediateBytes }) && e.count === 3,
      'U7 the exports field of /api/storage = the total of the /api/exports list (3 exports, vision not counted)', { storage: s.body?.exports, list: e });
  }
  check(!(await page.$('[data-pc="storage-error"]')), 'U1 the page shows no error banner');
  await page.$eval('[data-pc="start-storage"]', (el) => el.scrollIntoView());
  await page.screenshot({ path: path.join(OUT, 'u1-storage.png') });

  // ── U2 Delete intermediate files only ──
  const beforeFull = r1.find((r) => r.id === FULL);
  await page.click(`[data-export-id="${FULL}"] [data-pc="storage-export-prune"]`);
  await until('notice for deleting intermediate files only', () => page.$eval('[data-pc="storage-notice"]', (el) => el.textContent.includes('Deleted intermediate files')));
  const r2 = await rows(page);
  const afterFull = r2.find((r) => r.id === FULL);
  out.U2 = { before: beforeFull.bytes, after: afterFull?.bytes, notice: await page.$eval('[data-pc="storage-notice"]', (el) => el.textContent) };
  check(afterFull && afterFull.bytes !== beforeFull.bytes && afterFull.mid === '' && !afterFull.prune, 'U2 the size shrinks and the intermediate files column is gone', out.U2);
  check(JSON.stringify(fs.readdirSync(path.join(EXPORTS, FULL)).sort()) === JSON.stringify(['overlay.mov', 'preview.mp4', 'project.json']), 'U2 only the final video, transparent layer and project.json remain on disk', fs.readdirSync(path.join(EXPORTS, FULL)));
  await page.screenshot({ path: path.join(OUT, 'u2-pruned.png') });

  // ── U3 Delete ──
  await page.click(`[data-export-id="${HALF}"] [data-pc="storage-export-delete"]`);
  await until('one fewer export after deletion', async () => (await rows(page)).length === 2);
  out.U3 = { rows: (await rows(page)).map((r) => r.id) };
  check(!fs.existsSync(path.join(EXPORTS, HALF)), 'U3 that export is gone from disk');
  check(fs.existsSync(path.join(EXPORTS, 'export-vision-probe-1')), 'U3 the vision directory is untouched');
  await page.screenshot({ path: path.join(OUT, 'u3-deleted.png') });
  // U7b After deleting an export or intermediate files only, /api/storage's export column updates immediately (does not return cache from 60s ago)
  {
    const s = await storageJson('/api/storage');
    const e = await exportsSum();
    out.U7.afterDelete = { storage: s.body?.exports, list: e };
    check(s.body?.ok === true && JSON.stringify(s.body?.exports) === JSON.stringify({ bytes: e.bytes, count: e.count, intermediateBytes: e.intermediateBytes }) && e.count === 2,
      'U7 after deleting and after deleting intermediate files only, the exports field matches the list', out.U7.afterDelete);
  }
  // U7c Real "Clear cache" and cap change (frame store and data directory are both in temporary directory)
  {
    const sent = [];
    const onReq = (req) => { if (req.url().includes('/api/storage/')) sent.push({ path: new URL(req.url()).pathname, body: req.postData() ?? null }); };
    page.on('request', onReq);
    await page.$eval('[data-pc="start-storage"]', (el) => el.scrollIntoView());
    await page.click('[data-pc="storage-clear-cache"]');
    await until('notice for the real cache clearing', () => page.$eval('[data-pc="storage-notice"]', (el) => el.textContent.includes('freed')), 60_000);
    out.U7.clearNotice = await page.$eval('[data-pc="storage-notice"]', (el) => el.textContent);
    out.U7.lastEvictText = await until('the last cleanup row', () => page.$eval('[data-pc="start-storage"]', (el) => (el.textContent.match(/Last[^,]*/) || [null])[0]), 10_000).catch(() => null);
    check(out.U7.lastEvictText?.startsWith('Last cache cleanup'), 'U7 a cache clear clicked by the user is not labeled "Auto cleanup"', out.U7.lastEvictText);
    await page.screenshot({ path: path.join(OUT, 'u7-real-cleared.png') });
    await page.$eval('[data-pc="storage-cap-input"]', (el) => { el.select(); });
    await page.type('[data-pc="storage-cap-input"]', '20');
    await page.click('[data-pc="storage-cap-save"]');
    await until('notice for the real cap change', () => page.$eval('[data-pc="storage-notice"]', (el) => el.textContent.includes('Cache limit changed')), 30_000);
    page.off('request', onReq);
    const capReq = sent.find((x) => x.path === '/api/storage/cap');
    const sentBytes = capReq ? JSON.parse(capReq.body || '{}').bytes : null;
    const after = await storageJson('/api/storage');
    out.U7.cap = { sentBytes, capBytes: after.body?.frameLibrary?.capBytes, capSource: after.body?.frameLibrary?.capSource, text: await page.$eval('[data-pc="storage-cache-bytes"]', (el) => el.textContent) };
    check(sent.some((x) => x.path === '/api/storage/clear-cache'), 'U7 clicking "Clear cache" sends the real request');
    check(sentBytes === 20 * 1024 ** 3 && after.body?.frameLibrary?.capBytes === sentBytes && after.body?.frameLibrary?.capSource === 'user', 'U7 the cap change reaches the server (entering 20 = 20 × 1024³ bytes, consistent with the server\'s GB)', out.U7.cap);
    check(/Cap 20\.0G/.test(out.U7.cap.text), 'U7 echoes "Cap 20.0G"', out.U7.cap.text);
    check(/Cap 50\.0G \(default\)/.test(out.U7.cacheText ?? ''), 'U7 the default cap shows as 50.0G (not 46.6G)', out.U7.cacheText);
    check(fs.existsSync(path.join(DATA, 'storage.json')), 'U7 the cap is written to storage.json in the temporary data directory');
    await page.screenshot({ path: path.join(OUT, 'u7-real-cap.png') });
  }

  // ── U4 Title bar "Storage…" ──
  await page.$eval('.sp-main', (el) => { el.scrollTop = 0; });
  await sleep(100);
  check(!(await inView(page)), 'U4 precondition: after scrolling back to the top, "Storage" is not in the upper half of the view');
  const openStorageFromMenu = async (p) => {
    await p.click('.pc-titlebar-menu-button');
    await until('menu item "Storage…"', () => p.$('[data-pc="titlebar-open-storage"]'));
    await p.click('[data-pc="titlebar-open-storage"]');
  };
  await openStorageFromMenu(page);
  out.U4 = { fromStart: await until('scroll to "Storage" on the start page', () => inView(page), 5000).catch(() => false) };
  check(out.U4.fromStart, 'U4 clicking "Storage…" on the start page scrolls to "Storage"');
  await page.screenshot({ path: path.join(OUT, 'u4-menu-from-start.png') });

  const ed = await newPage();
  await ed.goto(ORIGIN + '/?editor', { waitUntil: 'domcontentloaded' });
  await until('editor', () => ed.$('.pc-bar--main'), 60_000);
  await sleep(1500);
  await openStorageFromMenu(ed);
  await until('back to the start page', () => ed.$('[data-pc="start-storage"]'), 15_000);
  out.U4.fromEditor = await until('scroll to "Storage" after returning from the editor', () => inView(ed), 8000).catch(() => false);
  check(out.U4.fromEditor, 'U4 clicking "Storage…" in the editor returns to the start page and scrolls to "Storage"');
  await sleep(1700); // Still present after 1.5s of smooth scrolling has passed
  out.U4.fromEditorSettled = await inView(ed);
  check(out.U4.fromEditorSettled, 'U4 "Storage" is still in view after the sections above finish loading');
  await ed.screenshot({ path: path.join(OUT, 'u4-menu-from-editor.png') });
  await ed.close();

  // ── U5 Simulate /api/storage* ──
  // "Storage" section matches server with GB = 1024³: default 50 GB displays as 50.0G; entering 20
  // sends 20 × 1024³
  const GB = 1024 ** 3;
  const mock = { bytes: 12 * GB, capBytes: 50 * GB, capSource: 'default', diskBytes: 931 * GB };
  const sent = [];
  const mp = await newPage();
  await mp.setRequestInterception(true);
  mp.on('request', (req) => {
    const u = new URL(req.url());
    const json = (body) => req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (u.pathname === '/api/storage' && req.method() === 'GET') {
      return json({ ok: true, frameLibrary: { ...mock, pinnedBytes: GB, scannedAt: Date.now(), lastEvict: { at: Date.now() - 3600_000, freedBytes: 2 * GB, removed: 3, skipped: 0 } }, exports: { bytes: 0, count: 0, intermediateBytes: 0 }, leftovers: { bytes: 0 } });
    }
    if (u.pathname === '/api/storage/clear-cache' && req.method() === 'POST') {
      sent.push({ path: u.pathname });
      const freed = 9 * GB;
      mock.bytes -= freed;
      return json({ ok: true, freedBytes: freed, removed: 40, skipped: 0 });
    }
    if (u.pathname === '/api/storage/cap' && req.method() === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      sent.push({ path: u.pathname, body, type: req.headers()['content-type'] });
      mock.capBytes = body.bytes;
      mock.capSource = 'user';
      return json({ ok: true, capBytes: body.bytes });
    }
    return req.continue();
  });
  await mp.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await until('cache usage', () => mp.$('[data-pc="storage-cache-bytes"]'));
  const fig0 = await mp.$eval('[data-pc="storage-cache-bytes"]', (el) => el.textContent);
  await mp.$eval('[data-pc="start-storage"]', (el) => el.scrollIntoView());
  await mp.screenshot({ path: path.join(OUT, 'u5-storage-mocked.png') });
  await mp.click('[data-pc="storage-clear-cache"]');
  await until('notice for clearing the cache', () => mp.$eval('[data-pc="storage-notice"]', (el) => el.textContent.includes('freed')));
  const notice = await mp.$eval('[data-pc="storage-notice"]', (el) => el.textContent);
  const fig1 = await until('the number gets smaller', async () => {
    const t = await mp.$eval('[data-pc="storage-cache-bytes"]', (el) => el.textContent);
    return t !== fig0 ? t : null;
  });
  await mp.screenshot({ path: path.join(OUT, 'u5-cleared.png') });
  await mp.$eval('[data-pc="storage-cap-input"]', (el) => { el.select(); });
  await mp.type('[data-pc="storage-cap-input"]', '20');
  await mp.click('[data-pc="storage-cap-save"]');
  await until('notice for changing the cap', () => mp.$eval('[data-pc="storage-notice"]', (el) => el.textContent.includes('Cache limit changed')));
  const fig2 = await mp.$eval('[data-pc="storage-cache-bytes"]', (el) => el.textContent);
  // Does not send if below 5 GB
  await mp.$eval('[data-pc="storage-cap-input"]', (el) => { el.select(); });
  await mp.type('[data-pc="storage-cap-input"]', '2');
  await mp.click('[data-pc="storage-cap-save"]');
  await until('range notice', () => mp.$eval('[data-pc="storage-error"]', (el) => el.textContent.includes('5 GB')));
  out.U5 = { fig0, notice, fig1, fig2, sent };
  check(fig0.includes('12.0G') && fig0.includes('50.0G') && fig0.includes('default'), 'U5 shows usage and cap', fig0);
  check(notice.includes('9.0G'), 'U5 shows how much was freed after clearing', notice);
  check(fig1.includes('3.0G'), 'U5 the number gets smaller after clearing', fig1);
  check(fig2.includes('20.0G') && !fig2.includes('default'), 'U5 echoes after changing the cap', fig2);
  const capReqs = sent.filter((s) => s.path === '/api/storage/cap');
  check(capReqs.length === 1 && capReqs[0].body.bytes === 20 * GB && /application\/json/.test(capReqs[0].type || ''), 'U5 changing the cap sends only one request, with the right byte count and content type', capReqs);
  await mp.screenshot({ path: path.join(OUT, 'u5-cap.png') });
  await mp.close();

  // ── U6 Endpoint path validation ──
  const post = (p) => page.evaluate(async (u) => { const r = await fetch(u, { method: 'POST' }); return r.status; }, p);
  out.U6 = {
    dotdot: await post('/api/exports/..%2F..%2Fdata/delete'),
    vision: await post('/api/exports/export-vision-probe-1/delete'),
    visionReveal: await post('/api/exports/export-vision-probe-1/reveal'),
    missing: await post('/api/exports/export-20200101-000000/prune'),
  };
  check(out.U6.dotdot === 400 && out.U6.vision === 400 && out.U6.visionReveal === 400 && out.U6.missing === 404, 'U6 path validation', out.U6);
  check(fs.existsSync(path.join(EXPORTS, 'export-vision-probe-1')), 'U6 the vision directory is untouched');

  out.pageErrors = pageErrors;
  check(pageErrors.length === 0, 'Page has no uncaught errors', pageErrors);
} catch (e) {
  fails.push(`Probe itself failed: ${e?.stack || e}`);
} finally {
  await browser?.close().catch(() => {});
  await stopTree(vite);
  await sleep(500);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Even if kept, stays in temporary directory */ }
}
out.fails = fails;
out.ok = fails.length === 0;
timingLog.print();
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);

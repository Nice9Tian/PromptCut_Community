/**
 * C6.6 live probe for two-tier assets and upload queue (`docs/plan/c66-design.md` sections 2 and 3,
 * acceptance checks T1 and T3).
 *
 * Launch two real editors (this checkout, vite):
 *   - **R**: acts only as "remote asset service", port `--port-r` (default 5563);
 *   - **A**: importer, port `--port-a` (default 5560), `PROMPTCUT_ASSET_URL` points to R's asset
 *     service: the upload queue target is R.
 * Both use a temporary `PROMPTCUT_EXPORT_DIR` / `PROMPTCUT_DATA_DIR`, leaving this checkout's out/
 * and user data directory untouched.
 *
 * Generate three assets live with ffmpeg (section 8 "Test assets"):
 *   1. 1080p MP4 with audio track, moov at the end (ffmpeg's default for MP4, ~17 MB, 3 clips);
 *   2. ProRes 422 HQ MOV (10 bit, no audio track);
 *   3. 640×360 H.264 MP4, deliberately omitting `+faststart` (delayed moov).
 * Import into A sequentially using the same request as page import
 * (`POST /api/media/upload/<name>?tiers=1`), then verify:
 *   - Remux: all three lack faststart and are remuxed; new hash ≠ source file sha256; the
 *     original-size asset in the library has moov at front, stream codecs match source file;
 *   - Small-size asset: A's `GET /api/media/tiers` reports ready; small-size asset ≤ 800×600,
 *     H.264, faststart; no upscaling;
 *   - Queue: A's upload queue cleared; log order is "per-asset, small tier first"
 *     (`upload.tier-start` / `tier-done` / `item-done`);
 *   - `chunks` for all six hashes (three assets × two tiers) on R each have `complete: true`, and
 *     retrieved byte sha256 matches;
 *   - T4 (added in C6.6 integration): open an editor page on A; edit once every 120 ms during import,
 *     transcode, and upload; `PerformanceObserver('longtask')` records 0 long tasks > 50 ms in this
 *     window (raw entries in `t4.longtasks`).
 *
 *   node scripts/probes/tiers-probe.mjs [--port-a 5560] [--port-r 5563] [--timeout-min 6] [--keep]
 *                                       [--cpu-throttle <factor>] [--trace <file.json>]
 *
 * Two flags for profiling only (both off by default, do not affect T4 judgment):
 *   --cpu-throttle N  Throttle the page by N times via CDP `Emulation.setCPUThrottlingRate` before
 *                     the T4 control window begins (simulating a slow machine on a fast one);
 *   --trace file      Record a Chrome trace (including V8 samples) from start of T4 control window
 *                     until upload queue is empty and write it to this file; DevTools Performance
 *                     panel can open it, and `scripts/probes/longtask-stacks.mjs` can summarize
 *                     call stacks in long tasks.
 *
 * Ports: each editor additionally takes "port + 1" and "port + 2" as stage ports; all three
 * consecutive ports must be free (A 5560~5562, R 5563~5565); the prerender process launched by the
 * editor itself is assigned a free port by the system (`vite-plugin-prerender.ts`). On exit, only
 * the process tree started by this probe is terminated.
 * The last line of output is a single line of JSON: `{ ok, imports, queueOrder, remote, t4, fails }`.
 */
import '../lib/no-user-dirs.mjs'; // First import: does not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR; outputs do not land in the user's Videos\PromptCut
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const PORT_A = Number(arg('--port-a', 5560));
const PORT_R = Number(arg('--port-r', 5563));
const TIMEOUT_MS = Number(arg('--timeout-min', 6)) * 60_000;
const KEEP = args.includes('--keep');
const CPU_THROTTLE = Number(arg('--cpu-throttle', 0));
const TRACE_FILE = arg('--trace', null);
const STAMP = Date.now().toString(36);
const WORK = path.join(os.tmpdir(), `pc-tiers-probe-${STAMP}`);

const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return cond; };
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
async function until(label, fn, timeoutMs = 120_000, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`Timeout: ${label}`); return null; }
    await delay(everyMs);
  }
}
function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fsSync.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}
function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGKILL');
}
const portFree = async (port) => {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
};
const ff = (argv) => {
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-v', 'error', ...argv], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
};
const ffprobe = (file) => JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { windowsHide: true, encoding: 'utf8' }).stdout);

const children = [];
async function startEditor(label, port, extraEnv) {
  const exportDir = path.join(WORK, label);
  await fs.mkdir(path.join(exportDir, 'data'), { recursive: true });
  const env = { ...process.env, PROMPTCUT_EXPORT_DIR: exportDir, PROMPTCUT_DATA_DIR: path.join(exportDir, 'data'), PROMPTCUT_STREAMS: '0', ...extraEnv };
  for (const name of ['PROMPTCUT_QUEUE_NODE', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_SHARED_CONFIG', 'PROMPTCUT_PUSH', 'PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_HEADLESS']) delete env[name];
  if (!extraEnv.PROMPTCUT_ASSET_URL) delete env.PROMPTCUT_ASSET_URL;
  const editor = spawn(process.execPath, [viteBin(), '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  children.push(editor);
  const log = [];
  let partial = '';
  const keep = (c) => {
    const lines = (partial + c.toString()).split(/\r?\n/);
    partial = lines.pop();
    for (const line of lines) { log.push(line); if (log.length > 4000) log.shift(); }
  };
  editor.stdout.on('data', keep); editor.stderr.on('data', keep);
  const origin = `http://127.0.0.1:${port}`;
  await until(`[${label}] editor is up`, async () => (await fetch(`${origin}/api/media/upload-queue`).then((r) => r.ok, () => false)) || null, 120_000);
  return { label, origin, exportDir, log };
}

const out = { ports: { a: PORT_A, r: PORT_R }, work: WORK };
let ok = false;
let browser = null;
try {
  for (const p of [PORT_A, PORT_A + 1, PORT_A + 2, PORT_R, PORT_R + 1, PORT_R + 2]) if (!(await portFree(p))) throw new Error(`Port ${p} is in use`);
  const { faststartState } = await import(pathToFileURL(path.join(ROOT, 'server', 'media-tiers.mjs')).href);

  // ---- Assets ----
  const fx = path.join(WORK, 'fixtures');
  await fs.mkdir(fx, { recursive: true });
  const SOURCES = [
    { name: 'probe-1080p.mp4', file: path.join(fx, 'probe-1080p.mp4'), make: (f) => ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '4', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f]) },
    { name: 'probe-prores.mov', file: path.join(fx, 'probe-prores.mov'), make: (f) => ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '3', '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-an', f]) },
    { name: 'probe-late-moov.mp4', file: path.join(fx, 'probe-late-moov.mp4'), make: (f) => ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '3', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-an', f]) },
  ];
  for (const s of SOURCES) {
    s.make(s.file);
    s.sha = sha(await fs.readFile(s.file));
    s.faststart = await faststartState(s.file);
    s.codecs = ffprobe(s.file).streams.map((x) => `${x.codec_type}:${x.codec_name}`);
    check(s.faststart === 'needs', `${s.name} should lack faststart`, s.faststart);
  }

  // ---- Two editors ----
  const R = await startEditor('r', PORT_R, {});
  const A = await startEditor('a', PORT_A, { PROMPTCUT_ASSET_URL: `http://127.0.0.1:${PORT_R}/api/asset` });
  if (!R || !A) throw new Error('Editor did not start');
  const q0 = await (await fetch(`${A.origin}/api/media/upload-queue`)).json();
  check(q0.target?.base === `http://127.0.0.1:${PORT_R}/api/asset`, 'A\'s upload target is R', q0.target);

  // ---- T4 (design doc section 6): page editing continues during background import, transcode, and
  // upload; main thread has no long tasks > 50 ms ----
  // Open an editor page on A (?nosetup=1 does not show first-launch dialog), wait for measurement
  // overlay on project open to dismiss, then let sit for 5 s,
  // then attach PerformanceObserver('longtask'), and perform an edit every 120 ms (scrub playhead,
  // move clip, change parameters, change tab).
  // Window = first import request sent → upload queue cleared; long tasks in window recorded as-is into
  // out.t4.
  const { default: puppeteer } = await import('puppeteer');
  const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
  browser = await puppeteer.launch({ headless: true, defaultViewport: { width: 1440, height: 900 }, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e).slice(0, 300)));
  await page.goto(`${A.origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded' });
  await until('[a] page and stage are up', () => page.evaluate(() => document.querySelectorAll('iframe').length >= 2), 300_000);
  // Measurement overlay appears ~3 s after page comes up (docs/archive/agent-reports/AGENT-perf-t4.md
  // "Not done and suggestions" item 3): waiting only for "no overlay" would let it pass before it
  // appears, overlapping measurement with subsequent idle and control windows. So wait first for
  // measurement to start (overlay appears, or probeRunner reports running), then wait for it to end
  // (overlay dismisses and no longer running). When project has no cards to measure, measurement does
  // not start at all: proceed normally if not seen after full GATE_APPEAR_MS.
  const gateState = () => page.evaluate(async () => {
    const gate = !!document.querySelector('[data-pc="probe-gate"]');
    let running = false;
    try { running = !!(await import('/src/editor/probeRunner.ts')).probeProgress().running; } catch { /* Fall back to checking only the overlay if unavailable */ }
    return { gate, running };
  });
  const GATE_APPEAR_MS = 30_000;
  const gateSeen = await until('[a] measurement starts (overlay appears)', async () => { const s = await gateState(); return s.gate || s.running ? s : null; }, GATE_APPEAR_MS, 100);
  if (gateSeen) {
    await until('[a] measurement ends, overlay goes away', async () => { const s = await gateState(); return !s.gate && !s.running; }, 300_000, 200);
    out.probeGate = 'shown-then-gone';
  } else {
    if (fails.at(-1) === 'Timeout: [a] measurement starts (overlay appears)') fails.pop(); // Not seeing overlay is not a failure: this project has no cards to measure
    out.probeGate = 'never-shown';
  }
  // Reset upload target to default when page opens ({ base: null } → PROMPTCUT_ASSET_URL): target is still R
  await delay(5000);
  const q1 = await (await fetch(`${A.origin}/api/media/upload-queue`)).json();
  check(q1.target?.base === `http://127.0.0.1:${PORT_R}/api/asset`, 'After the page opens, A\'s upload target is still R (null falls back to the default target)', q1.target);
  if (CPU_THROTTLE > 1) {
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
    out.cpuThrottle = CPU_THROTTLE;
  }
  if (TRACE_FILE) {
    await page.tracing.start({ path: path.resolve(TRACE_FILE), categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'disabled-by-default-v8.cpu_profiler', 'blink.user_timing', 'toplevel'] });
  }
  await page.evaluate(() => {
    window.__pcLong = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__pcLong.push({ at: Math.round(performance.timeOrigin + e.startTime), ms: Math.round(e.duration), name: e.name,
          attr: (e.attribution ?? []).map((a) => a.containerSrc || a.containerType || a.name).join(',') });
      }
    }).observe({ type: 'longtask' });
    window.__pcEdits = 0;
    window.__pcEditErrors = 0;
    window.__pcEditing = true;
    void (async () => {
      const S = await import('/src/store/project.ts');
      for (let i = 0; window.__pcEditing; i++) {
        try {
          const clips = S.getState().project.tracks.flatMap((t) => t.clips);
          const c = clips[i % Math.max(1, clips.length)];
          const d = (i % 8) < 4 ? 0.1 : -0.1;
          const kind = ['seek', 'move', 'params', 'label'][i % 4];
          const t = performance.now();
          if (kind === 'seek') S.actions.seek((i * 0.37) % 18);
          else if (kind === 'move' && c) S.actions.moveClip(c.id, { start: c.start + d, end: c.end + d });
          else if (kind === 'params' && c?.cardId) S.actions.setClipParams(c.id, { text: `T4-${i}` });
          else if (c) S.actions.updateClip(c.id, { label: `T4 ${i}` });
          (window.__pcEditLog ??= []).push({ at: Math.round(performance.timeOrigin + t), kind, syncMs: Math.round(performance.now() - t) });
          performance.mark(`pc:edit:${kind}`);
          window.__pcEdits++;
        } catch { window.__pcEditErrors++; }
        await new Promise((r) => setTimeout(r, 120));
      }
    })();
  });
  // Control window: identical edits without import or upload, run for 3 s first: distinguishes
  // whether long tasks come from editing itself or background upload
  const baseStart = Date.now();
  await delay(3000);
  const t4Start = Date.now();
  await page.evaluate(() => performance.mark("pc:upload-window")).catch(() => {});

  // ---- Import (same request as the page) ----
  out.imports = [];
  for (const s of SOURCES) {
    const t0 = Date.now();
    const res = await fetch(`${A.origin}/api/media/upload/${encodeURIComponent(s.name)}?tiers=1`, { method: 'POST', body: await fs.readFile(s.file) });
    const body = await res.json();
    s.body = body;
    s.importMs = Date.now() - t0;
  }
  // ---- Small-size asset ----
  const hashes = SOURCES.map((s) => s.body.hash);
  const tiers = await until('All asset small sizes generated', async () => {
    const j = await (await fetch(`${A.origin}/api/media/tiers?hashes=${hashes.join(',')}`)).json();
    return hashes.every((h) => j.items[h]?.state && j.items[h].state !== 'pending') ? j.items : null;
  }, TIMEOUT_MS);
  const dl = path.join(WORK, 'dl');
  await fs.mkdir(dl, { recursive: true });
  for (const s of SOURCES) {
    const b = s.body;
    const rec = tiers?.[b.hash] ?? {};
    const row = { name: s.name, src: s.sha.slice(0, 12), original: b.hash?.slice(0, 12), small: rec.small?.slice(0, 12) ?? null, remux: b.remux?.state, smallState: rec.state, importMs: s.importMs };
    check(b.ok === true && b.tiers?.original === b.hash, `${s.name} response has tiers.original`, b);
    check(b.remux?.state === 'remuxed' && b.remux.from === s.sha && b.hash !== s.sha, `${s.name} remuxed, stored under the output hash`, b.remux);
    // Original-size asset: retrieved from A, moov at front, codecs match source file
    const origFile = path.join(dl, `${b.hash}.${b.ext}`);
    const origBytes = Buffer.from(await (await fetch(`${A.origin}/@media/${b.hash}`)).arrayBuffer());
    await fs.writeFile(origFile, origBytes);
    row.originalFaststart = await faststartState(origFile);
    row.originalCodecs = ffprobe(origFile).streams.map((x) => `${x.codec_type}:${x.codec_name}`);
    check(sha(origBytes) === b.hash, `${s.name} asset original size bytes match the hash`);
    check(row.originalFaststart === 'faststart', `${s.name} asset original size has moov at the front`, row.originalFaststart);
    check(JSON.stringify(row.originalCodecs) === JSON.stringify(s.codecs), `${s.name} asset original size codecs unchanged`, { src: s.codecs, got: row.originalCodecs });
    // Small-size asset
    check(rec.state === 'ready' && /^[0-9a-f]{64}$/.test(rec.small ?? ''), `${s.name} asset small size ready`, rec);
    if (rec.small) {
      const smallFile = path.join(dl, `${rec.small}.mp4`);
      await fs.writeFile(smallFile, Buffer.from(await (await fetch(`${A.origin}/@media/${rec.small}`)).arrayBuffer()));
      const v = ffprobe(smallFile).streams.find((x) => x.codec_type === 'video');
      const srcV = ffprobe(s.file).streams.find((x) => x.codec_type === 'video');
      row.smallSize = `${v.width}x${v.height}`;
      row.smallCodec = v.codec_name;
      row.smallFaststart = await faststartState(smallFile);
      check(v.codec_name === 'h264', `${s.name} asset small size is H.264`, v.codec_name);
      check(v.width <= 800 && v.height <= 600 && v.width % 2 === 0 && v.height % 2 === 0, `${s.name} asset small size ≤ 800×600 with even dimensions`, row.smallSize);
      check(v.width <= srcV.width && v.height <= srcV.height, `${s.name} asset small size is not upscaled`, row.smallSize);
      check(row.smallFaststart === 'faststart', `${s.name} asset small size faststart`, row.smallFaststart);
    }
    out.imports.push(row);
  }

  // ---- Upload queue: empty, order ----
  await until('A\'s upload queue is drained', async () => {
    const j = await (await fetch(`${A.origin}/api/media/upload-queue`)).json();
    return j.queue && j.queue.items.length === 0 && !j.queue.working ? j : null;
  }, TIMEOUT_MS, 100);
  const t4End = Date.now();
  if (TRACE_FILE) { await page.tracing.stop(); out.trace = path.resolve(TRACE_FILE); }
  const t4 = await page.evaluate(() => { window.__pcEditing = false; return { long: window.__pcLong, edits: window.__pcEdits, editErrors: window.__pcEditErrors, log: window.__pcEditLog ?? [] }; });
  // Which kind of edit was most recent before each long task (editing itself slow, or unrelated to editing)
  const withEdit = (e) => { const prev = t4.log.filter((x) => x.at <= e.at + 1).at(-1); return { ...e, afterEdit: prev ? { kind: prev.kind, dtMs: e.at - prev.at, syncMs: prev.syncMs } : null }; };
  const inWindow = t4.long.filter((e) => e.at + e.ms >= t4Start && e.at <= t4End).map(withEdit);
  const inBase = t4.long.filter((e) => e.at + e.ms >= baseStart && e.at < t4Start).map(withEdit);
  const editsIn = (a, b) => t4.log.filter((x) => x.at >= a && x.at <= b);
  const bySyncKind = (list) => Object.fromEntries(['seek', 'move', 'params', 'label'].map((k) => { const xs = list.filter((x) => x.kind === k).map((x) => x.syncMs); return [k, xs.length ? { n: xs.length, maxSyncMs: Math.max(...xs) } : null]; }));
  out.t4 = {
    windowMs: t4End - t4Start, edits: editsIn(t4Start, t4End).length, editErrors: t4.editErrors,
    longtasks: inWindow, longtasksOver50: inWindow.filter((e) => e.ms > 50).length,
    baseline: { windowMs: t4Start - baseStart, edits: editsIn(baseStart, t4Start).length, longtasks: inBase, longtasksOver50: inBase.filter((e) => e.ms > 50).length },
    editSync: bySyncKind(t4.log), pageErrors,
  };
  check(out.t4.edits >= Math.floor(out.t4.windowMs / 200), 'T4 editing continues throughout the window', { edits: out.t4.edits, windowMs: out.t4.windowMs });
  check(out.t4.longtasksOver50 === 0, 'T4 no long tasks > 50 ms on the page main thread during background upload', inWindow);
  const short = (h) => {
    for (const s of SOURCES) {
      if (h === s.body.hash) return `${s.name}:original`;
      if (h === tiers?.[s.body.hash]?.small) return `${s.name}:small`;
    }
    return h.slice(0, 8);
  };
  const events = [];
  for (const line of A.log) {
    const m = /\[media-tiers\] (upload\.(?:tier-start|tier-done|item-done|retry)) (\{.*\})$/.exec(line);
    if (!m) continue;
    const f = JSON.parse(m[2]);
    events.push(m[1] === 'upload.item-done' ? `item-done ${short(f.id)}` : `${m[1].slice(7)} ${short(f.hash ?? f.id)}`);
  }
  out.queueOrder = events;
  const expected = SOURCES.flatMap((s) => [`tier-start ${s.name}:small`, `tier-done ${s.name}:small`, `tier-start ${s.name}:original`, `tier-done ${s.name}:original`, `item-done ${s.name}:original`]);
  check(JSON.stringify(events) === JSON.stringify(expected), 'Queue order: one asset at a time, small first then large', events);

  // ---- Both tiers complete separately on R ----
  out.remote = {};
  for (const s of SOURCES) {
    for (const [tier, h] of [['small', tiers?.[s.body.hash]?.small], ['original', s.body.hash]]) {
      if (!h) continue;
      const c = await (await fetch(`${R.origin}/api/asset/media/${h}/chunks`)).json();
      const bytes = Buffer.from(await (await fetch(`${R.origin}/api/asset/media/${h}`)).arrayBuffer());
      out.remote[`${s.name}:${tier}`] = { complete: c.complete, chunks: c.received.length, shaOk: sha(bytes) === h };
      check(c.complete === true && sha(bytes) === h, `On R, ${s.name} ${tier} is complete and its bytes match`, c);
    }
  }
  ok = fails.length === 0;
} catch (err) {
  fails.push(`Exception: ${err?.stack ?? err}`);
} finally {
  try { await browser?.close(); } catch { /* Already closed */ }
  for (const c of children) killTree(c);
  if (!KEEP) await fs.rm(WORK, { recursive: true, force: true }).catch(() => {});
}
console.log(JSON.stringify({ ok, ...out, fails }));
process.exit(ok ? 0 : 1);

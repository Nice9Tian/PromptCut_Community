/**
 * Visual cost identity of audio motion cards (visual is a component with separate `audio()`, like
 * `av-pulse`): automatic, immediate catch-up measurement, not classified as heavy by default
 * (user decision, 2026-10-06).
 * Real-browser probe on desktop side, entirely local: probe starts its own dev server, connects
 * to no hosted side, outputs no sound to speakers (headless Chrome, `--mute-audio`).
 *
 * Two usages:
 *
 *   # 1. Single run: arrange project (or load project left from another pass) -> wait for measurement
 *        -> verify -> export final video from editor page export entry
 *   node scripts/probes/av-card-cost-probe.mjs run --out <dir> [--kind av|plain] [--project <project.json from another pass>]
 *        [--tree <repo root, default this repo>] [--port 5720] [--expect light|legacy]
 *
 *   # 2. Frame-by-frame comparison of final videos from two passes (ffmpeg decodes to raw pixels, per-frame sha256)
 *   node scripts/probes/av-card-cost-probe.mjs compare --a <dir A> --b <dir B>
 *
 * `--tree` pointing to another checkout (pre-change commit) allows running same project on that
 * code, then comparing final videos on both sides with `compare`.
 * Ports: dev server occupies three consecutive ports starting from `--port` (editor page plus two stages).
 * Data directories are all under `--out`.
 *
 * Acceptance criteria (one `{ check, ok }` line per item, final line `{ summary }`, exit code 1 on failure):
 *
 * `run --kind av --expect light` (post-change code):
 *   V1 Audio motion card clip has cost identity and declared frame mode;
 *   V2 Measured on first appearance: present in measurement log, cost record written by its identity key;
 *   V3 Silent during measurement: from opening page to measurement completion, no new audio context
 *      created, no elements start playing, no sound sources started;
 *   V4 Classified as light after measurement: light in its position in dispatch table, not in prerender set;
 *   V5 Live render: not in suppressed set when playing to its position, live component inside its
 *      wrapper layer on stage, no placeholder shown, page has no "Requires local PC render assistance";
 *   V6 Reopening does not re-measure: refresh page and load the same project, absent from measurement log;
 *   V7 Export succeeds, final video file exists.
 * `run --expect legacy` (pre-change code, only kept for comparison, not counted as acceptance): record
 * whether audio motion card has identity, classified as light or heavy.
 * `run --kind plain`: project without audio motion cards, only does export (V7).
 * `compare`:
 *   C1 Frame count and per-frame sha256 match for every final video file on both sides.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { findFfmpeg } from '../../server/bakery/ffmpeg.mjs';

const argv = process.argv.slice(2);
const MODE = argv[0];
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const results = [];
const check = (name, ok, detail = {}) => { results.push({ check: name, ok: !!ok }); console.log(JSON.stringify({ check: name, ok: !!ok, detail }).slice(0, 2400)); return !!ok; };
const note = (name, detail = {}) => console.log(JSON.stringify({ note: name, detail }).slice(0, 2400));
const log = (...a) => console.error('[av-card-cost]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 60_000, every = 200) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (e) { last = String(e?.message ?? e); }
    if (v) return v;
    if (Date.now() - t0 > ms) { check(`Waited for: ${what}`, false, { last }); return null; }
    await sleep(every);
  }
}

const cleanups = [];
let exitCode = 1;
try {
  if (MODE === 'run') await run();
  else if (MODE === 'compare') await compare();
  else throw new Error('Usage is in the file header: run or compare');
  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ summary: { mode: MODE, checks: results.length, passed: results.length - failed.length, fails: failed.map((r) => r.check) } }));
  exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.log(JSON.stringify({ summary: { mode: MODE, checks: results.length, error: String(e?.stack ?? e).slice(0, 1500), fails: results.filter((r) => !r.ok).map((r) => r.check) } }));
} finally {
  for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* Best-effort cleanup */ } }
}
process.exit(exitCode);

/* ================================================================== run */

/** Log any action on the page that could produce sound (same as `sound-ab-probe.mjs`) */
function AUDIO_HOOK() {
  if (window.__pcAudioLog) return;
  const logged = (window.__pcAudioLog = []);
  const mark = (kind) => logged.push({ kind, at: Math.round(performance.now()) });
  for (const name of ['AudioContext', 'OfflineAudioContext']) {
    const Original = window[name];
    if (!Original) continue;
    window[name] = new Proxy(Original, { construct(target, args, newTarget) { mark(name); return Reflect.construct(target, args, newTarget); } });
  }
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) { mark('play'); return play.apply(this, a); };
  if (window.AudioScheduledSourceNode) {
    const start = AudioScheduledSourceNode.prototype.start;
    AudioScheduledSourceNode.prototype.start = function (...a) { mark('sourceStart'); return start.apply(this, a); };
  }
}

async function run() {
  const TREE = path.resolve(arg('--tree', ROOT));
  const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), `pc-av-card-cost-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`)));
  const KIND = arg('--kind', 'av');
  const EXPECT = arg('--expect', 'light');
  const PORT = Number(arg('--port', 5720));
  const PROJECT = arg('--project', null);
  fs.mkdirSync(OUT, { recursive: true });
  const dirs = { exportDir: path.join(OUT, 'export'), dataDir: path.join(OUT, 'data'), projectsDir: path.join(OUT, 'projects') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  // That checkout's own dev server helper (its REPO is that checkout)
  const { startDevServer } = await import(pathToFileURL(path.join(TREE, 'scripts', 'lib', 'dev-server.mjs')).href);
  log('Start dev server', TREE, PORT);
  const server = await startDevServer({ port: PORT, logFile: path.join(OUT, 'vite.log'), log,
    env: { PROMPTCUT_EXPORT_DIR: dirs.exportDir, PROMPTCUT_DATA_DIR: dirs.dataDir, PROMPTCUT_PROJECTS_DIR: dirs.projectsDir, PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_PUSH: '0' } });
  cleanups.push(() => server.stop());
  const browser = await puppeteer.launch({ headless: true, protocolTimeout: 900_000,
    args: [...PROBE_CHROME_ARGS, '--mute-audio', '--no-first-run', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required'] });
  cleanups.push(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e?.message ?? e).slice(0, 200)));
  await page.evaluateOnNewDocument(AUDIO_HOOK);
  const open = async () => {
    await page.goto(`${server.origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await until('Editor ready', () => page.evaluate(() => !!window.__pcStore && !!window.__pcIo && !!window.__pcPreviewDiag), 180_000);
  };
  await open();

  /* ---- Arrange project (or load the one left from another pass, so clip ids match) */
  let project;
  if (PROJECT) {
    project = JSON.parse(fs.readFileSync(path.resolve(PROJECT), 'utf8'));
    await page.evaluate((p) => window.__pcStore.actions.loadProject(p), project);
  } else {
    project = await page.evaluate((kind) => {
      const { actions, getState } = window.__pcStore;
      actions.newProject(`av-card-cost ${kind}`);
      actions.setProjectMeta({ width: 640, height: 360, fps: 30 });
      // Total duration follows content: a 4-second silent card stretches timeline to 4 seconds
      actions.addCardClip('punch-pill', 0, { duration: 4 });
      if (kind === 'av') {
        actions.addCardClip('av-pulse', 0.5, { duration: 1.0, params: { frequency: 880, gain: 0.5, duration: 0.6 } });
        actions.addCardClip('av-pulse', 2.0, { duration: 1.5, params: { color: '#f97316', frequency: 520, gain: 0.5, duration: 1.2 } });
      } else {
        actions.addCardClip('odometer', 0.5, { duration: 1.5 });
        actions.addCardClip('ring-metric', 2.0, { duration: 1.5 });
      }
      return getState().project;
    }, KIND);
  }
  fs.writeFileSync(path.join(OUT, 'project.json'), JSON.stringify(project, null, 1));
  const cardClips = project.tracks.flatMap((t) => t.clips).filter((c) => c.cardId);
  const avClips = cardClips.filter((c) => c.cardId === 'av-pulse');
  note('Project', { kind: KIND, clips: cardClips.map((c) => [c.id, c.cardId, c.start, c.end]) });

  /** Current determination on page side: identity, measurement log, cost record, dispatch table */
  const judged = () => page.evaluate(async (ids) => {
    const CI = await import('/src/editor/costIdentity.ts');
    const D = await import('/src/editor/planDispatch.ts');
    const P = await import('/src/render/pipelinePlan.mjs');
    const p = window.__pcStore.getState().project;
    const identity = CI.clipIdentityOf(p);
    const plan = D.currentPlan();
    const PR = await import('/src/editor/probeRunner.ts');
    const diag = window.__pcPreviewDiag();
    const costs = D.currentCosts();
    return {
      probeRun: { running: diag.probeRun.running, settled: PR.probeSettledFor(p), probed: diag.probeRun.probed.map((e) => [e.clipId, e.cardId]) },
      clips: ids.map((id) => {
        const clip = p.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
        const key = identity.identityKeys[id] ?? null;
        const record = key ? costs.find((r) => r.identityKey === key) ?? null : null;
        return { id, cardId: clip?.cardId, identityKey: key, frameMode: identity.frameModes[id] ?? null,
          record: record && { kind: record.kind, stepMs: record.stepMs, capped: record.capped === true, demoted: record.demoted === true },
          verdict: plan && clip ? P.pipelineAt(plan, id, (clip.start + clip.end) / 2) : null,
          inPrerenderSet: plan ? plan.prerenderSet.has(id) : null };
      }),
    };
  }, cardClips.map((c) => c.id));
  const settled = async (what) => {
    // Measurement finished: not running, and measurement log stopped growing across two checks
    let last = -1;
    return until(what, async () => {
      const j = await judged();
      const n = j.probeRun.probed.length;
      const ok = j.probeRun.settled && !j.probeRun.running && n === last;
      last = n;
      return ok ? j : null;
    }, 180_000, 700);
  };
  const first = await settled('First measurement round finished');
  if (!first) return;
  const audioLog = await page.evaluate(() => window.__pcAudioLog.slice());
  fs.writeFileSync(path.join(OUT, 'judged.json'), JSON.stringify(first, null, 1));
  const av = first.clips.filter((c) => c.cardId === 'av-pulse');

  if (KIND === 'av' && EXPECT === 'legacy') {
    note('Comparison before the change (not an acceptance check): identity and verdict of the audio motion graphics card', { av });
  }
  if (KIND === 'av' && EXPECT === 'light') {
    check('V1 Clips of the audio motion graphics card have a cost identity and a declared frame mode', av.length === avClips.length && av.every((c) => typeof c.identityKey === 'string' && c.frameMode === 'direct'), { av });
    const probedIds = new Set(first.probeRun.probed.map((e) => e[0]));
    // Same identity key measured only once: two clips with different parameters and durations have different keys, measured separately
    const keys = new Set(av.map((c) => c.identityKey));
    check('V2 Measured on first appearance: it is in the measurement log, and the cost record was written under its identity key', av.every((c) => c.record) && [...keys].length === first.probeRun.probed.filter((e) => e[1] === 'av-pulse').length && av.some((c) => probedIds.has(c.id)),
      { probed: first.probeRun.probed, records: av.map((c) => [c.id, c.record]) });
    check('V3 Silent during measurement: no new audio context, no element started playing, no sound source started', audioLog.length === 0, { audioLog });
    check('V4 Judged light after measurement: light in the dispatch table, not in the prerender set', av.every((c) => c.verdict === 'light' && c.inPrerenderSet === false), { av: av.map((c) => [c.id, c.verdict, c.inPrerenderSet]) });

    /* ---- V5 Live render */
    const target = avClips[0];
    const live = await page.evaluate(async (at) => {
      const { actions } = window.__pcStore;
      const wait = (n) => new Promise((r) => setTimeout(r, n));
      actions.pause(); actions.setVolume?.(0); actions.seek(at);
      await wait(600);
      actions.play();
      await wait(250);
      const playing = window.__pcPreviewDiag();
      actions.pause(); actions.seek(at);
      await wait(600);
      return { suppressedWhilePlaying: playing.suppressed, text: document.body.innerText.includes('Local PC render helper required') };
    }, target.start + 0.05);
    const stageDom = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const hit = await frame.evaluate((id) => {
        const el = document.querySelector(`[data-pc-clip="${id}"]`);
        if (!el) return null;
        const slot = el.querySelector('[data-pc-placeholder-slot]');
        const ring = [...el.querySelectorAll('div')].find((d) => d.style.borderRadius === '50%');
        return { suppressed: el.classList.contains('pc-suppressed'), placeholderShown: !!slot && !slot.hidden, ring: ring ? { width: ring.getBoundingClientRect().width } : null,
          unsupported: !!el.querySelector('[data-pc-placeholder-reason="unsupported"]:not([hidden])') && !!slot && !slot.hidden };
      }, target.id).catch(() => null);
      if (hit) stageDom.push({ url: frame.url().slice(0, 80), ...hit });
    }
    if (!stageDom.length) note('Stage frames', { frames: page.frames().map((f) => f.url().slice(0, 100)) });
    await page.screenshot({ path: path.join(OUT, 'V5-preview.png') });
    check('V5 Live render: not suppressed during playback; the stage has a live component (ring present), no placeholder, no "Local PC render helper required"',
      !live.suppressedWhilePlaying.includes(target.id) && !live.text && stageDom.some((s) => s.ring && s.ring.width > 20 && !s.placeholderShown && !s.suppressed),
      { live, stageDom });

    /* ---- V6 Reopening does not re-measure */
    await open();
    await page.evaluate((p) => window.__pcStore.actions.loadProject(p), project);
    const again = await settled('Round after reopening finished');
    if (again) {
      check('V6 Reopening does not re-measure: no audio motion graphics card in the measurement log, verdict still light', again.probeRun.probed.every((e) => e[1] !== 'av-pulse') && again.clips.filter((c) => c.cardId === 'av-pulse').every((c) => c.verdict === 'light' && c.record),
        { probed: again.probeRun.probed, av: again.clips.filter((c) => c.cardId === 'av-pulse').map((c) => [c.id, c.verdict]) });
    }
  }

  /* ---- V7 Export */
  log('Export');
  const exported = await page.evaluate(async () => {
    const stages = [];
    try {
      const r = await window.__pcIo.exportVideo({ onProgress: (_d, _t, stage) => { const s = stage ?? 'render'; if (stages.at(-1) !== s) stages.push(s); } });
      return { ok: true, outDir: r.outDir, stages };
    } catch (e) { return { ok: false, error: String(e?.message ?? e), stages }; }
  });
  const files = [];
  if (exported.ok) {
    for (const name of ['preview.mp4', 'overlay.mov']) {
      const from = path.join(exported.outDir, name);
      if (!fs.existsSync(from)) continue;
      fs.copyFileSync(from, path.join(OUT, name));
      files.push([name, fs.statSync(from).size]);
    }
  }
  check('V7 Export succeeded, final video file exists', exported.ok && files.some((f) => f[0] === 'preview.mp4' && f[1] > 0), { error: exported.error, stages: exported.stages, files });
  const end = await judged();
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ tree: TREE, kind: KIND, expect: EXPECT, first, end, exported: { ok: exported.ok, stages: exported.stages, files }, errors }, null, 1));
  note('Page errors', { errors: errors.slice(0, 5) });
}

/* ================================================================== compare */

async function frameHashes(ffmpeg, file) {
  // Decode into raw rgba pixels, slice by frame, per-frame sha256 (overlay.mov with alpha handled same way)
  const probe = await new Promise((resolve) => {
    const c = spawn(ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', () => resolve(err));
  });
  const m = /Stream #\d+:\d+.*Video:.*?(\d{2,5})x(\d{2,5})/.exec(probe);
  if (!m) throw new Error(`Cannot read aspect ratio: ${file}`);
  const frameBytes = Number(m[1]) * Number(m[2]) * 4;
  return new Promise((resolve, reject) => {
    const c = spawn(ffmpeg, ['-v', 'error', '-i', file, '-an', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { windowsHide: true });
    const hashes = [];
    let pending = Buffer.alloc(0), err = '';
    c.stdout.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= frameBytes) {
        hashes.push(createHash('sha256').update(pending.subarray(0, frameBytes)).digest('hex'));
        pending = pending.subarray(frameBytes);
      }
    });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => (code === 0 ? resolve({ hashes, size: `${m[1]}x${m[2]}` }) : reject(new Error(`ffmpeg decode failed: ${err.slice(-300)}`))));
  });
}

async function compare() {
  const A = path.resolve(arg('--a')), B = path.resolve(arg('--b'));
  const ffmpeg = await findFfmpeg();
  const rows = [];
  for (const name of ['preview.mp4', 'overlay.mov']) {
    const fa = path.join(A, name), fb = path.join(B, name);
    if (!fs.existsSync(fa) && !fs.existsSync(fb)) continue;
    if (!fs.existsSync(fa) || !fs.existsSync(fb)) { rows.push({ name, missing: !fs.existsSync(fa) ? 'a' : 'b' }); continue; }
    const [a, b] = [await frameHashes(ffmpeg, fa), await frameHashes(ffmpeg, fb)];
    let differ = 0;
    const firstDiff = [];
    for (let i = 0; i < Math.max(a.hashes.length, b.hashes.length); i++) if (a.hashes[i] !== b.hashes[i]) { differ++; if (firstDiff.length < 5) firstDiff.push(i); }
    const sameBytes = Buffer.compare(fs.readFileSync(fa), fs.readFileSync(fb)) === 0;
    rows.push({ name, size: a.size, framesA: a.hashes.length, framesB: b.hashes.length, differ, firstDiff, sameBytes,
      distinctA: new Set(a.hashes).size });
  }
  check('C1 Each final video file has the same frame count on both sides and the same per-frame sha256', rows.length > 0 && rows.every((r) => !r.missing && r.framesA === r.framesB && r.framesA > 0 && r.differ === 0), { rows });
}

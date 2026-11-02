/**
 * Playback keep-alive: end-to-end probe with **real editor + real prerender process** (task
 * "Desktop app playback keep-alive"; semantics `docs/semantics/mechanism/rendering.md` "Heavy
 * pipeline: prerender": work to catch up later is produced only when paused, not during playback).
 *
 *   node scripts/probes/play-idle-probe.mjs --port 27100 [--out <dir>] [--json <file>] [--keep]
 *   node scripts/probes/play-idle-probe.mjs --origin http://127.0.0.1:27100 …   # Connect to an already running dev server
 *
 * Bug to reproduce: the prerender process determines "whether user is playing" solely by the
 * playhead reported by the page (`FramePipeline.streamBusy()`: playing with activity within 5 s, or
 * moved within 800 ms). During playback, the page can only refresh this activity via the "gap"
 * (`wanted`) path, but when every layer under the playhead is covered by streams, there are no gaps
 * and nothing is sent. Thus, after playing continuously for over 5 seconds, the prerender process
 * assumes the machine is idle and resumes topping up other cards' streams to full density during
 * playback.
 *
 * Workflow:
 *   0. Editor `?editor&nosetup=1&preview=stage`; create a project, place eight cards that shift 10
 *      pixels horizontally per frame (`r6-stateful`), 6 seconds each, arranged in sequence; pin all
 *      as heavy cards to trigger prerendering. Card 1 (A) is for playback: wait for its track
 *      stream to cover the entire clip (even sparse counts), while streams for other cards are
 *      still catching up.
 *   1. Loop playback inside A (jump back to earlier part of A near the end; only A is under the
 *      playhead, and A is covered by streams, so there are no gaps). Page side records how many
 *      `/api/data/playhead` requests were sent and whether they carried `wanted`.
 *   2. Every 0.5 s, read prerender process diagnostics (`streams` in `/api/frames/diagnostics`:
 *      produced segments, frames captured, full-density segments) and the playhead in its hands
 *      (`/api/data/playhead`: most recently received timestamp `at` and `playing`).
 *   3. Stop after playing for 20 seconds. Read for another 12 seconds to observe how long it takes
 *      to resume producing streams.
 *
 * Assertions:
 *   a. From 5 seconds after playback starts until stopping, the playhead in the prerender process's
 *      hands remains continuously "playing", and the most recent ping does not exceed
 *      `MAX_HEAD_AGE_MS` (keep-alive must be significantly shorter than server's 5-second window);
 *   b. From 5 seconds after playback starts until stopping, produced segments, captured frames, and
 *      full-density segments do not increase at all (zero frames produced);
 *   c. After stopping, resume stream production within `RESUME_MS` (proving remaining work was
 *      truly waiting, not inactive because it was already finished).
 *
 * Write conclusion JSON to stdout, progress to stderr; exit non-zero if any item fails. Duration is
 * recorded only; timeout is solely to prevent hangs.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { flagArg } from './probe-connect.mjs';
import { startDevServer, sleep } from './below-stream-common.mjs';

const args = process.argv.slice(2);
const GIVEN_ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '0', args));
const KEEP = args.includes('--keep');
const JSON_OUT = flagArg('json', null, args);
const RUN = Date.now().toString(36);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-play-idle-${RUN}`));
if (!GIVEN_ORIGIN && !PORT) { console.error('Pass --origin <dev server> or --port <start your own>'); process.exit(2); }

const FPS = 30, SEG = 15;
/**
 * Eight cards, 6 seconds each (remaining work must be longer than the 20-second playback; around
 * 40 fps full density throughout); in points written in seconds, landing between two frames
 * (card 1 is frames 40–219, 12 segments in total).
 */
const CLIP_SECONDS = 6;
const STARTS = [1.32, 8.32, 15.32, 22.32, 29.32, 36.32, 43.32, 50.32];
const FIRST = Math.ceil(STARTS[0] * FPS), LAST = Math.ceil((STARTS[0] + CLIP_SECONDS) * FPS) - 1;
const SEG_COUNT = Math.ceil((LAST - FIRST + 1) / SEG);
/** Loop playback range: all within A (1.32-7.32 seconds) */
const LOOP_FROM = 2.0, LOOP_TO = 6.8;
/** How long to play; the prerender process "playing" window is 5 seconds, must play much longer than that */
const PLAY_MS = 20_000;
/** How long after starting playback to start requiring "zero frames produced": the server window is 5 seconds */
const QUIET_FROM_MS = 5_000;
/** Keepalive max interval: playhead in prerender process cannot be older than this (server window 5s, keepalive 2s) */
const MAX_HEAD_AGE_MS = 3_500;
/** Time to resume stream after stop (push playhead once, server idle 0.8s, producer wakes; counts full segment, so allow margin) */
const RESUME_MS = 12_000;

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const notes = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 900))); say('FAIL', { label, extra }); } return !!cond; };
async function until(label, fn, timeoutMs, everyMs = 100, soft = false) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { (soft ? notes : fails).push(`Timeout: ${label}`); say('TIMEOUT', { label, soft }); return null; }
    await sleep(everyMs);
  }
}

await fs.mkdir(OUT, { recursive: true });
const out = { out: OUT, clips: STARTS.map((s) => ({ start: s, seconds: CLIP_SECONDS })), loop: [LOOP_FROM, LOOP_TO], playMs: PLAY_MS };
let dev = null, browser = null;
const started = Date.now();
try {
  let origin = GIVEN_ORIGIN;
  if (!origin) {
    process.env.PROMPTCUT_EXPORT_DIR = path.join(OUT, 'export');
    await fs.mkdir(process.env.PROMPTCUT_EXPORT_DIR, { recursive: true });
    dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'playidle' });
    origin = dev.origin;
    say('spawn', { pid: dev.pid, port: PORT });
  }
  origin = origin.replace(/\/+$/, '');
  out.origin = origin;

  browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1200 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
  // Count what the page sends to /api/data/playhead: install before the page script runs.
  await page.evaluateOnNewDocument(() => {
    const tally = window.__playheadPosts = { total: 0, playing: 0, withWanted: 0, playingNoWanted: 0, at: [] };
    const real = window.fetch.bind(window);
    window.fetch = (input, init) => {
      try {
        const url = typeof input === 'string' ? input : input?.url;
        if (typeof url === 'string' && url.includes('/api/data/playhead') && String(init?.method || 'GET').toUpperCase() === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}'));
          tally.total++;
          if (body.playing) tally.playing++;
          if (Array.isArray(body.wanted) && body.wanted.length) tally.withWanted++;
          else if (body.playing) tally.playingNoWanted++;
          tally.at.push([Date.now(), body.playing ? 1 : 0, Array.isArray(body.wanted) && body.wanted.length ? 1 : 0]);
        }
      } catch { /* Just counting */ }
      return real(input, init);
    };
  });
  await page.goto(origin + '/?editor&nosetup=1&preview=stage', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return !!m.frontStage() && m.backRole() === 'back';
  }, { timeout: 180000, polling: 500 });
  const store = (fn, ...a) => page.evaluate(async (src, a2) => {
    const { actions, getState } = await import('/src/store/project.ts');
    // eslint-disable-next-line no-new-func
    return new Function('actions', 'getState', 'args', src)(actions, getState, a2);
  }, fn, a);

  /* ---------------------------------------------------------------- 0. Project */
  const clipIds = await store(`actions.newProject('play-idle-${RUN}');
    const ids = [];
    for (const start of args[0]) { const c = actions.addCardClip('r6-stateful', start, { duration: args[1], params: {} }); if (c) ids.push(c.id); }
    actions.seek(args[2]);
    return ids;`, STARTS, CLIP_SECONDS, LOOP_FROM);
  out.clipIds = clipIds;
  if (!check(clipIds.length === STARTS.length, 'all eight cards were added', clipIds)) throw new Error('not all cards were added');
  const A = clipIds[0];
  const project = await page.evaluate(async () => JSON.parse(JSON.stringify((await import('/src/store/project.ts')).getState().project)));
  out.project = { width: project.width, height: project.height, fps: project.fps, duration: project.duration };
  check(project.fps === FPS, 'the project is 30 frames per second', project.fps);

  const pinHeavy = (persist = false) => page.evaluate(async (ids, persist) => {
    const { getState } = await import('/src/store/project.ts');
    const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
    const pd = await import('/src/editor/planDispatch.ts');
    const keys = clipIdentityOf(getState().project).identityKeys;
    const costs = pd.currentCosts();
    const device = costs[0]?.device ?? 'probe';
    const recs = ids.map((id) => ({ ...(costs.find((r) => r.identityKey === keys[id]) ?? { identityKey: keys[id], device }), pinnedHeavy: true }));
    pd.mergePlanCosts(recs);
    if (persist) {
      const saved = recs.filter((r) => typeof r.stepMs === 'number');
      if (saved.length) await fetch('/api/data/costs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records: saved }) });
    }
    return recs.map((r) => typeof r.stepMs === 'number');
  }, clipIds, persist);
  await until('cost records of the eight cards', () => page.evaluate(async (ids) => {
    const { getState } = await import('/src/store/project.ts');
    const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
    const pd = await import('/src/editor/planDispatch.ts');
    const keys = clipIdentityOf(getState().project).identityKeys;
    const costs = pd.currentCosts();
    return ids.every((id) => costs.some((r) => r.identityKey === keys[id] && typeof r.stepMs === 'number'));
  }, clipIds), 240000, 500, true);
  out.costRecords = await pinHeavy(true);

  const prerender = await (await fetch(origin + '/api/prerender/info')).json();
  out.prerender = { url: prerender.url, ready: prerender.ready, mode: prerender.mode };
  const getJson = (url) => fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(5000) }).then((r) => (r.ok ? r.json() : null), () => null);
  /** Prerender process output so far: produced segments, snapshots, full-density segments, sparse segments */
  const produced = async () => {
    const d = await getJson(`${prerender.url}/api/frames/diagnostics`);
    const s = d?.streams;
    if (!s) return null;
    let frames = 0, dense = 0, sparse = 0;
    for (const st of s.streams ?? []) {
      frames += st.capture?.frames ?? 0;
      for (const seg of Object.values(st.segments ?? {})) { if (seg.stride === 1) dense++; else sparse++; }
    }
    return { segments: s.stats?.segments ?? 0, frames, dense, sparse, streams: (s.streams ?? []).length };
  };
  /** Playhead held by the prerender process: how long ago the latest received time was, whether playing or not */
  const headNow = async () => {
    const h = await getJson(`${prerender.url}/api/data/playhead`);
    return h ? { playing: !!h.playing, age: Date.now() - Number(h.at), wanted: h.wanted?.length ?? 0 } : null;
  };

  const layersNow = () => page.evaluate(async (id) => {
    const m = await import('/src/editor/snapshotFeed.ts');
    const byKind = m.currentReadyIndex().get(id);
    return byKind ? Object.fromEntries([...byKind].map(([k, v]) => [k, { key: v.key, ranges: v.ranges, originFrame: v.originFrame ?? null }])) : null;
  }, A);
  const startedPrerender = Date.now();
  const readyA = await until('A\'s track stream covers the whole span (a sparse one counts)', async () => {
    const k = await page.evaluate(async () => (await import('/src/render/dataMirror.ts')).mirrorKey());
    if (!k) return null;
    await pinHeavy(true);
    await fetch(prerender.url + '/api/frames/preload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: k.session, localRev: k.localRev, lane: 'background' }) }).catch(() => {});
    const layers = await layersNow();
    if (!layers?.stream || !(layers.stream.ranges ?? []).some((r) => r[0] <= 0 && r[1] >= SEG_COUNT - 1)) return null;
    return { layers, produced: await produced() };
  }, 900000, 2000);
  if (!readyA) throw new Error('A\'s track stream was not produced');
  out.aReadyMs = Date.now() - startedPrerender;
  say('a-ready', { ms: out.aReadyMs, produced: readyA.produced });
  out.beforePlay = await produced();
  say('before-play', out.beforePlay);

  /* ---------------------------------------------------------------- 1. Loop playback */
  // Loop in the page: jump back to earlier section near the end. seek does not change playing; playhead stays in A.
  await page.evaluate(async (from, to) => {
    const { actions, getState } = await import('/src/store/project.ts');
    window.__loopTimer = setInterval(() => {
      const s = getState();
      if (s.playing && s.t >= to) actions.seek(from);
    }, 100);
  }, LOOP_FROM, LOOP_TO);
  const postsBefore = await page.evaluate(() => ({ ...window.__playheadPosts, at: undefined }));
  const playStart = Date.now();
  await store(`actions.seek(args[0]); actions.play();`, LOOP_FROM);
  const samples = [];
  let baseline = null;
  while (Date.now() - playStart < PLAY_MS) {
    // Re-pin every few rounds: after pass 2 measurement, page rewrites entire cost record, wiping out the pinned heavy card bit
    if (samples.length % 6 === 0) await pinHeavy(true).catch(() => {});
    const elapsed = Date.now() - playStart;
    const [p, h, st] = await Promise.all([produced(), headNow(), page.evaluate(async () => { const { getState } = await import('/src/store/project.ts'); const s = getState(); return { t: s.t, playing: s.playing }; })]);
    const sample = { ms: elapsed, produced: p, head: h, t: Math.round(st.t * 100) / 100, playing: st.playing };
    samples.push(sample);
    if (!baseline && elapsed >= QUIET_FROM_MS && p) baseline = sample;
    await sleep(500);
  }
  const playEnd = Date.now();
  const lastProduced = await produced();
  const posts = await page.evaluate(() => window.__playheadPosts);
  const playPosts = posts.at.filter(([at]) => at >= playStart && at <= playEnd);
  out.posts = { before: postsBefore, duringPlay: { total: playPosts.length, playing: playPosts.filter((p) => p[1] === 1).length, withWanted: playPosts.filter((p) => p[2] === 1).length,
    playingNoWanted: playPosts.filter((p) => p[1] === 1 && p[2] === 0).length, atMs: playPosts.map((p) => p[0] - playStart) } };
  say('played', { posts: out.posts.duringPlay, lastProduced });

  /* ---------------------------------------------------------------- 3. Stop, see how long to recover */
  const stopAt = Date.now();
  await store(`actions.pause();`);
  let resumedAfterMs = null;
  const afterSamples = [];
  while (Date.now() - stopAt < RESUME_MS) {
    const p = await produced();
    afterSamples.push({ ms: Date.now() - stopAt, produced: p });
    if (p && lastProduced && (p.segments > lastProduced.segments || p.frames > lastProduced.frames)) { resumedAfterMs = Date.now() - stopAt; break; }
    await sleep(250);
  }
  await page.evaluate(() => clearInterval(window.__loopTimer)).catch(() => {});
  out.samples = samples;
  out.afterSamples = afterSamples;
  out.resumedAfterMs = resumedAfterMs;

  /* ---------------------------------------------------------------- Assertions */
  const quiet = samples.filter((s) => s.ms >= QUIET_FROM_MS && s.produced && s.head);
  check(samples.every((s) => s.playing), 'Playback keeps playing (the page\'s playing never dropped)', samples.filter((s) => !s.playing).slice(0, 3));
  check(quiet.length >= 10, 'enough samples were collected after the first 5 seconds of playback', quiet.length);
  const stale = quiet.filter((s) => !s.head.playing || s.head.age > MAX_HEAD_AGE_MS);
  check(stale.length === 0, `a. From ${QUIET_FROM_MS / 1000} seconds after playback starts until it stops, the playhead held by the prerender process stays "playing", and the most recent message is no more than ${MAX_HEAD_AGE_MS} milliseconds old`,
    { bad: stale.length, of: quiet.length, worst: Math.max(...quiet.map((s) => s.head.age)), first: stale.slice(0, 3).map((s) => ({ ms: s.ms, head: s.head })) });
  if (baseline && lastProduced) {
    const grew = { segments: lastProduced.segments - baseline.produced.segments, frames: lastProduced.frames - baseline.produced.frames, dense: lastProduced.dense - baseline.produced.dense };
    out.producedWhilePlaying = { from: baseline.ms, ...grew };
    check(grew.segments === 0 && grew.frames === 0 && grew.dense === 0, `b. From ${QUIET_FROM_MS / 1000} seconds after playback starts until it stops, the prerender process produced not a single frame`, { baseline: baseline.produced, last: lastProduced, grew });
  } else check(false, 'b. No baseline was obtained', { baseline: !!baseline, lastProduced: !!lastProduced });
  check(resumedAfterMs !== null, `c. Within ${RESUME_MS / 1000} seconds after stopping, stream production resumes (the remaining work really was waiting)`, { after: afterSamples.slice(-3), lastProduced });
  // Page side: no gaps during playback (no wanted), meaning this scene is indeed the "no gap" kind
  check(out.posts.duringPlay.withWanted === 0, 'Scenario holds: the page reported no gaps during playback (every layer under the playhead is covered by a stream)', out.posts.duringPlay);
  check(pageErrors.length === 0, 'Page has no uncaught errors', pageErrors.slice(0, 3));
} catch (error) {
  fails.push(`Exception: ${error?.stack || error}`);
} finally {
  try { await browser?.close(); } catch { /* Cleanup */ }
  try { await dev?.stop(); } catch { /* Cleanup */ }
  if (!KEEP && dev) { try { await fs.rm(path.join(OUT, 'dev-data'), { recursive: true, force: true }); } catch { /* Cleanup */ } }
}
out.fails = fails;
out.notes = notes;
out.ms = Date.now() - started;
const summary = { ...out, samples: undefined, afterSamples: undefined, sampleCount: out.samples?.length };
const text = JSON.stringify(summary, null, 2);
if (JSON_OUT) await fs.writeFile(path.resolve(JSON_OUT), JSON.stringify(out, null, 2));
console.log(text);
process.exit(fails.length ? 1 : 0);

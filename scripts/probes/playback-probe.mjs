/**
 * Acceptance probe for R5 "Playback and frame catch-up" (K3 / K4 / K5 / K6), plus a "stalled audio"
 * case (positive acceptance check of audio watchdog, see below).
 *
 *   node scripts/probes/playback-probe.mjs [--port 5281] [--seconds 10] [--keep]
 *                                          [--origin http://127.0.0.1:5281]
 *                                          [--json out/playback.json] [--only tick,seek,...] [--trace]
 *
 * Case names (recognized by `--only`): tick, stalled audio, end, frame catch-up, seek, timeline,
 * downgrade. `--trace` is only useful for "stalled audio": writes sample rows every 5 ms before
 * and after each stall (playhead, mediaStalled, sound element paused/position/energy) and frame
 * arrival timestamps into results for troubleshooting.
 *
 * When running without `--origin`, starts its own dev server (default 5281, stage ports follow
 * at 5282 / 5283), pointing `PROMPTCUT_DATA_DIR` to a temporary directory to avoid overwriting
 * repository `out/card-costs.json`.
 *
 * # How to configure "classify this card as light or heavy" into the desired state
 *
 * Dispatch in K2 is entirely determined by `costs`, while `costs` is measured by the K1 probe:
 * waiting for it to finish in the probe and praying values fall into the desired tier turns
 * acceptance check into rolling dice. So here we **write `costs` ourselves**: after creating
 * the project, compute `identityKey` for each clip via `clipIdentityOf`, PUT a batch of synthetic
 * records, then call `planDispatch.setPlanCosts` so the page side recalculates immediately and
 * dispatches via `setPlan`. `stepMs` / `catchUpMs` / `vtOk` / `seekOk` in synthetic records serve
 * as branching switches for K3 / K5.
 *
 * # Measurement limitations on this machine (per R2 report)
 *
 * Without `--disable-gpu-vsync --disable-frame-rate-limit`, headless Chrome rAF throttles down
 * to 10 Hz, so `await __pcRealRaf()` in the tick loop never arrives, and tick lengths are all
 * wrong. Both flags must be included.
 * **Cost**: with them included, rAF is no longer quantized by VSync into 16.6 ms slots, so the two
 * behaviors "24 / 25 fps naturally alternates 2 / 3 frames" and "no 16.6 ms short ticks at 30 fps"
 * **cannot observe the phenomenon itself** here (rAF fires whenever it wants). What can be
 * measured accurately, and what this check actually needs to guarantee, is **mean arrival interval
 * = 1000 / fps** and **difference in `sec` between consecutive `frame` events is strictly 1/fps**.
 * The 2/3 alternation on a real machine (session with VSync) needs to be verified using display
 * tick runs like `oac-probe`; noted here.
 *
 * # "Stalled audio": audio stops immediately on playback stall (`e289b886`, `armStallWatch` in `Preview.tsx`)
 *
 * The "tick" case only tests **no false triggers** (normal playback `mediaStallCount === 0`).
 * This case tests that **it actually works**: if no next tick arrives after "nominal tick duration
 * + 40 ms (`MEDIA_STALL_MS`)" since the previous tick, the watchdog **does not wait for the late
 * tick**, sets `mediaStalled` to true immediately, turns `playing` in main doc audio layer false,
 * and calls `pause()` on sound elements.
 *
 * How to create a stall (without modifying src/ or calling `setMediaStalled`): place actual
 * audible audio on the timeline (synthesized 440 Hz WAV in page, blob URL); once playing normally
 * and producing sound, synchronously spin for 700 ms (400 ms second time) in the **front stage
 * iframe**: its main thread is blocked, tick loop cannot emit any ticks, and parent page receives
 * no `frame`. This is the "late next tick" itself. Spinning uses real clock `window.__pcRealNow` on
 * stage page (stage replaced `performance.now` with virtual clock; spinning on it hangs forever).
 * Parent page is in another event loop, so sampler and watchdog timers run as usual; if parent page
 * is also dragged down during hold (stage and parent page in same process), the check "parent page
 * not dragged down together" will catch it, invalidating measurement. Only holds stage in this case;
 * other cases unaffected.
 *
 * Sampler outputs one row every 5 ms: playhead, `__pcPreviewDiag().mediaStalled / mediaStallCount`,
 * each main doc <audio>'s paused / currentTime / readyState / element reload count / real-time energy
 * (element captureStream → AnalyserNode, measurement only without output). Timestamps are converted
 * to the same scale using `performance.timeOrigin + performance.now()` (parent page) and stage
 * page's real clock. Headless Chrome runs with `--mute-audio` and `--autoplay-policy=no-user-gesture-required`,
 * not relying on human hearing.
 *
 * Assertions (one set for each stall):
 *   1. Stage truly stopped (interval between adjacent ticks ≥ 80% of hold duration), parent page
 *      not dragged down; before stall `mediaStalled` is false, audio playing, energy detected;
 *   2. **`mediaStalled` is true before the late tick arrives**, `mediaStallCount` increments by 1
 *      (key point of entire feature: immediate, not after the fact);
 *   3. **Sound stops immediately**: before the late tick arrives, all sound elements are paused
 *      and not played again before that tick arrives; in last 100 ms before late tick arrives,
 *      real-time energy is below threshold;
 *   4. **Recovery**: after ticks resume, `mediaStalled` reverts to false, sound resumes playing;
 *      audio position tracks current playhead (difference from t - clip start ≤ 0.25 s),
 *      not lower than position when stopped, not at start (not replayed from beginning),
 *      position continuous during first 400 ms after recovery (adjacent sample diff < 0.2 s);
 *   Whole sample run: audio position never rewinds, sound element never reloads,
 *   `mediaStallCount` ≥ stall count.
 *
 * Timing only recorded, not used as pass condition (verification.md "record duration only, not
 * as gate"): how long trip took from last tick before stall (nominal ~73 ms), how much earlier
 * than the late tick, how long element paused took from trip, how long energy drain took
 * (captureStream path still needs to drain 50-90 ms buffer after paused).
 * Ordering in assertions (tripping/audio stopping **before** the late tick) is a sequence
 * condition, not a timing gate: hold duration (700 / 400 ms) is far greater than trip time
 * (~73 ms), so a slower machine will not invert the order; wait limits (60 s / 30 s) are solely
 * to prevent hangs.
 */
import '../lib/no-user-dirs.mjs'; // First import: does not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR; outputs do not land in the user's Videos\PromptCut
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

import { stagePortsOf } from '../../server/stage-ports.mjs';

/* ------------------------------------------------------------------ Parameters */

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback; };
const has = (name) => argv.includes(name);

const port = Number(flag('--port', '5281')) || 5281;
const originArg = flag('--origin');
const seconds = Math.max(1, Number(flag('--seconds', '10')) || 10);
const keep = has('--keep');
const outJson = flag('--json');
const only = (flag('--only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const origin = (originArg || `http://127.0.0.1:${port}`).replace(/\/+$/, '');
const wants = (name) => !only.length || only.includes(name);

const EDITOR_URL = '/?editor&headless=1&preview=stage';
/** Page viewport width (the timeline section clips visible x by it, see xAt) */
const VIEWPORT_W = 1600;

const fails = [];
const out = { origin, editorUrl: EDITOR_URL, stagePorts: stagePortsOf(port), seconds, cases: {} };
const check = (cond, label, extra) => {
  if (!cond) fails.push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
  // Print each item to stderr (keep stdout for JSON): keep evidence for passed items too
  process.stderr.write((cond ? 'PASS ' : 'FAIL ') + label + '\n');
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Progress to stderr: a pass takes minutes, stuck step must be visible (stdout reserved for JSON) */
const step = (msg) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);

/* ------------------------------------------------------------------ dev server */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-playback-'));
const costsFile = path.join(dataDir, 'card-costs.json');
let server = null;

async function startServer() {
  if (originArg) return null;
  const viteBin = path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js');
  const proc = spawn(process.execPath,
    [viteBin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { windowsHide: true, cwd: path.resolve(import.meta.dirname, '../..'), env: { ...process.env, PROMPTCUT_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  proc.stdout.on('data', (b) => log.push(String(b)));
  proc.stderr.on('data', (b) => log.push(String(b)));
  for (let i = 0; i < 240; i++) {
    try {
      const res = await fetch(origin + '/@vite/client');
      if (res.ok) return proc;
    } catch { /* Not up yet */ }
    await sleep(500);
  }
  proc.kill();
  throw new Error(`dev server did not start within 240 seconds:\n${log.join('')}`);
}

async function stopServer() {
  if (!server) return;
  server.kill();
  if (process.platform === 'win32') {
    await new Promise((r) => spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('close', r));
  }
  server = null;
}

/* ------------------------------------------------------------------ Page-side scripts */

/**
 * Install two recorders in the main document:
 *   - `__pcFrames`: every `frame` / `ended` / `settled` event and its **real** arrival timestamp;
 *   - `__pcLongTasks`: long tasks (> 50 ms) in main document, measurement for "zero jank".
 * Subscription goes through `stageBridge.onStageEvent` (role filtering already done there).
 */
const INSTALL_RECORDERS = async () => {
  const bridge = await import('/src/editor/stageBridge.ts');
  window.__pcFrames = [];
  window.__pcEvents = [];
  if (!window.__pcOffEvents) {
    window.__pcOffEvents = bridge.onStageEvent((e) => {
      const at = performance.now();
      if (e.type === 'frame') window.__pcFrames.push({ sec: e.sec, at });
      else window.__pcEvents.push({ type: e.type, sec: e.sec, clipIds: e.clipIds ?? null, clipId: e.clipId ?? null, at });
    });
  }
  window.__pcLongTasks = [];
  if (!window.__pcLongObs) {
    try {
      window.__pcLongObs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__pcLongTasks.push({ start: entry.startTime, dur: entry.duration });
      });
      window.__pcLongObs.observe({ entryTypes: ['longtask'] });
    } catch { window.__pcLongObs = null; }
  }
  return true;
};

/** Create a project: one track per card, parameters provided by caller */
const BUILD = async ({ fps, duration, cards }) => {
  await import('/src/cards/index.ts');
  const { actions, getState } = await import('/src/store/project.ts');
  actions.newProject('playback-probe');
  actions.setProjectMeta({ fps, duration });
  for (const card of cards) {
    actions.addCardClip(card.id, card.start ?? 0, { duration: card.duration ?? duration });
  }
  const project = getState().project;
  // Clips land on their respective tracks in insertion order; returns a cardId → clipId map
  const byCard = {};
  for (const tr of project.tracks) for (const c of tr.clips) if (c.cardId) (byCard[c.cardId] ||= []).push(c.id);
  if (cards.some((c) => c.params)) {
    for (const card of cards) {
      if (!card.params) continue;
      for (const clipId of byCard[card.id] ?? []) actions.setClipParams(clipId, card.params, { merge: true });
    }
  }
  actions.setProjectMeta({ duration });
  return { byCard, fps: getState().project.fps, duration: getState().project.duration };
};

/**
 * Compute `identityKey` for each clip using `clipIdentityOf`, PUT a batch of synthetic cost
 * records, then call `setPlanCosts` to let the page recalculate immediately and dispatch `setPlan`
 * to the stage. `specs` is `{ [cardId]: { stepMs, catchUpMs, vtOk, seekOk, seekMs, kind } }`.
 */
const SET_COSTS = async ({ specs }) => {
  const { getState } = await import('/src/store/project.ts');
  const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
  const { setPlanCosts, currentPlan } = await import('/src/editor/planDispatch.ts');
  const project = getState().project;
  const { identityKeys } = clipIdentityOf(project);
  /*
   * **Must reuse the `device` string written by K1 resident probe**: `costs` deduplicates by
   * `(identityKey, device)`; changing device only adds another record while the real measured
   * record remains, and `planPipelines` indexing lets later writes win, so "manually configuring as
   * light card" has no effect at all (`probe-slow` measured 60 ms > B, classified as `capped`).
   * Writing back to the same device overwrites it, and `probeRunner`'s "skip if record exists and
   * demoted !== true" prevents it from re-measuring later.
   */
  const existing = (await (await fetch('/api/data/costs')).json())?.costs ?? [];
  const device = existing[0]?.device ?? 'playback-probe';
  const records = [];
  const seen = new Set();
  for (const tr of project.tracks) {
    for (const clip of tr.clips) {
      const spec = specs[clip.cardId];
      const key = identityKeys[clip.id];
      if (!spec || !key || seen.has(key)) continue;
      seen.add(key);
      records.push({
        identityKey: key, device, mode: 'dev', fps: project.fps,
        stepMs: spec.stepMs, stepMaxMs: spec.stepMs, inlineMs: 1, rasterMs: 0, serializeMs: 1,
        catchUpMs: spec.catchUpMs ?? 0, kind: spec.kind ?? 'stepped',
        vtOk: spec.vtOk, seekOk: spec.seekOk, seekMs: spec.seekMs ?? null,
        capped: spec.capped ?? false, demoted: false, measuredAt: Date.now(),
      });
    }
  }
  await fetch('/api/data/costs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records }) });
  const tuning = (await (await fetch('/api/data/costs')).json())?.tuning ?? null;
  setPlanCosts(records, tuning);
  // Only counts once a tick accumulates (planDispatch batches with microtask)
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 50));
  const plan = currentPlan();
  return {
    records: records.map((r) => ({ identityKey: r.identityKey, stepMs: r.stepMs, catchUpMs: r.catchUpMs, vtOk: r.vtOk, seekOk: r.seekOk })),
    segments: plan ? plan.segments.map((s) => ({ fromSec: s.fromSec, toSec: s.toSec, heavy: [...s.heavy], light: [...s.light] })) : null,
    prerenderSet: plan ? [...plan.prerenderSet] : null,
  };
};

const RESET_RECORDERS = () => { window.__pcFrames = []; window.__pcEvents = []; window.__pcLongTasks = []; };
const READ_RECORDERS = () => ({ frames: window.__pcFrames, events: window.__pcEvents, longTasks: window.__pcLongTasks });

/* ------------------------------------------------------------------ Page-side script for "stalled audio" case */

/**
 * Place actual audible sound into project: synthesize a 16 kHz mono WAV in page (440 Hz sine,
 * with 3 Hz amplitude variation, energy throughout), convert to a blob URL, attach to an audio
 * asset, and place onto timeline. Does not depend on ffmpeg or asset service, and does not go
 * through the voice generation button flow.
 */
const ADD_TONE = async ({ sec }) => {
  const { actions } = await import('/src/store/project.ts');
  const sr = 16000, n = Math.floor(sec * sr);
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const w4 = (o, str) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, str.charCodeAt(i)); };
  w4(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w4(8, 'WAVE'); w4(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w4(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    dv.setInt16(44 + i * 2, Math.round(32767 * 0.5 * (0.75 + 0.25 * Math.sin(2 * Math.PI * 3 * t)) * Math.sin(2 * Math.PI * 440 * t)), true);
  }
  const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  const media = actions.addMedia({ id: 'm-stall-tone', kind: 'audio', name: 'stall-tone.wav', url, duration: sec });
  const clip = actions.addMediaClip(media.id, 0, { duration: sec });
  return { mediaId: media.id, clipId: clip?.id ?? null, start: clip?.start ?? null, end: clip?.end ?? null };
};

/**
 * Page-side sampler: one row every `everyMs` ms { w (wall-clock ms), t (playhead), playing,
 * stalled (`mediaStalled`), count (`mediaStallCount`), els: each main doc <audio>'s { clip,
 * paused, ct, ready, loads, rms } }.
 * rms = real-time energy from element captureStream → AnalyserNode (measures only without output,
 * not connected to destination).
 * After element reload, original captured audio track no longer outputs data but status remains
 * live, so hold the stream and reconnect on each addtrack (per sound-preview-probe).
 * `w` uses `performance.timeOrigin + performance.now()`: on the same scale as timestamps sampled
 * by the same algorithm in stage page (same clock on same machine).
 */
const INSTALL_SAMPLER = async ({ everyMs }) => {
  const { getState } = await import('/src/store/project.ts');
  if (window.__stallSampler) { clearInterval(window.__stallSampler.timer); }
  const S = { rows: [], timer: null, hooks: new WeakMap(), ctx: new AudioContext(), maxTickMs: 0 };
  await S.ctx.resume().catch(() => {});
  const attach = (h) => {
    const track = h.stream.getAudioTracks().filter((x) => x.readyState === 'live').at(-1);
    if (!track || track === h.track) return;
    try { h.src?.disconnect(); } catch { /* Broken */ }
    h.track = track;
    h.src = S.ctx.createMediaStreamSource(new MediaStream([track]));
    h.an = S.ctx.createAnalyser();
    h.an.fftSize = 1024;
    h.src.connect(h.an);
  };
  const hook = (el) => {
    let h = S.hooks.get(el);
    if (!h) {
      h = { stream: null, track: null, src: null, an: null, buf: new Float32Array(1024), loads: 0 };
      el.addEventListener('loadstart', () => { h.loads++; });
      S.hooks.set(el, h);
    }
    if (!h.stream && el.readyState >= 1 && el.captureStream) {
      try { h.stream = el.captureStream(); h.stream.addEventListener('addtrack', () => attach(h)); } catch { /* Retry on next tick */ }
    }
    if (h.stream) { try { attach(h); } catch { /* Retry on next tick */ } }
    return h;
  };
  const tick = () => {
    const t0 = performance.now();
    const d = typeof window.__pcPreviewDiag === 'function' ? window.__pcPreviewDiag() : null;
    const st = getState();
    const els = [];
    for (const el of document.querySelectorAll('audio')) {
      const h = hook(el);
      let rms = null;
      if (h.an) {
        h.an.getFloatTimeDomainData(h.buf);
        let e = 0;
        for (const v of h.buf) e += v * v;
        rms = Math.sqrt(e / h.buf.length);
      }
      els.push({ clip: el.getAttribute('data-pc-audio-clip'), paused: el.paused, ct: el.currentTime, ready: el.readyState, loads: h.loads, rms });
    }
    S.rows.push({ w: performance.timeOrigin + performance.now(), t: st.t, playing: st.playing, stalled: d ? d.mediaStalled : null, count: d ? d.mediaStallCount : null, els });
    S.maxTickMs = Math.max(S.maxTickMs, performance.now() - t0);
  };
  S.timer = setInterval(tick, everyMs);
  window.__stallSampler = S;
  tick();
  return true;
};
const READ_SAMPLER = () => ({ rows: window.__stallSampler.rows, maxTickMs: window.__stallSampler.maxTickMs });
const STOP_SAMPLER = () => { const S = window.__stallSampler; if (S) { clearInterval(S.timer); S.timer = null; } return true; };
/** Hold main thread in stage page (front) for `ms` ms: tick loop emits no ticks. Returns start and end wall-clock ms */
const HOLD_STAGE = (ms) => {
  // Stage replaced performance.now with virtual clock (sync spin loops forever); real clock is in __pcRealNow (src/kernel/clock.ts)
  const now = () => performance.timeOrigin + (typeof window.__pcRealNow === 'function' ? window.__pcRealNow() : performance.now());
  const start = now();
  while (now() < start + ms);
  return { start, end: now(), virtualClock: typeof window.__pcRealNow === 'function' };
};
/** Save wall-clock timestamp for frame in recorder (`at` in INSTALL_RECORDERS is performance.now(), converted to same scale here) */
const WALL_FRAMES = () => window.__pcFrames.map((f) => ({ sec: f.sec, w: performance.timeOrigin + f.at }));

/* ------------------------------------------------------------------ Utilities */

/**
 * Proportionally sample a **visible** x on the timeline ruler.
 *
 * Ruler element is much wider than viewport (30 seconds × pxPerSec easily reaches thousands of
 * pixels, scrolling horizontally via `.pc-tl-scroll`), and taking a ratio against `box.width`
 * calculates coordinates outside viewport: clicking there with `page.mouse` does nothing.
 * Here we only sample within "ruler left edge to viewport right edge".
 */
const xAt = (box, frac) => {
  const left = box.x + 24;
  const right = Math.min(box.x + box.width, VIEWPORT_W) - 24;
  return left + Math.max(0, right - left) * frac;
};

const stats = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { n: xs.length, mean: +mean.toFixed(3), p50: +s[Math.floor(s.length * 0.5)].toFixed(3), min: +s[0].toFixed(3), max: +s[s.length - 1].toFixed(3) };
};

/**
 * Wait for K1 resident probe to finish this round (remove `ProbeGate` overlay).
 *
 * **Must wait after every project switch**: the probe writes `costs` based on real results,
 * whereas this probe next overwrites the same set of `identityKey` entries with manually
 * prepared values. Without waiting, both sides will overwrite each other.
 */
async function waitProbeIdle(page, timeoutMs = 300000) {
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/probeRunner.ts');
    return m.probeProgress().running === false;
  }, { timeout: timeoutMs, polling: 300 }).catch(() => {});
}

/** Internal state on stage side (cannot touch document cross-origin, can only query `__pcStageDiag`) */
async function stageDiag(page, id) {
  const frame = page.frames().find((f) => f.url().includes('stage=1') && f.url().includes(`id=${id}`));
  if (!frame) return null;
  return await frame.evaluate(() => (typeof window.__pcStageDiag === 'function' ? window.__pcStageDiag() : null)).catch(() => null);
}
async function frontDiag(page) {
  const which = await page.evaluate(() => (typeof window.__pcPreviewDiag === 'function' ? window.__pcPreviewDiag() : null));
  if (!which) return { preview: null, stage: null };
  return { preview: which, stage: await stageDiag(page, which.frontId) };
}

/* ------------------------------------------------------------------ Main flow */

const browser = await puppeteer.launch({
  headless: true,
  // A single evaluate may need to wait for the stage to finish a full catch-up run; default 180s is not enough
  protocolTimeout: 240000,
  args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    // R2 report: without these two, headless Chrome rAF drops to 10 Hz here, and the tick loop never gets frames
    '--disable-gpu-vsync', '--disable-frame-rate-limit',
    // "Stalled audio" case plays main doc <audio> without gestures or speaker sound: checks element state and captureStream energy
    '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
let exitCode = 0;
let page = null;
try {
  server = await startServer();
  page = await browser.newPage();
  await page.setViewport({ width: VIEWPORT_W, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  step('goto editor');
  await page.goto(origin + EDITOR_URL, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('iframe[data-pc="stage-frame"]', { timeout: 180000 });
  step('stage iframe up');
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return m.backRole() === 'back';
  }, { timeout: 180000, polling: 500 });
  step('two stages registered');
  await page.evaluate(INSTALL_RECORDERS);
  step('recorders installed');

  /* ============================================================ 1. K4 Tick */
  if (wants('ticks')) {
    const cadence = {};
    for (const fps of [24, 25, 30, 60]) {
      step(`cadence ${fps}: build`);
      await page.evaluate(BUILD, { fps, duration: seconds + 5, cards: [{ id: 'probe-css' }] });
      await waitProbeIdle(page);
      step(`cadence ${fps}: set costs`);
      await page.evaluate(SET_COSTS, { specs: { 'probe-css': { stepMs: 1, catchUpMs: 10, vtOk: true, seekOk: true, seekMs: 1 } } });
      step(`cadence ${fps}: seek 0`);
      await page.evaluate(async () => {
        const { actions } = await import('/src/store/project.ts');
        actions.seek(0);
      });
      await sleep(300);
      await page.evaluate(RESET_RECORDERS);
      step(`cadence ${fps}: play`);
      await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.play(); });
      await sleep(seconds * 1000);
      step(`cadence ${fps}: pause`);
      await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.pause(); });
      await sleep(400);
      const rec = await page.evaluate(READ_RECORDERS);
      // pinned architecture 10: normal playback must never be classified as jank (24 / 25 fps is false-trigger tier in R5-6)
      const stallDiag = await page.evaluate(() => (typeof window.__pcPreviewDiag === 'function' ? window.__pcPreviewDiag() : null));
      const gaps = [];
      const secDiffs = [];
      for (let i = 1; i < rec.frames.length; i++) {
        gaps.push(rec.frames[i].at - rec.frames[i - 1].at);
        secDiffs.push(rec.frames[i].sec - rec.frames[i - 1].sec);
      }
      const want = 1000 / fps;
      const g = stats(gaps);
      const wrongSec = secDiffs.filter((d) => Math.abs(d - 1 / fps) > 1e-6).length;
      // "Short tick" = arrival interval < half a tick: only counts if a tick was actually skipped, not rAF jitter
      const shortBeats = gaps.filter((x) => x < want * 0.5).length;
      cadence[fps] = { beats: rec.frames.length, want: +want.toFixed(3), gap: g, secDiffWrong: wrongSec, shortBeats, longTasks: rec.longTasks.length,
        mediaStallCount: stallDiag?.mediaStallCount ?? null, mediaGapMaxMs: stallDiag ? +Number(stallDiag.mediaGapMaxMs).toFixed(3) : null };
      check(stallDiag && stallDiag.mediaStallCount === 0,
        `${fps} fps: played ${seconds} seconds, mediaStalled fired 0 times (pinned architecture 10)`,
        { count: stallDiag?.mediaStallCount, overBeatMaxMs: stallDiag?.mediaGapMaxMs });
      check(g && Math.abs(g.mean - want) <= 1, `${fps} fps: mean frame arrival interval = ${want.toFixed(2)} ± 1 ms`, g);
      check(wrongSec === 0, `${fps} fps: the sec difference between two consecutive frames is always 1/fps`, { wrongSec, n: secDiffs.length });
      /*
       * The task brief only specifies "short tick" for **30 fps** ("no 16.6 ms short ticks at 30 fps").
       * Other frame rates are counted without judging: short intervals measured at 60 fps are **jitter
       * from parent page receiving postMessage**: two `frame` events arrive consecutively while ticks
       * on the stage side are accurate (`sec` difference is strictly 1/fps, exactly 600 ticks in 10 s).
       * If a tick was truly skipped, `secDiffWrong` will be non-zero.
       */
      if (fps === 30) check(shortBeats === 0, `${fps} fps: no short 16.6 ms ticks`, { shortBeats });
      // "Zero jank in main document": main document long tasks = 0 during playback
      check(rec.longTasks.length === 0, `${fps} fps: 0 long tasks in the main document during playback`, rec.longTasks.slice(0, 3));
    }
    out.cases['ticks'] = cadence;
  }

  /* ============================================================ 1b. Sound stops on stall (positive acceptance check of audio watchdog) */
  if (wants('stall-sound')) {
    /*
     * Creating stall: hold the main thread for HOLD_MS ms in the **stage page** (the front iframe):
     * its tick loop cannot emit a single tick during this time, and the parent page receives no `frame`.
     * This is the "late next tick" itself; without modifying src/ or touching `setMediaStalled`,
     * it tests Preview's own watchdog. Parent page is another document (another event loop), so its
     * setTimeout / sampler runs as usual; if parent page is also dragged down during the hold (long
     * task), it indicates stage and parent page share a process in this Chrome, making measurements
     * untrustworthy, which "parent page not dragged down" below will catch.
     */
    const TONE_SEC = 40, FPS = 30, THR = 0.003;
    const HOLDS_MS = [700, 400];
    const BEAT_MS = 1000 / FPS, MEDIA_STALL_MS = 40;
    step('stall: build');
    const built = await page.evaluate(BUILD, { fps: FPS, duration: TONE_SEC, cards: [{ id: 'probe-css' }] });
    step('stall: add tone');
    const tone = await page.evaluate(ADD_TONE, { sec: TONE_SEC });
    step('stall: tone added');
    check(!!tone.clipId, 'Stall sound: the sound clip was placed on the timeline', tone);
    await waitProbeIdle(page);
    await page.evaluate(SET_COSTS, { specs: { 'probe-css': { stepMs: 1, catchUpMs: 10, vtOk: true, seekOk: true, seekMs: 1 } } });
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(0); });
    await sleep(300);
    await page.evaluate(RESET_RECORDERS);
    step('stall: install sampler');
    await page.evaluate(INSTALL_SAMPLER, { everyMs: 5 });
    step('stall: play');
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.play(); });
    const waitT = (to) => page.waitForFunction(async (x) => (await import('/src/store/project.ts')).getState().t >= x, { timeout: 60000, polling: 50 }, to).then(() => true, () => false);
    const waitSounding = () => page.waitForFunction(() => {
      const rows = window.__stallSampler.rows; const r = rows.at(-1);
      return !!r && !r.stalled && r.els.length > 0 && r.els.every((e) => !e.paused && e.ready >= 3 && e.ct > 0.2) && rows.length > 20 && (r.els[0].rms ?? 0) > 0.003;
    }, { timeout: 60000, polling: 50 }).then(() => true, () => false);
    check(await waitT(1.0), 'Stall sound: the playhead reached 1 second (the stage is advancing tick by tick)');
    check(await waitSounding(), 'Stall sound: the sound is audible before the stall (not paused, data ready, captureStream measured energy)');
    const front = await frontDiag(page);
    const frontFrame = page.frames().find((f) => f.url().includes('stage=1') && f.url().includes(`id=${front.preview.frontId}`));
    check(!!frontFrame, 'Stall sound: found the iframe of the front stage', front.preview?.frontId);
    const holds = [];
    for (const [i, holdMs] of HOLDS_MS.entries()) {
      // Between stalls, wait for audio recovery and playhead progress before running next (checks watchdog triggers again after recovery)
      if (i > 0) { check(await waitSounding(), `Stall sound #${i + 1}: the sound is audible again after the previous stall`); await sleep(500); }
      step(`stall: hold #${i + 1} ${holdMs} ms`);
      const p = frontFrame.evaluate(HOLD_STAGE, holdMs);
      const win = await p;
      holds.push({ holdMs, ...win });
      // Wait for recovery: mediaStalled returns to false, audio returns,
      // playhead advances past pre-hold position
      const recovered = await page.waitForFunction(() => {
        const r = window.__stallSampler.rows.at(-1);
        return !!r && r.playing && r.stalled === false && r.els.every((e) => !e.paused);
      }, { timeout: 30000, polling: 25 }).then(() => true, () => false);
      check(recovered, `Stall sound #${i + 1}: after the stall ends, mediaStalled returns to false and the sound plays again`);
      await sleep(700);   // After recovery, watch another short segment, enough to determine "resumed playback"
    }
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.pause(); });
    await sleep(300);
    const { rows, maxTickMs } = await page.evaluate(READ_SAMPLER);
    const frames = await page.evaluate(WALL_FRAMES);
    const finalDiag = await page.evaluate(() => window.__pcPreviewDiag());
    await page.evaluate(STOP_SAMPLER);

    /* ---- Analysis ---- */
    const clipStart = tone.start ?? 0;
    const analyses = [];
    for (const [i, h] of holds.entries()) {
      const n = i + 1;
      const tag = (s) => `Stall sound #${n} (hold ${h.holdMs} ms): ${s}`;
      // Last tick before stall, late tick: longest adjacent frame interval within hold interval [start,end]
      let best = null;
      for (let k = 0; k + 1 < frames.length; k++) {
        const a = frames[k], b = frames[k + 1];
        if (a.w < h.end && b.w > h.start && (!best || b.w - a.w > best.b.w - best.a.w)) best = { a, b };
      }
      const A = { holdMs: h.holdMs, holdStart: h.start, holdEnd: h.end, holdActualMs: +(h.end - h.start).toFixed(1) };
      check(!!best, tag('found the last tick before the stall and the late tick'), A);
      if (!best) continue;
      const lastBefore = best.a.w, late = best.b.w;
      A.beatGapMs = +(late - lastBefore).toFixed(1);
      A.lateFrameSec = best.b.sec;
      check(late - lastBefore >= 0.8 * h.holdMs, tag('The stage really stopped: the gap between two adjacent ticks is no shorter than 80% of the hold duration'), { gap: A.beatGapMs });
      const win = rows.filter((r) => r.w >= lastBefore - 200 && r.w <= late + 200);
      // Parent page not stalled: max interval between adjacent sampler rows in this segment
      // (< half the hold duration, otherwise parent page was also stalled, measurement untrustworthy)
      let maxRowGap = 0;
      for (let k = 1; k < win.length; k++) maxRowGap = Math.max(maxRowGap, win[k].w - win[k - 1].w);
      A.parentMaxSampleGapMs = +maxRowGap.toFixed(1);
      check(maxRowGap < h.holdMs / 2, tag('The parent page was not held up too (the sampler keeps going as usual)'), { maxRowGap, holdMs: h.holdMs });

      const before = rows.filter((r) => r.w <= lastBefore).at(-1);
      A.before = before && { t: before.t, stalled: before.stalled, count: before.count, ct: before.els.map((e) => +e.ct.toFixed(3)), paused: before.els.map((e) => e.paused) };
      check(before && before.stalled === false && before.els.length > 0 && before.els.every((e) => !e.paused), tag('Before the stall starts, mediaStalled is false and the sound is playing'), A.before);
      const countBefore = before?.count ?? 0;

      // ② Watchdog trips **before** the late tick arrives
      const trip = rows.find((r) => r.w > lastBefore && r.stalled === true);
      A.tripAt = trip ? +(trip.w - lastBefore).toFixed(1) : null;               // Time from last tick before stall (nominal = tick length + 40 ms ≈ 73 ms, record only)
      A.tripMarginMs = trip ? +(late - trip.w).toFixed(1) : null;               // How much earlier than the late tick
      A.expectedTripMs = +(BEAT_MS + MEDIA_STALL_MS).toFixed(1);
      check(!!trip && trip.w < late, tag('mediaStalled is already true before the late tick arrives (tripped on the spot, not after the fact)'), { tripAfterLastBeatMs: A.tripAt, marginMs: A.tripMarginMs });
      check(!!trip && trip.count === countBefore + 1, tag('mediaStallCount goes up by 1 accordingly'), { before: countBefore, atTrip: trip?.count });

      // ③ Audio stops immediately: after trip and before late tick arrives, every audio element is paused
      // and remains stopped
      const paused = trip && rows.find((r) => r.w >= trip.w && r.els.length > 0 && r.els.every((e) => e.paused));
      A.pausedAfterTripMs = paused ? +(paused.w - trip.w).toFixed(1) : null;   // Record only
      A.pausedAfterLastBeatMs = paused ? +(paused.w - lastBefore).toFixed(1) : null;
      check(!!paused && paused.w < late, tag('All sound elements are already paused before the late tick arrives'), { pausedAfterTripMs: A.pausedAfterTripMs, pausedAfterLastBeatMs: A.pausedAfterLastBeatMs });
      if (paused) {
        const during = rows.filter((r) => r.w >= paused.w && r.w < late);
        const resurrected = during.filter((r) => r.els.some((e) => !e.paused));
        check(resurrected.length === 0, tag('No element was played again between the stop and the late tick'), resurrected.slice(0, 2));
        /*
         * Energy: after an element is paused, the captureStream → AnalyserNode path still needs to drain a
         * short buffer before reading silence (measured 50-90 ms, readings in this span still fluctuate
         * with the 3 Hz audio swing), so instead of using "N ms after paused" as the boundary, check that
         * readings are below threshold during the **last 100 ms before the late tick arrives**; how long
         * the drain took is record only.
         * Energy was measured before stall, showing this capture path is alive and reading 0 is not because
         * it was disconnected.
         */
        const quiet = rows.filter((r) => r.w >= late - 100 && r.w < late);
        const loud = rows.filter((r) => r.w >= paused.w && r.w < late && r.els.some((e) => (e.rms ?? 0) >= THR)).at(-1);
        A.energyDrainedAfterPauseMs = loud ? +(loud.w - paused.w).toFixed(1) : 0;
        const prePeak = Math.max(0, ...rows.filter((r) => r.w <= lastBefore).flatMap((r) => r.els.map((e) => e.rms ?? 0)));
        const quietPeak = Math.max(0, ...quiet.flatMap((r) => r.els.map((e) => e.rms ?? 0)));
        A.energy = { prePeak: +prePeak.toFixed(4), quietPeak: +quietPeak.toFixed(5), samplesQuiet: quiet.length };
        check(prePeak >= THR, tag('Energy was measured before the stall (the capture path is alive)'), A.energy);
        check(quiet.length >= 3 && quietPeak < THR, tag('In the last 100 ms before the late tick arrives, the real-time energy is below the threshold (the sound really stopped)'), A.energy);
        A.ctAtPause = paused.els.map((e) => +e.ct.toFixed(3));
        A.tAtPause = +paused.t.toFixed(3);
      }

      // ④ Recovery: after ticks return, mediaStalled returns to false, audio resumes from current playhead
      const rec = rows.find((r) => r.w > late && r.stalled === false);
      A.recoveredAfterLateFrameMs = rec ? +(rec.w - late).toFixed(1) : null;
      check(!!rec, tag('After ticks resume, mediaStalled returns to false'), A.recoveredAfterLateFrameMs);
      const resume = rec && rows.find((r) => r.w >= rec.w && r.els.length > 0 && r.els.every((e) => !e.paused && e.ready >= 3));
      check(!!resume, tag('the sound plays again'));
      if (resume) {
        const settled = rows.find((r) => r.w >= resume.w + 400 && r.els.every((e) => !e.paused));
        const probeRow = settled ?? resume;
        const el = probeRow.els[0];
        const expected = probeRow.t - clipStart;
        A.afterResume = { t: +probeRow.t.toFixed(3), ct: +el.ct.toFixed(3), expectedCt: +expected.toFixed(3), diff: +(el.ct - expected).toFixed(3) };
        check(Math.abs(el.ct - expected) <= 0.25, tag('The sound position follows the current playhead (deviation ≤ 0.25 s, half of the hard-seek threshold)'), A.afterResume);
        if (paused) check(el.ct >= paused.els[0].ct - 0.02 && el.ct > 0.5, tag('Did not replay from the start or go backward (position after resuming ≥ position at the stop, and not at the beginning)'), { ctAtPause: paused.els[0].ct, ctAfter: el.ct });
        const jump = rows.filter((r) => r.w >= resume.w).slice(0, 80).map((r, k, arr) => (k ? Math.abs(r.els[0].ct - arr[k - 1].els[0].ct) : 0));
        check(Math.max(0, ...jump) < 0.2, tag('Position is continuous in the first 400 ms after resuming (position difference between adjacent samples < 0.2 s, no jumps)'), { maxStep: +Math.max(0, ...jump).toFixed(3) });
      }
      if (has('--trace')) A.frameTrace = frames.filter((f) => f.w >= lastBefore - 100 && f.w <= late + 150).map((f) => ({ dt: +(f.w - lastBefore).toFixed(1), sec: f.sec }));
      if (has('--trace')) A.trace = rows.filter((r) => r.w >= lastBefore - 30 && r.w <= late + 120).map((r) => ({ dt: +(r.w - lastBefore).toFixed(1), t: +r.t.toFixed(3), st: r.stalled, n: r.count, el: r.els.map((e) => [e.paused ? 'P' : 'p', +e.ct.toFixed(3), e.ready, e.rms === null ? null : +e.rms.toFixed(3)]) }));
      analyses.push(A);
    }
    // Entire sample: position does not regress, elements not reloaded, final moment not stuck in stall
    let backward = 0; const loads = new Set();
    for (let k = 1; k < rows.length; k++) {
      if (rows[k].els[0] && rows[k - 1].els[0] && rows[k].els[0].ct < rows[k - 1].els[0].ct - 0.05) backward++;
      for (const e of rows[k].els) loads.add(e.loads);
    }
    check(backward === 0, 'Stall sound: the sound position never goes backward across the whole sampling (no restart from the beginning)', { backward });
    check(loads.size === 1, 'Stall sound: the sound element was not reloaded across the whole sampling', [...loads]);
    check(finalDiag.mediaStallCount >= holds.length, `Stall sound: mediaStallCount ≥ ${holds.length} in this round of playback`, finalDiag.mediaStallCount);
    out.cases['stall-sound'] = { toneClip: tone, holds: analyses, samples: rows.length, maxSamplerTickMs: +maxTickMs.toFixed(2), mediaStallCount: finalDiag.mediaStallCount, mediaGapMaxMs: +Number(finalDiag.mediaGapMaxMs).toFixed(1), built: built.fps };
  }

  /* ============================================================ 2. Wrap-up when playing to the end */
  if (wants('reach-end')) {
    await page.evaluate(BUILD, { fps: 30, duration: 2, cards: [{ id: 'probe-css' }] });
    await waitProbeIdle(page);
    await page.evaluate(SET_COSTS, { specs: { 'probe-css': { stepMs: 1, catchUpMs: 10, vtOk: true, seekOk: true, seekMs: 1 } } });
    await page.evaluate(async () => {
      const { actions } = await import('/src/store/project.ts');
      actions.seek(1.2);
    });
    await sleep(300);
    await page.evaluate(RESET_RECORDERS);
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.play(); });
    await page.waitForFunction(() => (window.__pcEvents ?? []).some((e) => e.type === 'ended'), { timeout: 30000, polling: 50 }).catch(() => {});
    await sleep(1200);
    const rec = await page.evaluate(READ_RECORDERS);
    const state = await page.evaluate(async () => {
      const { getState } = await import('/src/store/project.ts');
      const s = getState();
      return { t: s.t, playing: s.playing, duration: s.project.duration };
    });
    const diag = await frontDiag(page);
    const ended = rec.events.find((e) => e.type === 'ended');
    out.cases['reach-end'] = { ended, state, stage: diag.stage, settled: rec.events.filter((e) => e.type === 'settled') };
    check(!!ended, 'Playback reached the end and posted ended');
    check(state.playing === false, 'After ended, store.playing is false', state);
    check(Math.abs(state.t - state.duration) < 1e-6, 'After ended, store.t = duration', state);
    check(diag.stage && diag.stage.beatRunning === false, 'After ended, the tick loop stopped', diag.stage);
    check(diag.stage && diag.stage.suppressed.length === 0, 'The last frame does not stay in the suppression state (suppressed is empty)', diag.stage?.suppressed);

    /*
     * R7-11 regression: when playhead stops at the end, **pressing play again must replay from earliest
     * card**, not ended immediately.
     * Legacy wall-clock loop always did this (`Preview.tsx:155-158`), missed after flipping the switch.
     */
    await page.evaluate(RESET_RECORDERS);
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.play(); });
    await sleep(800);
    const replay = await page.evaluate(READ_RECORDERS);
    const replayState = await page.evaluate(async () => {
      const { getState } = await import('/src/store/project.ts');
      const s = getState();
      return { t: s.t, playing: s.playing };
    });
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.pause(); });
    await sleep(300);
    const firstSec = replay.frames[0]?.sec ?? null;
    out.cases['replay-after-end'] = { frames: replay.frames.length, firstSec, lastSec: replay.frames.at(-1)?.sec ?? null,
      endedAgain: replay.events.filter((e) => e.type === 'ended').length, state: replayState };
    check(replay.frames.length > 5, 'Pressing play again after reaching the end: it really starts playing (multiple frames received)', out.cases['replay-after-end']);
    check(firstSec !== null && firstSec < 0.5, 'Pressing play again after reaching the end: starts from the earliest card (0 seconds), not from duration', out.cases['replay-after-end']);
    check(out.cases['replay-after-end'].endedAgain === 0, 'Pressing play again after reaching the end: does not immediately end again', out.cases['replay-after-end']);
  }

  /* ============================================================ 3. Heavy cards catch up to live render after pause (path 1 / path 2) */
  if (wants('frame-catch-up')) {
    /* ---- Path 1: heavy cards with vtOk catch up on their own in visible stage, post settled with clipId ---- */
    const built = await page.evaluate(BUILD, {
      fps: 30, duration: 30,
      cards: [{ id: 'probe-css', duration: 30 }, { id: 'probe-motion-js', duration: 30 }],
    });
    await waitProbeIdle(page);
    // probe-css classified as heavy (capped) and vtOk → path 1; probe-motion-js classified as light (cheap)
    await page.evaluate(SET_COSTS, {
      specs: {
        'probe-css': { stepMs: 1, catchUpMs: 10, vtOk: true, seekOk: false, seekMs: null, capped: true },
        'probe-motion-js': { stepMs: 1, catchUpMs: 5, vtOk: false, seekOk: false, seekMs: null, kind: 'random' },
      },
    });
    await sleep(200);
    await page.evaluate(RESET_RECORDERS);
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(8); });
    await sleep(2500);
    let rec = await page.evaluate(READ_RECORDERS);
    let diag = await frontDiag(page);
    const cssClip = built.byCard['probe-css']?.[0];
    const firstPath = rec.events.filter((e) => e.type === 'settled' && (e.clipIds ?? []).includes(cssClip));
    out.cases['frame-catch-up-path-1'] = { clipId: cssClip, settled: firstPath, stage: diag.stage, preview: diag.preview };
    check(firstPath.length > 0, 'Path 1: settled carries that card\'s clipId', rec.events);
    check(diag.stage && !diag.stage.settling.includes(cssClip), 'Path 1: after the catch-up finishes, .pc-settling is removed', diag.stage?.settling);
    check(diag.stage && !diag.stage.snapshots.includes(cssClip), 'Path 1: after the catch-up finishes, it is not in snapshots', diag.stage?.snapshots);

    /* ---- Path 2: heavy cards with vtOk = false → swap after whole scene catch-up run ---- */
    await page.evaluate(SET_COSTS, {
      specs: {
        'probe-css': { stepMs: 1, catchUpMs: 5, vtOk: true, seekOk: true, seekMs: 1 },
        'probe-motion-js': { stepMs: 1, catchUpMs: 10, vtOk: false, seekOk: false, seekMs: null, capped: true },
      },
    });
    await sleep(200);
    const beforeFront = (await page.evaluate(() => window.__pcPreviewDiag()))?.frontId;
    await page.evaluate(RESET_RECORDERS);
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(12); });
    await page.waitForFunction(() => (window.__pcEvents ?? []).some((e) => e.type === 'settled' && (e.clipIds ?? []).length === 0),
      { timeout: 60000, polling: 100 }).catch(() => {});
    await sleep(600);
    rec = await page.evaluate(READ_RECORDERS);
    diag = await frontDiag(page);
    const jsClip = built.byCard['probe-motion-js']?.[0];
    const swapped = rec.events.filter((e) => e.type === 'settled' && (e.clipIds ?? []).length === 0);
    out.cases['frame-catch-up-path-2'] = { clipId: jsClip, beforeFront, afterFront: diag.preview?.frontId, settled: swapped, stage: diag.stage };
    check(swapped.length > 0, 'Path 2: after the swap the new front posted settled (clipIds empty)', rec.events);
    check(diag.preview && diag.preview.frontId !== beforeFront, 'Path 2: the two iframes swapped identities', { beforeFront, after: diag.preview?.frontId });
    check(diag.stage && diag.stage.snapshots.length === 0, 'Path 2: all snapshot planes were removed after the swap', diag.stage?.snapshots);
    check(diag.stage && diag.stage.suppressed.length === 0 && diag.stage.settling.length === 0,
      'Path 2: the component is not in any set', { suppressed: diag.stage?.suppressed, settling: diag.stage?.settling });

    /* ---- Click timeline 10 times in a row: no resends triggered, last one swaps normally ---- */
    await page.evaluate(RESET_RECORDERS);
    const front0 = (await page.evaluate(() => window.__pcPreviewDiag()))?.frontId;
    await page.evaluate(async () => {
      const { actions } = await import('/src/store/project.ts');
      for (let i = 0; i < 10; i++) actions.seek(13 + i * 0.4);
    });
    await page.waitForFunction(() => (window.__pcEvents ?? []).some((e) => e.type === 'settled' && (e.clipIds ?? []).length === 0),
      { timeout: 60000, polling: 100 }).catch(() => {});
    await sleep(800);
    rec = await page.evaluate(READ_RECORDERS);
    diag = await frontDiag(page);
    const swaps = rec.events.filter((e) => e.type === 'settled' && (e.clipIds ?? []).length === 0);
    out.cases['ten rapid clicks'] = { swaps: swaps.length, front0, front1: diag.preview?.frontId, errors: errors.length };
    check(swaps.length === 1, 'Clicking the timeline 10 times in a row swaps only once (the first nine were aborted, none resent)', swaps.length);
    check(diag.preview && diag.preview.frontId !== front0, 'The last swap goes through normally', { front0, front1: diag.preview?.frontId });
  }

  /* ============================================================ 4. K3(a′) direct seek for seekOk */
  if (wants('jump')) {
    const built = await page.evaluate(BUILD, { fps: 30, duration: 60, cards: [{ id: 'probe-css', duration: 60 }] });
    await waitProbeIdle(page);
    const clipId = built.byCard['probe-css'][0];
    // seekOk and seekMs ≤ B (at 30 fps, B = 23.3 ms) → (a′) direct seek, does not enter prerender set
    const plan = await page.evaluate(SET_COSTS, {
      specs: { 'probe-css': { stepMs: 2, catchUpMs: 3000, vtOk: true, seekOk: true, seekMs: 3 } },
    });
    check((plan.prerenderSet ?? []).length === 0, 'The (a′) card does not appear in prerenderSet', plan.prerenderSet);
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(1); });
    await sleep(500);
    const before = await frontDiag(page);
    const genOf = (d, id) => (d?.stage?.remountGen ?? []).find((e) => e[0] === id)?.[1] ?? 0;
    const gen0 = genOf(before, clipId);
    // Jump forward to second 50: reached in one step, **no remount**
    const t0 = Date.now();
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(50); });
    await sleep(500);
    const mid = await frontDiag(page);
    const forwardMs = Date.now() - t0;
    check(genOf(mid, clipId) === gen0, '(a′) a forward jump does not remount', { gen0, gen1: genOf(mid, clipId) });
    check(Math.abs((mid.stage?.t ?? 0) - 50) < 1e-6, '(a′) a forward jump lands in one step', mid.stage?.t);
    // Scrub back from second 55 to second 20: reached in one step after **remounting once**
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(55); });
    await sleep(400);
    const at55 = await frontDiag(page);
    const gen55 = genOf(at55, clipId);
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(20); });
    await sleep(500);
    const back = await frontDiag(page);
    out.cases['jump'] = { clipId, gen0, gen50: genOf(mid, clipId), gen55, gen20: genOf(back, clipId), forwardMs, prerenderSet: plan.prerenderSet };
    check(genOf(back, clipId) === gen55 + 1, '(a′) a backward jump remounts exactly once', { gen55, gen20: genOf(back, clipId) });
    check(Math.abs((back.stage?.t ?? 0) - 20) < 1e-6, '(a′) lands in one step after a backward jump', back.stage?.t);
    check((back.stage?.settling ?? []).length === 0, '(a′) does not stay in the frame catch-up state', back.stage?.settling);
  }

  /* ====================================== 4b. Precise live render after timeline click / scrub release (pinned architecture 9) */
  if (wants('timeline')) {
    /*
     * This measures a **real mouse**, not `actions.seek()`. This is precisely the gap in R5-16:
     * the release coordinate usually equals the last flush position (`t` unchanged); clicking
     * on the ruler batches `seek` and `beginScrub` into a single render within the same React
     * event (at that moment `scrubbing` is already true). In both cases, if `scrubbing` is not
     * in the dedup key of `setTime`, that `settle: true` will never be sent, and cards classified
     * as heavy stay stuck on snapshots.
     *
     * The criterion uses `settled` from K5 path 1: it only starts upon receiving
     * `setTime(t, { settle: true })`.
     */
    const built = await page.evaluate(BUILD, { fps: 30, duration: 30, cards: [{ id: 'probe-css', duration: 30 }] });
    await waitProbeIdle(page);
    const cssClip = built.byCard['probe-css'][0];
    await page.evaluate(SET_COSTS, {
      specs: { 'probe-css': { stepMs: 1, catchUpMs: 10, vtOk: true, seekOk: false, seekMs: null, capped: true } },
    });
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(1); });
    await sleep(800);
    /*
     * When Claude Code / agy / codex is not installed on this machine, the AI panel automatically
     * pops up a settings dialog whose `.ais-backdrop` covers the entire page: if not closed, mouse
     * clicks cannot reach the timeline at all (`elementFromPoint` hits the overlay).
     * Press Esc to close, at most three times.
     */
    for (let i = 0; i < 3; i++) {
      if (!(await page.evaluate(() => !!document.querySelector('.ais-backdrop, .pc-dialog-mask')))) break;
      await page.keyboard.press('Escape');
      await sleep(300);
    }
    const ruler = await page.$('[data-pc="ruler"]');
    const box = ruler ? await ruler.boundingBox() : null;
    check(!!box, 'The timeline ruler is on the page', box);
    if (box) {
      // Click point actually lands on the ruler (not on an overlay): without checking this,
      // the next two will fail as "settle not sent"
      const hit = await page.evaluate(([px, py]) => {
        const el = document.elementFromPoint(px, py);
        return { tag: el ? `${el.tagName}.${el.className}`.slice(0, 80) : null, onRuler: !!el?.closest('[data-pc="ruler"]') };
      }, [xAt(box, 0.25), box.y + box.height / 2]);
      out.cases['timeline click hit'] = hit;
      check(hit.onRuler, 'The click point lands on the timeline ruler (no overlay in the way)', hit);
    }
    const waitSettled = (id) => page.waitForFunction(
      (clip) => (window.__pcEvents ?? []).some((e) => e.type === 'settled' && (e.clipIds ?? []).includes(clip)),
      { timeout: 30000, polling: 50 }, id).then(() => true, () => false);
    if (box) {
      const y = box.y + box.height / 2;

      /* ---- ① Click once on the ruler ---- */
      await page.evaluate(RESET_RECORDERS);
      const beforeClick = await page.evaluate(async () => (await import('/src/store/project.ts')).getState().t);
      await page.mouse.move(xAt(box, 0.25), y);
      await page.mouse.down();
      await page.mouse.up();
      const clickSettled = await waitSettled(cssClip);
      const afterClick = await page.evaluate(async () => (await import('/src/store/project.ts')).getState().t);

      /* ---- ② Hold, scrub for a bit, then release ---- */
      await page.evaluate(RESET_RECORDERS);
      await page.mouse.move(xAt(box, 0.45), y);
      await page.mouse.down();
      for (const f of [0.55, 0.65, 0.75, 0.85]) {
        await page.mouse.move(xAt(box, f), y);
        await sleep(60);
      }
      await sleep(200);           // Let the last flush hand over t: release coordinate is therefore identical to store.t
      await page.mouse.up();
      const dragSettled = await waitSettled(cssClip);
      const afterDrag = await page.evaluate(async () => (await import('/src/store/project.ts')).getState().t);
      const diag = await frontDiag(page);

      out.cases['timeline'] = { clipId: cssClip, beforeClick, afterClick, afterDrag, clickSettled, dragSettled, stage: diag.stage };
      check(Math.abs(afterClick - beforeClick) > 1e-6, 'Clicking the ruler moved the playhead', { beforeClick, afterClick });
      check(clickSettled, 'settled arrives after clicking the timeline (cards judged heavy catch up to exact live render)', out.cases['timeline']);
      check(dragSettled, 'settled arrives after the drag is released', out.cases['timeline']);
      check(diag.stage && !diag.stage.settling.includes(cssClip), 'After release, .pc-settling was removed', diag.stage?.settling);
      check(diag.stage && !diag.stage.snapshots.includes(cssClip), 'After release, it is not in snapshots', diag.stage?.snapshots);
    }
  }

  /* ============================================================ 5. K6 downgrade */
  if (wants('downgrade')) {
    const built = await page.evaluate(BUILD, {
      fps: 30, duration: 20,
      cards: [{ id: 'probe-slow', duration: 20, params: { burnMs: 60, label: 'K6' } }, { id: 'probe-css', duration: 20 }],
    });
    await waitProbeIdle(page);
    const slowClip = built.byCard['probe-slow'][0];
    // Both classified as light: probe-slow **probe score** is written as very cheap, but actually
    // takes 60 ms: this is exactly what K6 is meant to catch
    await page.evaluate(SET_COSTS, {
      specs: {
        'probe-slow': { stepMs: 1, catchUpMs: 0, kind: 'random', vtOk: true, seekOk: true, seekMs: 1 },
        'probe-css': { stepMs: 1, catchUpMs: 5, vtOk: true, seekOk: true, seekMs: 1 },
      },
    });
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(0); });
    await sleep(400);
    await page.evaluate(RESET_RECORDERS);
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.play(); });
    await page.waitForFunction(() => (window.__pcEvents ?? []).some((e) => e.type === 'demote'), { timeout: 30000, polling: 50 }).catch(() => {});
    await sleep(1500);
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.pause(); });
    await sleep(600);
    const rec = await page.evaluate(READ_RECORDERS);
    const demote = rec.events.filter((e) => e.type === 'demote');
    const gaps = [];
    for (let i = 1; i < rec.frames.length; i++) gaps.push(rec.frames[i].at - rec.frames[i - 1].at);
    // Look only at entries for **this project**: when other test cases ran on the same dev server,
    // old records remain in costs
    const keysNow = await page.evaluate(async () => {
      const { getState } = await import('/src/store/project.ts');
      const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
      return Object.values(clipIdentityOf(getState().project).identityKeys);
    });
    const costs = await page.evaluate(async () => (await (await fetch('/api/data/costs')).json()));
    const demotedRecords = (costs?.costs ?? []).filter((r) => r.demoted === true && keysNow.includes(r.identityKey));
    const diag = await frontDiag(page);
    out.cases['downgrade'] = {
      slowClip, demote, beatGap: stats(gaps), demotedRecords: demotedRecords.map((r) => ({ identityKey: r.identityKey, capped: r.capped, demoted: r.demoted, stepMs: r.stepMs })),
      preview: diag.preview, stagePendingDemote: diag.stage?.pendingDemote,
      secDiffWrong: rec.frames.slice(1).filter((f, i) => Math.abs(f.sec - rec.frames[i].sec - 1 / 30) > 1e-6).length,
    };
    check(demote.length > 0, 'K6: demote fired after the cost of one card was artificially raised to 60 ms', demote);
    check(demote[0]?.clipId === slowClip, 'K6: the card demoted is the most expensive one (probe-slow)', { got: demote[0]?.clipId, want: slowClip });
    check(demotedRecords.length === 1, 'K6: exactly one entry in costs has demoted: true', demotedRecords.length);
    check(demotedRecords[0]?.capped === true && demotedRecords[0]?.demoted === true,
      'K6: whole-record PUT, with both capped and demoted written and the measured values still present', demotedRecords[0]);
    check(out.cases['downgrade'].secDiffWrong === 0, 'K6: a slow frame does not skip frames (sec difference is always 1/fps)', out.cases['downgrade'].secDiffWrong);
    check((diag.preview?.pendingDemote ?? []).includes(slowClip),
      'K6: until the static asset is ready it stays in pendingDemote and keeps live rendering as usual', diag.preview?.pendingDemote);
    // The copy written to disk
    if (!originArg && fs.existsSync(costsFile)) {
      const onDisk = JSON.parse(fs.readFileSync(costsFile, 'utf8'));
      const list = Array.isArray(onDisk) ? onDisk : (onDisk.records ?? onDisk.costs ?? []);
      out.cases['downgrade'].onDisk = list.filter((r) => r.demoted === true && keysNow.includes(r.identityKey)).length;
      check(out.cases['downgrade'].onDisk === 1, 'K6: the entry with demoted: true in out/card-costs.json was written to disk', out.cases['downgrade'].onDisk);
    }
  }

  /*
   * When there is no prerender process, `/api/frames/*` (ready index SSE, snapshot bytes) always
   * returns 503: that is a **by-design** fallback (F5 / general rule: when prerender process is
   * unavailable, stage continues as normal, heavy card layer transparent), not a page error.
   * Real JS exceptions do not contain "Failed to load resource".
   */
  const benign = (m) => /Failed to load resource/.test(m);
  out.errors = errors.filter((m) => !benign(m)).slice(0, 20);
  out.resourceErrors = errors.filter(benign).length;
  check(out.errors.length === 0, 'The page has no JS errors', out.errors.slice(0, 5));
} catch (err) {
  fails.push('The probe itself threw:' + (err?.stack || String(err)));
  exitCode = 1;
} finally {
  out.fails = fails;
  out.ok = fails.length === 0;
  if (outJson) {
    fs.mkdirSync(path.dirname(path.resolve(outJson)), { recursive: true });
    fs.writeFileSync(path.resolve(outJson), JSON.stringify(out, null, 2));
  }
  console.log(JSON.stringify(out, null, 2));
  try { await browser.close(); } catch { /* Already closed */ }
  await stopServer();
  if (!keep) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Keep if cannot be deleted */ } }
  else console.log('Temporary data directory kept:' + dataDir);
}
process.exit(fails.length ? 1 : exitCode);

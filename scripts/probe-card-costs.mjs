/**
 * The "offline half" of K1: measures card costs card by card on the background stage (role `back`,
 * work item `probe`), writing results by `(identityKey, device)` into `out/card-costs.json`
 * (`GET/PUT /api/data/costs`).
 *
 *   node scripts/probe-card-costs.mjs [--origin http://127.0.0.1:5197]
 *                                     [--cards odometer,punch-pill | --project path/to/x.proc]
 *                                     [--fps 30] [--clip-sec 4] [--worst-frames 40]
 *                                     [--force] [--dry-run] [--limit N] [--gl-route perDocument]
 *                                     [--mode dev|build] [--json out/xxx.json]
 *
 * The resident probe (`ProbeGate` + `back`) in step 4 does the same thing, except it is driven by
 * the editor inside the loading overlay; this script is its offline version, used to run the
 * scores in advance and verify the endpoints and keys before step 4 admission.
 *
 * # Mapping to task brief K1
 *
 * - **Measure only one clip at a time**: for each card, first run
 *   `setProject(reduced project, { reset: true })` (one track, one clip), then measure: `render`
 *   has no clipId; without reducing, `StageView.tsx:183` would push all currently active cards
 *   together.
 * - `identityKey = cardCostKey(node, sourceVersion, fps, durationFrames)`, where `node` is taken
 *   from the node for that clip in `projectCardGraph(reduced project, getCard).nodes`, and
 *   `sourceVersion` follows the algorithm in `ExportView.tsx:108-118` (user cards carry
 *   dependencies, built-in cards carry builtinCardSourceFiles).
 * - `direct` cards: deterministically pick random local frames and send `setTime(t, { probe: true })`
 *   once for each, with `catchUpMs = 0` and `kind: 'random'`. **Sample all `STEP_MIN_SAMPLES`
 *   frames**: task brief K1 says "if 8 samples are not enough for `STEP_MIN_SAMPLES`, sample more";
 *   without replenishing, 8 samples cannot reach the percentile, and `robustStep` would have to fall
 *   back to taking the maximum.
 * - `stateful` cards **take two passes** (task brief K1, confirmed by user, 2026-09-22): see next
 *   section.
 * - `capped = stepMs × COST_SCALE > B`.
 * - `vtOk` / `seekOk` / `seekMs` **are not measured offline** (left blank): they must be reset in
 *   the stage according to K3's remount recipe and use `pinner.syncIn` to sync the pinned tree
 *   virtual time; that is the job of the step 4 resident probe, and the parent page side cannot
 *   reach `pinner`.
 *
 * # Two passes (task brief K1)
 *
 * **Timing pass** `render(last frame, { jump: true, probe: 'time', maxCatchUp: Infinity })`:
 * Only advances, does not generate snapshots, and does not post `probe-frame`. **Not truncated by
 * one-tick budget**: the old approach (stopping once cumulative wall-clock time of this `render`
 * exceeded B, while that budget also included generating snapshots) caused all 61 frame-push cards
 * to advance only 1-10 frames, and `catchUpMs` extrapolated from the first few frames containing
 * mount costs was 1.7-3.6x too large, causing 5 cheap cards at 1 ms per frame to be misclassified as
 * heavy by the frame catch-up upper bound. Now a cap of `PROBE_MAX_FRAMES = 300` frames /
 * `PROBE_MAX_MS = 500` ms is kept only for long clips.
 * The response includes live render duration `steps` for **every frame**; statistics are computed by
 * this script:
 *   - `stepMs`    = `robustStep(steps)` (`STEP_PERCENTILE`th percentile, taking maximum if samples
 *     are insufficient);
 *   - `stepMaxMs` = single maximum, **for diagnostics only**, does not enter heavy classification
 *     or dispatch;
 *   - `catchUpMs` = sum of all frames; for those capped before finishing, remaining frames are filled
 *     in using the **median excluding the first frame**: do not use the average, since the first
 *     frame must build the tree and parse keyframes, and including it in the average would be
 *     systematically too large (this is the source of the 1.7-3.6x above).
 *
 * **Snapshot pass**: first reset according to K3's "remount positioning recipe"
 * (`render(0, { jump: true })`), then frame by frame `render(k / fps, { probe: 'snapshot' })`,
 * generating a snapshot for each frame; `inlineMs` / `rasterMs` / `serializeMs` similarly take
 * robust values. Sent individually frame by frame because the response for the entire `render` pass
 * reports only the **cumulative** total and per-frame counts cannot be obtained (the timing of
 * `probe-frame` events reaching the parent page does not work either: `yieldEvery: 8` in
 * `advanceToAsync` causes 8 postMessage calls to arrive in batches at the same yield point, with
 * nearly identical timestamps). Frame count is given by `--worst-frames` (default 40); long cards
 * that do not reach the end of the clip are marked `snapN` in the table; frames not reached are left
 * to background prerender, and truncation of the snapshot pass does not affect any classification.
 *
 * # Five numbers (task brief 3.8 + K1)
 *
 * The old `frameMs` (single-frame worst case including snapshot generation) **has been removed with
 * no backward compatibility kept**. Now measured separately and reported separately:
 *   - `stepMs`      **robust value** for a single frame of live render, the only number entering
 *     heavy classification;
 *   - `stepMaxMs`   single maximum for a single frame of live render, for diagnostics only;
 *   - `inlineMs`    robust value for single-frame style inlining;
 *   - `rasterMs`    robust value for single-frame canvas rasterization (0 for cards without a
 *     canvas);
 *   - `serializeMs` robust value for single-frame serialization.
 * The actual rAF wait in `setTime` with `probe: true` **is not counted toward any number** (the stage
 * takes `stepMs` before waiting for rAF, and durations of the three snapshot stages are measured by
 * `createSnapshot` itself): without doing this, the score of random-access cards would include at
 * least one vertical sync (about 17 ms).
 *
 * Statistics are computed entirely on the Node side (the page only measures and returns raw
 * arrays), so `--json` retains **raw samples**: recalculating with changed coefficients or
 * comparing heavy classification list differences between two runs does not require re-probing.
 *
 * # Previously probed cards are skipped
 *
 * Before running, `GET /api/data/costs?device=<local>`; cards where `(identityKey, device)` already
 * has a record **and `demoted !== true`** are skipped entirely (pinned render 5 final sentence:
 * reuse directly if identity has not changed). `--force` forces re-probing.
 *
 * # Changed coefficients = changed measurement method
 *
 * `STEP_PERCENTILE` / `STEP_MIN_SAMPLES` determine how `stepMs` is extracted from samples; changing
 * them is equivalent to changing the measurement method, and old scores should no longer be used.
 * Therefore these two numbers are **concatenated into the `device` string** (same method as `mode`):
 * the deduplication key is `${identityKey} ${device}`; once concatenated, old records naturally
 * will not hit and will be re-probed, with scores from both measurement methods having their own
 * entry. `COST_SCALE` is **not concatenated**: it only affects how these numbers are used (heavy
 * classification and weights), not the measured numbers themselves.
 *
 * The concatenation logic itself lives in `src/render/costDevice.mjs`, and **the resident probe
 * (`src/editor/probeRunner.ts`) imports the same copy**: if written separately in both places, any
 * discrepancy in order / spacing would make the two sets of records invisible to each other (R4a
 * report section 8, item 10).
 *
 * # dev or build
 *
 * `--mode` is auto-detected by default: `GET <origin>/@vite/client` returning a JS module indicates
 * dev server; returning anything else (`vite preview` uses SPA fallback and returns
 * `dist/index.html`, **with status code also 200**) indicates build output.
 * Records include `mode`, and **`mode` is also concatenated into the `device` string**: the
 * deduplication key of `costs-store.mjs` is `${identityKey} ${device}`; without concatenating it,
 * the two modes would overwrite each other, whereas both sets of numbers must be preserved (task
 * brief 3.1: desktop app runs the dev server, so dev numbers represent the real runtime environment;
 * build numbers are for the future online browser mode). The server treats `device` as an opaque
 * string, so not a single line of key code needs to change.
 *
 * **Note**: The host page card registry is fetched directly via `import('/src/cards/index.ts')`,
 * which only the dev server can serve; running on `vite preview` build output would require bundling
 * the registry into an independent probe kit first (see `scripts/probes/build-probe-kit.mjs` in the
 * reference implementation), which R1 did not do; see report.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

import { costDeviceString } from '../src/render/costDevice.mjs';
import { budgetOf, clipWeight } from '../src/render/pipelinePlan.mjs';
import { DEFAULT_TUNING, PROBE_MAX_FRAMES, PROBE_MAX_MS, resolveTuning } from '../src/render/pipelineTuning.mjs';
import { maxOf, percentile, summarizeProbe } from '../src/render/probeSummary.mjs';

/* ------------------------------------------------------------------ Parameters */

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(name);

const origin = (flag('--origin') || process.env.PC_STAGE_TEST_URL || 'http://127.0.0.1:5197').replace(/\/+$/, '');
const fpsArg = Number(flag('--fps', '30')) || 30;
const clipSec = Number(flag('--clip-sec', '4')) || 4;
const worstFrames = Math.max(1, Number(flag('--worst-frames', '40')) || 40);
const cardsArg = flag('--cards');
const projectArg = flag('--project');
const glRouteArg = flag('--gl-route');
const limit = Number(flag('--limit', '0')) || 0;
const force = has('--force');
const dryRun = has('--dry-run');
const modeArg = flag('--mode');
/** All raw numbers from this pass (quantiles per card, trunc, maxAt…), for reports and "run twice to compare differences" */
const outJson = flag('--json');

const HOST_PATH = '/__probe-card-costs-host';

/* ------------------------------------------------------------------ Host page */

// A same-origin test page: no static files are kept in the repo, temporarily served via Puppeteer
// request interception.
// Technique follows scripts/probes/stage-rpc-probe.mjs (that one is known to work with 5197).
const hostHtml = `<!doctype html><html><head><meta charset="utf-8"><title>card cost probe host</title>
<!-- Preamble for @vitejs/plugin-react: the plugin injects it into index.html automatically, but this hand-written page has to carry its own,
     otherwise any import of /src/**.tsx throws "can't detect preamble". /@react-refresh does not exist in the production bundle,
     so the failure is swallowed (it is not needed there anyway). -->
<script type="module">
try {
  const RefreshRuntime = await import('/@react-refresh');
  RefreshRuntime.injectIntoGlobalHook(window);
  window.$RefreshReg$ = () => {};
  window.$RefreshSig$ = () => (type) => type;
  window.__vite_plugin_react_preamble_installed__ = true;
} catch { /* built bundle: no react-refresh, and not needed */ }
</script>
</head>
<body style="margin:0;background:#111">
<iframe id="f" src="/?stage=1&id=B&prerender=1" style="width:1920px;height:1080px;border:0;display:block"></iframe>
<script type="module">
// Minimal RPC client (same protocol as src/render/stageRpc.ts), written inline so this page can also run against the built bundle
function createStageRpc(target) {
  let nextId = 1; const pending = new Map(); const listeners = new Set();
  window.addEventListener('message', (e) => {
    if (e.source !== target) return; const d = e.data;
    if (d && d.type === 'pc-rpc-reply') { const p = pending.get(d.id); if (!p) return; pending.delete(d.id); d.ok ? p.resolve(d.result) : p.reject(new Error(d.error)); return; }
    if (d && typeof d.type === 'string' && ['mediaReady','frame','ended','settled','probe','demote','probe-frame'].includes(d.type)) for (const l of listeners) l(d);
  });
  const call = (method) => (...args) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); target.postMessage({ type: 'pc-rpc', id, method, args }, location.origin); });
  const c = { onEvent: (l) => { listeners.add(l); return () => listeners.delete(l); } };
  for (const m of ['setProject','setTime','render','hitTest','rectsWithBounds','size','setProxy','setRole','setPlan','play','pause','setSuppressed','setStreamPlanes','setScrubbing','setPlaying','setMediaT','setLocalHashes','setSnapshots']) c[m] = call(m);
  return c;
}

const f = document.getElementById('f');
window.__probeFrames = 0;
window.__ready = new Promise((res, rej) => {
  setTimeout(() => rej(new Error('stage ready timeout')), 180000);
  window.addEventListener('message', (e) => {
    if (e.source !== f.contentWindow || e.data?.type !== 'pc-stage-ready') return;
    window.__caps = e.data.hostCapabilities;
    window.__rpc = createStageRpc(f.contentWindow);
    // probe-frame is only counted: per-frame html is useless on this side, and accumulating it just wastes memory
    window.__rpc.onEvent((ev) => { if (ev.type === 'probe-frame') window.__probeFrames++; });
    res(true);
  });
});

/* Card registry / graph / identity key. In dev mode /src/* is transformed on the fly by vite, so a direct import works. */
window.__kit = (async () => {
  await import('/src/cards/index.ts');                       // module-level registerCards
  const registry = await import('/src/kernel/registry.ts');
  const { projectCardGraph } = await import('/src/kernel/cardGraph.mjs');
  const { cardCostKey } = await import('/src/render/cardCostKey.mjs');
  const { cardSourceVersion } = await import('/src/render/cardSourceVersion.mjs');
  const { builtinCardSourceFiles } = await import('/src/render/cardSourceFiles.mjs');
  const { cardFrameMode, reviewedCard } = await import('/src/kernel/frameMode.mjs');
  const assets = await import('/src/cards/assets/index.ts');
  // Source version follows the algorithm in ExportView.tsx:108-118
  const sourceVersionOf = (card) => {
    const user = registry.userCardSources();
    const file = user.fileOf[card.id];
    return file && user.files[file] !== undefined
      ? 'user:' + cardSourceVersion(card, { ...builtinCardSourceFiles, ...user.dependencies }, '/src/cards/user/' + file + '.tsx')
      : 'builtin:' + cardSourceVersion(card, builtinCardSourceFiles);
  };
  return { ...registry, projectCardGraph, cardCostKey, cardFrameMode, reviewedCard, sourceVersionOf, featuredParticleIds: assets.featuredParticleIds };
})();

/* Local identity (J4): UA + WebGL renderer + compact (only one stage; the field name in the string is still called lowMemory, see costDevice.mjs) / offscreenGl / glRoute.
   The throwaway discarded context is opened in the **host page**, leaving the stage's own shared WebGL context alone.
   Both reading and assembling live in src/render/costDevice.mjs, and the resident probe imports the same copy. */
window.__deviceParts = async () => {
  const { readGpuRenderer, resolveGlRoute } = await import('/src/render/costDevice.mjs');
  const caps = window.__caps || {};
  const compact = !!caps.compact;
  return { ua: navigator.userAgent, renderer: readGpuRenderer(document), compact,
    offscreenGl: !!caps.offscreenGl, glRoute: resolveGlRoute(caps.glRoute ?? null, compact ? 'shared' : 'perDocument') };
};

/* Shrunken project: one clip per track (same shape as legacyTimeline in FrameScene.tsx) */
window.__mkProject = (cardId, fps, lenSec, params) => ({
  version: 1, id: 'probe', name: 'probe', width: 1920, height: 1080, fps, duration: lenSec,
  themeId: 'midnight', media: [],
  tracks: [{ id: 'probe-track', clips: [{ id: 'c0', cardId, start: 0, end: lenSec, params: params || {} }] }],
});

/* Identity key + declared frame mode. Compute only, no measuring; used to "skip cards that were already measured" */
window.__identify = async (jobs) => {
  const kit = await window.__kit;
  return jobs.map((job) => {
    const def = kit.getCard(job.cardId);
    if (!def) return { ...job, error: 'no such card in the registry' };
    try {
      const project = window.__mkProject(job.cardId, job.fps, job.lenSec, job.params);
      const node = kit.projectCardGraph(project, kit.getCard).nodes.find((n) => n.clipId === 'c0');
      if (!node) return { ...job, error: 'no node for this clip in the graph' };
      const durationFrames = Math.max(1, Math.round(job.lenSec * job.fps));
      return { ...job, durationFrames,
        identityKey: kit.cardCostKey(node, kit.sourceVersionOf(def), job.fps, durationFrames),
        canvasHeavy: ['canvas2d', 'webgl'].includes(kit.reviewedCard(job.cardId)?.surface),
        mode: kit.cardFrameMode(def, def.defaults) };
    } catch (err) { return { ...job, error: String(err && err.message || err) }; }
  });
};

/* The 62 cards visible by default in the panel (inventory :19): all non-particle cards + particle cards the catalog marks as featured */
window.__highFrequencyIds = async () => {
  const kit = await window.__kit;
  return kit.allCards().map((c) => c.id).filter((id) => !id.startsWith('particles-') || kit.featuredParticleIds.has(id));
};

/* -------- Measurement of one card. The whole run happens inside the page, to avoid one puppeteer round trip per frame.
      **This only measures, it does no statistics** — quantiles, extrapolation and dedup all live on the Node side (see the file header). -------- */
const seedOf = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const mulberry32 = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

window.__probeOne = async (job) => {
  const rpc = window.__rpc;
  const { cardId, fps, lenSec, params, mode, identityKey, durationFrames } = job;
  const out = { cardId, identityKey, fps, mode, durationFrames };
  const project = window.__mkProject(cardId, fps, lenSec, params);
  await rpc.setRole('back', { job: 'probe' });
  await rpc.setProject(project, { reset: true });
  // On mount React has to build the tree and Motion has to resolve keyframes: give it a real task boundary before measuring,
  // otherwise the first frame of the first card absorbs the whole module's first evaluation. Canvas cards (three.js / tsParticles)
  // also have to wait for the canvas to be set up asynchronously, or we would measure an empty shell (measured: particles-basic was off by 30x).
  await rpc.setTime(0);
  await new Promise((r) => setTimeout(r, 150));
  if (job.canvasHeavy) {
    const w = document.getElementById('f').contentWindow;
    for (let i = 0; i < 100; i++) {
      const cv = w.document.querySelector('[data-pc-clip] canvas');
      if (cv && cv.width > 1) { await new Promise((r) => setTimeout(r, 150)); break; }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  if (mode === 'direct') {
    /*
     * Fixed random sampling of local frames (seeded by cardId, so reruns on the same machine are comparable).
     * **Sample up to job.minSamples frames** (task spec K1: 8 is not enough for STEP_MIN_SAMPLES, so sample more);
     * clips shorter than that are sampled to the full frame count, without repeats.
     */
    const want = Math.max(8, Math.min(job.minSamples, durationFrames));
    const rnd = mulberry32(seedOf(cardId));
    const picks = new Set();
    for (let i = 0; i < want * 64 && picks.size < Math.min(want, durationFrames); i++) picks.add(Math.floor(rnd() * durationFrames));
    const frames = [...picks].sort((a, b) => a - b);
    const steps = [], inline = [], raster = [], serialize = [];
    for (const n of frames) {
      const r = await rpc.setTime(n / fps, { probe: true });
      // stepMs is taken by the stage **before** it waits for that one real rAF, so what we get here already excludes vertical sync (last item of 3.8)
      steps.push(Number(r?.stepMs) || 0);
      inline.push(Number(r?.snapshot?.inlineMs) || 0);
      raster.push(Number(r?.snapshot?.rasterMs) || 0);
      serialize.push(Number(r?.snapshot?.serializeMs) || 0);
    }
    out.kind = 'random';
    out.steps = steps;
    out.inline = inline;
    out.raster = raster;
    out.serialize = serialize;
    out.pushedFrames = steps.length;
    out.totalFrames = durationFrames;
    out.truncated = false;
    return out;
  }

  /* ---- Timing pass: only advance, no snapshots, capped by PROBE_MAX_*, the reply carries per-frame durations ---- */
  const target = Math.max(0, lenSec - 1 / fps);
  const totalFrames = Math.max(1, Math.round(target * fps) + 1);
  window.__probeFrames = 0;
  const timePass = await rpc.render(target, { jump: true, probe: 'time', maxCatchUp: Infinity, maxFrames: job.maxProbeFrames });
  out.kind = 'stepped';
  out.steps = Array.isArray(timePass?.steps) ? timePass.steps.map(Number) : [];
  out.pushedFrames = Number(timePass?.frames) || out.steps.length;
  out.totalFrames = totalFrames;
  out.runMs = Number(timePass?.elapsedMs) || 0;
  out.truncated = !!timePass?.truncated;
  // The timing pass should not generate a single snapshot, so this number should always be 0; if it is not, a branch on the stage side has leaked
  out.timePassProbeFrames = window.__probeFrames;

  /* ---- Snapshot pass: reset using K3's remount positioning recipe, then generate one snapshot per frame ---- */
  const n = Math.max(1, Math.min(totalFrames - 1, job.worstFrames));
  out.snapN = n;
  window.__probeFrames = 0;
  await rpc.render(0, { jump: true, maxCatchUp: Infinity });   // remount positioning recipe: reset to the mount frame
  const inline = [], raster = [], serialize = [];
  for (let k = 1; k <= n; k++) {
    const r = await rpc.render(k / fps, { probe: 'snapshot', maxCatchUp: Infinity });
    inline.push(Number(r?.snapshot?.inlineMs) || 0);
    raster.push(Number(r?.snapshot?.rasterMs) || 0);
    serialize.push(Number(r?.snapshot?.serializeMs) || 0);
  }
  out.inline = inline;
  out.raster = raster;
  out.serialize = serialize;
  out.snapPassProbeFrames = window.__probeFrames;
  return out;
};
</script></body></html>`;

/* ------------------------------------------------------------------ Which cards to probe */

function jobsFromProject(file, fps) {
  const raw = fs.readFileSync(file, 'utf8');
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { throw new Error(`${file} is not a JSON project (${e.message})`); }
  // .proc is { format, version, project: {...} }; bare projects are also accepted
  const proj = doc?.project ?? doc;
  const projFps = Number(proj.fps) || fps;
  const jobs = [];
  for (const track of proj.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (!clip.cardId) continue;
      const len = Math.max(1 / projFps, Number(clip.end) - Number(clip.start));
      jobs.push({ cardId: clip.cardId, fps: projFps, lenSec: Number(len.toFixed(6)), params: clip.params ?? {} });
    }
  }
  return jobs;
}

/* ------------------------------------------------------------------ Endpoints */

/**
 * dev server or `vite preview` build output. Criterion is the **Content-Type** returned by
 * `/@vite/client`: dev server returns a JS module; `vite preview` uses SPA fallback and returns
 * `dist/index.html` (**status code is also 200**, so `res.ok` cannot be used). `--mode` can force it.
 */
async function detectMode() {
  if (modeArg === 'dev' || modeArg === 'build') return modeArg;
  try {
    const res = await fetch(`${origin}/@vite/client`, { method: 'GET' });
    return res.ok && /javascript|ecmascript/i.test(res.headers.get('content-type') || '') ? 'dev' : 'build';
  } catch {
    return 'build';
  }
}

/**
 * `GET /api/data/costs` also returns K2 tunable coefficients (`out/pipeline-tuning.json`; missing
 * file = all defaults used). When plugin is not yet attached or during `--dry-run`, defaults are
 * used so this pass's measurement method matches the default set.
 */
async function getCosts(device) {
  const res = await fetch(`${origin}/api/data/costs${device ? `?device=${encodeURIComponent(device)}` : ''}`);
  if (res.status === 404) return { missing: true, costs: [], tuning: resolveTuning(null) };
  if (!res.ok) throw new Error(`GET /api/data/costs → HTTP ${res.status}`);
  const data = await res.json();
  return { missing: false, costs: Array.isArray(data?.costs) ? data.costs : [], tuning: resolveTuning(data?.tuning) };
}

async function putCosts(records) {
  const res = await fetch(`${origin}/api/data/costs`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw new Error(`PUT /api/data/costs → HTTP ${res.status} ${JSON.stringify(data)}`);
  return data;
}

/* ------------------------------------------------------------------ Main flow */

const num = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');
/** Statistics are entirely in `src/render/probeSummary.mjs`; resident probe imports the same copy (see file header) */
const pct = percentile;

function table(rows, columns) {
  const head = columns.map((c) => c.title);
  const body = rows.map((r) => columns.map((c) => String(c.get(r) ?? '')));
  const width = head.map((h, i) => Math.max([...h].length, ...body.map((r) => [...r[i]].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(width[i]) : c.padStart(width[i]))).join('  ');
  return [line(head), width.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}

const mode = await detectMode();

const browser = await puppeteer.launch({
  headless: true,
  // Disable background throttling: stage catch-up run yields a real setTimeout every 8 frames
  // (stageClock yieldEvery); throttled by background page to once per second, each card would take
  // tens of seconds and the measured result would not be the card's own cost.
  args: ['--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
let exitCode = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === HOST_PATH) req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: hostHtml });
    else req.continue();
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(origin + HOST_PATH, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.evaluate(() => window.__ready);
  await page.evaluate(async () => { await window.__kit; return true; });

  const parts = await page.evaluate(() => window.__deviceParts());
  if (glRouteArg) parts.glRoute = glRouteArg;

  /*
   * Coefficients must be fetched first: `STEP_PERCENTILE` / `STEP_MIN_SAMPLES` decide both how
   * `stepMs` is taken from samples and need to be concatenated into the `device` string (see file
   * header "Changed coefficients = changed measurement method"), so this GET does not include device.
   */
  const boot = dryRun ? { missing: true, costs: [], tuning: resolveTuning(null) } : await getCosts(null);
  const tuning = boot.tuning;

  /*
   * `mode` is also concatenated into device: `costs-store.mjs` deduplication key is
   * `${identityKey} ${device}`; without concatenating it, the dev pass and build pass would
   * overwrite each other, whereas both sets must be preserved (see file header). Server treats device
   * as an opaque string without parsing, so key code does not need to change.
   * Same for the two measurement coefficients: changing them invalidates old scores; concatenating
   * them causes old records to miss naturally so they are re-probed.
   * Concatenation logic lives in `src/render/costDevice.mjs`; resident probe uses the same function.
   */
  const device = costDeviceString({ ...parts, mode, tuning });
  console.log(`mode: ${mode} (${origin})`);
  console.log(`tuning: COST_SCALE=${tuning.COST_SCALE} STEP_PERCENTILE=${tuning.STEP_PERCENTILE} STEP_MIN_SAMPLES=${tuning.STEP_MIN_SAMPLES}`
    + (JSON.stringify(tuning) === JSON.stringify(DEFAULT_TUNING) ? '(default)' : '(overridden by out/pipeline-tuning.json)'));
  console.log(`probe caps: PROBE_MAX_FRAMES=${PROBE_MAX_FRAMES} PROBE_MAX_MS=${PROBE_MAX_MS}`);
  console.log(`device: ${device}\n`);

  let jobs;
  if (projectArg) {
    jobs = jobsFromProject(path.resolve(projectArg), fpsArg);
  } else if (cardsArg) {
    jobs = cardsArg.split(',').map((s) => s.trim()).filter(Boolean).map((cardId) => ({ cardId, fps: fpsArg, lenSec: clipSec, params: {} }));
  } else {
    const ids = await page.evaluate(() => window.__highFrequencyIds());
    jobs = ids.map((cardId) => ({ cardId, fps: fpsArg, lenSec: clipSec, params: {} }));
  }
  if (limit) jobs = jobs.slice(0, limit);

  const identified = await page.evaluate((j) => window.__identify(j), jobs);
  const broken = identified.filter((j) => j.error);
  for (const j of broken) console.warn(`Skipping ${j.cardId}: ${j.error}`);

  const existing = dryRun ? { missing: true, costs: [] } : await getCosts(device);
  if (existing.missing) console.warn('GET /api/data/costs returned 404: the plugin is not mounted yet (or this is a --dry-run), so no cards are skipped this run.');
  const known = new Map(existing.costs.map((r) => [r.identityKey, r]));
  const todo = [], skipped = [];
  const seen = new Set();
  for (const j of identified) {
    if (j.error) continue;
    if (seen.has(j.identityKey)) continue;   // Multiple clips of the same card share the same identity, probed only once
    seen.add(j.identityKey);
    const hit = known.get(j.identityKey);
    if (!force && hit && hit.demoted !== true) { skipped.push({ ...j, hit }); continue; }
    todo.push({ ...j, worstFrames, minSamples: tuning.STEP_MIN_SAMPLES, maxProbeFrames: PROBE_MAX_FRAMES });
  }
  console.log(`${identified.length} clips → ${todo.length} cards to measure, ${skipped.length} skipped (already recorded), ${broken.length} with problems.\n`);

  const B = budgetOf(fpsArg);
  const records = [], results = [];
  for (const [i, job] of todo.entries()) {
    process.stdout.write(`[${i + 1}/${todo.length}] ${job.cardId} (${job.mode}) … `);
    let raw;
    try {
      raw = await page.evaluate((j) => window.__probeOne(j), job);
    } catch (err) {
      console.log('failed');
      results.push({ ...job, error: String(err && err.message || err) });
      continue;
    }
    // Statistics are computed on this side: page only returns raw samples (see file header)
    const out = { ...raw, ...summarizeProbe(raw, tuning) };
    out.capped = out.stepMs * tuning.COST_SCALE > B;
    /*
     * Which tier this card takes under K2 and which positions classify as heavy: printed for
     * diagnostics only; actual dispatch is computed by `planPipelines` across the whole project
     * (light/heavy is a property of "(position, card)"; an individual card itself has no light/heavy
     * attribute). The offline probe does not test `seekOk`, so the tier here is conservative for
     * seekable long CSS cards, consistent with K2's fallback when `seekOk` is absent.
     */
    out.tier = clipWeight({ ...out, capped: out.capped }, job.mode, out.fps, tuning).tier;
    console.log(`stepMs=${num(out.stepMs, 2)}(max ${num(out.stepMaxMs, 2)}) inline=${num(out.inlineMs, 1)} raster=${num(out.rasterMs, 1)}`
      + ` serial=${num(out.serializeMs, 1)} catchUpMs=${num(out.catchUpMs, 0)} ${out.tier}${out.capped ? ' CAPPED' : ''}`);
    results.push(out);
    records.push({
      identityKey: out.identityKey,
      fps: out.fps,
      // Five numbers reported separately (task brief 3.8 + K1); old frameMs removed, no compatibility kept
      stepMs: Number(out.stepMs.toFixed(3)),
      stepMaxMs: Number(out.stepMaxMs.toFixed(3)),
      inlineMs: Number(out.inlineMs.toFixed(3)),
      rasterMs: Number(out.rasterMs.toFixed(3)),
      serializeMs: Number(out.serializeMs.toFixed(3)),
      catchUpMs: Number(out.catchUpMs.toFixed(3)),
      ...(out.capped ? { capped: true } : {}),
      kind: out.kind,
      mode,
      /*
       * **Explicitly write false** (task brief 3.3): `costs-store.mjs` STICKY_FLAGS means "if a new
       * record omits this field, keep the old value; if provided, even if false, use the new value", and
       * records are persisted to disk: without explicitly providing it, once K6 writes true, every
       * re-probe afterwards would be pasted back with true, permanently classifying this card as heavy.
       * "Only effective in current session" holds precisely because of this rule. `pinnedHeavy` is
       * reserved for future manual pinning; not written in this task (3.3).
       */
      demoted: false,
      measuredAt: Date.now(),
      device,
    });
  }

  console.log(`\nB = 1000/${fpsArg} × 70% = ${B.toFixed(2)} ms\n`);
  console.log(table(results.filter((r) => !r.error), [
    { title: 'card', get: (r) => r.cardId },
    { title: 'kind', get: (r) => r.kind },
    { title: 'stepMs', get: (r) => num(r.stepMs, 2) },
    { title: 'stepMax', get: (r) => num(r.stepMaxMs, 2) },
    { title: 'inlineMs', get: (r) => num(r.inlineMs, 2) },
    { title: 'rasterMs', get: (r) => num(r.rasterMs, 2) },
    { title: 'serialMs', get: (r) => num(r.serializeMs, 2) },
    { title: 'catchUpMs', get: (r) => num(r.catchUpMs, 0) },
    { title: 'oldCatchUp', get: (r) => num(r.legacyCatchUpMs, 0) },
    { title: 'stepP50', get: (r) => num(r.stepP50, 2) },
    { title: 'stepP90', get: (r) => num(r.stepP90, 2) },
    { title: '1st', get: (r) => num(r.firstMs, 2) },
    { title: 'run', get: (r) => (r.kind === 'stepped' ? `${r.samples}/${r.totalFrames}` : `${r.samples}`) },
    { title: 'snapN', get: (r) => r.snapN ?? '—' },
    { title: 'trunc', get: (r) => (r.truncated ? 'yes' : 'no') },
    { title: 'tier', get: (r) => r.tier ?? '' },
    { title: 'capped', get: (r) => (r.capped ? 'YES' : '') },
  ]));

  /* Group into K2's three tiers: report requirement for "how many cards each, which cards are classified as heavy by frame catch-up upper bound" */
  const ok = results.filter((r) => !r.error);
  const byTier = new Map();
  for (const r of ok) byTier.set(r.tier, [...(byTier.get(r.tier) ?? []), r.cardId]);
  console.log('\nBy K2 tier (seekOk is not measured offline, so long CSS cards also land in the frame-push tiers):');
  for (const [tier, list] of [...byTier].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${tier.padEnd(14)} ${String(list.length).padStart(3)} cards  ${list.join(', ')}`);
  }
  const steps = ok.map((r) => r.stepMs);
  console.log(`\nstepMs p50 / p90 / max = ${num(pct(steps, 0.5), 2)} / ${num(pct(steps, 0.9), 2)} / ${num(maxOf(steps), 2)} ms`);
  const cappedCards = ok.filter((r) => r.capped).map((r) => r.cardId);
  console.log(`Single frame over B (capped): ${cappedCards.length} cards${cappedCards.length ? ' —— ' + cappedCards.join(', ') : ''}`);
  const overCatchUp = ok.filter((r) => r.tier === 'over-catchup' && !r.capped).map((r) => r.cardId);
  console.log(`Rejected by the frame catch-up upper bound: ${overCatchUp.length} cards${overCatchUp.length ? ' —— ' + overCatchUp.join(', ') : ''}`);

  const failed = results.filter((r) => r.error);
  if (failed.length) {
    console.log('\nFailed:');
    for (const f of failed) console.log(`  ${f.cardId}: ${f.error}`);
  }
  if (skipped.length) console.log(`\nSkipped (already recorded): ${skipped.map((s) => s.cardId).join(', ')}`);

  if (!dryRun && records.length) {
    const put = await putCosts(records);
    console.log(`\nPUT /api/data/costs → ok, ${put.count} records stored (${put.added} added, ${put.updated} updated).`);
    const back = await getCosts(device);
    const got = new Set(back.costs.map((r) => r.identityKey));
    const missing = records.filter((r) => !got.has(r.identityKey));
    console.log(`GET /api/data/costs?device=… → ${back.costs.length} records; ${missing.length} of this run's ${records.length} records missing.`);
    if (missing.length) exitCode = 1;
  } else if (dryRun) {
    console.log('\n--dry-run: nothing written to /api/data/costs.');
  }

  if (outJson) {
    const file = path.resolve(outJson);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ origin, mode, device, fps: fpsArg, clipSec, worstFrames, B,
      tuning, probeCaps: { PROBE_MAX_FRAMES, PROBE_MAX_MS },
      at: new Date().toISOString(), results, skipped: skipped.map((s) => s.cardId),
      broken: broken.map((b) => ({ cardId: b.cardId, error: b.error })) }, null, 2), 'utf8');
    console.log(`\nRaw data written to ${file}`);
  }

  const noise = errors.filter((e) => !/favicon|React DevTools|Failed to load resource/i.test(e));
  if (noise.length) {
    console.log(`\nPage errors: ${noise.length} (first 5):`);
    for (const e of noise.slice(0, 5)) console.log('  ' + e);
  }
} catch (err) {
  console.error(err && err.stack || err);
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);

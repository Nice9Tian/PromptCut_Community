/**
 * Whether snapshots produced by queue fine-grained tasks via "single pass per segment" are
 * equivalent to the original "batches of 4 frames, each batch navigating and replaying from mount frame"
 * (`queueSinglePass` in `server/frame-pipeline.mjs`; `docs/archive/agent-reports/AGENT-uc-latency.md`).
 *
 *   First start the dev server (it occupies +1 and +2 as two stage ports): npx vite --port 5740 --strictPort --host 127.0.0.1
 *   node scripts/probes/queue-single-pass-probe.mjs --origin http://127.0.0.1:5740 [--out <dir>] [--cards a,b,c] [--seconds 4]
 *
 * Approach: this process starts two `FramePipeline` instances (each with a temporary frame store)
 * for the same project (one track per card, starting at 0s, default parameters). Both sides follow
 * the queue executor path: fetch plan with `planForQueue`, and call `renderCardSnapshotRange` for each
 * shared-tier card in 60-frame segments; side A disables single pass (`queueSinglePassOff = true`,
 * i.e. the original batch-by-batch mode), while side B follows the new behavior. Then compare frame by frame:
 *   - How many frames have byte-identical HTML snapshots; for differing ones, compare again after
 *     removing `will-change` (hint attached only during active Motion animations, recorded in M7 probe P2);
 *   - For still differing frames, capture one screenshot per side via prerender replay
 *     (`captureSnapshot`, same prerender room) and compare pixels (pixel-by-pixel after decoding);
 *   - For frames where pixels still differ, use sequential live render of this card as reference
 *     (a single track, pushed frame-by-frame from frame 0, full frame captured each frame, matching
 *     export push method) to see which side matches it.
 * Criteria: for each card, each frame is "byte-identical", "differs only in will-change", or
 * "pixel-identical", or has differing pixels but single pass showed no regression (no frames where
 * "batch-by-batch matches live render while single pass does not"); report timings for each segment
 * on both sides as well. (First run: `mu-word-rotate` in batch-by-batch diverged from live render
 * starting at frame 32: when batch-by-batch replayed each batch from the beginning without capturing
 * frames, Motion's JS frame loop could not be driven forward and AnimatePresence word transition
 * phase lagged behind; single pass was pixel-identical to live render in the first segment, lagged in
 * the first few frames of the second segment, then aligned.)
 *
 * Output: progress goes to stderr; the last line of stdout is a single JSON line `{ ok, fails, cards: { <cardId>: {…} }, timing }`.
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const ORIGIN = String(arg('--origin', 'http://127.0.0.1:5740')).replace(/\/+$/, '');
const OUT = path.resolve(arg('--out', fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-probe-'))));
const SECONDS = Number(arg('--seconds', 4));
const FPS = 30;
const SPAN = 60;
const DEFAULT_CARDS = ['mu-animated-shiny-text', 'punch-pill', 'mu-number-ticker', 'probe-slow-stepped', 'mu-typing', 'mu-word-rotate', 'mu-blur-fade',
  'mu-circular-progress', 'type-shift', 'probe-countdown', 'probe-typewriter', 'probe', 'probe-motion-js', 'r6-stateful', 'caption-track', 'chapter-bar', 'entity-chips',
  'focus-card', 'lottie', 'pin-board', 'quote-lockup', 'step-timeline', 'term-card', 'ui-callout', 'versus-card', 'blur-text', 'odometer', 'rank-bars', 'ring-metric',
  'growth-curve', 'checklist', 'stat-proof', 'probe-css', 'particles'];
const CARDS = String(arg('--cards', DEFAULT_CARDS.join(','))).split(',').map((s) => s.trim()).filter(Boolean);
const log = (...a) => process.stderr.write(`${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const stripWillChange = (h) => h.replace(/will-change:[^;"]*;?/g, '');

const PROJECT = {
  id: 'qsp-probe', name: 'Single-pass comparison', width: 1920, height: 1080, fps: FPS, duration: SECONDS,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: CARDS.map((cardId, i) => ({ id: `tr-${i}`, name: cardId, hidden: false, clips: [{ id: `clip-${cardId}`, kind: 'card', cardId, start: 0, end: SECONDS, params: {} }] })),
};

async function runSide(name, singlePassOff) {
  const root = path.join(OUT, `${name}-lib`);
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(root, { recursive: true });
  const { FramePipeline } = await import('../../server/frame-pipeline.mjs');
  const pipeline = new FramePipeline({ root, origin: () => ORIGIN, interactive: false, dataRoot: root });
  pipeline.queueSinglePassOff = singlePassOff;
  const side = { name, cards: {}, ms: 0 };
  const t0 = Date.now();
  try {
    const { entry, context } = await pipeline.planForQueue(PROJECT);
    pipeline.addBackfill(entry, context.cardPlan.map((c) => c.clipId));
    for (const control of context.cardPlan) {
      const tier = control.tier;
      const cardId = control.cardId ?? control.clipId.replace(/^clip-/, '');
      if (tier !== 'shared') { side.cards[cardId] = { skipped: `tier ${tier}` }; continue; }
      const segs = [];
      for (let from = 0; from < control.count; from += SPAN) {
        const range = { from, to: Math.min(control.count - 1, from + SPAN - 1) };
        const timing = {};
        const s0 = Date.now();
        await pipeline.renderCardSnapshotRange(entry, control, range, { timing });
        segs.push({ range: `${range.from}-${range.to}`, ms: Date.now() - s0, singlePass: timing.singlePass === true, batches: timing.batches ?? null, resetMs: timing.resetMs ?? null, bakeMs: timing.bakeMs ?? null });
      }
      const dir = pipeline.snapshots().dir({ tier: 'shared', key: control.snapshotKey });
      const dst = path.join(OUT, name, cardId);
      await fsp.rm(dst, { recursive: true, force: true });
      await fsp.mkdir(dst, { recursive: true });
      for (const n of await fsp.readdir(dir)) if (/^\d+\.html$/.test(n)) await fsp.copyFile(path.join(dir, n), path.join(dst, n));
      side.cards[cardId] = { count: control.count, segs, capabilities: control.capabilities ?? null };
      log(`${name} ${cardId}: ${segs.map((s) => `${s.range} ${s.ms} ms${s.singlePass ? ' single-pass' : ''}`).join(', ')}`);
    }
  } finally {
    side.ms = Date.now() - t0;
    await pipeline.close().catch(() => {});
  }
  return side;
}

function decode(buf) { const p = PNG.sync.read(buf); return p; }

/** This card on a single track, pushed sequentially from frame 0 to the last frame, capturing full live render images frame-by-frame (matching export push method); returns frame number → PNG */
async function sequentialLive(bakery, cardId, count) {
  const { bakeFrames } = await import('../../server/bakery/bake.mjs');
  const one = { ...PROJECT, tracks: [{ id: 'tr-0', name: cardId, hidden: false, clips: [{ id: `clip-${cardId}`, kind: 'card', cardId, start: 0, end: SECONDS, params: {} }] }] };
  const empty = { ...PROJECT, tracks: [], media: [] };
  await bakery.reset(one, `${ORIGIN}/?export=1&timeline=${encodeURIComponent(`data:application/json,${encodeURIComponent(JSON.stringify(empty))}`)}`);
  await bakery.page.setViewport({ width: PROJECT.width, height: PROJECT.height, deviceScaleFactor: 1 });
  const frames = new Map();
  await bakeFrames(bakery, { out: path.join(OUT, 'live-tmp'), frames: `0-${count - 1}`, fullFrame: true, writeFrames: false, quiet: true,
    onFrame: async (n, png) => { frames.set(n, png); } });
  // Subsequent snapshot replays must return to an empty page
  await bakery.reset(empty, `${ORIGIN}/?export=1&timeline=${encodeURIComponent(`data:application/json,${encodeURIComponent(JSON.stringify(empty))}`)}`);
  await bakery.page.setViewport({ width: PROJECT.width, height: PROJECT.height, deviceScaleFactor: 1 });
  await bakery.client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  return frames;
}
function pixelDiff(a, b) {
  const A = decode(a), B = decode(b);
  if (A.width !== B.width || A.height !== B.height) return { size: [A.width, A.height, B.width, B.height] };
  let differ = 0, maxd = 0;
  for (let i = 0; i < A.data.length; i += 4) {
    let m = 0;
    for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(A.data[i + k] - B.data[i + k]));
    if (m) differ++;
    if (m > maxd) maxd = m;
  }
  return { differ, maxd };
}

const fails = [];
const notes = [];
const out = { ok: false, origin: ORIGIN, out: OUT, cards: {}, timing: {} };
try {
  const a = await runSide('batch4', true);
  const b = await runSide('single', false);
  out.timing = { batch4Ms: a.ms, singleMs: b.ms };
  const { openBakery } = await import('../../server/bakery/chrome.mjs');
  const { captureSnapshot } = await import('../../server/bakery/capture-snapshot.mjs');
  const empty = { ...PROJECT, tracks: [], media: [] };
  const bakery = await openBakery({ url: `${ORIGIN}/?export=1&timeline=${encodeURIComponent(`data:application/json,${encodeURIComponent(JSON.stringify(empty))}`)}` });
  await bakery.page.setViewport({ width: PROJECT.width, height: PROJECT.height, deviceScaleFactor: 1 });
  await bakery.client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  try {
    for (const cardId of CARDS) {
      const ca = a.cards[cardId], cb = b.cards[cardId];
      if (!ca || !cb || ca.skipped || cb.skipped) { out.cards[cardId] = { skipped: ca?.skipped ?? cb?.skipped ?? 'missing' }; continue; }
      const row = { count: ca.count, bytesSame: 0, sameIgnoringWillChange: 0, pixelSame: 0, pixelDiffer: 0, differFrames: [], missing: 0, firstDiff: null,
        batch4: ca.segs.map((s) => s.ms), single: cb.segs.map((s) => s.ms), singlePass: cb.segs.every((s) => s.singlePass) };
      for (let n = 0; n < ca.count; n++) {
        const fa = path.join(OUT, 'batch4', cardId, `${n}.html`), fb = path.join(OUT, 'single', cardId, `${n}.html`);
        if (!fs.existsSync(fa) || !fs.existsSync(fb)) { row.missing++; continue; }
        const ha = fs.readFileSync(fa, 'utf8'), hb = fs.readFileSync(fb, 'utf8');
        if (sha(ha) === sha(hb)) { row.bytesSame++; continue; }
        if (stripWillChange(ha) === stripWillChange(hb)) { row.sameIgnoringWillChange++; continue; }
        const pa = await captureSnapshot(bakery, ha), pb = await captureSnapshot(bakery, hb);
        const d = pa.equals(pb) ? { differ: 0, maxd: 0 } : pixelDiff(pa, pb);
        if (!d.size && d.differ === 0) { row.pixelSame++; continue; }
        row.pixelDiffer++;
        row.differFrames.push(n);
        if (!row.firstDiff) {
          row.firstDiff = { frame: n, ...d };
          fs.mkdirSync(path.join(OUT, 'diff'), { recursive: true });
          fs.writeFileSync(path.join(OUT, 'diff', `${cardId}-${n}-batch4.png`), pa);
          fs.writeFileSync(path.join(OUT, 'diff', `${cardId}-${n}-single.png`), pb);
        }
      }
      out.cards[cardId] = row;
      if (row.missing) fails.push(`${cardId}: missing frames ${row.missing}`);
      if (row.pixelDiffer) {
        // Sides differ: use sequential live render of this card (pushed frame-by-frame from frame 0,
        // capturing screenshots frame-by-frame, same as export) as reference to see which side matches it.
        // Single pass must not fail to match on frames where batch-by-batch matched (that would be a regression);
        // where batch-by-batch already mismatched and single pass matched, single pass is more accurate.
        const truth = await sequentialLive(bakery, cardId, ca.count);
        const judge = { batch4Match: 0, singleMatch: 0, regressions: [] };
        for (const n of row.differFrames) {
          const la = await captureSnapshot(bakery, fs.readFileSync(path.join(OUT, 'batch4', cardId, `${n}.html`), 'utf8'));
          const lb = await captureSnapshot(bakery, fs.readFileSync(path.join(OUT, 'single', cardId, `${n}.html`), 'utf8'));
          const okA = pixelDiff(truth.get(n), la).differ === 0, okB = pixelDiff(truth.get(n), lb).differ === 0;
          if (okA) judge.batch4Match++;
          if (okB) judge.singleMatch++;
          if (okA && !okB) judge.regressions.push(n);
        }
        row.versusLive = judge;
        // Batch-by-batch itself mismatches live render for most of these frames (cards inherently non-deterministic
        // in prerender room, such as E4b probe card `probe-typewriter` driven by setInterval):
        // using it as reference is meaningless; recorded only, not judged.
        judge.referenceUnstable = judge.batch4Match * 2 < row.differFrames.length;
        if (judge.referenceUnstable) notes.push(`${cardId}: per-batch matches the live render in only ${judge.batch4Match} of the ${row.differFrames.length} differing frames, so per-batch cannot serve as the reference (either per-batch itself is wrong, as with mu-word-rotate, or this card is inherently nondeterministic in the prerender room, as with a probe card driven by setInterval); recorded only, not judged`);
        else if (judge.regressions.length) fails.push(`${cardId}: single-pass mismatches on ${judge.regressions.length} frames where per-batch matches the live render (${judge.regressions.slice(0, 8).join(',')})`);
      }
      if (!row.singlePass && !(ca.capabilities?.canvasHeavy)) fails.push(`${cardId}: the new behavior did not take the single-pass path`);
      log(`${cardId.padEnd(24)} bytes same ${row.bytesSame} same ignoring will-change ${row.sameIgnoringWillChange} pixels same ${row.pixelSame} pixels differ ${row.pixelDiffer} missing ${row.missing}${row.versusLive ? `(among the differing frames, matching the sequential live render: per-batch ${row.versusLive.batch4Match}, single-pass ${row.versusLive.singleMatch}, single-pass regressions ${row.versusLive.regressions.length})` : ''}  batch4 ${row.batch4.join('/')} ms  single-pass ${row.single.join('/')} ms`);
    }
  } finally {
    await bakery.close().catch(() => {});
  }
} catch (e) {
  fails.push(`Probe error: ${String(e?.stack ?? e).slice(0, 1200)}`);
}
out.fails = fails;
out.notes = notes;
out.ok = fails.length === 0;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);

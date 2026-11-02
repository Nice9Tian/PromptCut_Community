/**
 * Probe: how long calculating a Lottie frame on the fly takes, and whether it is classified as
 * heavy under existing cost measurement criteria.
 * Source: "Gui" in `docs/plan/render-refactor-task.md`: "How long calculating a Lottie frame on the
 * fly takes has not been measured. Measure it and write it into the Lottie section of
 * `render-standard.md`".
 *
 *   node scripts/probes/lottie-cost-probe.mjs [--port 27260] [--only stage,export] [--sizes 960x540,1920x1080]
 *        [--cards demo,adrock,bodymovin,gatin,happy2016,navidad] [--json <file>] [--no-baseline]
 *
 * Measures the real stage, rather than mounting an isolated player library: start an isolated
 * editor (`preview-stop-lib.mjs`), create a project with only a single card via store actions in the
 * editor (`demo` is the demo animation in default parameters of the generic Lottie card, and the other
 * five are wrapper cards for built-in assets; an additional "empty Lottie", where the generic card
 * holds an animation without any layers, measures the baseline of the stage's own tick to compare
 * how much extra the card itself consumes), setting clip duration to the asset's own duration,
 * frame rate 30. Measured for each asset × each resolution:
 *
 *   stage    Preview on desktop dev server (visible stage, the one in dual stage). Calls the
 *            product's own `setTime` in the visible stage page (`window.__pcStage`, the same function
 *            in stage RPC, called by the parent page when scrubbing the timeline or playing), frame by
 *            frame across full length:
 *              Sequential advance   Seek frames 0, 1, 2... consecutively (forward less than 0.5
 *                                   seconds, taking the stage's "continuous" branch)
 *              Direct jump          Frame numbers across full length are shuffled with a fixed
 *                                   seed, seeking frame by frame out of order (taking the "jump"
 *                                   branch)
 *            Two numbers are recorded for each frame: `sync` = from calling `setTime` until it
 *            returns (React commit finished, Lottie frame step finished, DOM is already at this
 *            frame); `paint` = then wait for the next rAF and a subsequent macro task (browser
 *            finishes painting this frame; lower bound is headless browser frame output cadence,
 *            compared against the difference with "empty Lottie").
 *   export   Export page (`FramePipeline.bakery` + `bakeFrames` / `createStepper`, the same frame
 *            extraction path as real export), three items:
 *              Full frame   `bakeFrames` exports full length sequentially, interval between
 *                           completion times of each frame = exporting one frame (including
 *                           advancing one tick, screenshot, no disk write)
 *              Step time    One step of `createStepper` (dispatch time, drain, advance one tick, pin
 *                           animation, wait for assets), no screenshots; one pass each for
 *                           sequential advance and direct jump
 *              In-page      Time spent running `window.__pcSetT` synchronously in page (React commit +
 *                           Lottie frame step, excluding Node round-trip and frame output); one pass
 *                           each for sequential advance and direct jump
 *   cost     Existing cost measurement criteria: the editor itself (`probeCardOnce` in
 *            `src/editor/probeRunner.ts`) runs a pass for each card on the background stage: direct
 *            cards take `stepMs` across 16 fixed randomly sampled frames with `setTime(t, { probe: true })`,
 *            taking the 90th percentile as the card's `stepMs`; classification formula is
 *            `stepMs × COST_SCALE > 0.7 × one tick`. Reads the cost records it wrote and the
 *            classification (light/heavy) in the dispatch table at a midpoint position
 *            (`__pcStagePipelineAt`), without writing a separate measurement.
 *
 * Statistics: median, 90th percentile, max (milliseconds). Time spent is recorded only, without
 * pass/fail judgment; enters `fails` (exit code 1) only if numbers cannot be measured, the page throws
 * an error, or cost records fail to settle.
 * Output: progress writes to stderr; last line of stdout is JSON `{ ok, fails, rows }`.
 */
import '../lib/no-user-dirs.mjs'; // First import: does not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR, and does not write shared port.json
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { flagArg } from './probe-connect.mjs';
import { costRecordOf, openEditorPage, sleep, startIsolatedEditor, waitFor } from './preview-stop-lib.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { bakeFrames, createStepper } from '../../server/bakery/bake.mjs';

const args = process.argv.slice(2);
const PORT = Number(flagArg('port', '27260', args));
if (!Number.isInteger(PORT) || PORT < 20000) throw new Error('--port must be a port of 20000 or above');
const ONLY = (flagArg('only', null, args) || 'stage,export').split(',').map((s) => s.trim()).filter(Boolean);
const SIZES = (flagArg('sizes', null, args) || '960x540,1920x1080').split(',').map((s) => { const [w, h] = s.split('x').map(Number); return { w, h }; });
const JSON_OUT = flagArg('json', null, args);
const NO_BASELINE = args.includes('--no-baseline');
const RUN = Date.now().toString(36);
const WORK = path.join(os.tmpdir(), `pc-lottie-cost-${RUN}`);
const FPS = 30;
const EMPTY_JSON = JSON.stringify({ v: '5.7.4', fr: 30, ip: 0, op: 60, w: 1920, h: 1080, nm: 'empty', ddd: 0, assets: [], layers: [] });
const ALL_CARDS = [
  { name: 'demo', cardId: 'lottie', seconds: 2, params: {} },
  { name: 'adrock', cardId: 'lottie-adrock', seconds: 13.07, params: {} },
  { name: 'bodymovin', cardId: 'lottie-bodymovin', seconds: 3.43, params: {} },
  { name: 'gatin', cardId: 'lottie-gatin', seconds: 3.2, params: {} },
  { name: 'happy2016', cardId: 'lottie-happy2016', seconds: 3.3, params: {} },
  { name: 'navidad', cardId: 'lottie-navidad', seconds: 5, params: {} },
];
const WANT = (flagArg('cards', null, args) || ALL_CARDS.map((c) => c.name).join(',')).split(',').map((s) => s.trim());
const CARDS = [
  ...(NO_BASELINE ? [] : [{ name: 'empty', cardId: 'lottie', seconds: 2, params: { json: EMPTY_JSON } }]),
  ...ALL_CARDS.filter((c) => WANT.includes(c.name)),
];

const fails = [];
const say = (line) => console.error(line);
const check = (cond, label, extra) => { if (!cond) { const msg = label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400)); fails.push(msg); say(`FAIL ${msg}`); } return !!cond; };

const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : null;
const stats = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const r = (x) => (x === null ? null : +x.toFixed(2));
  return { n: v.length, med: r(quantile(v, 0.5)), p90: r(quantile(v, 0.9)), max: r(v.length ? v[v.length - 1] : null) };
};
/** Fixed-seed shuffle (mulberry32), re-runs on the same machine draw the same order */
function shuffled(n, seed) {
  const a = Array.from({ length: n }, (_, i) => i);
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/**
 * Runs in the visible stage page: seeks frame by frame in the given frame sequence, recording
 * sync / paint for each frame. The stage page replaced clock, timer, and rAF with pinnable virtual
 * versions (`src/kernel/clock.ts`), so the real versions preserved by it are used here:
 * `__pcRealNow`, `__pcRealRaf`, `__pcRealSetTimeout`.
 */
const STAGE_PASS = String.raw`(async (order, fps) => {
  const now = window.__pcRealNow ?? (() => performance.now());
  const raf = window.__pcRealRaf ?? ((cb) => requestAnimationFrame(cb));
  const later = window.__pcRealSetTimeout ?? ((cb, ms) => setTimeout(cb, ms));
  const sync = [], paint = [];
  for (const f of order) {
    const a = now();
    await window.__pcStage.setTime(f / fps);
    const b = now();
    await new Promise((r) => raf(() => r()));
    await new Promise((r) => later(() => r(), 0));
    const c = now();
    sync.push(b - a); paint.push(c - a);
  }
  return { sync, paint };
})`;

const rows = [];
let editor = null, browser = null;
const started = Date.now();
try {
  await fs.mkdir(WORK, { recursive: true });
  editor = await startIsolatedEditor({ port: PORT, work: WORK });
  const origin = editor.origin.replace(/\/+$/, '');
  say(`Editor ${origin}; cases ${CARDS.map((c) => c.name).join(',')}; resolutions ${SIZES.map((s) => `${s.w}x${s.h}`).join(',')}; projects ${ONLY.join(',')}`);
  const ed = await openEditorPage(origin);
  browser = ed.browser;
  const { page, store, frontFrame, parentDiag, pageErrors } = ed;

  for (const size of SIZES) {
    for (const card of CARDS) {
      const tag = `${card.name}@${size.w}x${size.h}`;
      const total = Math.floor(card.seconds * FPS);
      const row = { card: card.name, cardId: card.cardId, size: `${size.w}x${size.h}`, frames: total };
      rows.push(row);
      say(`── ${tag} (${total} frames)`);
      const clipId = await store(`actions.newProject(args[0]);
        actions.setProjectMeta({ width: args[1].w, height: args[1].h });
        const clip = actions.addCardClip(args[2].cardId, 0, { duration: args[2].seconds, params: args[2].params });
        actions.select([]); actions.pause(); actions.seek(0);
        return clip ? clip.id : null;`, `lottie-cost-${RUN}-${tag}`, size, card);
      if (!check(!!clipId, `${tag}: clip was not created`)) continue;
      const stored = await store('return JSON.parse(JSON.stringify(getState().project));');
      check(stored.width === size.w && stored.height === size.h, `${tag}: project resolution was not set to ${size.w}x${size.h}`, [stored.width, stored.height]);

      // Wait for cost records to settle (the editor's own measurement pass), then wait for the visible
      // stage to return to exact live render for this card
      const cost = await waitFor(async () => {
        const rec = await costRecordOf(page, clipId);
        return rec && typeof rec.stepMs === 'number' ? rec : null;
      }, 120000, 500);
      await sleep(1500);
      row.cost = cost ? { stepMs: cost.stepMs, stepMaxMs: cost.stepMaxMs, kind: cost.kind, capped: !!cost.capped, samples: cost.samples ?? null, device: cost.device } : null;
      check(!!cost, `${tag}: no cost record within 120 s`);
      const budget = (1000 / FPS) * 0.7;
      row.budgetMs = +budget.toFixed(2);

      if (ONLY.includes('stage')) {
        const f = await waitFor(async () => {
          const pd = await parentDiag();
          if (!pd || pd.swapInFlight) return null;
          const fr = await frontFrame();
          if (!fr) return null;
          const ok = await fr.evaluate(() => !!window.__pcStage && !!window.__pcStageDiag && window.__pcStageDiag().role === 'front').catch(() => false);
          return ok ? fr : null;
        }, 60000, 300);
        if (!check(!!f, `${tag}: foreground stage not ready`)) continue;
        row.pipeline = await f.evaluate((id, sec) => (typeof window.__pcStagePipelineAt === 'function' ? window.__pcStagePipelineAt(id, sec) : null), clipId, card.seconds / 2).catch(() => null);
        const warm = Array.from({ length: Math.min(30, total) }, (_, i) => i);
        await f.evaluate(`${STAGE_PASS}(${JSON.stringify(warm)}, ${FPS})`);
        const seq = await f.evaluate(`${STAGE_PASS}(${JSON.stringify(Array.from({ length: total }, (_, i) => i))}, ${FPS})`);
        await f.evaluate((fps) => window.__pcStage.setTime(0), FPS);
        const jump = await f.evaluate(`${STAGE_PASS}(${JSON.stringify(shuffled(total, 20261014))}, ${FPS})`);
        row.stage = { seq: { sync: stats(seq.sync), paint: stats(seq.paint) }, jump: { sync: stats(jump.sync), paint: stats(jump.paint) } };
        check(row.stage.seq.sync.n === total && row.stage.jump.sync.n === total, `${tag}: the stage did not measure all ${total} frames`, [row.stage.seq.sync.n, row.stage.jump.sync.n]);
        say(`  stage forward sync ${JSON.stringify(row.stage.seq.sync)} paint ${JSON.stringify(row.stage.seq.paint)}`);
        say(`  stage jump  sync ${JSON.stringify(row.stage.jump.sync)} paint ${JSON.stringify(row.stage.jump.paint)}`);
      }

      if (ONLY.includes('export')) {
        const project = { ...stored, fps: FPS, duration: card.seconds };
        const service = new FramePipeline({ root: path.join(WORK, `lib-${card.name}-${size.w}`), origin: () => origin, dataRoot: WORK });
        let bakery = null;
        try {
          bakery = await service.bakery(project);
          const stamps = [];
          await bakeFrames(bakery, { out: path.join(WORK, `frames-${card.name}-${size.w}`), frames: `0-${total - 1}`, writeFrames: false, quiet: true,
            onFrame: async (i) => { stamps[i] = performance.now(); } });
          const full = []; for (let i = 1; i < stamps.length; i++) full.push(stamps[i] - stamps[i - 1]);
          const step = createStepper(bakery, { fps: FPS });
          const timed = async (order) => { const out = []; for (const i of order) { const a = performance.now(); await step(i, false); out.push(performance.now() - a); } return out; };
          // Export page pins performance.now to export milliseconds (kernel/exportClock.ts); timestamps of
          // performance.mark use native clock, which is used to measure real elapsed time
          const inPage = (order) => bakery.page.evaluate((o, fps) => { const real = () => performance.mark('m').startTime; const out = []; for (const f of o) { const a = real(); window.__pcSetT(f / fps, f / fps); out.push(real() - a); } performance.clearMarks(); return out; }, order, FPS);
          const seqOrder = Array.from({ length: total }, (_, i) => i);
          const jumpOrder = shuffled(total, 20261014);
          const stepSeq = await timed(seqOrder);
          const stepJump = await timed(jumpOrder);
          const pageSeq = await inPage(seqOrder);
          const pageJump = await inPage(jumpOrder);
          row.export = { full: stats(full), stepSeq: stats(stepSeq), stepJump: stats(stepJump), pageSeq: stats(pageSeq), pageJump: stats(pageJump) };
          check(row.export.full.n === total - 1, `${tag}: export not fully measured`, row.export.full.n);
          say(`  export full frame ${JSON.stringify(row.export.full)} time step forward ${JSON.stringify(row.export.stepSeq)} jump ${JSON.stringify(row.export.stepJump)}`);
          say(`  export in-page forward ${JSON.stringify(row.export.pageSeq)} jump ${JSON.stringify(row.export.pageJump)}`);
        } finally { await bakery?.close().catch(() => {}); await service.close().catch(() => {}); }
      }
      say(`  cost record ${JSON.stringify(row.cost)}; dispatch table now ${row.pipeline}`);
    }
  }
  check(pageErrors.length === 0, 'The editor page has no errors', pageErrors.slice(0, 3));
} catch (e) {
  fails.push(`Script error: ${String(e?.stack || e).slice(0, 600)}`);
  say(`ERROR ${e?.stack || e}`);
} finally {
  await browser?.close().catch(() => {});
  try { await editor?.stop?.(); } catch { /* Teardown */ }
}
const summary = { ok: fails.length === 0, fails, seconds: +((Date.now() - started) / 1000).toFixed(1), machine: { cpu: os.cpus()[0]?.model, logical: os.cpus().length, node: process.version }, rows };
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
process.exit(summary.ok ? 0 : 1);

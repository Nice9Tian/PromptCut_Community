/**
 * Probe for "exact on stop": live render visual after jumping back and stopping must match the
 * same frame reached by jumping forward
 * (`docs/semantics/product/rendering.md` "exact on stop"; source: `docs/plan/render-refactor-task.md`
 * "Ji" under "Two places to fix first" item 1).
 *
 *   node scripts/probes/seek-back-exact-probe.mjs [--port 7484] [--out <dir>] [--json <file>] [--cards a,b] [--modes natural,heavy,swap] [--survey [--survey-cards a,b]]
 *   node scripts/probes/seek-back-exact-probe.mjs --origin http://127.0.0.1:7480 …   # Connect to an already running dev server instead of launching one
 *
 * When `--origin` is omitted, launch an isolated editor (`startIsolatedEditor` in
 * `preview-stop-lib.mjs`; stage ports are +1, +2, all three consecutive numbers must be free),
 * terminated after running. Chrome headless.
 *
 * What is tested: Canvas and WebGL cards (particle card `particles`, two particle wrapper cards,
 * `scene-3d`, and `particles-pair` with two particle cards stacked together), each test case in a
 * separate project (0-6 seconds), without playing, only clicking on the timeline (`actions.seek`,
 * parent page sends `setTime` with settle), waiting each time for it to return to exact live
 * render before capturing pixels from the live canvas (`particles-pair` stitches the canvases of
 * the two cards top and bottom into one):
 *
 *   - `fwd37`: jump forward from frame 20 to frame 37 (jumps 17 frames, takes the seek path);
 *     same for `fwd59` and `fwd164`, continuing forward;
 *   - `back37`: **jump back** from frame 164 to frame 37; `back59`: jump back from frame 164 to
 *     frame 59;
 *   - `step38`: step forward one frame from `back37`; `back37b`: step back one frame again;
 *     `fwd38`: jump forward from frame 20 to frame 38;
 *   - `back0` / `init0`: return to frame 0 / frame 0 when project is newly created.
 *
 * Assertions (once for each card and each dispatch mode):
 *   - `back37` matches `fwd37` pixel-by-pixel; same for `back59` and `fwd59`, `back37b` and
 *     `fwd37`, `step38` and `fwd38`, `back0` and `init0`;
 *   - Control: `fwd37` and `fwd59` (two different timestamps) differ noticeably: no fewer than
 *     1000 differing pixels. For sparse visuals like particles, the full-image average delta
 *     between any two frames is only around 1.2, so the primary assertion uses "not a single
 *     pixel differs", and the control proves this ruler can detect differences between two
 *     different frames;
 *   - Whenever capturing pixels, this card is in live render (no snapshot attached, not
 *     suppressed, not in frame catch-up); outside frame 0, canvas is not blank (for
 *     `particles-pair`, neither canvas is blank);
 *   - When the stage indicates a remount, the wrapper layer must be a newly mounted node: if this
 *     stage's per-clip remount generation (`remountGen`) increased, or this time was swapped in
 *     after a background stage whole scene catch-up run (full stage remount), then upon arrival,
 *     this card's wrapper layer cannot still be the original DOM node (probe leaves marks on the
 *     node beforehand).
 *
 * Three dispatch modes (`--modes`, default runs all three):
 *   - `natural`: according to the cost record measured by the page itself;
 *   - `heavy`: pin as heavy card (`pinnedHeavy`), taking the per-clip frame catch-up path in the
 *     visible stage upon stop;
 *   - `swap`: pin as heavy card and change record to global clock only (`vtOk = false`), taking
 *     the background stage whole scene catch-up run and swap path upon stop.
 *
 * `--survey`: additionally sample several other stateful cards (`SURVEY_CARDS`; specified by
 * `--survey-cards`) through the same steps, comparing screenshots of the visible stage (scaled in
 * preview; deselect first to avoid selection outline drawn by editor entering the screenshot),
 * results are only recorded and not counted as failures (written into `survey`). When
 * `--cards none`, none of the main test cases run, only spot checks.
 *
 * Acceptance check: exit code 0, `fails: []` in results. Duration is only recorded
 * (`verification.md` "Duration is only recorded, not used as gate"). Timeout is only to prevent
 * hangs.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { flagArg } from './probe-connect.mjs';
import { createTimings } from './probe-timings.mjs';
import { comparePixels, costRecordOf, decodePng, openEditorPage, savePng, sleep, startIsolatedEditor, waitFor } from './preview-stop-lib.mjs';

const args = process.argv.slice(2);
const GIVEN_ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '7484', args)) || 7484;
const RUN = Date.now().toString(36);
const WORK = path.join(os.tmpdir(), `pc-seek-back-${RUN}`);
const OUT = path.resolve(flagArg('out', null, args) || path.join(WORK, 'out'));
const JSON_OUT = flagArg('json', null, args);
const SURVEY = args.includes('--survey');
const FPS = 30;
const SECONDS = 6;

const CARDS = {
  particles: { cardId: 'particles', params: { color: '#30ff60', quantity: 120, links: 'yes', seed: 5 } },
  'particles-snow': { cardId: 'particles-snow', params: {} },
  'particles-life': { cardId: 'particles-life', params: {} },
  'scene-3d': { cardId: 'scene-3d', params: { spinY: 0.4, spinX: 0.2 } },
  // Two particle cards on screen (one track each): engine's random source and container names are
  // global; the two cards must not override each other or consume each other's random numbers
  'particles-pair': { clips: [
    { cardId: 'particles', params: { color: '#30ff60', quantity: 120, links: 'yes', seed: 5 } },
    { cardId: 'particles', params: { color: '#ff5fa0', quantity: 60, links: 'no', seed: 9, size: 6 } },
  ] },
};
const SURVEY_CARDS = {
  lottie: { cardId: 'lottie', params: {} },
  odometer: { cardId: 'odometer', params: {} },
  'mu-typing': { cardId: 'mu-typing', params: {} },
  'mu-number-ticker': { cardId: 'mu-number-ticker', params: {} },
  'terminal-3d': { cardId: 'terminal-3d', params: {} },
  'growth-curve': { cardId: 'growth-curve', params: {} },
  'punch-pill': { cardId: 'punch-pill', params: {} },
  'blur-text': { cardId: 'blur-text', params: {} },
  checklist: { cardId: 'checklist', params: {} },
  'ring-metric': { cardId: 'ring-metric', params: {} },
  'mu-word-rotate': { cardId: 'mu-word-rotate', params: {} },
};
// `--cards none`: do not run any main test cases (used for spot checks only)
const wantCards = (flagArg('cards', null, args) || Object.keys(CARDS).join(',')).split(',').map((s) => s.trim()).filter((s) => s && s !== 'none');
const wantModes = (flagArg('modes', null, args) || 'natural,heavy,swap').split(',').map((s) => s.trim()).filter(Boolean);
const wantSurvey = (flagArg('survey-cards', null, args) || Object.keys(SURVEY_CARDS).join(',')).split(',').map((s) => s.trim()).filter(Boolean);

const fails = [];
const notes = [];
const timings = createTimings('seek-back-exact-probe');
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 700))); return !!cond; };

const out = { origin: null, ownEditor: !GIVEN_ORIGIN, out: OUT, cards: wantCards, modes: wantModes, cases: [] };
let editor = null;
let browser = null;
try {
  await fs.mkdir(OUT, { recursive: true });
  if (!GIVEN_ORIGIN) editor = await startIsolatedEditor({ port: PORT, work: WORK });
  const origin = (GIVEN_ORIGIN || editor.origin).replace(/\/+$/, '');
  out.origin = origin;
  const ed = await openEditorPage(origin);
  browser = ed.browser;
  const { page, store, frontFrame, frontId, parentDiag, stageFrames } = ed;

  /** Current state of these cards in visible stage (one entry per card) */
  const cardStates = async (clipIds) => {
    const f = await frontFrame();
    if (!f) return null;
    return f.evaluate((ids) => {
      const d = window.__pcStageDiag?.();
      if (!d) return null;
      return ids.map((id) => {
        const wrap = document.querySelector(`[data-pc-clip="${CSS.escape(id)}"]:not([data-pc-media])`);
        return {
          role: d.role, t: d.t, cls: wrap?.className ?? null,
          settling: d.settling.includes(id), suppressed: d.suppressed.includes(id), awaiting: d.awaiting.includes(id),
          snapshot: d.snapshots.includes(id), catchUps: d.catchUps.length,
          remountGen: (d.remountGen.find((e) => e[0] === id) ?? [id, 0])[1],
          pipeline: window.__pcStagePipelineAt?.(id, d.t) ?? null,
          // Mark left by probe on wrapper layer node (`markWrappers`): present = same node, gone = remounted
          mark: wrap ? wrap.__pcProbeMark ?? null : null,
        };
      });
    }, clipIds).catch(() => null);
  };

  /**
   * Leave a mark on wrapper layer node of each card in both stages: if mark remains, node was not
   * remounted
   */
  let markSeq = 0;
  const markWrappers = async (clipIds) => {
    const n = ++markSeq;
    for (const f of stageFrames()) {
      await f.evaluate((ids, n2) => {
        for (const id of ids) {
          const wrap = document.querySelector(`[data-pc-clip="${CSS.escape(id)}"]:not([data-pc-media])`);
          if (wrap) wrap.__pcProbeMark = n2;
        }
      }, clipIds, n).catch(() => {});
    }
  };

  /**
   * Pixels (PNG) of live canvases for these cards at this moment: a horizontal strip per card,
   * stitched top to bottom into one image (each card is its own canvas)
   */
  const grabCanvas = async (clipIds) => {
    const f = await frontFrame();
    if (!f) return null;
    return f.evaluate((ids) => {
      const bands = [];
      for (const id of ids) {
        const wrap = document.querySelector(`[data-pc-clip="${CSS.escape(id)}"]:not([data-pc-media])`);
        if (!wrap) return { error: 'no-wrap', id };
        const live = [...wrap.querySelectorAll('canvas')].filter((el) => !el.hasAttribute('data-pc-stream-plane')
          && !el.closest('[data-pc-snapshot-plane],[data-pc-placeholder-slot],[data-pc-proxy-plane]') && el.width && el.height);
        if (!live.length) return { error: 'no-canvas', id, cls: wrap.className };
        bands.push(live);
      }
      const w = Math.max(...bands.map((b) => b[0].width));
      const h = bands[0][0].height;
      const c = document.createElement('canvas');
      c.width = w; c.height = h * bands.length;
      const ctx = c.getContext('2d');
      bands.forEach((live, i) => { for (const el of live) ctx.drawImage(el, 0, i * h, el.width, h); });
      return { png: c.toDataURL('image/png'), bands: bands.length };
    }, clipIds).catch((e) => ({ error: String(e).slice(0, 200) }));
  };

  /**
   * Screenshot of visible stage iframe (used when surveying other cards: DOM cards have no canvas
   * to capture)
   */
  const grabStage = async () => {
    const id = await frontId();
    const handle = await page.$(`iframe[src*="stage=1"][src*="id=${id}"]`);
    if (!handle) return { error: 'no-iframe' };
    const b64 = await handle.screenshot({ encoding: 'base64', type: 'png' });
    return { png: 'data:image/png;base64,' + b64, bands: 1 };
  };

  /**
   * Seek to frame `frame`, wait for these cards to return to exact live render and visual to
   * stabilize, return pixels at this moment.
   * "Stabilized": after all states settle, sample twice with 150ms interval, then a third time after
   * 250ms; all three match, and visible stage did not change in between.
   */
  const arrive = async (clipIds, frame, label, { pin = null, shot = grabCanvas, tag = '' } = {}) => {
    if (pin) for (const id of clipIds) await costRecordOf(page, id, pin);
    const sec = frame / FPS;
    await markWrappers(clipIds);
    const before = await cardStates(clipIds);
    const beforeFront = await frontId();
    const started = Date.now();
    await store('actions.pause(); actions.seek(args[0]);', sec);
    const settledState = async () => {
      const pd = await parentDiag();
      if (!pd || pd.swapInFlight) return null;
      const last = pd.setTimeLog?.[pd.setTimeLog.length - 1];
      if (!last || Math.abs(last.sec - sec) > 1e-6 || !last.settle) return null;
      const list = await cardStates(clipIds);
      if (!list) return null;
      for (const s of list) {
        if (s.role !== 'front' || Math.abs(s.t - sec) > 1e-6) return null;
        if (s.settling || s.suppressed || s.awaiting || s.snapshot || s.catchUps) return null;
        if (/pc-(settling|suppressed|awaiting|snapshot)/.test(s.cls ?? '')) return null;
      }
      return { list, frontId: pd.frontId };
    };
    let result = null;
    let noShotSince = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const s1 = await settledState();
      if (!s1) { noShotSince = null; await sleep(50); continue; }
      const a = await shot(clipIds);
      if (!a?.png) {
        // All states have settled but live canvas cannot be captured (canvas was detached): no need to
        // wait the full 30 seconds
        noShotSince ??= Date.now();
        if (Date.now() - noShotSince > 4000) break;
        await sleep(80);
        continue;
      }
      noShotSince = null;
      await sleep(150);
      const b = await shot(clipIds);
      await sleep(250);
      const c = await shot(clipIds);
      const s2 = await settledState();
      if (!s2 || s2.frontId !== s1.frontId || a.png !== b?.png || b?.png !== c?.png) continue;
      result = { state: s2, png: c.png, bands: c.bands };
      break;
    }
    const ms = Date.now() - started;
    if (!result) {
      const pd = await parentDiag();
      check(false, `${tag}${label}: frame ${frame} did not return to the exact live render, or the live canvas could not be obtained`, { states: await cardStates(clipIds), shot: await shot(clipIds).then((r) => r?.error ?? 'ok', () => 'throw'),
        swapInFlight: pd?.swapInFlight, lastSetTime: pd?.setTimeLog?.slice(-2), heavy: pd?.snapshotFeed?.heavy });
      return null;
    }
    await savePng(OUT, `${tag}${label}.png`, result.png);
    const pixels = decodePng(result.png);
    // How many opaque pixels each horizontal strip (each card) has
    const bandH = pixels.h / result.bands;
    const ink = Array.from({ length: result.bands }, () => 0);
    for (let y = 0; y < pixels.h; y++) {
      const band = Math.min(result.bands - 1, Math.floor(y / bandH));
      const row = y * pixels.w * 4;
      for (let x = 0; x < pixels.w; x++) if (pixels.data[row + x * 4 + 3]) ink[band]++;
    }
    const first = result.state.list[0];
    // Visible stage switched (full stage remounted during background whole scene catch-up run), or this
    // stage's per-clip remount generation increased: wrapper layer should be a newly mounted node
    const swapped = result.state.frontId !== beforeFront;
    const genUp = !swapped && !!before && result.state.list.some((s, i) => s.remountGen > before[i].remountGen);
    const sameNode = result.state.list.some((s) => s.mark !== null);
    return { label, frame, ms, pixels, ink, frontId: result.state.frontId, pipeline: first.pipeline,
      remounted: before && !swapped ? first.remountGen - before[0].remountGen : null, swapped,
      staleNode: (swapped || genUp) && sameNode ? (swapped ? 'swap' : 'clip') : null };
  };

  /** One test case, one dispatch mode: run through the full steps, return visuals and comparison results */
  const STEPS = [[0, 'init0'], [20, 'at20'], [37, 'fwd37'], [59, 'fwd59'], [164, 'fwd164'], [37, 'back37'], [38, 'step38'], [37, 'back37b'],
    [20, 'at20b'], [38, 'fwd38'], [164, 'fwd164b'], [59, 'back59'], [0, 'back0']];
  const runSequence = async (clipIds, tag, { pin, shot, assert }) => {
    const shots = {};
    const info = [];
    for (const [frame, label] of STEPS) {
      const r = await arrive(clipIds, frame, label, { pin, shot, tag });
      if (!r) continue;
      shots[label] = r;
      info.push({ label, frame, ms: r.ms, ink: r.ink, frontId: r.frontId, pipeline: r.pipeline, remounted: r.remounted, swapped: r.swapped, staleNode: r.staleNode });
    }
    const cmp = (a, b) => (shots[a] && shots[b] ? comparePixels(shots[a].pixels, shots[b].pixels) : { error: 'missing', a: !!shots[a], b: !!shots[b] });
    const pairs = { back37: cmp('back37', 'fwd37'), back37b: cmp('back37b', 'fwd37'), back59: cmp('back59', 'fwd59'), step38: cmp('step38', 'fwd38'),
      back0: cmp('back0', 'init0'), fwd164b: cmp('fwd164b', 'fwd164'), at20b: cmp('at20b', 'at20') };
    const control = { fwd37vs59: cmp('fwd37', 'fwd59'), fwd37vs38: cmp('fwd37', 'fwd38'), back37vsFwd59: cmp('back37', 'fwd59') };
    const ok = (c) => !!c && !c.error && c.identical;
    const say = assert ? check : (cond, label, extra) => { if (!cond) notes.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
    say(info.length === STEPS.length, `${tag}every step returned to the exact live render`, info.map((i) => i.label));
    // Frame 0 can be blank (some particle configs have zero particles at startup); afterwards each
    // card must have visuals
    say(info.filter((i) => i.frame > 0).every((i) => i.ink.every((n) => n > 0)), `${tag}at every step other than frame 0, every card's live canvas is non-empty`, info.map((i) => [i.label, ...i.ink]));
    say(info.every((i) => !i.staleNode), `${tag}when the stage reports a remount (the per-clip remount generation increased, or a swap after a whole-scene background catch-up run), this card's wrapper layer is a newly mounted node`,
      info.filter((i) => i.staleNode).map((i) => `${i.label}@${i.frontId}:${i.staleNode === 'swap' ? 'still the stale node after the swap' : 'still the stale node after the generation increased'}`));
    say(ok(pairs.back37), `${tag}jumping back to frame 37 (from frame 164) is pixel-identical to the same frame reached going forward`, pairs.back37);
    say(ok(pairs.back59), `${tag}jumping back to frame 59 (from frame 164) is pixel-identical to the same frame reached going forward`, pairs.back59);
    say(ok(pairs.back37b), `${tag}stepping back one frame to frame 37 is pixel-identical to the same frame reached going forward`, pairs.back37b);
    say(ok(pairs.step38), `${tag}stepping forward one frame (frame 38) after jumping back is pixel-identical to the same frame reached going forward`, pairs.step38);
    say(ok(pairs.back0), `${tag}going back to frame 0 is pixel-identical to frame 0 when the project was first created`, pairs.back0);
    say(ok(pairs.fwd164b) && ok(pairs.at20b), `${tag}the same frame reached going forward twice is pixel-identical`, { fwd164b: pairs.fwd164b, at20b: pairs.at20b });
    say(!control.fwd37vs59.error && control.fwd37vs59.diffPixels >= 1000, `${tag}control: frame 37 and frame 59 clearly differ (at least 1000 pixels differ)`, control.fwd37vs59);
    return { info, pairs, control };
  };

  /**
   * Create new project, place cards for this test case (one track per card, 0-6 seconds), wait for
   * the page to finish measuring them. Returns clip IDs
   */
  const setupCase = async (name, def) => {
    const clips = def.clips ?? [def];
    const clipIds = await store(`actions.newProject(args[0]);
      const ids = [];
      for (const c of args[2]) {
        const trackId = ids.length ? actions.addTrack('t' + ids.length).id : undefined;
        const clip = actions.addCardClip(c.cardId, 0, { duration: args[1], params: c.params, ...(trackId ? { trackId } : {}) });
        if (clip) ids.push(clip.id);
      }
      // Deselect: the selection outline the editor draws over the preview would end up in screenshots (screenshots are what get compared when spot-checking other cards)
      actions.select([]);
      actions.pause(); actions.seek(0);
      return ids;`, `seek-back-${name}-${RUN}`, SECONDS, clips);
    if (!clipIds || clipIds.length !== clips.length) return null;
    // Wait for page to finish measuring cards (cost records land in dispatch table); if not received,
    // continue running as if there were no records and log an entry
    for (const id of clipIds) if (!(await waitFor(() => costRecordOf(page, id), 120000, 500))) notes.push(`${name}: no cost record after 120 seconds`);
    // Second pass (the pass with snapshots) rewrites the entire record: wait until it stops changing
    let last = '';
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const now = JSON.stringify(await Promise.all(clipIds.map((id) => costRecordOf(page, id))));
      if (now === last && i >= 3) break;
      last = now;
    }
    return clipIds;
  };

  const recordBrief = (r) => (r ? { stepMs: r.stepMs ?? null, catchUpMs: r.catchUpMs ?? null, vtOk: r.vtOk ?? null, seekOk: r.seekOk ?? null, seekMs: r.seekMs ?? null,
    capped: r.capped ?? null, pinnedHeavy: r.pinnedHeavy ?? null } : null);

  for (const name of wantCards) {
    const def = CARDS[name];
    if (!check(!!def, `Recognized case: ${name}`)) continue;
    const started = Date.now();
    const clipIds = await setupCase(name, def);
    if (!check(!!clipIds, `${name}: card added`)) continue;
    const natural = await Promise.all(clipIds.map((id) => costRecordOf(page, id)));
    const entry = { card: name, clipIds, record: natural.map(recordBrief), modes: {} };
    out.cases.push(entry);
    for (const mode of wantModes) {
      const pin = mode === 'heavy' ? { pinnedHeavy: true, vtOk: true } : mode === 'swap' ? { pinnedHeavy: true, vtOk: false } : null;
      if (pin) {
        for (const id of clipIds) await costRecordOf(page, id, pin);
        await sleep(400);
        const pd = await parentDiag();
        check(clipIds.every((id) => pd?.snapshotFeed?.heavy?.includes(id)), `${name}/${mode}: these cards are classified as heavy in the parent page's dispatch table`, pd?.snapshotFeed?.heavy);
      }
      const t0 = Date.now();
      const res = await runSequence(clipIds, `${name}-${mode}-`, { pin, shot: grabCanvas, assert: true });
      entry.modes[mode] = { ...res, pin, ms: Date.now() - t0 };
      timings.record(`${name}/${mode}: total time for ${STEPS.length} arrivals`, Date.now() - t0);
      // Clear the pinned bit; next dispatch starts from the page's own record
      if (pin) for (let i = 0; i < clipIds.length; i++) await costRecordOf(page, clipIds[i], { pinnedHeavy: false, vtOk: natural[i]?.vtOk ?? true });
    }
    timings.record(`${name}: time for the whole case (including waiting for measurement)`, Date.now() - started);
  }

  if (SURVEY) {
    out.survey = [];
    for (const name of wantSurvey) {
      const def = SURVEY_CARDS[name] ?? CARDS[name];
      if (!def) { out.survey.push({ card: name, error: 'unknown' }); continue; }
      const clipIds = await setupCase(name, def);
      if (!clipIds) { out.survey.push({ card: name, error: 'no-clip' }); continue; }
      const natural = recordBrief(await costRecordOf(page, clipIds[0]));
      const before = notes.length;
      const res = await runSequence(clipIds, `survey-${name}-`, { pin: null, shot: grabStage, assert: false });
      out.survey.push({ card: name, clipIds, record: natural, pairs: res.pairs, control: res.control, info: res.info, notes: notes.splice(before) });
    }
  }

  out.pageErrors = ed.pageErrors.slice(0, 10);
} catch (e) {
  fails.push(`Probe error: ${String(e?.stack ?? e).slice(0, 600)}`);
} finally {
  try { await browser?.close(); } catch { /* Already closed */ }
  try { editor?.stop(); } catch { /* Already stopped */ }
}

out.notes = notes;
out.fails = fails;
out.timings = timings.list;
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
const pairLine = (pairs) => Object.entries(pairs).map(([k, v]) => `${k}=${v.error ? 'ERR' : v.identical ? 'same' : `diff ${v.diffPixels}px/mean content diff ${v.meanContent}/max ${v.max}`}`).join(' ');
const pathLine = (info) => info.map((i) => `${i.label}@${i.frontId}${i.swapped ? 'swap' : ''}${i.remounted ? `+${i.remounted}` : ''}${i.staleNode ? '!stale node' : ''}(${i.pipeline},${i.ms}ms)`).join(' ');
const ctlLine = (c) => (c?.error ? 'ERR' : `diff ${c.diffPixels}px/mean content diff ${c.meanContent}`);
for (const cs of out.cases) {
  console.log(`\n[${cs.card}] cost record ${JSON.stringify(cs.record)}`);
  for (const [mode, m] of Object.entries(cs.modes)) {
    console.log(`  ${mode}: ${pairLine(m.pairs)} | control 37↔59 ${ctlLine(m.control.fwd37vs59)}`);
    console.log(`    path: ${pathLine(m.info)}`);
  }
}
for (const sv of out.survey ?? []) {
  console.log(`\n[spot check ${sv.card}] cost record ${JSON.stringify(sv.record ?? sv.error)}`);
  if (!sv.pairs) continue;
  console.log(`  ${pairLine(sv.pairs)} | control 37↔59 ${ctlLine(sv.control.fwd37vs59)}`);
  console.log(`    path: ${pathLine(sv.info)}`);
}
timings.print();
console.log(JSON.stringify({ probe: 'seek-back-exact-probe', out: OUT, cases: out.cases.length, notes, fails }, null, 2));
process.exit(fails.length ? 1 : 0);

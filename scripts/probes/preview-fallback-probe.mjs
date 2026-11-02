/**
 * End-to-end probe for fallback order (rendering.md "Fallback order"): plays projects containing
 * heavy cards in a real editor, and records **tick by tick** which level each suppressed card falls
 * into: `dense` (full-frame stream) / `sparse` (sparse stream) / `snapshot` (nearest snapshot in
 * the same interval) / `placeholder` (placeholder) / `transparent` (transparent without notice,
 * must not occur). The gap before reaching 120 ms to display is recorded as `placeholder-delay`
 * and counted separately.
 *
 *   node scripts/probes/preview-fallback-probe.mjs --origin http://127.0.0.1:5230 [--seconds 10] [--out <dir>] [--json <file>]
 *        [--label after|before] [--baseline <before.json>] [--no-pills] [--page-preload]
 *
 * `--no-pills`: Do not add the two pills (no placeholders); only measure main-thread overhead for
 * the stream + poster snapshot portion; change "After edit" to reset the particle card to the same
 * parameters (localRev + 1, identity unchanged).
 *
 * `--page-preload`: The probe does not invoke preload itself; it only waits for the page's
 * `usePrerenderPreload` (triggered with debounce when edit push succeeds and idle): verifies that
 * the page really triggers prerender under dual stage mode.
 *
 * Ports follow the allocated port range: dev server uses `npx vite --port 5230 --strictPort --host 127.0.0.1`
 * (stage ports 5231 / 5232).
 *
 * Flow (same approach as `scripts/archive/probes/stream-editor-e2e.mjs` (archived): editor
 * `?preview=stage`, probe invokes the prerender process's preload itself with `{ session, localRev }`
 * without waiting for page debounce; with `--page-preload`, triggered by the page itself):
 *   0. Switch to an empty project, add a long particle card (heavy card: classified as heavy by
 *      frame catch-up upper bound), wait for its track stream to reach full density and snapshots
 *      to cover a stretch; add two punchline pills (one rotated 25°, one scaled 0.6), pin them as
 *      heavy cards in the parent page's dispatch table, and **do not prerender them**: on playback
 *      they reach the end of the fallback order and display placeholders (screenshots of the
 *      rotated / scaled ones);
 *   1. **Start playback**: Stay at 0 s, play for 3 s;
 *   2. **Seek**: While paused, seek to 60% of the clip, play for 2 s;
 *   3. **More than 6 streams**: Add 6 more identical particle cards, copy the `stream` / `html`
 *      layers of the first card to them (parent page ready index); with 7 streams total and decoder
 *      budget 6: treat the 7th card as "no stream" and swap snapshot each tick; play for 2 s;
 *   4. **After edit**: Delete those 6 cards, pause at 2 s, modify text on one pill (localRev + 1),
 *      and **immediately** play for 2 s: previously this action cleared the ready index and
 *      reconnected SSE (root cause E), leaving heavy cards completely transparent during the gap.
 *   Also verify: background stage has no placeholder nodes and no injected placeholder styles;
 *   visible stage `__pcCreateSnapshot()` output contains no placeholder nodes; clicking a
 *   placeholder hits the card it belongs to.
 *
 * Tick-by-tick classification relies on the stage's `window.__pcFallbackTrace` (`traceFallback`
 * in `StageView`, recorded only when it is an array). Main-thread time per tick has two parts:
 * `trace.workMs` (work duration for a tick measured by the stage itself, present only in fixed
 * code) and `taskMs` (delta of CDP `Performance.getMetrics` `TaskDuration` sampled at 1/fps:
 * measurable in both pre-fix and post-fix code, used to compare "relative to pre-fix p90
 * increase ≤ 1 ms"). The pre-fix portion is run on pre-fix code with `--label before`, then
 * compared with `--baseline <that json>`.
 *
 * Acceptance check: `transparent` tick count is 0 (`placeholder-delay` is listed separately and
 * excluded).
 * Timings are recorded only (verification.md "Record timings only, do not treat as gate"):
 * main-thread duration per tick and p90 increase of `taskMs` when `--baseline` is provided
 * (original gate ≤ 1 ms) are only written to the `TIMINGS` line and `timings` in the result,
 * and do not determine pass/fail. Wait timeouts (60 s wait for recording is soft; 600 s wait for
 * full density) are only to prevent hangs.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { devOrigin, flagArg } from './probe-connect.mjs';
import { createTimings } from './probe-timings.mjs';

const args = process.argv.slice(2);
const origin = devOrigin(args);
const SECONDS = Number(flagArg('seconds', '10', args)) || 10;
const LABEL = flagArg('label', 'after', args);
const BASELINE = flagArg('baseline', null, args);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-fallback-${LABEL}-${Date.now().toString(36)}`));
const JSON_OUT = flagArg('json', null, args);
const NO_PILLS = args.includes('--no-pills');
const PAGE_PRELOAD = args.includes('--page-preload');
const RUN = Date.now().toString(36);
const fails = [];
const notes = [];
const timings = createTimings('preview-fallback-probe');
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 600))); return cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(3); };

async function until(label, fn, timeoutMs, everyMs = 1000, soft = false) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { (soft ? notes : fails).push(`Timeout: ${label}`); return null; }
    await sleep(everyMs);
  }
}

const out = { origin, label: LABEL, seconds: SECONDS, out: OUT, scenarios: {} };
await fs.mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
  args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 2560, height: 1600 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(origin + '/?editor&nosetup=1&preview=stage', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return !!m.frontStage() && m.backRole() === 'back';
  }, { timeout: 120000, polling: 500 });
  const ports = await (await fetch(origin + '/api/stage/ports')).json();
  const stagePorts = (ports.ports ?? []).slice(0, 2).map(String);
  const store = (fn, ...a) => page.evaluate(async (src, a2) => {
    const { actions, getState } = await import('/src/store/project.ts');
    // eslint-disable-next-line no-new-func
    return new Function('actions', 'getState', 'args', src)(actions, getState, a2);
  }, fn, a);
  const stageFrames = () => page.frames().filter((f) => /[?&]stage=1/.test(f.url()) && stagePorts.some((p) => f.url().includes(`:${p}/`)));
  const frontFrame = async () => {
    const id = await page.evaluate(() => window.__pcPreviewDiag?.().frontId ?? 'A');
    return stageFrames().find((f) => f.url().includes(`id=${id}`)) ?? null;
  };

  /* ---------------------------------------------------------------- 0. Project */
  const clipId = await store(`actions.newProject('fallback-${RUN}');
    const c = actions.addCardClip('particles', 0, { duration: args[0], params: { color: '#30ff60', quantity: 100, links: 'yes', seed: 5 } });
    actions.seek(0);
    return c?.id;`, SECONDS);
  out.clipId = clipId;
  check(!!clipId, 'particle card added');
  /**
   * Pin these cards as heavy cards (`pinnedHeavy`): the parent page dispatch table takes effect
   * immediately (`mergePlanCosts`); upon `persist`, PUT the entire record to this dev server's
   * cost archive (the worktree's own `out/card-costs.json`), and the prerender process places them
   * into the prerender set accordingly. In testing, the particle card is a light card (K1 measured
   * stepMs ≈ 1 ms); without pinning, it live renders during playback and does not enter the fallback
   * order at all.
   */
  const pinHeavy = (ids, persist = false) => page.evaluate(async (ids, persist) => {
    const { getState } = await import('/src/store/project.ts');
    const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
    const pd = await import('/src/editor/planDispatch.ts');
    const keys = clipIdentityOf(getState().project).identityKeys;
    const costs = pd.currentCosts();
    const device = costs[0]?.device ?? 'probe';
    const recs = ids.filter((id) => keys[id]).map((id) => ({ ...(costs.find((r) => r.identityKey === keys[id]) ?? { identityKey: keys[id], device }), pinnedHeavy: true }));
    pd.mergePlanCosts(recs);
    if (persist) {
      const full = recs.filter((r) => typeof r.stepMs === 'number');
      if (full.length) await fetch('/api/data/costs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records: full }) });
    }
    return recs.length;
  }, ids, persist);
  const hasRecords = (ids) => page.evaluate(async (ids) => {
    const { getState } = await import('/src/store/project.ts');
    const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
    const pd = await import('/src/editor/planDispatch.ts');
    const keys = clipIdentityOf(getState().project).identityKeys;
    return ids.every((id) => pd.currentCosts().some((r) => r.identityKey === keys[id]));
  }, ids);
  await until('K1 record of the particle card', () => hasRecords([clipId]), 60000, 500, true);
  await pinHeavy([clipId], true);
  const prerender = await (await fetch(origin + '/api/prerender/info')).json();
  const segCount = Math.ceil(SECONDS * 30 / 15);
  const ready = await until('Track stream of the particle card at full density', async () => {
    const k = await page.evaluate(async () => (await import('/src/render/dataMirror.ts')).mirrorKey());
    if (!k) return null;
    if (!PAGE_PRELOAD) await fetch(prerender.url + '/api/frames/preload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: k.session, localRev: k.localRev, lane: 'background' }) }).catch(() => {});
    const layers = await page.evaluate(async (id) => {
      const m = await import('/src/editor/snapshotFeed.ts');
      const byKind = m.currentReadyIndex().get(id);
      return byKind ? Object.fromEntries([...byKind].map(([k, v]) => [k, v.ranges])) : null;
    }, clipId);
    const covered = (ranges, n) => { let c = 0; for (let i = 0; i < n; i++) if ((ranges ?? []).some((r) => r[0] <= i && i <= r[1])) c++; return c; };
    if (!layers?.stream || covered(layers.stream, segCount) < segCount) return null;
    return layers;
  }, 600000, 2000);
  out.readyLayers = ready ? Object.fromEntries(Object.entries(ready).map(([k, v]) => [k, v.length])) : null;

  // Two pills: one rotated, one scaled. Wait for K1 measurement, then pin as heavy cards in the
  // parent page dispatch table (do not prerender them → end of fallback order)
  // Placed on the top two tracks (index 0): placeholders are not covered by particle streams below,
  // and can be clicked
  const pills = NO_PILLS ? [] : await store(`const a = actions.addClipOnNewTrack({ index: 0, cardId: 'punch-pill', start: 0, duration: args[0] });
    const b = actions.addClipOnNewTrack({ index: 0, cardId: 'punch-pill', start: 0, duration: args[0] });
    actions.setClipParams(a.id, { text: '旋转 ${RUN}' });
    actions.setClipParams(b.id, { text: '缩放 ${RUN}' });
    actions.setClipFrame(a.id, { x: 560, y: 300, w: 640, h: 360, anchor: [0.5, 0.5], rotate: 25 });
    actions.setClipFrame(b.id, { x: 1360, y: 760, w: 640, h: 360, anchor: [0.5, 0.5], scale: 0.6 });
    return [a.id, b.id];`, SECONDS);
  out.pills = pills;
  if (pills.length) await until('K1 record of the pill', () => hasRecords(pills), 60000, 500, true);
  // Pills are only pinned in the parent page (no PUT): the prerender process does not produce them,
  // and during playback they reach the end of the fallback order
  const pinAll = async (extraIds = []) => { await pinHeavy([clipId, ...extraIds]); if (pills.length) await pinHeavy(pills); await sleep(300); };
  await pinAll();
  // Pause at 1 s to let the pill live render once (the placeholder's ink box is measured with
  // debounce after pause)
  await store(`actions.seek(1);`);
  await sleep(1500);

  /* ---------------------------------------------------------------- Tick-by-tick recording + main-thread sampling */
  const cdp = [];
  for (const target of browser.targets()) {
    if (!stagePorts.some((p) => target.url().includes(`:${p}/`))) continue;
    try {
      const s = await target.createCDPSession();
      await s.send('Performance.enable');
      cdp.push({ url: target.url(), s });
    } catch { /* Frames in the same process do not have separate targets */ }
  }
  out.cdpTargets = cdp.map((c) => c.url.replace(/\?.*$/, ''));
  const taskDuration = async (s) => (await s.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')?.value ?? 0;

  async function scenario(name, run) {
    // Which process is the visible stage (determined by front before playback starts; TaskDuration
    // is taken only from its side)
    const frontId = await page.evaluate(() => window.__pcPreviewDiag?.().frontId ?? 'A');
    for (const f of stageFrames()) await f.evaluate(() => { window.__pcFallbackTrace = []; }).catch(() => {});
    const samples = cdp.map(() => []);
    let sampling = true;
    const sampler = (async () => {
      const last = await Promise.all(cdp.map((c) => taskDuration(c.s).catch(() => 0)));
      while (sampling) {
        await sleep(1000 / 30);
        const now = await Promise.all(cdp.map((c) => taskDuration(c.s).catch(() => 0)));
        now.forEach((v, i) => { samples[i].push((v - last[i]) * 1000); last[i] = v; });
      }
    })();
    const shots = await run();
    sampling = false;
    await sampler;
    const traces = [];
    for (const f of stageFrames()) {
      const t = await f.evaluate(() => (Array.isArray(window.__pcFallbackTrace) ? window.__pcFallbackTrace.splice(0) : null)).catch(() => null);
      if (t) traces.push(...t);
      await f.evaluate(() => { delete window.__pcFallbackTrace; }).catch(() => {});
    }
    // Main thread for the visible stage side (the other side is the background stage, listed
    // separately for inspection)
    const frontIdx = cdp.findIndex((c) => c.url.includes(`id=${frontId}`));
    const task = samples[frontIdx] ?? [];
    const backTask = samples.find((_, i) => i !== frontIdx) ?? [];
    const counts = {};
    const transparent = [];
    for (const beat of traces) {
      for (const [id, level] of Object.entries(beat.levels)) {
        counts[level] = (counts[level] ?? 0) + 1;
        if (level === 'transparent') transparent.push({ sec: beat.sec, id });
      }
    }
    const work = traces.map((b) => b.workMs);
    const res = { beats: traces.length, counts, transparent: transparent.slice(0, 20), transparentBeats: transparent.length,
      workMs: { p50: pct(work, 0.5), p90: pct(work, 0.9) }, taskMs: { n: task.length, p50: pct(task, 0.5), p90: pct(task, 0.9) },
      backTaskMs: { p50: pct(backTask, 0.5), p90: pct(backTask, 0.9) }, frontId, shots };
    out.scenarios[name] = res;
    if (LABEL !== 'before') {
      check(traces.length > 0, `${name}: the stage recorded per-tick grading`);
      check(transparent.length === 0, `${name}: no tick is transparent without a hint`, transparent.slice(0, 10));
    }
    return res;
  }
  const play = () => store(`actions.play();`);
  const pause = () => store(`actions.pause();`);
  /** Only capture the visible stage area in preview (the whole page is too small to see placeholders) */
  const shot = async (name) => {
    const file = path.join(OUT, `${LABEL}-${name}.png`);
    const box = await page.evaluate(() => {
      const f = [...document.querySelectorAll('iframe')].filter((el) => /stage=1/.test(el.src) && getComputedStyle(el).opacity !== '0')
        .map((el) => el.getBoundingClientRect()).find((r) => r.width > 100);
      return f ? { x: f.left, y: f.top, width: f.width, height: f.height } : null;
    });
    await page.screenshot({ path: file, ...(box ? { clip: box } : {}) });
    return file;
  };

  /* ---------------------------------------------------------------- 1. Start playback */
  await pinAll();
  await store(`actions.seek(0);`);
  await sleep(1500);
  await scenario('playback start', async () => {
    await play();
    await sleep(350);
    const a = await shot('playback start');
    await sleep(1200);
    // Rotated / scaled pills are currently at the end of fallback order (suppressed, no stream, no
    // snapshot): placeholder
    const front = await frontFrame();
    const ph = front ? await front.evaluate(() => [...document.querySelectorAll('[data-pc-placeholder-slot]:not([hidden])')].map((s) => {
      const plane = s.querySelector('[data-pc-placeholder-plane]');
      const r = (plane ?? s).getBoundingClientRect();
      // Hourglass scale factor (stage compensates for parent page preview zoom, `placeholderFit.ts`):
      // badge is on root element, fill mode is on the middle one
      const tf = (plane?.style.transform || plane?.querySelector('.pc-ph-center')?.style.transform || '');
      const m = /scale\(([\d.]+)\)/.exec(tf);
      return { clip: s.parentElement?.getAttribute('data-pc-clip'), reason: s.getAttribute('data-pc-placeholder-reason'), kind: plane?.getAttribute('data-pc-placeholder-kind') ?? null,
        glassScale: m ? Number(m[1]) : 1, cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height };
    })).catch(() => []) : [];
    out.placeholdersWhilePlaying = ph;
    // Hourglass is ~28 pixels on screen (only cancels preview zoom, does not cancel this layer's own
    // zoom): 28 × scale factor × preview zoom
    const viewScale = await page.evaluate(() => {
      const f = [...document.querySelectorAll('iframe')].filter((el) => /stage=1/.test(el.src) && getComputedStyle(el).opacity !== '0')
        .find((el) => el.getBoundingClientRect().width > 100);
      return f ? f.getBoundingClientRect().width / f.offsetWidth : null;
    }).catch(() => null);
    out.hourglassScreen = ph.filter((x) => x.kind === 'badge' || x.kind === 'solid').map((x) => ({ clip: x.clip, kind: x.kind, glassScale: x.glassScale, viewScale, screenPxNoLayerScale: viewScale ? +(28 * x.glassScale * viewScale).toFixed(1) : null }));
    if (LABEL !== 'before' && viewScale && out.hourglassScreen.length) {
      check(out.hourglassScreen.every((x) => Math.abs(x.screenPxNoLayerScale - 28) <= 3), 'The hourglass is about 28 pixels on screen (compensated for the preview scale)', out.hourglassScreen);
    }
    const b = await shot('placeholder-rotation-and-scaling');
    // Clicking a placeholder hits the card it belongs to; no placeholder nodes in snapshots
    if (front && ph.length) {
      const hit = await front.evaluate((x, y) => window.__pcStage.hitTest(x, y), ph[0].cx, ph[0].cy).catch((e) => ({ error: String(e) }));
      out.placeholderHit = { want: ph[0].clip, hit };
      check(hit?.clipId === ph[0].clip, 'Clicking a placeholder hits the card it belongs to', out.placeholderHit);
      const snap = await front.evaluate(() => { const s = window.__pcCreateSnapshot(); return { html: s.html.includes('data-pc-placeholder'), controls: s.controls.some((c) => c.html.includes('data-pc-placeholder')) }; }).catch((e) => ({ error: String(e) }));
      out.snapshotHasPlaceholder = snap;
      check(snap && snap.html === false && snap.controls === false, 'Generate snapshots carries no placeholder nodes', snap);
    }
    if (LABEL !== 'before') {
      /*
       * Pills either reach the end of the fallback order to display placeholders, or already have
       * prerender output backing them (snapshot / stream): after the page itself triggers prerender
       * (Item 5, `usePrerenderPreload`), pills will also be prerendered and won't necessarily reach
       * the end. The only forbidden case is "neither exists" (which would be transparent, guarded
       * separately by tick-by-tick classification's transparent count).
       */
      const covered = front ? await front.evaluate(() => {
        const d = window.__pcStageDiag();
        return { snapshots: d.snapshots, planes: d.streamPlanes.flatMap((p) => p.clipIds) };
      }).catch(() => ({ snapshots: [], planes: [] })) : { snapshots: [], planes: [] };
      out.pillsCovered = covered;
      for (const id of pills) {
        check(ph.some((p) => p.clip === id) || covered.snapshots.includes(id) || covered.planes.includes(id),
          `Pill ${id} shows a placeholder, or already has a prerender output underneath`, { ph, covered });
      }
    }
    await sleep(1400);
    await pause();
    return [a, b];
  });
  await sleep(1500);

  /* ---------------------------------------------------------------- 2. Seek */
  await pinAll();
  await store(`actions.seek(args[0]);`, +(SECONDS * 0.6).toFixed(2));
  await sleep(1200);
  await scenario('jump', async () => {
    await play();
    await sleep(300);
    const a = await shot('jump');
    await sleep(1700);
    await pause();
    return [a];
  });
  await sleep(1500);

  /* ---------------------------------------------------------------- 3. More than 6 streams */
  const extra = await store(`const out = [];
    for (let i = 0; i < 6; i++) { const c = actions.addClipOnNewTrack({ cardId: 'particles', start: 0, duration: args[0] }); actions.setClipParams(c.id, { color: '#30ff60', quantity: 100, links: 'yes', seed: 5 }); out.push(c.id); }
    actions.seek(0.5);
    return out;`, SECONDS);
  out.extra = extra;
  await sleep(1000);
  const injected = await page.evaluate(async (orig, ids) => {
    const m = await import('/src/editor/snapshotFeed.ts');
    const idx = m.currentReadyIndex();
    const src = idx.get(orig);
    if (!src) return 0;
    for (const id of ids) idx.set(id, new Map([...src].map(([k, v]) => [k, { ...v }])));
    return ids.length;
  }, clipId, extra);
  check(injected === 6, 'Cloned stream layers for 6 new particle cards', injected);
  // New cards share the same identity; pin as heavy cards together
  await pinAll(extra);
  await sleep(500);
  await scenario('more than 6 streams', async () => {
    await play();
    await sleep(1000);
    const front = await frontFrame();
    out.overBudget = front ? await front.evaluate(() => {
      const d = window.__pcStageDiag();
      const planesWithin = d.streamPlanes.filter((p) => !p.over).length;
      return { planes: d.streamPlanes.length, planesWithin, tracks: d.streams.tracks.length, snapshots: d.snapshots.length, suppressed: d.suppressed.length, over: d.streams.over?.length ?? 0 };
    }).catch(() => null) : null;
    const a = await shot('more than 6 streams');
    await sleep(1000);
    await pause();
    return [a];
  });
  if (LABEL !== 'before') check(out.overBudget && out.overBudget.planesWithin === out.overBudget.tracks && out.overBudget.tracks <= 32, 'The number of stage decoders matches the number of in-budget stream planes and does not exceed the hard limit (≤ 32)', out.overBudget);
  await sleep(1200);

  /* ---------------------------------------------------------------- 4. After edit */
  await store(`for (const id of args[0]) actions.removeClip(id); actions.seek(2);`, extra);
  await pinAll();
  await sleep(1500);
  await scenario('after editing', async () => {
    if (pills.length) await store(`actions.setClipParams(args[0], { text: '改过 ${RUN}' }); actions.play();`, pills[0]);
    else await store(`actions.setClipParams(args[0], { seed: 5 }); actions.play();`, clipId);
    await sleep(400);
    const a = await shot('after editing');
    await sleep(1600);
    await pause();
    return [a];
  });
  await sleep(1000);

  /* ---------------------------------------------------------------- Background stage */
  const backId = await page.evaluate(() => ((window.__pcPreviewDiag?.().frontId ?? 'A') === 'A' ? 'B' : 'A'));
  const back = stageFrames().find((f) => f.url().includes(`id=${backId}`));
  out.backStage = back ? await back.evaluate(() => ({ slots: document.querySelectorAll('[data-pc-placeholder-slot],[data-pc-placeholder-plane]').length,
    style: !!document.querySelector('style[data-pc-placeholder]'), role: window.__pcStageDiag?.().role })).catch((e) => ({ error: String(e) })) : null;
  if (LABEL !== 'before') check(out.backStage && out.backStage.slots === 0 && out.backStage.style === false, 'The background stage mounts no placeholder nodes and injects no placeholder styles', out.backStage);

  /* ---------------------------------------------------------------- Summary */
  const all = Object.values(out.scenarios);
  out.total = {
    beats: all.reduce((n, s) => n + s.beats, 0),
    transparentBeats: all.reduce((n, s) => n + s.transparentBeats, 0),
    placeholderDelay: all.reduce((n, s) => n + (s.counts['placeholder-delay'] ?? 0), 0),
    counts: all.reduce((acc, s) => { for (const [k, v] of Object.entries(s.counts)) acc[k] = (acc[k] ?? 0) + v; return acc; }, {}),
    taskP90: pct(all.flatMap((s) => [s.taskMs.p90]).filter((v) => v !== null), 0.5),
  };
  if (BASELINE) {
    const base = JSON.parse(await fs.readFile(BASELINE, 'utf8'));
    out.vsBaseline = {};
    for (const [name, s] of Object.entries(out.scenarios)) {
      const b = base.scenarios?.[name];
      if (!b?.taskMs?.p90 || s.taskMs.p90 === null) continue;
      const delta = +(s.taskMs.p90 - b.taskMs.p90).toFixed(3);
      out.vsBaseline[name] = { before: b.taskMs.p90, after: s.taskMs.p90, delta };
      // Record timings only (verification.md "Record timings only, do not treat as gate"): originally
      // delta ≤ 1 ms was the pass condition
      timings.record(`${name}: increase in p90 per-tick main-thread time relative to baseline`, delta, { formerLimit: '≤ 1 ms' });
    }
  }
  for (const [name, s] of Object.entries(out.scenarios)) {
    timings.record(`${name}: p90 per-tick main-thread time (CDP TaskDuration)`, s.taskMs.p90);
    timings.record(`${name}: p90 stage work time per tick`, s.workMs.p90);
  }
  out.pageErrors = errors;
} catch (error) {
  fails.push(`Exception: ${error?.stack || error}`);
} finally {
  out.fails = fails;
  out.notes = notes;
  out.timings = timings.list;
  await browser.close().catch(() => {});
  const text = JSON.stringify(out, null, 2);
  if (JSON_OUT) await fs.writeFile(JSON_OUT, text);
  console.log(text);
  timings.print();
  console.log(fails.length ? `FAIL ${fails.length}` : 'PASS');
  process.exit(fails.length ? 1 : 0);
}

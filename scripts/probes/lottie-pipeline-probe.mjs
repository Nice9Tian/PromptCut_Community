/**
 * Probe: after converting Lottie to remotion-style, verify once in the **real pipeline**: visible
 * stage (play, pause, scrub), export, and prerender stream generation.
 * Source: acceptance check for "Gui" in `docs/plan/render-refactor-task.md`, and item 1 of "Things to
 * do during integration" ("Consistency between preview and export" must be verified in the real
 * export pipeline).
 *
 *   node scripts/probes/lottie-pipeline-probe.mjs [--port 27610] [--out <dir>] [--only stage,export,streams] [--json <file>]
 *
 * Starts an isolated editor itself (`startIsolatedEditor` in `preview-stop-lib.mjs`: data directory
 * and build artifact directory are both in temp dir, without writing shared port.json; `--port` also
 * occupies +1 and +2 as stage ports), Chrome headless. The project is created in the editor using
 * store actions, with four Lottie clips end to end:
 *   Built-in `lottie-navidad` (with nested masks) and `lottie-happy2016` (the one retaining old values
 *   in attributes);
 *   Generic `lottie` card holding two hand-written test assets (the one with random expressions and
 *   the one with random-order text under `scripts/probes/fixtures/lottie-seed/`).
 *
 * What is verified:
 *   export   Real export (`exportUnified`, export page): export full length three times: single-way
 *            sequential export, 4-way split export (remotion-style cards allow splitting in the
 *            middle of a clip, subsequent ways start by jumping directly into the middle of a clip),
 *            and exporting only sampled frames (random access). PNGs of the same frame across all
 *            three passes are identical pixel by pixel. In addition, the export page
 *            (`FramePipeline.bakery` + `bakeFrames`, the same frame extraction path as export) records
 *            the hash of "visible SVG text" frame by frame for each card to compare against stage.
 *   stage    Visible stage: click on the timeline while paused (forward, backward, across clips),
 *            waiting each time for it to return to exact live render, and read the card's visible SVG
 *            text: must match the same frame on the export page (consistency between preview and
 *            export); seeking forward or backward to the same frame must match. Then play a section
 *            and pause: the stopped frame must also match the export page; samples taken during
 *            playback that fall on integer frames must also match.
 *   streams  Prerender: in the card plan, Lottie's `frameMode` is direct and snapshot tier
 *            (`snapshotTier`) is none; after being pinned as heavy cards, each has a single-card
 *            stream, and in the ready index these cards have only a `stream` layer without a snapshot
 *            layer; stream `replay` is false, and `replayedFrames` remains 0 after generation and after
 *            invalidating and re-producing several middle segments; for the same segment, "generate
 *            directly without replay" and "generate with replay from mount frame" have identical PNGs
 *            frame by frame (pixel by pixel).
 *
 * Verdict: all the above hold; if any fails, enters `fails` with exit code 1. Time spent is recorded
 * only.
 */
import '../lib/no-user-dirs.mjs'; // First import: does not inherit external export directory / data directory, and does not write shared port.json
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { PNG } from 'pngjs';
import { flagArg } from './probe-connect.mjs';
import { openEditorPage, sleep, startIsolatedEditor, waitFor } from './preview-stop-lib.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { exportUnified } from '../../server/bakery/export-unified.mjs';
import { bakeFrames, bakeStream } from '../../server/bakery/bake.mjs';
import { SEGMENT_FRAMES } from '../../server/frame-stream.mjs';
import { snapshotTier } from '../../server/snapshot-tier.mjs';

const args = process.argv.slice(2);
const PORT = Number(flagArg('port', '27610', args));
if (!Number.isInteger(PORT) || PORT < 20000) throw new Error('--port must be a port of 20000 or above');
const RUN = Date.now().toString(36);
const WORK = path.join(os.tmpdir(), `pc-lottie-pipeline-${RUN}`);
const OUT = path.resolve(flagArg('out', null, args) || path.join('out', 'lottie-pipeline-probe'));
const JSON_OUT = flagArg('json', null, args);
const ONLY = (flagArg('only', null, args) || 'export,stage,streams').split(',').map((s) => s.trim()).filter(Boolean);
const FPS = 30;
const FIX = '/scripts/probes/fixtures/lottie-seed';
const CLIPS = [
  { name: 'navidad', cardId: 'lottie-navidad', start: 0, seconds: 5, params: {} },
  { name: 'happy2016', cardId: 'lottie-happy2016', start: 5, seconds: 3.4, params: {} },
  { name: 'random-expr', cardId: 'lottie', start: 8.4, seconds: 2, params: { json: '', src: `${FIX}/expr-layers.json` } },
  { name: 'random-text', cardId: 'lottie', start: 10.4, seconds: 2, params: { json: '', src: `${FIX}/text-random.json` } },
];
const DURATION = 12.4;

const fails = [];
const say = (line) => console.log(line);
const check = (cond, label, extra) => { if (!cond) { const msg = label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 500)); fails.push(msg); say(`FAIL ${msg}`); } return !!cond; };
const out = { port: PORT, out: OUT, only: ONLY };

/**
 * Used in page: hash of "visible SVG text" for a card (same standard as lottie-seed-probe.mjs),
 * computed synchronously and included in the same call as reading stage time
 */
const GRAB_SRC = String.raw`(() => {
  if (window.__pcLottieGrab) return true;
  const normalize = (s) => { const ids = new Map(); return s.replace(/__lottie_element_\d+/g, (m) => { if (!ids.has(m)) ids.set(m, 'E' + ids.size); return ids.get(m); }); };
  const visible = (svg) => {
    const copy = svg.cloneNode(true);
    const walk = (el) => {
      if (el.style && el.style.display === 'none') { while (el.firstChild) el.removeChild(el.firstChild); for (const a of [...el.attributes]) if (a.name !== 'id' && a.name !== 'style') el.removeAttributeNode(a); return; }
      const attrs = [...el.attributes].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
      for (const a of attrs) el.removeAttributeNode(a);
      for (const a of attrs) el.setAttributeNode(a);
      for (const child of [...el.children]) walk(child);
    };
    walk(copy);
    const refsOf = (el, into) => { for (const node of [el, ...el.querySelectorAll('*')]) for (const a of node.attributes) { for (const m of a.value.matchAll(/url\(["']?#([^)"']+)["']?\)/g)) into.add(m[1]); if (a.localName === 'href' && a.value.startsWith('#')) into.add(a.value.slice(1)); } };
    const byId = new Map(); for (const el of copy.querySelectorAll('[id]')) byId.set(el.getAttribute('id'), el);
    const used = new Set(); const pending = new Set();
    for (const child of copy.children) if (child.localName !== 'defs') refsOf(child, pending);
    while (pending.size) { const id = pending.values().next().value; pending.delete(id); if (used.has(id)) continue; used.add(id); const el = byId.get(id); if (el) { const more = new Set(); refsOf(el, more); for (const x of more) if (!used.has(x)) pending.add(x); } }
    for (const defs of copy.querySelectorAll('defs')) for (const res of [...defs.children]) { const ids = [res, ...res.querySelectorAll('[id]')].map((el) => el.getAttribute('id')).filter(Boolean); if (!ids.some((id) => used.has(id))) res.remove(); }
    return normalize(new XMLSerializer().serializeToString(copy));
  };
  const hash = (s) => { let a = 0x811c9dc5, b = 0x1b873593; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x85ebca6b) + 0x7f4a7c15 | 0; } return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0') + ':' + s.length; };
  /** 每张挂着 Lottie 的片段:{ 片段 id: 散列 };没挂或没有 SVG 的不列 */
  window.__pcLottieGrab = (ids) => {
    const res = {};
    for (const wrap of document.querySelectorAll('[data-pc-clip]:not([data-pc-media])')) {
      const id = wrap.getAttribute('data-pc-clip');
      if (ids && !ids.includes(id)) continue;
      const svg = [...wrap.querySelectorAll('svg')].find((el) => !el.closest('[data-pc-snapshot-plane],[data-pc-placeholder-slot],[data-pc-proxy-plane]'));
      if (svg) res[id] = hash(visible(svg));
    }
    return res;
  };
  return true;
})()`;

function diffPixels(a, b) {
  const pa = PNG.sync.read(a), pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return -1;
  let n = 0;
  for (let i = 0; i < pa.data.length; i += 4) if (pa.data[i] !== pb.data[i] || pa.data[i + 1] !== pb.data[i + 1] || pa.data[i + 2] !== pb.data[i + 2] || pa.data[i + 3] !== pb.data[i + 3]) n++;
  return n;
}
const inkPixels = (png) => { const p = PNG.sync.read(png); let n = 0; for (let i = 3; i < p.data.length; i += 4) if (p.data[i] > 0) n++; return n; };
const frameFile = (dir, f) => path.join(dir, 'frames', `${String(f).padStart(6, '0')}.png`);

let editor = null, browser = null, pipeline = null;
const started = Date.now();
try {
  await fs.mkdir(OUT, { recursive: true });
  await fs.mkdir(WORK, { recursive: true });
  editor = await startIsolatedEditor({ port: PORT, work: WORK });
  const origin = editor.origin.replace(/\/+$/, '');
  out.origin = origin;
  // Test assets are served as regular files by this editor (accessible by both stage and export
  // page); without them, all subsequent tests are futile
  for (const name of ['expr-layers.json', 'text-random.json']) {
    const ok = await fetch(`${origin}${FIX}/${name}`).then(async (r) => r.ok && !!(await r.json()).layers, () => false);
    if (!ok) throw new Error(`The editor did not serve ${FIX}/${name} as JSON`);
  }

  // ── Create project in editor ──
  const ed = await openEditorPage(origin);
  browser = ed.browser;
  const { page, store, frontFrame, parentDiag, pageErrors } = ed;
  const clipIds = await store(`actions.newProject(args[0]);
    const ids = [];
    for (const c of args[1]) {
      const trackId = ids.length ? actions.addTrack('t' + ids.length).id : undefined;
      const clip = actions.addCardClip(c.cardId, c.start, { duration: c.seconds, params: c.params, ...(trackId ? { trackId } : {}) });
      if (clip) ids.push(clip.id);
    }
    actions.select([]); actions.pause(); actions.seek(0);
    return ids;`, `lottie-pipeline-${RUN}`, CLIPS);
  if (!clipIds || clipIds.length !== CLIPS.length) throw new Error(`Project was not created: ${JSON.stringify(clipIds)}`);
  CLIPS.forEach((c, i) => { c.id = clipIds[i]; });
  const stored = await store('return JSON.parse(JSON.stringify(getState().project));');
  // Export and prerender use this exact instance from the editor (identical clip ids), only pinning
  // duration to the total duration of the four clips
  const project = { ...stored, fps: FPS, duration: DURATION };
  const placed = project.tracks.flatMap((t) => t.clips).map((c) => ({ id: c.id, cardId: c.cardId, start: c.start, end: c.end }));
  out.project = { id: project.id, width: project.width, height: project.height, fps: project.fps, duration: project.duration, storedDuration: stored.duration, clips: placed };
  check(project.width === 1920 && project.height === 1080 && (stored.fps ?? 30) === FPS, 'The project is 1920×1080 at 30 fps', out.project);
  check(CLIPS.every((c) => placed.some((p) => p.id === c.id && Math.abs(p.start - c.start) < 1e-6 && Math.abs(p.end - c.start - c.seconds) < 1e-6)), 'The four clips are placed at the planned positions', placed);
  const TOTAL = Math.floor(DURATION * FPS);
  const clipAt = (f) => CLIPS.find((c) => f / FPS >= c.start - 1e-9 && f / FPS < c.start + c.seconds - 1e-9) ?? null;
  const exportUrl = `${origin}/?export=1&timeline=${encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(project)))}`;

  // ── Frame-by-frame SVG text hashes from export page (same frame extraction path as export) to
  // compare against stage; the export item also requires this first ──
  const domByFrame = [];
  if (ONLY.includes('export') || ONLY.includes('stage')) {
    const service = new FramePipeline({ root: path.join(WORK, 'dom-lib'), origin: () => origin, dataRoot: WORK });
    let bakery = null;
    try {
      bakery = await service.bakery(project);
      await bakeFrames(bakery, { out: path.join(WORK, 'dom-frames'), frames: `0-${TOTAL - 1}`, writeFrames: false, quiet: true,
        onFrame: async (f) => { await bakery.page.evaluate(GRAB_SRC); domByFrame[f] = await bakery.page.evaluate(() => window.__pcLottieGrab(null)); } });
    } finally { await bakery?.close().catch(() => {}); await service.close().catch(() => {}); }
    const missing = []; for (let f = 0; f < TOTAL; f++) { const c = clipAt(f); if (c && !domByFrame[f]?.[c.id]) missing.push(f); }
    out.exportDom = { frames: domByFrame.filter(Boolean).length, missing: missing.length, distinct: Object.fromEntries(CLIPS.map((c) => [c.name, new Set(domByFrame.map((d) => d?.[c.id]).filter(Boolean)).size])) };
    check(missing.length === 0, 'Every frame of the export page read the SVG of the card on stage', missing.slice(0, 20));
    for (const c of CLIPS) check(out.exportDom.distinct[c.name] > 20, `${c.name}: the export page's per-frame picture does change`, out.exportDom.distinct[c.name]);
    say(`Export page frame by frame: ${out.exportDom.frames} frames, ${missing.length} missing; distinct pictures per card ${JSON.stringify(out.exportDom.distinct)}`);
  }

  // ── export: real export, three passes ──
  if (ONLY.includes('export')) {
    const logs = [];
    const realLog = console.log;
    const run = async (name, opts) => {
      const dir = path.join(OUT, name);
      await fs.rm(dir, { recursive: true, force: true });
      const t0 = Date.now();
      console.log = (...a) => { const line = a.join(' '); if (/sharded export/.test(line)) logs.push(`${name}: ${line}`); };
      try { await exportUnified(project, { url: exportUrl, out: dir, noVideo: true, ...opts }); } finally { console.log = realLog; }
      return { dir, seconds: +((Date.now() - t0) / 1000).toFixed(1) };
    };
    const one = await run('export-1', { workers: 1 });
    const four = await run('export-4', { workers: 4 });
    const picks = [0, 1, 37, 62, 75, 96, 149, 150, 151, 199, 240, 251, 252, 263, 289, 311, 312, 330, 345, 371].filter((f) => f < TOTAL);
    const some = await run('export-picks', { targetFrames: picks });
    const shardLine = logs.find((l) => l.startsWith('export-4')) ?? '';
    const cuts = [...shardLine.matchAll(/(\d+)-(\d+)/g)].map((m) => Number(m[1])).filter((f) => f > 0);
    const insideClip = cuts.filter((f) => { const c = clipAt(f); return c && Math.round(c.start * FPS) !== f; });
    const cmp = (a, b, frames) => { const bad = []; let ink = 0; for (const f of frames) { const pa = fsSync.readFileSync(frameFile(a, f)), pb = fsSync.readFileSync(frameFile(b, f)); if (!pa.equals(pb)) { const d = diffPixels(pa, pb); if (d !== 0) bad.push({ f, pixels: d }); } if (f % 37 === 0) ink += inkPixels(pa) > 0 ? 1 : 0; } return { bad, ink }; };
    const all = Array.from({ length: TOTAL }, (_, i) => i);
    const a = cmp(one.dir, four.dir, all), b = cmp(one.dir, some.dir, picks);
    out.export = { seconds: { one: one.seconds, four: four.seconds, picks: some.seconds }, shards: shardLine, cuts, cutsInsideClip: insideClip, oneVsFour: { frames: TOTAL, differ: a.bad }, oneVsPicks: { frames: picks.length, differ: b.bad } };
    check(cuts.length >= 1, 'The 4-lane export did split', shardLine);
    check(insideClip.length >= 1, 'At least one split lands in the middle of a Lottie clip (that lane jumps straight in)', { cuts, clips: placed });
    check(a.ink > 0, 'The exported frame is not empty');
    check(a.bad.length === 0, `Single-lane sequential export vs 4-lane export: all ${TOTAL} frames are pixel-identical`, a.bad.slice(0, 12));
    check(b.bad.length === 0, `Single-lane sequential export vs export of only the ${picks.length} sampled frames: pixel-identical`, b.bad.slice(0, 12));
    say(`Export: single-lane ${one.seconds} s, 4-lane ${four.seconds} s, ${picks.length} sampled frames ${some.seconds} s; ${shardLine}; splits inside clips: ${insideClip.join(', ') || 'none'}; ${a.bad.length} frames differ between single-lane and 4-lane, ${b.bad.length} frames differ between single-lane and sampled frames`);
  }

  // ── stage: visible stage ──
  if (ONLY.includes('stage')) {
    const ids = CLIPS.map((c) => c.id);
    /** Current visible stage: time, status of each card, SVG hash of each card (read in the same call) */
    const readStage = async () => {
      const f = await frontFrame();
      if (!f) return null;
      await f.evaluate(GRAB_SRC).catch(() => {});
      return f.evaluate((ids2) => {
        const d = window.__pcStageDiag?.();
        if (!d || !window.__pcLottieGrab) return null;
        const busy = ids2.filter((id) => d.settling.includes(id) || d.suppressed.includes(id) || d.awaiting.includes(id) || d.snapshots.includes(id));
        const cls = ids2.map((id) => document.querySelector(`[data-pc-clip="${CSS.escape(id)}"]:not([data-pc-media])`)?.className ?? '').filter((c) => /pc-(settling|suppressed|awaiting|snapshot)/.test(c));
        return { role: d.role, t: d.t, busy, cls, catchUps: d.catchUps.length, hashes: window.__pcLottieGrab(ids2) };
      }, ids).catch(() => null);
    };
    /** Click to frame while paused, wait for it to return to exact live render, and verify two consecutive reads match */
    const arrive = async (frame) => {
      const sec = frame / FPS;
      await store('actions.pause(); actions.seek(args[0]);', sec);
      let last = null;
      const got = await waitFor(async () => {
        const pd = await parentDiag();
        if (!pd || pd.swapInFlight) return null;
        const s = await readStage();
        if (!s || s.role !== 'front' || Math.abs(s.t - sec) > 1e-6 || s.busy.length || s.cls.length || s.catchUps) { last = null; return null; }
        const c = clipAt(frame);
        if (c && !s.hashes[c.id]) { last = null; return null; }
        const key = JSON.stringify(s.hashes);
        if (last !== key) { last = key; return null; }
        return s;
      }, 30000, 150);
      return got;
    };
    // Wait for the page to finish measuring all four cards (cost records settled) to avoid the
    // measurement pass remounting the stage halfway
    await sleep(3000);
    const rows = [];
    const visit = async (frame, how) => {
      const s = await arrive(frame);
      const c = clipAt(frame);
      const want = c ? domByFrame[frame]?.[c.id] : null;
      const got = s && c ? s.hashes[c.id] : null;
      rows.push({ frame, clip: c?.name, how, same: !!got && got === want });
      check(!!s, `Stage: ${how} to frame ${frame}, returned to exact live render within 30 s`);
      if (s) check(got === want, `Stage: ${how} to frame ${frame} (${c?.name}), the picture is identical to this frame of the export page`, { got, want });
      return got;
    };
    const byFrame = new Map();
    const remember = (f, h, how) => { if (!h) return; if (byFrame.has(f)) check(byFrame.get(f) === h, `Stage: frame ${f}, the result reached by ${how} is identical to the previous one`); else byFrame.set(f, h); };
    // Forward: sample several frames in each clip (navidad covers the section where the browser does
    // not repaint masks during sequential advance: project frames 61-97)
    const forward = [0, 1, 20, 37, 62, 63, 75, 96, 120, 149, 150, 151, 199, 240, 251, 252, 263, 289, 311, 312, 330, 345, 371];
    for (const f of forward) remember(f, await visit(f, 'click forward'), 'click forward');
    // Backward, jumping randomly across clips
    const back = [345, 263, 75, 312, 62, 199, 20, 289, 96, 0, 371, 37, 240, 1];
    for (const f of back) remember(f, await visit(f, 'click backward or across clips'), 'click backward or across clips');
    // Move frame by frame (scrub): move forward 30 frames in the middle section of navidad, then move
    // backward 10 frames
    for (let f = 60; f <= 90; f++) remember(f, await visit(f, 'step forward frame by frame'), 'step forward frame by frame');
    for (let f = 89; f >= 80; f--) remember(f, await visit(f, 'step backward frame by frame'), 'step backward frame by frame');
    // Play: play a segment from four positions each, sampling along the way, then pause
    const plays = [];
    for (const from of [45, 160, 255, 315]) {
      await arrive(from);
      await store('actions.play();');
      const samples = [];
      const t0 = Date.now();
      while (Date.now() - t0 < 1500) { const s = await readStage(); if (s) samples.push(s); await sleep(60); }
      await store('actions.pause();');
      await sleep(400);
      const pd = await store('return getState().currentTime ?? getState().time ?? null;');
      // After stopping: read current stage time; it should land on an integer frame, and the image must
      // match that frame on the export page
      let stop = null;
      await waitFor(async () => { const s = await readStage(); if (!s || s.role !== 'front' || s.busy.length || s.cls.length || s.catchUps) return null; if (stop && Math.abs(stop.t - s.t) < 1e-9 && JSON.stringify(stop.hashes) === JSON.stringify(s.hashes)) return s; stop = s; return null; }, 30000, 150);
      const onGrid = (t) => Math.abs(t * FPS - Math.round(t * FPS)) < 1e-4;
      let compared = 0, same = 0, offGrid = 0, noSvg = 0;
      for (const s of samples) {
        if (!onGrid(s.t)) { offGrid++; continue; }
        const f = Math.round(s.t * FPS), c = clipAt(f);
        if (!c) continue;
        if (!s.hashes[c.id] || s.busy.includes(c.id)) { noSvg++; continue; }
        compared++; if (s.hashes[c.id] === domByFrame[f]?.[c.id]) same++;
      }
      const stopFrame = stop ? Math.round(stop.t * FPS) : null, sc = stopFrame === null ? null : clipAt(stopFrame);
      const row = { from, samples: samples.length, advanced: samples.length ? +(samples[samples.length - 1].t - samples[0].t).toFixed(3) : 0, compared, same, offGrid, noSvg, stopT: stop?.t ?? null, stopFrame, storeTime: pd,
        stopSame: !!stop && !!sc && onGrid(stop.t) && stop.hashes[sc.id] === domByFrame[stopFrame]?.[sc.id] };
      plays.push(row);
      check(row.advanced > 0.5, `Stage: playing for 1.5 s from frame ${from}, the time did advance`, row);
      check(row.compared > 0 ? row.same === row.compared : true, `Stage: playing from frame ${from}, the samples taken on whole frames along the way match the export page`, row);
      check(row.stopSame, `Stage: after playing from frame ${from} and pausing, the picture at the stopped frame (frame ${stopFrame}) is identical to the export page`, row);
    }
    out.stage = { visited: rows.length, same: rows.filter((r) => r.same).length, plays, pageErrors: pageErrors.slice(0, 5) };
    check(pageErrors.length === 0, 'The editor page has no errors', pageErrors.slice(0, 3));
    say(`Stage: ${rows.length} clicks while paused (forward, backward, across clips, frame by frame), ${out.stage.same} identical to the same export page frame; ${plays.length} playback segments: ${plays.map((p) => `advanced ${p.advanced} s from frame ${p.from}, whole-frame samples along the way ${p.same}/${p.compared} identical (${p.offGrid} not on a whole frame), stopped at frame ${p.stopFrame}${p.stopSame ? 'same' : 'different'}`).join(';')}`);
  }
  await browser?.close().catch(() => {}); browser = null;

  // ── streams: prerender stream generation ──
  if (ONLY.includes('streams')) {
    const lib = path.join(WORK, 'stream-lib');
    pipeline = new FramePipeline({ root: lib, origin: () => origin, interactive: true, playhead: () => null, dataRoot: WORK });
    pipeline.streamPicked = () => true; // Pin as heavy card: remotion-style cards are declared as light cards and do not enter prerender unless pinned
    const producer = pipeline.streamProducer();
    producer.attachRoute();
    const layers = [];
    pipeline.readyIndex.subscribe((m) => { if (m.type === 'layer') layers.push({ clipId: m.clipId, kind: m.kind }); });
    const dense = () => {
      const status = producer.status();
      if (!status.streams.length) return null;
      for (const s of status.streams) for (let n = s.firstSegment; n <= s.lastSegment; n++) if (s.segments[n]?.stride !== 1) return null;
      return !producer.workers.size && !producer.encoding.size ? status : null;
    };
    const t0 = Date.now();
    await pipeline.preload(project);
    const ready = await waitFor(() => (pipeline._streams?.streams.size >= CLIPS.length ? pipeline._streams : null), 180000, 500);
    if (!ready) throw new Error(`Producer did not start: ${pipeline._streams?.streams.size ?? 0} streams`);
    const first = await waitFor(dense, 900000, 1000);
    if (!first) throw new Error('The first production round did not finish');
    const produceSeconds = +((Date.now() - t0) / 1000).toFixed(1);
    const plan = [...pipeline.entries.values()].flatMap((e) => e.cardPlan ?? []);
    const rowOf = (status, clipId) => status.streams.find((s) => s.clipIds.length === 1 && s.clipIds[0] === clipId);
    const stateOf = (clipId) => [...producer.streams.values()].find((s) => s.spec.clipIds.length === 1 && s.spec.clipIds[0] === clipId);
    out.streams = { produceSeconds, encoder: first.encoder, cards: {}, compare: [] };
    for (const c of CLIPS) {
      const control = plan.find((x) => x.clipId === c.id);
      const row = rowOf(first, c.id);
      const kinds = [...new Set(layers.filter((l) => l.clipId === c.id).map((l) => l.kind))];
      const rec = { frameMode: control?.frameMode, tier: control?.tier, tierFromCapabilities: control ? snapshotTier(control.capabilities) : null, compositing: control?.capabilities?.compositing,
        stream: !!row, replay: row?.replay, replayedFrames: row?.replayedFrames, segments: row ? row.lastSegment - row.firstSegment + 1 : 0, layerKinds: kinds };
      out.streams.cards[c.name] = rec;
      check(rec.frameMode === 'direct', `${c.name}: the card plan is remotion-style (direct)`, rec.frameMode);
      check(rec.tier === 'none' && rec.tierFromCapabilities === 'none', `${c.name}: snapshot tier is none (no snapshots produced)`, rec);
      check(rec.stream, `${c.name}: once pinned as a heavy card there is one single-card stream`);
      check(rec.replay === false, `${c.name}: the stream does not replay from the mount frame (replay is false)`, rec.replay);
      check(rec.replayedFrames === 0, `${c.name}: replayedFrames is 0 after production finishes`, rec.replayedFrames);
      check(kinds.includes('stream') && kinds.every((k) => k === 'stream'), `${c.name}: the ready index has only a stream layer, no snapshot layer`, kinds);
    }
    // Check whether any snapshots were left in the store
    const snapshotDirs = ['controls-html', 'controls-local'].map((d) => { try { return fsSync.readdirSync(path.join(lib, d)).length; } catch { return 0; } });
    out.streams.snapshotDirs = { 'controls-html': snapshotDirs[0], 'controls-local': snapshotDirs[1] };
    check(snapshotDirs[0] === 0 && snapshotDirs[1] === 0, 'No snapshots were written next to the stream store', out.streams.snapshotDirs);
    // Invalidate middle segments and re-produce
    const REGEN = [3, 1, 2];
    const before = Object.fromEntries(CLIPS.map((c) => { const r = rowOf(producer.status(), c.id); return [c.id, (r.resets?.sparse ?? 0) + (r.resets?.dense ?? 0)]; }));
    for (const c of CLIPS) { const state = stateOf(c.id); for (const n of REGEN) delete state.manifest.segments[state.spec.firstSegment + n]; }
    producer.kick();
    const second = await waitFor(() => { const s = dense(); return s && s.streams.every((x) => REGEN.every((n) => x.segments[x.firstSegment + n]?.stride === 1)) ? s : null; }, 900000, 1000);
    if (!second) throw new Error('The invalidated segment did not finish producing again');
    for (const c of CLIPS) {
      const r = rowOf(second, c.id);
      const resets = (r.resets?.sparse ?? 0) + (r.resets?.dense ?? 0) - before[c.id];
      out.streams.cards[c.name].afterRegen = { replayedFrames: r.replayedFrames, resets };
      check(r.replayedFrames === 0, `${c.name}: replayedFrames is still 0 after the middle three segments were invalidated and produced again (page reloaded ${resets} times)`, r.replayedFrames);
    }
    // Same segment: direct generation without replay vs generation with replay from mount frame,
    // comparing PNGs frame by frame
    const bakery = await pipeline.leaseStreamBakery();
    try {
      for (const c of CLIPS) {
        const state = stateOf(c.id);
        const { spec, manifest } = state;
        const rect = manifest.tight ?? manifest.bound;
        const clip = { x: rect.x + spec.offset.x, y: rect.y + spec.offset.y, w: rect.w, h: rect.h };
        const shoot = async (segment, replay) => {
          const fromFrame = segment * SEGMENT_FRAMES, toFrame = Math.min(fromFrame + SEGMENT_FRAMES - 1, spec.total - 1, spec.lastFrame);
          await bakery.reset(state.isolated, pipeline.emptyUrl(state.isolated), { deferCards: true });
          bakery.streamLease = null;
          const pngs = [];
          const stats = await bakeStream(bakery, { streamSignature: `${spec.streamKey}:${replay ? 'replay' : 'direct'}:${segment}`, fromFrame, toFrame, stride: 1, fps: spec.fps,
            ...(replay ? { mountFrame: spec.mountFrame } : { warm: 0 }), clip, hasMedia: false, onFrame: async (_f, png) => { pngs.push(png); } });
          bakery.streamLease = null;
          return { pngs, stats };
        };
        const span = spec.lastSegment - spec.firstSegment;
        const segments = [...new Set([spec.firstSegment + 1, spec.firstSegment + Math.floor(span / 2), spec.firstSegment + Math.floor(span * 0.6), spec.lastSegment - 1])].filter((n) => n > spec.firstSegment && n <= spec.lastSegment);
        for (const segment of segments) {
          const direct = await shoot(segment, false), replay = await shoot(segment, true);
          const diffs = direct.pngs.map((png, i) => (replay.pngs[i] ? diffPixels(png, replay.pngs[i]) : -1));
          const ink = replay.pngs.map(inkPixels);
          const rec = { clip: c.name, segment, frames: direct.pngs.length, replayedDirect: direct.stats.replayed, replayedReplay: replay.stats.replayed, diffPixelsMax: Math.max(...diffs), differFrames: diffs.filter((d) => d !== 0).length, inkMax: Math.max(...ink) };
          out.streams.compare.push(rec);
          check(direct.pngs.length === replay.pngs.length && direct.pngs.length > 0, `${c.name}#${segment}: both paths have the same frame count`, [direct.pngs.length, replay.pngs.length]);
          check(rec.replayedDirect === 0 && rec.replayedReplay > 0, `${c.name}#${segment}: one path did not replay and the other did`, rec);
          check(rec.inkMax > 0, `${c.name}#${segment}: the image is not empty`);
          check(rec.diffPixelsMax === 0, `${c.name}#${segment}: producing directly without replay and producing with replay from the mount frame are identical frame by frame, pixel by pixel`, diffs);
          if (segment === segments[Math.min(1, segments.length - 1)]) await fs.writeFile(path.join(OUT, `stream-${c.name}-seg${segment}-direct.png`), direct.pngs[Math.min(7, direct.pngs.length - 1)]);
        }
      }
    } finally { pipeline.returnStreamBakery(bakery); }
    const final = producer.status();
    check(CLIPS.every((c) => rowOf(final, c.id).replayedFrames === 0), 'Final check: replayedFrames is 0 on all four streams');
    say(`Stream production: ${final.streams.length} streams finished in ${produceSeconds} s; ${CLIPS.map((c) => { const r = out.streams.cards[c.name]; return `${c.name} ${r.frameMode}/${r.tier}/replay=${r.replay}/replayedFrames=${r.afterRegen?.replayedFrames}/layers=${r.layerKinds.join('+')}`; }).join(';')}; compared no-replay with replay frame by frame over ${out.streams.compare.length} segments, ${out.streams.compare.filter((r) => r.diffPixelsMax !== 0).length} segments differ`);
  }
} catch (error) {
  fails.push(`Probe itself failed: ${String(error?.stack || error).slice(0, 900)}`);
  say(`FAIL ${fails[fails.length - 1]}`);
} finally {
  try { await pipeline?.close(); } catch { /* ignore */ }
  try { await browser?.close(); } catch { /* ignore */ }
  try { await editor?.stop(); } catch { /* ignore */ }
  try { fsSync.rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* ignore */ }
}
out.seconds = +((Date.now() - started) / 1000).toFixed(1);
out.fails = fails;
out.ok = fails.length === 0;
try { await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ok: out.ok, fails, seconds: out.seconds }));
process.exit(out.ok ? 0 : 1);

/**
 * "When only pushing frames without taking screenshots, mid-mounted motion-style cards do not
 * advance on screen": whether each export and frame extraction path hits (`push-draw` in file
 * header of `server/bakery/bake.mjs`).
 *
 *   node scripts/probes/push-draw-probe.mjs (--origin http://127.0.0.1:<dev server> | --port 27140)
 *        [--variants glass,user,plain,alone] [--paths range,targets,see,layout,stream,shards] [--legacy]
 *        [--cost] [--out <dir>] [--json <file>] [--keep]
 *
 * Project (960×540, 30 fps, 5s): one `punch-pill` enters at 1s; another earlier-mounted card to
 * replay (`rank-bars`, enters at 0.2s, at the very bottom); at 3s a second pill enters: there is a
 * stretch of static frames before it (no push-draw for static frames, see `pushDrawNeeded` in
 * `bake.mjs`), verifying that "cards mounted after a static stretch" are also correct. Four tiers:
 *   glass  A frosted-glass card (odometer `odometer`, enters at 0.2s) overlays the pill
 *   user   A framework user card overlays the pill (remotion-style, created by probe via real
 *          `/api/cards/create`; only run when probe starts own dev server or with `--with-user`: it
 *          writes a card into that dev server's data directory)
 *   plain  Nothing overlays the pill (earlier-mounted card is below it)
 *   alone  Only the first pill card (control: no earlier-mounted card on page)
 *
 * Reference: full-segment export capturing every frame from frame 0 for same project (`bakeFrames`,
 * `frames: 0-149`).
 *
 * Check each "push through without capturing screenshot" path in product one by one, giving a
 * conclusion for each: diff between fetched frame and reference same frame (average absolute diff
 * across 4 RGBA channels, out of 255), which reference frame it is closest to (frames behind):
 *   range    Export single range: `exportUnified({ frames: '51-70' })`, `'100-104'` (pushes from
 *            frame 0, captures only this range)
 *   targets  Export selected frames only: `exportUnified({ targetFrames: [51, 52, 80, 100, 101] })`
 *   see      Frame extraction: `FramePipeline.see_frames` (Agent's see_frames; get_gif uses same
 *            path, just with a few more timestamps)
 *   layout   `FramePipeline.layout` (Agent's get_layout): pill entity box, compared against box at
 *            same timestamp in pill-only project
 *   stream   Stream frame-push (`bakeStream`, 2 cards on one page = group stream page shape; alone
 *            tier is single-card stream shape): segments replayed from mount frame after broken
 *            lease, and sparse pass (captures only first frame of each segment), each compared
 *            frame-by-frame against full density produced continuously holding lease
 *   shards   Parallel export (another project, 6s, cards connected sequentially): every frame of
 *            `exportUnified({ workers: 3 })` compared against full-segment export
 *
 * Windowed frame capture (targets / see / layout): after fixing dispatch in FrameScene by
 * clipFrameMode between direct evaluation and time cards, windowed frame capture no longer mounts
 * 1 frame early; fetched frame f is pixel-identical to reference frame f (ahead = 0).
 *
 * `--legacy`: disable push-draw (`PROMPTCUT_PUSH_DRAW=0`) and run same suite to reproduce pre-fix
 * behavior; here probe checks that "all paths that should hit do hit, and control tier does not".
 * `--cost`: separately measure overhead (960×540 and 1920×1080): extra milliseconds spent per frame
 * pushed, and total duration change of parallel export. Durations are recorded only.
 *
 * Output JSON conclusions, write progress to stderr; exit non-zero on unexpected results.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { flagArg } from './probe-connect.mjs';
import { startDevServer, sleep, round2 } from './below-stream-common.mjs';

const args = process.argv.slice(2);
const ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '0', args));
const KEEP = args.includes('--keep');
const LEGACY = args.includes('--legacy');
const COST = args.includes('--cost');
const WITH_USER = args.includes('--with-user');
const JSON_OUT = flagArg('json', null, args);
if (!ORIGIN && !PORT) { console.error('Pass --origin <dev server> or --port <start your own>'); process.exit(2); }
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-push-draw-${Date.now().toString(36)}`));
// Must be set before importing bake.mjs (it reads on each call; setting early here is for clarity)
if (LEGACY) process.env.PROMPTCUT_PUSH_DRAW = '0'; else delete process.env.PROMPTCUT_PUSH_DRAW;
process.env.PROMPTCUT_EXPORT_DIR = path.join(OUT, 'export');

const { FramePipeline } = await import('../../server/frame-pipeline.mjs');
const { openBakery } = await import('../../server/bakery/chrome.mjs');
const { bakeFrames, bakeStream } = await import('../../server/bakery/bake.mjs');
const { exportUnified } = await import('../../server/bakery/export-unified.mjs');
const { decodePngRgba } = await import('../../server/bakery/capture-canvas.mjs');
const { mountFrameOf } = await import('../../src/render/frameWindow.mjs');

const W = 960, H = 540, FPS = 30, SECONDS = 5, N = SECONDS * FPS;
const RUN = Date.now().toString(36);
const USER_CARD = `pd-cover-${RUN}`;
const ownServer = !ORIGIN;
const VARIANTS = String(flagArg('variants', ownServer || WITH_USER ? 'glass,user,plain,alone' : 'glass,plain,alone', args)).split(',').filter(Boolean);
const PATHS = new Set(String(flagArg('paths', 'range,targets,see,layout,stream,shards', args)).split(',').filter(Boolean));
/** Frames to capture: pill enters at frame 30; at frame 51 entrance animation is midway (spring has not settled, glow still dispersing) */
const RANGES = [[51, 70], [100, 104]];
const TARGETS = [51, 52, 80, 100, 101];
const SEE = [35, 51, 80, 100];
/** Frame queried for entity box (not in `SEE`; pill's glow is still expanding, box changes frame by frame) */
const LAYOUT_FRAME = 57;
/** Considered identical within this diff (0 for byte-identical on same path; margin for see_frames re-encoding) */
const TOL = 0.05;

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 700))); say('FAIL', { label, extra }); } return !!cond; };
const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

const scaleOf = (w) => w / 1920;
const pillClip = (w = W) => ({ id: 'clip-p', kind: 'card', cardId: 'punch-pill', start: 1, end: SECONDS, params: { text: '对照卡' },
  frame: { x: Math.round(w / 3), y: Math.round(w * 150 / 960), w: 560, h: 200, anchor: [0.5, 0.5], scale: w / 960 } });
const fullFrame = (w) => ({ frame: { x: 0, y: 0, w: 1920, h: 1080, anchor: [0, 0], scale: scaleOf(w) } });
const secondPill = (w = W) => ({ ...pillClip(w), id: 'clip-q', start: 3, params: { text: '第二枚' }, frame: { ...pillClip(w).frame, x: Math.round(w * 0.7), y: Math.round(w * 400 / 960) } });
const earlyClip = (w = W) => ({ id: 'clip-e', kind: 'card', cardId: 'rank-bars', start: 0.2, end: SECONDS, params: {}, ...fullFrame(w) });
const glassClip = (w = W) => ({ id: 'clip-t', kind: 'card', cardId: 'odometer', start: 0.2, end: SECONDS, params: { position: 'left', value: 86420, label: 'x' }, ...fullFrame(w) });
const userClip = (w = W) => ({ id: 'clip-u', kind: 'card', cardId: USER_CARD, start: 0.2, end: SECONDS, params: { label: '框架卡' }, ...fullFrame(w) });
const track = (id, clips) => ({ id, name: id, hidden: false, clips });
const base = (id, w, h, seconds, tracks) => ({ id: `${id}-${RUN}`, name: `Push-draw probe ${id}`, width: w, height: h, fps: FPS, duration: seconds,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {}, tracks });
/** The first track is at the very top */
function variantProject(variant, w = W, h = H) {
  const tracks = variant === 'glass' ? [track('tr-t', [glassClip(w)]), track('tr-q', [secondPill(w)]), track('tr-p', [pillClip(w)]), track('tr-e', [earlyClip(w)])]
    : variant === 'user' ? [track('tr-u', [userClip(w)]), track('tr-q', [secondPill(w)]), track('tr-p', [pillClip(w)]), track('tr-e', [earlyClip(w)])]
      : variant === 'plain' ? [track('tr-q', [secondPill(w)]), track('tr-p', [pillClip(w)]), track('tr-e', [earlyClip(w)])]
        : [track('tr-p', [pillClip(w)])];
  return base(`pd-${variant}-${w}`, w, h, SECONDS, tracks);
}
/** Project for parallel export (6s): cards connect back-to-back, leaving splittable gaps; cards after split point mount after it */
function shardProject(w = W, h = H) {
  const pill = (id, text, start, end) => ({ ...pillClip(w), id, start, end, params: { text } });
  return base(`pd-shards-${w}`, w, h, 6, [
    track('tr-a', [pill('clip-a1', '第一枚', 0.2, 1.9), pill('clip-a2', '第二枚', 2.1, 3.9), pill('clip-a3', '第三枚', 4.1, 6)]),
    track('tr-b', [{ ...earlyClip(w), id: 'clip-b1', start: 0.3, end: 1.9 }, { ...glassClip(w), id: 'clip-b2', start: 2.2, end: 3.9 }, { ...earlyClip(w), id: 'clip-b3', start: 4.2, end: 6 }]),
    track('tr-c', [{ id: 'clip-c1', kind: 'card', cardId: 'particles', start: 0, end: 1.9, params: { quantity: 80, speed: 1.5, size: 4, links: 'yes', seed: 3 } },
      { id: 'clip-c3', kind: 'card', cardId: 'particles', start: 4.1, end: 6, params: { quantity: 80, speed: 1.5, size: 4, links: 'yes', seed: 5 } }]),
  ]);
}

const USER_SOURCE = `import type { CardDef, CardProps } from "../../kernel/types";
import { interpolate, tween } from "../../kernel/remotionStyle";

interface Params { label: string }

function PdCover({ params, t = 0 }: CardProps<Params>) {
  const x = interpolate(t, [0, 3], [0, 900]);
  return (
    <div style={{ position: "absolute", inset: 0, fontFamily: "sans-serif" }}>
      <div style={{ position: "absolute", inset: 0, background: "rgba(40, 90, 200, 0.25)", opacity: tween(t, { duration: 0.4 }) }} />
      <div style={{ position: "absolute", left: 120 + x, top: 90, width: 220, height: 36, borderRadius: 18, background: "#ffd166" }} />
      <div style={{ position: "absolute", left: 120, bottom: 90, fontSize: 72, color: "#ffffff" }}>{params.label}</div>
    </div>
  );
}

export const pdCover: CardDef<Params> = {
  id: "${USER_CARD}",
  name: "Push-draw probe: overlaid framework card",
  description: "Remotion-style DOM card for the probe: one translucent layer covers the whole frame while a bar moves right at constant speed",
  source: "user",
  useWhen: "For probes only, not for real projects.",
  tags: ["probe"],
  frameMode: "direct",
  defaults: { label: "Framework card" },
  controls: [{ key: "label", label: "Text", type: "text" }],
  Component: PdCover,
  lifecycle: { settleMs: 400, after: "hold", exit: ["fade"] },
};
`;

const diff = (a, b) => { if (!a || !b || a.length !== b.length) return Infinity; let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
const rgba = (buf) => decodePngRgba(Buffer.from(buf)).data;

const out = { out: OUT, legacy: LEGACY, pushDraw: LEGACY ? 'off (reproduces pre-fix behavior)' : 'on', variants: {}, };
await fs.mkdir(path.join(OUT, 'export'), { recursive: true });
await fs.mkdir(path.join(OUT, 'shots'), { recursive: true });
let dev = null, bakery = null, pipeline = null;
const started = Date.now();
try {
  let origin = ORIGIN;
  if (!origin) {
    dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'pushdraw' });
    origin = dev.origin;
    say('spawn', { pid: dev.pid, port: PORT });
  }
  origin = origin.replace(/\/+$/, '');
  out.origin = origin;
  const emptyUrl = (w = W, h = H) => `${origin}/?export=1&timeline=${encodeURIComponent(`data:application/json,${encodeURIComponent(JSON.stringify({ width: w, height: h, fps: FPS, duration: 1, tracks: [], media: [] }))}`)}`;
  const exportUrl = (project) => `${origin}/?export=1&timeline=${encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(project)))}`;

  if (VARIANTS.includes('user')) {
    const r = await fetch(`${origin}/api/cards/create`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ id: USER_CARD, source: USER_SOURCE, projectId: variantProject('user').id }) });
    const body = await r.json().catch(() => null);
    out.userCard = { id: USER_CARD, status: r.status, ok: body?.ok === true, errors: r.status === 200 ? undefined : (body?.errors ?? [body?.error]) };
    say('user-card', out.userCard);
    if (!check(r.status === 200 && body?.ok === true, 'Creating a user card (/api/cards/create) returns 200', out.userCard)) VARIANTS.splice(VARIANTS.indexOf('user'), 1);
    else await sleep(1500); // Dev server compiles this card's module
  }

  bakery = await quiet(() => openBakery({ url: emptyUrl() }));
  /** Run a pass of `bakeFrames` on shared page, returning frame number → RGBA */
  const bake = async (project, opts) => {
    await bakery.reset(project, emptyUrl(project.width, project.height));
    bakery.streamLease = null;
    const frames = new Map();
    const pngs = new Map();
    const t0 = Date.now();
    const result = await quiet(() => bakeFrames(bakery, { out: path.join(OUT, 'scratch'), fps: FPS, fullFrame: true, format: 'png', warm: 3, staticSkip: false, quiet: true, writeFrames: false, ...opts,
      onFrame: async (i, buf) => { if (opts.timingOnly) return; frames.set(i, rgba(buf)); if (opts.keepFrames?.includes(i)) pngs.set(i, Buffer.from(buf)); } }));
    return { frames, pngs, ms: Date.now() - t0, result };
  };
  /** Each fetched frame: diff against reference same frame, which reference frame it is closest to */
  const judge = (got, ref) => [...got].sort((a, b) => a[0] - b[0]).map(([f, picture]) => {
    const same = diff(picture, ref.get(f));
    let bestFrame = f, bestD = same;
    for (let g = Math.max(0, f - 40); g <= Math.min(ref.size - 1, f + 3); g++) { const d = diff(picture, ref.get(g)); if (d < bestD) { bestD = d; bestFrame = g; } }
    return { frame: f, sameFrameDiff: round2(same), bestFrame: bestFrame, bestFrameDiff: round2(bestD), framesBehind: f - bestFrame };
  });
  /** Whether a path hits: `ahead` is number of frames path naturally leads ahead by (1 for windowed frame capture, see file header) */
  const verdict = (rows, ahead = 0) => {
    const ok = rows.length > 0 && rows.every((r) => r.bestFrameDiff <= TOL && (r.framesBehind === 0 || r.framesBehind === -ahead));
    const worst = rows.reduce((a, b) => (Math.abs(b.framesBehind) > Math.abs(a.framesBehind) || (Math.abs(b.framesBehind) === Math.abs(a.framesBehind) && b.sameFrameDiff > a.sameFrameDiff) ? b : a), rows[0] ?? {});
    return { hit: !ok, worstFrame: worst, frames: rows };
  };
  /** Whether it should hit: none hit after fix; under `--legacy`, 3 tiers with earlier-mounted cards should hit, pill control does not */
  const expectHit = (variant) => LEGACY && variant !== 'alone';
  const settle = (variant, name, v, note) => {
    const want = expectHit(variant);
    say('path', { variant, path: name, hit: v.hit, shouldHit: want, worstFrame: v.worstFrame });
    check(v.hit === want, `${variant} / ${name}:${want ? 'should be hit when push-draw is off' : 'should not be hit'}`, { worstFrame: v.worstFrame, note });
    return { ...v, shouldHit: want };
  };

  pipeline = new FramePipeline({ root: path.join(OUT, 'lib'), origin: () => origin });
  let aloneLayout = null;
  const layoutOf = async (project) => {
    // Querying a frame `see_frames` hasn't fetched: for fetched frames `layout` uses recorded snapshot (windowed, mounted 1 frame early; frame store keys by project content, changing project id won't work); here force it to push once
    const got = await quiet(() => pipeline.layout(project, { t: LAYOUT_FRAME / FPS, clipIds: ['clip-p'] }));
    return got?.clips?.['clip-p']?.contentBox ?? null;
  };

  for (const variant of VARIANTS) {
    const project = variantProject(variant);
    const row = out.variants[variant] = { project: project.id, cards: project.tracks.map((t) => t.clips.map((c) => `${c.cardId}@${c.start}s`).join('+')).join(' / ') };
    const reference = await bake(project, { frames: `0-${N - 1}`, keepFrames: [35, 51] });
    const ref = reference.frames;
    say('reference', { variant, frames: ref.size });
    // For visual inspection: reference frames 35 and 51, and same frames fetched by 2 paths below (save extra copy for `--legacy`)
    const shot = (name, buf) => fs.writeFile(path.join(OUT, 'shots', `${variant}-${name}${LEGACY ? '-legacy' : ''}.png`), buf);
    if (variant !== 'alone') for (const [f, buf] of reference.pngs) await shot(`ref-f${f}`, buf);
    if (variant === VARIANTS[0]) {
      // Whether reference itself is reliable: export again, frame-by-frame identical (legacy issue with first few dozen frames only seen on demo projects; noted here in passing)
      const again = (await bake(project, { frames: `0-${N - 1}` })).frames;
      row.refTwoExportsDiffFrames = [...ref].filter(([f, a]) => diff(a, again.get(f)) > 0).map(([f]) => f);
      check(row.refTwoExportsDiffFrames.length === 0, `${variant}: two exports of the reference are identical frame by frame`, row.refTwoExportsDiffFrames.slice(0, 20));
    }

    if (PATHS.has('range')) {
      const got = new Map();
      const pushes = [];
      for (const [a, b] of RANGES) {
        const result = await quiet(() => exportUnified(project, { url: exportUrl(project), out: path.join(OUT, 'scratch', `range-${variant}-${a}`), frames: `${a}-${b}`, workers: 1, noVideo: true, writeFrames: false,
          onFrame: async (i, buf) => { got.set(i, rgba(buf)); if (i === 51 && variant !== 'alone') await shot('range-f51', Buffer.from(buf)); } }));
        pushes.push({ segment: `${a}-${b}`, framesPushed: a, redrawnTicks: result.pushDrawn ?? null });
      }
      row.exportOneSegment = { ...settle(variant, 'range: export one segment only', verdict(judge(got, ref))), framePush: pushes };
      row.exportOneSegment.frames = row.exportOneSegment.frames.filter((r, k) => k < 3 || r.sameFrameDiff > TOL).slice(0, 6);
      // Static frames not push-drawn: push-draw ticks fewer than pushed frames (in pill-only tier, entire frame empty before pill enters)
      if (!LEGACY) check(pushes.every((x) => x.redrawnTicks > 0 && x.redrawnTicks < x.framesPushed + 2), `${variant}: static frames are not redrawn when only one segment is exported`, pushes);
      else check(pushes.every((x) => x.redrawnTicks === 0), `${variant}: no tick is redrawn when it is off`, pushes);
    }
    if (PATHS.has('targets')) {
      const got = new Map();
      await quiet(() => exportUnified(project, { url: exportUrl(project), out: path.join(OUT, 'scratch', `targets-${variant}`), targetFrames: TARGETS, noVideo: true, writeFrames: false,
        onFrame: async (i, buf) => { got.set(i, rgba(buf)); } }));
      row.fewFramesExport = settle(variant, 'targets: export only a few frames', verdict(judge(got, ref), 0));
    }
    if (PATHS.has('see')) {
      const frames = await quiet(() => pipeline.see_frames(project, SEE.map((f) => f / FPS), { lane: 'agent' }));
      const got = new Map([...frames].map(([f, value]) => [f, rgba(value.buf)]));
      row.frameSampling = settle(variant, 'see_frames frame sampling', verdict(judge(got, ref), 0), { sources: [...frames].map(([f, v]) => `${f}:${v.source}`) });
      if (variant !== 'alone') await shot('see-f35', frames.get(35).buf);
    }
    if (PATHS.has('layout')) {
      // Pill entity box depends only on pill itself: compared against box at same timestamp (same windowed frame capture path) in pill-only project
      aloneLayout ??= await layoutOf(variantProject('alone'));
      const box = variant === 'alone' ? aloneLayout : await layoutOf(project);
      const same = JSON.stringify(box) === JSON.stringify(aloneLayout);
      const want = expectHit(variant);
      row.get_layout = { pillEntityBox: box, pillOnlyLayout: aloneLayout, hit: !same, shouldHit: want };
      say('path', { variant, path: 'layout', ...row.get_layout });
      check(box && !same === want, `${variant} / get_layout:${want ? 'should be hit when push-draw is off' : 'should not be hit'}`, row.get_layout);
    }
    if (PATHS.has('stream') && (variant === 'plain' || variant === 'alone')) {
      // Stream frame-push: cards on this page are members of this stream (plain = group stream page with 2 cards, alone = single-card stream page); do not crop rectangle
      const mountFrame = Math.min(...project.tracks.flatMap((t) => t.clips.map((c) => mountFrameOf(c, FPS))));
      const first = Math.min(...project.tracks.flatMap((t) => t.clips.map((c) => Math.ceil(c.start * FPS - 1e-9))));
      const stream = async (calls) => {
        await bakery.reset(project, emptyUrl(), { deferCards: true });
        bakery.streamLease = null;
        const frames = new Map();
        const stats = [];
        for (const call of calls) stats.push(await quiet(() => bakeStream(bakery, { streamSignature: `pd-${variant}`, fps: FPS, mountFrame, ...call, onFrame: async (f, png) => { frames.set(f, rgba(png)); } })));
        return { frames, stats };
      };
      const dense = await stream([{ fromFrame: first, toFrame: N - 1, stride: 1 }]);
      const replay = await stream([{ fromFrame: first + 60, toFrame: first + 74, stride: 1 }]);
      // Replay later segment: second pill mounts only after a static period; this segment is right inside its entrance animation
      const replayLate = await stream([{ fromFrame: first + 90, toFrame: first + 104, stride: 1 }]);
      const segments = [];
      for (let a = first; a < N; a += 15) segments.push({ fromFrame: a, toFrame: Math.min(N - 1, a + 14), stride: 15 });
      const sparse = await stream(segments);
      const page = variant === 'plain' ? 'page with two cards' : 'page with only the pill';
      const a = verdict(judge(new Map([...replay.frames, ...replayLate.frames]), dense.frames));
      const b = verdict(judge(sparse.frames, dense.frames));
      a.frames = a.frames.filter((r, k) => k < 2 || r.sameFrameDiff > TOL).slice(0, 5);
      b.frames = b.frames.filter((r, k) => k < 2 || r.sameFrameDiff > TOL).slice(0, 8);
      row.streamBrokenLeaseReplaySegments = { ...settle(variant, `stream replay segments (${page})`, a), framesReplayed: [replay.stats[0].replayed, replayLate.stats[0].replayed], redrawnTicks: [replay.stats[0].pushDrawn, replayLate.stats[0].pushDrawn] };
      row.streamSparseRun = { ...settle(variant, `stream sparse run (${page})`, b), segmentCount: segments.length, redrawnTicks: sparse.stats.reduce((s, x) => s + x.pushDrawn, 0),
        redrawTotalMs: sparse.stats.reduce((s, x) => s + x.pushDrawMs, 0), framePushTotalMs: sparse.stats.reduce((s, x) => s + x.stepMs, 0) };
    }
  }

  if (PATHS.has('shards')) {
    const project = shardProject();
    const total = 6 * FPS;
    const ref = (await bake(project, { frames: `0-${total - 1}` })).frames;
    const got = new Map();
    const lines = [];
    const log = console.log;
    console.log = (...a) => { const s = a.join(' '); if (s.startsWith('Split export')) lines.push(s); };
    let result;
    try {
      result = await exportUnified(project, { url: exportUrl(project), out: path.join(OUT, 'scratch', 'shards'), workers: 3, noVideo: true, writeFrames: false,
        onFrame: async (i, buf) => { got.set(i, rgba(buf)); } });
    } finally { console.log = log; }
    const rows = judge(got, ref);
    const bad = rows.filter((r) => r.sameFrameDiff > 0);
    out.parallelExport = { project: project.id, splitPlan: lines[0] ?? null, parts: result.parts?.map((p) => `${p.startFrame}-${p.endFrame}`), frameCount: rows.length, framesDiffFromWholeExport: bad.length, samples: bad.slice(0, 6), hit: bad.length > 0, shouldHit: false };
    say('shards', out.parallelExport);
    check(rows.length === total && (result.parts?.length ?? 0) > 1, 'Parallel export really splits into several parts', out.parallelExport);
    check(bad.length === 0, 'Every frame of the parallel export is pixel-identical to the whole-range export', out.parallelExport);
  }

  if (COST) {
    out.overhead = {};
    for (const [w, h] of [[960, 540], [1920, 1080]]) {
      const project = variantProject('plain', w, h);
      await quiet(async () => { await bakery.close(); bakery = await openBakery({ url: emptyUrl(w, h) }); });
      const timeOf = async (pushDraw) => {
        const runs = [];
        for (let k = 0; k < 3; k++) runs.push((await bake(project, { frames: `${N - 10}-${N - 1}`, pushDraw, timingOnly: true })).ms);
        return runs.sort((a, b) => a - b)[1];
      };
      const off = await timeOf(false), on = await timeOf(true);
      const pushed = N - 10;
      // Single tick: send 60 ticks each on the same static page
      await bakery.reset(project, emptyUrl(w, h));
      const beat = async (extra) => { const t0 = performance.now(); for (let k = 0; k < 60; k++) await bakery.beginFrame(extra); return (performance.now() - t0) / 60; };
      await beat({ screenshot: { format: 'jpeg', quality: 0 } });
      const plain = await beat(), jpeg0 = await beat({ screenshot: { format: 'jpeg', quality: 0 } }), png = await beat({ screenshot: { format: 'png', optimizeForSpeed: true } });
      // Total duration of parallel export
      const shards = shardProject(w, h);
      const whole = async (pushDraw, workers) => { const t0 = Date.now(); await quiet(() => exportUnified(shards, { url: exportUrl(shards), out: path.join(OUT, 'scratch', `cost-${w}-${pushDraw}-${workers}`), workers, noVideo: true, writeFrames: false, ...(pushDraw === undefined ? {} : { pushDraw }), onFrame: async () => {} })); return Date.now() - t0; };
      // Default: no push-draw from second shard onward (`export-unified.mjs`); "always push-draw" is control explicitly passing pushDraw: true (overhead if shards also push-draw)
      const single = await whole(undefined, 1), parOff = await whole(false, 3), parDefault = await whole(undefined, 3), parAll = await whole(true, 3);
      out.overhead[`${w}x${h}`] = { framesPushed: pushed, lastTenFramesExportOff: off, lastTenFramesExportOn: on, extraMsPerPushedFrame: round2((on - off) / pushed),
        msPerTick: { noScreenshot: round2(plain), discardedJPEG: round2(jpeg0), PNG: round2(png) },
        sixSecondProjectWholeExportMs: { singleProcess: single, threePartsOff: parOff, threePartsDefault: parDefault, threePartsRedrawEveryPart: parAll, redrawEveryPartExtraPercent: round2((parAll - parOff) / parOff * 100) } };
      say('cost', { size: `${w}x${h}`, ...out.overhead[`${w}x${h}`] });
    }
  }
} catch (error) {
  fails.push(`Exception: ${error?.stack || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  try { await pipeline?.close(); } catch { /* ignore */ }
  try { await bakery?.close(); } catch { /* ignore */ }
  try { await dev?.stop(); } catch { /* ignore */ }
  if (!KEEP) { try { for (const name of await fs.readdir(OUT)) if (!/\.json$/.test(name) && name !== 'shots') await fs.rm(path.join(OUT, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ } }
}
out.elapsedMs = Date.now() - started;
out.fails = fails;
out.ok = fails.length === 0;
try { await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log(out.ok ? 'PASS' : `FAIL ${fails.length}`);
process.exit(out.ok ? 0 : 1);

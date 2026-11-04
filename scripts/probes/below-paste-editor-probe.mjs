/**
 * Below-dependent card pasting its track stream: end-to-end probe in the **real editor**
 * (part 3 of "Wu-2" in task brief `docs/plan/render-refactor-task.md`).
 * On the stage side, frame-by-frame pixel comparison, three scenes, and plane placement order
 * after swap are in `stream-below-stage-probe.mjs`; here verify whether the parent page
 * connects correctly: whether the layer sent by the real prerender process carries kind and
 * input signature, whether the signature calculated by the parent page based on its own project
 * matches (if not, this card will never paste the stream), whether stream planes and suppression
 * are sent during play / pause / scrub, whether the old stream is still pasted after the lower
 * layer is modified, and pasting again after re-producing.
 *
 *   node scripts/probes/below-paste-editor-probe.mjs --port 27000 [--out <dir>] [--json <file>] [--keep]
 *   node scripts/probes/below-paste-editor-probe.mjs --origin http://127.0.0.1:27000 …   # Connect to an already started dev server
 *   node scripts/probes/below-paste-editor-probe.mjs --port 27000 --settle-control        # Control: live render after a heavy card stops when not producing this stream
 *
 * `--settle-control` (only with `--port`): the self-started editor carries
 * `PROMPTCUT_TEST_BELOW_STREAMS=0` (simulating old behavior without this stream), only doing two
 * things: "reference for live render" and "clicking to the same frames after pinning as heavy
 * card, then taking screenshots after stopping", reporting how much both sides differ and which
 * frame on the export page each is most similar to, then finishing up. Used to distinguish
 * whether "live render after heavy card stops differs from light card" is caused by stream pasting.
 *
 * When `--port` is given, it starts an isolated editor itself (stage ports are +1 and +2, all
 * three consecutive numbers must be free; data directory, card overlay layer, and artifacts
 * directory are all under `--out`), cleaned up by PID after completion.
 *
 * Project (960×540, 30 fps): the upper track is a frosted-glass card (odometer `odometer`,
 * below-dependent in the review table), **entering at frame 6** (not a multiple of 15); the
 * lower track is a remotion-style user card (created via real `POST /api/cards/create`): on a
 * full solid background, a bright band sweeps from left to right behind the frosted-glass card.
 * This lower card is a light card whose visuals are determined only by t, so in preview it is
 * always **live render** and accurate at any moment: when the frosted-glass card pastes the
 * stream, behind it is the actual lower layer on stage at that moment. The frosted-glass card is
 * pinned as a heavy card.
 *
 * Flow:
 *   0. Wait for the frosted-glass card's cost record, pin it as a heavy card, and wait for its
 *      below-dependent stream to reach full density across all segments. Check: that layer in the
 *      ready index carries `streamKind: "below"` and input signature; the parent page did not
 *      classify it as expired (the signature calculated by the prerender process based on its
 *      accepted project matches the one calculated by the page from the project in the store).
 *      Start another rendering browser to export the same project frame by frame as reference.
 *   1. **Click the timeline to jump across** (paused, with "stop"): sampled by animation frames
 *      throughout, this card has no moment where "the live subtree is hidden while the stream has
 *      no visuals", with no placeholders and no snapshots; after stopping, returns to live
 *      render (not suppressed, live subtree exposed), stream plane hidden, and this frame is
 *      already decoded.
 *   2. **Hold ruler and scrub** (real pointer events): at every point this card is suppressed,
 *      live subtree hidden, the stream plane under the stage root exposed, and the player draws
 *      this frame (full density, `kind: below`); the stream plane sent by the parent page
 *      carries `plane: "stage"`, without selecting snapshots; **the screenshot is most similar to
 *      the same frame on the export page** (more similar than to the previous frame or next
 *      frame): at this time, behind the frosted glass is the live render lower layer, and frosted
 *      glass itself is a stream.
 *   3. **Start playback while paused, pause during playback**: in per-tick records, every tick of
 *      this card shows visuals of the full density stream; after stopping, returns to exact live
 *      render.
 *   4. **Change one place in lower layer** (holding ruler without releasing, change one parameter
 *      of the card below): the parent page recognizes the old stream as expired on the spot, no
 *      longer sending its stream plane (the old stream's track on stage is closed accordingly),
 *      after which the old key is never pasted back; after prerender process re-produces and the
 *      new key arrives, the parent page re-sends the stream plane, and the stage pastes the new
 *      stream: the screenshot is most similar to the same frame on the export page of the
 *      **modified** project, and more similar than when compared with the export page before
 *      modification.
 *
 * **Reference for live render** (done first in step 0, when this card is still a light card and
 * stream is not yet produced): click while paused to each of the frames to be used in step 1,
 * capturing one screenshot each. Compared with the visuals obtained in step 1 "paste stream and
 * then stop", **record only**: returning to live render after a heavy card stops takes a different
 * path (subtree virtual-time frame catch-up), and on frames where the entrance animation has not
 * finished playing, the results of the two paths will differ by one frame: the same is true in
 * `--settle-control` (not producing this stream) after pinning as heavy card, so this is not
 * caused by stream pasting and is not judged here.
 *
 * Acceptance check: exit code 0, `fails: []` in results. Elapsed time is only recorded. Wait
 * timeouts are only to prevent hangs.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { flagArg } from './probe-connect.mjs';
import { openBakery } from '../../server/bakery/chrome.mjs';
import { bakeFrames } from '../../server/bakery/bake.mjs';
import { startDevServer, emptyUrlOf, sleep, round2 } from './below-stream-common.mjs';

const args = process.argv.slice(2);
const GIVEN_ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '0', args));
const KEEP = args.includes('--keep');
const SETTLE_CONTROL = args.includes('--settle-control');
const JSON_OUT = flagArg('json', null, args);
const RUN = Date.now().toString(36);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-below-paste-editor-${RUN}`));
if (!GIVEN_ORIGIN && !PORT) { console.error('Pass --origin <dev server> or --port <start your own>'); process.exit(2); }
if (SETTLE_CONTROL && GIVEN_ORIGIN) { console.error('--settle-control requires starting your own editor (pass --port)'); process.exit(2); }
// Control tier: this editor and its prerender process do not produce below-dependent streams
if (SETTLE_CONTROL) process.env.PROMPTCUT_TEST_BELOW_STREAMS = '0';

const FPS = 30, SEG = 15, WIDTH = 960, HEIGHT = 540, SECONDS = 3.4;
const GLASS = 'clip-glass', MOVER = 'clip-mover';
/** Frosted-glass card: entrance at 0.2s (frame 6), exit at 3.0s (last frame is frame 89) */
const FIRST = 6, LAST = 89;
const MOVER_CARD = `bp-mover-${RUN}`;
const CLICKS = [57, 20, 83, 41];
/**
 * Frames scrubbed to in sequence: the first is the pressed position. Includes moving backward,
 * crossing segments, moving only two frames, the first frame of its segment (6 + 3 × 15 = 51),
 * and the last frame of the previous segment
 */
const STEPS = [33, 48, 24, 70, 72, 51, 50, 86, 11];
/**
 * Which frame the step modifying the lower layer stops on (at this frame, the bright band below
 * is in the visible half behind the frosted glass)
 */
const EDIT_AT = 28;

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const notes = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 900))); say('FAIL', { label, extra }); } return !!cond; };
const frameOf = (t) => Math.round(t * FPS);
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

/**
 * The card below: remotion-style (visuals determined only by t), referencing the framework. Solid
 * background, a bright band sweeping from left to right, with a line of text following along
 */
const MOVER_SOURCE = `import type { CardDef, CardProps } from "../../kernel/types";
import { interpolate } from "../../kernel/remotionStyle";

interface Params { accent: string; label: string }

function BpMover({ params, t = 0 }: CardProps<Params>) {
  const x = interpolate(t, [0, 3.4], [-60, 620]);
  const y = interpolate(t, [0, 3.4], [120, 330]);
  return (
    <div style={{ position: "absolute", inset: 0, background: "linear-gradient(135deg, #16213e 0%, #0f3460 55%, #1a1a2e 100%)", fontFamily: "sans-serif", overflow: "hidden" }}>
      <div style={{ position: "absolute", left: x, top: 0, width: 90, height: "100%", background: params.accent }} />
      <div style={{ position: "absolute", left: 0, top: y, width: "100%", height: 26, background: "rgba(255,255,255,0.75)" }} />
      <div style={{ position: "absolute", left: x + 110, top: 60, color: params.accent, fontSize: 34, fontWeight: 800 }}>{params.label}</div>
    </div>
  );
}

export const bpMover: CardDef<Params> = {
  id: "${MOVER_CARD}",
  name: "Stream-paste probe: sweeping bright band",
  description: "Probe-only remotion-style DOM card: a bright band sweeps from left to right over a full-bleed background color",
  source: "user",
  useWhen: "For probes only, not for real projects.",
  tags: ["probe"],
  frameMode: "direct",
  defaults: { accent: "#ffd166", label: "Below" },
  controls: [
    { key: "accent", label: "Primary color", type: "color" },
    { key: "label", label: "Text", type: "text" },
  ],
  Component: BpMover,
  lifecycle: { settleMs: 500, after: "hold", exit: ["fade"] },
};
`;

const PROJECT = {
  id: `below-paste-${RUN}`, name: 'Stream paste for a card that depends on the layer below', width: WIDTH, height: HEIGHT, fps: FPS, duration: SECONDS,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [
    { id: 'tr-glass', name: 'glass', hidden: false, clips: [
      { id: GLASS, kind: 'card', cardId: 'odometer', start: 0.2, end: 3.0, params: { position: 'left', value: 86420, label: '贴流探针' },
        frame: { x: 0, y: 0, w: 1920, h: 1080, anchor: [0, 0], scale: WIDTH / 1920 } },
    ] },
    { id: 'tr-mover', name: 'mover', hidden: false, clips: [
      { id: MOVER, kind: 'card', cardId: MOVER_CARD, start: 0, end: SECONDS, params: { accent: '#ffd166', label: '下层' } },
    ] },
  ],
};

/* ---------------------------------------------------------------- Pixels */

/**
 * One RGBA frame → RGB of specified size (each target pixel takes the average of the area it
 * covers). The reference frame is fully opaque (the card below covers the entire background)
 */
function resized(png, width, height) {
  const out = new Float32Array(width * height * 3);
  const sx = png.width / width, sy = png.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < png.height; yy++) {
        for (let xx = x0; xx < x1 && xx < png.width; xx++) { const i = (yy * png.width + xx) * 4; r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; n++; }
      }
      const o = (y * width + x) * 3;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }
  return { width, height, data: out };
}
/**
 * Average difference between two RGB frames (same size) in a rectangle (out of 255).
 * Rectangle given proportionally (0-1)
 */
function rectMean(a, b, rect) {
  const x0 = Math.floor(rect.x * a.width), x1 = Math.ceil((rect.x + rect.w) * a.width), y0 = Math.floor(rect.y * a.height), y1 = Math.ceil((rect.y + rect.h) * a.height);
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * a.width + x) * 3; sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]); n += 3; }
  return n ? sum / n : Infinity;
}

const out = { out: OUT, clip: { first: FIRST, last: LAST }, clicks: CLICKS, steps: STEPS };
await fs.mkdir(OUT, { recursive: true });
let dev = null, bakery = null, browser = null;
const started = Date.now();
try {
  let origin = GIVEN_ORIGIN;
  if (!origin) {
    process.env.PROMPTCUT_EXPORT_DIR = path.join(OUT, 'export');
    await fs.mkdir(process.env.PROMPTCUT_EXPORT_DIR, { recursive: true });
    dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'belowe2e' });
    origin = dev.origin;
    say('spawn', { pid: dev.pid, port: PORT });
  }
  origin = origin.replace(/\/+$/, '');
  out.origin = origin;

  // First create the user card below (before the editor, stage, and export page load)
  {
    const r = await fetch(origin + '/api/cards/create', { method: 'POST', headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ id: MOVER_CARD, source: MOVER_SOURCE, projectId: PROJECT.id }), signal: AbortSignal.timeout(60_000) });
    const body = await r.json().catch(() => null);
    out.moverCard = { id: MOVER_CARD, status: r.status, ok: body?.ok ?? null, errors: r.status === 200 ? undefined : (body?.errors ?? [body?.error]).slice?.(0, 6) };
    if (!check(r.status === 200 && body?.ok === true, 'The user card underneath was created (POST /api/cards/create returned 200)', out.moverCard)) throw new Error('The user card was not created');
  }

  browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 2560, height: 1600 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
  await page.goto(origin + '/?editor&nosetup=1&preview=stage', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return !!m.frontStage() && m.backRole() === 'back';
  }, { timeout: 180000, polling: 500 });
  const ports = await (await fetch(origin + '/api/stage/ports')).json();
  const stagePorts = (ports.ports ?? []).slice(0, 2).map(String);
  const store = (fn, ...a) => page.evaluate(async (src, a2) => {
    const { actions, getState } = await import('/src/store/project.ts');
    // eslint-disable-next-line no-new-func
    return new Function('actions', 'getState', 'args', src)(actions, getState, a2);
  }, fn, a);
  const stageFrames = () => page.frames().filter((f) => /[?&]stage=1/.test(f.url()) && stagePorts.some((p) => f.url().includes(`:${p}/`)));
  const frontId = () => page.evaluate(() => window.__pcPreviewDiag?.().frontId ?? 'A');
  const frontFrame = async () => { const id = await frontId(); return stageFrames().find((f) => f.url().includes(`id=${id}`)) ?? null; };
  const parentDiag = () => page.evaluate(() => {
    const d = window.__pcPreviewDiag?.();
    return d ? { frontId: d.frontId, suppressed: d.suppressed, setTimeLog: d.setTimeLog, swapInFlight: d.swapInFlight,
      heavy: d.snapshotFeed?.heavy ?? [], scrub: d.snapshotFeed?.scrub ?? [], streams: d.snapshotFeed?.streams ?? [], staleBelow: d.snapshotFeed?.staleBelow ?? [],
      picks: (d.snapshotFeed?.picks ?? []).map((p) => p.clipId), mounted: (d.snapshotFeed?.mounted ?? []).map((p) => p.clipId) } : null;
  });
  const storeT = () => page.evaluate(async () => (await import('/src/store/project.ts')).getState().t);
  const storeProject = () => page.evaluate(async () => JSON.parse(JSON.stringify((await import('/src/store/project.ts')).getState().project)));

  /* ---------------------------------------------------------------- 0. Project, pin heavy card, wait for stream */
  const loaded = await store(`actions.loadProject(args[0]); actions.select([]); actions.pause(); actions.seek(0); return getState().project.tracks.map(t => t.clips.map(c => c.id))`, PROJECT);
  out.loaded = loaded;
  if (!check(JSON.stringify(loaded) === JSON.stringify([[GLASS], [MOVER]]), 'Project loaded: the frosted-glass card above and the user card below', loaded)) throw new Error('The project did not load');
  const project = await storeProject();
  /*
   * Reference for live render: when the stream has not yet been produced (the frosted-glass card
   * has no stream plane and no snapshot on stage), click while paused to each of the frames to be
   * used in step 1, capturing one screenshot each.
   * This is the live render of the preview when "not pasting streams"; the visuals of step 1 "paste
   * stream and then stop" must be the same image. If a clean state cannot be awaited (the stream has
   * already arrived), do not keep the reference for this frame.
   */
  const stageBox = () => page.evaluate(() => {
    const f = [...document.querySelectorAll('iframe')].filter((el) => /stage=1/.test(el.src) && getComputedStyle(el).opacity !== '0')
      .map((el) => el.getBoundingClientRect()).find((r) => r.width > 100);
    return f ? { x: Math.round(f.left), y: Math.round(f.top), width: Math.round(f.width), height: Math.round(f.height) } : null;
  });
  /**
   * Capture the visible stage in preview (first waiting two animation frames); if `saveAs` is given,
   * save an additional PNG
   */
  const shootStage = async (saveAs = null) => {
    const f = await frontFrame();
    await f?.evaluate(() => new Promise((r) => (window.__pcRealRaf ?? requestAnimationFrame)(() => (window.__pcRealRaf ?? requestAnimationFrame)(() => r())))).catch(() => {});
    const box = await stageBox();
    if (!box) return null;
    const buf = await page.screenshot({ clip: box });
    if (saveAs) await fs.writeFile(path.join(OUT, saveAs), buf);
    const png = PNG.sync.read(buf);
    return resized(png, png.width, png.height);
  };
  const WHOLE = { x: 0, y: 0, w: 1, h: 1 };
  /**
   * Area occupied by the frosted-glass card (including shadow) in the frame, proportionally. The
   * control tier has no stream manifest to read, so use this hardcoded one (same area as the tight
   * rectangle of this project's stream)
   */
  const GLASS_REGION = { x: 19 / 960, y: 158 / 540, w: 328 / 960, h: 248 / 540 };
  const liveRef = new Map();
  {
    /**
     * Frosted-glass card is currently pure live render: stopped on this frame, not suppressed, not in
     * frame catch-up, no snapshots, and not a single stream plane on the stage
     */
    const plain = async (frame) => {
      const f = await frontFrame();
      return f?.evaluate((id, sec) => {
        const d = window.__pcStageDiag();
        const wrap = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`);
        return !!wrap && Math.abs(d.t - sec) < 1 / 60 && !d.suppressed.includes(id) && !d.settling.includes(id) && !d.awaiting.includes(id) && !d.snapshots.includes(id)
          && d.streamPlanes.length === 0 && d.streams.tracks.length === 0 && !/\bpc-(suppressed|settling|awaiting|snapshot)\b/.test(wrap.className);
      }, GLASS, frame / FPS).catch(() => false) ?? false;
    };
    for (const f of CLICKS) {
      await store(`actions.pause(); actions.seek(args[0]);`, (f > 40 ? f - 30 : f + 30) / FPS);
      await sleep(150);
      await store(`actions.pause(); actions.seek(args[0]);`, f / FPS);
      let last = null, kept = null;
      await until(`Live render reference: frame ${f} settled`, async () => {
        if (!(await plain(f))) { last = null; return null; }
        const shot = await shootStage();
        if (!shot) return null;
        const stable = !!last && last.width === shot.width && rectMean(last, shot, WHOLE) < 0.05;
        last = shot;
        if (stable && (await plain(f))) { kept = shot; return true; }
        return null;
      }, 12000, 120, true);
      if (kept) liveRef.set(f, { frame: f, shot: kept, best: null });
    }
    say('live-reference', { frames: [...liveRef.keys()] });
  }
  const pinHeavy = (persist = false, patch = {}) => page.evaluate(async (id, persist, patch) => {
    const { getState } = await import('/src/store/project.ts');
    const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
    const pd = await import('/src/editor/planDispatch.ts');
    const keys = clipIdentityOf(getState().project).identityKeys;
    const costs = pd.currentCosts();
    const device = costs[0]?.device ?? 'probe';
    const rec = { ...(costs.find((r) => r.identityKey === keys[id]) ?? { identityKey: keys[id], device }), pinnedHeavy: true, ...patch };
    pd.mergePlanCosts([rec]);
    if (persist && typeof rec.stepMs === 'number') await fetch('/api/data/costs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records: [rec] }) });
    return { vtOk: rec.vtOk ?? null, seekOk: rec.seekOk ?? null, stepMs: rec.stepMs ?? null };
  }, GLASS, persist, patch);
  await until('Cost record of the frosted-glass card', () => page.evaluate(async (id) => {
    const { getState } = await import('/src/store/project.ts');
    const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
    const pd = await import('/src/editor/planDispatch.ts');
    const key = clipIdentityOf(getState().project).identityKeys[id];
    return pd.currentCosts().some((r) => r.identityKey === key && typeof r.stepMs === 'number');
  }, GLASS), 180000, 500, true);
  out.costRecord = await pinHeavy(true);
  const prerender = await (await fetch(origin + '/api/prerender/info')).json();
  const segCount = Math.ceil((LAST - FIRST + 1) / SEG);
  const layersNow = () => page.evaluate(async (id) => {
    const m = await import('/src/editor/snapshotFeed.ts');
    const byKind = m.currentReadyIndex().get(id);
    return byKind ? Object.fromEntries([...byKind].map(([k, v]) => [k, { key: v.key, ranges: v.ranges, originFrame: v.originFrame ?? null, streamKind: v.streamKind ?? null, inputSig: v.inputSig ?? null }])) : null;
  }, GLASS);
  const poke = async () => {
    const k = await page.evaluate(async () => (await import('/src/render/dataMirror.ts')).mirrorKey());
    if (!k) return null;
    // Re-pin and re-save in every round: after the page finishes the second pass of testing, it rewrites
    // this entire cost record, the bit for pinning as heavy card gets wiped, and the prerender process
    // no longer produces it
    await pinHeavy(true);
    await fetch(prerender.url + '/api/frames/preload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: k.session, localRev: k.localRev, lane: 'background' }) }).catch(() => {});
    return k;
  };
  /**
   * Wait for this card's stream to reach full density across all segments; if `notKey` is given,
   * wait until it changes to another key
   */
  const waitStream = (label, notKey = null) => until(label, async () => {
    if (!(await poke())) return null;
    const layers = await layersNow();
    if (!layers?.stream || layers.stream.key === notKey || !(layers.stream.ranges ?? []).some((r) => r[0] <= 0 && r[1] >= segCount - 1)) return null;
    const manifest = await fetch(`${prerender.url}/api/frames/stream/${encodeURIComponent(layers.stream.key)}/manifest`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null), () => null);
    if (!manifest) return null;
    for (let n = 0; n < segCount; n++) if ((manifest.segments?.[n]?.stride ?? 0) !== 1) return null;
    return { layers, manifest };
  }, 900000, 2000);
  if (SETTLE_CONTROL) {
    // Control: without this stream. After pinning as heavy card, click to the same frames, wait for it
    // to stop and catch up to exact live render (not suppressed, not catching up frames, no snapshots,
    // not waiting for snapshots), and take screenshots
    const emptyUrl0 = emptyUrlOf(origin, { width: WIDTH, height: HEIGHT });
    bakery = await openBakery({ url: emptyUrl0 });
    await bakery.reset(project, emptyUrl0);
    bakery.streamLease = null;
    const frames = new Map();
    await fs.mkdir(path.join(OUT, 'ref-control'), { recursive: true });
    await bakeFrames(bakery, { out: path.join(OUT, 'ref-control'), fps: FPS, frames: `0-${LAST + 2}`, fullFrame: true, format: 'png', warm: 3, staticSkip: false, quiet: true, writeFrames: false,
      onFrame: async (i, buf) => { frames.set(i, PNG.sync.read(Buffer.from(buf))); } });
    const bestOf = (shot, f) => {
      const scores = [f - 2, f - 1, f, f + 1, f + 2].filter((c) => frames.has(c)).map((c) => [c, round2(rectMean(shot, resized(frames.get(c), shot.width, shot.height), GLASS_REGION))]);
      return [...scores].sort((x, y) => x[1] - y[1])[0]?.[0] ?? null;
    };
    await store(`actions.pause(); actions.seek(args[0]);`, (FIRST + 5) / FPS);
    await until('Control: the frosted-glass card is classified as heavy in the parent page\'s dispatch table', async () => { await pinHeavy(); const p = await parentDiag(); return p?.heavy.includes(GLASS) ? true : null; }, 30000, 200);
    const rows = [];
    for (const f of CLICKS) {
      const ref = liveRef.get(f);
      await store(`actions.pause(); actions.seek(args[0]);`, (f > 40 ? f - 30 : f + 30) / FPS);
      await sleep(400);
      await store(`actions.pause(); actions.seek(args[0]);`, f / FPS);
      let last = null, kept = null;
      await until(`Control: frame ${f} settled after stopping`, async () => {
        const fr = await frontFrame();
        const ok = await fr?.evaluate((id, sec) => {
          const d = window.__pcStageDiag();
          const wrap = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`);
          return !!wrap && Math.abs(d.t - sec) < 1 / 60 && !d.suppressed.includes(id) && !d.settling.includes(id) && !d.awaiting.includes(id) && !d.snapshots.includes(id)
            && d.streams.tracks.length === 0 && !/\bpc-(suppressed|settling|awaiting|snapshot)\b/.test(wrap.className);
        }, GLASS, f / FPS).catch(() => false);
        if (!ok || (await parentDiag())?.swapInFlight) { last = null; return null; }
        const shot = await shootStage();
        if (!shot) return null;
        const stable = !!last && rectMean(last, shot, WHOLE) < 0.05;
        last = shot;
        if (stable) { kept = shot; return true; }
        return null;
      }, 15000, 200, true);
      rows.push({ frame: f, heavyAfterStopVsLightLiveRender: ref && kept ? round2(rectMean(kept, ref.shot, GLASS_REGION)) : null, lightBestMatchExportFrame: ref ? bestOf(ref.shot, f) : null, heavyAfterStopBestMatchExportFrame: kept ? bestOf(kept, f) : null });
    }
    out.settleControl = rows;
    say('settle-control', { rows, setTimeLog: (await parentDiag())?.setTimeLog.slice(-4) });
    throw Object.assign(new Error('settle-control-done'), { done: true });
  }
  const startedPrerender = Date.now();
  const ready = await waitStream('All segments of the frosted-glass card\'s below-dependent stream at full density');
  if (!ready) throw new Error('The below-dependent stream was not produced');
  out.produceMs = Date.now() - startedPrerender;
  const key0 = ready.layers.stream.key;
  out.ready = { stream: { ...ready.layers.stream, key: key0.slice(0, 12) }, manifest: { kind: ready.manifest.kind, plane: ready.manifest.plane, bound: ready.manifest.bound, tight: ready.manifest.tight },
    hasSnapshotLayer: !!(ready.layers.html || ready.layers.local) };
  say('stream-ready', { ms: out.produceMs, ...out.ready });
  check(ready.manifest.kind === 'below' && ready.manifest.plane === 'stage', 'The prerender process produces a below-dependent stream (manifest: kind below, plane stage)', out.ready.manifest);
  check(ready.layers.stream.originFrame === FIRST, `The first frame of this stream is frame ${FIRST} (not a multiple of 15)`, ready.layers.stream);
  check(ready.layers.stream.streamKind === 'below' && /^s1-/.test(ready.layers.stream.inputSig ?? ''), 'That layer in the ready index carries the kind and the input signature', out.ready.stream);
  await pinHeavy();
  await store(`actions.pause(); actions.seek(args[0]);`, (FIRST + 5) / FPS);
  await sleep(500);
  {
    const p = await parentDiag();
    const pageSig = await page.evaluate(async (id) => {
      const { getState } = await import('/src/store/project.ts');
      const { streamInputSig } = await import('/src/render/streamInputSig.mjs');
      return streamInputSig(getState().project, { clipIds: [id], kind: 'below' });
    }, GLASS);
    out.signature = { layer: ready.layers.stream.inputSig, page: pageSig, staleBelow: p?.staleBelow ?? null };
    check(pageSig === ready.layers.stream.inputSig && (p?.staleBelow ?? []).length === 0, 'The signature from the prerender process is the same one the page computes from the project in the store (the parent page did not mark it as stale)', out.signature);
    check(!!p?.heavy.includes(GLASS) && !p.heavy.includes(MOVER), 'In the parent page\'s dispatch table the frosted-glass card is classified as heavy and the card below it is a light card (live render)', p?.heavy);
  }

  /* ---------------------------------------------------------------- Reference: export page frame by frame */
  const emptyUrl = emptyUrlOf(origin, { width: WIDTH, height: HEIGHT });
  bakery = await openBakery({ url: emptyUrl });
  const exportAll = async (proj, tag) => {
    await bakery.reset(proj, emptyUrl);
    bakery.streamLease = null;
    const frames = new Map();
    const dir = path.join(OUT, `ref-${tag}`);
    await fs.mkdir(dir, { recursive: true });
    await bakeFrames(bakery, { out: dir, fps: FPS, frames: `0-${LAST + 2}`, fullFrame: true, format: 'png', warm: 3, staticSkip: false, quiet: true, writeFrames: false,
      onFrame: async (i, buf) => { frames.set(i, PNG.sync.read(Buffer.from(buf))); } });
    return frames;
  };
  const exported = await exportAll(project, 'project');
  say('exported', { frames: exported.size });

  /* ---------------------------------------------------------------- Observations on the stage side */
  /**
   * Modified area of frosted-glass card (tight rectangle of stream, proportionally); compare only
   * within this area
   */
  const tightOf = (manifest) => { const t = manifest.tight ?? manifest.bound; return { x: t.x / WIDTH, y: t.y / HEIGHT, w: t.w / WIDTH, h: t.h / HEIGHT }; };
  let region = tightOf(ready.manifest);
  const refCache = new Map();
  /**
   * Capture visible stage in preview and compare with several frames of export page (export frames
   * scaled to screenshot size, comparing only the frosted-glass card area): returns the most similar
   * frame
   */
  const scoreShot = (shot, candidates, from = exported, tag = 'p') => {
    const scores = [...new Set(candidates)].filter((c) => from.has(c)).map((c) => {
      const key = `${tag}|${c}|${shot.width}x${shot.height}`;
      if (!refCache.has(key)) { refCache.set(key, resized(from.get(c), shot.width, shot.height)); if (refCache.size > 60) refCache.delete(refCache.keys().next().value); }
      return [c, round2(rectMean(shot, refCache.get(key), region))];
    });
    const sorted = [...scores].sort((x, y) => x[1] - y[1]);
    return { best: sorted[0]?.[0] ?? null, mean: sorted[0]?.[1] ?? null, runnerUp: sorted[1]?.[1] ?? null, scores, size: [shot.width, shot.height], shot };
  };
  const shootAndScore = async (candidates, saveAs = null, from = exported, tag = 'p') => {
    const shot = await shootStage(saveAs);
    return shot ? scoreShot(shot, candidates, from, tag) : { error: 'Visible stage not found' };
  };
  // Which frame of export page each reference image (live render without stream paste) looks most
  // like: record only
  for (const ref of liveRef.values()) ref.best = scoreShot(ref.shot, [ref.frame - 2, ref.frame - 1, ref.frame, ref.frame + 1, ref.frame + 2]).best;
  /** How the frosted-glass card currently looks in the visible stage */
  const cardState = async () => {
    const f = await frontFrame();
    if (!f) return null;
    return f.evaluate((id) => {
      const d = window.__pcStageDiag();
      const wrap = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`);
      const track = d.streams.tracks.find((t) => t.id.split('#')[0] === id) ?? null;
      const plane = document.querySelector(`canvas[data-pc-group-plane][data-pc-stream-group="${id}"]`);
      const live = wrap ? [...wrap.children].filter((el) => !el.hasAttribute('data-pc-stream-plane') && !el.hasAttribute('data-pc-snapshot-plane')
        && !el.hasAttribute('data-pc-placeholder-slot') && !el.hasAttribute('data-pc-proxy-plane')) : [];
      const hiddenEl = (el) => { const cs = getComputedStyle(el); return cs.display === 'none' || cs.visibility === 'hidden'; };
      const slot = wrap?.querySelector(':scope > [data-pc-placeholder-slot]') ?? null;
      return {
        t: d.t, role: d.role, cls: wrap?.className ?? null, mounted: !!wrap,
        suppressed: d.suppressed.includes(id), named: d.parentSuppressed.includes(id), waiting: d.streamWaiting.includes(id), settling: d.settling.includes(id), awaiting: d.awaiting.includes(id),
        snapshot: d.snapshots.includes(id) || !!wrap?.querySelector(':scope > [data-pc-snapshot-plane]'),
        planes: d.streamPlanes.map((p) => ({ clip: p.clipIds.join(','), plane: p.plane, key: (p.key ?? '').slice(0, 12) })),
        track: track && { key: (track.key ?? '').slice(0, 12), lastDrawn: track.lastDrawn, picture: track.picture, stale: track.stale, level: track.level, plane: track.plane, kind: track.kind, fits: track.fits, errors: track.errors, lastError: track.lastError },
        canvasInWrapper: !!wrap?.querySelector(':scope > canvas[data-pc-stream-plane]'),
        planeShown: !!plane && getComputedStyle(plane).display !== 'none', liveCount: live.length, liveHidden: live.length > 0 && live.every(hiddenEl),
        placeholder: d.placeholders.includes(id) || (!!slot && !slot.hidden),
      };
    }, GLASS).catch((e) => ({ error: String(e).slice(0, 200) }));
  };
  /**
   * Frame-by-frame sampler (installed on both stages; records only visible one): whether frosted-glass
   * card has moments where "live subtree is hidden while stream has no visuals", moments where live
   * visuals and stream overlap, placeholders, or snapshots
   */
  const installSampler = async () => {
    for (const f of stageFrames()) {
      await f.evaluate((id) => {
        const now = () => (window.__pcRealNow ?? (() => Date.now()))();
        const raf = window.__pcRealRaf ?? window.requestAnimationFrame.bind(window);
        const st = window.__probeSampler = { on: true, samples: 0, empty: 0, emptyRuns: [], both: 0, placeholder: 0, snapshot: 0, keys: [], log: [] };
        let eStart = null, lastKey = '';
        const began = now();
        const tick = () => {
          if (!st.on) return;
          const d = window.__pcStageDiag?.();
          if (d && d.role === 'front') {
            const at = now();
            const wrap = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`);
            if (wrap) {
              st.samples++;
              const track = d.streams.tracks.find((t) => t.id.split('#')[0] === id);
              const plane = document.querySelector(`canvas[data-pc-group-plane][data-pc-stream-group="${id}"]`);
              const streamOn = !!track && track.lastDrawn !== null && !!plane && getComputedStyle(plane).display !== 'none';
              const hidden = /\bpc-(suppressed|settling|awaiting|snapshot)\b/.test(wrap.className);
              const snap = d.snapshots.includes(id);
              const slot = wrap.querySelector(':scope > [data-pc-placeholder-slot]');
              const ph = d.placeholders.includes(id) || (!!slot && !slot.hidden);
              const empty = hidden && !streamOn && !snap;
              if (empty) { st.empty++; if (eStart === null) eStart = at; } else if (eStart !== null) { st.emptyRuns.push(Math.round(at - eStart)); eStart = null; }
              if (!hidden && streamOn) st.both++;
              if (ph) st.placeholder++;
              if (snap) st.snapshot++;
              const shownKey = streamOn ? (track.key ?? '').slice(0, 12) : '-';
              if (st.keys[st.keys.length - 1] !== shownKey) st.keys.push(shownKey);
              const key = `f${Math.round(d.t * 30)}|${track ? track.lastDrawn : '-'}|${hidden ? 'hid' : 'live'}|${streamOn ? 'stream' : '-'}|${d.settling.includes(id) ? 'settling' : '-'}|${snap ? 'snap' : '-'}|${ph ? 'ph' : '-'}`;
              if (key !== lastKey && st.log.length < 300) { lastKey = key; st.log.push(`${Math.round(at - began)}ms ${key}`); }
            }
            st.flush = () => { if (eStart !== null) { st.emptyRuns.push(Math.round(now() - eStart)); eStart = null; } };
          }
          raf(tick);
        };
        raf(tick);
      }, GLASS).catch(() => {});
    }
  };
  const collectSampler = async () => {
    const total = { samples: 0, empty: 0, emptyRuns: [], both: 0, placeholder: 0, snapshot: 0, keys: [], log: [] };
    for (const f of stageFrames()) {
      const s = await f.evaluate(() => {
        const st = window.__probeSampler;
        if (!st) return null;
        st.flush?.();
        st.on = false;
        return { samples: st.samples, empty: st.empty, emptyRuns: st.emptyRuns, both: st.both, placeholder: st.placeholder, snapshot: st.snapshot, keys: st.keys, log: st.log };
      }).catch(() => null);
      if (!s) continue;
      for (const k of ['samples', 'empty', 'both', 'placeholder', 'snapshot']) total[k] += s[k];
      total.emptyRuns.push(...s.emptyRuns); total.keys.push(...s.keys); total.log.push(...s.log);
    }
    return total;
  };
  const checkSampler = (label, s) => {
    check(s.samples > 0, `${label}: samples were collected`, s.samples);
    check(s.empty === 0, `${label}: the frosted-glass card never has a moment when "the live subtree is hidden and the stream has no picture"`, { empty: s.empty, runs: s.emptyRuns, log: s.log.slice(0, 40) });
    check(s.placeholder === 0, `${label}: the placeholder was not shown`, { placeholder: s.placeholder, log: s.log.slice(0, 40) });
    check(s.snapshot === 0, `${label}: no snapshot is mounted at all (with a stream, snapshots are not read)`, { snapshot: s.snapshot, log: s.log.slice(0, 40) });
    check(s.both === 0, `${label}: there is no moment when the live picture and the stream are stacked together`, { both: s.both, log: s.log.slice(0, 40) });
  };
  /**
   * After stopping: return to exact live render: not suppressed, live subtree exposed, no snapshots,
   * no placeholders; stream plane hidden, this frame already decoded; parent page keeps sending stream
   * plane
   */
  const waitSettled = async (label, frame) => {
    const began = Date.now();
    const state = await until(`${label}: back to the exact live render after stopping`, async () => {
      const s = await cardState();
      const p = await parentDiag();
      if (!s || s.error || !p || !s.mounted) return null;
      const exact = !s.suppressed && !s.named && !s.waiting && !s.settling && !s.awaiting && !s.snapshot && !s.liveHidden && s.liveCount > 0 && !s.placeholder
        && !p.swapInFlight && !p.suppressed.length && Math.abs(s.t - frame / FPS) < 0.5 / FPS;
      return exact ? { s, p } : null;
    }, 60000, 40);
    if (!state) { say('not-settled', { card: await cardState(), parent: await parentDiag() }); return { ok: false, ms: Date.now() - began }; }
    const warm = await until(`${label}: after stopping, the stream plane is hidden and this frame is already decoded`, async () => {
      const s = await cardState();
      return s && s.track && s.track.lastDrawn === frame && !s.planeShown && s.planes.length === 1 ? s : null;
    }, 8000, 40);
    const p = await parentDiag();
    check(!!warm, `${label}: after stopping, the stream plane is hidden and the frame under the playhead is already decoded`, await cardState());
    check(p.streams.length === 1 && p.streams[0].plane === 'stage' && p.scrub.length === 0 && p.picks.length === 0 && p.mounted.length === 0, `${label}: after stopping, the parent page keeps sending the stream plane (stage coordinates), with no suppression and no snapshot picked`, p);
    return { ok: true, ms: Date.now() - began };
  };

  check(CLICKS.filter((f) => liveRef.has(f)).length >= 3, 'Live render reference: at least three spots were captured before the stream was produced', [...liveRef.keys()]);
  if ([...liveRef.values()].some((r) => r.best !== r.frame)) notes.push(`When the odometer does not paste the stream, the preview's live render already does not line up with the export page (unrelated to the stream; frame number → closest export-page frame): ${JSON.stringify([...liveRef.values()].map((r) => [r.frame, r.best]))}`);

  /* ---------------------------------------------------------------- 1. Click timeline to jump across */
  await store(`actions.pause(); actions.seek(args[0]);`, (FIRST + 5) / FPS);
  await waitSettled('Start', FIRST + 5);
  out.click = [];
  for (const f of CLICKS) {
    await installSampler();
    await store(`actions.pause(); actions.seek(args[0]);`, f / FPS);
    const settled = await waitSettled(`Click to frame ${f}`, f);
    const sampler = await collectSampler();
    checkSampler(`Click to frame ${f}`, sampler);
    const score = await shootAndScore([f - 2, f - 1, f, f + 1, f + 2], f === CLICKS[0] ? `click-${f}-settled.png` : null);
    const ref = liveRef.get(f);
    const vsLive = ref ? round2(rectMean(score.shot, ref.shot, region)) : null;
    // Record only: returning to live render after heavy card stops takes a different path (subtree
    // virtual-time frame catch-up), and on frames where entrance animation has not finished playing, it
    // differs by one frame from live render as light card:
    // the same is true in the control tier (`--settle-control`) not producing this stream; this is not
    // caused by stream pasting. Record those with large differences into notes
    if (ref && !(vsLive < 1)) notes.push(`Click to frame ${f}: the live render after stream paste and then stopping is not the same image as the live render with the light card (mean difference ${vsLive}; closest export-page frame ${score.best} vs ${ref.best}). The same holds after a heavy card stops in the control mode --settle-control (which does not produce this kind of stream)`);
    out.click.push({ vsLiveRenderWithoutStreamPaste: vsLive, bestMatchExportFrameWithoutStreamPaste: ref?.best ?? null, frame: f, settledMs: settled.ms, best: score.best, mean: score.mean, runnerUp: score.runnerUp, log: sampler.log.slice(0, 10) });
  }
  say('1-click', { clicks: out.click.map((c) => ({ frame: c.frame, settledMs: c.settledMs, best: c.best, mean: c.mean, runnerUp: c.runnerUp })) });

  /* ---------------------------------------------------------------- 2. Hold ruler and scrub */
  const ruler = await page.evaluate(() => {
    const el = document.querySelector('[data-pc="ruler"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const ticks = [...el.querySelectorAll('.pc-tl-tick.is-major')].map((t) => {
      const label = t.querySelector('.pc-tl-tick-label')?.textContent ?? '';
      const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(label.trim());
      return m ? { sec: Number(m[1]) * 60 + Number(m[2]), x: t.getBoundingClientRect().left } : null;
    }).filter(Boolean);
    return { left: r.left, right: r.right, y: r.top + r.height / 2, ticks };
  });
  if (!ruler || ruler.ticks.length < 2) throw new Error('Cannot measure the ruler ticks');
  const tk0 = ruler.ticks[0], tk1 = ruler.ticks[ruler.ticks.length > 2 ? 2 : 1];
  const pxPerSec = (tk1.x - tk0.x) / (tk1.sec - tk0.sec);
  await store(`actions.pause(); actions.seek(args[0]);`, 2);
  await sleep(300);
  const head = await page.evaluate(async () => {
    const el = document.querySelector('[data-pc="playhead"]');
    const r = el?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, t: (await import('/src/store/project.ts')).getState().t } : null;
  });
  let xZero = head ? head.x - head.t * pxPerSec : tk0.x - tk0.sec * pxPerSec;
  out.ruler = { pxPerSec: +pxPerSec.toFixed(3), xZero: +xZero.toFixed(2) };
  check(pxPerSec / FPS >= 2, 'At least 2 pixels per frame on the ruler (the pointer lands accurately)', out.ruler);
  const xOf = (frame) => xZero + ((frame + 0.5) / FPS) * pxPerSec;
  const moveToFrame = async (frame, { down = false } = {}) => {
    let landed = null;
    for (const dx of [0, 1, -1, 2, -2]) {
      await page.mouse.move(Math.round(xOf(frame)) + dx, ruler.y);
      if (down && landed === null) await page.mouse.down();
      const deadline = Date.now() + 600;
      while (Date.now() < deadline && frameOf(await storeT()) !== frame) await sleep(30);
      landed = frameOf(await storeT());
      if (landed === frame) { if (dx) xZero += dx; break; }
    }
    return landed;
  };
  /**
   * After scrubbing to this frame: stream draws this frame; verify how this card looks on stage and
   * on parent page side; compare screenshot with export page
   */
  const checkDragStep = async (label, target, { from = exported, tag = 'p', key = null, saveAs = null } = {}) => {
    const state = await until(`${label}: the stream draws this frame`, async () => {
      const s = await cardState();
      return s && !s.error && s.track && s.track.lastDrawn === target && !s.track.stale && Math.abs(s.t - target / FPS) < 1e-6 && (!key || s.track.key === key.slice(0, 12)) ? s : null;
    }, 15000, 15);
    const s = state ?? await cardState();
    const p = await parentDiag();
    if (s && !s.error) {
      check(s.suppressed && /\bpc-suppressed\b/.test(s.cls ?? '') && s.liveHidden, `${label}: the frosted-glass card is suppressed and the live subtree is hidden`, s);
      check(s.planeShown && !s.canvasInWrapper && s.track?.level === 'dense' && s.track?.kind === 'below' && s.track?.plane === 'stage' && s.track?.fits === true, `${label}: the stream plane under the stage root is shown, pasting the full-density version of this frame`, s);
      check(!s.placeholder && !s.snapshot && !s.awaiting, `${label}: no placeholder, no snapshot, not waiting for a snapshot`, s);
      check((s.track?.errors ?? 0) === 0, `${label}: no decode errors`, s.track);
    }
    check(p.suppressed.includes(GLASS) && !p.suppressed.includes(MOVER) && p.streams.length === 1 && p.streams[0].plane === 'stage' && p.picks.length === 0 && p.mounted.length === 0 && p.staleBelow.length === 0,
      `${label}: the parent page only suppresses the frosted-glass card, sends its stream plane (stage coordinates) and does not pick a snapshot`, p);
    const score = await shootAndScore([target - 1, target, target + 1], saveAs, from, tag);
    check(score.best === target, `${label}: the screenshot most resembles frame ${target} of the export page (more than both the previous frame and the next frame)`, { best: score.best, scores: score.scores });
    return { state: s, parent: p, score };
  };
  {
    await waitSettled('Before drag', 60);
    await installSampler();
    await page.keyboard.down('Alt');   // Does not snap to whole seconds / clip boundaries; which frame it lands on is determined by coordinates
    const steps = [];
    for (let i = 0; i < STEPS.length; i++) {
      const target = STEPS[i];
      const landed = await moveToFrame(target, { down: i === 0 });
      const step = { i, target, landed, sample: (target - FIRST) % SEG };
      steps.push(step);
      if (!check(landed === target, `Drag step ${i} lands on frame ${target}`, { landed })) continue;
      const r = await checkDragStep(`Drag step ${i} (frame ${target})`, target, { saveAs: [33, 70].includes(target) ? `drag-${target}-stream.png` : null });
      step.best = r.score.best; step.mean = r.score.mean; step.runnerUp = r.score.runnerUp;
      check(r.parent.setTimeLog.at(-1)?.settle === false, `Drag step ${i}: this setTime call does not carry "settle"`, r.parent.setTimeLog.at(-1));
    }
    await page.mouse.up();
    await page.keyboard.up('Alt');
    const released = STEPS.at(-1);
    const settled = await waitSettled('Release', released);
    const sampler = await collectSampler();
    checkSampler('Entire drag', sampler);
    out.drag = { steps, releasedAt: released, settleMs: settled.ms, empty: sampler.empty, placeholder: sampler.placeholder, snapshot: sampler.snapshot };
    say('2-drag', { steps: steps.map((s) => [s.target, s.best, s.mean, s.runnerUp]), settleMs: settled.ms });
  }

  /* ---------------------------------------------------------------- 3. Start playback while paused, pause during playback */
  out.play = [];
  for (const [round, [from, playMs]] of [[20, 900], [45, 600]].entries()) {
    await store(`actions.pause(); actions.seek(args[0]);`, from / FPS);
    await waitSettled(`Before playback starts in round ${round}`, from);
    await installSampler();
    for (const f of stageFrames()) await f.evaluate(() => { window.__pcFallbackTrace = []; }).catch(() => {});
    await store(`actions.play();`);
    await sleep(playMs);
    await store(`actions.pause();`);
    await sleep(60);
    const traces = [];
    for (const f of stageFrames()) {
      const t = await f.evaluate(() => (Array.isArray(window.__pcFallbackTrace) ? window.__pcFallbackTrace.splice(0) : null)).catch(() => null);
      if (t?.length) traces.push(...t);
      await f.evaluate(() => { delete window.__pcFallbackTrace; }).catch(() => {});
    }
    const beats = traces.map((b) => ({ frame: Math.round(b.sec * FPS), level: b.levels[GLASS] ?? null, snapshots: b.snapshots }));
    const stopped = frameOf(await storeT());
    const settled = await waitSettled(`Pause during playback in round ${round}`, stopped);
    const sampler = await collectSampler();
    checkSampler(`Round ${round}, entire run from playback start to pause`, sampler);
    const inRange = beats.filter((b) => b.frame >= FIRST && b.frame <= LAST);
    const notDense = inRange.filter((b) => b.level !== 'dense');
    check(inRange.length >= 8, `Round ${round}: played a stretch`, beats.length);
    check(beats[0]?.frame === from + 1 && beats[0]?.level === 'dense', `Round ${round} playback start: on the first tick the frosted-glass card already shows the stream picture (this frame was already decoded while paused)`, beats.slice(0, 3));
    check(notDense.length === 0, `Round ${round} playback: every tick shows the full-density stream picture (no empty ticks, no placeholders, no snapshots)`, notDense.slice(0, 5));
    check(beats.every((b) => b.snapshots === 0), `Round ${round} playback: there is not a single snapshot on the stage`, beats.filter((b) => b.snapshots).slice(0, 3));
    const score = await shootAndScore([stopped - 2, stopped - 1, stopped, stopped + 1, stopped + 2], round === 0 ? `pause-${stopped}-settled.png` : null);
    const entry = { from, stoppedAt: stopped, beats: beats.length, firstBeat: beats[0] ?? null, notDense: notDense.length, settleMs: settled.ms, best: score.best, mean: score.mean };
    out.play.push(entry);
    say('3-play', entry);
  }

  /* ---------------------------------------------------------------- 4. Change one place in lower layer: do not paste old stream, re-produce, paste again */
  {
    await store(`actions.pause(); actions.seek(args[0]);`, 60 / FPS);
    await waitSettled('Before editing the layer below', 60);
    await page.keyboard.down('Alt');
    const landed = await moveToFrame(EDIT_AT, { down: true });
    check(landed === EDIT_AT, `Pressing on the ruler lands on frame ${EDIT_AT}`, { landed });
    const before = await checkDragStep('Before editing the layer below (pasting the old stream)', EDIT_AT, { key: key0 });
    await installSampler();
    // Change a parameter of the card below (color of the bright band). Store switches to the new
    // project object; the signature calculated by parent page based on it does not match that of old
    // stream
    const editedAt = Date.now();
    await store(`actions.setClipParams(args[0], { accent: '#ff4d6d' });`, MOVER);
    const dropped = await until('After the layer below changes, the parent page no longer sends the stream plane of the old stream', async () => {
      const p = await parentDiag();
      const s = await cardState();
      return p && p.staleBelow.includes(GLASS) && p.streams.length === 0 && s && !s.error && !s.track && s.planes.length === 0 ? { p, s, ms: Date.now() - editedAt } : null;
    }, 5000, 10);
    const edit = { frame: EDIT_AT, oldKey: key0.slice(0, 12), droppedMs: dropped?.ms ?? null, afterDrop: dropped ? { staleBelow: dropped.p.staleBelow, streams: dropped.p.streams.length, suppressed: dropped.p.suppressed, picks: dropped.p.picks, stageSuppressed: dropped.s.suppressed, placeholder: dropped.s.placeholder } : null };
    check(!!dropped, 'One spot in the layer below changed: the parent page immediately recognizes the old stream as stale (signature mismatch), stops sending its stream plane, and the old stream\'s track on the stage is closed', { parent: await parentDiag(), card: await cardState() });
    // There is no stream for this frame: handle as heavy card without streams during pause / scrub
    // (current status: not suppressed, falls back to snapshot, exposes live component if still missing)
    if (dropped) check(!dropped.p.suppressed.includes(GLASS) && !dropped.p.scrub.includes(GLASS), 'After the old stream goes stale, this card is treated as having no stream: no longer suppressed because of stream paste', dropped.p);
    // Re-produce: prerender process updates version based on new project, new keys arrive
    const t0 = Date.now();
    const again = await waitStream('After the layer below changes, all segments of the new stream are at full density', key0);
    if (!again) throw new Error('The new stream was not produced after the layer below was edited');
    edit.reproduceMs = Date.now() - t0;
    const key1 = again.layers.stream.key;
    edit.newKey = key1.slice(0, 12);
    edit.newLayer = { streamKind: again.layers.stream.streamKind, inputSig: again.layers.stream.inputSig, oldSig: ready.layers.stream.inputSig };
    check(key1 !== key0 && again.layers.stream.inputSig !== ready.layers.stream.inputSig && again.layers.stream.streamKind === 'below', 'The re-produced stream has a new key and a new signature', edit);
    region = tightOf(again.manifest);
    const edited = await storeProject();
    const exported1 = await exportAll(edited, 'edited');
    // Hand still pressed down: after receiving the new layer, parent page re-sends stream plane itself,
    // and stage pastes new stream
    const after = await checkDragStep('After re-producing (pasting the new stream)', EDIT_AT, { from: exported1, tag: 'e', key: key1, saveAs: `edit-${EDIT_AT}-new-stream.png` });
    const vsOld = round2(rectMean(after.score.shot, resized(exported.get(EDIT_AT), after.score.size[0], after.score.size[1]), region));
    edit.afterMean = after.score.mean; edit.afterRunnerUp = after.score.runnerUp; edit.vsPreEditExportSameFrame = vsOld; edit.beforeMean = before.score.mean;
    check(vsOld > after.score.mean * 1.3 + 0.3, 'Control: the picture pasting the new stream is clearly worse when compared against the pre-edit export page (this comparison method can tell whether the layer below changed)', edit);
    // Scrub to two more places, both with the new stream
    for (const f of [EDIT_AT + 19, EDIT_AT - 13]) {
      const got = await moveToFrame(f);
      if (check(got === f, `Drag to frame ${f} after re-producing`, { got })) await checkDragStep(`Drag to frame ${f} after re-producing`, f, { from: exported1, tag: 'e', key: key1 });
    }
    await page.mouse.up();
    await page.keyboard.up('Alt');
    const sampler = await collectSampler();
    // Keys exposed on stream plane in sampling: once the old key disappeared, it never came back
    const order = sampler.keys.filter((k, i, a) => i === 0 || a[i - 1] !== k);
    edit.shownKeys = order;
    const firstGone = order.findIndex((k) => k !== key0.slice(0, 12));
    check(order.includes(key1.slice(0, 12)) && (firstGone < 0 || !order.slice(firstGone).includes(key0.slice(0, 12))), 'After the old stream was withdrawn it was never pasted back; what was pasted afterwards is the new stream', order);
    out.edit = edit;
    say('4-edit', edit);
    await waitSettled('Release after editing', EDIT_AT - 13);
  }

  out.pageErrors = pageErrors.slice(0, 5);
  check(pageErrors.length === 0, 'Page has no uncaught errors', pageErrors.slice(0, 3));
} catch (error) {
  if (!error?.done) {
    fails.push(`Exception: ${error?.stack || error}`);
    say('ERROR', { error: String(error?.stack || error) });
  }
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { await bakery?.close(); } catch { /* ignore */ }
  try { await dev?.stop(); } catch { /* ignore */ }
  if (!KEEP) {
    try {
      for (const name of await fs.readdir(OUT)) if (!/\.(json|png|log|err)$/.test(name)) await fs.rm(path.join(OUT, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* ignore */ }
  }
}
out.elapsedMs = Date.now() - started;
out.notes = notes;
out.fails = fails;
out.ok = fails.length === 0;
try { await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log(out.ok ? 'PASS' : `FAIL ${fails.length}`);
process.exit(out.ok ? 0 : 1);

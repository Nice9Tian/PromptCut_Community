/**
 * Track streams **pasted back to stage** for below-dependent cards: probe on the stage side
 * (the third block of task brief `docs/plan/render-refactor-task.md` "Wu-2"; contract
 * `docs/plan/prerender-products-contract.md` section 5.4). Production side (differential layer
 * extraction, keys) is in `stream-below-probe.mjs`; parent page side (which cards paste streams in
 * the real editor, old streams not pasted after lower layer changes) is in
 * `below-paste-editor-probe.mjs`.
 *
 *   node scripts/probes/stream-below-stage-probe.mjs (--origin http://127.0.0.1:26980 | --port 26980) [--host-port 26990] [--media-port 26991]
 *        [--scenes a,b,u,d] [--size 960x540] [--out <dir>] [--json <file>] [--keep]
 *
 * If `--port` is given, start a dev server at checkout root (`--port`, also occupying +1 and +2 as
 * stage ports; data directory and card overlay layer are under `--out`), and tear it down by PID
 * when finished. Start `FramePipeline` directly in this process (same code as prerender process),
 * library root under `--out`. Test page acts as parent page, sending messages in same order as parent
 * page in production (send stream plane first, then suppression, then set time; media layer
 * timestamp is sent separately; below-dependent layer carries `streamKind: "below"`, stream plane
 * carries `plane: "stage"`).
 *
 * Scenes (every scene has another small pill pressed on top of target card at very top: verify
 * upper layers cover above stream plane as usual):
 *
 *   Jia  Frosted-glass card (odometer `odometer`, below-dependent in review table) pressed on top
 *        of a moving card (particles) and a video;
 *   Yi   Lower layer is semi-transparent: opacity 0.6, pill with shadow, nothing underneath
 *        (transparent); same frosted-glass card pressed on top;
 *   Bing **User card** written with remotion-style framework (not covered in review table, treated
 *        as below-dependent; created via real `POST /api/cards/create`) pressed on top of particles
 *        and video.
 *   Ding (not run by default, `--scenes d`) Same as Jia, but frosted-glass card's **outer frame uses
 *        3D transform** (`rotateY`, `rotateX`, `translateZ`), project has perspective enabled:
 *        stream contains frames in 3D stage coordinates, while plane remains mounted under stage root
 *        as usual without further transform. Item F modifies **3D angle** (not lower layer): signature
 *        on old stream mismatches, key changes, pasted only when new stream arrives, significantly
 *        worse when compared against export page with old angle.
 *
 * All target cards **do not start on a multiple-of-15 frame** (Jia and Yi on frame 6, Bing on frame
 * 38). All cards are pinned as heavy cards: target cards use below-dependent streams, other cards each
 * use their own single-card streams, and video is played live by the stage: so when jumping to any
 * frame while paused, the lower layer on the stage is the exact frame it should be, and full-frame
 * screenshot can be directly compared against same frame on export page (cases where lower layer is
 * **live render** go through "pause and catch up to exact live render", which is the responsibility of
 * parent page and cost records, verified in `below-paste-editor-probe.mjs`).
 *
 * Verify item by item (reference is always full-frame image of same frame from export page; compare
 * only within tight rectangle of this stream, closest match must be the expected frame):
 *
 *   0. Planning and layer dispatch: target card has a stream with `kind: below`, `plane: stage`;
 *      layer dispatched to page carries `streamKind: "below"` and input signature, where signature is
 *      computed from the same project (page uses it to detect expiration); layers of other cards do
 *      not carry these two items.
 *   A. **Sparse version only** (only produce sparse pass first): set to several frames while paused,
 *      pastes closest frame no later than this frame, stage reports sparse tier, no placeholders.
 *   B. **Where plane is mounted**: target card's wrapper layer does not contain canvas of stream
 *      plane; there is a piece under stage root, in same stage as wrapper layer, with identical layer
 *      order, positioned by manifest stage coordinates; wrapper layer is suppressed (subtree hidden),
 *      bearing the "click to return to wrapper layer box" marker.
 *   C. **Full density, jump to any frame while paused** (every frame where target card is present,
 *      shuffled): pasted frame most closely matches same frame from export page; difference from same
 *      frame is on the order of encoding error, and significantly larger than differences to adjacent
 *      frames. Region where pill pressed on top sits also matches (upper layers not covered by plane).
 *   D. **Scrub** (each step without "pause", proceeding to next step before previous step renders):
 *      renders final frame after stopping, with no blank moments.
 *   E. **Playback**: from first tick onward, target card displays full density stream frame on every
 *      tick; paused during playback, paused frame pastes this exact frame.
 *   F. **Modify one place in lower layer**: signature on old layer mismatches the one computed from
 *      new project (parent page skips pasting based on this); prerender process stops sending old key
 *      after version change, produces new stream with new key and new signature; new stream is pasted,
 *      matching same frame of new project's export page best, and significantly closer than comparing
 *      against old project's export page (this comparison distinguishes whether lower layer changed).
 *   G. **The moment two stages swap** (`swapAndDress` in `src/editor/stageSwap.ts`, playback state):
 *      new visible stage holds exact live frame from catch-up run, without having fetched any stream
 *      yet. In revised order, **send stream plane first, then suppression** before resuming playback:
 *      before stream renders first frame, target card's original frame is not hidden, with zero
 *      moments where "live subtree hidden while stream has no frame", and no placeholders. Control:
 *      send in original order (suppression first, then stream plane), measuring that blank period
 *      (segment bytes wait 80 ms extra each time, switching address prefix to avoid cache: exactly
 *      how new stage fetches this stream for the first time). Parent page dispatch order itself is
 *      pinned by unit test `src/editor/stageSwap.test.mjs`.
 *
 * Outputs JSON conclusion, writes progress to stderr; exits non-zero if any check fails.
 * Elapsed time is recorded only; timeout is only to prevent hangs.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { serve, flagArg } from './probe-connect.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { handleStreamRequest, BELOW_STREAMS_DEFAULT, belowStreamsEnabled } from '../../server/frame-stream.mjs';
import { openBakery } from '../../server/bakery/chrome.mjs';
import { bakeFrames } from '../../server/bakery/bake.mjs';
import { findFfmpeg, dropStreamEncoderSpares } from '../../server/bakery/ffmpeg.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startDevServer, serveMedia, emptyUrlOf, sleep, round2 } from './below-stream-common.mjs';
import { streamPlanesFor } from '../../src/render/streamPlayer.ts';
import { streamInputSig, streamSigStale } from '../../src/render/streamInputSig.mjs';
import { STREAM_SEGMENT_FRAMES, streamSegmentFirstFrame, streamSegmentOf } from '../../src/render/streamSegments.mjs';

const args = process.argv.slice(2);
const ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '0', args));
const HOST_PORT = Number(flagArg('host-port', '0', args)) || 0;
const MEDIA_PORT = Number(flagArg('media-port', '0', args)) || 0;
const SCENES = String(flagArg('scenes', 'a,b,u', args)).split(',').map((s) => s.trim()).filter((s) => ['a', 'b', 'u', 'd'].includes(s));
const KEEP = args.includes('--keep');

const JSON_OUT = flagArg('json', null, args);
const RUN = Date.now().toString(36);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-stream-below-stage-${RUN}`));
const [WIDTH, HEIGHT] = String(flagArg('size', '960x540', args)).split('x').map(Number);
process.env.PROMPTCUT_STREAM_POOL = '1';
if (!ORIGIN && !PORT) { console.error('Pass --origin <dev server> or --port <start your own>'); process.exit(2); }
if (!(WIDTH > 0 && HEIGHT > 0)) { console.error('write --size like 960x540'); process.exit(2); }

const FPS = 30, DURATION = 3, SEG = STREAM_SEGMENT_FRAMES, LAST = DURATION * FPS - 1;
const K = WIDTH / 1920;
const SCENE_NAME = { a: 'A', b: 'B', u: 'C', d: 'D' };
/** Ding: 3D placement of the frosted-glass card outer frame; switch angle on `edited` */
const TILT = { rotateY: 18, rotateX: -8, translateZ: -60 }, TILT_EDITED = { rotateY: 30, rotateX: 6, translateZ: -60 }, FOV = 50;
const USER_CARD = `bp-panel-${RUN}`;

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 900))); say('FAIL', { label, extra }); } return !!cond; };
async function until(label, fn, timeoutMs, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`Timeout: ${label}`); say('TIMEOUT', { label }); return null; }
    await sleep(everyMs);
  }
}

/**
 * Video for Jia and Bing: ffmpeg test pattern (sharp edges, continuous motion), **color removed,
 * keeping only luminance**. The stage browser plays video via GPU while export page uses software
 * rasterization; the two paths use different matrices to convert YUV to RGB (measured pure red on
 * color test pattern differs by 20 to 30 levels even with matrix specified; this is difference
 * between stage-played video and export page, not stream paste issue), which would be blamed on
 * stream paste when comparing full frames against export page. Video with luminance only has
 * constant median chroma, converting identically under any matrix. `ensureVideo` in
 * `below-stream-common.mjs` is in color, so a separate version is provided here.
 */
async function taggedVideo(ffmpeg, dir) {
  const file = path.join(dir, `below-stage-${WIDTH}x${HEIGHT}.mp4`);
  await fs.mkdir(dir, { recursive: true });
  await promisify(execFile)(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${DURATION + 1}`,
    '-vf', 'hue=s=0,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-c:v', 'libx264', '-g', String(FPS), '-crf', '18', '-movflags', '+faststart', file], { windowsHide: true });
  return file;
}

/* ---------------------------------------------------------------- Scene */

/** User card used by Bing: remotion-style (frame determined solely by t), imports framework; a semi-transparent plaque slides from left to right, with a line of text inside */
const USER_SOURCE = `import type { CardDef, CardProps } from "../../kernel/types";
import { Easing, interpolate } from "../../kernel/remotionStyle";

interface Params { text: string; accent: string }

const SLIDE = Easing.bezier(0.16, 1, 0.3, 1);

function BpPanel({ params, t = 0 }: CardProps<Params>) {
  const x = interpolate(t, [0, 1.4], [0, 260], { easing: SLIDE });
  const show = interpolate(t, [0, 0.3], [0, 1]);
  const tilt = interpolate(t, [0, 1.4], [-6, 3]);
  return (
    <div style={{ position: "absolute", inset: 0, fontFamily: "sans-serif" }}>
      <div
        style={{
          position: "absolute", left: 60 + x, top: 190, width: 400, height: 150, borderRadius: 26,
          background: "rgba(18, 22, 40, 0.55)", border: \`3px solid \${params.accent}\`, opacity: show,
          transform: \`rotate(\${tilt}deg)\`, display: "flex", alignItems: "center", justifyContent: "center",
          color: params.accent, fontSize: 40, fontWeight: 800,
        }}
      >
        {params.text}
      </div>
    </div>
  );
}

export const bpPanel: CardDef<Params> = {
  id: "${USER_CARD}",
  name: "贴流探针：滑入的牌子",
  description: "探针用的 remotion 式 DOM 卡：一块半透明的牌子从左往右滑入",
  source: "user",
  useWhen: "探针用，不用于真实项目。",
  tags: ["探针"],
  frameMode: "direct",
  defaults: { text: "用户卡贴流", accent: "#ffd166" },
  controls: [
    { key: "text", label: "文字", type: "text" },
    { key: "accent", label: "主色", type: "color" },
  ],
  Component: BpPanel,
  lifecycle: { settleMs: 1500, after: "hold", exit: ["fade"] },
};
`;

/** Odometer is designed for 1920×1080: scales entire card proportionally on smaller aspect ratios */
const glassFrame = () => (WIDTH === 1920 && HEIGHT === 1080 ? {} : { frame: { x: 0, y: 0, w: 1920, h: 1080, anchor: [0, 0], scale: K } });
/** Small pill pressed on top of target card (position given by scene: falls within the area modified by target card) */
const abovePill = (cx, cy) => ({ id: 'tr-above', name: 'above', hidden: false, clips: [
  { id: 'clip-above', kind: 'card', cardId: 'punch-pill', start: 0.5, end: DURATION, params: { text: '上面的层' },
    frame: { x: Math.round(cx), y: Math.round(cy), w: 1280, h: 720, anchor: [0.5, 0.5], scale: K * 0.45 } },
] });
const particles = (color = '#30ff60') => ({ id: 'tr-move', name: 'move', hidden: false, clips: [
  { id: 'clip-move', kind: 'card', cardId: 'particles', start: 0, end: DURATION, params: { color, quantity: 120, speed: 1.5, size: 4, links: 'yes', seed: 3 } },
] });
const videoTrack = () => ({ id: 'tr-video', name: 'video', hidden: false, clips: [{ id: 'clip-video', mediaId: 'm-video', start: 0, end: DURATION, params: {} }] });

/**
 * Scene project. `edited`: modifies one control in lower layer (Jia and Bing change particle color,
 * Yi changes pill text). Returns `{ project, target, cards, hasVideo }`, `cards` is IDs of all card
 * clips (all pinned as heavy cards).
 */
function scene(kind, { mediaUrl = '', edited = false } = {}) {
  const base = { name: `Stream-paste probe ${SCENE_NAME[kind]}`, width: WIDTH, height: HEIGHT, fps: FPS, duration: DURATION, themeId: 'dark', filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {} };
  const media = [{ id: 'm-video', kind: 'video', name: 'below-probe.mp4', url: mediaUrl, duration: DURATION }];
  if (kind === 'u') {
    const target = { id: 'tr-user', name: 'user', hidden: false, clips: [
      { id: 'clip-user', kind: 'card', cardId: USER_CARD, start: 1.24, end: 2.9, params: { text: '用户卡贴流', accent: '#ffd166' } },
    ] };
    return { target: 'clip-user', cards: ['clip-above', 'clip-user', 'clip-move'], hasVideo: true,
      project: { ...base, id: `below-stage-u-${RUN}`, media, tracks: [abovePill(WIDTH * 0.42, HEIGHT * 0.5), target, particles(edited ? '#ff5a30' : '#30ff60'), videoTrack()] } };
  }
  const glass = { id: 'tr-glass', name: 'glass', hidden: false, clips: [
    { id: 'clip-glass', kind: 'card', cardId: 'odometer', start: 0.2, end: DURATION, params: { position: 'left', value: 86420, label: '贴流探针' }, ...glassFrame() },
  ] };
  if (kind === 'd') {
    const g = glass.clips[0];
    g.frame = { x: 0, y: 0, w: 1920, h: 1080, anchor: [0, 0], scale: K, ...(g.frame ?? {}), ...(edited ? TILT_EDITED : TILT) };
    return { target: 'clip-glass', cards: ['clip-above', 'clip-glass', 'clip-move'], hasVideo: true, tilted: true,
      project: { ...base, camera3dFov: FOV, id: `below-stage-d-${RUN}`, media, tracks: [abovePill(WIDTH * 0.2, HEIGHT * 0.5), glass, particles(), videoTrack()] } };
  }
  if (kind === 'a') {
    return { target: 'clip-glass', cards: ['clip-above', 'clip-glass', 'clip-move'], hasVideo: true,
      project: { ...base, id: `below-stage-a-${RUN}`, media, tracks: [abovePill(WIDTH * 0.16, HEIGHT * 0.5), glass, particles(edited ? '#ff5a30' : '#30ff60'), videoTrack()] } };
  }
  const block = { id: 'tr-block', name: 'block', hidden: false, clips: [
    { id: 'clip-block', kind: 'card', cardId: 'punch-pill', start: 0, end: DURATION, params: { text: edited ? '半透明的下层(改过)' : '半透明的下层' },
      frame: { x: Math.round(WIDTH * 0.36), y: Math.round(HEIGHT * 0.5), w: 1280, h: 720, anchor: [0.5, 0.5], scale: K * 1.5 },
      opacity: 0.6, emphasis: { kind: 'shadow', color: '#000000', size: 36, opacity: 0.7, dx: 0, dy: 18 } },
  ] };
  return { target: 'clip-glass', cards: ['clip-above', 'clip-glass', 'clip-block'], hasVideo: false,
    project: { ...base, id: `below-stage-b-${RUN}`, media: [], tracks: [abovePill(WIDTH * 0.16, HEIGHT * 0.5), glass, block] } };
}

/* ---------------------------------------------------------------- Pixels */

/** RGBA PNG → RGB underlaid with test page background color (full frame of export page has transparent background, stage screenshot is overlaid on test page background color) */
function rgbOver(buf, bg = [0x20, 0x20, 0x20]) {
  const png = PNG.sync.read(buf);
  const out = new Uint8Array(png.width * png.height * 3);
  for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) {
    const a = png.data[i + 3] / 255;
    for (let k = 0; k < 3; k++) out[j + k] = Math.round(png.data[i + k] * a + bg[k] * (1 - a));
  }
  return { width: png.width, height: png.height, rgb: out };
}
/** Difference between two RGB images in a rectangle: average difference (out of 255), and fraction of pixels with max channel difference exceeding 48 */
function rectDiff(a, b, rect) {
  if (a.width !== b.width || a.height !== b.height) return { mean: Infinity, bad: 1 };
  let sum = 0, bad = 0, n = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let i = (y * a.width + rect.x) * 3, end = i + rect.w * 3; i < end; i += 3) {
      const d0 = Math.abs(a.rgb[i] - b.rgb[i]), d1 = Math.abs(a.rgb[i + 1] - b.rgb[i + 1]), d2 = Math.abs(a.rgb[i + 2] - b.rgb[i + 2]);
      sum += d0 + d1 + d2; n += 3;
      if (d0 > 48 || d1 > 48 || d2 > 48) bad++;
    }
  }
  return { mean: sum / Math.max(1, n), bad: bad / Math.max(1, n / 3) };
}
const toPng = (img) => { const png = new PNG({ width: img.width, height: img.height }); for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) { png.data[i] = img.rgb[j]; png.data[i + 1] = img.rgb[j + 1]; png.data[i + 2] = img.rgb[j + 2]; png.data[i + 3] = 255; } return PNG.sync.write(png); };
const clampRect = (r) => { const x = Math.max(0, Math.round(r.x)), y = Math.max(0, Math.round(r.y)); return { x, y, w: Math.max(0, Math.min(WIDTH, Math.round(r.x + r.w)) - x), h: Math.max(0, Math.min(HEIGHT, Math.round(r.y + r.h)) - y) }; };
const intersect = (a, b) => { const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y); return { x, y, w: Math.min(a.x + a.w, b.x + b.w) - x, h: Math.min(a.y + a.h, b.y + b.h) - y }; };
const shuffled = (from, to) => { const order = []; for (let f = from; f <= to; f++) order.push(f); for (let i = 0; i < order.length; i++) { const j = (i * 37 + 11) % order.length; [order[i], order[j]] = [order[j], order[i]]; } return order; };

const hostHtml = (oa) => `<!doctype html><html><head><meta charset="utf-8"><title>stream below stage probe host</title></head>
<body style="margin:0;background:#202020">
<iframe id="a" src="${oa}/?stage=1&id=A&preview=stage&prerender=1" style="width:${WIDTH}px;height:${HEIGHT}px;border:0;display:block"></iframe>
<script type="module">
function createStageRpc(target, targetOrigin) {
  let nextId = 1; const pending = new Map(); const listeners = new Set();
  window.addEventListener('message', (e) => {
    if (e.source !== target) return; const d = e.data;
    if (d && d.type === 'pc-rpc-reply') { const p = pending.get(d.id); if (!p) return; pending.delete(d.id); d.ok ? p.resolve(d.result) : p.reject(new Error(d.error)); return; }
    if (d && typeof d.type === 'string' && ['mediaReady', 'frame', 'ended', 'settled'].includes(d.type)) for (const l of listeners) l(d);
  });
  const call = (method) => (...args) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); target.postMessage({ type: 'pc-rpc', id, method, args }, targetOrigin); });
  const c = { onEvent: (l) => { listeners.add(l); return () => listeners.delete(l); } };
  for (const m of ['setProject', 'setTime', 'setRole', 'play', 'pause', 'setSuppressed', 'setStreamPlanes', 'setPlaying', 'setScrubbing', 'setMediaT']) c[m] = call(m);
  return c;
}
window.__frames = [];
const frame = document.getElementById('a');
window.__ready = new Promise((res) => {
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.data?.type !== 'pc-stage-ready') return;
    const rpc = createStageRpc(frame.contentWindow, '${oa}');
    rpc.onEvent((ev) => { if (ev.type === 'frame') window.__frames.push({ sec: ev.sec, at: performance.now() }); });
    window.__rpc = rpc;
    res(true);
  });
});
</script></body></html>`;

const out = { out: OUT, size: `${WIDTH}x${HEIGHT}`, switchDefault: BELOW_STREAMS_DEFAULT, runs: [] };
await fs.mkdir(OUT, { recursive: true });
let dev = null, media = null, bakery = null, browser = null, hostServer = null;
const pipelines = [];
const current = { producer: null };
const started = Date.now();
try {
  check(BELOW_STREAMS_DEFAULT === true && belowStreamsEnabled({}) === true, 'streams that depend on the layers below are on by default (the probe did not enable anything extra)', BELOW_STREAMS_DEFAULT);
  const ffmpeg = await findFfmpeg();
  let origin = ORIGIN;
  if (!origin) {
    process.env.PROMPTCUT_EXPORT_DIR = path.join(OUT, 'export');
    await fs.mkdir(process.env.PROMPTCUT_EXPORT_DIR, { recursive: true });
    dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'belowstage' });
    origin = dev.origin;
    say('spawn', { pid: dev.pid, port: PORT });
  }
  origin = origin.replace(/\/+$/, '');
  out.origin = origin;
  const mediaDir = path.join(OUT, 'media');
  await fs.mkdir(mediaDir, { recursive: true });
  media = await serveMedia(MEDIA_PORT, mediaDir);
  const mediaUrl = media.url(path.basename(await taggedVideo(ffmpeg, mediaDir)));

  // Bing: first create that user card via real card creation API (before stage page and export page load)
  if (SCENES.includes('u')) {
    const r = await fetch(origin + '/api/cards/create', { method: 'POST', headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ id: USER_CARD, source: USER_SOURCE, projectId: `below-stage-u-${RUN}` }), signal: AbortSignal.timeout(60_000) });
    const body = await r.json().catch(() => null);
    out.userCard = { id: USER_CARD, status: r.status, ok: body?.ok ?? null, errors: r.status === 200 ? undefined : (body?.errors ?? [body?.error]).slice?.(0, 6) };
    if (!check(r.status === 200 && body?.ok === true, 'C: user card created (POST /api/cards/create returns 200)', out.userCard)) throw new Error('The user card was not created');
  }

  /* ------------------------------------------------------------ Stage (one instance, shared across scenes in turn) */
  const ports = await (await fetch(origin + '/api/stage/ports')).json();
  if (!ports.ok || !Array.isArray(ports.ports) || ports.ports.length < 1) throw new Error(`Stage ports did not come up: ${JSON.stringify(ports)}`);
  const u = new URL(origin);
  const originA = `${u.protocol}//${u.hostname}:${ports.ports[0]}`;
  const HOST_PATH = '/__stream-below-stage-probe-host';
  hostServer = await serve(HOST_PORT, (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (url.pathname === HOST_PATH) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(hostHtml(originA)); return; }
    // Address prefix `/s<n>/`: switching prefix avoids browser cache; `/d<n>/`: each segment's
    // bytes additionally wait 80 ms (item G)
    const m = /^\/(?:([sd])\d+\/)?api\/frames(\/.*)$/.exec(url.pathname);
    const go = () => { if (!m || !current.producer || !handleStreamRequest(current.producer.store, req, res, m[2])) { res.statusCode = 404; res.end(); } };
    if (m && m[1] === 'd' && /\/seg\//.test(m[2])) setTimeout(go, 80); else go();
  }, '127.0.0.1');
  const base = `http://127.0.0.1:${hostServer.address().port}`;
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required',
      '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  await page.goto(base + HOST_PATH);
  await page.waitForFunction(() => window.__ready, { timeout: 180000 });
  await page.evaluate(() => window.__ready);
  const frameA = () => page.frames().find((f) => f.url().startsWith(originA));
  const rpc = (method, ...a) => page.evaluate((m, a2) => window.__rpc[m](...a2), method, a);
  const iframeBox = await (await page.$('#a')).boundingBox();
  const shotStage = async () => {
    await frameA().evaluate(() => new Promise((r) => (window.__pcRealRaf ?? requestAnimationFrame)(() => (window.__pcRealRaf ?? requestAnimationFrame)(() => r()))));
    await page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: WIDTH, height: HEIGHT } });
    return rgbOver(await page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: WIDTH, height: HEIGHT } }));
  };
  const diagA = () => frameA().evaluate(() => {
    const d = window.__pcStageDiag();
    return { t: d.t, suppressed: d.suppressed, parentSuppressed: d.parentSuppressed, streamWaiting: d.streamWaiting, placeholders: d.placeholders, snapshots: d.snapshots,
      planes: d.streamPlanes.map((p) => ({ clipIds: p.clipIds, plane: p.plane })),
      tracks: d.streams.tracks.map((t) => ({ id: t.id.split('#')[0], lastDrawn: t.lastDrawn, picture: t.picture, level: t.level, stale: t.stale, plane: t.plane, kind: t.kind, fits: t.fits, errors: t.errors, lastError: t.lastError, bound: t.bound })) };
  });
  const emptyUrl = emptyUrlOf(origin, { width: WIDTH, height: HEIGHT });
  bakery = await openBakery({ url: emptyUrl });
  /** Export page frame by frame (full frame), returns frame number → PNG bytes */
  const exportAll = async (project, tag) => {
    await bakery.reset(project, emptyUrl);
    bakery.streamLease = null;
    const frames = new Map();
    const dir = path.join(OUT, `ref-${tag}`);
    await fs.mkdir(dir, { recursive: true });
    await bakeFrames(bakery, { out: dir, fps: FPS, frames: `0-${LAST}`, fullFrame: true, format: 'png', warm: 3, staticSkip: false, quiet: true, writeFrames: false,
      onFrame: async (i, buf) => { frames.set(i, Buffer.from(buf)); } });
    return frames;
  };

  let slot = 0;
  for (const kind of SCENES) {
    const tag = SCENE_NAME[kind];
    const run = { scene: tag };
    out.runs.push(run);
    const sc = scene(kind, { mediaUrl });
    const { project, target, cards } = sc;
    const targetClip = project.tracks.flatMap((t) => t.clips).find((c) => c.id === target);
    const FIRST = Math.ceil(targetClip.start * FPS - 1e-9), TLAST = Math.min(LAST, Math.ceil(targetClip.end * FPS - 1e-9) - 1);
    run.target = { clip: target, firstFrame: FIRST, lastFrame: TLAST };
    check(FIRST % SEG !== 0, `${tag}: the target card does not start on a frame that is a multiple of 15`, FIRST);

    /* ---------- Stream production: produce only the sparse pass first */
    const pipeline = new FramePipeline({ root: path.join(OUT, `lib-${kind}`), origin: () => origin, interactive: true, playhead: () => null });
    pipelines.push(pipeline);
    pipeline.streamPicked = () => true; // Pin all as heavy cards
    const producer = pipeline.streamProducer();
    producer.attachRoute();
    current.producer = producer;
    let holdDense = true;
    const nextTask = producer.nextTask.bind(producer);
    producer.nextTask = (b) => { const task = nextTask(b); return task && task.stride === 1 && holdDense ? null : task; };
    const layerByClip = new Map();
    const layerLog = [];
    pipeline.readyIndex.subscribe((message) => {
      if (message.type === 'reset') { layerByClip.clear(); layerLog.push({ type: 'reset' }); }
      if (message.type === 'layer' && message.kind === 'stream') { layerByClip.set(message.clipId, message); layerLog.push({ type: 'layer', clipId: message.clipId, key: message.key }); }
    });
    const idle = () => !producer.workers.size && !producer.encoding.size;
    const stateOf = (clipId) => [...producer.streams.values()].find((s) => s.spec.clipIds.length === 1 && s.spec.clipIds[0] === clipId) ?? null;
    const stridesOf = (clipId) => { const s = stateOf(clipId); return s ? Array.from({ length: s.spec.lastSegment + 1 }, (_, n) => s.manifest.segments[n]?.stride ?? 0) : []; };
    const t0 = Date.now();
    await pipeline.preload(project);
    const sparseOk = await until(`${tag}: the sparse version covers all segments`, () => (producer.streams.size >= cards.length && idle() && cards.every((id) => { const st = stridesOf(id); return st.length && st.every((s) => s >= 1); }) ? true : null), 900_000, 300);
    if (!sparseOk) throw new Error(`${tag}: the sparse pass did not finish: ${JSON.stringify(producer.status().log?.slice(-6))}`);
    run.sparseMs = Date.now() - t0;
    const spec0 = stateOf(target).spec;
    run.stream = { kind: spec0.kind, plane: spec0.plane, key: spec0.streamKey.slice(0, 12), originFrame: spec0.originFrame, lastSegment: spec0.lastSegment, belowClipIds: spec0.belowClipIds, replay: spec0.replay,
      others: cards.filter((id) => id !== target).map((id) => `${stateOf(id)?.spec.kind}:${id}`) };
    say('sparse-ready', { scene: tag, ms: run.sparseMs, ...run.stream });

    /* ---------- 0. Planning and layer dispatch */
    const layer0 = layerByClip.get(target);
    const sig0 = streamInputSig(project, { clipIds: [target], kind: 'below' });
    run.layer = { streamKind: layer0?.streamKind ?? null, inputSig: layer0?.inputSig ?? null, pageSig: sig0, originFrame: layer0?.originFrame ?? null };
    check(spec0.kind === 'below' && spec0.plane === 'stage' && spec0.originFrame === FIRST, `${tag}: the target card has a stream that depends on the layers below (stage coordinates), and its first frame is the card's own first frame`, run.stream);
    check(layer0?.streamKind === 'below' && typeof sig0 === 'string' && layer0.inputSig === sig0, `${tag}: the layer sent to the page carries the kind and input signature, and the signature is the one computed from the same project`, run.layer);
    if (sc.tilted) {
      const f3 = targetClip.frame ?? {};
      check(!!(f3.rotateX && f3.rotateY && f3.translateZ) && project.camera3dFov > 0 && !('solo' in spec0), `${tag}: the target card's frame has 3D properties and the project has perspective enabled, so the stream produced is the one that depends on the layers below (not the standalone kind)`, { frame: f3, fov: project.camera3dFov, solo: spec0.solo ?? null });
    }
    check(cards.filter((id) => id !== target).every((id) => stateOf(id)?.spec.kind === 'card' && layerByClip.get(id) && !('streamKind' in layerByClip.get(id)) && !('inputSig' in layerByClip.get(id))),
      `${tag}: the other cards use single-card streams, and their layers do not carry these two fields`, run.stream.others);
    /** Parent page behavior (`streamLayers` in `snapshotFeed.ts`): stream plane for below-dependent layer carries `plane: "stage"` */
    const layers = () => [...layerByClip.values()].map((l) => (l.streamKind === 'below' ? { ...l, plane: 'stage' } : l));
    const planesAt = (f) => streamPlanesFor(layers(), new Set(cards), f);
    const membersOf = (planes) => [...new Set(planes.flatMap((p) => p.clipIds))].sort();
    const pictureOf = (clipId, f) => {
      const state = stateOf(clipId);
      const o = state.spec.originFrame;
      const n = streamSegmentOf(f, o);
      const stride = state.manifest.segments[n]?.stride ?? 1;
      const start = streamSegmentFirstFrame(n, o);
      return stride > 1 && SEG % stride === 0 ? start + Math.floor((f - start) / stride) * stride : f;
    };

    /* ---------- Switch stage to this scene */
    slot++;
    await frameA().evaluate((b) => { window.__pcStreamBase = b; }, `${base}/s${slot}`);
    await rpc('setStreamPlanes', []);
    await rpc('setSuppressed', []);
    await rpc('setProject', project, { reset: true });
    await rpc('setRole', 'front');
    await rpc('setTime', FIRST / FPS + 1e-4);
    /**
     * Set time to frame f following parent page behavior: send stream plane first, then suppression,
     * then set time; then send no more messages, waiting in stage for each stream to render the frame
     * it should render, and video (if any) to scrub into place. Returns milliseconds from setting time
     * to rendering, and placeholders displayed at that moment.
     */
    const seekTo = async (f, { scrubbing = false } = {}) => {
      const planes = planesAt(f);
      const want = Object.fromEntries(membersOf(planes).map((id) => [id, pictureOf(id, f)]));
      await rpc('setStreamPlanes', planes);
      await rpc('setSuppressed', membersOf(planes));
      const got = await frameA().evaluate(async (frame, fps, want, hasVideo) => {
        const now = window.__pcRealNow ?? (() => performance.now());
        const wait = (ms) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, ms));
        const t0 = now();
        const sec = frame / fps + 1e-4;
        // Timestamp tracked by media layer (video) is sent separately by parent page (sends `setMediaT`
        // following store t in `Preview`)
        if (hasVideo) void window.__pcStage.setMediaT(sec);
        await window.__pcStage.setTime(sec);
        const ids = Object.keys(want);
        let nudged = 0;
        for (;;) {
          const d = window.__pcStageDiag();
          const of = (id) => d.streams.tracks.find((t) => t.id.split('#')[0] === id);
          const videos = hasVideo ? [...document.querySelectorAll('video')].filter((v) => v.currentSrc || v.src) : [];
          const videoOk = !hasVideo || (videos.length > 0 && videos.every((v) => !v.seeking) && videos.some((v) => v.readyState >= 2 && Math.abs(v.currentTime - sec) < 0.4 / fps));
          // Paused video is no longer scrubbed if within 0.03 s of target (`PAUSED_SEEK_SEC` in `mediaSync.ts`,
          // tolerance in production): pausing after playback may be off by exactly one frame.
          // The probe compares pixels frame by frame, so it first scrubs away slightly and then scrubs back
          if (hasVideo && !videoOk && nudged < 3 && now() - t0 > 400 * (nudged + 1) && videos.every((v) => !v.seeking)) {
            nudged++;
            await window.__pcStage.setMediaT(Math.max(0, sec - 0.5));
            await wait(120);
            await window.__pcStage.setMediaT(sec);
          }
          if (videoOk && ids.every((id) => of(id) && of(id).picture === want[id] && !of(id).stale)) {
            const ms = +(now() - t0).toFixed(1);
            await wait(0);
            const after = window.__pcStageDiag();
            return { ms, placeholders: after.placeholders, levels: Object.fromEntries(ids.map((id) => [id, of(id).level])), waiting: after.streamWaiting };
          }
          if (now() - t0 > 10000) return { ms: null, videoOk, videos: videos.map((v) => [v.currentTime, v.readyState, v.seeking]), tracks: d.streams.tracks.map((t) => ({ id: t.id.split('#')[0], lastDrawn: t.lastDrawn, picture: t.picture, stale: t.stale, fits: t.fits, err: t.lastError })) };
          await wait(2);
        }
      }, f, FPS, want, sc.hasVideo && !scrubbing);
      return { planes, want, got };
    };

    /* ---------- A. Sparse version only */
    {
      const rec = { frames: 0, bad: [] };
      for (const f of [FIRST, FIRST + 1, FIRST + SEG - 1, FIRST + SEG, FIRST + SEG + 7, TLAST]) {
        const { want, got } = await seekTo(f);
        rec.frames++;
        if (got.ms === null || got.levels[target] !== 'sparse' || want[target] > f || got.placeholders.length) rec.bad.push({ frame: f, want: want[target], got });
      }
      run.sparse = { strides: stridesOf(target), ...rec };
      say('A-sparse', { scene: tag, ...run.sparse });
      check(run.sparse.strides.every((s) => s > 1), `${tag}: only the sparse version exists at first`, run.sparse.strides);
      check(rec.bad.length === 0, `${tag}: with only the sparse version, what is pasted is the nearest frame not later than this one, the stage reports the sparse level, and there are no placeholders`, rec.bad.slice(0, 3));
    }
    holdDense = false;
    producer.kick();
    const t1 = Date.now();
    const denseOk = await until(`${tag}: all segments at full density`, () => (idle() && cards.every((id) => stridesOf(id).every((s) => s === 1)) ? true : null), 900_000, 500);
    if (!denseOk) throw new Error(`${tag}: the full-density pass did not finish: ${JSON.stringify(producer.status().log?.slice(-6))}`);
    run.denseMs = Date.now() - t1;
    const manifest = stateOf(target).manifest;
    const tight = clampRect(manifest.tight ?? manifest.bound);
    run.stream.bound = manifest.bound; run.stream.tight = manifest.tight;
    run.stream.capture = producer.status().streams.find((s) => s.kind === 'below')?.below ?? null;
    say('dense-ready', { scene: tag, ms: run.denseMs, tight });
    check(!run.stream.capture?.failed, `${tag}: differential layer extraction was not marked as failed`, run.stream.capture);

    /* ---------- Reference: export page frame by frame */
    const exported = await exportAll(project, kind);
    const exportRgb = new Map();
    const exportOf = (f, from = exported, cache = exportRgb) => { if (!cache.has(f)) { cache.set(f, rgbOver(from.get(f))); if (cache.size > 24) cache.delete(cache.keys().next().value); } return cache.get(f); };
    say('exported', { scene: tag, frames: exported.size });
    /**
     * Which frame of export page this stage screenshot matches best within rectangle. `self` is the
     * frame it should be: counted as closest match if its difference exceeds minimum difference by at
     * most `tieOf` (for still frames or final frames of entrance animation, adjacent frames are nearly
     * pixel-by-pixel identical to it, with differences smaller than encoding noise, indistinguishable
     * in order; `tie` records this case), returned `mean` / `bad` are relative to `self`. Tolerance is
     * 5% of its own difference, at least 0.05 (out of 255).
     */
    const tieOf = (mean) => Math.max(0.05, mean * 0.05);
    const score = (stage, rect, candidates, of = exportOf, self = candidates[Math.floor(candidates.length / 2)]) => {
      const scores = [...new Set(candidates)].filter((c) => c >= 0 && c <= LAST).map((c) => [c, rectDiff(stage, of(c), rect)]);
      const sorted = [...scores].sort((x, y) => x[1].mean - y[1].mean);
      const own = scores.find(([c]) => c === self) ?? sorted[0];
      const others = sorted.filter(([c]) => c !== own[0]);
      const wins = own[1].mean <= sorted[0][1].mean + tieOf(own[1].mean);
      return { best: wins ? own[0] : sorted[0][0], mean: round2(own[1].mean), bad: round2(own[1].bad * 100), runnerUp: others[0] ? round2(others[0][1].mean) : null,
        tie: wins && !!others[0] && others[0][1].mean <= own[1].mean + tieOf(own[1].mean), scores: scores.map(([c, d]) => [c, round2(d.mean)]) };
    };

    /* ---------- B. Where plane is mounted */
    {
      const f = Math.min(TLAST - 3, FIRST + 41);
      await seekTo(f);
      const dom = await frameA().evaluate((id) => {
        const wrap = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`);
        const plane = document.querySelector(`canvas[data-pc-group-plane][data-pc-stream-group="${id}"]`);
        const stage = wrap?.closest('.pc-stage') ?? null;
        const live = wrap ? [...wrap.children].filter((el) => !el.hasAttribute('data-pc-placeholder-slot')) : [];
        const cs = plane ? getComputedStyle(plane) : null;
        return {
          wrapper: !!wrap, cls: wrap?.className ?? null, member: !!wrap?.hasAttribute('data-pc-stream-member'),
          canvasInWrapper: !!wrap?.querySelector(':scope > canvas[data-pc-stream-plane]'),
          plane: !!plane, planeInSameStage: !!plane && plane.parentElement === stage, planeInsideWrapper: !!plane && !!wrap?.contains(plane),
          planeDisplay: cs?.display ?? null, planeZ: cs?.zIndex ?? null, wrapperZ: wrap ? getComputedStyle(wrap).zIndex : null, pointerEvents: cs?.pointerEvents ?? null,
          planeBox: plane ? { left: plane.style.left, top: plane.style.top, width: plane.style.width, height: plane.style.height, w: plane.width, h: plane.height } : null,
          liveHidden: live.length > 0 && live.every((el) => getComputedStyle(el).display === 'none'),
          planes: document.querySelectorAll(`canvas[data-pc-group-plane][data-pc-stream-group="${id}"]`).length,
        };
      }, target);
      const d = await diagA();
      const track = d.tracks.find((t) => t.id === target);
      run.dom = { frame: f, ...dom, track: track && { plane: track.plane, kind: track.kind, fits: track.fits, picture: track.picture }, sentPlane: d.planes.find((p) => p.clipIds[0] === target) };
      say('B-dom', { scene: tag, ...run.dom });
      const b = manifest.bound;
      check(dom.wrapper && !dom.canvasInWrapper && dom.plane && dom.planes === 1 && dom.planeInSameStage && !dom.planeInsideWrapper, `${tag}: the stream plane's canvas is under the stage root (the same stage as the wrapper layer), not inside the wrapper layer`, dom);
      check(dom.planeDisplay !== 'none' && dom.planeZ === dom.wrapperZ && dom.pointerEvents === 'none', `${tag}: the plane is visible, has the same layer order as this card's layer, and does not receive pointer events`, dom);
      check(dom.planeBox && dom.planeBox.left === `${b.x}px` && dom.planeBox.top === `${b.y}px` && dom.planeBox.w === b.w && dom.planeBox.h === b.h, `${tag}: the plane is placed at the manifest's stage coordinates`, { planeBox: dom.planeBox, bound: b });
      check(/pc-suppressed/.test(dom.cls ?? '') && dom.liveHidden && dom.member, `${tag}: the target card's wrapper layer is suppressed (subtree hidden), and clicking it falls back to the wrapper layer's box`, dom);
      check(track?.plane === 'stage' && track.kind === 'below' && track.fits === true && run.dom.sentPlane?.plane === 'stage', `${tag}: the player recognizes this as a stream in stage coordinates`, run.dom);
      if (sc.tilted) {
        // Plane itself carries no transform (stage perspective only applies to direct child elements with 3D
        // transform): its box on screen is manifest rectangle; wrapper layer carries 3D matrix
        const flat = await frameA().evaluate((id) => {
          const wrap = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`);
          const plane = document.querySelector(`canvas[data-pc-group-plane][data-pc-stream-group="${id}"]`);
          const root = plane?.parentElement?.getBoundingClientRect();
          const box = plane?.getBoundingClientRect();
          return { planeTransform: plane ? getComputedStyle(plane).transform : null, wrapperTransform: wrap ? getComputedStyle(wrap).transform.slice(0, 9) : null,
            // Perspective is attached to wrapper layer's parent element (the AnimClock layer in `Stage.tsx`);
            // stream plane is under stage root, not its child element
            perspective: wrap?.parentElement ? getComputedStyle(wrap.parentElement).perspective : null, planeUnderPerspective: !!plane && !!wrap?.parentElement && plane.parentElement === wrap.parentElement,
            screen: box && root ? { x: box.left - root.left, y: box.top - root.top, w: box.width, h: box.height } : null, css: plane ? { w: parseFloat(plane.style.width), h: parseFloat(plane.style.height), l: parseFloat(plane.style.left), t: parseFloat(plane.style.top) } : null };
        }, target);
        run.dom.tilt = flat;
        check(flat.planeTransform === 'none' && flat.wrapperTransform === 'matrix3d(' && flat.perspective && flat.perspective !== 'none', `${tag}: the wrapper layer has a 3D matrix and the stage has perspective, while the stream plane itself has no transform`, flat);
        check(flat.screen && flat.css && Math.abs(flat.screen.x - flat.css.l) < 0.51 && Math.abs(flat.screen.y - flat.css.t) < 0.51 && Math.abs(flat.screen.w - flat.css.w) < 0.51 && Math.abs(flat.screen.h - flat.css.h) < 0.51, `${tag}: the stream plane's box on screen is the box in its style (not distorted by perspective)`, flat);
      }
    }

    /* ---------- C. Full density: jump to any frame while paused, compare frame by frame */
    {
      const rec = { frames: 0, wrong: [], notDrawn: [], placeholders: [], same: 0, next: 0, n: 0, sameBad: 0, ms: [], above: 0, aboveN: 0, aboveWrong: [], notDense: [], ties: 0 };
      // Intersection of pill pressed on top and the area modified by target card (pill enters at 0.5 s)
      const pillBox = await (async () => {
        await seekTo(Math.min(TLAST - 2, 60));
        const r = await frameA().evaluate(() => { const el = document.querySelector('[data-pc-clip="clip-above"] canvas[data-pc-stream-plane]'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
        return r ? clampRect(r) : null;
      })();
      const overlap = pillBox ? intersect(pillBox, tight) : { w: 0, h: 0 };
      run.above = { pillBox, overlap };
      check(overlap.w > 20 && overlap.h > 10, `${tag}: the pill on top really falls inside the region the target card changed (this scene is set up correctly)`, run.above);
      for (const f of shuffled(FIRST, TLAST)) {
        const { got } = await seekTo(f);
        if (got.ms === null) { rec.notDrawn.push({ frame: f, ...got }); continue; }
        rec.ms.push(got.ms);
        if (got.placeholders.length) rec.placeholders.push({ frame: f, placeholders: got.placeholders });
        if (got.levels[target] !== 'dense') rec.notDense.push({ frame: f, level: got.levels[target] });
        const stage = await shotStage();
        const r = score(stage, tight, [f - 2, f - 1, f, f + 1, f + 2]);
        if (r.best !== f) rec.wrong.push({ frame: f, ...r });
        if (r.tie) rec.ties++;
        rec.same += r.mean; rec.next += r.runnerUp ?? 0; rec.n++;
        rec.sameBad = Math.max(rec.sameBad, r.best === f ? r.bad : 0);
        if (f >= 20 && overlap.w > 20 && overlap.h > 10) {
          const a = score(stage, overlap, [f - 1, f, f + 1]);
          rec.above += a.mean; rec.aboveN++;
          if (a.best !== f || a.mean > 8) rec.aboveWrong.push({ frame: f, ...a });
        }
        rec.frames++;
        if (f === FIRST + 41 || f === FIRST + 2) { await fs.writeFile(path.join(OUT, `${kind}-stage-${f}.png`), toPng(stage)); await fs.writeFile(path.join(OUT, `${kind}-export-${f}.png`), toPng(exportOf(f))); }
      }
      const sorted = [...rec.ms].sort((x, y) => x - y);
      run.dense = { frames: rec.frames, wrongCount: rec.wrong.length, wrong: rec.wrong.slice(0, 5), notDrawn: rec.notDrawn.slice(0, 3), placeholdersLeft: rec.placeholders.slice(0, 3), notDense: rec.notDense.slice(0, 3),
        meanDiffVsExportSameFrame: round2(rec.same / Math.max(1, rec.n)), vsMostSimilarAdjacentFrame: round2(rec.next / Math.max(1, rec.n)), maxPercentPixelsOver48InSameFrame: rec.sameBad,
        stillFramesWithAmbiguousOrder: rec.ties,
        pillRegionAboveVsSameFrame: rec.aboveN ? round2(rec.above / rec.aboveN) : null, pillRegionMismatchedFrames: rec.aboveWrong.slice(0, 3),
        frameSkipMs: sorted.length ? { n: sorted.length, median: sorted[sorted.length >> 1], max: sorted.at(-1) } : null };
      say('C-dense', { scene: tag, ...run.dense });
      check(rec.notDrawn.length === 0 && rec.frames === TLAST - FIRST + 1, `${tag}: each of frames ${FIRST}-${TLAST} pasted exactly that frame`, { frames: rec.frames, notDrawn: rec.notDrawn.slice(0, 2) });
      check(rec.notDense.length === 0, `${tag}: everything pasted is from the full-density level`, rec.notDense.slice(0, 3));
      check(rec.wrong.length === 0, `${tag}: when paused and jumping to any frame, the picture most similar to the one composited with the lower layers is always the same frame of the export page`, { wrong: rec.wrong.length, first: rec.wrong.slice(0, 3) });
      check(run.dense.meanDiffVsExportSameFrame < 4, `${tag}: the difference from the same frame of the export page is on the order of encoding error (mean difference below 4, out of 255)`, run.dense);
      check(rec.aboveWrong.length === 0, `${tag}: the layers above still cover the stream plane as usual (the pill region matches the same frame of the export page)`, rec.aboveWrong.slice(0, 3));
      check(rec.placeholders.length === 0, `${tag}: no placeholder is left hanging at the moment it is drawn`, rec.placeholders.slice(0, 3));
    }

    /* ---------- D. Scrub: step every 16 ms without waiting for render */
    {
      const span = TLAST - FIRST;
      const path16 = [...Array.from({ length: 14 }, (_, i) => FIRST + 1 + Math.round((i * (span - 4)) / 13)), ...Array.from({ length: 10 }, (_, i) => TLAST - 2 - Math.round((i * (span - 6)) / 9)), FIRST + 23, FIRST + 4, TLAST - 9, FIRST + 31];
      await seekTo(path16[0]);
      await rpc('setScrubbing', true);
      const fast = await frameA().evaluate(async (steps, fps, id) => {
        const now = window.__pcRealNow ?? (() => performance.now());
        const wait = (ms) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, ms));
        const track = () => window.__pcStageDiag().streams.tracks.find((t) => t.id.split('#')[0] === id);
        const seen = new Set();
        let empty = 0;
        for (const f of steps) {
          void window.__pcStage.setTime(f / fps + 1e-4);
          await wait(16);
          const t = track();
          if (t && t.lastDrawn !== null) seen.add(t.lastDrawn); else empty++;
        }
        const last = steps[steps.length - 1];
        const t0 = now();
        let settleMs = null;
        for (;;) {
          const t = track();
          if (t && t.lastDrawn === last && !t.stale) { settleMs = +(now() - t0).toFixed(1); break; }
          if (now() - t0 > 8000) break;
          await wait(2);
        }
        return { steps: steps.length, distinctDrawn: seen.size, emptySamples: empty, settleMs, placeholders: window.__pcStageDiag().placeholders };
      }, path16, FPS, target);
      await rpc('setScrubbing', false);
      const last = path16.at(-1);
      await seekTo(last);   // Other layers (respective streams, video) also reach this frame
      const r = score(await shotStage(), tight, [last - 2, last - 1, last, last + 1, last + 2]);
      run.drag = { ...fast, last, best: r.best, mean: r.mean, runnerUp: r.runnerUp };
      say('D-drag', { scene: tag, ...run.drag });
      check(fast.settleMs !== null && r.best === last, `${tag}: drag: after stopping, the last frame is drawn`, run.drag);
      check(fast.distinctDrawn >= 5 && fast.emptySamples === 0 && fast.placeholders.length === 0, `${tag}: drag: the picture follows all the way, with no empty moments and no placeholders`, run.drag);
    }

    /* ---------- E. Playback; pause during playback */
    {
      const f0 = FIRST + 9;
      await seekTo(f0);
      await frameA().evaluate(() => { window.__pcFallbackTrace = []; });
      await page.evaluate(() => { window.__frames = []; });
      await rpc('setStreamPlanes', planesAt(f0));
      await rpc('setSuppressed', cards);
      await rpc('setPlaying', true);
      await rpc('play', f0 / FPS + 1e-4);
      await sleep(700);
      const stop = await rpc('pause');
      await rpc('setPlaying', false);
      const stopped = Math.round(stop.stoppedAt * FPS);
      const trace = await frameA().evaluate(() => { const t = window.__pcFallbackTrace.splice(0); delete window.__pcFallbackTrace; return t; });
      const beats = trace.map((b) => ({ frame: Math.round(b.sec * 30), level: b.levels[target] ?? null }));
      const bad = beats.filter((b) => b.frame >= FIRST && b.frame <= TLAST && b.level !== 'dense');
      await until(`${tag}: the paused frame is drawn`, async () => { const d = await diagA(); const t = d.tracks.find((x) => x.id === target); return t && t.lastDrawn === stopped ? d : null; }, 5000, 50);
      await seekTo(stopped);
      const frames = await page.evaluate(() => window.__frames);
      const steps = frames.slice(1).map((x, i) => +(x.sec - frames[i].sec).toFixed(6));
      const r = score(await shotStage(), tight, [stopped - 2, stopped - 1, stopped, stopped + 1, stopped + 2]);
      run.play = { from: f0, stoppedAt: stopped, beats: beats.length, firstBeat: beats[0] ?? null, notDense: bad.slice(0, 5), noSkip: steps.every((s) => Math.abs(s - 1 / FPS) < 1e-6), best: r.best, mean: r.mean, runnerUp: r.runnerUp };
      say('E-play', { scene: tag, ...run.play });
      check(beats.length >= 5 && bad.length === 0, `${tag}: playback: from the first tick on, the target card shows the full-density stream's picture on every tick (no empty ticks)`, { beats: beats.length, first: beats[0], bad: bad.slice(0, 3) });
      check(run.play.noSkip && stopped > f0 + 3 && stopped <= TLAST, `${tag}: playback: no frame skipping, stops on a frame where the target card is present`, run.play);
      check(r.best === stopped, `${tag}: pause during playback: the stopped frame pastes that very frame`, r);
    }

    /* ---------- F. Modify one place in lower layer: old stream expires, re-produce, verify again */
    {
      const ed = scene(kind, { mediaUrl, edited: true });
      const sig1 = streamInputSig(ed.project, { clipIds: [target], kind: 'below' });
      const key0 = spec0.streamKey;
      const rec = { oldSig: layer0.inputSig, newPageSig: sig1, staleOld: streamSigStale(layer0.inputSig, sig1) };
      check(rec.staleOld === true, `${tag}: after one change in the lower layer: the signature carried by the old layer does not match the one computed from the new project (so the parent page does not paste the old stream)`, rec);
      const mark = layerLog.length;
      const t2 = Date.now();
      await pipeline.preload(ed.project);
      const again = await until(`${tag}: the new stream at full density`, () => {
        const s = stateOf(target);
        return s && s.spec.streamKey !== key0 && idle() && cards.every((id) => stridesOf(id).length && stridesOf(id).every((x) => x === 1)) ? s : null;
      }, 900_000, 500);
      if (!again) throw new Error(`${tag}: the new stream was not produced after the lower layer was changed`);
      rec.reproduceMs = Date.now() - t2;
      const layer1 = layerByClip.get(target);
      const since = layerLog.slice(mark);
      rec.newKey = again.spec.streamKey.slice(0, 12); rec.oldKey = key0.slice(0, 12);
      rec.newLayer = { key: layer1?.key.slice(0, 12), streamKind: layer1?.streamKind ?? null, inputSig: layer1?.inputSig ?? null };
      rec.oldKeySentAfterReset = (() => { const at = since.findIndex((e) => e.type === 'reset'); return since.slice(Math.max(0, at)).some((e) => e.type === 'layer' && e.clipId === target && e.key === key0); })();
      check(again.spec.streamKey !== key0 && layer1?.key === again.spec.streamKey, `${tag}: after the lower layer changed, the stream key changed and the page was sent the new key`, rec);
      check(layer1?.streamKind === 'below' && layer1.inputSig === sig1 && !streamSigStale(layer1.inputSig, sig1), `${tag}: the new layer carries the signature computed from the new project (the parent page accepts it)`, rec.newLayer);
      check(since.some((e) => e.type === 'reset') && !rec.oldKeySentAfterReset, `${tag}: after the prerender process switched versions, the table was cleared and the old key is no longer sent`, { events: since.slice(0, 8) });
      // Paste new stream, compare against export page of new project; control: comparison against
      // export page of old project must be significantly worse
      const exported1 = await exportAll(ed.project, `${kind}-edited`);
      const cache1 = new Map();
      const exportOf1 = (f) => exportOf(f, exported1, cache1);
      const tight1 = clampRect(again.manifest.tight ?? again.manifest.bound);
      await rpc('setStreamPlanes', []);
      await rpc('setSuppressed', []);
      await rpc('setProject', ed.project, { reset: true });
      const list = [FIRST, FIRST + 3, FIRST + 17, FIRST + 30, FIRST + 44, TLAST - 20, TLAST - 1].filter((f) => f >= FIRST && f <= TLAST);
      const rows = [];
      for (const f of list) {
        const { got } = await seekTo(f);
        if (got.ms === null) { rows.push({ frame: f, notDrawn: got }); continue; }
        const stage = await shotStage();
        const r = score(stage, tight1, [f - 2, f - 1, f, f + 1, f + 2], exportOf1);
        const vsOld = round2(rectDiff(stage, exportOf(f), tight1).mean);
        rows.push({ frame: f, best: r.best, mean: r.mean, runnerUp: r.runnerUp, vsOldProjectSameFrame: vsOld });
        if (f === FIRST + 30) { await fs.writeFile(path.join(OUT, `${kind}-edited-stage-${f}.png`), toPng(stage)); await fs.writeFile(path.join(OUT, `${kind}-edited-export-${f}.png`), toPng(exportOf1(f))); }
      }
      rec.frames = rows;
      run.edit = rec;
      say('F-edit', { scene: tag, ...rec });
      check(rows.every((x) => x.best === x.frame), `${tag}: after re-production the new stream is pasted, and it is most similar to the same frame of the new project's export page`, rows.filter((x) => x.best !== x.frame).slice(0, 3));
      check(rows.every((x) => x.mean < 4), `${tag}: after re-production, the difference from the same frame of the new project is on the order of encoding error`, rows.map((x) => x.mean));
      const mid = rows.filter((x) => x.frame >= FIRST + 15);
      check(mid.length > 0 && mid.every((x) => x.vsOldProjectSameFrame > x.mean * 1.3 + 0.3), `${tag}: control: comparing the same picture against the old project's export page is clearly worse (this comparison can tell whether the lower layer changed)`, mid);
    }

    /* ---------- G. The moment two stages swap: send stream plane first, then suppression */
    {
      // Stream plane for this version (version with modified lower layer); a frame where target card is present
      const f0 = FIRST + 20;
      const dress = async (order) => {
        await rpc('setSuppressed', []);
        await rpc('setStreamPlanes', []);
        await rpc('setTime', f0 / FPS + 1e-4);
        slot++;
        await frameA().evaluate((b) => { window.__pcStreamBase = b; }, `${base}/d${slot}`);
        await sleep(150);
        const sampler = frameA().evaluate(async (id, ms) => {
          const now = window.__pcRealNow ?? (() => performance.now());
          const wait = (n) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, n));
          const t0 = now();
          const log = [];
          let last = '', emptyMs = 0, emptySince = null, firstHidden = null, firstShowing = null;
          for (;;) {
            const d = window.__pcStageDiag();
            const at = now() - t0;
            const showing = d.streams.tracks.some((t) => t.id.split('#')[0] === id && t.lastDrawn !== null);
            const hidden = !!document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`)?.classList.contains('pc-suppressed');
            const empty = hidden && !showing;
            if (empty && emptySince === null) emptySince = at;
            if (!empty && emptySince !== null) { emptyMs += at - emptySince; emptySince = null; }
            if (hidden && firstHidden === null) firstHidden = Math.round(at);
            if (showing && firstShowing === null) firstShowing = Math.round(at);
            const key = `${d.parentSuppressed.includes(id) ? 'named' : '-'}|${d.streamWaiting.includes(id) ? 'wait' : '-'}|${hidden ? 'hidden' : 'live'}|${showing ? 'stream' : '-'}|${d.placeholders.includes(id) ? 'ph' : '-'}`;
            if (key !== last) { last = key; log.push(`${Math.round(at)}ms ${key}`); }
            if (at > ms) { if (emptySince !== null) emptyMs += at - emptySince; return { log, emptyMs: Math.round(emptyMs), firstHidden, firstShowing, placeholder: log.some((l) => l.endsWith('|ph')) }; }
            await wait(2);
          }
        }, target, 600);   // Only check 0.6 s after playback starts: Bing's target card is 1.66 s long, sampling too long would sample past its exit
        await sleep(40);
        const planes = planesAt(f0);
        if (order === 'planes-first') { await rpc('setStreamPlanes', planes); await rpc('setSuppressed', cards); }
        else { await rpc('setSuppressed', cards); await rpc('setStreamPlanes', planes); }
        await rpc('setPlaying', true);
        await rpc('play', f0 / FPS + 1e-4);
        const seen = await sampler;
        await rpc('pause');
        await rpc('setPlaying', false);
        return seen;
      };
      const fixed = await dress('planes-first');
      const old = await dress('suppress-first');
      run.swapDress = { frame: f0, streamPlaneSentBeforeSuppression: fixed, controlSuppressionSentBeforeStreamPlane: old };
      say('G-swap-dress', { scene: tag, ...run.swapDress });
      check(fixed.emptyMs === 0 && !fixed.placeholder, `${tag}: plane placement after the swap: stream plane sent first, suppression second, with no moment of "live subtree hidden while the stream has no picture" throughout, and no placeholders`, fixed);
      check(fixed.firstHidden !== null && fixed.firstShowing !== null && fixed.firstHidden >= fixed.firstShowing, `${tag}: plane placement after the swap: the original picture is hidden only at the moment the stream draws its first frame`, fixed);
      check(old.emptyMs > 20, `${tag}: control: with the original order (suppression first, stream plane second) this layer does go empty for a while (this measurement can detect empty ticks)`, old);
      slot++;
      await frameA().evaluate((b) => { window.__pcStreamBase = b; }, `${base}/s${slot}`);
    }

    await rpc('setStreamPlanes', []);
    await rpc('setSuppressed', []);
    current.producer = null;
    try { await pipeline.close(); } catch { /* ignore */ }
    pipelines.pop();
  }
  await rpc('setRole', 'back', { job: 'probe' });
} catch (error) {
  fails.push(`Exception: ${error?.stack || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { hostServer?.close(); hostServer?.closeAllConnections?.(); } catch { /* ignore */ }
  for (const p of pipelines) { try { await p.close(); } catch { /* ignore */ } }
  try { await bakery?.close(); } catch { /* ignore */ }
  try { await media?.close(); } catch { /* ignore */ }
  dropStreamEncoderSpares();
  try { await dev?.stop(); } catch { /* ignore */ }
  if (!KEEP) {
    try {
      for (const name of await fs.readdir(OUT)) if (!/\.(json|png)$/.test(name)) await fs.rm(path.join(OUT, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* ignore */ }
  }
}
out.elapsedMs = Date.now() - started;
out.fails = fails;
out.ok = fails.length === 0;
try { await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log(out.ok ? 'PASS' : `FAIL ${fails.length}`);
process.exit(out.ok ? 0 : 1);

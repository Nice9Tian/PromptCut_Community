/**
 * Track streams for source-dependent cards and cards whose outer frames use 3D transforms:
 * end-to-end probe for stream generation, pasting back onto stage, and invalidating and re-producing
 * after modifying inputs, **comparing pixels frame by frame** (semantics
 * `docs/semantics/mechanism/rendering.md` "Heavy pipeline: prerender", "How to produce, split by card";
 * the plan side is in `soloStreamKind` of `server/frame-stream.mjs`).
 *
 *   node scripts/probes/stream-source-probe.mjs --port 27060 [--host-port 27070] [--out <dir>] [--keep] [--json <file>]
 *   node scripts/probes/stream-source-probe.mjs --port 27060 --measure [--size 1920x1080] [--seconds 10]     Measure elapsed time and size only (see end of text)
 *
 * Starts a dev server at checkout root itself (`--port`, occupying +1 and +2 as stage ports; asset
 * catalog, data directory, and card overlay layer are all newly created temporary directories, not
 * writing a single file to checkout directory), torn down by process ID after use. Directly starts
 * `FramePipeline` in this process (same code as prerender process), with store root in a temporary
 * directory.
 *
 * Three kinds of cards in project (1280×720, 30 frames per second), all pinned as heavy cards,
 * **none starting at a frame multiple of 15**:
 *
 *   fx     a video clip wrapped with a media effect card (invert color, motion-style: playback from
 *          mount frame during stream generation), frames 39-128. Clip carries its own asset and card
 *   trans  a transition between two video clips (crossfade, remotion-style: no playback during stream
 *          generation), frames 166-195; two video clips va and vb are normal media clips on timeline
 *   tilt   a standalone card whose outer frame has 3D transforms (`r6-stateful`, a block of text
 *          moves horizontally by 10 pixels per frame; rotateY 35°, rotateX 12°), frames 70-144,
 *          layered on top of fx
 *
 * Check item by item:
 *
 *   1. Plan: all three are single-card streams (`kind: 'card'`, `plane: 'local'`), fx and trans
 *      marked `solo: 'source'`, tilt marked `solo: 'spatial'`; the first frame of each is the first
 *      frame of the clip, and segments count from it.
 *   2. Sparse version (producer first fully populates sparse version of three streams, probe blocks
 *      to prevent catching up to full density): each segment's `stride` is the frame count of one
 *      segment, with position rectangle `box`;
 *      **Stage pastes sparse version**: set time to a frame in middle of segment; image pasted on
 *      stage is closest to that of the first frame of this segment on export page (stream of a
 *      source-dependent card carries video, so at this time the full-frame image pauses at the
 *      segment's first frame together with video: this is the consequence to report to user).
 *   3. Release to catch up to full density. **Stream generation, frame by frame**: decode each
 *      segment; the k-th sample of the n-th segment should be frame `originFrame + n × 15 + k` of
 *      the project. Reference is stepping forward frame by frame on export page for this stream's
 *      isolated project, taking one screenshot per frame: in references for fx and trans, it is
 *      the image "after video passes through this card"; tilt's reference is planar image **before
 *      transform** (in isolated project, box only retains position, width, and height). Compare each
 *      sample against itself and two frames before and after; closest match must be itself.
 *   4. **Stage pastes stream, frame by frame** (test page acts as parent page, stream planes use
 *      `streamPlanesFor` from product): for every frame where the three streams are present, jump
 *      in shuffled order (scrub), wait for stream plane to draw this frame, capture stage, and
 *      compare against the **same frame on export page of complete project**, also comparing one
 *      frame before and after; closest match must be itself. tilt's stream contains a planar
 *      image, and 3D transform is applied by wrapper layer when pasting, so this item also verifies
 *      "applying transform when pasting yields results consistent with export"; during fx's
 *      section, nothing else on stage is drawing video.
 *   5. Truly play a short segment and then pause: do not jump frames, compare paused frame the same
 *      way. ("Returning to exact live render after stopping" is not checked here: test page lacks
 *      cost records and dispatch tables, stage does not start frame catch-up. The 3D outer frame kind
 *      is checked in real editor, `scrub-stream-probe.mjs --tilt`; media effect cards have no cost
 *      records, and how to return to live render after stopping is an existing separate path, not
 *      touched this time.)
 *   6. **Modified inputs**: modify one place each for video crop start point (fx), card parameters
 *      (trans), and 3D angle (tilt). Stream keys for fx and trans change (old stream does not
 *      belong to this version, ready message contains new keys) and are re-produced; tilt's stream
 *      key remains unchanged, and not a single segment is re-produced. After re-producing, sample
 *      several frames from each of three streams; what stage pastes is closest to the same frame
 *      exported from **modified project** (those frames for tilt verify pasting the same stream
 *      according to new angle).
 *
 * `--measure`: measure only. A project contains only one video clip wrapped with a media effect card
 * (default 10 seconds, 1920×1080), timed from `preload`: how long to fully populate sparse version,
 * how long to complete full density, and how large sparse and full-density versions of this stream
 * are. Does not compare pixels. Elapsed time is recorded only, not a pass condition. Defaults to
 * using motion-style card (pushes every frame during stream generation); add `--direct` to switch to
 * remotion-style implementation (sparse version jumps directly to frame to capture).
 *
 * Outputs JSON conclusion, writes progress to stderr; exits non-zero if any check fails.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { serve, flagArg } from './probe-connect.mjs';
import { startDevServer } from '../lib/dev-server.mjs';
import { emptyUrlOf, decodeSegment, newError, errorSummary, tallyDecodedDirect, cropRgba, savePreview, sleep, round2 } from './below-stream-common.mjs';
import { STREAM_SEGMENT_FRAMES, streamSegmentFirstFrame, streamSegmentFrameCount, streamSegmentOf } from '../../src/render/streamSegments.mjs';

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const PORT = Number(flagArg('port', '0', args));
const KEEP = args.includes('--keep');
const MEASURE = args.includes('--measure');
/** `--measure --direct`: media effect card switches to remotion-style one (no playback during stream generation, sparse version jumps directly to frame to capture) */
const DIRECT = args.includes('--direct');
const JSON_OUT = flagArg('json', null, args);
const HOST_PORT = Number(flagArg('host-port', '0', args)) || 0;
const RUN = Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-stream-source-probe-${RUN}`));
if (!PORT) { console.error('Pass --port <port of a dev server you start yourself>'); process.exit(2); }

const FPS = 30;
const [WIDTH, HEIGHT] = MEASURE ? String(flagArg('size', '1920x1080', args)).split('x').map(Number) : [1280, 720];
const MEASURE_SECONDS = Math.max(1, Number(flagArg('seconds', '10', args)) || 10);
const WORK = path.join(OUT, 'work');
const MEDIA_DIR = path.join(WORK, 'media');
const DATA_DIR = path.join(WORK, 'data');
const OVERRIDES = path.join(WORK, 'card-overrides');
process.env.PROMPTCUT_STREAM_POOL = '1';

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); say('FAIL', { label, extra }); } return cond; };
async function until(label, fn, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`Timeout: ${label}`); return null; }
    await sleep(everyMs);
  }
}

/* ------------------------------------------------------------------ Assets and cards */

/** ffmpeg test pattern (sharp edges, continuous motion, distinct every frame), placed into asset catalog by content hash. Returns asset record in project */
async function makeVideo(ffmpeg, id, filter, seconds, width, height) {
  const tmp = path.join(WORK, `${id}.mp4`);
  await execFileAsync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${FPS}:duration=${seconds}`,
    ...(filter ? ['-vf', filter] : []), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', String(FPS), '-crf', '18', '-movflags', '+faststart', tmp], { windowsHide: true });
  const bytes = await fs.readFile(tmp);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  await fs.rename(tmp, path.join(MEDIA_DIR, `${hash}.mp4`));
  return { id, kind: 'video', name: `${id}.mp4`, url: `/@media/${hash}`, hash, duration: seconds, width, height, fps: FPS, bytes: bytes.length };
}

const TINT = 'probe-source-tint', FADE = 'probe-source-fade', TINT_DIRECT = 'probe-source-tint-direct';
/** Two media effect cards, written into temporary card overlay layer. Invert card written as motion-style (playback from mount frame during stream generation), dissolve card is remotion-style (no playback) */
async function writeCards() {
  const dir = path.join(OVERRIDES, 'src', 'cards', 'user');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${TINT}.tsx`), `import type { CardDef } from "../../kernel/types";
import { glsl } from "../../render/cards/graphValues";

/** For the probe (stream-source-probe.mjs temporarily writes it into the overlay layer): blend the input picture toward its inverse color by strength */
export const probeSourceTint: CardDef<{ amount: number }> = {
  id: "${TINT}",
  name: "Source-dependent probe: invert",
  description: "Blend the input picture toward its inverse color by strength",
  source: "user",
  kind: "filter",
  frameMode: "stateful",
  inputs: { source: { description: "Input picture" } },
  defaults: { amount: 1 },
  controls: [],
  card: (sources, t, params) => glsl(
    \`uniform sampler2D u_input0;
     uniform float amount;
     void main() { vec4 c = texture(u_input0, v_uv); outColor = vec4(mix(c.rgb, 1.0 - c.rgb, amount), 1.0); }\`,
    [sources.source.at(t)],
    { amount: params.amount },
  ),
};
`);
  // Remotion-style implementation of the same invert card (used by `--measure --direct`)
  await fs.writeFile(path.join(dir, `${TINT_DIRECT}.tsx`), `import "../../kernel/remotionStyle";
import type { CardDef } from "../../kernel/types";
import { glsl } from "../../render/cards/graphValues";

export const probeSourceTintDirect: CardDef<{ amount: number }> = {
  id: "${TINT_DIRECT}",
  name: "Source-dependent probe: invert (remotion style)",
  description: "Blend the input picture toward its inverse color by strength",
  source: "user",
  kind: "filter",
  frameMode: "direct",
  inputs: { source: { description: "Input picture" } },
  defaults: { amount: 1 },
  controls: [],
  card: (sources, t, params) => glsl(
    \`uniform sampler2D u_input0;
     uniform float amount;
     void main() { vec4 c = texture(u_input0, v_uv); outColor = vec4(mix(c.rgb, 1.0 - c.rgb, amount), 1.0); }\`,
    [sources.source.at(t)],
    { amount: params.amount },
  ),
};
`);
  await fs.writeFile(path.join(dir, `${FADE}.tsx`), `import "../../kernel/remotionStyle";
import type { CardDef } from "../../kernel/types";
import { glsl } from "../../render/cards/graphValues";

/** For the probe (stream-source-probe.mjs temporarily writes it into the overlay layer): A dissolves into B over the clip duration; when swap is 1 it runs the other way round */
export const probeSourceFade: CardDef<{ swap: number }> = {
  id: "${FADE}",
  name: "Source-dependent probe: dissolve",
  description: "Picture A dissolves into picture B",
  source: "user",
  kind: "transition",
  frameMode: "direct",
  inputs: { A: { description: "Picture before the transition" }, B: { description: "Picture after the transition" } },
  defaults: { swap: 0 },
  controls: [],
  card: (sources, t, params, ctx) => glsl(
    \`uniform sampler2D u_input0;
     uniform sampler2D u_input1;
     uniform float progress;
     uniform float swap;
     void main() {
       float p = clamp(progress, 0.0, 1.0);
       p = mix(p, 1.0 - p, swap);
       outColor = vec4(mix(texture(u_input0, v_uv).rgb, texture(u_input1, v_uv).rgb, p), 1.0);
     }\`,
    [sources.A.at(t), sources.B.at(t)],
    { progress: t / Math.max(1e-6, ctx.duration), swap: params.swap },
  ),
};
`);
}

/* ------------------------------------------------------------------ Project */

/** Timeline frames (closed interval) and seconds for three cards. In and out points written in seconds, falling between two frames */
const CLIPS = {
  fx: { frames: [39, 128], start: 1.29, end: 4.29, solo: 'source' },
  tilt: { frames: [70, 144], start: 2.32, end: 4.82, solo: 'spatial' },
  trans: { frames: [166, 195], start: 5.52, end: 6.52, solo: 'source' },
};
const VA = { start: 4.9, end: 6.02 }, VB = { start: 6.02, end: 7, mediaOffset: 0.5 };
const DURATION = 7;
const TILT_FRAME = { x: 640, y: 400, w: 900, h: 260, anchor: [0.5, 0.5], rotateY: 35, rotateX: 12 };

function project(media, { fxOffset = 0.4, swap = 0, rotateY = TILT_FRAME.rotateY } = {}) {
  return {
    id: 'stream-source-probe', name: 'Stream probe for source-dependent cards and 3D outer-frame cards', width: WIDTH, height: HEIGHT, fps: FPS, duration: DURATION,
    themeId: 'dark', camera3dFov: 50, media: [media.a, media.b, media.c], filters: [], pixelMaps: [], audioFx: [], style: {},
    cardNodes: [
      { id: 'n-fx', adapter: 'card', cardId: TINT, kind: 'filter', params: { amount: 1 }, inputs: { source: { nodeId: '@clip/fx/source', offset: 0, rate: 1 } } },
      // Time offsets of the two inputs are set to "follow that video's own time": A is where va plays at transition in point, B is the segment before vb in point
      { id: 'n-trans', adapter: 'card', cardId: FADE, kind: 'transition', params: { swap },
        inputs: { A: { nodeId: '@clip/va/source', offset: +(CLIPS.trans.start - VA.start).toFixed(4), rate: 1 }, B: { nodeId: '@clip/vb/source', offset: +(CLIPS.trans.start - VB.start).toFixed(4), rate: 1 } } },
    ],
    // First track is on top
    tracks: [
      { id: 'tr-tilt', name: 'tilt', hidden: false, clips: [{ id: 'tilt', kind: 'card', cardId: 'r6-stateful', start: CLIPS.tilt.start, end: CLIPS.tilt.end, params: {}, frame: { ...TILT_FRAME, rotateY } }] },
      { id: 'tr-trans', name: 'trans', hidden: false, clips: [{ id: 'trans', kind: 'card', cardId: FADE, nodeId: 'n-trans', start: CLIPS.trans.start, end: CLIPS.trans.end, params: { swap } }] },
      { id: 'tr-fx', name: 'fx', hidden: false, clips: [{ id: 'fx', cardId: TINT, nodeId: 'n-fx', mediaId: media.c.id, mediaOffset: fxOffset, start: CLIPS.fx.start, end: CLIPS.fx.end, params: { amount: 1 }, volume: 0 }] },
      { id: 'tr-va', name: 'va', hidden: false, clips: [{ id: 'va', cardId: '', mediaId: media.a.id, mediaOffset: 0, start: VA.start, end: VA.end, params: {}, volume: 0 }] },
      { id: 'tr-vb', name: 'vb', hidden: false, clips: [{ id: 'vb', cardId: '', mediaId: media.b.id, mediaOffset: VB.mediaOffset, start: VB.start, end: VB.end, params: {}, volume: 0 }] },
    ],
  };
}

/** Project for `--measure`: only one video clip wrapped with a media effect card, starting from frame 0, entire clip */
function measureProject(media, seconds) {
  const card = DIRECT ? TINT_DIRECT : TINT;
  return {
    id: 'stream-source-measure', name: 'Source-dependent card streams: measure time and size', width: WIDTH, height: HEIGHT, fps: FPS, duration: seconds,
    themeId: 'dark', media: [media.c], filters: [], pixelMaps: [], audioFx: [], style: {},
    cardNodes: [{ id: 'n-fx', adapter: 'card', cardId: card, kind: 'filter', params: { amount: 1 }, inputs: { source: { nodeId: '@clip/fx/source', offset: 0, rate: 1 } } }],
    tracks: [{ id: 'tr-fx', name: 'fx', hidden: false, clips: [{ id: 'fx', cardId: card, nodeId: 'n-fx', mediaId: media.c.id, mediaOffset: 0, start: 0, end: seconds, params: { amount: 1 }, volume: 0 }] }],
  };
}

/* ------------------------------------------------------------------ Compare pixels */

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
/**
 * Difference between two RGB images: average difference, and number of pixels with difference > 48
 * (pixels "clearly not the same image").
 */
function rgbDiff(a, b) {
  if (a.width !== b.width || a.height !== b.height) return { mean: Infinity, bad: Infinity };
  let sum = 0, bad = 0;
  for (let i = 0; i < a.rgb.length; i += 3) {
    const d0 = Math.abs(a.rgb[i] - b.rgb[i]), d1 = Math.abs(a.rgb[i + 1] - b.rgb[i + 1]), d2 = Math.abs(a.rgb[i + 2] - b.rgb[i + 2]);
    sum += d0 + d1 + d2;
    if (d0 > 48 || d1 > 48 || d2 > 48) bad++;
  }
  return { mean: sum / a.rgb.length, bad };
}
const toPng = (img) => { const png = new PNG({ width: img.width, height: img.height }); for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) { png.data[i] = img.rgb[j]; png.data[i + 1] = img.rgb[j + 1]; png.data[i + 2] = img.rgb[j + 2]; png.data[i + 3] = 255; } return PNG.sync.write(png); };

const hostHtml = (oa, ob) => `<!doctype html><html><head><meta charset="utf-8"><title>stream source probe host</title></head>
<body style="margin:0;background:#202020">
<iframe id="a" src="${oa}/?stage=1&id=A&preview=stage&prerender=1" style="width:${WIDTH}px;height:${HEIGHT}px;border:0;display:block"></iframe>
<iframe id="b" src="${ob}/?stage=1&id=B&preview=stage&prerender=1" style="width:${WIDTH}px;height:${HEIGHT}px;border:0;display:block;opacity:0;pointer-events:none;position:absolute;left:0;top:0"></iframe>
<script type="module">
function createStageRpc(target, targetOrigin) {
  let nextId = 1; const pending = new Map(); const listeners = new Set();
  window.addEventListener('message', (e) => {
    if (e.source !== target) return; const d = e.data;
    if (d && d.type === 'pc-rpc-reply') { const p = pending.get(d.id); if (!p) return; pending.delete(d.id); d.ok ? p.resolve(d.result) : p.reject(new Error(d.error)); return; }
    if (d && typeof d.type === 'string' && ['mediaReady', 'frame', 'ended', 'settled', 'probe', 'demote', 'probe-frame'].includes(d.type)) for (const l of listeners) l(d);
  });
  const call = (method) => (...args) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); target.postMessage({ type: 'pc-rpc', id, method, args }, targetOrigin); });
  const c = { onEvent: (l) => { listeners.add(l); return () => listeners.delete(l); } };
  for (const m of ['setProject', 'setTime', 'setRole', 'play', 'pause', 'setSuppressed', 'setStreamPlanes', 'setPlaying']) c[m] = call(m);
  return c;
}
window.__frames = [];
const waitReady = (frame, targetOrigin) => new Promise((res) => {
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.data?.type !== 'pc-stage-ready') return;
    res(createStageRpc(frame.contentWindow, targetOrigin));
  });
});
window.__ready = Promise.all([waitReady(document.getElementById('a'), '${oa}'), waitReady(document.getElementById('b'), '${ob}')])
  .then(([a, b]) => { window.__rpc = a; window.__rpcB = b; a.onEvent((ev) => { if (ev.type === 'frame') window.__frames.push({ sec: ev.sec, at: performance.now() }); }); return true; });
</script></body></html>`;

/* ------------------------------------------------------------------ Main flow */

const out = { measure: MEASURE, out: OUT, size: `${WIDTH}x${HEIGHT}`, fps: FPS };
await fs.mkdir(MEDIA_DIR, { recursive: true });
await fs.mkdir(DATA_DIR, { recursive: true });
let dev = null, bakery = null, pipeline = null, browser = null, hostServer = null, dropSpares = () => {};
const started = Date.now();
try {
  // These environment variables are also needed by pipeline in this process (card overlay layer, asset catalog): share the same with dev server
  const env = { PROMPTCUT_EXPORT_DIR: WORK, PROMPTCUT_DATA_DIR: DATA_DIR, PROMPTCUT_CARD_OVERRIDES: OVERRIDES, PROMPTCUT_NO_PORT_FILE: '1',
    PROMPTCUT_CARD_SYNC: '0', PROMPTCUT_PUSH: '0', PROMPTCUT_LAN_HOST: '', PROMPTCUT_DEVICE_ID: `srcprobe-${RUN}`.padEnd(16, '0'), PROMPTCUT_DEVICE_NAME: 'source-probe' };
  Object.assign(process.env, env);
  const { FramePipeline } = await import('../../server/frame-pipeline.mjs');
  const { handleStreamRequest, splitFmp4, SPARSE_STRIDE } = await import('../../server/frame-stream.mjs');
  const { openBakery } = await import('../../server/bakery/chrome.mjs');
  const { bakeFrames } = await import('../../server/bakery/bake.mjs');
  const { findFfmpeg, openStreamSegmentEncoder, dropStreamEncoderSpares } = await import('../../server/bakery/ffmpeg.mjs');
  const { decodePngRgba } = await import('../../server/bakery/capture-canvas.mjs');
  const { streamPlanesFor } = await import('../../src/render/streamPlayer.ts');
  const ffmpeg = await findFfmpeg();
  dropSpares = dropStreamEncoderSpares;

  await writeCards();
  const seconds = MEASURE ? MEASURE_SECONDS + 1 : DURATION + 1;
  const media = {
    a: MEASURE ? null : await makeVideo(ffmpeg, 'm-a', null, seconds, WIDTH, HEIGHT),
    b: MEASURE ? null : await makeVideo(ffmpeg, 'm-b', 'hflip,hue=h=120', seconds, WIDTH, HEIGHT),
    c: await makeVideo(ffmpeg, 'm-c', 'vflip,hue=h=240', seconds, WIDTH, HEIGHT),
  };
  dev = await startDevServer({ env, port: PORT, logFile: path.join(WORK, 'vite.log'), log: (m) => say('dev', { m }) });
  const origin = dev.origin;
  out.origin = origin;
  say('spawn', { pid: dev.pid, port: PORT, stagePorts: dev.stagePorts });

  /** Start a pipeline: pin as heavy cards; add gate (`hold`) to "block once all sparse ones are ready", and catch up to full density only after release */
  const openPipeline = (root) => {
    const p = new FramePipeline({ root, origin: () => origin, interactive: true, playhead: () => null });
    p.streamPicked = () => true;
    const producer = p.streamProducer();
    producer.attachRoute();
    const gate = { hold: true };
    const busy = p.streamBusy.bind(p);
    p.streamBusy = (now) => busy(now) || (gate.hold && producer.streams.size > 0 && !producer.encoding.size && !producer.needsSparseAnywhere());
    const stored = [];
    const store = producer.storeSegment.bind(producer);
    producer.storeSegment = async (state, generation, o) => { const r = await store(state, generation, o); stored.push({ key: state.spec.streamKey, n: o.segment, stride: o.stride, at: Date.now() }); return r; };
    const layers = new Map();
    p.readyIndex.subscribe((message) => { if (message.type === 'layer' && message.kind === 'stream') layers.set(message.clipId, message); });
    return { pipeline: p, producer, gate, stored, layers };
  };
  /** Return status only when every segment of each stream in this version satisfies `want` (and none are currently generating) */
  const allAt = (producer, keys, want) => {
    const s = producer.status();
    const rows = s.streams.filter((row) => keys.has(row.streamKey));
    if (rows.length !== keys.size) return null;
    for (const row of rows) for (let n = row.firstSegment; n <= row.lastSegment; n++) if (!want(row.segments[n])) return null;
    return s;
  };
  const bytesOf = (state) => {
    let sparse = 0, dense = 0, inits = 0;
    for (const seg of Object.values(state.manifest.segments)) { if (seg.stride > 1) sparse += seg.bytes; else dense += seg.bytes; }
    for (const init of Object.values(state.manifest.inits)) inits += init.bytes ?? 0;
    return { sparse, dense, inits };
  };

  /* ================================================================ Measure only */
  if (MEASURE) {
    const PROJECT = measureProject(media, MEASURE_SECONDS);
    const P = openPipeline(path.join(OUT, 'library'));
    pipeline = P.pipeline;
    const t0 = Date.now();
    const entry = await pipeline.preload(PROJECT);
    void entry;
    const keysOf = () => new Set([...P.producer.streams.values()].map((s) => s.spec.streamKey));
    const sparse = await until('Sparse version fully laid out', () => (P.producer.streams.size ? allAt(P.producer, keysOf(), (seg) => !!seg) : null), 1_800_000, 200);
    const sparseMs = Date.now() - t0;
    const state = [...P.producer.streams.values()][0];
    if (!sparse || !state) throw new Error(`Sparse version not fully laid out: ${JSON.stringify(P.producer.status().log.slice(-8))}`);
    const sparseBytes = bytesOf(state);
    const segments = state.spec.lastSegment + 1;
    const sparseCapture = { ...(state.capture ?? {}) };
    P.gate.hold = false;
    P.producer.kick();
    const dense = await until('Full density filled in', () => { const s = allAt(P.producer, keysOf(), (seg) => seg?.stride === 1); return s && !P.producer.workers.size && !P.producer.encoding.size ? s : null; }, 3_600_000, 300);
    const denseMs = Date.now() - t0;
    if (!dense) throw new Error(`Full density not filled in: ${JSON.stringify(P.producer.status().log.slice(-8))}`);
    const denseBytes = bytesOf(state);
    const frames = state.spec.lastFrame - state.spec.originFrame + 1;
    const cap = state.capture ?? {};
    out.result = {
      seconds: MEASURE_SECONDS, frames, segments, card: DIRECT ? 'remotion-style' : 'motion style', encoder: dense.encoder, solo: state.spec.solo ?? null, replay: state.spec.replay,
      sourceVideoBytes: media.c.bytes,
      sparseMs, denseMs, denseOnlyMs: denseMs - sparseMs,
      sparseBytes: sparseBytes.sparse, denseBytes: denseBytes.dense, initBytes: denseBytes.inits,
      // Frame capture stage cumulative total (recorded by producer): frames captured, screenshot duration in milliseconds, frame-push duration (including waiting for media effect card to decode this frame's video) in milliseconds
      sparsePass: { captured: sparseCapture.frames ?? 0, captureMs: Math.round(sparseCapture.captureMs ?? 0), stepMs: Math.round(sparseCapture.stepMs ?? 0) },
      densePass: { captured: (cap.frames ?? 0) - (sparseCapture.frames ?? 0), captureMs: Math.round((cap.captureMs ?? 0) - (sparseCapture.captureMs ?? 0)), stepMs: Math.round((cap.stepMs ?? 0) - (sparseCapture.stepMs ?? 0)) },
      tight: state.manifest.tight, bound: state.manifest.bound, resets: state.resets ?? null, replayedFrames: state.replayedFrames ?? 0,
    };
    say('measure', out.result);
    check(state.spec.kind === 'card' && state.spec.solo === 'source', 'The measured stream is the single-card stream of a source-dependent card', { kind: state.spec.kind, solo: state.spec.solo });
    check(sparseBytes.sparse > 0 && denseBytes.dense > 0, 'Both the sparse and full-density versions were produced', { sparseBytes, denseBytes });
  } else {
  /* ================================================================ Check frame by frame */
  const PROJECT = project(media);
  const A = openPipeline(path.join(OUT, 'library'));
  pipeline = A.pipeline;
  const { producer } = A;
  const t0 = Date.now();
  await pipeline.preload(PROJECT);
  const keysNow = () => new Set([...producer.streams.values()].map((s) => s.spec.streamKey));

  // ---------- 1. Plan + 2. Sparse version
  const sparseStatus = await until('Sparse versions of the three streams fully laid out', () => (producer.streams.size ? allAt(producer, keysNow(), (seg) => !!seg) : null), 900_000, 200);
  if (!sparseStatus) throw new Error(`Sparse version not fully laid out: ${JSON.stringify(producer.status().log.slice(-8))}`);
  out.sparseMs = Date.now() - t0;
  out.encoder = sparseStatus.encoder;
  const states = () => [...producer.streams.values()];
  const stateOf = (clipId) => states().find((s) => s.spec.topClipId === clipId) ?? null;
  out.plan = states().map((s) => ({ clip: s.spec.topClipId, kind: s.spec.kind, plane: s.spec.plane, solo: s.spec.solo ?? null, replay: s.spec.replay,
    originFrame: s.spec.originFrame, lastFrame: s.spec.lastFrame, lastSegment: s.spec.lastSegment, bound: s.spec.bound, offset: s.spec.offset }));
  say('plan', { ms: out.sparseMs, plan: out.plan });
  check(states().length === 3, 'There are three streams', out.plan.map((p) => `${p.kind}:${p.clip}`));
  for (const [id, want] of Object.entries(CLIPS)) {
    const st = stateOf(id);
    if (!check(!!st, `${id}: has this stream`)) continue;
    const { spec, manifest } = st;
    const lastSegment = Math.floor((want.frames[1] - want.frames[0]) / STREAM_SEGMENT_FRAMES);
    check(spec.kind === 'card' && spec.plane === 'local' && spec.solo === want.solo, `${id}: single-card stream, solo is ${want.solo}`, { kind: spec.kind, plane: spec.plane, solo: spec.solo });
    check(spec.originFrame === want.frames[0] && spec.lastFrame === want.frames[1] && spec.firstSegment === 0 && spec.lastSegment === lastSegment,
      `${id}: first frame ${want.frames[0]}, last frame ${want.frames[1]}, segments 0-${lastSegment}`, { originFrame: spec.originFrame, lastFrame: spec.lastFrame, lastSegment: spec.lastSegment });
    check(want.frames[0] % STREAM_SEGMENT_FRAMES !== 0, `${id}: the first frame is not a multiple of 15`, want.frames[0]);
    check(spec.replay === (id !== 'trans'), `${id}: replay or not (the invert card and r6 are motion style, the dissolve card is remotion style)`, spec.replay);
    const sparseSegs = Object.entries(manifest.segments);
    check(sparseSegs.length === lastSegment + 1 && sparseSegs.every(([, seg]) => seg.stride === SPARSE_STRIDE), `${id}: in the sparse version every segment's stride is the frame count of one segment`, sparseSegs.map(([n, seg]) => [n, seg.stride]));
    check(sparseSegs.every(([n, seg]) => seg.samples === streamSegmentFrameCount(Number(n), want.frames[0], want.frames[1])), `${id}: a sparse segment's sample count = the number of frames this segment covers`, sparseSegs.map(([n, seg]) => [n, seg.samples]));
    check(sparseSegs.every(([, seg]) => seg.box && seg.box.w > 0 && seg.box.h > 0), `${id}: every segment in the sparse version carries a position rectangle`, sparseSegs.map(([n, seg]) => [n, seg.box ?? null]));
    const layer = A.layers.get(id);
    check(!!layer && layer.key === spec.streamKey && layer.originFrame === want.frames[0], `${id}: the ready message carries the stream key and the first frame`, layer && { key: layer.key.slice(0, 12), originFrame: layer.originFrame, ranges: layer.ranges });
  }
  out.sparseBytes = Object.fromEntries(states().map((s) => [s.spec.topClipId, bytesOf(s).sparse]));
  // Position rectangle for fx: video fills the frame and is opaque, so bounding box for each segment is the entire frame
  {
    const st = stateOf('fx');
    const boxes = Object.values(st?.manifest.segments ?? {}).map((seg) => seg.box);
    check(boxes.length > 0 && boxes.every((b) => b && b.x === 0 && b.y === 0 && b.w === WIDTH && b.h === HEIGHT), 'fx: the position rectangle is the whole picture (the stream carries video, opaque)', boxes.slice(0, 2));
  }

  // ---------- Reference: complete project steps forward on export page, capturing one full frame per frame
  const emptyUrl = emptyUrlOf(origin, { width: WIDTH, height: HEIGHT });
  bakery = await openBakery({ url: emptyUrl });
  const LAST = CLIPS.trans.frames[1];
  /** Export page steps forward 0..last, capturing one full frame per frame (transparent background). Returns `{ png(f), rgba(f), rgb(f) }` */
  const exportAll = async (proj, last, dir) => {
    await fs.mkdir(dir, { recursive: true });
    const pngs = new Map();
    await bakery.reset(proj, emptyUrl);
    bakery.streamLease = null;
    await bakeFrames(bakery, { out: dir, fps: FPS, frames: `0-${last}`, fullFrame: true, format: 'png', warm: 3, staticSkip: false, quiet: true, writeFrames: false,
      onFrame: async (i, buf) => { pngs.set(i, Buffer.from(buf)); } });
    const rgbaCache = new Map(), rgbCache = new Map();
    return {
      has: (f) => pngs.has(f),
      png: (f) => pngs.get(f),
      rgba(f) { if (!rgbaCache.has(f)) { const d = decodePngRgba(pngs.get(f))?.data; if (!d) throw new Error(`Could not resolve the reference for frame ${f}`); rgbaCache.set(f, d); if (rgbaCache.size > 40) rgbaCache.delete(rgbaCache.keys().next().value); } return rgbaCache.get(f); },
      rgb(f) { if (!rgbCache.has(f)) { rgbCache.set(f, rgbOver(pngs.get(f))); if (rgbCache.size > 24) rgbCache.delete(rgbCache.keys().next().value); } return rgbCache.get(f); },
    };
  };
  const tExport = Date.now();
  const exported = await exportAll(PROJECT, LAST + 1, path.join(OUT, 'ref-project'));
  out.exportMs = Date.now() - tExport;
  say('exported', { frames: LAST + 2, ms: out.exportMs });

  // ---------- Stage
  const u = new URL(origin);
  const [originA, originB] = dev.stagePorts.slice(0, 2).map((p) => `${u.protocol}//${u.hostname}:${p}`);
  const HOST_PATH = '/__stream-source-probe-host';
  /** Replaced sparse segment files are deleted by producer after a few seconds; stream player may still hold old manifest, keep a copy and serve as usual (same as `sparse-stream-probe`) */
  const kept = new Map();
  let servedKept = 0;
  hostServer = await serve(HOST_PORT, (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (url.pathname === HOST_PATH) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(hostHtml(originA, originB)); return; }
    if (url.pathname.startsWith('/api/frames/')) {
      const rest = url.pathname.slice('/api/frames'.length);
      const m = /^\/stream\/([a-f0-9]{64})\/(\d+-[a-f0-9]{16}\.m4s)$/.exec(rest);
      if (m) {
        const file = path.join(pipeline.streamProducer().store.dir(m[1]), m[2]);
        if (fsSync.existsSync(file)) { try { kept.set(rest, fsSync.readFileSync(file)); } catch { /* Deleting */ } }
        else if (kept.has(rest)) { servedKept++; res.setHeader('Content-Type', 'video/iso.segment'); res.end(kept.get(rest)); return; }
      }
      if (handleStreamRequest(pipeline.streamProducer().store, req, res, rest)) return;
    }
    res.statusCode = 404; res.end();
  }, '127.0.0.1');
  const base = `http://127.0.0.1:${hostServer.address().port}`;
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required',
      '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  const frameA = () => page.frames().find((f) => f.url().startsWith(originA));
  const frameB = () => page.frames().find((f) => f.url().startsWith(originB));
  const rpc = (method, ...a) => page.evaluate((m, a2) => window.__rpc[m](...a2), method, a);
  const rpcB = (method, ...a) => page.evaluate((m, a2) => window.__rpcB[m](...a2), method, a);
  const diagA = () => frameA().evaluate(() => window.__pcStageDiag());
  const heavy = Object.keys(CLIPS);
  let layersNow = () => [...A.layers.values()];
  const planesAt = (f) => streamPlanesFor(layersNow(), new Set(heavy), f);
  /** (Re)open parent page and two stages: rebuild stream player from scratch */
  const openStage = async (proj) => {
    await page.goto(base + HOST_PATH);
    await page.waitForFunction(() => window.__ready, { timeout: 120000 });
    await page.evaluate(() => window.__ready);
    for (const f of [frameA(), frameB()]) await f.evaluate((b) => { window.__pcStreamBase = b; }, base);
    await rpc('setProject', proj, { reset: true });
    await rpcB('setProject', proj, { reset: true });
    await rpc('setRole', 'front');
    await rpcB('setRole', 'back', { job: 'probe' });
    await rpc('setTime', CLIPS.fx.frames[0] / FPS);
    await rpc('setPlaying', true);
    await rpc('setSuppressed', heavy);
  };
  let iframeBox = null;
  const shotStage = async () => {
    await frameA().evaluate(() => new Promise((r) => (window.__pcRealRaf ?? requestAnimationFrame)(() => (window.__pcRealRaf ?? requestAnimationFrame)(() => r()))));
    await page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: WIDTH, height: HEIGHT } });
    return rgbOver(await page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: WIDTH, height: HEIGHT } }));
  };
  /**
   * Set time to frame f, wait for each present stream to draw this frame. Following parent page's
   * behavior: send stream plane first, then suppress cards pasting streams on this frame, then set time.
   */
  const seekTo = async (f) => {
    const planes = planesAt(f);
    await rpc('setStreamPlanes', planes);
    await rpc('setSuppressed', [...new Set(planes.flatMap((p) => p.clipIds))]);
    const got = await frameA().evaluate(async (frame, fps, want) => {
      const now = window.__pcRealNow ?? (() => performance.now());
      const wait = (ms) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, ms));
      const start = now();
      await window.__pcStage.setTime(frame / fps + 1e-4);
      for (;;) {
        const d = window.__pcStageDiag();
        const tracks = d.streams.tracks;
        if (tracks.length === want && tracks.every((t) => t.lastDrawn === frame)) {
          await wait(0);
          return { ms: +(now() - start).toFixed(1), errors: tracks.map((t) => t.errors), placeholders: window.__pcStageDiag().placeholders };
        }
        if (now() - start > 8000) return { ms: null, drawn: tracks.map((t) => t.lastDrawn), errors: tracks.map((t) => t.lastError), tracks: tracks.length };
        await wait(2);
      }
    }, f, FPS, planes.length);
    return { planes, got };
  };
  const onStage = (f) => Object.keys(CLIPS).filter((id) => f >= CLIPS[id].frames[0] && f <= CLIPS[id].frames[1]);

  await openStage(PROJECT);
  iframeBox = await (await page.$('#a')).boundingBox();

  // ---------- 2 (cont.). Stage pastes sparse version: for frames in the middle of a segment, what gets pasted is the image of the segment's first frame
  {
    const rows = [];
    // [frame, which stream to evaluate]: fx present alone, trans, tilt present alone (nothing underneath after frame 129)
    for (const [f, id] of [[46, 'fx'], [63, 'fx'], [174, 'trans'], [190, 'trans'], [137, 'tilt'], [142, 'tilt']]) {
      const { planes, got } = await seekTo(f);
      if (!check(got.ms !== null && planes.length === onStage(f).length, `Stage with sparse version: stream plane rendered frame ${f}`, { got, planes: planes.length })) continue;
      const stage = await shotStage();
      const first = streamSegmentFirstFrame(streamSegmentOf(f, CLIPS[id].frames[0]), CLIPS[id].frames[0]);
      const scores = [...new Set([first, f, f - 1])].map((c) => [c, rgbDiff(stage, exported.rgb(c)).mean]).sort((x, y) => x[1] - y[1]);
      rows.push({ frame: f, clip: id, segmentFirst: first, best: scores[0][0], scores: scores.map(([c, v]) => [c, round2(v)]), placeholders: got.placeholders?.length ?? 0 });
      if (f === 46) { await fs.writeFile(path.join(OUT, 'stage-sparse-46.png'), toPng(stage)); await fs.writeFile(path.join(OUT, 'export-39.png'), toPng(exported.rgb(39))); await fs.writeFile(path.join(OUT, 'export-46.png'), toPng(exported.rgb(46))); }
    }
    out.stageSparse = rows;
    say('stage-sparse', { rows: rows.map((r) => [r.frame, r.clip, r.segmentFirst, r.best, r.scores]) });
    check(rows.length === 6, 'Stage shows the sparse version: all six frames were compared', rows.length);
    check(rows.every((r) => r.best === r.segmentFirst), 'Stage shows the sparse version: frames in the middle of a segment show the segment\'s first-frame picture (a source-dependent card\'s stream freezes the video along with it at that frame)', rows.filter((r) => r.best !== r.segmentFirst));
    check(rows.every((r) => r.placeholders === 0), 'Stage shows the sparse version: no placeholders', rows.filter((r) => r.placeholders));
  }

  // ---------- 3. Unblock filling to full density; generate stream frame by frame
  const tDense = Date.now();
  A.gate.hold = false;
  producer.kick();
  const denseStatus = await until('The three streams filled in to full density', () => { const s = allAt(producer, keysNow(), (seg) => seg?.stride === 1); return s && !producer.workers.size && !producer.encoding.size ? s : null; }, 1_800_000, 300);
  if (!denseStatus) throw new Error(`Full density not filled in: ${JSON.stringify(producer.status().log.slice(-8))}`);
  out.denseMs = Date.now() - tDense;
  out.denseBytes = Object.fromEntries(states().map((s) => [s.spec.topClipId, bytesOf(s).dense]));
  say('dense', { ms: out.denseMs, bytes: out.denseBytes });
  out.streams = [];
  for (const [id, want] of Object.entries(CLIPS)) {
    const state = stateOf(id);
    if (!state) continue;
    const { spec, manifest } = state;
    const [first0, last0] = want.frames;
    const lastSegment = spec.lastSegment;
    const dir = path.join(OUT, `ref-${id}`);
    const truth = await exportAll(state.isolated, last0, dir);
    const got = newError(), floor = newError(), next = newError();
    let frames = 0, minMargin = Infinity;
    const wrong = [];
    for (let n = 0; n <= lastSegment; n++) {
      const seg = manifest.segments[n];
      if (!check(seg?.stride === 1, `${id}#${n}: full density`, seg)) continue;
      const count = streamSegmentFrameCount(n, first0, last0);
      check(seg.samples === count, `${id}#${n}: sample count = number of frames this segment covers`, { samples: seg.samples, count });
      check(seg.box !== undefined, `${id}#${n}: the position rectangle is still there after filling in to full density`, seg.box ?? null);
      const meta = manifest.inits[seg.init];
      const rect = { x: meta.rect.x + spec.offset.x, y: meta.rect.y + spec.offset.y, w: meta.rect.w, h: meta.rect.h };
      const init = await fs.readFile(producer.store.initFile(spec.streamKey, seg.init));
      const bytes = await fs.readFile(path.join(producer.store.dir(spec.streamKey), seg.file));
      const decoded = await decodeSegment(ffmpeg, init, bytes, dir, `seg-${n}`);
      const frameBytes = rect.w * 2 * (rect.h + 8) * 3;
      if (!check(decoded.length === seg.samples * frameBytes, `${id}#${n}: decoded ${seg.samples} frames`, decoded.length / frameBytes)) continue;
      const first = streamSegmentFirstFrame(n, first0);
      // Reference baseline: same real frames cropped to same rectangle, passed through same encoder as is
      const plain = openStreamSegmentEncoder(ffmpeg, { encoder: denseStatus.encoder, fps: FPS, raw: { width: rect.w, height: rect.h } });
      for (let k = 0; k < count; k++) await plain.write(cropRgba(truth.rgba(first + k), WIDTH, rect));
      const plainParts = splitFmp4((await plain.finish()).bytes);
      const plainDecoded = await decodeSegment(ffmpeg, plainParts.init, plainParts.segments[0], dir, `plain-${n}`);
      for (let k = 0; k < count; k++) {
        const f = first + k;
        const picture = decoded.subarray(k * frameBytes, (k + 1) * frameBytes);
        const scores = [];
        for (let c = f - 2; c <= f + 2; c++) if (c >= Math.max(0, first0 - 1) && c <= last0) scores.push([c, (() => { const e = newError(); tallyDecodedDirect(e, picture, rect, truth.rgba(c), WIDTH); return e.count ? e.sum / e.count : 0; })()]);
        scores.sort((x, y) => x[1] - y[1]);
        if (scores[0][0] !== f) wrong.push({ frame: f, segment: n, sample: k, best: scores[0][0], scores: scores.map(([c, d]) => [c, round2(d)]) });
        else if (scores[1]) minMargin = Math.min(minMargin, scores[1][1] / Math.max(scores[0][1], 1e-6));
        tallyDecodedDirect(got, picture, rect, truth.rgba(f), WIDTH);
        tallyDecodedDirect(floor, plainDecoded.subarray(k * frameBytes, (k + 1) * frameBytes), rect, truth.rgba(f), WIDTH);
        tallyDecodedDirect(next, picture, rect, truth.rgba(f < last0 ? f + 1 : f - 1), WIDTH);
        frames++;
        if (f === first0 + 7) await savePreview(path.join(OUT, 'previews', `${id}-stream-truth-${f}.png`), cropRgba(truth.rgba(f), WIDTH, rect), rect.w, rect.h);
      }
    }
    const record = { clip: id, solo: spec.solo, streamKey: spec.streamKey.slice(0, 16), frames, tight: manifest.tight, bound: manifest.bound, resets: state.resets ?? null, replayedFrames: state.replayedFrames ?? 0,
      error: { vsItsOwnFrame: errorSummary(got), referenceSamePictureThroughEncoderAsIs: errorSummary(floor), controlNextFrame: errorSummary(next) },
      wrongFrames: wrong.slice(0, 6), wrongCount: wrong.length, minMargin: Number.isFinite(minMargin) ? round2(minMargin) : null };
    out.streams.push(record);
    say('produce-compare', { clip: id, frames, wrong: wrong.length, minMargin: record.minMargin, ...record.error });
    const g = record.error.vsItsOwnFrame, ref = record.error.referenceSamePictureThroughEncoderAsIs, nx = record.error.controlNextFrame;
    check(frames === last0 - first0 + 1, `${id}: every frame from frame ${first0} to frame ${last0} was compared`, frames);
    check(wrong.length === 0, `${id}: frame-by-frame stream production, each sample is most similar to the frame it should be`, { wrong: wrong.length, first: wrong.slice(0, 3) });
    check(g.mean <= ref.mean + 0.5 && g.bad <= ref.bad * 1.25 + g.pixels * 0.001, `${id}: the difference from its own frame is within encoding error`, { got: g, ref });
    check(nx.mean > 2 * g.mean, `${id}: the control (next frame) is clearly larger`, { got: g, next: nx });
    if (!KEEP) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  // ---------- 4. Stage stream paste, frame by frame (scrub)
  /** A batch of frames: set time frame by frame, wait for stream to draw, capture stage, and compare with the same frame and one frame before and after in `ref`. Return summary */
  const scrubFrames = async (order, ref, tag) => {
    const acc = { frames: 0, wrong: [], notDrawn: [], retried: [], placeholders: [], minMargin: Infinity, seekMs: [], same: { mean: 0, bad: 0 }, next: { mean: 0, bad: 0 }, byClip: {}, rows: [] };
    const score = (stage, f) => { const scores = [f - 1, f, f + 1].map((c) => [c, rgbDiff(stage, ref.rgb(c))]); return { scores, best: [...scores].sort((x, y) => x[1].mean - y[1].mean)[0][0] }; };
    for (const f of order) {
      const { planes, got } = await seekTo(f);
      if (planes.length !== onStage(f).length) { acc.wrong.push({ frame: f, planes: planes.length, expectPlanes: onStage(f).length }); continue; }
      if (got.ms === null) { acc.notDrawn.push({ frame: f, ...got }); continue; }
      acc.seekMs.push(got.ms);
      if (got.placeholders?.length) acc.placeholders.push({ frame: f, placeholders: got.placeholders });
      let stage = await shotStage();
      let { scores, best } = score(stage, f);
      if (best !== f) {
        // Mismatch: save first, wait a moment and capture again as-is (stage had not finished compositing at the moment of capture); if still mismatched, set time once again; record truthfully into retried
        await fs.writeFile(path.join(OUT, `stage-mismatch-${tag}-${f}.png`), toPng(stage));
        const firstTry = { best, scores: scores.map(([c, d]) => [c, round2(d.mean), d.bad]) };
        await sleep(400);
        stage = await shotStage();
        ({ scores, best } = score(stage, f));
        let how = 'reshoot';
        if (best !== f) { how = 'reseek'; await seekTo(f); await sleep(200); stage = await shotStage(); ({ scores, best } = score(stage, f)); }
        acc.retried.push({ frame: f, first: firstTry, fixedBy: best === f ? how : null });
      }
      const same = scores[1][1];
      if (best !== f) acc.wrong.push({ frame: f, best, scores: scores.map(([c, d]) => [c, round2(d.mean), d.bad]) });
      else acc.minMargin = Math.min(acc.minMargin, Math.min(scores[0][1].mean, scores[2][1].mean) / Math.max(same.mean, 1e-6));
      const other = scores[0][1].mean < scores[2][1].mean ? scores[0][1] : scores[2][1];
      acc.same.mean += same.mean; acc.same.bad += same.bad; acc.next.mean += other.mean; acc.next.bad += other.bad;
      acc.frames++;
      acc.rows.push({ frame: f, same: round2(same.mean), prev: round2(scores[0][1].mean), next: round2(scores[2][1].mean) });
      const key = onStage(f).join('+');
      const row = acc.byClip[key] ||= { frames: 0, same: 0, next: 0, sameMax: 0 };
      row.frames++; row.same += same.mean; row.next += other.mean; row.sameMax = Math.max(row.sameMax, same.mean);
      if ([100, 137, 180].includes(f)) { await fs.writeFile(path.join(OUT, `stage-${tag}-${f}.png`), toPng(stage)); await fs.writeFile(path.join(OUT, `export-${tag}-${f}.png`), toPng(ref.rgb(f))); }
    }
    const n = Math.max(1, acc.frames);
    return { frames: acc.frames, wrong: acc.wrong.slice(0, 6), wrongCount: acc.wrong.length, notDrawn: acc.notDrawn.slice(0, 6), notDrawnCount: acc.notDrawn.length,
      retried: acc.retried, retriedCount: acc.retried.length, placeholdersLeft: acc.placeholders.slice(0, 6), placeholdersLeftCount: acc.placeholders.length,
      seekMsMedian: acc.seekMs.length ? [...acc.seekMs].sort((a, b) => a - b)[acc.seekMs.length >> 1] : null, seekMsMax: acc.seekMs.length ? Math.max(...acc.seekMs) : null,
      minMargin: Number.isFinite(acc.minMargin) ? round2(acc.minMargin) : null,
      // Frames differing most from the same frame, and frames least distinguishable from adjacent frames (for human inspection: which frames are most borderline)
      worstSame: [...acc.rows].sort((x, y) => y.same - x.same).slice(0, 4),
      closest: [...acc.rows].sort((x, y) => Math.min(x.prev, x.next) / Math.max(x.same, 1e-6) - Math.min(y.prev, y.next) / Math.max(y.same, 1e-6)).slice(0, 4),
      vsExportSameFrame: { mean: round2(acc.same.mean / n), bad: Math.round(acc.same.bad / n) }, controlMoreSimilarNeighborExportFrame: { mean: round2(acc.next.mean / n), bad: Math.round(acc.next.bad / n) },
      byPresentStream: Object.fromEntries(Object.entries(acc.byClip).map(([k, r]) => [k, { frames: r.frames, same: round2(r.same / r.frames), sameMax: round2(r.sameMax), next: round2(r.next / r.frames) }])) };
  };
  // Switch page (rebuild stream player from scratch: sparse version was pasted just now, it holds the old manifest), then jump in shuffled order
  await openStage(PROJECT);
  const all = [];
  for (let f = CLIPS.fx.frames[0]; f <= CLIPS.tilt.frames[1]; f++) all.push(f);
  for (let f = CLIPS.trans.frames[0]; f <= CLIPS.trans.frames[1]; f++) all.push(f);
  const order = [...all];
  for (let i = 0; i < order.length; i++) { const j = (i * 37 + 11) % order.length; [order[i], order[j]] = [order[j], order[i]]; }
  out.scrub = await scrubFrames(order, exported, 'scrub');
  say('scrub', out.scrub);
  check(out.scrub.notDrawnCount === 0, 'drag: for every frame the stream plane drew that frame', out.scrub.notDrawn);
  check(out.scrub.placeholdersLeftCount === 0, 'Scrub: no placeholder at the moment the stream\'s frame is drawn', out.scrub.placeholdersLeft);
  check(out.scrub.retried.every((r) => r.fixedBy !== null), 'Scrub: frames that were re-captured matched when captured again as is', out.scrub.retried.slice(0, 3));
  check(out.scrub.frames === all.length, `Scrub: all ${all.length} frames where the three streams are present were compared`, out.scrub.frames);
  check(out.scrub.wrongCount === 0, 'frame-by-frame drag, the picture pasted on the stage is most similar to the same frame of the export page (not the previous or next frame)', { wrong: out.scrub.wrongCount, first: out.scrub.wrong.slice(0, 3) });
  check(out.scrub.vsExportSameFrame.mean < 3, 'drag: mean difference between the stage (stream paste) and the same export frame < 3/255', out.scrub.vsExportSameFrame);

  // ---------- 5. Real playback: start playback before fx entrance, play into tilt, pause
  {
    const forced = layersNow().map((l) => ({ clipIds: [l.clipId], key: l.key, ranges: l.ranges, originFrame: l.originFrame }));
    const from = 60;
    await rpc('setTime', from / FPS + 1e-4);
    await rpc('setStreamPlanes', forced);
    await rpc('setSuppressed', heavy);
    await page.evaluate(() => { window.__frames = []; });
    await rpc('play', from / FPS + 1e-4);
    await sleep(900);
    const stop = await rpc('pause');
    const frames = await page.evaluate(() => window.__frames);
    const steps = frames.slice(1).map((f, i) => +(f.sec - frames[i].sec).toFixed(6));
    const stopped = Math.round(stop.stoppedAt * FPS);
    await sleep(150);
    const d = await diagA();
    const stage = await shotStage();
    const scores = [stopped - 1, stopped, stopped + 1].map((c) => [c, rgbDiff(stage, exported.rgb(Math.min(c, LAST + 1)))]);
    const best = [...scores].sort((x, y) => x[1].mean - y[1].mean)[0][0];
    const active = d.streams.tracks.filter((t) => t.lastDrawn !== null);
    out.play = { from, stoppedAt: stopped, beats: frames.length, noSkip: steps.every((s) => Math.abs(s - 1 / FPS) < 1e-6),
      tracks: d.streams.tracks.map((t) => ({ id: String(t.id).slice(0, 14), lastDrawn: t.lastDrawn, drawn: t.drawn, errors: t.errors })),
      scores: scores.map(([c, x]) => [c, round2(x.mean), x.bad]), best };
    say('play', out.play);
    check(out.play.noSkip && frames.length > 5, 'playback: no frame skipping (the sec difference between frames is always 1/fps)', { beats: frames.length, steps: [...new Set(steps)] });
    check(stopped > CLIPS.tilt.frames[0] && stopped <= CLIPS.fx.frames[1], 'Playback: it reached the stretch where tilt is on top of fx', stopped);
    check(active.length >= 2 && active.every((t) => t.errors === 0 && t.drawn > 3), 'Playback: both stream planes kept drawing the whole way and the decoder reported no errors', out.play.tracks);
    check(active.every((t) => t.lastDrawn === stopped), 'playback: when paused, the stream plane stops on the paused frame', out.play.tracks);
    check(best === stopped && scores[1][1].mean < 3, 'playback: at the paused frame, the stage (stream paste) is most similar to the same frame of the export page', out.play.scores);
  }

  // ---------- 6. Changed inputs: video crop (fx), card parameters (trans), 3D angle (tilt)
  {
    const before = Object.fromEntries(states().map((s) => [s.spec.topClipId, { key: s.spec.streamKey, contentKey: s.spec.contentKey }]));
    const storedBefore = A.stored.length;
    const EDITED = project(media, { fxOffset: 1.4, swap: 1, rotateY: -30 });
    A.gate.hold = false;
    const tEdit = Date.now();
    await pipeline.preload(EDITED);
    const after = () => Object.fromEntries(states().map((s) => [s.spec.topClipId, { key: s.spec.streamKey, contentKey: s.spec.contentKey }]));
    await until('The edited version\'s streams entered the producer', () => { const a = after(); return a.fx && a.trans && a.tilt && a.fx.key !== before.fx.key ? a : null; }, 60_000, 100);
    const now = after();
    check(now.fx?.contentKey !== before.fx.contentKey, 'Changed the video\'s trim start: fx\'s stream key changed', { before: before.fx.key.slice(0, 12), after: now.fx?.key.slice(0, 12) });
    check(now.trans?.contentKey !== before.trans.contentKey, 'Changed the card\'s parameters: trans\'s stream key changed', { before: before.trans.key.slice(0, 12), after: now.trans?.key.slice(0, 12) });
    check(now.tilt?.key === before.tilt.key, 'Changed only the 3D angle: tilt\'s stream key is unchanged (3D is not in the stream)', { before: before.tilt.key.slice(0, 12), after: now.tilt?.key.slice(0, 12) });
    // Old stream does not belong to this version: producer does not have old keys, and these two cards have new keys in ready message (parent page pastes stream based on this)
    check(!producer.streams.has(before.fx.key) && !producer.streams.has(before.trans.key), 'The two old streams are not in this version', [...producer.streams.keys()].map((k) => k.slice(0, 12)));
    const redone = await until('The two edited streams finished re-production (full density)', () => { const s = allAt(producer, keysNow(), (seg) => seg?.stride === 1); return s && !producer.workers.size && !producer.encoding.size ? s : null; }, 1_800_000, 300);
    out.edit = { reproduceMs: Date.now() - tEdit, before: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.key.slice(0, 12)])), after: Object.fromEntries(Object.entries(now).map(([k, v]) => [k, v.key.slice(0, 12)])) };
    if (!check(!!redone, 'The two edited streams finished re-production', producer.status().log.slice(-6))) throw new Error('Re-production did not finish');
    const redoneKeys = new Set(A.stored.slice(storedBefore).map((s) => s.key));
    out.edit.restored = [...redoneKeys].map((k) => k.slice(0, 12));
    check(redoneKeys.has(now.fx.key) && redoneKeys.has(now.trans.key), 'What was re-produced are the new streams of fx and trans', out.edit.restored);
    check(!redoneKeys.has(now.tilt.key), 'Not a single segment of tilt\'s stream was re-produced', out.edit.restored);
    for (const id of ['fx', 'trans']) {
      const layer = A.layers.get(id);
      check(layer?.key === now[id].key, `${id}: the ready message has the new stream's key (the old stream is no longer shown)`, layer && { key: layer.key.slice(0, 12), ranges: layer.ranges });
    }
    // Export of the modified project, as reference; switch stage to modified project, sample a few frames from each of the three streams
    const exportedEdit = await exportAll(EDITED, LAST + 1, path.join(OUT, 'ref-edited'));
    await openStage(EDITED);
    const sample = [41, 55, 77, 90, 100, 113, 128, 131, 137, 144, 166, 173, 180, 188, 195];
    out.edit.scrub = await scrubFrames(sample, exportedEdit, 'edited');
    say('edit', out.edit);
    check(out.edit.scrub.notDrawnCount === 0 && out.edit.scrub.frames === sample.length, 'After the edit: every sampled frame was drawn on the stream plane', out.edit.scrub.notDrawn);
    check(out.edit.scrub.wrongCount === 0, 'After the edit: what the stage shows is most similar to the same frame exported from the edited project (fx and trans are re-produced streams; tilt is the original stream shown at the new angle)', out.edit.scrub.wrong);
    check(out.edit.scrub.vsExportSameFrame.mean < 3, 'After the edit: mean difference to the exported same frame < 3/255', out.edit.scrub.vsExportSameFrame);
    // Control: modified stage compared with export of **unmodified** project clearly does not match (indicating that what is pasted is indeed new image, not old stream)
    {
      const rows = [];
      for (const f of [100, 137, 170]) {
        await seekTo(f);
        const stage = await shotStage();
        rows.push({ frame: f, vsEdited: round2(rgbDiff(stage, exportedEdit.rgb(f)).mean), vsUnedited: round2(rgbDiff(stage, exported.rgb(f)).mean) });
      }
      out.edit.versusOld = rows;
      check(rows.every((r) => r.vsUnedited > 2 * r.vsEdited + 1), 'After the edit: clearly does not match the export of the unedited project', rows);
    }
  }
  out.servedKept = servedKept;
  await rpc('setRole', 'back', { job: 'probe' });
  }
} catch (error) {
  fails.push(`Exception: ${error?.stack || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { hostServer?.close(); } catch { /* ignore */ }
  try { await pipeline?.close(); } catch { /* ignore */ }
  try { await bakery?.close(); } catch { /* ignore */ }
  try { dropSpares(); } catch { /* ignore */ }
  try { dev?.stop(); } catch { /* ignore */ }
  if (!KEEP) {
    await sleep(1500);
    try {
      for (const name of await fs.readdir(OUT)) if (!/\.(json|png)$/.test(name) && name !== 'previews') await fs.rm(path.join(OUT, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

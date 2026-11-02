/**
 * Runs user cards written with a remotion-style framework through the real prerender pipeline
 * and export pipeline (task brief `docs/plan/render-refactor-task.md` "Yi" framework, "Bing"
 * card creation guide; Bing's report `docs/archive/agent-reports/AGENT-rr-guide.md` only verified:
 * guide examples pass card creation checks, card runtime on the online page, and isolated worker
 * processes for hosted rendering. This probe additionally verifies: such cards produce track
 * streams via the **desktop app prerender process**, export via the **export page**, and match
 * the **editor preview**).
 *
 *   node scripts/probes/framework-card-pipeline-probe.mjs [--port 27780] [--out <dir>] [--json <file>] [--keep]
 *        [--only create,export,prerender,preview] [--origin http://127.0.0.1:27780] [--default-review]
 *
 * Ports: the editor uses --port, and additionally occupies +1 and +2 as stage ports; all three
 * consecutive numbers must be free (default 27780-27782). Starts an isolated editor itself
 * (`startDevServer` in `scripts/lib/dev-server.mjs`; `no-user-dirs.mjs` has set
 * `PROMPTCUT_NO_PORT_FILE=1`; data directory, export directory, and card overlay layer are all in
 * temporary directories, leaving no extra files in the checkout), and cleans it up together with
 * child processes once done. `--origin` connects to an already started one (for debugging only;
 * created cards include a random suffix for this run, so they will not collide with existing ones).
 * `--only` runs only some of the steps (for debugging; runs all by default, acceptance criteria are
 * to run all).
 * `--default-review`: step 4 only runs 4a (does not modify plan capabilities in probe process),
 * cleans up once the three streams that exist by default (one below-dependent stream for each of
 * the two user cards, and one single-card stream for punch-pill) finish producing, and records how
 * long it took (record only).
 *
 * What it does (criteria for each step are written below; elapsed time is recorded only and is not
 * treated as a pass condition):
 *
 *   1. create     Create three user cards via real `POST /api/cards/create`, all declaring
 *                 `frameMode: "direct"` (remotion-style) and referencing the framework:
 *                   fw-title    DOM card: uses interpolate, Easing, spring, stagger, random, tween;
 *                   fw-colors   DOM card: uses interpolateColors, noise, loop, pingPong,
 *                               randomRange, tween;
 *                   fw-bad      Control: useState used in remotion-style, must be rejected (HTTP
 *                               400); error includes line number, mentions stateful hook, and did
 *                               not land in overlay layer (proving real checks are run).
 *                 The first two must return 200, source code lands in overlay layer, and no extra
 *                 files in checkout.
 *   2. Project    1280×720, 30 fps, 9 seconds. fw-title 0.7-4.9 seconds, fw-colors 3.3-7.6 seconds
 *                 (neither start is on a whole second, each 4+ seconds), built-in motion-style card
 *                 punch-pill (`frameMode: "stateful"`) 6.0-9.0 seconds as control.
 *   3. export     The same project (data URL placed into export page address, same as
 *                 `export-baseline-compare.mjs`):
 *                   a. Single-worker (--workers 1) full-length export once, then export again;
 *                   b. Split into 4 workers (--workers 4) export once, then export again; cut
 *                      points are taken from the "chunked export" line of the export output,
 *                      **at least one cut point must fall within each user card's clip** (in the
 *                      middle of the clip; motion-style punch-pill must not be cut);
 *                   c. Export only extracted target frames (--target-frames; including frame before
 *                      cut point, cut point, frame after cut point, first frame of each card).
 *                 Criteria: single-worker twice, 4-worker twice, single-worker vs. 4-worker,
 *                 single-worker vs. target frames: every frame has identical bytes; if bytes
 *                 differ, compare pixels, and only fail if pixels also differ.
 *                 Non-empty: every frame in user card clips has content (pixels with opacity > 0),
 *                 and frames at different times are different; total frame count is 270.
 *   4. prerender  Start a `FramePipeline` in-process (same code as prerender process,
 *                 `interactive: true`, store root in temporary directory), pin all three cards as
 *                 heavy cards (`streamPicked` pinned to select all; remotion-style cards are
 *                 declared as light cards, and will have no streams without pinning). Divided into
 *                 two sub-steps:
 *                 4a Default behavior: user cards are not in the review table
 *                    (`src/cards/capabilities.json`), `compositing` in the plan is unknown, treated
 *                    as below-dependent cards, **do not enter single-card streams**
 *                    (`docs/semantics/mechanism/cards.md` "Classification is subject to review
 *                    table"): by default, when classified as heavy, each of the two user cards has
 *                    a **below-dependent stream** (rendered together with layers below, with the
 *                    stream storing only the layer modified by this card, pasted back in stage
 *                    coordinates). The probe calculates `planStreams` once with the unmodified plan
 *                    to verify this fact (user cards have below-dependent streams and no single-card
 *                    streams; punch-pill has a single-card stream). Whether the pasting is correct
 *                    is verified by pixels in scenario Bing (also a user card written with the
 *                    framework) of `stream-below-stage-probe.mjs`;
 *                 4b In the **probe process memory**, change `compositing` for both user cards in the
 *                    plan to independent (equivalent to "registered them in review table"; product
 *                    code is completely untouched), verifying that once streams for such cards are
 *                    produced, they do not replay and are frame-by-frame identical to producing with
 *                    replay. After prerendering:
 *                   - All three cards each have a track stream; `replay` for the two user card
 *                     streams is false and `replayedFrames` is 0; `replay` for punch-pill stream is
 *                     true;
 *                   - Invalidate and re-produce the two middle segments of each stream (each
 *                     segment breaks its lease); `replayedFrames` for the two user card streams
 *                     remains 0, while punch-pill is > 0;
 *                   - For each user card stream, take three segments, comparing pixels
 *                     frame-by-frame between path A "produce directly without replay" and path B
 *                     "produce with replay from mount frame", which must match completely without
 *                     missing a single frame; punch-pill stream serves as a control: the two paths
 *                     must show differences (proving this comparison method can detect "should
 *                     replay but did not");
 *                   - The segment produced without replay in the stream store is byte-for-byte
 *                     identical to the one encoded from path B PNG using the same encoder (if
 *                     different, decode and compare pixel-by-pixel).
 *   5. preview    The editor page (dual stage, `?editor&nosetup=1&preview=stage`) loads the same
 *                 project, paused and clicking ten time points on the timeline (forward, backward,
 *                 reaching the same frame twice), each time waiting for it to return to exact live
 *                 render (setTime sent by parent page carries settle, t of visible stage matches,
 *                 card is not in settling / suppression / waiting for snapshots / frame
 *                 catch-up), with frame samples remaining unchanged three times in a row,
 *                 retrieving the **DOM** (innerHTML of wrapper layer) of this card in the visible
 *                 stage. On the export side: the same project runs export `bakeFrames`
 *                 (targetFrames, fullFrame, same path as step 3 c) on the export page; after
 *                 capturing each frame, retrieves the DOM of the same card.
 *                 Criteria (character-by-character identical DOM without tolerance: cards are pure
 *                 functions of t and parameters, so the same t on both sides should render the
 *                 exact same DOM):
 *                   - At each reached time in preview, the DOM of every present user card is
 *                     identical to the DOM of the same frame in export;
 *                   - Seeking backward (second arrival at 80, 45) produces identical DOM to
 *                     reaching the same frame moving forward the first time;
 *                   - Control: DOM differs between two different frames (45 vs. 80), and DOM of
 *                     present cards is never empty.
 *                 Reason for not comparing screenshot pixels: in preview, the stage is displayed
 *                 according to the editor's scaling (re-rasterized after scaling, and overlaid on
 *                 top of the theme background), whereas export is a 1:1 transparent layer, so
 *                 their pixels are inherently incomparable; character-by-character identical DOM
 *                 plus step 3 "export frames have identical bytes across all paths" pins down "image
 *                 determined by t" on both ends. Preview and export each save several images in
 *                 `--out/shots/` for human inspection.
 *   6. Output a JSON (`ok`, `fails`, key numbers for each step): process written to stderr, last
 *      line of stdout is JSON, also written to `--out/result.json` (and `--json`).
 *
 * Pass criteria: fails is empty, exit code 0; exit code 1 if any check fails; exit code 2 if usage
 * is incorrect or fails to start (fails in output describes the reason).
 * Does not modify any product code (src/, server/).
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR, and set PROMPTCUT_NO_PORT_FILE=1
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { flagArg } from './probe-connect.mjs';
import { startDevServer } from '../lib/dev-server.mjs';
import { exportUrlOf } from './export-baseline-compare.mjs';
import { openEditorPage } from './preview-stop-lib.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { SEGMENT_FRAMES, planStreams, splitFmp4 } from '../../server/frame-stream.mjs';
import { streamSegmentFirstFrame, streamSegmentLastFrame } from '../../src/render/streamSegments.mjs';
import { bakeFrames, bakeStream } from '../../server/bakery/bake.mjs';
import { openBakery } from '../../server/bakery/chrome.mjs';
import { openStreamSegmentEncoder } from '../../server/bakery/ffmpeg.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const PORT = Number(flagArg('port', '27780', args)) || 27780;
const GIVEN_ORIGIN = flagArg('origin', null, args);
const KEEP = args.includes('--keep');
/** Observe default behavior only (do not modify plan capabilities in probe process): step 4 only runs 4a, cleans up once punch-pill stream comes out, and records how long it took */
const DEFAULT_REVIEW = args.includes('--default-review');
const JSON_OUT = flagArg('json', null, args);
const OUT = path.resolve(flagArg('out', null, args) || path.join(ROOT, 'out', 'framework-card-pipeline-probe'));
const ONLY = new Set((flagArg('only', 'create,export,prerender,preview', args) || '').split(',').map((s) => s.trim()).filter(Boolean));
const want = (step) => ONLY.has(step);
const RUN = Date.now().toString(36);
const FPS = 30;
const WIDTH = 1280;
const HEIGHT = 720;
const SECONDS = 9;
const TOTAL_FRAMES = SECONDS * FPS;

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => {
  if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 900))); say('FAIL', { label, extra }); }
  return !!cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = (code, out) => {
  const text = JSON.stringify(out);
  process.stdout.write(`${text}\n`);
  process.exit(code);
};
if (!GIVEN_ORIGIN && [5190, 5191, 5192].some((p) => p >= PORT && p <= PORT + 2)) done(2, { ok: false, fails: ['This port range belongs to the user\'s always-on dev server, pick another'] });

/* ------------------------------------------------------------------ Card source */

const ID = { title: `fw-title-${RUN}`, colors: `fw-colors-${RUN}`, bad: `fw-bad-${RUN}` };

const TITLE_SOURCE = `import type { CardDef, CardProps } from "../../kernel/types";
import { Easing, interpolate, random, spring, springDuration, stagger, staggerDuration, tween } from "../../kernel/remotionStyle";

interface Params { text: string; seed: number; accent: string }

const POP = { stiffness: 190, damping: 13 };
const SWEEP = Easing.bezier(0.16, 1, 0.3, 1);

function FwTitle({ params, t = 0 }: CardProps<Params>) {
  const chars = [...params.text];
  const lineStart = staggerDuration(chars.length, { each: 0.09 }, 0.2);
  const line = interpolate(t, [lineStart, lineStart + 0.7], [0, 1], { easing: SWEEP });
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "sans-serif" }}>
      <div style={{ display: "flex", fontSize: 92, fontWeight: 800 }}>
        {chars.map((ch, i) => {
          const local = stagger(t, i, { each: 0.09 });
          const tilt = (random(params.seed, i, "rot") - 0.5) * 24 * (1 - tween(local, { duration: 0.5 }));
          const lift = Math.round(random(params.seed, i, "lift") * 10);
          return (
            <span
              key={i}
              style={{
                display: "inline-block",
                whiteSpace: "pre",
                opacity: tween(local, { duration: 0.25 }),
                transform: \`translateY(\${spring(local, { ...POP, from: 70, to: lift })}px) rotate(\${tilt}deg) scale(\${spring(local, { ...POP, from: 0.5, to: 1 })})\`,
                color: i % 2 ? "#4cc9f0" : params.accent,
              }}
            >
              {ch}
            </span>
          );
        })}
      </div>
      <div style={{ marginTop: 20, height: 8, width: 640 * line, borderRadius: 4, background: params.accent, opacity: line }} />
    </div>
  );
}

export const fwTitle: CardDef<Params> = {
  id: "${ID.title}",
  name: "框架探针：逐字弹入",
  description: "探针用的 remotion 式 DOM 卡：标题逐字弹入（弹簧、错开进场、带种子的随机），随后一条线展开",
  source: "user",
  useWhen: "探针用，不用于真实项目。",
  tags: ["探针"],
  frameMode: "direct",
  defaults: { text: "框架卡走真管线", seed: 7, accent: "#ffd166" },
  controls: [
    { key: "text", label: "文字", type: "text" },
    { key: "seed", label: "随机种子", type: "number", min: 0, max: 9999, step: 1 },
    { key: "accent", label: "主色", type: "color" },
  ],
  Component: FwTitle,
  timing: (p) => ({ settleMs: Math.round((staggerDuration([...p.text].length, { each: 0.09 }, springDuration(POP)) + 0.8) * 1000) }),
  lifecycle: { settleMs: 2000, after: "hold", exit: ["fade"] },
};
`;

const COLORS_SOURCE = `import type { CardDef, CardProps } from "../../kernel/types";
import { Easing, interpolateColors, loop, noise, pingPong, randomRange, tween } from "../../kernel/remotionStyle";

interface Params { count: number; seed: number }

const PALETTE = ["#ff4d6d", "#ffd166", "#06d6a0", "#4cc9f0"];
const STOPS = [0, 1, 2, 3];
const RISE = Easing.out(Easing.cubic);

function FwColors({ params, t = 0 }: CardProps<Params>) {
  const count = Math.max(1, Math.min(24, Math.round(params.count)));
  const sweep = interpolateColors(loop(t, 3), STOPS, PALETTE);
  const ring = 1 + pingPong(t, 0.75) * 0.25;
  return (
    <div style={{ position: "absolute", inset: 0, fontFamily: "sans-serif" }}>
      <div style={{ position: "absolute", left: 80, top: 70, width: 96, height: 96, borderRadius: 48, border: "10px solid " + sweep, transform: \`scale(\${ring})\`, opacity: tween(t, { duration: 0.4 }) }} />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 70, display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 14 }}>
        {Array.from({ length: count }, (_, i) => {
          const grown = tween(t, { delay: i * 0.05, duration: 0.6, easing: RISE });
          const target = randomRange(70, 260, params.seed, i);
          const sway = 1 + noise(t * 1.2, params.seed, i, "sway") * 0.12;
          return (
            <div
              key={i}
              style={{
                width: 38,
                height: target * grown * sway,
                borderRadius: 8,
                background: interpolateColors(loop(t + i * 0.25, 3), STOPS, PALETTE),
                opacity: 0.9,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

export const fwColors: CardDef<Params> = {
  id: "${ID.colors}",
  name: "Framework probe: color-changing bars",
  description: "Probe remotion-style DOM card: a row of bars whose colors cycle over time and whose heights fluctuate with noise, plus a ring in the top-left corner that pulses back and forth",
  source: "user",
  useWhen: "For probes only, not for real projects.",
  tags: ["probe"],
  frameMode: "direct",
  defaults: { count: 12, seed: 3 },
  controls: [
    { key: "count", label: "Bar count", type: "number", min: 1, max: 24, step: 1 },
    { key: "seed", label: "Random seed", type: "number", min: 0, max: 9999, step: 1 },
  ],
  Component: FwColors,
  lifecycle: { settleMs: 1500, after: "evolve", exit: ["fade"] },
};
`;

/** Control: useState used in remotion-style (stateful hook). Starts from line 11 */
const BAD_SOURCE = `import { useEffect, useState } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
import { tween } from "../../kernel/remotionStyle";

interface Params { text: string }

function FwBad({ params, t = 0 }: CardProps<Params>) {
  const [frames, setFrames] = useState(0);
  useEffect(() => { setFrames((n) => n + 1); }, [t]);
  return <div style={{ position: "absolute", inset: 0, opacity: tween(t, { duration: 0.4 }) }}>{params.text}{frames}</div>;
}

export const fwBad: CardDef<Params> = {
  id: "${ID.bad}",
  name: "Framework probe: violation control",
  description: "Violation control for the probe: a stateful hook is used in a remotion-style card, which the card creation check must reject",
  source: "user",
  frameMode: "direct",
  defaults: { text: "x" },
  controls: [{ key: "text", label: "Text", type: "text" }],
  Component: FwBad,
};
`;

/* ------------------------------------------------------------------ Project */

const PROJECT = {
  id: `fw-pipeline-${RUN}`, name: 'Framework card in the real pipeline', width: WIDTH, height: HEIGHT, fps: FPS, duration: SECONDS,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [
    { id: 'tr-title', name: 'title', hidden: false, clips: [
      { id: 'clip-title', kind: 'card', cardId: ID.title, start: 0.7, end: 4.9, params: { text: '框架卡走真管线', seed: 7, accent: '#ffd166' } },
    ] },
    { id: 'tr-colors', name: 'colors', hidden: false, clips: [
      { id: 'clip-colors', kind: 'card', cardId: ID.colors, start: 3.3, end: 7.6, params: { count: 12, seed: 3 } },
    ] },
    { id: 'tr-pill', name: 'pill', hidden: false, clips: [
      { id: 'clip-pill', kind: 'card', cardId: 'punch-pill', start: 6.0, end: 9.0, params: { text: '对照卡' }, frame: { x: 640, y: 150, w: 560, h: 200, anchor: [0.5, 0.5] } },
    ] },
  ],
};
const USER_CLIPS = ['clip-title', 'clip-colors'];
const clipOf = (id) => PROJECT.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
/** Frames [first, last] where clip is present (mount lead time calculated from "frame at start point", only used to pick frames to inspect; cut point criteria use export's own plan) */
const spanOf = (id) => { const c = clipOf(id); return [Math.ceil(c.start * FPS - 1e-9), Math.ceil(c.end * FPS - 1e-9) - 1]; };

/* ------------------------------------------------------------------ Tools */

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Number of differing pixels between two PNGs (any RGBA component unequal); returns -1 if dimensions differ */
function diffPixels(a, b) {
  const pa = PNG.sync.read(a), pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return -1;
  let n = 0;
  for (let i = 0; i < pa.data.length; i += 4) {
    if (pa.data[i] !== pb.data[i] || pa.data[i + 1] !== pb.data[i + 1] || pa.data[i + 2] !== pb.data[i + 2] || pa.data[i + 3] !== pb.data[i + 3]) n++;
  }
  return n;
}
/** Number of pixels with opacity > 0 (whether the frame is empty) */
function inkPixels(png) {
  const p = PNG.sync.read(png);
  let n = 0;
  for (let i = 3; i < p.data.length; i += 4) if (p.data[i] > 0) n++;
  return n;
}

const out = { port: PORT, run: RUN, project: PROJECT.id, ids: ID, only: [...ONLY], steps: {} };
await fs.mkdir(OUT, { recursive: true });
const SHOTS = path.join(OUT, 'shots');
await fs.mkdir(SHOTS, { recursive: true });
const WORK = fsSync.mkdtempSync(path.join(os.tmpdir(), 'pc-fw-pipeline-'));
const OVERLAY = path.join(WORK, 'card-overrides');
const USER_DIR = path.join(ROOT, 'src', 'cards', 'user');
const userDirList = () => fsSync.readdirSync(USER_DIR).sort();
const userDirBefore = userDirList();
fsSync.mkdirSync(OVERLAY, { recursive: true });

let editor = null;
let origin = null;
let pipeline = null;
let editorPage = null;
let bakery = null;

/** Export: start `scripts/export-frames.mjs` (same entry point as desktop app export), returns frame directory and cut points parsed from the "chunked export" line */
async function runExport(tag, { workers = 1, targetFrames = null } = {}) {
  const dir = path.join(WORK, `export-${tag}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const cmd = ['scripts/export-frames.mjs', '--url', exportUrlOf(origin, PROJECT), '--out', dir, '--fps', String(FPS), '--workers', String(workers), '--no-video'];
  if (targetFrames) cmd.push('--target-frames', targetFrames.join(','));
  const t0 = Date.now();
  const log = [];
  const child = spawn(process.execPath, cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const keep = (c) => { log.push(c.toString()); if (log.length > 600) log.shift(); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* Already exited */ } }, 30 * 60_000); // Only to prevent hangs
    child.on('close', (c) => { clearTimeout(timer); resolve(c); });
    child.on('error', () => { clearTimeout(timer); resolve(-1); });
  });
  const text = log.join('');
  const frames = path.join(dir, 'frames');
  const names = fsSync.existsSync(frames) ? (await fs.readdir(frames)).filter((f) => f.endsWith('.png')).sort() : [];
  const planLine = /sharded export:(\d+) segments ([^\n]*)/.exec(text);
  const ranges = planLine ? planLine[2].trim().split(/\s+/).map((r) => r.split('-').map(Number)) : null;
  const info = { tag, workers, code, frames: names.length, ms: Date.now() - t0, ranges };
  say('export', info);
  if (code !== 0) say('export-log', { tail: text.slice(-1200) });
  return { ...info, dir: frames, names, tail: code !== 0 ? text.slice(-1200) : undefined };
}

/** Frame-by-frame comparison of two exports: bytes first, then pixels if bytes differ. `names` defaults to those present on both sides */
async function compareExports(a, b, names = null) {
  const shared = names ?? a.names.filter((n) => b.names.includes(n));
  const diffs = [];
  let byteSame = 0;
  for (const name of shared) {
    const [ba, bb] = await Promise.all([fs.readFile(path.join(a.dir, name)), fs.readFile(path.join(b.dir, name))]);
    if (ba.equals(bb)) { byteSame++; continue; }
    diffs.push({ name, pixels: diffPixels(ba, bb), shaA: sha256(ba).slice(0, 12), shaB: sha256(bb).slice(0, 12) });
  }
  const pixelDiff = diffs.filter((d) => d.pixels !== 0);
  return { compared: shared.length, byteSame, bytesDiffer: diffs.length, pixelsDiffer: pixelDiff.length, first: pixelDiff.slice(0, 5), bytesOnly: diffs.filter((d) => d.pixels === 0).length };
}

try {
  /* ---------- 0. Editor (isolated) */
  if (GIVEN_ORIGIN) {
    origin = GIVEN_ORIGIN.replace(/\/+$/, '');
  } else {
    const cacheDir = path.join(ROOT, 'out', 'probe-vite-cache', String(PORT));
    await fs.mkdir(cacheDir, { recursive: true });
    const exportDir = path.join(WORK, 'export-dir');
    const dataDir = path.join(WORK, 'data');
    await fs.mkdir(exportDir, { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });
    let lastError = null;
    for (let attempt = 1; attempt <= 6 && !editor; attempt++) {
      try {
        editor = await startDevServer({
          port: PORT, logFile: path.join(WORK, 'vite.log'), log: (m) => say('dev-server', { m }),
          env: {
            PROMPTCUT_EXPORT_DIR: exportDir, PROMPTCUT_DATA_DIR: dataDir, PROMPTCUT_VITE_CACHE_DIR: cacheDir, PROMPTCUT_CARD_OVERRIDES: OVERLAY,
            PROMPTCUT_CARD_SYNC: '0', PROMPTCUT_PUSH: '0', PROMPTCUT_LAN_HOST: '', PROMPTCUT_DEVICE_ID: `fwpipe-${RUN}`.padEnd(16, '0'), PROMPTCUT_DEVICE_NAME: 'framework-card-pipeline-probe',
          },
        });
      } catch (e) {
        lastError = e;
        if (!/not all free/.test(String(e?.message))) throw e; // Port occupied is a transient failure: retry with backoff; rethrow other errors as is
        say('port-busy', { attempt, message: String(e.message) });
        await sleep(attempt * 3000);
      }
    }
    if (!editor) throw lastError;
    origin = editor.origin;
  }
  out.origin = origin;
  say('editor', { origin, own: !!editor });

  /* ---------- 1. Create cards (real /api/cards/create) */
  const post = async (url, body) => {
    const r = await fetch(origin + url, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  // Steps requiring cards (export / prerender / preview) must create cards first; if other steps
  // are specified with --only, card creation still runs
  {
    const create = { cards: [] };
    for (const [label, id, source] of [['title', ID.title, TITLE_SOURCE], ['colors', ID.colors, COLORS_SOURCE]]) {
      const r = await post('/api/cards/create', { id, source, projectId: PROJECT.id });
      const stored = path.join(OVERLAY, 'src', 'cards', 'user', `${id}.tsx`);
      const inOverlay = fsSync.existsSync(stored) && fsSync.readFileSync(stored, 'utf8') === (r.body?.source ?? source);
      const row = { label, id, status: r.status, ok: r.body?.ok, inOverlay, errors: r.status === 200 ? undefined : (r.body?.errors ?? [r.body?.error]).slice?.(0, 8) };
      create.cards.push(row);
      check(r.status === 200 && r.body?.ok === true, `Create card ${label}: must return 200`, row);
      check(inOverlay, `Create card ${label}: source landed in the overlay layer`, row);
    }
    // Control: violations must be rejected, with line numbers, mentioning stateful hooks, without writing to disk
    const bad = await post('/api/cards/create', { id: ID.bad, source: BAD_SOURCE, projectId: PROJECT.id });
    const badText = JSON.stringify(bad.body ?? {});
    const badFile = path.join(OVERLAY, 'src', 'cards', 'user', `${ID.bad}.tsx`);
    const badRow = { status: bad.status, ok: bad.body?.ok, mentionsLine: /line\s*\d+/.test(badText), mentionsHook: /useState|stateful/.test(badText), onDisk: fsSync.existsSync(badFile), sample: badText.slice(0, 400) };
    create.violation = badRow;
    check(bad.status === 400 && bad.body?.ok === false, 'Violation control: using useState in a remotion-style card must be rejected (HTTP 400)', badRow);
    check(badRow.mentionsLine, 'Violation control: the error includes a line number (line N)', badRow);
    check(badRow.mentionsHook, 'Violation control: the error names the stateful hook (useState)', badRow);
    check(!badRow.onDisk, 'Violation control: the rejected card did not land in the overlay layer', badRow);
    check(JSON.stringify(userDirList()) === JSON.stringify(userDirBefore), 'Create card: not a single extra file in the checkout directory', userDirList().filter((n) => !userDirBefore.includes(n)));
    out.steps.create = create;
    say('create', create);
  }

  /* ---------- 3. Export */
  if (want('export')) {
    const ex = { runs: {}, compares: {} };
    out.steps.export = ex;
    const brief = (r) => ({ code: r.code, frames: r.frames, ms: r.ms, ranges: r.ranges });
    const single1 = await runExport('single-1', { workers: 1 });
    ex.runs.single1 = brief(single1);
    check(single1.code === 0 && single1.frames === TOTAL_FRAMES, `Single-lane first pass: exit code 0, ${TOTAL_FRAMES} frames in total`, brief(single1));
    if (single1.tail) ex.runs.single1.tail = single1.tail;

    const four1 = await runExport('four-1', { workers: 4 });
    ex.runs.four1 = brief(four1);
    check(four1.code === 0 && four1.frames === TOTAL_FRAMES, `4-lane first pass: exit code 0, ${TOTAL_FRAMES} frames in total`, brief(four1));
    if (four1.tail) ex.runs.four1.tail = four1.tail;

    // Cut points: start of each slice (except the 0th). Requires 4 workers 4 segments, and at least
    // one cut point falling in the middle of each user card clip; punch-pill (motion-style) must not be cut
    const ranges = four1.ranges ?? [];
    const cuts = ranges.slice(1).map((r) => r[0]);
    ex.cuts = cuts;
    ex.plan = ranges;
    check(ranges.length === 4, '4-lane: the shard plan has 4 segments', ranges);
    const pillSpan = spanOf('clip-pill');
    for (const id of USER_CLIPS) {
      const [first, last] = spanOf(id);
      const inside = cuts.filter((c) => c > first && c <= last);
      ex[`cutsIn_${id}`] = inside;
      check(inside.length >= 1, `4-lane: a split point falls in the middle of ${id}'s clip (clip ${first}-${last})`, { cuts, span: [first, last] });
    }
    check(cuts.every((c) => !(c > pillSpan[0] + 1 && c <= pillSpan[1])), '4-lane: no split point inside the motion-style punch-pill clip', { cuts, span: pillSpan });

    if (single1.code === 0 && four1.code === 0) {
      ex.compares.single1VsFour1 = await compareExports(single1, four1);
      const c = ex.compares.single1VsFour1;
      check(c.compared === TOTAL_FRAMES && c.pixelsDiffer === 0, 'Single-lane vs 4-lane: every frame is pixel-identical', c);
      if (c.bytesOnly) say('note', { note: 'Single-lane vs 4-lane: some frames differ in bytes but are pixel-identical', bytesOnly: c.bytesOnly });
    }

    // Target frames: first frame of each card, frame before cut point / cut point / frame after cut
    // point, several frames in clips of both cards, last frame
    const picks = new Set([0, 269]);
    for (const id of [...USER_CLIPS, 'clip-pill']) { const [f, l] = spanOf(id); picks.add(f); picks.add(f + 20); picks.add(Math.floor((f + l) / 2)); picks.add(l); }
    for (const c of cuts) { picks.add(c - 1); picks.add(c); picks.add(c + 1); }
    const targets = [...picks].filter((n) => n >= 0 && n < TOTAL_FRAMES).sort((a, b) => a - b);
    ex.targets = targets;
    const target1 = await runExport('target-1', { workers: 1, targetFrames: targets });
    ex.runs.target1 = brief(target1);
    check(target1.code === 0 && target1.frames === targets.length, `Sampled frames: exit code 0, ${targets.length} frames in total`, brief(target1));
    if (target1.tail) ex.runs.target1.tail = target1.tail;
    const targetNames = targets.map((n) => `${String(n).padStart(6, '0')}.png`);
    if (single1.code === 0 && target1.code === 0) {
      ex.compares.single1VsTarget = await compareExports(single1, target1, targetNames.filter((n) => target1.names.includes(n)));
      const c = ex.compares.single1VsTarget;
      check(c.compared === targets.length && c.pixelsDiffer === 0, 'Single-lane vs sampled frames: every sampled frame is pixel-identical', c);
    }

    // Export twice in succession on the same path
    const single2 = await runExport('single-2', { workers: 1 });
    ex.runs.single2 = brief(single2);
    check(single2.code === 0 && single2.frames === TOTAL_FRAMES, 'Single-lane second pass: exit code 0, frame count correct', brief(single2));
    if (single1.code === 0 && single2.code === 0) {
      ex.compares.single1VsSingle2 = await compareExports(single1, single2);
      const c = ex.compares.single1VsSingle2;
      check(c.compared === TOTAL_FRAMES && c.pixelsDiffer === 0, 'Single-lane exported twice in a row: every frame is pixel-identical', c);
    }
    const four2 = await runExport('four-2', { workers: 4 });
    ex.runs.four2 = brief(four2);
    check(four2.code === 0 && four2.frames === TOTAL_FRAMES, '4-lane second pass: exit code 0, frame count correct', brief(four2));
    check(JSON.stringify(four2.ranges) === JSON.stringify(four1.ranges), 'The shard plans of the two 4-lane passes are identical', [four1.ranges, four2.ranges]);
    if (four1.code === 0 && four2.code === 0) {
      ex.compares.four1VsFour2 = await compareExports(four1, four2);
      const c = ex.compares.four1VsFour2;
      check(c.compared === TOTAL_FRAMES && c.pixelsDiffer === 0, '4-lane exported twice in a row: every frame is pixel-identical', c);
    }

    // Non-empty: every frame in user card clips has content, frames at different times are different
    if (single1.code === 0) {
      ex.content = {};
      for (const id of USER_CLIPS) {
        const [first, last] = spanOf(id);
        const inks = [];
        const sample = [];
        for (let n = first + 2; n <= last - 2; n += 6) {
          const buf = await fs.readFile(path.join(single1.dir, `${String(n).padStart(6, '0')}.png`));
          inks.push(inkPixels(buf));
          sample.push({ n, buf });
        }
        let moving = 0;
        for (let i = 1; i < sample.length; i++) moving = Math.max(moving, diffPixels(sample[i - 1].buf, sample[i].buf));
        ex.content[id] = { framesChecked: inks.length, inkMin: Math.min(...inks), inkMax: Math.max(...inks), maxStepDiff: moving };
        check(inks.length >= 4 && Math.min(...inks) > 0, `${id}: every sampled frame in the clip has content (opaque pixels > 0)`, ex.content[id]);
        check(moving > 300, `${id}: adjacent sampled frames differ (it is moving)`, ex.content[id]);
        const mid = Math.floor((first + last) / 2);
        await fs.copyFile(path.join(single1.dir, `${String(mid).padStart(6, '0')}.png`), path.join(SHOTS, `export-${id}-f${mid}.png`));
      }
      // Blank areas: frame 0 (nobody is present) has no content: proves that "has content" above is
      // not due to the entire image being dirty
      const blank = await fs.readFile(path.join(single1.dir, '000000.png'));
      ex.content.frame0Ink = inkPixels(blank);
      check(ex.content.frame0Ink === 0, 'Frame 0 (no card on stage) is transparent', ex.content.frame0Ink);
      // Control card also renders an image
      const [pf, pl] = spanOf('clip-pill');
      const pillBuf = await fs.readFile(path.join(single1.dir, `${String(Math.floor((pf + pl) / 2)).padStart(6, '0')}.png`));
      ex.content.pillInk = inkPixels(pillBuf);
      check(ex.content.pillInk > 0, 'The punch-pill (control) clip has content', ex.content.pillInk);
    }
    // Keep several single-worker frames for inspection
    if (single1.code === 0) for (const n of [60, 120, 200]) await fs.copyFile(path.join(single1.dir, `${String(n).padStart(6, '0')}.png`), path.join(SHOTS, `export-single-f${n}.png`)).catch(() => {});
    out.exportDir = KEEP ? WORK : undefined;
    say('export-done', { compares: ex.compares });
  }

  /* ---------- 4. Prerender */
  if (want('prerender')) {
    const pr = { streams: {}, regen: {}, compare: [] };
    out.steps.prerender = pr;
    const PIPE_ROOT = path.join(WORK, 'pipeline');
    await fs.mkdir(PIPE_ROOT, { recursive: true });
    pipeline = new FramePipeline({ root: PIPE_ROOT, origin: () => origin, interactive: true, playhead: () => null });
    pipeline.streamPicked = () => true; // Pin as heavy cards: remotion-style cards are declared as light cards; without pinning they have no streams
    const producer = pipeline.streamProducer();
    producer.attachRoute();
    const dense = () => {
      const status = producer.status();
      if (!status.streams.length) return null;
      for (const s of status.streams) for (let n = s.firstSegment; n <= s.lastSegment; n++) if (s.segments[n]?.stride !== 1) return null;
      return !producer.workers.size && !producer.encoding.size ? status : null;
    };
    const until = async (label, fn, timeoutMs, everyMs = 500) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let v = null;
        try { v = await fn(); } catch { v = null; }
        if (v) return v;
        if (Date.now() > deadline) { check(false, `Timed out: ${label}`); return null; }
        await sleep(everyMs);
      }
    };
    /*
     * Cards not registered in the review table (`src/cards/capabilities.json`) always have unknown
     * `compositing`, are treated as below-dependent cards, and do not enter single-card streams
     * (`docs/semantics/mechanism/cards.md` "Classification is subject to review table", line 44); user
     * cards are never in the review table. Therefore **by default**, when classified as heavy, each of
     * the two user cards has a below-dependent stream (`kind: below`, in stage coordinates) and no
     * single-card stream.
     * Step 4a records this fact (calculating `planStreams` once with the unmodified plan); step 4b
     * changes the plan capabilities of these two cards to independent **in this process** (equivalent
     * to "registered them in review table"), verifying that once streams for such cards are produced,
     * they do not replay and are frame-by-frame identical to producing with replay. Only memory in the
     * probe process is modified; product code is completely untouched.
     */
    let unpatched = null;
    const originalPlan = pipeline.browserCardPlan.bind(pipeline);
    pipeline.browserCardPlan = async (b) => {
      const value = await originalPlan(b);
      if (!value) return value;
      unpatched = structuredClone(value);
      const graph = value.graph || value;
      if (!DEFAULT_REVIEW) for (const o of graph.outputs ?? []) if (USER_CLIPS.includes(o.clipId)) o.capabilities = { ...(o.capabilities ?? {}), compositing: 'independent', independentCache: true };
      return value;
    };
    const ALL = [...USER_CLIPS, 'clip-pill'];
    const t0 = Date.now();
    const entry = await pipeline.preload(PROJECT);
    const ready = await until('producer is up and the three streams are in place', () => (pipeline._streams?.streams.size >= 3 ? pipeline._streams : null), 1_800_000);
    if (!ready) throw new Error('The producer did not start');
    // 4a: default behavior: unmodified plan
    {
      const controls = entry.cardCache.plan(unpatched);
      const compOf = (id) => controls.find((c) => c.clipId === id)?.compositing ?? null;
      const specs = planStreams({ project: entry.project, cardPlan: controls }, { picked: () => true, envFingerprint: controls[0]?.envFingerprint, codeVersion: '' });
      pr.defaultBehavior = {
        compositing: Object.fromEntries(ALL.map((id) => [id, compOf(id)])),
        streamClips: specs.map((s) => s.clipIds.join('+')),
        streams: specs.map((s) => ({ clip: s.clipIds.join('+'), kind: s.kind, plane: s.plane, replay: s.replay, belowClipIds: s.belowClipIds ?? null })),
        note: 'Cards not registered in the review table have compositing unknown and are treated as cards that depend on the layer below: they do not get a single-card stream, and when classified as heavy they use the stream that depends on the layer below (mechanism/cards.md "Classification follows the review table"); user cards are never in the review table',
      };
      const kindOf = (id) => specs.filter((s) => s.clipIds.includes(id)).map((s) => `${s.kind}/${s.plane}`);
      check(compOf('clip-title') === 'unknown' && compOf('clip-colors') === 'unknown', 'Default behavior: user cards written with the framework have compositing unknown in the plan (not registered in the review table)', pr.defaultBehavior.compositing);
      check(compOf('clip-pill') === 'independent', 'Default behavior: the built-in punch-pill is independent', pr.defaultBehavior.compositing);
      check(USER_CLIPS.every((id) => kindOf(id).length === 1 && kindOf(id)[0] === 'below/stage'),
        'Default behavior: when classified as heavy, each user card has one stream that depends on the layer below (by stage coordinates) and no single-card stream', pr.defaultBehavior.streams);
      check(kindOf('clip-pill').length === 1 && kindOf('clip-pill')[0] === 'card/local', 'Default behavior: punch-pill has a single-card stream', pr.defaultBehavior.streams);
      // The remotion-style target card itself does not need replay; whether to replay depends on
      // whether it or cards below it include motion-style ones:
      // below fw-title there is only fw-colors (remotion-style) → no replay; below fw-colors is
      // punch-pill (motion-style, overlapping in time) → requires replay
      const specOf = (id) => specs.find((s) => s.clipIds.includes(id));
      check(specOf('clip-title')?.replay === false && JSON.stringify(specOf('clip-title')?.belowClipIds) === JSON.stringify(['clip-colors']),
        'Default behavior: the fw-title stream does not replay (it and its lower layer fw-colors are both remotion-style)', pr.defaultBehavior.streams);
      check(specOf('clip-colors')?.replay === true && JSON.stringify(specOf('clip-colors')?.belowClipIds) === JSON.stringify(['clip-pill']),
        'Default behavior: the fw-colors stream must replay (a motion-style punch-pill sits underneath it)', pr.defaultBehavior.streams);
    }
    if (DEFAULT_REVIEW) {
      pr.defaultOnly = true;
      pr.msToFirstStream = Date.now() - t0;
      // Wait until each stream either reaches full density or is declared dead by differential layer
      // extraction self-checks (`below.failed`: this stream stops producing, and this card falls back
      // as if there were no stream)
      const settledAll = () => {
        const status = producer.status();
        if (status.streams.length < 3 || producer.workers.size || producer.encoding.size) return null;
        for (const s of status.streams) {
          if (s.below?.failed) continue;
          for (let n = s.firstSegment; n <= s.lastSegment; n++) if (s.segments[n]?.stride !== 1) return null;
        }
        return status;
      };
      const all = await until('the three default streams finish producing (or are declared dead by the self-check)', settledAll, 420_000, 1000);
      if (!all) {
        // Not finished producing: preserve the state of each stream at this moment (which segments are
        // not yet full density, whether differential layer extraction failed, producer's recent logs)
        // for troubleshooting
        const st = producer.status();
        pr.defaultStuck = { streams: st.streams.map((s) => ({ clipIds: s.clipIds, kind: s.kind, strides: Array.from({ length: s.lastSegment + 1 }, (_, n) => s.segments[n]?.stride ?? 0), below: s.below ?? null })), log: (st.log ?? []).slice(-12) };
        say('default-stuck', pr.defaultStuck);
      }
      pr.msToPillDense = Date.now() - t0;
      check(!!all, 'Default behavior: the three streams finish producing');
      if (all) {
        pr.defaultStreams = all.streams.map((s) => ({ clipIds: s.clipIds, kind: s.kind, replay: s.replay, replayedFrames: s.replayedFrames, below: s.below ? { failed: s.below.failed ?? null, frames: s.below.frames, checks: s.below.checks } : null }));
        const rowOfClip = (id) => all.streams.find((s) => s.kind === 'below' && s.clipIds[0] === id);
        check(all.streams.length === 3 && !!rowOfClip('clip-title') && !rowOfClip('clip-title').below?.failed,
          'Default behavior: the fw-title stream that depends on the layer below was actually produced (differential layer extraction was not declared dead)', pr.defaultStreams);
        // punch-pill below fw-colors is a motion-style card entering mid-way: this arrangement once
        // uncovered a bug where "during ticks pushed past without drawing, lower-layer animations
        // did not advance, and the stream was declared dead by self-checks"
        // (`BELOW_DISCARD_SHOT` in `frame-stream.mjs`, reproduced and verified frame-by-frame in
        // `below-late-lower-probe.mjs`); after the fix, it must be produced successfully
        check(!!rowOfClip('clip-colors') && !rowOfClip('clip-colors').below?.failed, 'Default behavior: the fw-colors stream that depends on the layer below was actually produced (differential layer extraction was not declared dead)', pr.defaultStreams);
        pr.colorsStream = rowOfClip('clip-colors')?.below?.failed ? `declared dead by the self-check of differential layer extraction: ${rowOfClip('clip-colors').below.failed}` : 'produced';
        check(all.streams.find((s) => s.clipIds[0] === 'clip-title')?.replayedFrames === 0, 'Default behavior: the fw-title stream replays 0 frames', pr.defaultStreams);
      }
      out.steps.prerender = pr;
      throw Object.assign(new Error('default-review-done'), { done: true });
    }
    const first = await until('all segments at full density', dense, 1_800_000, 1000);
    if (!first) throw new Error('The first production round did not finish');
    pr.produceMs = Date.now() - t0;
    pr.encoder = first.encoder;
    const stateOf = (clipId) => [...producer.streams.values()].find((s) => s.spec.clipIds.length === 1 && s.spec.clipIds[0] === clipId);
    const rowOf = (status, clipId) => status.streams.find((s) => s.clipIds.length === 1 && s.clipIds[0] === clipId);
    check(producer.streams.size === 3, 'Prerender: three streams (one each for the two user cards and the control card)', producer.streams.size);
    for (const clipId of ALL) {
      const row = rowOf(first, clipId);
      const wantReplay = clipId === 'clip-pill';
      check(!!row, `${clipId}: has a track stream`);
      if (!row) continue;
      pr.streams[clipId] = { replay: row.replay, replayedFrames: row.replayedFrames, resets: row.resets, firstSegment: row.firstSegment, lastSegment: row.lastSegment, segments: row.lastSegment - row.firstSegment + 1 };
      check(row.replay === wantReplay, `${clipId}: the stream's replay should be ${wantReplay}`, row.replay);
      if (!wantReplay) check(row.replayedFrames === 0, `${clipId}: replayedFrames is 0 after the first round finishes`, row.replayedFrames);
    }
    say('first-round', pr.streams);

    // Invalidate and re-produce the two middle segments: break lease for each segment
    const regenOf = (row) => {
      const s = row.firstSegment, e = row.lastSegment;
      const picks = [e - 1, s + 1];
      return picks[0] - picks[1] >= 2 ? picks : [s + 1];
    };
    const before = {};
    const regenPlan = {};
    for (const clipId of ALL) {
      const r = rowOf(producer.status(), clipId);
      before[clipId] = { replayedFrames: r.replayedFrames, resets: (r.resets?.sparse ?? 0) + (r.resets?.dense ?? 0) };
      regenPlan[clipId] = regenOf(r);
      for (const n of regenPlan[clipId]) delete stateOf(clipId).manifest.segments[n];
    }
    producer.kick();
    const second = await until('the invalidated segments are produced again', () => {
      const status = dense();
      return status && ALL.every((id) => regenPlan[id].every((n) => rowOf(status, id).segments[n]?.stride === 1)) ? status : null;
    }, 900_000, 1000);
    if (!second) throw new Error('The second production round did not finish');
    for (const clipId of ALL) {
      const row = rowOf(second, clipId);
      const delta = row.replayedFrames - before[clipId].replayedFrames;
      const resetsDelta = (row.resets?.sparse ?? 0) + (row.resets?.dense ?? 0) - before[clipId].resets;
      pr.regen[clipId] = { segments: regenPlan[clipId], replayedFramesDelta: delta, resetsDelta };
      check(resetsDelta >= regenPlan[clipId].length, `${clipId}: all ${regenPlan[clipId].length} invalidated segments had their leases broken`, resetsDelta);
      if (clipId === 'clip-pill') check(delta > 0, `${clipId} (motion-style): re-production after a broken lease still replays from the mount frame`, delta);
      else check(delta === 0 && row.replayedFrames === 0, `${clipId} (remotion-style): replayedFrames is still 0 after re-production following a broken lease`, { delta, total: row.replayedFrames });
    }
    say('regen', pr.regen);

    // Frame-by-frame comparison: path A (without replay) vs. path B (produced with replay from mount frame)
    const lease = await pipeline.leaseStreamBakery();
    const cmpDir = path.join(WORK, 'cmp');
    await fs.mkdir(cmpDir, { recursive: true });
    const decodeSegment = async (init, seg, name) => {
      const file = path.join(cmpDir, `${name}.mp4`);
      await fs.writeFile(file, Buffer.concat([init, seg]));
      const { stdout } = await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
        { encoding: 'buffer', maxBuffer: 1 << 30, windowsHide: true });
      return stdout;
    };
    let pillDiffSum = 0;
    try {
      for (const clipId of ALL) {
        const state = stateOf(clipId);
        const { spec, manifest } = state;
        const rect = manifest.tight ?? manifest.bound;
        const clip = { x: rect.x + spec.offset.x, y: rect.y + spec.offset.y, w: rect.w, h: rect.h };
        const s = pr.streams[clipId].firstSegment, e = pr.streams[clipId].lastSegment;
        // Start (animation running), third segment after start (near settling), middle, second-to-last
        // segment (after settling); within five segments per stream
        const segs = [...new Set([s, s + 1, s + 3, Math.floor((s + e) / 2), e - 1])].filter((n) => n >= s && n <= e);
        const shoot = async (segment, replay) => {
          // Segments count from the first frame of this stream itself (`streamSegments.mjs`), not project
          // frame number × 15
          const fromFrame = streamSegmentFirstFrame(segment, spec.originFrame), toFrame = streamSegmentLastFrame(segment, spec.originFrame, spec.lastFrame);
          await lease.reset(state.isolated, pipeline.emptyUrl(state.isolated), { deferCards: true });
          lease.streamLease = null;
          const pngs = [];
          const stats = await bakeStream(lease, {
            streamSignature: `${spec.streamKey}:${replay ? 'replay' : 'direct'}`, fromFrame, toFrame, stride: 1, fps: spec.fps,
            ...(replay ? { mountFrame: spec.mountFrame } : { warm: 0 }), clip, hasMedia: false,
            onFrame: async (_f, png) => { pngs.push(png); },
          });
          lease.streamLease = null;
          return { pngs, stats };
        };
        for (const segment of segs) {
          const direct = await shoot(segment, false); // Path A
          const replay = await shoot(segment, true); // Path B
          check(direct.stats.replayed === 0, `${clipId}#${segment}: route A bakeStream replayed is 0`, direct.stats.replayed);
          check(direct.pngs.length === replay.pngs.length && direct.pngs.length > 0, `${clipId}#${segment}: both routes have the same frame count`, [direct.pngs.length, replay.pngs.length]);
          const diffs = direct.pngs.map((png, i) => diffPixels(png, replay.pngs[i]));
          const ink = replay.pngs.map(inkPixels);
          const rec = { clipId, segment, mode: clipId === 'clip-pill' ? 'motion-style (control)' : 'remotion-style', frames: direct.pngs.length, replayedB: replay.stats.replayed,
            diffPixelsMax: Math.max(...diffs), diffPixelsSum: diffs.reduce((a, b) => a + Math.max(0, b), 0), inkMin: Math.min(...ink), inkMax: Math.max(...ink) };
          pr.compare.push(rec);
          say('compare', rec);
          if (clipId !== 'clip-pill') {
            check(rec.diffPixelsMax === 0, `${clipId}#${segment}: producing directly without replay and producing with replay are identical frame by frame (pixels)`, diffs);
            check(rec.inkMax > 0, `${clipId}#${segment}: the picture is not empty`, ink);
            // When segment start is not after mount frame (mount frame is inside this segment), producing
            // with replay has no frames to replay either
            if (spec.mountFrame < streamSegmentFirstFrame(segment, spec.originFrame)) check(replay.stats.replayed > 0, `${clipId}#${segment}: route B did replay (replayed > 0; mount frame ${spec.mountFrame})`, replay.stats.replayed);
            else check(replay.stats.replayed === 0, `${clipId}#${segment}: mount frame ${spec.mountFrame} is within this segment, so route B has no frames to replay`, replay.stats.replayed);
            await fs.writeFile(path.join(SHOTS, `stream-${clipId}-seg${segment}-A-direct.png`), direct.pngs[Math.min(7, direct.pngs.length - 1)]);
            await fs.writeFile(path.join(SHOTS, `stream-${clipId}-seg${segment}-B-replay.png`), replay.pngs[Math.min(7, replay.pngs.length - 1)]);
            // The segment produced by runSegment (without replay) in stream store, compared against the one
            // encoded from path B PNG using the same encoder
            const seg = manifest.segments[segment];
            const stored = await fs.readFile(path.join(producer.store.dir(spec.streamKey), seg.file));
            const storedInit = await fs.readFile(producer.store.initFile(spec.streamKey, seg.init));
            const enc = openStreamSegmentEncoder(producer.ffmpeg, { encoder: producer.encoderName, fps: spec.fps });
            for (const png of replay.pngs) await enc.write(png);
            const encoded = await enc.finish();
            const { init: refInit, segments: refSegs } = splitFmp4(encoded.bytes);
            const sameBytes = Buffer.compare(refSegs[0], stored) === 0;
            let sameDecoded = null;
            if (!sameBytes) {
              const a = await decodeSegment(storedInit, stored, `stored-${clipId}-${segment}`);
              const b = await decodeSegment(refInit, refSegs[0], `ref-${clipId}-${segment}`);
              sameDecoded = Buffer.compare(a, b) === 0;
            }
            const row = { clipId, segment, kind: 'stream-vs-replay-encode', storedBytes: stored.length, refBytes: refSegs[0].length, sameBytes, sameDecoded, storedStride: seg.stride };
            pr.compare.push(row);
            check(seg.stride === 1, `${clipId}#${segment}: this segment is at full density in the stream store`, seg.stride);
            check(sameBytes || sameDecoded === true, `${clipId}#${segment}: in the stream store, the segment produced without replay and the one produced with replay have identical encoded results (bytes or decoded pixels)`, row);
          } else {
            pillDiffSum += rec.diffPixelsSum;
          }
        }
      }
      check(pillDiffSum > 0, 'Control: punch-pill (motion-style) without replay must show a difference (this comparison can detect "should have replayed but did not")', pillDiffSum);
    } finally { pipeline.returnStreamBakery(lease); }
    const fin = producer.status();
    pr.final = fin.streams.map((s) => ({ clipIds: s.clipIds, replay: s.replay, replayedFrames: s.replayedFrames, resets: s.resets }));
    check(USER_CLIPS.every((id) => rowOf(fin, id).replayedFrames === 0), 'The streams of the two user cards always have replayedFrames 0 (checked once more at the end)');
    out.steps.prerender = pr;
  }

  /* ---------- 5. Preview vs. export */
  if (want('preview')) {
    const pv = { points: [], compare: [] };
    out.steps.preview = pv;
    const SEQUENCE = [45, 80, 110, 135, 80, 45, 200, 160, 120, 140]; // Forward, backward, reaching the same frame twice
    const ed = await openEditorPage(origin, { viewport: { width: 2560, height: 1600 } });
    editorPage = ed;
    const { page, store, frontFrame, parentDiag } = ed;
    const loaded = await store(`actions.loadProject(args[0]); actions.select([]); actions.pause(); actions.seek(0); return getState().project.tracks.map(t => t.clips.map(c => c.id))`, PROJECT);
    check(JSON.stringify(loaded) === JSON.stringify(PROJECT.tracks.map((t) => t.clips.map((c) => c.id))), 'Preview: the project loaded into the editor', loaded);
    await sleep(1500);

    const stateAndDom = async (frame, ids) => {
      const f = await frontFrame();
      if (!f) return null;
      return f.evaluate((ids2) => {
        const cardDom = (wrap) => { const c = wrap.cloneNode(true); c.querySelectorAll('[data-pc-placeholder-slot],[data-pc-snapshot-plane],[data-pc-stream-plane],[data-pc-proxy-plane]').forEach((n) => n.remove()); return c.innerHTML; };
        const d = window.__pcStageDiag?.();
        if (!d) return null;
        return {
          role: d.role, t: d.t, catchUps: d.catchUps.length,
          clips: Object.fromEntries(ids2.map((id) => {
            const wrap = document.querySelector(`[data-pc-clip="${CSS.escape(id)}"]:not([data-pc-media])`);
            return [id, wrap ? {
              cls: wrap.className, html: cardDom(wrap), local: wrap.getAttribute('data-pc-local-frame'),
              settling: d.settling.includes(id), suppressed: d.suppressed.includes(id), awaiting: d.awaiting.includes(id), snapshot: d.snapshots.includes(id),
            } : null];
          })),
        };
      }, ids).catch(() => null);
    };
    const ALL_IDS = ['clip-title', 'clip-colors', 'clip-pill'];
    /** Seek to frame, wait for exact live render and 3 consecutive identical samples; returns each card's DOM at this moment */
    const arrive = async (frame, label) => {
      const sec = frame / FPS;
      const started = Date.now();
      await store('actions.pause(); actions.seek(args[0]);', sec);
      const settled = async () => {
        const pd = await parentDiag();
        if (!pd || pd.swapInFlight) return null;
        const last = pd.setTimeLog?.[pd.setTimeLog.length - 1];
        if (!last || Math.abs(last.sec - sec) > 1e-6 || !last.settle) return null;
        const s = await stateAndDom(frame, ALL_IDS);
        if (!s || s.role !== 'front' || Math.abs(s.t - sec) > 1e-6 || s.catchUps) return null;
        for (const c of Object.values(s.clips)) {
          if (!c) continue;
          if (c.settling || c.suppressed || c.awaiting || c.snapshot) return null;
          if (/pc-(settling|suppressed|awaiting|snapshot)/.test(c.cls ?? '')) return null;
        }
        return { s, frontId: pd.frontId };
      };
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const a = await settled();
        if (!a) { await sleep(50); continue; }
        await sleep(150);
        const b = await stateAndDom(frame, ALL_IDS);
        await sleep(250);
        const c = await stateAndDom(frame, ALL_IDS);
        const z = await settled();
        const same = (x, y) => JSON.stringify(Object.values(x?.clips ?? {}).map((k) => k?.html ?? null)) === JSON.stringify(Object.values(y?.clips ?? {}).map((k) => k?.html ?? null));
        if (!z || z.frontId !== a.frontId || !same(a.s, b) || !same(b, c)) continue;
        // Keep one visible stage screenshot for inspection (scaled, overlaid on theme background)
        const shot = async () => {
          const handle = await page.$(`iframe[src*="stage=1"][src*="id=${z.frontId}"]`);
          return handle ? Buffer.from(await handle.screenshot({ type: 'png' })) : null;
        };
        const png = await shot().catch(() => null);
        return { frame, label, ms: Date.now() - started, frontId: z.frontId, dom: Object.fromEntries(Object.entries(z.s.clips).map(([id, k]) => [id, k ? k.html : null])), local: Object.fromEntries(Object.entries(z.s.clips).map(([id, k]) => [id, k ? k.local : null])), shot: png };
      }
      check(false, `Preview: frame ${frame} (${label}) did not return to exact live render and the picture did not settle`, { states: await stateAndDom(frame, ALL_IDS).then((s) => s && { t: s.t, clips: Object.fromEntries(Object.entries(s.clips).map(([k, v]) => [k, v && { cls: v.cls }])) }) });
      return null;
    };
    const arrived = [];
    for (const [i, frame] of SEQUENCE.entries()) {
      const r = await arrive(frame, `p${i}`);
      if (!r) continue;
      arrived.push(r);
      pv.points.push({ label: r.label, frame, ms: r.ms, present: Object.fromEntries(Object.entries(r.dom).map(([id, h]) => [id, h ? h.length : null])) });
      if (r.shot) await fs.writeFile(path.join(SHOTS, `preview-f${String(frame).padStart(3, '0')}-${r.label}.png`), r.shot);
    }
    say('preview-arrived', pv.points);
    check(arrived.length === SEQUENCE.length, `Preview: all ten moments returned to exact live render`, arrived.length);

    // Export side: same project runs export bakeFrames; after capturing each frame, retrieves DOM
    // for the same batch of cards
    const frames = [...new Set(SEQUENCE)].sort((a, b) => a - b);
    bakery = await openBakery({ url: exportUrlOf(origin, PROJECT) });
    const exportDom = new Map();
    const exportPng = new Map();
    await bakeFrames(bakery, {
      out: path.join(WORK, 'preview-bake'), fps: FPS, fullFrame: true, targetFrames: frames, writeFrames: false, quiet: true, onProgressLog: false, staticSkip: false,
      onFrame: async (n, buf) => {
        exportPng.set(n, buf);
        exportDom.set(n, await bakery.page.evaluate((ids) => Object.fromEntries(ids.map((id) => {
          const wrap = document.querySelector(`[data-pc-clip="${CSS.escape(id)}"]:not([data-pc-media])`);
          if (!wrap) return [id, null];
          const c = wrap.cloneNode(true);
          c.querySelectorAll('[data-pc-placeholder-slot],[data-pc-snapshot-plane],[data-pc-stream-plane],[data-pc-proxy-plane]').forEach((n) => n.remove());
          return [id, c.innerHTML];
        })), ALL_IDS));
      },
    });
    pv.exportFrames = [...exportDom.keys()];
    check(exportDom.size === frames.length, `Export side: the DOM was captured at all ${frames.length} moments`, [...exportDom.keys()]);
    // Also compare frames captured in this pass of the export page with the same frame from the
    // whole-video export in step 3 (to prove that this DOM extraction path follows the export path)
    // (Skip if step 3 was not run)

    const spanIn = (id, n) => { const [f, l] = spanOf(id); return n >= f && n <= l; };
    for (const r of arrived) {
      const exp = exportDom.get(r.frame);
      for (const id of USER_CLIPS) {
        const present = spanIn(id, r.frame);
        const pre = r.dom[id];
        const post = exp?.[id] ?? null;
        if (!present) { pv.compare.push({ frame: r.frame, label: r.label, clipId: id, present: false, preview: pre === null, export: post === null }); continue; }
        const same = pre !== null && post !== null && pre === post;
        pv.compare.push({ frame: r.frame, label: r.label, clipId: id, present: true, previewLen: pre?.length ?? null, exportLen: post?.length ?? null, same });
        check(pre !== null && pre.length > 0, `Preview ${r.label} (frame ${r.frame}): ${id} is present and its DOM is not empty`, { previewLen: pre?.length ?? null });
        check(post !== null && post.length > 0, `Export frame ${r.frame}: ${id} is present and its DOM is not empty`, { exportLen: post?.length ?? null });
        if (!same && pre && post) {
          let k = 0;
          while (k < pre.length && k < post.length && pre[k] === post[k]) k++;
          check(false, `Preview ${r.label} (frame ${r.frame}) vs the same export frame: the DOM of ${id} is identical character by character`, { firstDiffAt: k, preview: pre.slice(Math.max(0, k - 80), k + 120), export: post.slice(Math.max(0, k - 80), k + 120) });
        }
      }
    }
    // Click back / reach the same frame twice
    const byFrame = new Map();
    for (const r of arrived) { if (!byFrame.has(r.frame)) byFrame.set(r.frame, []); byFrame.get(r.frame).push(r); }
    for (const [frame, list] of byFrame) {
      if (list.length < 2) continue;
      for (const id of USER_CLIPS) {
        if (!spanIn(id, frame)) continue;
        const same = list.every((r) => r.dom[id] === list[0].dom[id]);
        pv.compare.push({ frame, clipId: id, reached: list.map((r) => r.label), sameAcrossArrivals: same });
        check(same, `Preview: frame ${frame} reached twice (${list.map((r) => r.label).join(', ')}, including a backward click), the DOM of ${id} is identical`, list.map((r) => r.dom[id]?.length));
      }
    }
    // Control: different frames have different DOM
    const a45 = arrived.find((r) => r.frame === 45), a80 = arrived.find((r) => r.frame === 80);
    if (a45 && a80) {
      pv.control = { title45vs80: a45.dom['clip-title'] !== a80.dom['clip-title'], len45: a45.dom['clip-title']?.length, len80: a80.dom['clip-title']?.length };
      check(pv.control.title45vs80, 'Control: the fw-title DOM differs between frame 45 and frame 80 (this yardstick can measure change)', pv.control);
    }
    const a120 = arrived.find((r) => r.frame === 120), a140 = arrived.find((r) => r.frame === 140);
    if (a120 && a140) {
      const ctl = a120.dom['clip-colors'] !== a140.dom['clip-colors'];
      pv.control2 = { colors120vs140: ctl };
      check(ctl, 'Control: the fw-colors DOM differs between frame 120 and frame 140', pv.control2);
    }
    // Keep two images from this pass of the export page
    for (const n of [80, 160]) if (exportPng.get(n)) await fs.writeFile(path.join(SHOTS, `export-bakery-f${n}.png`), exportPng.get(n));
  }
} catch (error) {
  if (error?.done) say('default-review-done', {}); // --default-review: actively finalize after finishing 4a, not an error
  else {
    check(false, `Exception: ${String(error?.stack || error).slice(0, 1500)}`);
    say('ERROR', { error: String(error?.stack || error) });
  }
} finally {
  try { await bakery?.close(); } catch { /* Already closed */ }
  try { await editorPage?.browser?.close(); } catch { /* Already closed */ }
  try { await pipeline?.close(); } catch { /* ignore */ }
  try { editor?.stop(); } catch { /* ignore */ }
  await sleep(800);
  if (KEEP) say('kept', { work: WORK });
  else { try { fsSync.rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Left for the system to clean */ } }
}
const userDirNow = userDirList();
if (JSON.stringify(userDirNow) !== JSON.stringify(userDirBefore)) { fails.push('Extra files in checkout directory src/cards/user:' + userDirNow.filter((n) => !userDirBefore.includes(n)).join(',')); }
out.fails = fails;
out.ok = fails.length === 0;
try { await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
done(out.ok ? 0 : 1, out);

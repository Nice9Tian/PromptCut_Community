/**
 * Video frame-fetching cadence probe (`docs/plan/TODO.md` "User physical device defects" item:
 * uneven cadence in video input source of media effect cards during 0.5x slow-motion export).
 * This behavior is the regression baseline going forward; a G0-R "prerender probe" line, required
 * to run whenever touching frame fetching, decoding, media effect card video sources, or
 * `src/render/frameMedia.ts`.
 *
 *   node scripts/probes/video-source-cadence-probe.mjs [--port 6030] [--keep]
 *
 * Approach:
 *   - ffmpeg synthesizes two assets: 30 fps and 25 fps, each 3 s, 64×64, frame n full grayscale =
 *     16 × (n mod 16) (RGB value, neutral chroma; step size 16, resilient to lossy encoding).
 *     TODO specifies 2 s, but 3 s is used here: case (3) with mediaOffset 0.35 needs up to frame
 *     69, while 2 s only has 60 frames.
 *   - A 30 fps, 256×144 project, with each test case a 2 s (60 frames) segment arranged end-to-end
 *     on the timeline:
 *       (1) Media effect card node (pass-through media effect card `probe-cadence-pass` outputting
 *           upstream as-is) input source rate 0.5, offset 0 and 0.35 (10.5 frames, non-integer
 *           frame);
 *       (2) Same media effect card rate 1, offset 0;
 *       (3) Regular timeline video clip mediaOffset 0 and 0.35 (covering `src/render/frameMedia.ts`);
 *       (4) 25 fps asset through media effect card rate 1 (plus an additional 25 fps timeline clip,
 *           following the same rule).
 *   - Start a dev server (export directory and data directory are newly created temporary
 *     directories; pass-through media effect card is written to temporary card overlay layer
 *     `PROMPTCUT_CARD_OVERRIDES`, writing zero files to checkout directory), and `exportFrames`
 *     exports the full video as PNGs in a single process.
 *   - Read average grayscale of center 16×16 for each frame, round to multiples of 16 to obtain
 *     n mod 16, and reconstruct source frame number m(n) by monotonicity.
 *   - Assert m(n) = floor((offset + rate × n / 30) × source frame rate + 1e-6) (where n is the
 *     frame index within this segment).
 *
 * Outputs a single JSON line at the end: `{ ok, fails: [], cases: [{ name, got, want, bad }] }`;
 * exit code 0 if and only if `fails` is empty.
 * Ports: editor `--port`, stage takes +1 and +2; default 6030. `--keep` preserves temporary
 * directories (frames, logs).
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { startDevServer } from '../lib/dev-server.mjs';
import { findFfmpeg } from '../../server/bakery/ffmpeg.mjs';
import { exportFrames } from '../../server/bakery/export.mjs';

const args = process.argv.slice(2);
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 6030);
const KEEP = args.includes('--keep');
const RUN = Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
const WORK = path.join(os.tmpdir(), `pc-cadence-probe-${RUN}`);
const MEDIA_DIR = path.join(WORK, 'media');
const DATA_DIR = path.join(WORK, 'data');
const OVERRIDES = path.join(WORK, 'card-overrides');
const EXPORT_ID = 'cadence';
const OUT_DIR = path.join(WORK, `export-${EXPORT_ID}`);
fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const fails = [];
const out = { ok: false, port: PORT, work: WORK };
const log = (msg) => console.log(`[cadence] ${msg}`);

const FPS = 30, SEG = 60, W = 256, H = 144, SRC_SECONDS = 3;

/* ---------------- Assets ---------------- */

const ffmpeg = await findFfmpeg();
function makeSource(rate) {
  const tmp = path.join(WORK, `src-${rate}.mp4`);
  const r = spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=black:s=64x64:r=${rate}:d=${SRC_SECONDS}`,
    '-vf', "format=rgb24,geq=r='16*mod(N\\,16)':g='16*mod(N\\,16)':b='16*mod(N\\,16)',format=yuv420p",
    '-c:v', 'libx264', '-crf', '4', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmp], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`Failed to synthesize ${rate} fps media: ${r.stderr}`);
  const bytes = fs.readFileSync(tmp);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.renameSync(tmp, path.join(MEDIA_DIR, `${hash}.mp4`));
  return { id: `m${rate}`, kind: 'video', name: `cadence-${rate}.mp4`, url: `/@media/${hash}`, hash, duration: SRC_SECONDS, width: 64, height: 64, fps: rate };
}
const src30 = makeSource(30);
const src25 = makeSource(25);

/* ---------------- Pass-through media effect card (written to temporary overlay layer) ---------------- */

const CARD_ID = 'probe-cadence-pass';
const cardFile = path.join(OVERRIDES, 'src', 'cards', 'user', `${CARD_ID}.tsx`);
fs.mkdirSync(path.dirname(cardFile), { recursive: true });
fs.writeFileSync(cardFile, `import type { CardDef } from "../../kernel/types";
import { glsl } from "../../render/cards/graphValues";

/** Probe only: outputs the upstream as is (video-source-cadence-probe.mjs temporarily writes it into the overlay layer) */
export const probeCadencePass: CardDef<Record<string, never>> = {
  id: "${CARD_ID}",
  name: "Cadence probe passthrough",
  description: "Outputs the input frame unchanged",
  source: "user",
  kind: "filter",
  frameMode: "direct",
  inputs: { source: { description: "Input frame" } },
  defaults: {},
  controls: [],
  card: (sources, t) => glsl(
    \`uniform sampler2D u_input0;
     void main() { outColor = texture(u_input0, v_uv); }\`,
    [sources.source.at(t)],
  ),
};
`);

/* ---------------- Project ---------------- */

/** kind: 'card' goes through media effect card node; 'clip' goes through timeline video clip */
const CASES = [
  { name: '(1) media effect card rate 0.5 offset 0', kind: 'card', media: src30, rate: 0.5, offset: 0 },
  { name: '(1) media effect card rate 0.5 offset 0.35', kind: 'card', media: src30, rate: 0.5, offset: 0.35 },
  { name: '(2) media effect card rate 1 offset 0', kind: 'card', media: src30, rate: 1, offset: 0 },
  { name: '(3) timeline clip mediaOffset 0', kind: 'clip', media: src30, rate: 1, offset: 0 },
  { name: '(3) timeline clip mediaOffset 0.35', kind: 'clip', media: src30, rate: 1, offset: 0.35 },
  { name: '(4) media effect card 25 fps media rate 1', kind: 'card', media: src25, rate: 1, offset: 0 },
  { name: '(4) timeline clip 25 fps media', kind: 'clip', media: src25, rate: 1, offset: 0 },
];

const cardNodes = [
  { id: 'src30', adapter: 'media', media: src30, inputs: {} },
  { id: 'src25', adapter: 'media', media: src25, inputs: {} },
];
const tracks = [];
CASES.forEach((c, i) => {
  const start = (i * SEG) / FPS, end = ((i + 1) * SEG) / FPS;
  c.start = start;
  const clipId = `case-${i}`;
  if (c.kind === 'card') {
    const nodeId = `pass-${i}`;
    cardNodes.push({ id: nodeId, adapter: 'card', cardId: CARD_ID, kind: 'filter', params: {},
      inputs: { source: { nodeId: c.media === src30 ? 'src30' : 'src25', offset: c.offset, rate: c.rate } } });
    tracks.push({ id: `tr-${i}`, name: `tr-${i}`, hidden: false, clips: [{ id: clipId, kind: 'card', cardId: CARD_ID, nodeId, start, end, params: {} }] });
  } else {
    tracks.push({ id: `tr-${i}`, name: `tr-${i}`, hidden: false, clips: [{ id: clipId, cardId: '', mediaId: c.media.id, mediaOffset: c.offset, start, end, volume: 0 }] });
  }
});
const PROJECT = {
  id: `cadence-${RUN}`, name: 'Video frame-fetch cadence probe', width: W, height: H, fps: FPS, duration: (CASES.length * SEG) / FPS,
  themeId: 'dark', camera3dFov: 50, media: [src30, src25], filters: [], pixelMaps: [], audioFx: [], cardNodes, style: {}, tracks,
};
fs.writeFileSync(path.join(OUT_DIR, 'project.json'), JSON.stringify(PROJECT));

/* ---------------- Export ---------------- */

const env = { PROMPTCUT_EXPORT_DIR: WORK, PROMPTCUT_DATA_DIR: DATA_DIR, PROMPTCUT_CARD_OVERRIDES: OVERRIDES, PROMPTCUT_NO_PORT_FILE: '1' };
let server = null;
try {
  server = await startDevServer({ env, port: PORT, logFile: path.join(WORK, 'vite.log'), log });
  log(`dev server ${server.origin} (stage ${server.stagePorts.join(' / ')})`);
  Object.assign(process.env, env);
  const url = `${server.origin}/?export=1&timeline=/@export/${EXPORT_ID}/project.json`;
  const t0 = Date.now();
  await exportFrames({ url, out: OUT_DIR, noVideo: true, workers: 1 });
  out.exportMs = Date.now() - t0;
  if (server.restarts()) fails.push(`dev server restarted ${server.restarts()} times during export`);

  /* ---------------- Read frames, reconstruct source frame numbers ---------------- */

  const framesDir = path.join(OUT_DIR, 'frames');
  const level = (frame) => {
    const file = path.join(framesDir, `${String(frame).padStart(6, '0')}.png`);
    if (!fs.existsSync(file)) return null;
    const png = PNG.sync.read(fs.readFileSync(file));
    let sum = 0, count = 0;
    for (let y = (png.height >> 1) - 8; y < (png.height >> 1) + 8; y++) {
      for (let x = (png.width >> 1) - 8; x < (png.width >> 1) + 8; x++) {
        const i = (png.width * y + x) << 2;
        sum += png.data[i] + png.data[i + 1] + png.data[i + 2]; count += 3;
      }
    }
    const mean = sum / count;
    return { mean, level: ((Math.round(mean / 16) % 16) + 16) % 16, off: Math.abs(mean - 16 * Math.round(mean / 16)) };
  };
  out.cases = [];
  CASES.forEach((c, i) => {
    const want = Array.from({ length: SEG }, (_, n) => Math.floor((c.offset + (c.rate * n) / FPS) * c.media.fps + 1e-6));
    const got = [];
    let prev = null, maxOff = 0, missing = 0;
    for (let n = 0; n < SEG; n++) {
      const l = level(i * SEG + n);
      if (!l) { missing++; got.push(null); continue; }
      maxOff = Math.max(maxOff, l.off);
      let m;
      if (prev === null) m = l.level + 16 * Math.round((want[0] - l.level) / 16); // First frame: take the cycle closest to expectation
      else m = prev + ((l.level - (prev % 16) + 16) % 16);                       // Afterwards: monotonically non-decreasing, each step < 16
      got.push(m); prev = m;
    }
    const bad = want.map((w, n) => (got[n] === w ? null : { n, got: got[n], want: w })).filter(Boolean);
    out.cases.push({ name: c.name, start: c.start, maxLevelError: +maxOff.toFixed(2), missing, got: got.join(','), want: want.join(','), bad: bad.length });
    if (missing) fails.push(`${c.name}: ${missing} frames missing`);
    if (maxOff > 6) fails.push(`${c.name}: gray level too far from a multiple of 16 (${maxOff.toFixed(1)}), reading unreliable`);
    if (bad.length) fails.push(`${c.name}: ${bad.length} frames have a mismatched source frame number, first few: ${JSON.stringify(bad.slice(0, 6))}`);
  });
} catch (e) {
  fails.push('Exception:' + (e?.stack || e?.message || String(e)));
} finally {
  server?.stop();
  if (!KEEP) {
    await new Promise((r) => setTimeout(r, 1500));
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { log(`Temp directory not removed: ${e.message}`); }
  } else log(`Leaving temp directory ${WORK}`);
}

out.fails = fails;
out.ok = fails.length === 0;
for (const c of out.cases ?? []) log(`${c.bad ? '✗' : '✓'} ${c.name}\n    got  ${c.got}\n    want ${c.want}`);
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);

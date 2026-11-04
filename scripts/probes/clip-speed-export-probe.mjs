/**
 * End-to-end export probe for clip speed (`TrackClip.speed`, `src/kernel/clipTime.mjs`): verifies
 * **frame-by-frame** which asset frame the speed-changed clip's video takes, and verifies that the
 * speed-changed clip's original audio is indeed muted in the final video ([ruling] speed-changed clip
 * original audio is muted in the first version); separated audio clips from audio-visual separation
 * shift pitch according to the multiplier across two mix paths and the two paths match.
 *
 *   node scripts/probes/clip-speed-export-probe.mjs --port 5920 [--tree <checkout-root>] [--out <dir>] [--skip-audio]
 *
 * `--tree` defaults to the checkout where this probe resides; passing a tree extracted from the
 * kickoff commit (such as `out/base-5a8f375a`) serves as the "before changes" baseline, using that
 * tree's own dev server and export script. Asset catalog, data directory, and card overlay layers
 * are all created under `--out`, writing no files to the checkout directory; dev servers are
 * cleaned up by PID after use, writing no port file (`PROMPTCUT_NO_PORT_FILE=1`).
 *
 * Asset: a 20-second, 30 fps, 320×180 video, with frame N painted entirely in one color:
 * r = 8 × (N mod 32), g = 8 × ⌊N / 32⌋, b = 128; during decoding, N is inferred from the color
 * (each tier spaced by 8, encoding error well below half a tier); also includes a 440 Hz sine tone.
 *
 * Project (640×360, 30 fps, 16 s), back-to-back clips on the main track, all filling the frame:
 *
 *   A  0-2 s    1×     starting from asset second 1         control group (default 1, no speed)
 *   B  2-4 s    2×     starting from second 0.5
 *   C  4-6 s    0.5×   starting from second 3
 *   D  6-8 s    cut segment: quotes cut "inner", from its second 0.5; that cut contains a 2×
 *               video, starting from asset second 1
 *   E  8-10 s   4×     starting from second 2
 *   F  10-12 s  0.25×  starting from second 5
 *   G  12-14 s  2×     starting from second 6, wrapped with a media effect card (invert color, frame
 *               fetch follows asset node `rate`)
 *   H  14-16 s  1×     starting from second 9               control group
 *
 * Checks:
 *   1. Video: full 480 PNG frames (`--workers 1 --no-video`); take screen center of each frame to
 *      decode asset frame number, compared with `⌊(asset time + 2 ms) × 30⌋` (asset time =
 *      mediaOffset + (t − start) × speed; export frame fetch seeks to asset time + 2 ms, with a
 *      presentation timestamp no later than its last frame). Requires 480/480 frame-by-frame match.
 *   2. Audio: export final video of the same project twice: default Chrome offline mix
 *      (`src/audio/renderMix.ts`) and `--audio ffmpeg` (`server/bakery/mux-audio.mjs`): loudness of
 *      the middle 1.4 s of each clip: A and H have audio (above −30 dBFS), B-G are silent
 *      (below −70 dBFS).
 *
 * Outputs JSON conclusion; exits non-zero if any check fails.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';

const execFileAsync = promisify(execFile);
setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 40 * 60_000).unref();

const HERE = path.resolve(fileURLToPath(import.meta.url), '../../..');
const argv = process.argv.slice(2);
const arg = (name, dflt = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const TREE = path.resolve(arg('tree', HERE));
const PORT = Number(arg('port', 0)) || undefined;
const OUT = path.resolve(arg('out', path.join(HERE, 'out', 'clip-speed-export', path.basename(TREE))));
const SKIP_AUDIO = argv.includes('--skip-audio');
/** For troubleshooting: speed of clip G (the one with the media effect card), defaults to 2 */
const G_SPEED = Number(arg('g-speed', 2));
const FPS = 30, W = 640, H = 360, SRC_SECONDS = 20, DURATION = 16;
const WORK = path.join(OUT, 'work');
const MEDIA_DIR = path.join(WORK, 'media');
const OVERRIDES = path.join(WORK, 'card-overrides');
const TINT = 'probe-speed-tint';
const say = (m) => console.error(`[speed-probe] ${m}`);

async function findFfmpeg() {
  const { findFfmpeg: f } = await import(pathToFileURL(path.join(TREE, 'server/bakery/ffmpeg.mjs')).href);
  return f();
}

/** Frame N painted entirely in one color + 440 Hz sine tone */
async function makeVideo(ffmpeg) {
  const tmp = path.join(WORK, 'coded.mp4');
  await execFileAsync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=black:s=320x180:r=${FPS}:d=${SRC_SECONDS},format=rgb24,geq=r='8*mod(N\\,32)':g='8*floor(N/32)':b='128'`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${SRC_SECONDS}`,
    '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '4', '-g', String(FPS),
    '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', tmp], { windowsHide: true });
  const bytes = await fs.readFile(tmp);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  await fs.rename(tmp, path.join(MEDIA_DIR, `${hash}.mp4`));
  return { id: 'm-coded', kind: 'video', name: 'coded.mp4', url: `/@media/${hash}`, hash, duration: SRC_SECONDS, width: 320, height: 180, fps: FPS };
}

async function writeCard() {
  const dir = path.join(OVERRIDES, 'src', 'cards', 'user');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${TINT}.tsx`), `import "../../kernel/remotionStyle";
import type { CardDef } from "../../kernel/types";
import { glsl } from "../../render/cards/graphValues";

/** For the probe (clip-speed-export-probe.mjs temporarily writes it into the overlay layer): inverts the input image */
export const probeSpeedTint: CardDef<{ amount: number }> = {
  id: "${TINT}",
  name: "Speed probe: invert",
  description: "Inverts the colors of the input image",
  source: "user",
  kind: "filter",
  frameMode: "direct",
  inputs: { source: { description: "Input image" } },
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
}

const full = { x: 0, y: 0, w: W, h: H, anchor: [0, 0], scale: 1, rotate: 0 };
const SEGMENTS = [
  { id: 'A', start: 0, end: 2, mediaOffset: 1, audible: true, hz: 440 },
  // Video original audio for clips B and C does not play; the "audio" track below has a separated
  // audio clip each (same speed), playing sound pitch-shifted according to the multiplier
  { id: 'B', start: 2, end: 4, mediaOffset: 0.5, speed: 2, audible: true, hz: 880 },
  { id: 'C', start: 4, end: 6, mediaOffset: 3, speed: 0.5, audible: true, hz: 220 },
  { id: 'D', start: 6, end: 8, cut: { cutOffset: 0.5, inner: { mediaOffset: 1, speed: 2, start: 0 } } },
  { id: 'E', start: 8, end: 10, mediaOffset: 2, speed: 4 },
  { id: 'F', start: 10, end: 12, mediaOffset: 5, speed: 0.25 },
  { id: 'G', start: 12, end: 14, mediaOffset: 6, speed: G_SPEED === 1 ? undefined : G_SPEED, tint: true },
  { id: 'H', start: 14, end: 16, mediaOffset: 9, audible: true, hz: 440 },
];

function projectOf(media) {
  const clips = SEGMENTS.map((s) => s.cut
    ? { id: s.id, cardId: '', cutId: 'inner', cutOffset: s.cut.cutOffset, start: s.start, end: s.end, params: {}, frame: full }
    // Clip with a media effect card (G): looks just like after attaching via apply_card; clip carries
    // card (cardId), media (mediaId), and node (nodeId)
    : { id: s.id, cardId: s.tint ? TINT : '', mediaId: media.id, mediaOffset: s.mediaOffset, start: s.start, end: s.end, params: s.tint ? { amount: 1 } : {}, frame: full, label: s.id,
      ...(s.speed ? { speed: s.speed } : {}), ...(s.tint ? { nodeId: 'n-tint' } : {}) });
  const inner = SEGMENTS.find((s) => s.cut).cut.inner;
  return {
    version: 1, id: 'p-speed-probe', name: 'speed-probe', width: W, height: H, fps: FPS, duration: DURATION, themeId: 'midnight',
    // Audio asset separated from audio-visual (shares the same file with video, kind is audio, same as
    // soundAssetFrom in store)
    media: [media, { ...media, id: 'm-coded-sound', kind: 'audio', name: 'Sound of coded.mp4', soundOf: media.id }], filters: [], audioFx: [],
    cardNodes: [{ id: 'n-tint', adapter: 'card', cardId: TINT, kind: 'filter', params: { amount: 1 }, inputs: { source: '@clip/G/source' } }],
    tracks: [{ id: 't-main', name: 'Track 1', clips: clips.map((c) => (c.id === 'B' || c.id === 'C' ? { ...c, audioMuted: true } : c)) },
      { id: 't-sound', name: 'Sound', clips: SEGMENTS.filter((x) => x.id === 'B' || x.id === 'C').map((x) => ({ id: `${x.id}-sound`, cardId: '', mediaId: 'm-coded-sound', mediaOffset: x.mediaOffset, start: x.start, end: x.end, speed: x.speed, params: {} })) }],
    cuts: [{ id: 'outer', name: 'Cut 1' }, { id: 'inner', name: 'Inner', duration: 8, transitions: [], tracks: [{ id: 't-in', name: 'Track 1', clips: [
      { id: 'b1', cardId: '', mediaId: media.id, mediaOffset: inner.mediaOffset, speed: inner.speed, start: inner.start, end: 8, params: {}, frame: full },
    ] }] }],
    activeCutId: 'outer',
  };
}

/** Which asset frame should be displayed at frame i (t = i / fps) */
function expectedFrame(i) {
  const t = i / FPS;
  const s = SEGMENTS.find((x) => t >= x.start - 1e-9 && t < x.end - 1e-9);
  let m;
  if (s.cut) {
    const u = s.cut.cutOffset + (t - s.start); // Time within the referenced cut
    m = s.cut.inner.mediaOffset + (u - s.cut.inner.start) * s.cut.inner.speed;
  } else m = s.mediaOffset + (t - s.start) * (s.speed ?? 1);
  return { seg: s.id, media: m, frame: Math.floor((m + 0.002) * FPS + 1e-6), tint: !!s.tint };
}

function decodeFrame(file, tint) {
  const png = PNG.sync.read(fsSync.readFileSync(file));
  const sample = (x, y) => { const o = (y * png.width + x) * 4; return [png.data[o], png.data[o + 1], png.data[o + 2]]; };
  const acc = [0, 0, 0];
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const p = sample((png.width >> 1) + dx, (png.height >> 1) + dy); for (let k = 0; k < 3; k++) acc[k] += p[k]; }
  let [r, g, b] = acc.map((v) => v / 25);
  if (tint) [r, g, b] = [255 - r, 255 - g, 255 - b];
  return { frame: Math.round(r / 8) + 32 * Math.round(g / 8), rgb: [r, g, b].map((v) => Math.round(v)) };
}

function run(cmd, args, env, logFile) {
  return new Promise((resolve) => {
    const log = fsSync.createWriteStream(logFile, { flags: 'a' });
    const p = spawn(cmd, args, { cwd: TREE, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    p.stdout.pipe(log); p.stderr.pipe(log);
    p.on('close', (code) => { log.end(); resolve(code); });
    p.on('error', () => resolve(1));
  });
}

/** Decode audio of final video into 48 kHz mono float (entire track) */
async function pcmOf(ffmpeg, file) {
  const { stdout } = await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'],
    { windowsHide: true, encoding: 'buffer', maxBuffer: 1 << 28 });
  const out = new Float32Array(stdout.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = stdout.readFloatLE(i * 4);
  return out;
}
const win = (pcm, a, b) => pcm.subarray(Math.round(a * 48000), Math.round(b * 48000));
/** Loudness for [a, b) seconds (dBFS, RMS) */
function loudness(pcm, a, b) {
  const x = win(pcm, a, b);
  if (!x.length) return -Infinity;
  let sum = 0;
  for (const v of x) sum += v * v;
  return 10 * Math.log10(sum / x.length + 1e-20);
}
/** Dominant frequency for [a, b) seconds (zero-crossing count / 2 / duration) */
function pitch(pcm, a, b) {
  const x = win(pcm, a, b);
  let n = 0;
  for (let i = 1; i < x.length; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) n++;
  return n / 2 / ((b - a) || 1);
}
/** Difference between both paths in same window: difference signal loudness minus signal loudness (dB, lower is closer) */
function diffDb(p1, p2, a, b) {
  const x = win(p1, a, b), y = win(p2, a, b);
  const n = Math.min(x.length, y.length);
  let d = 0, e = 0;
  for (let i = 0; i < n; i++) { d += (x[i] - y[i]) ** 2; e += x[i] * x[i]; }
  return 10 * Math.log10((d + 1e-20) / (e + 1e-20));
}

const result = { tree: TREE, out: OUT, ok: false, fails: [] };
let dev = null;
try {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  await fs.mkdir(path.join(WORK, 'data'), { recursive: true });
  const ffmpeg = await findFfmpeg();
  const media = await makeVideo(ffmpeg);
  await writeCard();
  const project = projectOf(media);
  await fs.writeFile(path.join(OUT, 'project.json'), JSON.stringify(project, null, 1));
  const env = { PROMPTCUT_EXPORT_DIR: WORK, PROMPTCUT_DATA_DIR: path.join(WORK, 'data'), PROMPTCUT_CARD_OVERRIDES: OVERRIDES, PROMPTCUT_NO_PORT_FILE: '1',
    PROMPTCUT_CARD_SYNC: '0', PROMPTCUT_PUSH: '0', PROMPTCUT_LAN_HOST: '' };
  Object.assign(process.env, env);
  const { startDevServer } = await import(pathToFileURL(path.join(TREE, 'scripts/lib/dev-server.mjs')).href);
  dev = await startDevServer({ env, port: PORT, logFile: path.join(OUT, 'vite.log'), log: say });
  say(`dev server ${dev.origin}(pid ${dev.pid})`);
  const timeline = 'data:application/json,' + encodeURIComponent(JSON.stringify(project));
  const url = `${dev.origin}/?export=1&timeline=${encodeURIComponent(timeline)}`;

  // 1. Video: frame-by-frame
  let code = 1;
  for (let attempt = 1; attempt <= 3 && code !== 0; attempt++) {
    say(`Exporting PNG, attempt ${attempt}`);
    code = await run(process.execPath, ['scripts/export-frames.mjs', '--url', url, '--out', path.join(OUT, 'frames-run'), '--fps', String(FPS), '--workers', '1', '--no-video'], env, path.join(OUT, 'export-frames.log'));
  }
  if (code !== 0) throw new Error(`PNG export exit code ${code} (log ${path.join(OUT, 'export-frames.log')})`);
  const dir = path.join(OUT, 'frames-run', 'frames');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.png')).sort();
  const rows = [];
  for (let i = 0; i < files.length; i++) {
    const want = expectedFrame(i);
    const got = decodeFrame(path.join(dir, files[i]), want.tint);
    rows.push({ i, seg: want.seg, media: +want.media.toFixed(4), want: want.frame, got: got.frame, rgb: got.rgb });
  }
  const bySeg = {};
  for (const r of rows) {
    const s = (bySeg[r.seg] ??= { frames: 0, match: 0, firstMismatch: null });
    s.frames++;
    if (r.want === r.got) s.match++;
    else s.firstMismatch ??= { frame: r.i, mediaTime: r.media, want: r.want, got: r.got };
  }
  const match = rows.filter((r) => r.want === r.got).length;
  result.frames = { total: rows.length, expected: DURATION * FPS, match, bySeg };
  await fs.writeFile(path.join(OUT, 'frames.json'), JSON.stringify(rows));
  if (rows.length !== DURATION * FPS) result.fails.push(`Exported ${rows.length} frames, expected ${DURATION * FPS}`);
  if (match !== rows.length) result.fails.push(`Frame by frame: ${match}/${rows.length} frames fetched the media frame they should have`);

  // 2. Audio: export final video once for each of the two mix paths
  if (!SKIP_AUDIO) {
    result.audio = {};
    const pcms = {};
    for (const [name, extra] of [['chrome', []], ['ffmpeg', ['--audio', 'ffmpeg']]]) {
      // Chrome offline mix requires page URL to be /@export/<id>/project.json (trimmed wav is fetched by
      // this id, server/bakery/audio-mix.mjs); using data: URLs results in "Chrome mix failed, fallback to
      // ffmpeg", turning both paths into the same one. So arrange per product export layout:
      // <export-dir>/export-<id>/
      const id = `speed-${name}`;
      const outDir = path.join(WORK, `export-${id}`);
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(path.join(outDir, 'project.json'), JSON.stringify(project));
      const url = `${dev.origin}/?export=1&timeline=${encodeURIComponent(`/@export/${id}/project.json`)}`;
      let c = 1;
      for (let attempt = 1; attempt <= 3 && c !== 0; attempt++) {
        say(`Exporting final video (${name} mix), attempt ${attempt}`);
        c = await run(process.execPath, ['scripts/export-frames.mjs', '--url', url, '--out', outDir, '--fps', String(FPS), '--workers', '1', ...extra], env, path.join(OUT, `export-${name}.log`));
      }
      if (c !== 0) { result.fails.push(`Final video (${name} mix) export exit code ${c}`); continue; }
      // Verify both paths truly run independently: Chrome run must genuinely mix in Chrome without
      // falling back to ffmpeg
      const log = await fs.readFile(path.join(OUT, `export-${name}.log`), 'utf8');
      const mixedIn = /falling back to ffmpeg/.test(log) ? 'ffmpeg (fell back after Chrome failed)' : /in Chrome/.test(log) ? 'chrome' : /Muxing .* with ffmpeg/.test(log) ? 'ffmpeg' : 'unknown';
      if (mixedIn !== name) result.fails.push(`The ${name} attempt actually mixed in ${mixedIn}`);
      const mp4 = (await fs.readdir(outDir)).find((f) => f.endsWith('.mp4'));
      if (!mp4) { result.fails.push(`Final video (${name} mix) has no mp4`); continue; }
      const file = path.join(outDir, mp4);
      const pcm = await pcmOf(ffmpeg, file);
      pcms[name] = pcm;
      const segs = {};
      for (const s of SEGMENTS) {
        const db = loudness(pcm, s.start + 0.3, s.end - 0.3);
        const hz = pitch(pcm, s.start + 0.3, s.end - 0.3);
        const okDb = s.audible ? db > -30 : db < -70;
        const okHz = !s.hz || Math.abs(hz - s.hz) <= s.hz * 0.02;
        segs[s.id] = { dBFS: Number.isFinite(db) ? +db.toFixed(1) : null, hz: s.audible ? +hz.toFixed(1) : null, expect: s.audible ? `audible ${s.hz} Hz` : 'silent', ok: okDb && okHz };
        if (!okDb) result.fails.push(`${name} mix: segment ${s.id} (${s.start} to ${s.end} seconds) should be ${s.audible ? 'audible' : 'silent'}, measured ${db.toFixed(1)} dBFS`);
        if (s.audible && !okHz) result.fails.push(`${name} mix: the dominant frequency of segment ${s.id} should be ${s.hz} Hz, measured ${hz.toFixed(1)} Hz`);
      }
      result.audio[name] = { file, mixedIn, segs };
    }
    // Compare both mix paths clip by clip: for clips with audio, how many dB lower difference signal
    // is than the signal itself
    if (pcms.chrome && pcms.ffmpeg) {
      result.audio.chromeVsFfmpeg = {};
      for (const s of SEGMENTS.filter((x) => x.audible)) {
        const d = diffDb(pcms.chrome, pcms.ffmpeg, s.start + 0.3, s.end - 0.3);
        result.audio.chromeVsFfmpeg[s.id] = +d.toFixed(1);
      }
      // Yardstick: the two paths are not sample-by-sample identical to begin with (Chrome offline mix +
      // encoding vs ffmpeg mix + encoding); difference in 1× clips serves as baseline for this yardstick;
      // difference between both paths for speed-changed audio clips (B, C) cannot be greater than the
      // maximum difference among 1× clips (A, H)
      const floor = Math.max(...SEGMENTS.filter((x) => x.audible && !x.speed).map((x) => result.audio.chromeVsFfmpeg[x.id]));
      result.audio.oneXFloor = floor;
      for (const s of SEGMENTS.filter((x) => x.audible && x.speed)) {
        const d = result.audio.chromeVsFfmpeg[s.id];
        if (!(d <= floor + 1e-9)) result.fails.push(`The two mix paths differ by ${d} dB in segment ${s.id} (${s.speed}×), more than the ${floor} dB of the 1× segment`);
      }
    }
  }
  result.ok = result.fails.length === 0;
} catch (error) {
  result.fails.push(String(error?.stack || error));
} finally {
  try { dev?.stop(); } catch {}
}
console.log(JSON.stringify(result, null, 1));
process.exit(result.ok ? 0 : 1);

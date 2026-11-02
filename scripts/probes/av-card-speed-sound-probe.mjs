/**
 * Export end-to-end probe for integrated audio-visual cards attached to speed-changed media clips
 * playing audio as usual (user decision, 2026-10-23: "Play sound.", overturning [ruling] V21-28):
 * Dominant frequencies of those clips in final video scale with playback rate, and after "generate
 * audio first, then split speed-changed clip", generated audio aligns as before without regeneration.
 *
 *   node scripts/probes/av-card-speed-sound-probe.mjs --port 5940 [--out <dir>]
 *
 * This probe starts a dev server from this tree itself (ports `--port`, +1, and +2 must be free,
 * avoiding 5190~5192; export, data, and overlay layer are all under `--out`, no port file written),
 * opening the editor in headless Chrome (`--mute-audio`, no sound to speakers).
 *
 * Asset: 20-second video with a 440 Hz sine tone. Card: temporary integrated audio-visual card
 * `probe-av-pass` written into overlay layer (has visual component, has `audio()`, audio passes input
 * `source` samples through as is; just like after apply_card, clip has cardId / mediaId / nodeId, and
 * node input is this clip's own asset). Project 10 seconds, one track:
 *
 *     A 0~2 s    1x    From asset second 1    Expected 440 Hz
 *     B 2~4 s    2x    From second 0.5        Expected 880 Hz
 *     C 4~6 s    0.5x  From second 3          Expected 220 Hz
 *     D 6~10 s   2x    From second 4          Expected 880 Hz; **generate audio first, then split at 8 s** (store's splitClip)
 *
 * Steps and assertions (one PASS/FAIL line per item, final line prints a JSON line, exit code 1 on failure):
 *   N0  Pre-export manifest: all four clips need generation (ungenerated); pre-change assertProjectCardAudio
 *       only named A (speed-changed clips were skipped with no sound), not seen here
 *   G   prepareExportSounds generates audio for four clips
 *   S   Split D at 8 s: manifest is empty after split (generated audio still covers both halves, not judged
 *       expired); second half's playback offset = first half + 2 s (timeline seconds)
 *   E   Desktop export (`window.__pcIo.exportVideo()`) succeeds without generating audio again
 *   A/B/C/D1/D2  Middle of each final video clip (excluding 0.3 s at both ends) has sound (above -30 dBFS),
 *                dominant frequency (zero-crossings and DFT peak) within +/-2% of expected value
 *   DX  Window spanning split point (7.5~8.5 s) is also 880 Hz, loudness differs from D1 by under 1 dB
 *       (no discontinuity at split point)
 *   V   Visuals: card's red bar width = card clock / 10 s * frame width. Frame before split point
 *       (frame 239, 1.967 s into first half clip) and frame at split point (frame 240, 0 s into second half)
 *       differ in red bar width by under 4 pixels, and both are roughly 0.4 * 640 = 256 pixels
 *       (card clock = mediaOffset / rate + intra-clip time = 4/2 + 2 = 4 s); pre-change card clock start
 *       was mediaOffset (asset seconds), frame before was ~382 pixels, jumping to 512 pixels at split frame.
 *       Both frames saved as PNG under --out
 *   E0  Zero errors on page
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startDevServer, REPO } from '../lib/dev-server.mjs';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 40 * 60_000).unref();
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(arg('--port', 5940));
const OUT = path.resolve(arg('--out', path.join(REPO, 'out', 'av-card-speed-sound')));
const FPS = 30, W = 640, H = 360, SRC_SECONDS = 20, DURATION = 10, SR = 48000;
const PASS = 'probe-av-pass';
fs.rmSync(OUT, { recursive: true, force: true });
const dirs = { exportDir: path.join(OUT, 'export'), dataDir: path.join(OUT, 'data'), projectsDir: path.join(OUT, 'projects'), overrides: path.join(OUT, 'card-overrides') };
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
const MEDIA_DIR = path.join(dirs.exportDir, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const fails = [];
const check = (key, cond, note, extra) => {
  results[key] = { ok: !!cond, note, ...(extra !== undefined ? { extra } : {}) };
  if (!cond) fails.push(`${key}: ${note}`);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${key} ${note} ${extra !== undefined ? JSON.stringify(extra).slice(0, 600) : ''}`);
};

function makeVideo() {
  const tmp = path.join(OUT, 'tone.mp4');
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=gray:s=320x180:r=${FPS}:d=${SRC_SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${SRC_SECONDS}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', String(FPS),
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', tmp], { windowsHide: true });
  const hash = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
  fs.renameSync(tmp, path.join(MEDIA_DIR, `${hash}.mp4`));
  return { id: 'm-tone', kind: 'video', name: 'tone.mp4', url: `/@media/${hash}`, hash, duration: SRC_SECONDS, width: 320, height: 180, fps: FPS };
}

const CARD_SOURCE = [
  'import type { CardDef, CardProps } from "../../kernel/types";',
  '',
  '/** Probe only (temporarily written into the override layer by av-card-speed-sound-probe.mjs): audio-visual card whose sound passes the input sound through unchanged; the picture is a red bar, width = card clock ÷ 10 seconds */',
  'function Frame({ t = 0 }: CardProps<{ gain: number }>) {',
  '  return <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${Math.min(1, Math.max(0, t / 10)) * 100}%`, background: "#ff0000" }} />;',
  '}',
  'export const probeAvPass: CardDef<{ gain: number }> = {',
  `  id: "${PASS}",`,
  '  name: "Speed probe: audio-visual passthrough",',
  '  description: "The picture draws the card clock, the sound outputs the input unchanged",',
  '  source: "user",',
  '  kind: "animation",',
  '  frameMode: "direct",',
  '  inputs: { source: { description: "Input media" } },',
  '  defaults: { gain: 1 },',
  '  controls: [],',
  '  Component: Frame,',
  '  audio: async (sources, range, params) => {',
  '    const block = await sources.source.block(range.start, range.count);',
  '    const out = new Float32Array(block.length);',
  '    for (let i = 0; i < block.length; i++) out[i] = block[i] * params.gain;',
  '    return out;',
  '  },',
  '};',
  '',
].join('\n');

const full = { x: 0, y: 0, w: W, h: H, anchor: [0, 0], scale: 1, rotate: 0 };
const SEGMENTS = [
  { id: 'A', start: 0, end: 2, mediaOffset: 1, hz: 440 },
  { id: 'B', start: 2, end: 4, mediaOffset: 0.5, speed: 2, hz: 880 },
  { id: 'C', start: 4, end: 6, mediaOffset: 3, speed: 0.5, hz: 220 },
  { id: 'D', start: 6, end: 10, mediaOffset: 4, speed: 2, hz: 880 },
];
const SPLIT_AT = 8;

function projectOf(media) {
  const clips = [], cardNodes = [];
  for (const s of SEGMENTS) {
    cardNodes.push({ id: `n-${s.id}`, adapter: 'card', cardId: PASS, kind: 'animation', embeddedAudio: true, params: { gain: 1 }, inputs: { source: { nodeId: `@clip/${s.id}/source` } } });
    clips.push({ id: s.id, cardId: PASS, mediaId: media.id, nodeId: `n-${s.id}`, embeddedAudio: true, mediaOffset: s.mediaOffset, start: s.start, end: s.end,
      params: { gain: 1 }, frame: full, ...(s.speed ? { speed: s.speed } : {}) });
  }
  return { version: 1, id: 'p-av-card-speed', name: 'av-card-speed-sound', width: W, height: H, fps: FPS, duration: DURATION, themeId: 'midnight',
    media: [media], filters: [], audioFx: [], cardNodes, tracks: [{ id: 't-main', name: 'Track 1', clips }] };
}

/** Final video frame n (rgb24), measure count of leftmost consecutive red pixels on row y */
function redBar(file, n, png) {
  // Commas in filter arguments must be escaped as "\," (passed to ffmpeg as is, not through shell)
  const vf = `select=eq(n\\,${n})`;
  const buf = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', vf, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { windowsHide: true, maxBuffer: 1 << 26 });
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-vf', vf, '-vframes', '1', png], { windowsHide: true });
  const y = Math.floor(H / 2);
  let w = 0;
  for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; if (buf[i] > 180 && buf[i + 1] < 90 && buf[i + 2] < 90) w = x + 1; else if (w) break; }
  return w;
}

function pcmOf(file) {
  const buf = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'],
    { windowsHide: true, maxBuffer: 1 << 28 });
  const out = new Float32Array(buf.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}
const win = (pcm, a, b) => pcm.subarray(Math.round(a * SR), Math.round(b * SR));
function loudness(pcm, a, b) {
  const x = win(pcm, a, b);
  if (!x.length) return -Infinity;
  let sum = 0;
  for (const v of x) sum += v * v;
  return 10 * Math.log10(sum / x.length + 1e-20);
}
/** Zero-crossing count / 2 / duration (same approach as speed-audio-input-probe.mjs) */
function pitch(pcm, a, b) {
  const x = win(pcm, a, b);
  let n = 0;
  for (let i = 1; i < x.length; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) n++;
  return n / 2 / ((b - a) || 1);
}
/** Single-frequency DFT peak finding (100~2000 Hz, 1 Hz per step), cross-validated with zero-crossings */
function peakHz(pcm, a, b) {
  const x = win(pcm, a, b);
  let best = 0, bestHz = 0;
  for (let hz = 100; hz <= 2000; hz++) {
    let re = 0, im = 0;
    const w = 2 * Math.PI * hz / SR;
    for (let i = 0; i < x.length; i += 2) { re += x[i] * Math.cos(w * i); im += x[i] * Math.sin(w * i); }
    const p = re * re + im * im;
    if (p > best) { best = p; bestHz = hz; }
  }
  return bestHz;
}

fs.mkdirSync(path.join(dirs.overrides, 'src', 'cards', 'user'), { recursive: true });
fs.writeFileSync(path.join(dirs.overrides, 'src', 'cards', 'user', `${PASS}.tsx`), CARD_SOURCE);
const media = makeVideo();
const project = projectOf(media);
fs.writeFileSync(path.join(OUT, 'project.json'), JSON.stringify(project, null, 1));

const server = await startDevServer({ port: PORT, logFile: path.join(OUT, 'vite.log'), log: (m) => console.log('[dev]', m),
  env: { PROMPTCUT_EXPORT_DIR: dirs.exportDir, PROMPTCUT_DATA_DIR: dirs.dataDir, PROMPTCUT_PROJECTS_DIR: dirs.projectsDir, PROMPTCUT_CARD_OVERRIDES: dirs.overrides,
    PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_PUSH: '0', PROMPTCUT_CARD_SYNC: '0', PROMPTCUT_LAN_HOST: '' } });
const browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--mute-audio', '--force-device-scale-factor=1'], protocolTimeout: 15 * 60_000 });
const report = { out: OUT };
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => { void d.dismiss(); });
  await page.goto(`${server.origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForFunction(() => !!window.__pcStore && !!window.__pcIo, { timeout: 120_000 });
  await page.waitForFunction(async (id) => { const { getCard } = await import('/src/kernel/registry.ts'); return !!getCard(id); }, { timeout: 120_000, polling: 1000 }, PASS);
  await sleep(3000);
  await page.evaluate((p) => window.__pcStore.actions.loadProject(JSON.parse(JSON.stringify(p))), project);
  await sleep(500);

  const pre = await page.evaluate(async () => {
    const sound = await window.__pcIo.sound();
    const needs = await sound.listExportSoundNeeds(new AbortController().signal);
    return needs.map((n) => ({ clipId: n.clipId, reason: n.reason }));
  });
  check('N0', pre.length === 4 && pre.every((n) => n.reason === 'ungenerated'), 'Before export, all four segments need sound generated', pre);

  const gen = await page.evaluate(async () => {
    try {
      const { prepareExportSounds } = await import('/src/editor/io/exportSounds.ts');
      await prepareExportSounds({ signal: new AbortController().signal, onProgress: () => {} });
      const p = window.__pcStore.getState().project;
      return { ok: true, generated: p.tracks[0].clips.filter((c) => c.cardAudio).map((c) => c.id) };
    } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  });
  check('G', gen.ok && gen.generated?.length === 4, 'Generate the sound for the four segments first', gen);

  const split = await page.evaluate(async (at) => {
    const a = window.__pcStore.actions;
    const right = a.splitClip('D', at);
    const p = window.__pcStore.getState().project;
    const sound = await window.__pcIo.sound();
    const needs = await sound.listExportSoundNeeds(new AbortController().signal);
    const { persistentCardAudio } = await import('/src/audio/cardAudio.ts');
    const left = p.tracks[0].clips.find((c) => c.id === 'D'), r = right && p.tracks[0].clips.find((c) => c.id === right.id);
    let offsets = null, error = null;
    try { offsets = { left: persistentCardAudio(p, left).offset, right: persistentCardAudio(p, r).offset, sameWav: left.cardAudio?.mediaId === r.cardAudio?.mediaId }; } catch (e) { error = String(e?.message ?? e); }
    return { rightId: right?.id ?? null, rightMediaOffset: r?.mediaOffset, needs: needs.map((n) => ({ clipId: n.clipId, reason: n.reason, detail: n.detail })), offsets, error };
  }, SPLIT_AT);
  check('S', split.rightId && split.needs.length === 0 && split.offsets?.sameWav && Math.abs(split.offsets.right - split.offsets.left - (SPLIT_AT - 6)) < 1e-6,
    `After splitting D the manifest is empty, both halves share the same WAV, and the second half's offset = first half + ${SPLIT_AT - 6} seconds`, split);

  const exp = await page.evaluate(async () => {
    const progress = [];
    try {
      const out = await window.__pcIo.exportVideo({ onProgress: (d, t, stage) => progress.push([stage ?? 'render', d, t]) });
      return { ok: true, outDir: out.outDir, soundSteps: progress.filter((x) => x[0] === 'sound').length };
    } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  });
  const file = exp.outDir ? path.join(exp.outDir, 'preview.mp4') : '';
  check('E', exp.ok && fs.existsSync(file), 'Desktop export succeeded', exp);
  if (exp.ok && fs.existsSync(file)) {
    const mp4 = path.join(OUT, 'export.mp4');
    fs.copyFileSync(file, mp4);
    report.file = mp4;
    const pcm = pcmOf(mp4);
    report.segs = {};
    const windows = [
      { id: 'A', a: 0, b: 2, hz: 440, speed: 1 }, { id: 'B', a: 2, b: 4, hz: 880, speed: 2 }, { id: 'C', a: 4, b: 6, hz: 220, speed: 0.5 },
      { id: 'D1', a: 6, b: SPLIT_AT, hz: 880, speed: 2 }, { id: 'D2', a: SPLIT_AT, b: 10, hz: 880, speed: 2 },
    ];
    for (const s of windows) {
      const a = s.a + 0.3, b = s.b - 0.3;
      const db = loudness(pcm, a, b), hz = pitch(pcm, a, b), peak = peakHz(pcm, a, b);
      const ok = db > -30 && Math.abs(hz - s.hz) <= s.hz * 0.02 && Math.abs(peak - s.hz) <= s.hz * 0.02;
      report.segs[s.id] = { speed: s.speed, expectHz: s.hz, zeroCrossHz: +hz.toFixed(1), dftPeakHz: peak, dBFS: +db.toFixed(1) };
      check(s.id, ok, `Segment ${s.id} at ${s.speed}x should be ${s.hz} Hz with sound: zero-crossing ${hz.toFixed(1)} Hz, DFT peak ${peak} Hz, ${db.toFixed(1)} dBFS`);
    }
    const dx = { hz: pitch(pcm, SPLIT_AT - 0.5, SPLIT_AT + 0.5), peak: peakHz(pcm, SPLIT_AT - 0.5, SPLIT_AT + 0.5), db: loudness(pcm, SPLIT_AT - 0.5, SPLIT_AT + 0.5) };
    report.segs.DX = { zeroCrossHz: +dx.hz.toFixed(1), dftPeakHz: dx.peak, dBFS: +dx.db.toFixed(1) };
    check('DX', Math.abs(dx.hz - 880) <= 880 * 0.02 && Math.abs(dx.peak - 880) <= 880 * 0.02 && Math.abs(dx.db - report.segs.D1.dBFS) < 1,
      `Across the cut point ${SPLIT_AT - 0.5}~${SPLIT_AT + 0.5} s: zero-crossing ${dx.hz.toFixed(1)} Hz, DFT peak ${dx.peak} Hz, ${dx.db.toFixed(1)} dBFS (D1 ${report.segs.D1.dBFS})`);
    const before = redBar(mp4, SPLIT_AT * FPS - 1, path.join(OUT, `frame-${SPLIT_AT * FPS - 1}.png`)), at = redBar(mp4, SPLIT_AT * FPS, path.join(OUT, `frame-${SPLIT_AT * FPS}.png`));
    report.bar = { before, at, expect: 0.4 * W };
    check('V', Math.abs(at - before) < 4 && Math.abs(at - 0.4 * W) < 6, `Frame: red bar is ${before} px in the frame before the cut point and ${at} px in the cut-point frame (both should be about ${0.4 * W})`);
  }
  check('E0', errors.length === 0, 'Page has zero errors', errors);
} catch (error) {
  check('X', false, `Probe error: ${String(error?.stack || error)}`);
} finally {
  await browser.close();
  server.stop();
}
console.log(JSON.stringify({ ok: fails.length === 0, results, report, fails }));
process.exit(fails.length ? 1 : 0);

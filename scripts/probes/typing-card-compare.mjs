/**
 * Frame-by-frame comparison before and after changes for typing animation card (mu-typing) and
 * typewriter part (text-typing).
 *
 * Background: phase 0.5 audio rewrote `src/cards/magicui/typing-animation.card.tsx` and
 * `vendor/typing-animation.tsx` to "sample characters by t when stage passes t, based on grapheme
 * event table". The pixel baseline demo project does not have this card, and full comparison
 * cannot test it, so it is compared separately.
 *
 *   node scripts/probes/typing-card-compare.mjs --main <main worktree> [--out <dir>] [--port 5714] [--passes 2] [--reuse]
 *
 * Method: using the same project JSON (each test case below occupies a portion of the timeline),
 * run real export paths using `scripts/export-e2e.mjs` from both the "before" and "after" code trees
 * (launching dev servers, frame-by-frame screenshots, card layer only, transparent background),
 * then compare the PNG pixels frame by frame.
 *   - Before = directory given by --main (main commit 3da0aa0e, recommended to `git worktree add --detach`
 *     and delete after use)
 *   - After = code tree containing this script
 * Each side exports --passes passes; comparison uses only the last pass (the first pass includes
 * font warm-up, see docs/guides/compare-pitfalls.md); also reports the difference between its own
 * two passes as noise floor. Each side occupies 3 consecutive ports (editor + two stages): --port
 * for before, --port+3 for after.
 *
 * Acceptance criteria (exit code 0 if and only if all pass):
 *   1. "Default parameters, plain text" test cases (marked expect=same): identical frame by frame
 *      and pixel by pixel before and after, 0 diff frames.
 *      Includes: empty text, Latin, Chinese, line breaks, different ms per character (including
 *      100 ms on exact frame boundaries), typewriter part (text-typing, via composite card).
 *   2. "Expected to differ" cases (marked expect=differs) are reported only without pass/fail
 *      judgment, to be explained visually:
 *      emoji / combining characters / flags (before timed by UTF-16 code units, after timed by
 *      graphemes; this is a user-approved fix);
 *      new parameters such as pauses (before lacked these parameters, ignores them); clips trimmed
 *      in the middle (before typed from start on every mount, after continues typing).
 *      The script also infers "characters that should display before" vs "characters that should
 *      display after" frame by frame from a text model, requiring the set of frames with differing
 *      text to exactly match the set of frames with differing pixels (otherwise exit code 1);
 *      and for each such case lists the first diff frame and stitches a "before | after | diff×8"
 *      triptych (cropped only to diff areas) into <out>/sheets/.
 *   3. Both sides export successfully with matching frame counts.
 *   4. **Run each of the two project formats once** (added 2026-10-07): test cases above are in
 *      Project format (has `tracks`, export page goes through FrameScene, card mounted only at clip
 *      start).
 *      Another set of test cases is in Timeline format (flattened `clips`, no `tracks`, names start
 *      with `tl-`): export page renders Stage directly, and card is mounted CARD_MOUNT_LEAD (one
 *      frame at 30 fps) early; old typing card timed from the mount frame. Default demo project
 *      (export pixel baseline) follows this path, and testing only Project format once missed "every
 *      character one frame late". Includes: mu-4 from the demo project (6~8 seconds, empty
 *      parameters), start at 0 (no lead time), Latin, Chinese, exact frame boundaries, typewriter
 *      part; expected to differ include emoji and clips with source offset (Timeline's `sourceOffset`).
 *      `export-e2e.mjs` accepts only Project format, so this set launches its own dev server and
 *      directly runs `scripts/export-frames.mjs` on each tree.
 *
 * Comparison pitfalls: see docs/guides/compare-pitfalls.md. If program reports differences,
 * inspect images first: the script outputs images for every differing test case.
 * Does not touch anything running for the user: custom ports (default 5714, 5717), temporary export
 * directory; does not inherit PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR.
 * Output: progress to stdout; last line is JSON `{ ok, cases: [...] }`; complete results to
 * <out>/result.json.
 */
import '../lib/no-user-dirs.mjs';
import '../../src/testing/registerTs.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AFTER = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const BEFORE = path.resolve(arg('main', path.join(AFTER, '..', 'sound-verify-main')));
const OUT = path.resolve(arg('out', path.join(AFTER, '..', '..', 'work', 'four-stage', 'sound', 'typing-compare')));
const PORT = Number(arg('port', 5714));
/**
 * The baseline tree already includes typing card changes (release acceptance checks compare
 * against the previous version): every case should be identical frame by frame, and original
 * differs cases are also judged as same
 */
const NO_CHANGE = argv.includes('--no-change');
const PASSES = Number(arg('passes', 2));
const REUSE = argv.includes('--reuse');
const FPS = 30, W = 1280, H = 720;
const require = createRequire(path.join(AFTER, 'package.json'));
const { PNG } = require('pngjs');

/** Test case: name, expect (same / differs), clip card and parameters */
const CASES = [
  { name: 'empty', expect: 'same', dur: 1.5, params: { text: '' } },
  { name: 'latin-default', expect: 'same', dur: 3.6, params: { text: 'Hello, PromptCut typing!' } },
  { name: 'card-default-text', expect: 'same', dur: 2.2, params: {} },
  { name: 'chinese-default', expect: 'same', dur: 2.8, params: { text: '这是一段打字机测试文字，含标点。' } },
  { name: 'multiline-default', expect: 'same', dur: 2.6, params: { text: 'Line one\nLine two' } },
  { name: 'slow-duration-200', expect: 'same', dur: 3.0, params: { text: 'Slow typing', duration: 200 } },
  { name: 'duration-100-frame-boundaries', expect: 'same', dur: 3.0, params: { text: 'Boundary at exact frames', duration: 100 } },
  { name: 'part-text-typing-default', expect: 'same', dur: 3.2, part: { text: 'Part typing, default.', size: 0, duration: 120 } },
  { name: 'part-text-typing-chinese', expect: 'same', dur: 2.6, part: { text: '部件里的中文打字。', size: 0, duration: 120 } },
  { name: 'emoji-zwj-default', expect: 'differs', dur: 3.0, params: { text: 'Hi 👩🏽‍💻🎉 ok' } },
  { name: 'combining-and-flag', expect: 'differs', dur: 3.0, params: { text: 'école 🇯🇵 été' } },
  { name: 'part-text-typing-emoji', expect: 'differs', dur: 3.0, part: { text: 'Go 👩🏽‍💻 now', size: 0, duration: 120 } },
  { name: 'pause-params', expect: 'differs', dur: 5.0, params: { text: 'Wait, what? Yes.\nOK', duration: 100, delayMs: 300, punctuationPauseMs: 400, newlinePauseMs: 300, jitterMs: 30, seed: 7, pauses: [{ afterIndex: 3, durationMs: 500 }] } },
  { name: 'crop-from-middle', expect: 'differs', dur: 3.0, mediaOffset: 0.6, params: { text: 'Cropped from the middle of typing' } },
];

/**
 * Timeline format test case (flattened clips): if at is given, pin to that start point (mu-4 in demo
 * project must be at 6~8 seconds); otherwise append after previous one.
 * sourceOffset is the source offset on Timeline (Project's mediaOffset becomes this via flattenOverlay).
 */
const TIMELINE_CASES = [
  { name: 'tl-start-at-zero', expect: 'same', at: 0, dur: 2.2, params: {} },
  { name: 'tl-latin-default', expect: 'same', dur: 3.4, params: { text: 'Hello, PromptCut typing!' } },
  { name: 'tl-demo-mu-4', expect: 'same', id: 'mu-4', at: 6, dur: 2, params: {} },
  { name: 'tl-chinese-default', expect: 'same', dur: 2.8, params: { text: '这是一段打字机测试文字，含标点。' } },
  { name: 'tl-duration-100-frame-boundaries', expect: 'same', dur: 3.0, params: { text: 'Boundary at exact frames', duration: 100 } },
  { name: 'tl-part-text-typing-default', expect: 'same', dur: 3.2, part: { text: 'Part typing, default.', size: 0, duration: 120 } },
  { name: 'tl-emoji-zwj-default', expect: 'differs', dur: 3.0, params: { text: 'Hi 👩🏽‍💻🎉 ok' } },
  { name: 'tl-crop-from-middle', expect: 'differs', dur: 3.0, sourceOffset: 0.6, params: { text: 'Cropped from the middle of typing' } },
];

async function buildTimeline() {
  const { mountFrameOf } = await import('../../src/render/frameWindow.mjs');
  const clips = [];
  const windows = [];
  let at = 0;
  TIMELINE_CASES.forEach((c, i) => {
    const from = c.at ?? at;
    if (from < at - 1e-9) throw new Error(`Timeline case ${c.name}: start ${from} overlaps the previous case`);
    const start = Math.round(from * FPS) / FPS, end = Math.round((from + c.dur) * FPS) / FPS;
    const common = { id: c.id ?? `tl-${i}`, start, end };
    if (c.part) {
      clips.push({ ...common, cardId: 'composite', params: {}, parts: [{ id: `tp-${i}`, partId: 'text-typing', params: c.part, frame: { x: 200, y: 440, w: 1520, h: 200 } }] });
    } else {
      clips.push({ ...common, cardId: 'mu-typing', params: { ...c.params }, ...(c.sourceOffset ? { sourceOffset: c.sourceOffset } : {}) });
    }
    // On this path the card is mounted early, and the frame it mounts on is already in view: test
    // case frame range is counted from the mount frame (blank frame comparison excludes it)
    const mountFrame = mountFrameOf({ start, end }, FPS);
    windows.push({ ...c, timeline: true, clipStartFrame: Math.round(start * FPS), mountFrame, startFrame: mountFrame, endFrame: Math.round(end * FPS) });
    at = end + 0.2;
  });
  const duration = Math.ceil(at * FPS) / FPS;
  return { project: { width: W, height: H, fps: FPS, duration, clips }, windows, frames: Math.round(duration * FPS) };
}

/**
 * Timeline format: launch dev server on tree (using its own scripts/lib/dev-server.mjs), run its own
 * export-frames.mjs. Frames land in <work>/export-e2e/frames, same layout as export-e2e.
 */
async function runTimelineExport(label, tree, port, timeline, work) {
  fs.mkdirSync(work, { recursive: true });
  const { startDevServer, tripleFree, sleep } = await import(pathToFileURL(path.join(tree, 'scripts', 'lib', 'dev-server.mjs')).href);
  // The dev server from the previous pass had its entire process tree terminated; wait a moment
  // for the three consecutive ports to be released
  const portsFree = async () => { for (let i = 0; i < 60 && !(await tripleFree(port)); i++) await sleep(500); };
  await portsFree();
  const env = { PROMPTCUT_EXPORT_DIR: work };
  let server = null;
  try {
    server = await startDevServer({ env, logFile: path.join(work, 'vite.log'), port });
    const url = `${server.origin}/?export=1&timeline=${encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(timeline)))}`;
    const code = await new Promise((resolve) => {
      const log = fs.createWriteStream(path.join(work, 'export-frames.log'), { flags: 'a' });
      const child = spawn(process.execPath, [path.join(tree, 'scripts', 'export-frames.mjs'), '--url', url, '--out', path.join(work, 'export-e2e'), '--fps', String(FPS), '--workers', '1', '--no-video'],
        { cwd: tree, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      child.on('exit', (c) => { log.end(); resolve(c ?? 1); });
    });
    console.log(`[${label}] exit code ${code}`);
    return code;
  } catch (e) {
    console.log(`[${label}] failed: ${e.message}`);
    return 1;
  } finally {
    server?.stop();
    if (server) await portsFree();
  }
}

function buildProject() {
  const clips = [];
  const windows = [];
  let at = 0;
  CASES.forEach((c, i) => {
    const start = Math.round(at * FPS) / FPS, end = Math.round((at + c.dur) * FPS) / FPS;
    const common = { id: `clip-${i}`, start, end };
    if (c.part) {
      clips.push({ ...common, cardId: 'composite', params: {}, parts: [{ id: `p-${i}`, partId: 'text-typing', params: c.part, frame: { x: 200, y: 440, w: 1520, h: 200 } }] });
    } else {
      clips.push({ ...common, cardId: 'mu-typing', params: { ...c.params }, ...(c.mediaOffset ? { mediaOffset: c.mediaOffset } : {}) });
    }
    windows.push({ ...c, startFrame: Math.round(start * FPS), endFrame: Math.round(end * FPS) });
    at = end + 0.2;
  });
  const duration = Math.ceil(at * FPS) / FPS;
  return { project: { version: 1, id: 'typing-compare', name: 'typing compare', width: W, height: H, fps: FPS, duration, themeId: 'midnight', media: [], tracks: [{ id: 't-1', name: 'Track 1', clips }] }, windows, frames: Math.round(duration * FPS) };
}

function runExport(label, tree, port, projectFile, work) {
  return new Promise((resolve) => {
    fs.mkdirSync(work, { recursive: true });
    const log = fs.createWriteStream(path.join(work, 'export-e2e.log'), { flags: 'a' });
    const child = spawn(process.execPath, [path.join(tree, 'scripts', 'export-e2e.mjs'), '--project', projectFile, '--work', work, '--port', String(port), '--', '--workers', '1'],
      { cwd: tree, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('exit', (code) => { log.end(); console.log(`[${label}] exit code ${code}`); resolve(code ?? 1); });
  });
}

const framePath = (work, f) => path.join(work, 'export-e2e', 'frames', `${String(f).padStart(6, "0")}.png`);
function listFrames(work) {
  const dir = path.join(work, 'export-e2e', 'frames');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.png')).sort() : [];
}
function readPng(file) { return PNG.sync.read(fs.readFileSync(file)); }
function diffPng(a, b) {
  if (a.width !== b.width || a.height !== b.height) return { differing: -1, max: 255, box: null };
  let differing = 0, max = 0, x0 = a.width, y0 = a.height, x1 = -1, y1 = -1;
  for (let i = 0, n = a.width * a.height; i < n; i++) {
    const o = i * 4;
    let d = 0;
    for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(a.data[o + k] - b.data[o + k]));
    if (d) {
      differing++; max = Math.max(max, d);
      const x = i % a.width, y = (i / a.width) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return { differing, max, box: differing ? [x0, y0, x1, y1] : null };
}
const frameFiles = (work) => listFrames(work);
function compareDirs(wa, wb, from, to) {
  const out = { frames: 0, diffFrames: 0, first: null, maxChannel: 0, maxPixels: 0, list: [] };
  for (let f = from; f < to; f++) {
    const pa = framePath(wa, f), pb = framePath(wb, f);
    if (!fs.existsSync(pa) || !fs.existsSync(pb)) { out.frames++; out.diffFrames++; out.list.push({ frame: f, missing: true }); out.first ??= f; continue; }
    out.frames++;
    const ba = fs.readFileSync(pa), bb = fs.readFileSync(pb);
    if (ba.equals(bb)) continue;
    const d = diffPng(PNG.sync.read(ba), PNG.sync.read(bb));
    if (!d.differing) continue; // File bytes differ, pixels identical (compression difference)
    out.diffFrames++; out.first ??= f; out.maxChannel = Math.max(out.maxChannel, d.max); out.maxPixels = Math.max(out.maxPixels, d.differing);
    if (out.list.length < 400) out.list.push({ frame: f, pixels: d.differing, max: d.max, box: d.box });
  }
  return out;
}

/**
 * Triptych: before | after | diff×8, cropped only to diff bounding box (expanded by 24px), scaled
 * up to within 2x. Written as PNG.
 */
function sheet(wa, wb, f, box, file) {
  const a = readPng(framePath(wa, f)), b = readPng(framePath(wb, f));
  const pad = 24;
  const x0 = Math.max(0, box[0] - pad), y0 = Math.max(0, box[1] - pad), x1 = Math.min(a.width - 1, box[2] + pad), y1 = Math.min(a.height - 1, box[3] + pad);
  const w = x1 - x0 + 1, h = y1 - y0 + 1, gap = 8;
  const out = new PNG({ width: w * 3 + gap * 2, height: h });
  out.data.fill(60);
  const put = (src, ox, mode) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const si = ((y0 + y) * src.width + x0 + x) * 4, di = (y * out.width + ox + x) * 4;
      const bi = ((y0 + y) * b.width + x0 + x) * 4, ai = ((y0 + y) * a.width + x0 + x) * 4;
      if (mode === 'diff') {
        for (let k = 0; k < 3; k++) out.data[di + k] = Math.min(255, Math.abs(a.data[ai + k] - b.data[bi + k]) * 8);
        out.data[di + 3] = 255;
      } else {
        // Lay dark gray checkerboard under transparent background so text is visible
        const al = src.data[si + 3] / 255, bg = ((x >> 4) + (y >> 4)) & 1 ? 40 : 56;
        for (let k = 0; k < 3; k++) out.data[di + k] = Math.round(src.data[si + k] * al + bg * (1 - al));
        out.data[di + 3] = 255;
      }
    }
  };
  put(a, 0, 'img'); put(b, w + gap, 'img'); put(a, (w + gap) * 2, 'diff');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(out));
}

/**
 * Explaining differences: without relying on human eyes, infer frame by frame "what characters
 * should display before" vs "what characters should display after", checking whether "the set of
 * frames with differing text" equals exactly "the set of frames with differing pixels".
 *   Before: text.substring(0, floor(elapsedMs / msPerChar)), by UTF-16 code units, ignoring all
 *   new parameters, ignoring mediaOffset (typed from start on every mount)
 *   After: grapheme event table (typingTextAt), elapsedMs = localTime + mediaOffset
 * Both sides have been proven by pixels to match reality only in "default parameters, plain text"
 * test cases (expect=same all 0 diff); here the same model is extrapolated to differs cases.
 *
 * Timeline format (w.timeline): card mounts at w.mountFrame (earlier than clip start), both sides
 * time from the mount frame:
 *   Before: same as above, except start frame is changed to mount frame, ignoring sourceOffset;
 *   After: same elapsedMs (mount clock, without boundary tolerance) plus sourceOffset, sampling
 *   characters by grapheme event table.
 */
async function analyticTextDiff(w) {
  const { createTypingSchedule, typingTextAt, typingScheduleOptionsFromParams } = await import('../../src/kernel/typingEvents.ts');
  const p = w.part ?? w.params;
  const text = p.text ?? '这是一段打字机测试文字', duration = p.duration ?? 120;
  const schedule = createTypingSchedule(w.part ? { text, duration } : typingScheduleOptionsFromParams({ text, ...p }));
  const frames = [];
  for (let f = w.startFrame; f < w.endFrame; f++) {
    if (w.timeline) {
      const elapsed = (f / FPS) * 1000 - (w.mountFrame / FPS) * 1000;
      const before = duration === 0 ? text : text.substring(0, Math.floor(elapsed / duration));
      const after = w.mountFrame < w.clipStartFrame
        ? typingTextAt(schedule, elapsed + (w.sourceOffset ?? 0) * 1000, 0)
        : typingTextAt(schedule, (Math.max(0, f - w.clipStartFrame) / FPS + (w.sourceOffset ?? 0)) * 1000);
      const visible = (x) => x.replace(/\s+/g, ' ').trimEnd();
      if (visible(before) !== visible(after)) frames.push(f);
      continue;
    }
    const local = ((f - w.startFrame) / FPS) * 1000;
    // The old implementation reads the pinned page clock (frame ms, float), elapsed = current frame
    // ms - mount frame ms, carrying its own float error on exact frame boundaries; subtract the same
    // way here
    const oldElapsed = (f * 1000) / FPS - (w.startFrame * 1000) / FPS;
    const oldText = duration === 0 ? text : text.substring(0, Math.floor(oldElapsed / duration));
    const newText = typingTextAt(schedule, local + (w.mediaOffset ?? 0) * 1000);
    // Typesetting collapses whitespace and trailing whitespace takes no space, so compare "visually
    // perceptible text" after collapsing whitespace and stripping trailing whitespace
    const seen = (x) => x.replace(/s+/g, ' ').trimEnd();
    if (seen(oldText) !== seen(newText)) frames.push(f);
  }
  return frames;
}

async function main() {
  if (!fs.existsSync(path.join(BEFORE, 'scripts', 'export-e2e.mjs'))) throw new Error(`--main is not a code tree: ${BEFORE}`);
  fs.mkdirSync(OUT, { recursive: true });
  const suites = [];
  {
    const built = buildProject();
    const projectFile = path.join(OUT, 'project.json');
    fs.writeFileSync(projectFile, JSON.stringify(built.project));
    suites.push({ label: 'Project format', prefix: '', ...built, run: (tag, tree, port, work) => runExport(tag, tree, port, projectFile, work) });
  }
  {
    const built = await buildTimeline();
    fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify(built.project));
    suites.push({ label: 'Timeline format', prefix: 'tl-', ...built, run: (tag, tree, port, work) => runTimelineExport(tag, tree, port, built.project, work) });
  }
  const summary = { ok: true, suites: [], cases: [] };
  for (const suite of suites) {
    const r = await compareSuite(suite);
    summary.suites.push({ label: suite.label, ...r });
    summary.cases.push(...r.cases);
    if (!r.ok) summary.ok = false;
  }
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ok: summary.ok, cases: summary.cases.map((c) => ({ name: c.name, expect: c.expect, frames: c.frames, diffFrames: c.diffFrames })) }));
  return summary.ok ? 0 : 1;
}

async function compareSuite({ label, prefix, windows, frames, run }) {
  console.log(`-- ${label}: ${frames} frames, ${windows.length} cases; before ${BEFORE}; after ${AFTER}`);
  const works = { before: [], after: [] };
  for (let p = 1; p <= PASSES; p++) {
    for (const side of ['before', 'after']) works[side].push(path.join(OUT, `${prefix}${side}-pass${p}`));
  }
  if (!REUSE) {
    for (let p = 0; p < PASSES; p++) {
      for (const w of [works.before[p], works.after[p]]) fs.rmSync(w, { recursive: true, force: true });
      const codes = await Promise.all([
        run(`${prefix}before#${p + 1}`, BEFORE, PORT, works.before[p]),
        run(`${prefix}after#${p + 1}`, AFTER, PORT + 3, works.after[p]),
      ]);
      if (codes.some((c) => c !== 0)) throw new Error(`${label} export run ${p + 1} failed: exit code ${codes.join('/')}`);
    }
  }
  const last = PASSES - 1;
  const nb = frameFiles(works.before[last]).length, na = frameFiles(works.after[last]).length;
  console.log(`Frame count: before ${nb}, after ${na} (should be ${frames})`);
  const result = { frames, frameCountBefore: nb, frameCountAfter: na, noise: {}, cases: [] };
  if (PASSES > 1) {
    result.noise.beforeSelf = compareDirs(works.before[0], works.before[last], 0, frames).diffFrames;
    result.noise.afterSelf = compareDirs(works.after[0], works.after[last], 0, frames).diffFrames;
    console.log(`Two runs compared with themselves: before differs by ${result.noise.beforeSelf} frames, after differs by ${result.noise.afterSelf} frames (including the cold-start run)`);
  }
  // Blank segments (0.2 s between cases and end of video) also count: both sides should be empty frames
  const gaps = [];
  let prev = 0;
  for (const w of windows) { if (w.startFrame > prev) gaps.push([prev, w.startFrame]); prev = w.endFrame; }
  if (prev < frames) gaps.push([prev, frames]);
  let ok = nb === frames && na === frames;
  for (const raw of windows) {
    const w = NO_CHANGE ? { ...raw, expect: 'same' } : raw;
    const c = compareDirs(works.before[last], works.after[last], w.startFrame, w.endFrame);
    const row = { name: w.name, expect: w.expect, startFrame: w.startFrame, endFrame: w.endFrame, frames: c.frames, diffFrames: c.diffFrames, firstDiffFrame: c.first, maxChannelDiff: c.maxChannel, maxDiffPixels: c.maxPixels };
    if (w.expect === 'same' && c.diffFrames !== 0) ok = false;
    if (c.diffFrames && c.list.length) {
      const pick = c.list.find((x) => x.box) ?? null;
      if (pick) {
        const file = path.join(OUT, 'sheets', `${w.name}-frame${pick.frame}.png`);
        sheet(works.before[last], works.after[last], pick.frame, pick.box, file);
        row.sheet = file;
        // Output image for the frame with the largest difference as well
        const big = c.list.filter((x) => x.box).sort((a, b) => b.pixels - a.pixels)[0];
        if (big && big.frame !== pick.frame) { const f2 = path.join(OUT, 'sheets', `${w.name}-frame${big.frame}-max.png`); sheet(works.before[last], works.after[last], big.frame, big.box, f2); row.sheetMax = f2; }
      }
      row.diffFramesList = c.list.map((x) => x.frame);
    }
    if (w.expect === 'differs') {
      const expectedFrames = await analyticTextDiff(w);
      const pixel = new Set(row.diffFramesList ?? []);
      row.analyticTextDiffFrames = expectedFrames.length;
      row.analyticMatchesPixels = expectedFrames.length === pixel.size && expectedFrames.every((x) => pixel.has(x));
      if (!row.analyticMatchesPixels) ok = false;
    }
    result.cases.push(row);
    console.log(`${w.expect === 'same' ? (c.diffFrames ? 'FAIL' : 'PASS') : 'INFO'} ${w.name} [${w.expect}] frames ${w.startFrame}-${w.endFrame - 1}: ${c.frames} frames, ${c.diffFrames} frames differ${c.first !== null ? `, first differing frame ${c.first}, max channel difference ${c.maxChannel}` : ''}${row.analyticMatchesPixels !== undefined ? `; ${row.analyticTextDiffFrames} differing frames inferred from the text model, ${row.analyticMatchesPixels ? 'exactly matches the set of pixel-differing frames' : 'does not match the set of pixel-differing frames'}` : ''}`);
  }
  const gap = gaps.map(([a, b]) => compareDirs(works.before[last], works.after[last], a, b));
  result.gapDiffFrames = gap.reduce((s, g) => s + g.diffFrames, 0);
  console.log(`${result.gapDiffFrames ? 'FAIL' : 'PASS'} gap frames between cases: ${gaps.reduce((s, [a, b]) => s + b - a, 0)} frames, ${result.gapDiffFrames} frames differ`);
  if (result.gapDiffFrames) ok = false;
  result.ok = ok;
  return result;
}
main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });

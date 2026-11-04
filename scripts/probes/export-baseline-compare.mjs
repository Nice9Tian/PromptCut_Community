/*
 * Full-length export byte-for-byte identical: baseline reconciliation probe
 * (acceptance check tool for C1 "Unified Mount Formulas" / H7)
 *
 * Does two things:
 *   1. run     : runs one pass of **full-length** PNG export in the specified repository tree
 *                (no video), outputting to <out>/frames/%06d.png;
 *   2. compare : compares two frames directories frame-by-frame via sha256, reports the first
 *                difference, and counts pixel differences on differing frames.
 *
 * Why run requires --tree: the baseline must run **HEAD tree's own** scripts/export-frames.mjs
 * (engine in server/bakery/)(engine in server/bakery/) (which is what this refactor modifies);
 * rendering the baseline with the working tree's script wouldn't be apples-to-apples.
 * So run is only responsible for `node scripts/export-frames.mjs …`; whichever tree cwd points to,
 * that tree's code is used.
 * cwd also determines the asset directory: mediaRootDir() in server/bakery/media.mjs = <cwd>/out/media
 * (when PROMPTCUT_EXPORT_DIR is unset); both sides must have that file at /@media/<filename>.
 *
 * ───────────── Commands actually run in this round (copy verbatim to reproduce) ─────────────
 *
 * Prerequisites:
 *   # 1) HEAD working tree (leaves main tree git state untouched)
 *   git worktree add <scratch>/pc-head 0ba58cb
 *   cmd /c mklink /J <scratch>\pc-head\node_modules C:\Users\admin\Documents\PromptCut\node_modules
 *   # 2) Assets (ffmpeg testsrc2): place one copy in each tree's out/media, fetched by filename
 *   ffmpeg -f lavfi -i "testsrc2=s=320x180:r=30:d=8" -c:v libx264 -pix_fmt yuv420p -g 30 -y pc-baseline-fixture.mp4
 *   cp pc-baseline-fixture.mp4 <main-tree>/out/media/ ; cp pc-baseline-fixture.mp4 <scratch>/pc-head/out/media/
 *   # 3) Two dev servers (avoid user's 5190 / 5197; point TEMP to scratch, avoid overwriting global port.json)
 *   cd <scratch>/pc-head && TEMP=<scratch>/tmp-head TMP=<scratch>/tmp-head npx vite --port 5215 --strictPort --host 127.0.0.1
 *   cd <main-tree>       && TEMP=<scratch>/tmp-work TMP=<scratch>/tmp-work npx vite --port 5216 --strictPort --host 127.0.0.1
 *   curl -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5215/@media/pc-baseline-fixture.mp4   # both sides must return 200
 *
 * Baseline (HEAD tree script + 5215):
 *   node scripts/probes/export-baseline-compare.mjs run \
 *     --tree <scratch>/pc-head --origin http://127.0.0.1:5215 \
 *     --project <scratch>/export-fixture/project.json --out <scratch>/export-fixture/baseline
 *
 * Candidate (working tree script + 5216):
 *   node scripts/probes/export-baseline-compare.mjs run \
 *     --origin http://127.0.0.1:5216 \
 *     --project <scratch>/export-fixture/project.json --out <scratch>/export-fixture/candidate
 *
 * Compare (exit code 1 if different):
 *   node scripts/probes/export-baseline-compare.mjs \
 *     --baseline <scratch>/export-fixture/baseline/frames \
 *     --candidate <scratch>/export-fixture/candidate/frames
 *
 * Comparing immediately after run in a single command is also supported: provide --baseline to run as well.
 *
 * ───────────── Reconciliation criteria (docs/guides/compare-pitfalls.md) ─────────────
 * - Acceptance criteria is **byte-for-byte** (sha256): identical PNG bytes ⟹ identical pixels.
 *   Pixel differences are recalculated only on differing frames to distinguish between "last-digit
 *   anti-aliasing differing by a few pixels" and "genuinely drawn wrong": both count as failure,
 *   but the conclusions differ.
 * - Both sides must have identical fps, shard count, and animation path. Use --workers 1 across the
 *   board here: the sharding plan (shardPlan) itself is also within the refactor scope, and differing
 *   shard counts would introduce differences from "remounting at shard boundaries".
 * - --no-video: acceptance checks compare frames, not encoded outputs; ffmpeg / prores are not part
 *   of reconciliation.
 * - Chrome flags (--disable-gpu, --font-render-hinting=none, software rasterization, etc.) are all
 *   in CHROME_ARGS in server/bakery/chrome.mjs; each tree uses its own copy: this is one of the
 *   things being compared, so do not override them here.
 */
import '../lib/no-user-dirs.mjs'; // First import: does not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR; outputs do not land in the user's Videos\PromptCut
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

function parseArgs(argv) {
  const opts = { mode: null, tree: REPO_ROOT, fps: 30, workers: '1', frames: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'run' || a === 'compare') opts.mode = a;
    else if (a === '--tree') opts.tree = path.resolve(argv[++i]);
    else if (a === '--origin') opts.origin = argv[++i];
    else if (a === '--project') opts.project = path.resolve(argv[++i]);
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a === '--baseline') opts.baseline = path.resolve(argv[++i]);
    else if (a === '--candidate') opts.candidate = path.resolve(argv[++i]);
    else if (a === '--fps') opts.fps = Number(argv[++i]);
    else if (a === '--workers') opts.workers = argv[++i];
    else if (a === '--frames') opts.frames = argv[++i];
    else if (a === '--max-diff-frames') opts.maxDiffFrames = Number(argv[++i]);
    else if (a === '--help' || a === '-h') opts.help = true;
    else rest.push(a);
  }
  if (rest.length) throw new Error('Unrecognized arguments:' + rest.join(' '));
  if (!opts.mode) opts.mode = opts.origin ? 'run' : 'compare';
  return opts;
}

/** Export page URL: project is passed in via data: URL, same pattern as scripts/verify-*.mjs */
export function exportUrlOf(origin, project) {
  const timeline = 'data:application/json,' + encodeURIComponent(JSON.stringify(project));
  return `${origin.replace(/\/$/, '')}/?export=1&timeline=${encodeURIComponent(timeline)}`;
}

/** Run one pass of full-length PNG export. Whichever tree cwd points to, use that tree's scripts/export-frames.mjs and out/media */
export async function runExport({ tree, origin, project, out, fps, workers, frames }) {
  const proj = JSON.parse(await fsp.readFile(project, 'utf8'));
  const url = exportUrlOf(origin, proj);
  const args = ['scripts/export-frames.mjs', '--url', url, '--out', out,
    '--fps', String(fps || proj.fps || 30), '--workers', String(workers ?? 1), '--no-video'];
  if (frames) args.push('--frames', frames);
  await fsp.rm(path.join(out, 'frames'), { recursive: true, force: true });
  await fsp.mkdir(out, { recursive: true });
  console.log(`[run] cwd=${tree}`);
  console.log(`[run] node ${args[0]} --url "<${origin}/?export=1&timeline=data:…(${url.length} characters)>" ${args.slice(3).join(' ')}`);
  const t0 = process.hrtime.bigint();
  const code = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { cwd: tree, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    p.on('error', reject);
    p.on('close', resolve);
  });
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  const dir = path.join(out, 'frames');
  const n = fs.existsSync(dir) ? (await fsp.readdir(dir)).filter((f) => f.endsWith('.png')).length : 0;
  console.log(`[run] exit code ${code}, ${n} frames, ${secs.toFixed(1)} s → ${dir}`);
  if (code !== 0) throw new Error(`export-frames exit code ${code}`);
  return { framesDir: dir, count: n, seconds: secs };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Accepts either <out> or <out>/frames */
function framesDirOf(dir) {
  if (!fs.existsSync(dir)) throw new Error('Directory does not exist:' + dir);
  const hasPng = fs.readdirSync(dir).some((f) => /\.(png|jpe?g|webp)$/i.test(f));
  if (!hasPng && fs.existsSync(path.join(dir, 'frames'))) return path.join(dir, 'frames');
  return dir;
}

async function listFrames(dir) {
  const names = (await fsp.readdir(dir)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort();
  if (!names.length) throw new Error('No frames in the directory:' + dir);
  return names;
}

/** Pixel difference between two PNGs. Returns differing pixel count, max channel difference, and first differing coordinates */
async function pixelDiff(fileA, fileB) {
  const { PNG } = await import('pngjs');
  let a, b;
  try { a = PNG.sync.read(await fsp.readFile(fileA)); b = PNG.sync.read(await fsp.readFile(fileB)); }
  catch (e) { return { error: 'Cannot read PNG:' + e.message }; }
  if (a.width !== b.width || a.height !== b.height) {
    return { error: `Different sizes ${a.width}x${a.height} vs ${b.width}x${b.height}` };
  }
  let diffPixels = 0, maxChannel = 0, first = null;
  for (let i = 0; i < a.data.length; i += 4) {
    let d = 0;
    for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(a.data[i + k] - b.data[i + k]));
    if (d) {
      diffPixels++;
      if (d > maxChannel) maxChannel = d;
      if (!first) { const p = i >> 2; first = { x: p % a.width, y: Math.floor(p / a.width) }; }
    }
  }
  return { width: a.width, height: a.height, total: a.width * a.height, diffPixels, maxChannel, first };
}

export async function compare(baselineDir, candidateDir, { maxDiffFrames = 5 } = {}) {
  baselineDir = framesDirOf(baselineDir);
  candidateDir = framesDirOf(candidateDir);
  const A = await listFrames(baselineDir);
  const B = await listFrames(candidateDir);
  console.log(`Baseline  ${baselineDir}  ${A.length} frames`);
  console.log(`Candidate ${candidateDir}  ${B.length} frames`);
  const onlyA = A.filter((f) => !B.includes(f));
  const onlyB = B.filter((f) => !A.includes(f));
  if (onlyA.length) console.log(`Frames only in the baseline (${onlyA.length}): ${onlyA.slice(0, 10).join(', ')}`);
  if (onlyB.length) console.log(`Frames only in the candidate (${onlyB.length}): ${onlyB.slice(0, 10).join(', ')}`);
  const shared = A.filter((f) => B.includes(f));
  const diffs = [];
  let identical = 0;
  for (const name of shared) {
    const fa = path.join(baselineDir, name), fb = path.join(candidateDir, name);
    const [ba, bb] = await Promise.all([fsp.readFile(fa), fsp.readFile(fb)]);
    if (ba.length === bb.length && ba.equals(bb)) { identical++; continue; }
    diffs.push({ name, shaA: sha256(ba), shaB: sha256(bb), bytesA: ba.length, bytesB: bb.length });
  }
  console.log(`\nByte by byte: identical ${identical}/${shared.length}${diffs.length ? `, different ${diffs.length}` : ''}`);
  if (diffs.length) {
    console.log(`First difference: ${diffs[0].name}`);
    for (const d of diffs.slice(0, maxDiffFrames)) {
      const px = await pixelDiff(path.join(baselineDir, d.name), path.join(candidateDir, d.name));
      const head = `  ${d.name}  ${d.bytesA}B/${d.bytesB}B  sha ${d.shaA.slice(0, 12)}…/${d.shaB.slice(0, 12)}…`;
      if (px.error) console.log(head + '  Pixel difference:' + px.error);
      else console.log(head + `  Pixel difference ${px.diffPixels}/${px.total}` +
        ` (${(px.diffPixels / px.total * 100).toFixed(4)}%) max channel difference ${px.maxChannel}` +
        (px.first ? ` first at (${px.first.x},${px.first.y})` : ''));
    }
    if (diffs.length > maxDiffFrames) console.log(`  …and ${diffs.length - maxDiffFrames} more frames differ: ${diffs.slice(maxDiffFrames, maxDiffFrames + 20).map((d) => d.name).join(', ')}`);
  }
  const ok = diffs.length === 0 && !onlyA.length && !onlyB.length && A.length === B.length;
  console.log(ok ? '\n✅ Full-length export is byte-identical' : '\n❌ Failed');
  return { ok, total: shared.length, identical, diffs };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(fs.readFileSync(import.meta.filename, 'utf8').split('*/')[0]);
    process.exit(0);
  }
  try {
    let candidateDir = opts.candidate;
    if (opts.mode === 'run') {
      if (!opts.origin || !opts.project || !opts.out) throw new Error('run requires --origin --project --out');
      const r = await runExport(opts);
      candidateDir = r.framesDir;
    }
    if (opts.baseline) {
      if (!candidateDir) throw new Error('compare requires --candidate (or run first)');
      const r = await compare(opts.baseline, candidateDir, { maxDiffFrames: opts.maxDiffFrames });
      process.exit(r.ok ? 0 : 1);
    }
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}

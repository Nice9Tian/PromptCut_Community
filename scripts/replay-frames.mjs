/**
 * Re-capture frames from HTML sample cache: arbitrary order, arbitrary subset.
 *
 * # What it does
 *
 * In the export pass, `scripts/export-frames.mjs --dom-cache` generates an HTML snapshot of the
 * stage after capturing each frame (all computed styles inlined, animations turned off, ids renamed,
 * canvases replaced with images of the same dimensions), and saves it to `<out>/dom/%06d.html.gz`.
 * This script takes these snapshots to re-capture:
 *
 *   - **No need to advance sequentially from frame 0**: the state of each frame is right in the
 *     snapshot, capture whichever frame you want;
 *   - **No need for page clock, settle, or pinned animations**: there are no running clocks in the
 *     snapshot (tested: waiting 500ms after injection before capturing showed 0/60 frame changes);
 *   - So it can be out of order, capture only a subset, or launch multiple processes to each
 *     capture a section.
 *
 * Used when "content has not changed, just need to re-capture": changing output format, changing
 * composite layers, progressive rollout for preview, or distributing across multiple processes
 * in parallel.
 *
 * # What you must know
 *
 * **Replay captures and live captures are not byte-for-byte identical**: during replay, the
 * browser re-layouts according to inlined computed styles, leaving subtle residuals on edges
 * (tested: rank-bars had 35/60 identical frames, max channel difference 71; mu-number-ticker
 * had 60/60 identical frames). Replay-to-replay is deterministic (out-of-order vs reverse: 0/60
 * differences). Therefore **only take one path for the same delivery**, never mix frames captured
 * live with frames replayed: the seams will jitter.
 *
 * # Usage
 *
 *   node scripts/replay-frames.mjs --cache out/x/dom --out out/x-replay [--frames 0-99 | --frames 5,9,12] [--shuffle] [--url <export page>]
 *
 * Uses the same renderer and startup parameters (openBakery) as export; fonts and stylesheets both
 * come from the export page.
 */
import './lib/no-user-dirs.mjs'; // First import: does not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR; outputs do not land in the user's Videos\PromptCut
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { captureSnapshot } from '../server/bakery/capture-snapshot.mjs';
import { openBakery } from '../server/bakery/index.mjs';

/** Parse --frames: "a-b" or "a,b,c"; if omitted, defaults to all frames in the cache */
function pickFrames(spec, available) {
  if (!spec) return available;
  const have = new Set(available);
  if (/^\d+-\d+$/.test(spec)) {
    const [a, b] = spec.split('-').map(Number);
    return available.filter((n) => n >= a && n <= b);
  }
  return spec.split(',').map(Number).filter((n) => Number.isFinite(n) && have.has(n));
}

/**
 * Re-capture a batch of frames. Returns { frames, elapsed }.
 * `bakery` can be passed in by the caller for reuse (used in resident processes); if omitted,
 * opens one on its own and closes it after use.
 */
export async function replayFrames(opts) {
  const cacheDir = opts.cache;
  const manifest = JSON.parse(fs.readFileSync(path.join(cacheDir, 'manifest.json'), 'utf8'));
  const available = fs.readdirSync(cacheDir).filter((f) => /^\d{6}\.html\.gz$/.test(f)).map((f) => Number(f.slice(0, 6))).sort((a, b) => a - b);
  let frames = pickFrames(opts.frames, available);
  if (opts.shuffle) frames = [...frames].sort(() => Math.random() - 0.5);
  const outDir = path.join(opts.out || 'out/replay', 'frames');
  fs.mkdirSync(outDir, { recursive: true });

  const bakery = opts.bakery || await openBakery({ url: opts.url || manifest.exportUrl });
  const { page, client, beginFrame } = bakery;
  const t0 = Date.now();
  try {
    await page.setViewport({ width: manifest.width, height: manifest.height, deviceScaleFactor: 1 });
    await client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    const writes = [];
    for (const n of frames) {
      const html = zlib.gunzipSync(fs.readFileSync(path.join(cacheDir, `${String(n).padStart(6, '0')}.html.gz`))).toString('utf8');
      const buf = await captureSnapshot(bakery, html);
      writes.push(fs.promises.writeFile(path.join(outDir, String(n).padStart(6, '0') + '.png'), buf));
    }
    await Promise.all(writes);
  } finally {
    if (!opts.bakery) await bakery.close();
  }
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`Replayed ${frames.length} frames in ${elapsed.toFixed(1)}s (${(elapsed * 1000 / Math.max(1, frames.length)).toFixed(1)} ms/frame).`);
  return { frames, elapsed };
}

const isMain = import.meta.url.startsWith('file:') && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cache') opts.cache = args[++i];
    else if (args[i] === '--out') opts.out = args[++i];
    else if (args[i] === '--frames') opts.frames = args[++i];
    else if (args[i] === '--url') opts.url = args[++i];
    else if (args[i] === '--shuffle') opts.shuffle = true;
  }
  if (!opts.cache) { console.error('Usage: node scripts/replay-frames.mjs --cache <out>/dom --out <dir> [--frames a-b] [--shuffle]'); process.exit(2); }
  replayFrames(opts).catch((e) => { console.error(e); process.exit(1); });
}

/**
 * Sharding and concurrency: how many segments to split a timeline into, how many processes to
 * spawn, and how each segment is merged back.
 *
 * Split from scripts/export-frames.mjs (pure refactoring, copied verbatim).
 */

import path from 'path';
import fs from 'fs/promises';
import { planShardRanges } from '../../src/render/shardPlan.mjs';
import { openBakery } from './chrome.mjs';
import { bakeFrames } from './bake.mjs';

/*
 * Multi-process sharding (docs/archive/topics/render-rebuild-plan.md Stage 5).
 *
 * Every shard **starts advancing from frame 0**, capturing only its own segment: animation anchor
 * points, cards integrating over delta, and seeded random streams all depend on "which frames were
 * advanced earlier"; skipping ahead causes mismatches. Therefore, shard outputs are byte-for-byte
 * identical to single-process output, at the cost of each shard having to pay for "advancing to
 * the beginning of its own segment": in benchmark tests, advancing one frame takes ~20 ms and
 * capturing one frame takes ~24.5 ms (demo + particles + scene-3d). The final shard must advance
 * through the entire timeline regardless, so the theoretical upper bound is ~(20+24.5)/20 ≈ 2.2×.
 *
 * **In benchmarks, it falls far short of this upper bound** (demo total length 1800 frames +
 * particles + scene-3d, 28-thread machine):
 *   1 worker 54.8s / 4 workers 44.8s / 8 workers 62.4s (slower than single process); the three
 *   outputs are pairwise 1800/1800 byte-for-byte identical.
 * Running multiple software-rasterized Chrome instances simultaneously causes them to compete for
 * CPU, while the cost of "advancing to the beginning of its segment" cannot be saved. Export
 * defaults to auto sharding; explicit --workers 1 can fall back to single process; 'auto' spawns
 * up to 4. To truly speed up significantly requires a different approach: skip earlier
 * advancement by clip boundaries (affects the global random number stream, see pinEntropy.ts), or
 * re-capture out of order using an HTML sample cache (scripts/replay-frames.mjs).
 *
 * To have all shards finish at the same time, segment lengths are not divided equally: earlier
 * shards advance fewer frames, so they capture more frames. Binary search for a shared cost ceiling
 * using "shard cost = (segment end + 1) × advance + segment length × capture", then slice from
 * front to back.
 */
const PUSH_MS = 20;
const SHOOT_MS = 24.5;

/** Splits [start, end] into n segments so the cost of "advance to segment end + capture this segment" is as equal as possible */
export function balancedShards(start, end, n) {
  const cost = (a, b) => (b + 1) * PUSH_MS + (b - a + 1) * SHOOT_MS;
  const fits = (limit) => {
    const out = [];
    let a = start;
    while (a <= end) {
      if (out.length === n) return null;
      let b = a;
      if (cost(a, b) > limit) return null;
      while (b < end && cost(a, b + 1) <= limit) b++;
      out.push([a, b]);
      a = b + 1;
    }
    return out;
  };
  let lo = cost(end, end), hi = cost(start, end);
  let best = fits(hi);
  for (let k = 0; k < 40 && hi - lo > 1; k++) {
    const mid = (lo + hi) / 2;
    const r = fits(mid);
    if (r) { best = r; hi = mid; } else lo = mid;
  }
  return best;
}

/**
 * How many shards to spawn. 'auto': each Chrome takes ~1.9 cores and ~750 MB (measured), clamped by
 * core count and free memory together, up to 8 (in the old pipeline 8 was measured as the inflection
 * point; 12 was actually slower).
 */
export async function resolveWorkers(w) {
  if (w === undefined || w === null || w === '' || w === 1 || w === '1') return 1;
  if (w !== 'auto') return Math.max(1, Math.min(16, Math.floor(Number(w)) || 1));
  const os = await import('node:os');
  const byCpu = Math.floor(os.cpus().length / 3);
  const byMem = Math.floor((os.freemem() / 1e9 - 1) / 0.8);
  return Math.max(1, Math.min(4, byCpu, byMem));
}

async function bakeSharded(opts, n) {
  const first = await openBakery(opts);
  const bakeries = [first];
  try {
    const timeline = await first.page.evaluate(() => window.__pcTimeline);
    if (!timeline) throw new Error('Timeline not found');
    const fps = opts.fps || timeline.fps || 30;
    let start = 0;
    let end = Math.floor((timeline.duration || 20) * fps) - 1;
    if (opts.frames) [start, end] = opts.frames.split('-').map(Number);
    // Same cut policy as the unified export; flattened clips without a reported
    // mode are treated as stateful.
    const clips = await first.page.evaluate(() => window.__pcClipFrameModes?.() ?? null);
    const shards = planShardRanges(clips ?? (timeline.clips || []), start, end, fps, n);
    console.log(`Shard export: ${shards.length} processes, segments ${shards.map(([a, b]) => `${a}-${b}`).join(' ')}`);
    while (bakeries.length < shards.length) bakeries.push(await openBakery(opts));
    const t0 = Date.now();
    // Frame-advancing catch-up rendering (`bake.mjs` header): skipped from second shard onward, for the
    // same reason as `export-unified.mjs` (cards advanced before split point are unmounted by then)
    const results = await Promise.all(shards.map(([a, b], k) => bakeFrames(bakeries[k], { ...opts, frames: `${a}-${b}`,
      ...(k > 0 && typeof opts.pushDraw !== 'boolean' ? { pushDraw: false } : {}) })));
    const r0 = results[0];
    const totalFrames = end - start + 1;
    const merged = {
      ...r0,
      startFrame: start, endFrame: end, totalFrames,
      durationSec: (totalFrames / r0.fps).toFixed(3),
      reused: results.reduce((s, r) => s + (r.reused || 0), 0),
      elapsed: ((Date.now() - t0) / 1000).toFixed(1),
      glass: {
        dir: r0.glass?.dir ?? null,
        list: results.flatMap((r) => r.glass?.list || []),
        blurs: [...new Set(results.flatMap((r) => r.glass?.blurs || []))],
      },
    };
    // Each shard wrote a manifest covering only its own segment; merge into one covering the full range
    if (r0.domDir) {
      const mf = path.join(r0.domDir, 'manifest.json');
      const m = JSON.parse(await fs.readFile(mf, 'utf8'));
      await fs.writeFile(mf, JSON.stringify({ ...m, startFrame: start, endFrame: end }, null, 1));
    }
    console.log(`Shard export finished: ${totalFrames} frames, ${merged.elapsed}s.`);
    return merged;
  } finally {
    await Promise.all(bakeries.map((b) => b.close().catch(() => {})));
  }
}

export { bakeSharded };

#!/usr/bin/env node
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
/**
 * Frame-by-frame evidence in multi-project mode that "both modes produce identical video"
 * (semantics `product/rendering.md` "Two modes of render service": same frame at the same time).
 *
 *   node scripts/probes/multi-project-expand-probe.mjs --url http://127.0.0.1:5880 [--out <dir>] [--keep]
 *
 * Requires a running dev server (`--url`, defaults to `PC_FRAME_TEST_URL` or dev-test in
 * `.claude/launch.json`).
 *
 * Method: same test project, same set of requests (each request asks for several frames), render
 * each request twice:
 *   - **Single-project mode**: pass entire project to export page (`exportUnified`, the same
 *     export frame extraction path taken when desktop app prerender process loads the whole project);
 *   - **Multi-project mode**: expand first according to the frames requested by this request
 *     (`expandProject` in `server/render-node/expand.mjs`), and pass only the expanded project
 *     to export page;
 * Compare every frame output from both runs pixel by pixel (RGBA four channels byte by byte),
 * recording the count of identical frames and different pixels. Also record the number of clips,
 * cards, and assets before and after expansion, showing that multi-project mode indeed loads only
 * the ones used.
 *
 * Second pass (skipped with `--no-pipeline`) takes the frame viewing path: `FramePipeline#see_frames`
 * used by worker process when receiving see-frames requests (which is `renderFrames` in
 * `server/vision/render.ts`), similarly once for entire project and once after expansion, compared
 * pixel by pixel.
 *
 * Test project covers: frame-push cards (playback from mount frame), below-dependent cards
 * (frosted-glass type, lower layer is video and image), canvas cards, remotion-style cards, video
 * assets (with filters) and crossfade, image assets, cut segments (referencing a parked cut,
 * segment starts from second 1 of referenced cut), hidden tracks, requested frames falling on card
 * mount boundaries.
 *
 * Passing criteria: every frame of each request is pixel-by-pixel identical across both runs
 * (0 different pixels). Last line of stdout is JSON summary; exit code 0 passes, 1 fails, 2 fails to start.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expandProject } from '../../server/render-node/expand.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { renderProject } from '../../server/render-project.mjs';
import { devOrigin } from './probe-connect.mjs';
import { FPS, makeMedia, testProject, renderFrames as renderAt, comparePng, mediaDirOf } from './multi-project-fixture.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const origin = arg('--url', process.env.PC_FRAME_TEST_URL || devOrigin());
const stamp = Date.now();
const root = path.resolve(arg('--out', path.join('out', `multi-project-expand-${stamp}`)));
const mediaDir = mediaDirOf();
const renderFrames = (project, frames, dir) => renderAt(origin, project, frames, dir);

/** Frames requested by a request (project frame numbers). Picked at mount boundaries, transition overlaps, inside cut segments, last frame, etc. */
const REQUESTS = [
  { name: 'odometer replayed to 0.5s', frames: [15] },
  { name: 'frosted-glass card just mounted (the frame before 1.0s and the frame at 1.0s) + frame-push card', frames: [29, 30, 45] },
  { name: 'crossfade overlap segment 3.3s-3.8s', frames: [100, 114] },
  { name: 'canvas card and frosted-glass card on screen together at 4.6s', frames: [138] },
  { name: 'remotion card + image + cut segment (at 1.5s within the segment) 7.5s', frames: [225] },
  { name: 'two cards overlapping in a cut segment (at 3.5s within the segment) + frame-push card mount boundary 8.2s', frames: [246, 255] },
  { name: 'end 11.5s to the last frame', frames: [345, 359] },
];

async function main() {
  await fs.mkdir(root, { recursive: true });
  const media = await makeMedia(stamp, mediaDir);
  const project = testProject(media);
  const allClips = project.tracks.reduce((n, t) => n + t.clips.length, 0) + project.cuts.reduce((n, c) => n + (c.tracks ?? []).reduce((m, t) => m + t.clips.length, 0), 0);
  const results = [];
  let identical = 0, frames = 0, diffPixels = 0;
  const tally = (perFrame, a, b, f, extra = {}) => {
    const c = comparePng(a, b);
    frames += 1;
    if (c.size && c.pixels === 0) identical += 1;
    diffPixels += c.pixels;
    perFrame.push({ frame: f, diffPixels: c.pixels, totalPixels: c.total, opaquePixels: c.opaque ?? null, ...extra });
  };
  const line = (perFrame) => perFrame.map((p) => `frame ${p.frame} differing pixels ${p.diffPixels}/${p.totalPixels} (opaque ${p.opaquePixels})`).join(';');
  try {
    // First pass: export frame extraction (exportUnified)
    for (const [i, req] of REQUESTS.entries()) {
      const exp = expandProject(project, { frames: req.frames });
      const dir = path.join(root, `r${i + 1}`);
      const full = await renderFrames(project, req.frames, path.join(dir, 'single'));
      const multi = await renderFrames(exp.project, req.frames, path.join(dir, 'multi'));
      const perFrame = [];
      for (const f of req.frames) tally(perFrame, full.get(f), multi.get(f), f);
      results.push({ path: 'export', request: req.name, frames: req.frames, clipsFull: allClips, clipsExpanded: exp.clipIds.length, cards: exp.cardIds, media: exp.mediaIds, cuts: exp.cutIds, perFrame });
      console.log(`[MPE-PROBE] ${i + 1}. ${req.name}: frames ${req.frames.join(',')}; clips ${allClips} → ${exp.clipIds.length} (${exp.clipIds.join(',')}); media ${exp.mediaIds.join(',') || 'none'}; ${line(perFrame)}`);
    }
    // Second pass: frame viewing path (FramePipeline#see_frames used by worker process renderFrames)
    if (!argv.includes('--no-pipeline')) {
      const service = new FramePipeline({ root: path.join(root, 'pipeline'), origin: () => origin });
      try {
        for (const [i, req] of REQUESTS.entries()) {
          const times = req.frames.map((f) => f / FPS);
          const exp = expandProject(project, { frames: req.frames });
          const full = await service.see_frames(renderProject(project), times);
          const multi = await service.see_frames(renderProject(exp.project), times);
          const perFrame = [];
          for (const f of req.frames) tally(perFrame, full.get(f).buf, multi.get(f).buf, f, { source: [full.get(f).source ?? null, multi.get(f).source ?? null] });
          results.push({ path: 'see_frames', request: req.name, frames: req.frames, clipsFull: allClips, clipsExpanded: exp.clipIds.length, perFrame });
          console.log(`[MPE-PROBE see_frames] ${i + 1}. ${req.name}: ${line(perFrame)}`);
        }
      } finally { await service.close(); }
    }
  } finally {
    if (!argv.includes('--keep')) for (const name of Object.values(media)) await fs.rm(path.join(mediaDir, name), { force: true });
  }
  const ok = identical === frames && diffPixels === 0;
  console.log(JSON.stringify({ ok, requests: REQUESTS.length, frames, identical, diffPixels, out: root, origin, results }));
  process.exit(ok ? 0 : 1);
}


main().catch((err) => { console.error(err?.stack || err); process.exit(2); });

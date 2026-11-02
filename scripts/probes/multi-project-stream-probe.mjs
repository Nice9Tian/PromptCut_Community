#!/usr/bin/env node
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
/**
 * Stream generation in multi-project mode: frame-by-frame evidence that "only loading the used segment"
 * keeps visuals and keys unchanged (lead session decision, 2026-10-22: keys are calculated from the
 * subset expanded for this stream).
 *
 *   node scripts/probes/multi-project-stream-probe.mjs --url http://127.0.0.1:5880 [--out <dir>] [--keep]
 *
 * Requires a running dev server (`--url`). Test project is the same as in
 * `multi-project-expand-probe.mjs` (`multi-project-fixture.mjs`).
 *
 * Two things, both going through the real pipeline (`FramePipeline`: real render page computes card
 * plan, font fingerprint, environment fingerprint):
 *
 *   K  Key consistency: publisher calculates each stream of this revision from whole project
 *      (single-card stream, below-dependent stream, `listStreamSpecs`); node calculates a plan using
 *      only the subset expanded for this stream (`streamNeed` + `expandProject` in
 *      `render-node/expand.mjs`), recovering the same stream. Content key and stream key compared
 *      byte by byte on both sides.
 *   P  Visual consistency: isolated project for the same stream, built from whole project in
 *      single-project mode vs. built from subset expanded for this stream in multi-project mode
 *      (the two branches of `StreamProducer#isolatedOf`), each passed to export page to render
 *      several frames in this stream (playback start, first frame, middle, last frame), compared
 *      pixel by pixel (RGBA byte by byte).
 *
 * Passing criteria: K identical on both sides for each stream; P has 0 different pixels per frame.
 * Last line of stdout is JSON summary; exit code 0 passes, 1 fails, 2 fails to start.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { renderProject } from '../../server/render-project.mjs';
import { isolatedStreamProject } from '../../server/frame-stream.mjs';
import { expandProject, streamNeed } from '../../server/render-node/expand.mjs';
import { devOrigin } from './probe-connect.mjs';
import { makeMedia, testProject, renderFrames, comparePng, mediaDirOf } from './multi-project-fixture.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const origin = arg('--url', process.env.PC_FRAME_TEST_URL || devOrigin());
const stamp = Date.now();
const root = path.resolve(arg('--out', path.join('out', `multi-project-stream-${stamp}`)));
const mediaDir = mediaDirOf();

async function main() {
  await fs.mkdir(root, { recursive: true });
  const media = await makeMedia(stamp, mediaDir);
  const project = testProject(media);
  const service = new FramePipeline({ root: path.join(root, 'pipeline'), origin: () => origin });
  const keys = [];
  const frames = [];
  try {
    // Publisher: calculate a plan for the whole project, take streams of each card in manifest (host
    // produces only single-card streams and below-dependent streams)
    const { entry } = await service.planForQueue(renderProject(project));
    const clipIds = project.tracks.filter((t) => !t.hidden).flatMap((t) => t.clips).filter((c) => c.cardId).map((c) => c.id);
    const specs = service.listStreamSpecs(entry, clipIds).filter((s) => s.kind === 'card' || s.kind === 'below');
    if (!specs.length) throw new Error('This version has no streams at all (check envFingerprint and the streams toggle)');
    for (const spec of specs) {
      const need = streamNeed(spec);
      const sub = expandProject(project, need);
      // K: node calculates plan using only the subset, recovering the same stream
      const { entry: subEntry } = await service.planForQueue(renderProject(sub.project));
      const again = service.listStreamSpecs(subEntry, [spec.topClipId]).find((s) => s.kind === spec.kind && s.topClipId === spec.topClipId) ?? null;
      const k = { kind: spec.kind, clip: spec.topClipId, clipsFull: project.tracks.reduce((n, t) => n + t.clips.length, 0), clipsSubset: sub.clipIds.length,
        same: !!again && again.contentKey === spec.contentKey && again.streamKey === spec.streamKey, contentKey: spec.contentKey.slice(0, 16), nodeContentKey: again?.contentKey?.slice(0, 16) ?? null };
      keys.push(k);
      // P: isolated project for the same stream, whole project vs subset (same algorithm as the two branches of StreamProducer#isolatedOf)
      const full = isolatedStreamProject(entry.project, spec);
      const part = isolatedStreamProject(expandProject(entry.project, need).project, spec);
      const at = [...new Set([spec.mountFrame, spec.firstFrame, Math.round((spec.firstFrame + spec.lastFrame) / 2), spec.lastFrame].filter((f) => Number.isInteger(f) && f >= 0 && f < spec.total))].sort((a, b) => a - b);
      const dir = path.join(root, `${spec.kind}-${spec.topClipId}`);
      const a = await renderFrames(origin, full, at, path.join(dir, 'single'));
      const b = await renderFrames(origin, part, at, path.join(dir, 'multi'));
      const per = at.map((f) => ({ frame: f, ...comparePng(a.get(f), b.get(f)) }));
      frames.push(...per.map((p) => ({ stream: `${spec.kind}:${spec.topClipId}`, ...p })));
      console.log(`[MPS-PROBE] ${spec.kind}:${spec.topClipId}: clips ${k.clipsFull} → ${k.clipsSubset} (${sub.clipIds.join(',')}); key ${k.same ? 'same' : 'different'} (${k.contentKey} / ${k.nodeContentKey});`
        + per.map((p) => `frame ${p.frame} differing pixels ${p.pixels}/${p.total} (opaque ${p.opaque})`).join(';'));
    }
  } finally {
    await service.close();
    if (!argv.includes('--keep')) for (const name of Object.values(media)) await fs.rm(path.join(mediaDir, name), { force: true });
  }
  const identical = frames.filter((f) => f.size && f.pixels === 0).length;
  const ok = keys.length > 0 && keys.every((k) => k.same) && identical === frames.length;
  console.log(JSON.stringify({ ok, streams: keys.length, keysSame: keys.filter((k) => k.same).length, frames: frames.length, identical, diffPixels: frames.reduce((n, f) => n + f.pixels, 0), out: root, keys }));
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err?.stack || err); process.exit(2); });

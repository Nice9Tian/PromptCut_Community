/**
 * Single-card frame (`bake_card`, texture in 3D view) renders a bitmap on the spot: loads this
 * project (containing only one card) into the prerender room, advances from this card's mount frame
 * to the requested frames, and captures PNGs directly to return.
 *
 * Semantics: `docs/semantics/mechanism/asset-service.md` "Single-card frame bypassing the task
 * queue... is a bitmap rendered on the spot, without storing HTML for this card",
 * `docs/semantics/glossary.md` "Snapshot" (snapshots are never stored for any individual card anywhere).
 *
 * Differs from `FramePipeline.see_frames` only in "whether to record":
 *   - Does not create frame store entries, neither queries nor writes the frame store (untouched:
 *     whole-scene HTML archives, frame-by-frame PNGs, and `controls-html/` under `<frameStore>/<key>/`).
 *     Previously, this path went through `see_frames`, where isolated single-card projects each took
 *     an entry in the frame store containing their HTML; snapshots of this card also entered the
 *     snapshot store and were pushed to `snap` in the asset service; old entries remain in place and
 *     are evicted by capacity limits, unread here;
 *   - Does not generate snapshots: the screenshot is the frame visual itself (`fullFrame` in `bakeFrames`),
 *     producing zero HTML;
 *   - Does not inject card frames prerendered elsewhere into the page (`cardRender`): this card is
 *     actually rendered here.
 * Queueing remains as before: Agent tasks go to the Agent dedicated instance (`runAgentTask`);
 * textures that users are waiting to see jump ahead of normal prerender tasks; idle texture prefetches
 * queue at the tail (`runQueueTask`); all scaled at 1x (`mechanism/rendering.md` "Query rendering and
 * prerender process").
 *
 * Bitmap caching, reconciliation, and pushing to the remote asset service occur at the caller
 * (`bakeOne` in `bake.ts` via `bake-store.mjs`); only pixels are produced here.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { frameService, renderProject } from "../vite-plugin-frames";
import { bakeFrames } from "../bakery/index.mjs";
import { dirtyStreamLease } from "../bakery/bake.mjs";
import { outRoot } from "./http";

/** `bakeFrames` requires an output directory (it creates `<out>/frames`); this path does not write frame files, so the directory remains empty */
export const cardBitmapScratch = (root: string) => path.join(outRoot(root), "card-bitmap-scratch");

/**
 * Renders several timestamps of this project, returning "frame number → PNG". The frame number
 * algorithm matches `see_frames`: rounded by fps, clamped within the project duration.
 * `lane`: `"agent"` (default) / `"preview"` / `"prerender"`, see file header.
 */
export async function renderCardBitmaps(
  root: string,
  origin: string,
  project: any,
  times: number[],
  o: { signal?: AbortSignal; lane?: "agent" | "preview" | "prerender" } = {},
): Promise<Map<number, Buffer>> {
  const service: any = frameService(root, origin);
  const normalized = renderProject(project);
  const fps = normalized.fps || 30;
  const max = Math.max(0, Math.floor((normalized.duration || 0) * fps) - 1);
  if (!times.length || times.some((t) => !Number.isFinite(t))) throw new Error("Frame times must be finite numbers");
  const frames = [...new Set(times.map((t) => Math.max(0, Math.min(max, Math.round(t * fps)))))].sort((a, b) => a - b);
  const scratch = cardBitmapScratch(root);
  const shots = new Map<number, Buffer>();
  const work = async (lease: (project: any) => Promise<any>) => {
    if (o.signal?.aborted) throw Object.assign(new Error("Frame request cancelled"), { cancelled: true });
    const bakery = await lease(normalized);
    // This prerender room may have just produced a track stream: its stream lease is invalidated here, and the next stream generation pays for a full replay
    dirtyStreamLease(bakery);
    shots.clear();
    await fsp.mkdir(scratch, { recursive: true });
    await bakeFrames(bakery, {
      out: scratch, targetFrames: frames, snapshotOnly: false, fullFrame: true, writeFrames: false, signal: o.signal,
      onFrame: async (frame: number, buf: Buffer) => { shots.set(frame, buf); },
    });
    return shots;
  };
  const lane = o.lane === "preview" || o.lane === "prerender" ? o.lane : "agent";
  if (lane === "agent") await service.runAgentTask(work);
  else await service.runQueueTask(work, o.signal, { front: lane === "preview", scaleLane: "preview", kind: lane });
  for (const frame of frames) if (!shots.has(frame)) throw new Error(`Frame ${frame} was not rendered`);
  return shots;
}

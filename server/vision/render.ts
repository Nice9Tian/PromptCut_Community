/**
 * Render entry point: turns "these timestamps of this project" into PNGs. Copied verbatim from
 * server/vite-plugin-vision.ts.
 *
 * **This module state can only be written here**: `counter` (sequence dispenser for temporary
 * filenames). bake.ts gets numbers via `nextCounter()`; this is the only counter in the entire
 * process. Dependency direction: render → worker-pool / http, unidirectional.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { frameService, renderProject } from "../vite-plugin-frames";
import { postFrame } from "../png-post.mjs";
import { outRoot } from "./http";
import { cardBitmapScratch, renderCardBitmaps } from "./card-bitmap";
import { runExport } from "./worker-pool";
import type { RenderJob2, Runner } from "./worker-pool";

let counter = 0;

/** Deletes temporary export directory with backoff retry if deletion fails (child process may still hold file on Windows). Returns whether deleted. */
async function removeTempDir(dir: string): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await fsp.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }); return true; }
    catch { await new Promise((r) => setTimeout(r, 200 * (attempt + 1))); }
  }
  return false;
}

/** Allocates an ID. `counter` lives only in this module; across modules (bake.ts temporary file names), only access via this */
export function nextCounter(): number {
  return counter++;
}

/** Result returned for a frame. width / height / transparentRatio are present only after post-processing */
export interface FrameResult {
  buf: Buffer;
  width?: number | null;
  height?: number | null;
  transparentRatio?: number;
  /**
   * D3: Solid rectangles of this frame (stage pixel coordinates, not thumbnail coordinates). Present
   * only when rects was requested; null = could not measure this frame. An item with `solid` being
   * null indicates that card has no solid pixels at this moment.
   */
  rects?: EntityRect[] | null;
}

/** D3: A card's wrapper layer bounding box and solid bounds in this frame, both `[x, y, w, h]` stage pixels */
export interface EntityRect {
  clipId: string;
  box: [number, number, number, number];
  solid: [number, number, number, number] | null;
}

/** Additional render options */
export interface RenderOpts {
  /** Triggered if caller aborts: removes queued items and stops running ones */
  signal?: AbortSignal;
  /** Pixel work before returning: shrink = thumbnail for model; bg = underlay color (6-hex); stats = count transparent pixels */
  post?: { shrink?: boolean; bg?: string | null; stats?: boolean };
  /** Who runs it: defaults to render pool if omitted */
  runner?: Runner;
  /**
   * D3: Attach solid rectangles to each frame (`FrameResult.rects`), and write one line per clipId
   * into `notes` (the text part of tool results). If omitted, checks `post.shrink`: thumbnail =
   * image shown to the model (`see_frames`), and images shown to the model always attach rectangles;
   * callers that do not shrink images, such as prerendered textures and GIFs, do not pay for this
   * pass. Available only on the FramePipeline path; the `runner` bypass does not measure.
   */
  rects?: boolean;
  /**
   * Which queue to join on the FramePipeline path (`mechanism/rendering.md` "Query Rendering and
   * Prerendering Processes"). Defaults to `"agent"`: Agent queries, run only on Agent dedicated
   * instances (`see_frames`, `/render` for `get_gif`, `bake_card`).
   *   - `"preview"`: Action preview opened by the user in the AI panel: queued ahead of all pending
   *     items in the normal prerender queue, without occupying the Agent dedicated instance;
   *   - `"prerender"`: Normal prerendering (idle texture prefetching for 3D view): queued at the tail
   *     of the normal prerender queue, which Agent dedicated instances can pick up when idle.
   * `runner` bypass ignores it.
   */
  lane?: "agent" | "preview" | "prerender";
  /**
   * Single-card visuals (`bake_card`, textures for 3D view): renders bitmaps on the spot, creating
   * no frame store entries, neither querying nor writing to the frame store, and generating no
   * snapshots (`card-bitmap.ts`; `mechanism/asset-service.md` "Single-Card Visuals Without Task
   * Queue"). Does not attach solid rectangles. The `runner` bypass ignores it (that path only outputs
   * PNGs in a temporary directory and deletes them after use anyway).
   */
  bitmapOnly?: boolean;
}

const fmtBox = (b: readonly number[] | null) => (b ? `[${b.join(", ")}]` : "null");

/**
 * Text part of D3: one paragraph per frame, one line per clipId within each paragraph. Coordinates
 * are in stage pixels (project width × height); images shown to the model are mostly shrunk, so both
 * dimensions are written out.
 */
export function entityRectsNote(stage: { width: number; height: number }, fps: number, frames: [number, EntityRect[] | null][], image?: { width?: number | null; height?: number | null }): string {
  const scaled = image?.width && image?.height && (image.width !== stage.width || image.height !== stage.height)
    ? `Image was scaled down to ${image.width}×${image.height}; converted proportionally` : "Matches the image pixels";
  const head = `Solid rectangles (pixel coordinates [x, y, w, h] on the ${stage.width}×${stage.height} stage, ${scaled}; box = outer frame of the clip wrapper, solid = extent of the solid pixels, solid null = this card has no solid pixels right now):`;
  const blocks = frames.map(([frame, rects]) => {
    const t = `t=${+(frame / fps).toFixed(3)}s`;
    if (!rects) return `${t}: could not be measured.`;
    if (!rects.length) return `${t}: no clips on screen.`;
    return [`${t}:`, ...rects.map((r) => `${r.clipId} box=${fmtBox(r.box)} solid=${fmtBox(r.solid)}`)].join("\n");
  });
  return [head, ...blocks].join("\n");
}

/**
 * Attach entity rectangles to already rendered frames. If measurement fails, do not compromise the
 * image: log a note and deliver the image anyway; only throw upward if the caller aborted.
 */
async function attachEntityRects(service: ReturnType<typeof frameService>, project: any, times: number[], result: Map<number, FrameResult>, notes: string[], signal?: AbortSignal): Promise<void> {
  try {
    const measured: Map<number, EntityRect[] | null> = await service.entityRects(project, times, { signal });
    for (const [frame, value] of result) value.rects = measured.get(frame) ?? null;
    const fps = Number(project.fps) > 0 ? project.fps : 30;
    const frames = [...result.keys()].sort((a, b) => a - b);
    notes.push(entityRectsNote({ width: project.width, height: project.height }, fps,
      frames.map((frame): [number, EntityRect[] | null] => [frame, result.get(frame)?.rects ?? null]), result.get(frames[0])));
  } catch (e: any) {
    if (signal?.aborted) throw e;
    for (const value of result.values()) value.rects = null;
    notes.push(`Could not measure the entity rectangle (${e?.message || e}); the image is not affected.`);
  }
}

/**
 * Run a single-frame render to get the PNG bytes of that frame.
 *
 * By default, FramePipeline renders the complete FrameScene in the same Chrome page; video is
 * mounted and seeked only at the target snapshot frame. Only when explicitly selecting the legacy
 * ffmpeg compatibility bypass will frames be extracted separately from the asset layer and
 * composited below the card.
 */
/**
 * A single frame is just renderFrames for only one point in time: images captured by both paths
 * are byte-for-byte identical (single frame via frames `F-F` also pushes from frame 0 to F; see
 * the notes in renderFrames), so combining them into one avoids cases where "single and batch are
 * not the same image".
 */
export async function renderOneFrame(root: string, origin: string, project: any, t: number, notes: string[], priority = 0, o: RenderOpts = {}): Promise<FrameResult> {
  const m = await renderFrames(root, origin, project, [t], notes, priority, o);
  const first = m.values().next().value;
  if (!first) throw new Error("No frame was rendered");
  return first;
}

/**
 * Render **several points in time for the same project** in one pass. Returns "frame number → PNG".
 *
 * The only difference from renderOneFrame is "how many images come out in one pass". Why it is
 * worth opening a dedicated path: the export script pushes forward from frame 0 regardless of
 * which frame is requested (determinism requirement: the animation anchor is "the frame where it
 * first appears", and jumping forward has no anchor), so rendering N points in time for a single
 * card across N passes means N repeated forward pushes, which is O(N²); pushing through in one
 * pass and capturing along the way pays the advance cost only once.
 *
 * Actual benchmark (1920x1080, 7 points in time for the same card): 7 passes took 31.0s → one pass
 * took 2.7s, **11.4x**, and all 7 images are byte-for-byte identical. Breaking down unit costs:
 * pushing one frame takes about 18~23ms, capturing one image takes about 78ms, while starting a
 * pass on its own takes 4.0~5.0s. That is, starting from the 2nd point in time for the same card,
 * the cost drops from 4400ms to 78ms.
 */
export async function renderFrames(root: string, origin: string, project: any, times: number[], notes: string[], priority = 0, o: RenderOpts = {}): Promise<Map<number, FrameResult>> {
  if (!o.runner && o.bitmapOnly) {
    const shots = await renderCardBitmaps(root, origin, project, times, { signal: o.signal, lane: o.lane ?? "agent" });
    const result = new Map<number, FrameResult>();
    const wantPost = !!(o.post && (o.post.shrink || o.post.bg || o.post.stats));
    const scratch = cardBitmapScratch(root);
    for (const [frame, buf] of shots) {
      if (!wantPost) { result.set(frame, { buf, width: project.width, height: project.height }); continue; }
      // Background color application and transparent pixel counting are left to postFrame as usual (it
      // sends and receives via files); temporary files are placed in this path's own empty directory and
      // deleted after use
      const stem = path.join(scratch, "post-" + process.pid + "-" + counter++);
      const file = stem + "-input.png", out = stem + ".png";
      try {
        await fsp.mkdir(scratch, { recursive: true });
        await fsp.writeFile(file, buf);
        const info = await postFrame({ cards: file, layers: [], out, bg: o.post?.bg ?? null, shrink: !!o.post?.shrink, stats: !!o.post?.stats });
        result.set(frame, { ...info, buf: await fsp.readFile(out) });
      } finally { await Promise.all([fsp.rm(out, { force: true }), fsp.rm(file, { force: true })]); }
    }
    return result;
  }
  if (!o.runner) {
    const service = frameService(root, origin);
    const normalized = renderProject(project);
    const entry = await service.entry(normalized);
    const frames = await service.see_frames(normalized, times, { signal: o.signal, lane: o.lane ?? "agent" });
    const result = new Map<number, FrameResult>();
    for (const [frame, value] of frames) {
      if (value.incomplete) throw new Error(`Frame not ready yet: ${(value.missing || []).join(", ")}`);
      if (o.post && (o.post.shrink || o.post.bg || o.post.stats)) {
        // The authoritative frame may come from MOV, a mixed control cache,
        // or live rendering. None promises a duplicate in frames/<n>.png.
        const stem = path.join(entry.dir, "post-" + process.pid + "-" + counter++);
        const file = stem + "-input.png", out = stem + ".png";
        try {
          await fsp.mkdir(entry.dir, { recursive: true });
          await fsp.writeFile(file, value.buf);
          const info = await postFrame({ cards: file, layers: [], out, bg: o.post.bg ?? null, shrink: !!o.post.shrink, stats: !!o.post.stats });
          result.set(frame, { ...info, buf: await fsp.readFile(out) });
        } finally { await Promise.all([fsp.rm(out, { force: true }), fsp.rm(file, { force: true })]); }
      } else result.set(frame, { buf: value.buf, width: project.width, height: project.height });
    }
    if (o.rects ?? !!o.post?.shrink) await attachEntityRects(service, normalized, times, result, notes, o.signal);
    return result;
  }

  // Include pid: the editor process (hot-standby renderer) and prerender process write to the same
  // out/, and their respective counters both count from 0
  const id = `vision-${process.pid}-${Date.now().toString(36)}-${counter++}`;
  const dir = path.resolve(outRoot(root), `export-${id}`);
  await fsp.mkdir(dir, { recursive: true });

  const fps = project.fps || 30;
  // The frame number must fall within the project duration; otherwise, the script renders an empty
  // stage, and the model sees a blank screen and assumes the card did not take effect
  const maxFrame = Math.max(0, Math.floor((project.duration || 0) * fps) - 1);
  const frames = [...new Set(times.map((t) => Math.min(maxFrame, Math.max(0, Math.round(t * fps)))))].sort((a, b) => a - b);
  const pad = (f: number) => String(f).padStart(6, "0");
  const frameFile = (f: number) => path.join(dir, "frames", `${pad(f)}.png`);
  const finalFile = (f: number) => path.join(dir, `final-${pad(f)}.png`);

  try {
    // The asset layer extracts frames independently per frame, running in parallel with launching
    // Chrome to render the card (a card's isolated project usually has no asset layer, so this is
    // mostly empty here)
    const layersPromises = frames.map(() => Promise.resolve([]));
    await fsp.writeFile(path.join(dir, "project.json"), JSON.stringify(project, null, 2), "utf8");
    const relOut = process.env.PROMPTCUT_EXPORT_DIR ? dir : `out/export-${id}`;
    const wantPost = !!(o.post && (o.post.shrink || o.post.bg || o.post.stats));
    const job: RenderJob2 = {
      opts: {
        url: `${origin}/?export=1&timeline=/@export/${id}/project.json`,
        out: relOut,
        frames: `0-${frames[frames.length - 1]}`,
        targetFrames: frames,
        fps,
      },
      /*
       * Decide whether post-processing is needed after rendering the frame: the asset layer is also
       * extracted by now. **Return null if nothing needs to be done**, and read and deliver the frame
       * file directly below: previously, even without an asset layer, it decoded and re-encoded as is,
       * which was purely wasted effort.
       */
      post: async () => {
        const layers = await Promise.all(layersPromises);
        if (!wantPost && layers.every((l) => l.length === 0)) return null;
        return frames.map((f, i) => ({
          cards: frameFile(f), layers: layers[i], out: finalFile(f),
          bg: o.post?.bg ?? null, stats: !!o.post?.stats, shrink: !!o.post?.shrink,
        }));
      },
    };
    const run: Runner = o.runner ?? ((j, s) => runExport(root, j, priority, s));
    const results = await run(job, o.signal);

    const out = new Map<number, FrameResult>();
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const r = results ? results[i] : null;
      const buf = await fsp.readFile(r ? finalFile(f) : frameFile(f));
      out.set(f, {
        buf,
        width: r?.width ?? null,
        height: r?.height ?? null,
        ...(r && r.transparentRatio !== undefined ? { transparentRatio: r.transparentRatio } : {}),
      });
    }
    return out;
  } finally {
    // A quick look is enough, leave no garbage behind: wait for deletion to finish (on Windows, the
    // render child process may have just exited and files might still be locked; back off and retry);
    // if deletion still fails, this call should not fail: log a note, and on next startup
    // sweepExportRoot will clean it up by pid
    if (!(await removeTempDir(dir))) console.warn(`[vision] Could not delete the temporary export directory, leaving it for cleanup on next startup: ${dir}`);
  }
}

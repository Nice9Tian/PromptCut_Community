/**
 * Where each card frame gets its visuals during online browser export (semantics
 * `docs/semantics/product/platforms.md` "Online browser" "Export", user decision, 2026-10-13). Pure
 * calculation, no data fetching.
 *
 * The export page (`?export=1` document sharing origin with editor page) advances time frame by
 * frame, generating a whole scene snapshot and rasterizing it for each frame. Visuals for a card
 * at this frame come from three sources:
 *
 *   1. **Frame-by-frame render on this page**: live components in export page. Cards runnable on
 *      this page (bundled at build time) always take this route in "Full export";
 *   2. **Track stream**: used only in "Fast export", and **only takes full density segments**
 *      (sections with only a sparse version update only once every 15 frames, causing stuttering
 *      in final video). The fetched frame is pasted into this card's wrapper layer (single-card
 *      stream), or pasted in stage coordinates taking this card's layer order (below-dependent
 *      stream), matching preview-side rules;
 *   3. **Bitmaps rendered frame by frame by render nodes** (`exportFrames.ts`; used only for this
 *      export): frames not covered by a full density stream for cards not executed on this page
 *      (synced user cards and media effect cards: export page does not execute their code).
 *
 * A card's wrapper layer is always mounted in export page (position, scale, rotation, opacity, and
 * layer order all reside on wrapper layer); for cards that do not take item 1 across their entire
 * duration, export page mounts only wrapper layer without components (`wrapperOnly`), saving the
 * time to live render this card: this is why fast export is fast.
 *
 * Group streams (one stream covering several adjacent cards) are not fetched in this version:
 * their members are treated as having no stream in fast export (rendered frame by frame on this
 * page, or rendered frame by frame by render nodes), leaving visuals unaffected.
 */
import { streamSegmentOf, streamSegmentFirstFrame } from "../render/streamSegments.mjs";
import { getCard, isUserCardId, cardRunState } from "../kernel/registry";
import type { Project } from "../kernel/project";

/**
 * Whether this card can run in the browser at this moment:
 *   - Cards bundled at build time (built-in cards, built-in media effect cards, repository cards):
 *     `getCard` is defined, directly runnable;
 *   - Synced user cards: unsynced or non-user cards are not runnable; only run state `ready` is
 *     considered runnable;
 *     other error states (`missing-module`, `unsupported-syntax`, `gpu`, `load-error`,
 *     `runtime-error`, `not-isolated`, `media`, `disabled`, `loading`) are all not runnable.
 */
export function isCardRunnable(cardId: string): boolean {
  if (getCard(cardId)) return true;
  if (!isUserCardId(cardId)) return false;
  const state = cardRunState(cardId)?.state;
  return state === "ready";
}

/**
 * Card clips not executed on this page:
 * Online export performs whole-frame live render in cross-origin isolated stage
 * (user-decisions-2026-10-14 §2.2):
 * synced user cards live render in the isolated stage as long as they are ready (`ready`) in
 * browser; only cards genuinely unable to execute in browser (unsupported syntax, missing module,
 * insufficient GPU capability, load/runtime error, not isolated, media formats, etc., or
 * unready/unknown cards) enter `nonRunnableClips` waiting for render node frame-by-frame rendered
 * bitmap fallback for export.
 */
export function nonRunnableClips(p: Project): string[] {
  return p.tracks.flatMap((tr) => tr.clips).filter((c) => !!c.cardId && !isCardRunnable(c.cardId)).map((c) => c.id);
}

export type ExportMode = "fast" | "full";

export interface LayerRect { x: number; y: number; w: number; h: number }

/** A fetchable stream (a row in layer table, after selecting candidates and collecting all manifests) */
export interface StreamCoverage {
  clipId: string;
  /** `local`: wrapper layer's own coordinate system; `stage`: stage coordinates (below-dependent stream) */
  plane: "local" | "stage";
  resultKey: string;
  /** First frame of this stream itself (project frame number) */
  originFrame: number;
  /** Full density segment number → sample count for this segment */
  dense: ReadonlyMap<number, number>;
}

/** Bitmaps rendered frame by frame by render nodes (an entry in export index, after manifests collected) */
export interface FrameCoverage {
  clipId: string;
  plane: "local" | "stage";
  /** Rectangle covered by each image (plane coordinates) */
  rect: LayerRect;
  /** Project frames with bitmaps */
  frames: ReadonlySet<number>;
}

export interface ClipSpan { id: string; start: number; end: number; cardId?: string }

/** Project frames covered by clip `[first, last]` (same formula as prerender sample window and `windowOf` in `streamInputSig.mjs`; truncated by project duration) */
export function clipFrameWindow(clip: { start: number; end: number }, fps: number, total: number): { first: number; last: number } {
  const start = Number(clip.start) || 0, end = Number(clip.end) || 0;
  const first = Math.max(0, Math.ceil(start * fps - 1e-9));
  const phase = first / fps - start;
  const count = Math.max(1, Math.ceil((end - start - phase) * fps - 1e-9));
  return { first, last: Math.min(total - 1, first + count - 1) };
}

/** Whether this stream has full density visuals at frame `frame` */
export function streamCovers(stream: Pick<StreamCoverage, "originFrame" | "dense">, frame: number): boolean {
  if (frame < stream.originFrame) return false;
  const seg = streamSegmentOf(frame, stream.originFrame);
  const samples = stream.dense.get(seg);
  return samples !== undefined && frame - streamSegmentFirstFrame(seg, stream.originFrame) < samples;
}

export interface LayerPlan {
  mode: ExportMode;
  /** Clip fetching stream in fast export → its stream */
  streamOf: Map<string, StreamCoverage>;
  /** Clips where export page mounts only wrapper layer without components (not live rendered by export page throughout) */
  wrapperOnly: string[];
  /** Clips requiring render node frame-by-frame rendering (not executed on this page, not fully covered by full density stream) */
  needFrames: string[];
  /** Stats: frame count fetching stream, frame count requiring render node bitmaps (accumulated per clip) */
  streamFrames: number;
  nodeFrames: number;
}

/**
 * Determine how each card is output.
 *   - `nonRunnable`: card clips not executed on this page (their code is absent from export page);
 *   - `streams`: fetchable streams (checked only in fast export; if a clip has several, take the
 *     one with the most full density segments).
 */
export function planCardLayers({ clips, fps, total, mode, nonRunnable, streams }: {
  clips: readonly ClipSpan[]; fps: number; total: number; mode: ExportMode;
  nonRunnable: ReadonlySet<string>; streams: readonly StreamCoverage[];
}): LayerPlan {
  const plan: LayerPlan = { mode, streamOf: new Map(), wrapperOnly: [], needFrames: [], streamFrames: 0, nodeFrames: 0 };
  const best = new Map<string, StreamCoverage>();
  if (mode === "fast") {
    for (const s of streams) {
      const cur = best.get(s.clipId);
      if (!cur || s.dense.size > cur.dense.size) best.set(s.clipId, s);
    }
  }
  for (const clip of clips) {
    if (!clip.cardId) continue;
    const { first, last } = clipFrameWindow(clip, fps, total);
    if (last < first) continue;
    const stream = best.get(clip.id) ?? null;
    let covered = 0;
    if (stream) for (let f = first; f <= last; f++) if (streamCovers(stream, f)) covered++;
    const all = last - first + 1;
    if (stream && covered > 0) { plan.streamOf.set(clip.id, stream); plan.streamFrames += covered; }
    if (nonRunnable.has(clip.id)) {
      plan.wrapperOnly.push(clip.id);
      if (covered < all) { plan.needFrames.push(clip.id); plan.nodeFrames += all - covered; }
    } else if (stream && covered === all) {
      plan.wrapperOnly.push(clip.id);
    }
  }
  return plan;
}

export type LayerChoice = { from: "stream"; stream: StreamCoverage } | { from: "frames"; frames: FrameCoverage } | { from: "live" } | { from: "missing" };

/**
 * Which source this card takes for this frame. `missing`: cards not executed on this page have
 * neither full density streams nor render node bitmaps for this frame (pre-export check should
 * have caught this; reaching here indicates manifests changed since check, caller treats as error
 * and avoids outputting half-finished visuals).
 */
export function layerChoiceAt(plan: LayerPlan, clipId: string, frame: number, frames: ReadonlyMap<string, FrameCoverage>, nonRunnable: ReadonlySet<string>): LayerChoice {
  const stream = plan.streamOf.get(clipId);
  if (stream && streamCovers(stream, frame)) return { from: "stream", stream };
  if (!nonRunnable.has(clipId)) return { from: "live" };
  const got = frames.get(clipId);
  if (got && got.frames.has(frame)) return { from: "frames", frames: got };
  return { from: "missing" };
}

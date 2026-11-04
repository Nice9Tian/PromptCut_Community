/**
 * Sources of card visuals during online browser export, gathered in one place for the compositor
 * (`layers` in `frameCompositor.ts`).
 *
 *   Before export (`prepareExportLayers`):
 *     Fast export → read layer tables and stream manifests, determine full-density segments for
 *     each stream (`streamFrames.ts`);
 *     Determine how each card is output (`planCardLayers` in `cardLayers.ts`);
 *     Cards not executed on this page and not fully covered by full-density streams → request
 *     render nodes to render frame-by-frame, wait until all have arrived (`exportFrames.ts`).
 *     Do not start exporting before all arrive.
 *   During export (`at(frame, clips mounting wrapper layers)`):
 *     Which option each card takes for this frame (`layerChoiceAt`): this frame from stream
 *     (decoded and composited into an image with transparency), this frame rendered by render
 *     nodes (PNG), or do not paste (live rendered by export page). Return layers to paste;
 *     the compositor pastes them into snapshots following preview-side rules.
 *
 * Process only one frame at a time, discard images after use; one stream decoder per stream,
 * decoding forward along frame numbers.
 */
import type { Project } from "../kernel/project";
import { clipFrameWindow, layerChoiceAt, planCardLayers, type ExportMode, type FrameCoverage, type LayerPlan, type LayerRect } from "./cardLayers";
import { requestExportFrames, type ExportFrameDeps, type ExportFrames, type ExportFramesStatus } from "./exportFrames";
import { loadReadableStreams, StreamFrameReader, type ReadableStream, type StreamFrameDeps } from "./streamFrames";
import { ONLINE_EXPORT_TEXT } from "./text";

/** A layer to be pasted by the compositor */
export interface FrameLayer {
  clipId: string;
  /** `local`: wrapper layer's own coordinate system, image placed inside wrapper layer; `stage`: stage coordinates, image placed beside wrapper layer with same layer order */
  plane: "local" | "stage";
  rect: LayerRect;
  /** `data:` URL (other URLs taint the canvas) */
  url: string;
}

export interface FrameLayers {
  /** Clips where the export page only mounts wrapper layers without components */
  wrapperOnly: readonly string[];
  /** Visuals to paste for each clip mounting wrapper layers in this frame (project frame number); omitted for live renders on this page */
  at(frame: number, activeClipIds: readonly string[]): Promise<FrameLayer[]>;
  close(): void;
  readonly stats: ExportLayerStats;
}

export interface ExportLayerStats {
  mode: ExportMode;
  /** Number of clips using streams, clips not live rendering for entire segments, and clips requesting render nodes */
  streamClips: number;
  wrapperOnly: number;
  nodeClips: number;
  /** Number pasted: fetched from stream, rendered by render nodes */
  streamPictures: number;
  nodePictures: number;
  /** Number pasted for each clip (probe verifies "this segment uses stream") */
  perClip: Record<string, { stream: number; frames: number }>;
  streamDecodeMs: number;
  streamBytes: number;
  nodeBytes: number;
  /** Time spent waiting for render nodes before export */
  waitMs: number;
}

export interface ExportLayerDeps {
  /** Read layer tables, stream manifests, and stream bytes */
  stream: StreamFrameDeps;
  /** Request render nodes and fetch their rendered bitmaps; null = cannot request on this page (not connected to project) */
  frames: ExportFrameDeps | null;
  /** Project version confirmed by document service (manifest plan is published using it) */
  projectRev: () => number | null;
}

const statusText = (s: ExportFramesStatus): string => (
  s.phase === "rendering" ? ONLINE_EXPORT_TEXT.renderingNode(s.done, s.total)
    : s.phase === "planning" ? ONLINE_EXPORT_TEXT.planningNode(s.clips)
      : ONLINE_EXPORT_TEXT.waitingNode(s.clips)
);

/** Whether this browser can decode track streams (browsers without `VideoDecoder` output fast export using the full export approach) */
const canDecodeStreams = () => typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder === "function";

export async function prepareExportLayers({ project, projectId, mode, nonRunnable, deps, signal, onWaiting }: {
  project: Project; projectId: string | null; mode: ExportMode; nonRunnable: readonly string[];
  deps: ExportLayerDeps; signal: AbortSignal; onWaiting?: (message: string | null) => void;
}): Promise<FrameLayers> {
  const fps = Math.max(1, project.fps || 30);
  const total = Math.max(1, Math.floor(project.duration * fps));
  const clips = project.tracks.flatMap((tr) => tr.clips).filter((c) => !!c.cardId).map((c) => ({ id: c.id, start: c.start, end: c.end, cardId: c.cardId }));
  const blocked = new Set(nonRunnable);
  const streams: ReadableStream[] = mode === "fast" && canDecodeStreams()
    // Layer tables are stored by project's own id (`layers:<project.id>`, written by render nodes for their claimed project version); task queues use document service project id (`projectId`). The two ids may differ
    ? await loadReadableStreams(project.id || null, project, deps.stream, { clipIds: new Set(clips.map((c) => c.id)) })
    : [];
  const plan: LayerPlan = planCardLayers({ clips, fps, total, mode, nonRunnable: blocked, streams });
  const stats: ExportLayerStats = { mode, streamClips: plan.streamOf.size, wrapperOnly: plan.wrapperOnly.length, nodeClips: plan.needFrames.length,
    streamPictures: 0, nodePictures: 0, perClip: {}, streamDecodeMs: 0, streamBytes: 0, nodeBytes: 0, waitMs: 0 };
  let frames: ExportFrames | null = null;
  if (plan.needFrames.length) {
    const rev = deps.projectRev();
    if (!deps.frames || !projectId || !Number.isSafeInteger(rev)) throw new Error(ONLINE_EXPORT_TEXT.noLink);
    const t0 = Date.now();
    frames = await requestExportFrames({
      projectId, projectRev: rev as number, project, clips: plan.needFrames, deps: deps.frames, signal,
      onStatus: (s) => { try { onWaiting?.(statusText(s)); } catch { /* Host failure does not affect waiting */ } },
    });
    stats.waitMs = Date.now() - t0;
    try { onWaiting?.(null); } catch { /* Same as above */ }
  }
  const coverage: Map<string, FrameCoverage> = frames?.coverage ?? new Map();
  const windows = new Map(clips.map((c) => [c.id, clipFrameWindow(c, fps, total)] as const));
  const readers = new Map<string, StreamFrameReader>();
  const byKey = new Map(streams.map((s) => [s.resultKey, s] as const));
  const count = (clipId: string, kind: "stream" | "frames") => {
    const row = (stats.perClip[clipId] ??= { stream: 0, frames: 0 });
    row[kind]++;
  };
  return {
    wrapperOnly: plan.wrapperOnly,
    stats,
    async at(frame, activeClipIds) {
      const out: FrameLayer[] = [];
      for (const clipId of activeClipIds) {
        const choice = layerChoiceAt(plan, clipId, frame, coverage, blocked);
        if (choice.from === "live") continue;
        if (choice.from === "stream") {
          const stream = byKey.get(choice.stream.resultKey)!;
          let reader = readers.get(stream.resultKey);
          if (!reader) { reader = new StreamFrameReader(stream, deps.stream, signal); readers.set(stream.resultKey, reader); }
          const pic = await reader.picture(frame);
          const url = (pic.canvas as HTMLCanvasElement).toDataURL("image/png");
          out.push({ clipId, plane: stream.plane, rect: pic.rect, url });
          stats.streamPictures++;
          count(clipId, "stream");
          continue;
        }
        if (choice.from === "frames") {
          const url = await frames!.dataUrl(clipId, frame, signal);
          out.push({ clipId, plane: choice.frames.plane, rect: choice.frames.rect, url });
          stats.nodePictures++;
          count(clipId, "frames");
          continue;
        }
        // Cards not executed on this page have nothing for this frame: leave blank outside clip frame range (wrapper layer hangs one extra tick at time boundaries); inside range means manifest differs from verification, stop
        const win = windows.get(clipId);
        if (win && frame >= win.first && frame <= win.last) throw new Error(ONLINE_EXPORT_TEXT.nodeFailed("frame-missing"));
      }
      return out;
    },
    close() {
      for (const r of readers.values()) {
        stats.streamDecodeMs += r.stats.decodeMs;
        stats.streamBytes += r.stats.bytes;
        r.close();
      }
      readers.clear();
      if (frames) stats.nodeBytes = frames.stats.bytes;
    },
  };
}

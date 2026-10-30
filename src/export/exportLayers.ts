/**
 * 在线浏览器导出时卡片画面的来源,合在一处给合成器用(`frameCompositor.ts` 的 `layers`)。
 *
 *   导出前(`prepareExportLayers`):
 *     快速导出 → 读层表与流清单,定出每条流的满密度分段(`streamFrames.ts`);
 *     定每张卡怎么出(`cardLayers.ts` 的 `planCardLayers`);
 *     有本页不执行、又没被满密度流盖满的卡 → 请渲染节点逐帧渲,等到齐(`exportFrames.ts`)。到齐之前不开始导。
 *   导出中(`at(frame, 挂着包裹层的片段)`):
 *     这一帧每张卡取哪一样(`layerChoiceAt`):流里的这一帧(解码、合成成带透明的图)、渲染节点渲好的这一帧(PNG),
 *     或者不贴(导出页活渲)。回要贴的那几层,合成器照预览一侧的规矩贴进快照。
 *
 * 一次只做一帧,图用完不留;流的解码器一条流一个,顺着帧号往前解。
 */
import type { Project } from "../kernel/project";
import { clipFrameWindow, layerChoiceAt, planCardLayers, type ExportMode, type FrameCoverage, type LayerPlan, type LayerRect } from "./cardLayers";
import { requestExportFrames, type ExportFrameDeps, type ExportFrames, type ExportFramesStatus } from "./exportFrames";
import { loadReadableStreams, StreamFrameReader, type ReadableStream, type StreamFrameDeps } from "./streamFrames";
import { ONLINE_EXPORT_TEXT } from "./text";

/** 合成器要贴的一层 */
export interface FrameLayer {
  clipId: string;
  /** `local`:包裹层自己的坐标系,图放在包裹层里;`stage`:舞台坐标,图放在包裹层旁边、层序同它 */
  plane: "local" | "stage";
  rect: LayerRect;
  /** `data:` 地址(别的地址会污染画布) */
  url: string;
}

export interface FrameLayers {
  /** 导出页只挂包裹层、不挂组件的片段 */
  wrapperOnly: readonly string[];
  /** 这一帧(项目帧号)里,这些挂着包裹层的片段各自要贴的画面;本页活渲的不回 */
  at(frame: number, activeClipIds: readonly string[]): Promise<FrameLayer[]>;
  close(): void;
  readonly stats: ExportLayerStats;
}

export interface ExportLayerStats {
  mode: ExportMode;
  /** 取流的片段数、整段都不活渲的片段数、请渲染节点渲的片段数 */
  streamClips: number;
  wrapperOnly: number;
  nodeClips: number;
  /** 贴了几张:流里取的、渲染节点渲的 */
  streamPictures: number;
  nodePictures: number;
  /** 每个片段各贴了几张(探针核对「这一段取的是流」) */
  perClip: Record<string, { stream: number; frames: number }>;
  streamDecodeMs: number;
  streamBytes: number;
  nodeBytes: number;
  /** 导出前等渲染节点花了多久 */
  waitMs: number;
}

export interface ExportLayerDeps {
  /** 读层表、流清单、流字节 */
  stream: StreamFrameDeps;
  /** 请渲染节点、取它渲好的位图;null = 这个页面请不到(没连着项目) */
  frames: ExportFrameDeps | null;
  /** 文档服务确认的项目版本号(清单计划按它发) */
  projectRev: () => number | null;
}

const statusText = (s: ExportFramesStatus): string => (
  s.phase === "rendering" ? ONLINE_EXPORT_TEXT.renderingNode(s.done, s.total)
    : s.phase === "planning" ? ONLINE_EXPORT_TEXT.planningNode(s.clips)
      : ONLINE_EXPORT_TEXT.waitingNode(s.clips)
);

/** 这个浏览器能不能解轨道流(没有 `VideoDecoder` 的浏览器,快速导出照完整导出的办法出) */
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
    // 层表按项目自己的 id 存(`layers:<project.id>`,渲染节点按它认下的那一版项目写);任务队列按文档服务的项目号(`projectId`)。两个号不一定相同
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
      onStatus: (s) => { try { onWaiting?.(statusText(s)); } catch { /* 宿主坏了不影响等待 */ } },
    });
    stats.waitMs = Date.now() - t0;
    try { onWaiting?.(null); } catch { /* 同上 */ }
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
        // 本页不执行的卡这一帧什么都没有:片段的帧范围之外(包裹层在时间的边界上多挂了一拍)留空;范围之内是清单和核对时不一样了,停下
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

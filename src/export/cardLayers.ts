/**
 * 在线浏览器导出时,哪张卡的哪一帧从哪取画面(语义 `docs/semantics/product/platforms.md`「在线浏览器」的「导出」,用户 2026-10-13 定)。纯算,不取数。
 *
 * 导出页(与编辑页面同源的 `?export=1` 文档)逐帧推时间、每帧生成整场景的快照再栅格化。一张卡这一帧的画面有三个来处:
 *
 *   1. **本页逐帧渲**:导出页里的活组件。本页能运行的卡(构建时就在包里的)在「完整导出」里一律走这条;
 *   2. **轨道流**:只在「快速导出」里用,而且**只取满密度的分段**(只有稀疏版的那一段每 15 帧才换一张,成片里会一卡一卡的)。
 *      取到的那一帧贴在这张卡的包裹层里(单卡流),或贴在舞台坐标、层序取这张卡那一层(依赖下层的流),规矩同预览一侧;
 *   3. **渲染节点逐帧渲的位图**(`exportFrames.ts`;只给这一次导出用):本页不执行的卡(同步来的用户卡与素材效果卡 —— 导出页不执行它们的代码)
 *      没被满密度流盖住的帧。
 *
 * 一张卡的包裹层在导出页里总是挂着(位置、缩放、旋转、不透明度、层序都在包裹层上);整段都不走第 1 条的卡,导出页只挂包裹层、
 * 不挂组件(`wrapperOnly`),省掉活渲这张卡的时间 —— 快速导出快就快在这里。
 *
 * 组流(一条流盖住相邻几张卡)这一版不取:它的成员在快速导出里照没有流办(本页逐帧渲,或渲染节点逐帧渲),画面不受影响。
 */
import { streamSegmentOf, streamSegmentFirstFrame } from "../render/streamSegments.mjs";
import { getCard, isUserCardId, cardRunState } from "../kernel/registry";
import type { Project } from "../kernel/project";

/**
 * 这张卡在此刻是否能在浏览器中运行：
 *   - 构建时在包里的卡（内置卡、内置素材效果卡、仓库卡）：`getCard` 有定义，直接可运行；
 *   - 同步来的用户卡：未同步或非用户卡不可运行；运行状态只有 `ready` 视为可运行；
 *     其它错误状态（`missing-module`, `unsupported-syntax`, `gpu`, `load-error`, `runtime-error`, `not-isolated`, `media`, `disabled`, `loading`）均不可运行。
 */
export function isCardRunnable(cardId: string): boolean {
  if (getCard(cardId)) return true;
  if (!isUserCardId(cardId)) return false;
  const state = cardRunState(cardId)?.state;
  return state === "ready";
}

/**
 * 本页不执行的卡片段:
 * 在线导出在跨源隔离舞台里整帧活渲（user-decisions-2026-10-14 §2.2）：
 * 同步来的用户卡只要在浏览器中就绪（`ready`），就在隔离舞台活渲；
 * 只有真正无法在浏览器执行的卡（语法不支持、缺模块、GPU能力不够、加载/运行时出错、未隔离、媒体格式等，或未就绪/未知卡）
 * 才进入 `nonRunnableClips` 等待渲染节点为导出逐帧渲染位图兜底。
 */
export function nonRunnableClips(p: Project): string[] {
  return p.tracks.flatMap((tr) => tr.clips).filter((c) => !!c.cardId && !isCardRunnable(c.cardId)).map((c) => c.id);
}

export type ExportMode = "fast" | "full";

export interface LayerRect { x: number; y: number; w: number; h: number }

/** 一条可取的流(层表的一行,选定了候选、取齐了清单之后) */
export interface StreamCoverage {
  clipId: string;
  /** `local`:包裹层自己的坐标系;`stage`:舞台坐标(依赖下层的流) */
  plane: "local" | "stage";
  resultKey: string;
  /** 这条流自己的第一帧(项目帧号) */
  originFrame: number;
  /** 满密度的分段号 → 这一段的样本数 */
  dense: ReadonlyMap<number, number>;
}

/** 渲染节点逐帧渲好的位图(导出索引里的一条,清单取齐之后) */
export interface FrameCoverage {
  clipId: string;
  plane: "local" | "stage";
  /** 每张图盖住的矩形(平面坐标) */
  rect: LayerRect;
  /** 有位图的项目帧 */
  frames: ReadonlySet<number>;
}

export interface ClipSpan { id: string; start: number; end: number; cardId?: string }

/** 片段盖住的项目帧 `[first, last]`(与预渲染的采样窗口、`streamInputSig.mjs` 的 `windowOf` 同一个算式;被项目时长截断) */
export function clipFrameWindow(clip: { start: number; end: number }, fps: number, total: number): { first: number; last: number } {
  const start = Number(clip.start) || 0, end = Number(clip.end) || 0;
  const first = Math.max(0, Math.ceil(start * fps - 1e-9));
  const phase = first / fps - start;
  const count = Math.max(1, Math.ceil((end - start - phase) * fps - 1e-9));
  return { first, last: Math.min(total - 1, first + count - 1) };
}

/** 这条流在第 `frame` 帧有没有满密度的画面 */
export function streamCovers(stream: Pick<StreamCoverage, "originFrame" | "dense">, frame: number): boolean {
  if (frame < stream.originFrame) return false;
  const seg = streamSegmentOf(frame, stream.originFrame);
  const samples = stream.dense.get(seg);
  return samples !== undefined && frame - streamSegmentFirstFrame(seg, stream.originFrame) < samples;
}

export interface LayerPlan {
  mode: ExportMode;
  /** 快速导出里取流的片段 → 它的流 */
  streamOf: Map<string, StreamCoverage>;
  /** 导出页只挂包裹层、不挂组件的片段(整段都不由导出页活渲) */
  wrapperOnly: string[];
  /** 要渲染节点逐帧渲的片段(本页不执行、又没被满密度流盖满) */
  needFrames: string[];
  /** 统计:取流的帧数、要渲染节点位图的帧数(按片段累加) */
  streamFrames: number;
  nodeFrames: number;
}

/**
 * 定每张卡怎么出。
 *   - `nonRunnable`:本页不执行的卡片段(导出页里没有它们的代码);
 *   - `streams`:可取的流(只在快速导出里看;一个片段有几条时取满密度分段最多的那一条)。
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
 * 这张卡这一帧取哪一样。`missing`:本页不执行的卡这一帧既没有满密度流、也没有渲染节点的位图(导出前的核对应当已经拦下;
 * 走到这里说明清单和核对时不一样了,调用方按错误处理,不出半截的画面)。
 */
export function layerChoiceAt(plan: LayerPlan, clipId: string, frame: number, frames: ReadonlyMap<string, FrameCoverage>, nonRunnable: ReadonlySet<string>): LayerChoice {
  const stream = plan.streamOf.get(clipId);
  if (stream && streamCovers(stream, frame)) return { from: "stream", stream };
  if (!nonRunnable.has(clipId)) return { from: "live" };
  const got = frames.get(clipId);
  if (got && got.frames.has(frame)) return { from: "frames", frames: got };
  return { from: "missing" };
}

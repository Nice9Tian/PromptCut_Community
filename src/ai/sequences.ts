import type { Shots, Transcript, TransitionKind } from "../kernel/project";

/**
 * see_frames 素材模式(source: "media")的纯逻辑:把镜头划分变成「要看哪几个镜头、分几页、每张拼图抽哪几帧」。
 * 不碰网络、不碰 store,node 里直接单测(sequences.test.mjs)。拼图本身由服务端 ffmpeg 生成
 * (server/vite-plugin-vision.ts 的 /api/vision/sheet),这里只算规划。
 */

export interface SceneSpec {
  /** 从 1 起的镜头序号,和 list_shots 的顺序一致 */
  index: number;
  start: number;
  end: number;
  inTransition: TransitionKind | null;
  outTransition: TransitionKind | null;
}

export interface SequencesPlan {
  scenes: SceneSpec[];
  page: number;
  pages: number;
  perPage: number;
  grid: 4 | 9;
  /** 筛选(from / to / scene)之后有多少个镜头 */
  matched: number;
  totalScenes: number;
  nextPage: number | null;
  prevPage: number | null;
}

export const DEFAULT_PER_PAGE = 6;
export const MAX_PER_PAGE = 12;
/** 没跑镜头识别(或识别失败)时按固定间隔切段 */
export const FALLBACK_STEP_SEC = 10;
/** 抽帧从镜头起点往后挪一点点,避开正卡在转场上的那一帧 */
export const FRAME_EPS = 0.05;

/** 镜头识别结果 → 镜头清单;没有结果就按固定间隔切,并标 fallback */
export function scenesOf(shots: Shots | null | undefined, durationSec: number, step = FALLBACK_STEP_SEC): { scenes: SceneSpec[]; fallback?: "fixed-interval" } {
  if (shots?.shots?.length) {
    return {
      scenes: shots.shots.map((s, i) => ({ index: i + 1, start: s.start, end: s.end, inTransition: s.inTransition ?? null, outTransition: s.outTransition ?? null })),
    };
  }
  const total = Math.max(0, Number(durationSec) || 0);
  const scenes: SceneSpec[] = [];
  if (total <= 0) return { scenes, fallback: "fixed-interval" };
  const n = Math.max(1, Math.ceil(total / step));
  for (let i = 0; i < n; i++) {
    const start = i * step;
    scenes.push({ index: i + 1, start, end: Math.min(total, start + step), inTransition: null, outTransition: null });
  }
  return { scenes, fallback: "fixed-interval" };
}

export interface PlanOptions {
  page?: number;
  perPage?: number;
  grid?: number;
  scene?: number;
  from?: number;
  to?: number;
}

/** 筛选 + 分页。scene 指定了就只看那一个(默认 9 格),忽略分页 */
export function planSequences(all: SceneSpec[], opts: PlanOptions = {}): SequencesPlan {
  const totalScenes = all.length;
  if (opts.scene !== undefined) {
    const n = Number(opts.scene);
    if (!Number.isInteger(n) || n < 1 || n > totalScenes) throw new Error(`scene 要在 1~${totalScenes} 之间,收到 ${JSON.stringify(opts.scene)}`);
    const grid = opts.grid === 4 ? 4 : 9;
    return { scenes: [all[n - 1]], page: 1, pages: 1, perPage: 1, grid, matched: 1, totalScenes, nextPage: null, prevPage: null };
  }
  const from = opts.from !== undefined ? Number(opts.from) : -Infinity;
  const to = opts.to !== undefined ? Number(opts.to) : Infinity;
  if (opts.from !== undefined && !Number.isFinite(from)) throw new Error("from 要是秒数");
  if (opts.to !== undefined && !Number.isFinite(to)) throw new Error("to 要是秒数");
  if (from > to) throw new Error("from 不能大于 to");
  // 和区间有交集的镜头都算(用户说「看 30 秒到 60 秒」,跨在 30 秒上的那个镜头也该看)
  const matched = all.filter((s) => s.end > from && s.start < to);
  const perPage = Math.max(1, Math.min(MAX_PER_PAGE, Math.round(Number(opts.perPage) || DEFAULT_PER_PAGE)));
  const grid: 4 | 9 = opts.grid === 9 ? 9 : 4;
  const pages = Math.max(1, Math.ceil(matched.length / perPage));
  const page = Math.max(1, Math.min(pages, Math.round(Number(opts.page) || 1)));
  const scenes = matched.slice((page - 1) * perPage, page * perPage);
  return {
    scenes, page, pages, perPage, grid, matched: matched.length, totalScenes,
    nextPage: page < pages ? page + 1 : null,
    prevPage: page > 1 ? page - 1 : null,
  };
}

/** 一个镜头抽哪几帧(秒):等间隔,起点略往后挪;和服务端 ffmpeg 的 fps 滤镜取法一致 */
export function frameTimes(start: number, end: number, grid: number): number[] {
  const dur = Math.max(0, end - start - FRAME_EPS);
  const n = Math.max(1, grid | 0);
  const out: number[] = [];
  for (let k = 0; k < n; k++) out.push(Math.round((start + FRAME_EPS + (dur * k) / n) * 100) / 100);
  return out;
}

/** 这段时间里的字幕文本(有转写才有);和区间有交集的段都算 */
export function transcriptFor(transcript: Transcript | null | undefined, start: number, end: number): string {
  if (!transcript?.segments?.length) return "";
  return transcript.segments
    .filter((s) => s.end > start && s.start < end)
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(" ");
}

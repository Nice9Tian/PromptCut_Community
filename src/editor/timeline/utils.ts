// 只当类型用 —— 写成 import type,node 的类型剥离会把整行抹掉,单测就不用去解析
// 那个没写扩展名的路径了(否则 node --test 直接 ERR_MODULE_NOT_FOUND)
import type { Project, Track } from "../../kernel/project";
// 带 .ts 后缀:单测用 node --test 直接跑源码,不写后缀它解析不到(仓库里已有这种写法)
import { atFrameGrid } from "../../render/frameGrid.ts";

/** 轨道行高配置 */
export type RowSize = "small" | "medium" | "large";
export const ROW_SIZE_H: Record<RowSize, number> = {
  small: 28,
  medium: 44,
  large: 72,
};
export const DEFAULT_ROW_SIZE: RowSize = "medium";

/** 左侧行头列宽(px)配置 */
export const HEADER_W_DEFAULT = 180;
export const HEADER_W_MIN = 120;
export const HEADER_W_MAX = 420;

/** 内容层右边的拖动余量(px) */
export const TAIL_SLACK_PX = 200;

/**
 * 可见内容的末尾。播放范围的上界就是它 —— 空无一物的地方不该能播,拖到那里也只会
 * 看到黑屏。规则本身在 kernel/duration.ts。
 */
export { contentEndOf } from "../../kernel/duration.ts";

/**
 * 可见内容的开头:最早一个片段的开始时间。没有任何片段就是 0。
 * 播放从这里开始 —— 播放范围是「最早的卡片 ~ 最晚的卡片」。
 */
export function contentStartOf(tracks: Track[]): number {
  let start = Infinity;
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.start < start) start = clip.start;
    }
  }
  return Number.isFinite(start) ? Math.max(0, start) : 0;
}

/**
 * 0 秒前面留的一点间距(px,和缩放无关)。纯粹是留白,不代表时间——时间没有负数。
 * 有它 0 秒的片段和播放头才不会贴死在行头上。
 */
export const GUTTER_PX = 24;

/** 时间 ↔ 内容层像素。所有换算都走这两个函数,不要再直接乘 pxPerSec。 */
export function xOfTime(t: number, pxPerSec: number): number {
  return GUTTER_PX + t * pxPerSec;
}

export function timeOfX(x: number, pxPerSec: number): number {
  return (x - GUTTER_PX) / pxPerSec;
}

export function isOccupied(track: Track, clipId: string, start: number, end: number) {
  return track.clips.some(
    (c) => c.id !== clipId && Math.max(start, c.start) < Math.min(end, c.end)
  );
}

export function getGap(track: Track, clipId: string, projectDuration: number) {
  const others = track.clips.filter((c) => c.id !== clipId);
  const currentClip = track.clips.find(c => c.id === clipId);
  if (!currentClip) return { start: 0, end: projectDuration };
  
  let gapStart = 0;
  let gapEnd = projectDuration;
  
  for (const c of others) {
    if (c.end <= currentClip.start) gapStart = Math.max(gapStart, c.end);
    if (c.start >= currentClip.end) gapEnd = Math.min(gapEnd, c.start);
  }
  return { start: gapStart, end: gapEnd };
}

export function snapTime(
  time: number,
  altKey: boolean,
  project: Project,
  t: number,
  ignoreClipId?: string,
  pxPerSec: number = 100
) {
  /*
   * **一律落到帧格上**,alt 也不例外。
   *
   * alt 的意思是「别吸到别的片段和整秒上」,不是「可以停在成片里不存在的时刻」——
   * 成片逐帧渲,一条 4.041s 开始的片段在成片里其实从第 122 帧(4.0667s)开始。
   *
   * 这不只是不好看:三维视图的预渲染时刻是按**片段起点**排格子的,导出渲的是**全局帧格**,
   * 起点不在帧格上两套格子就对不齐,而且不是一一对应 —— 实测起点 4.041 时,播放头
   * 第 121 / 122 / 123 帧拿到的预渲染帧是 121 / 121 / 122,三维比二维整整慢一帧,不报错。
   */
  const grid = (v: number) => atFrameGrid(v, project.fps || 30);
  if (altKey) return grid(time);
  const threshold = 10 / pxPerSec; // snap within 10 pixels
  const snapPoints = [0, t];
  const maxSec = Math.max(project.duration, time + 10);
  for (let i = 1; i <= Math.ceil(maxSec); i++) snapPoints.push(i);
  for (const track of project.tracks) {
    if (track.hidden) continue;
    for (const c of track.clips) {
      if (c.id === ignoreClipId) continue;
      snapPoints.push(c.start, c.end);
    }
  }
  let best = time;
  let minDiff = threshold;
  for (const p of snapPoints) {
    const diff = Math.abs(p - time);
    if (diff < minDiff) {
      best = p;
      minDiff = diff;
    }
  }
  return grid(best);
}

export function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${m}:${s.toString().padStart(2, "0")}.${ms}`;
}

import { mountFrameOf } from './frameWindow.mjs';
import { clipFrameSpan } from './shardPlan.mjs';

/**
 * C4 的选帧规则,做成纯函数:浏览器(父页按层选快照)和 Node(预渲染进程排优先级、
 * 端到端探针)共用同一份,两端选出来的一定是同一帧。
 *
 * 规则三句话:
 *
 * 1. **按层各自回溯**:每一层(片段 × 档位)查自己那张区间表,选 ≤ 目标本地帧的
 *    最大就绪帧;
 * 2. **同区间内回溯,不跨区间**:这里的「区间」是**锚帧切出的段**
 *    (C1 末句:锚帧集合 = 每个片段的 `mountFrameOf`、`clipFrameSpan` 的 `last + 1`、
 *    第 0 帧),不是就绪表里的闭区间。跨过一个锚帧去拿更早的快照,画面会突然
 *    回到上一段的状态 —— 宁可这一层透明;
 * 3. **不等待**:选不出来就回 null,那一层这一拍透明,播放头不停(总规则)。
 *
 * 冷缓存的表现就是由第 2 条决定的:C2 先产锚帧,所以拖到第 1000 帧时该层就绪的
 * 往往只有段起点那一帧 —— 选出来的正是**区间起点快照**,而不是一张更早的、
 * 属于上一段的快照,也不是空白。
 */

/** 就绪表(闭区间、已合并有序)里 ≤ frame 的最大就绪帧;没有就 null。二分。 */
export function latestReadyAtOrBefore(ranges, frame) {
  if (!Array.isArray(ranges) || !ranges.length || !Number.isInteger(frame) || frame < 0) return null;
  let lo = 0, hi = ranges.length - 1, found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [from, to] = ranges[mid];
    if (from > frame) { hi = mid - 1; continue; }
    // 落在这一段里就是它本身;整段都在左边就记下段尾,继续往右找更近的
    found = frame <= to ? frame : to;
    lo = mid + 1;
  }
  return found;
}

/**
 * 锚帧集合(全局帧号,升序去重)。C1 末句的三项:
 * 每个片段的 `mountFrameOf`、`clipFrameSpan` 的 `last + 1`、第 0 帧。
 *
 * `clips` 是**全部**片段(不只这一层那一张卡):别的片段挂载 / 退场同样会让
 * 下层依赖卡的画面换一段,所以段边界是全局的。
 */
export function anchorFrames(clips, fps) {
  if (!(fps > 0)) return [0];
  const anchors = new Set([0]);
  for (const clip of clips ?? []) {
    if (!Number.isFinite(clip?.start) || !Number.isFinite(clip?.end)) continue;
    anchors.add(mountFrameOf(clip, fps));
    const span = clipFrameSpan(clip, fps);
    if (span) anchors.add(span[1] + 1);
  }
  return [...anchors].filter(n => Number.isInteger(n) && n >= 0).sort((a, b) => a - b);
}

/** 锚帧切出的段里,`frame` 所在那一段的起点(≤ frame 的最大锚帧;一个都没有就 0)。 */
export function segmentStartOf(anchors, frame) {
  let start = 0;
  for (const anchor of anchors ?? []) {
    if (anchor > frame) break;
    start = anchor;
  }
  return start;
}

/**
 * 一层的选帧。全部用**本地帧**口径(`localFrame = globalFrame - firstFrame`);
 * `segmentStart` 也是本地帧,由调用方把全局段起点换算过来并夹到 0。
 *
 * 返回选中的本地帧,或 null(这一层这一拍透明)。
 */
export function pickSnapshotFrame({ ranges, localFrame, segmentStart = 0 }) {
  if (!Number.isInteger(localFrame) || localFrame < 0) return null;
  const hit = latestReadyAtOrBefore(ranges, localFrame);
  if (hit === null) return null;
  // 不跨区间:段起点之前的快照属于上一段,宁可透明
  return hit >= Math.max(0, segmentStart) ? hit : null;
}

/**
 * 把一个全局帧换成某一层的本地帧,并算出该层这一段的起点(本地帧口径)。
 * `firstFrame` = `control.sampling.firstFrame`(`card-cache.mjs:109` 的现成公式)。
 */
export function localWindowOf({ globalFrame, firstFrame = 0, count = Infinity, anchors = [] }) {
  const localFrame = globalFrame - firstFrame;
  if (!Number.isInteger(localFrame) || localFrame < 0 || localFrame >= count) return null;
  const segmentStart = Math.max(0, segmentStartOf(anchors, globalFrame) - firstFrame);
  return { localFrame, segmentStart };
}

/**
 * 父页每帧对一层的完整查询:索引里这一层的 `{ key, ranges }` + 该层的采样信息
 * → `{ kind, key, localFrame }` 或 null。C4 的「换 DOM 有节流」「投递基线」
 * 都是消费方(R5)的事,这里只回答「此刻该贴哪一帧」。
 */
export function pickLayerSnapshot({ layer, globalFrame, firstFrame = 0, count = Infinity, anchors = [] }) {
  if (!layer?.key) return null;
  const window = localWindowOf({ globalFrame, firstFrame, count, anchors });
  if (!window) return null;
  const localFrame = pickSnapshotFrame({ ranges: layer.ranges, localFrame: window.localFrame, segmentStart: window.segmentStart });
  return localFrame === null ? null : { kind: layer.kind, key: layer.key, localFrame };
}

/**
 * 项目总时长的规则(`docs/semantics/product/project-model.md`「总时长」):
 * 缺省等于内容末尾,跟着内容走;可以手动缩短(截断),不能拉长到内容末尾之后;
 * 空项目保留原值。
 *
 * 手动值不落盘,只活在编辑器状态里(`durationManual`),换项目、切剪辑就清掉。
 */
import type { Track } from "./project.ts";

/** 可见内容的末尾:最后一个片段的结束时间。没有任何片段就是 0。 */
export function contentEndOf(tracks: Track[]): number {
  let end = 0;
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.end > end) end = clip.end;
    }
  }
  return end;
}

/**
 * 这一刻项目的总时长应该是多少。
 * `manual` 是手动截断到的秒数,`null` = 没截断、跟内容走。
 */
export function effectiveDuration(contentEnd: number, current: number, manual: number | null): number {
  // 空项目没有内容可依,保留文档里那个值,不然时间轴会塌成 0 宽没法往里拖东西。
  if (contentEnd <= 0) return current;
  return manual === null ? contentEnd : Math.min(manual, contentEnd);
}

/**
 * 有人(用户或 Agent)要把总时长设成 `requested` 秒,该记下的手动值。
 * 比内容末尾短才算截断;等于或长于内容末尾就回到跟内容走(拉不长,也不该留下一个
 * 会在以后挡住新内容的上限)。空项目同理:原值照设,之后加内容照常跟着走。
 */
export function manualDurationFor(requested: number, contentEnd: number): number | null {
  return contentEnd > 0 && requested < contentEnd ? requested : null;
}

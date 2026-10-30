/**
 * 「播放范围跟着可见内容走」的同步点:内容末尾变了(挪、拉长、删掉最后一段),把总时长对上
 * (`effectiveDuration`,手动截断的上限照旧)。时间轴挂着的时候才做,和以前时间轴里那个 effect 一样。
 *
 * # 为什么不再只靠渲染后的 effect(tiers-probe T4,docs/archive/agent-reports/AGENT-perf-t4.md)
 *
 * 以前是 `TimelineInner` 渲染完在 effect 里 `syncDuration`:挪最后一段 → 整个编辑器按新片段渲一遍 →
 * effect 发现时长不对 → 再改一次项目 → **整个编辑器在同一个任务里又渲一遍**。一次编辑两遍全量重渲,
 * 在笔记本上后台转码、上传一抢 CPU,这个任务就过了 50 ms。
 *
 * 现在在 store 上挂一个监听:项目一变就排一个微任务去对时长。监听在模块加载时就挂上,排在所有 React
 * 组件的订阅前面,所以这个微任务排在 React 刷新渲染的那个微任务前面 —— 对完时长才渲,一次编辑只渲一遍。
 * 放在微任务里而不是监听里当场改:别人的改动经 docsync 写进 store 时监听就在它的调用栈里,
 * 当场再提交一次等于在 docsync 自己的回调里重入;挪到微任务里就和以前的 effect 一样在栈外。
 * 顺序不成立时(同一任务里别处先排了渲染)退回以前的效果:先渲一遍,对完时长再渲一遍,不会更差。
 * `TimelineInner` 里那个 effect 留着兜底,渲完还不对就照以前那样补。
 */
import { useEffect } from "react";
import { actions, getState, subscribe } from "../../store/project";
import { contentEndOf, effectiveDuration } from "../../kernel/duration";
import type { Track } from "../../kernel/project";
import { isRecoveringAssociation } from "../sync/recoveryAssociation";
import { memberReadOnlyNow } from "../readOnlyCore";

let mounted = 0;
let queued = false;
/** 上一次对过的三样:都没换对象就不用再对 */
let seen: { tracks: Track[]; duration: number; manual: number | null } | null = null;

/** 这一刻内容末尾对应的总时长和项目里记的不一样,就改过来(不进撤销栈,和以前一样) */
export function syncDurationNow(): void {
  queued = false;
  // 只读项目(游客):总时长是项目里的字段,这一下是个写,服务端要拒;看别人的项目时也别自己去改它
  if (mounted === 0 || isRecoveringAssociation() || memberReadOnlyNow()) return;
  const s = getState();
  const tracks = s.project.tracks;
  const duration = s.project.duration;
  const manual = s.durationManual;
  if (seen && seen.tracks === tracks && seen.duration === duration && seen.manual === manual) return;
  seen = { tracks, duration, manual };
  const target = effectiveDuration(contentEndOf(tracks), duration, manual);
  if (Math.abs(target - duration) > 1e-6) actions.syncDuration(target);
}

subscribe(() => {
  if (mounted === 0 || queued) return;
  queued = true;
  queueMicrotask(syncDurationNow);
});

/** 开始跟(可以叠加);返回停止的函数 */
export function mountDurationSync(): () => void {
  mounted++;
  seen = null;
  syncDurationNow();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    mounted--;
  };
}

/** 时间轴挂着期间让总时长跟着内容走 */
export function useDurationFollowsContent(): void {
  useEffect(() => mountDurationSync(), []);
}

/** 测试用 */
export function resetDurationSync(): void {
  mounted = 0;
  queued = false;
  seen = null;
}

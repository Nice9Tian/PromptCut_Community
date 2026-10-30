import { useMemo, useSyncExternalStore } from "react";
import { useTimelineContext } from "./TimelineContext";
import { useStore } from "../../store/project";
import { useScrub } from "./useScrub";
import {
  clipFingerprint, getCoverage, idleSpans, mergeSegments, subscribeCoverage, visibleCoverage,
  type CoverageSegment,
} from "../preview/bakeCoverage";
import { xOfTime } from "./utils";

/** 进度条高度(px)。够看见、又不抢时间轴的地方 */
export const RENDER_H = 2;

/**
 * 预渲染进度条(AE 顶上那条)。就是时间标尺(Ruler)的底边线。
 *
 * # 两种颜色说的是两件事
 *
 * **黄 = 低帧率那一档已经有了。** 拖过去立刻有画面,但看到的那一刻最多和播放头差 0.25 秒。
 * 这一档先把整条片子铺满 —— 成本只有原始帧率的零头。
 *
 * **绿 = 原始帧率那一档也有了。** 那一段是逐帧精确的。低帧率全部铺完之后才开始渲它。
 *
 * **空白 = 什么都没有,拖过去要等它现场渲染(一张约 4 秒)。**
 *
 * # 改了一张卡,它那一段**当帧**就变白
 *
 * 覆盖是**按卡**存的,每条带着那张卡当时的内容指纹(见 bakeCoverage 的 ClipCoverage)。
 * 这里每次渲染都拿**当前项目**的指纹对一遍,对不上的直接不画。
 *
 * 所以「改完卡片条子立刻变白」不依赖任何异步:用户一改参数,store 里的 project 就换了,
 * 这个组件这一帧就把那张卡抹掉了 —— 不等盘点、不等预渲染,也不可能有竞态。
 *
 * 之前不是这样:覆盖是所有卡合成一整条存的,**只有预渲染循环能更新它**,而那个循环得先把
 * 手上这批渲完、再盘点一次才轮得到发布。于是改完卡片条子纹丝不动,看起来像被预渲染卡住了。
 * 那是结构问题,不是时序没调好 —— 所以这次改的是结构。
 *
 * # 画法上的两条硬要求
 *
 * 1. **画的是真实覆盖的时间段,不是百分比。** 一个预渲染好的时刻覆盖到同一张卡的下一个时刻为止。
 *    百分比进度条做不到这件事 —— 它能显示 90%,而用户偏偏拖到剩下那 10% 里,一样干等。
 * 2. **宁可少画不能多画。** 多画一格就是骗人:那儿明明要等五秒,条却是有色的。
 */
export function RenderBar() {
  const { pxPerSec } = useTimelineContext();
  const project = useStore((s) => s.project);
  const duration = useStore((s) => Math.max(s.project.duration, s.t + 10));
  const startScrub = useScrub();
  /*
   * 订阅模块级仓库。用 useSyncExternalStore 而不是自己 useState + useEffect:
   * 它保证并发渲染下读到的值和订阅到的是同一份,不会出现"画面用的是旧值"。
   */
  const cov = useSyncExternalStore(subscribeCoverage, getCoverage, getCoverage);

  /**
   * 当前项目里每张卡长什么样、现在待在哪儿。指纹 → 当前起点。
   *
   * 指纹变了 → 那张卡的覆盖当帧作废(改参数、剪长短、换画幅)。
   * 指纹没变但起点变了 → 覆盖跟着平移(挪位置不改像素,预渲染好的图还能用)。两条都在 visibleCoverage 里。
   */
  const liveFps = useMemo(() => {
    const map = new Map<string, number>();
    for (const tr of project?.tracks ?? []) for (const c of tr.clips ?? []) map.set(clipFingerprint(c), c.start);
    return map;
  }, [project]);

  // 过滤 + 合并的逻辑放在 bakeCoverage 里(纯函数,有单测钉着这条行为)
  const shown = useMemo(() => visibleCoverage(cov, liveFps), [cov, liveFps]);

  /**
   * 「本来就没东西要渲」的那几段,和渲好的一样涂上色。
   *
   * 空白的几秒、素材段(视频 / 图片本来就是位图,`bakeTarget` 会直接拒绝预渲染)、
   * scene-3d(在 3D 视图里是真几何,不需要贴图)—— 拖过去立刻就是它该有的样子。
   * 按条子的契约("绿的地方拖过去一定立刻有画面")它们就该是绿的。
   *
   * 不这么画的话,一条全部渲完的片子上永远留着几块白,用户没法把「还没渲」和
   * 「本来就没东西」分开,看上去就是预渲染一直卡在那儿不动。
   */
  const idle = useMemo(() => {
    const busy: { start: number; end: number }[] = [];
    for (const tr of project?.tracks ?? []) {
      for (const c of tr.clips ?? []) {
        if ((c as any).mediaId || c.cardId === "scene-3d") continue; // 这两类不用渲
        busy.push({ start: c.start, end: c.end });
      }
    }
    return idleSpans(busy, project?.duration ?? 0);
  }, [project]);

  const x0 = xOfTime(0, pxPerSec);
  const width = Math.max(0, xOfTime(duration, pxPerSec) - x0);

  const band = (segs: CoverageSegment[], cls: string) =>
    segs.map((seg, i) => {
      const left = xOfTime(seg.start, pxPerSec);
      const w = xOfTime(seg.end, pxPerSec) - left;
      // 缩得很小时一段可能不足 1px。给它兜个底,不然整条看着像没渲
      if (w <= 0) return null;
      return <div key={`${cls}-${seg.start}-${i}`} className={cls} style={{ left, width: Math.max(1, w) }} />;
    });

  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
  const title = shown.coarseTotal === 0
    ? "预渲染:还没开始。切到预览面板的「3D」页会在空闲时自动预渲染"
    : [
        `低帧率(黄)${shown.coarseBaked}/${shown.coarseTotal}(${pct(shown.coarseBaked, shown.coarseTotal)}%)—— 拖过去立刻有画面,最多差 0.25 秒`,
        `原始帧率(绿)${shown.fullBaked}/${shown.fullTotal}(${pct(shown.fullBaked, shown.fullTotal)}%)—— 逐帧精确`,
        `空白 = 要等它现场渲染(一张约 4 秒)。已占 ${(cov.bytes / 1048576).toFixed(1)}MB`,
        ...(shown.stale ? [`${shown.stale} 张卡刚改过,它们那几段已作废,正在重新预渲染`] : []),
      ].join("\n");

  return (
    <div
      data-pc="render-bar"
      className="pc-tl-renderbar relative overflow-hidden select-none touch-none cursor-ew-resize"
      style={{ height: RENDER_H }}
      // 和标尺一样能拖播放头:它紧贴在标尺下面,点到这几个像素上却没反应会让人以为界面卡了
      onPointerDown={(e) => startScrub(e, { jumpToPointer: true })}
      title={title}
    >
      {/* 底槽:整条片子的长度,标出"还有多少没预渲染" */}
      <div className="pc-tl-renderbar-track absolute top-0 bottom-0" style={{ left: x0, width }} />
      {/* 先铺黄的(低帧率),再把绿的(原始帧率)盖在上面 —— 绿的一定落在黄的之内 */}
      {band(mergeSegments([...shown.coarse, ...idle]), "pc-tl-renderbar-coarse absolute top-0 bottom-0")}
      {band(mergeSegments([...shown.full, ...idle]), "pc-tl-renderbar-done absolute top-0 bottom-0")}
      {/*
        正在渲的那一刻单独标一下。它还没进任何一档的覆盖(还没渲完),
        但用户看得见"进度正卡在这儿",而不是对着一条不动的条猜是不是死了。
      */}
      {cov.bakingAt !== null && (
        <div
          className="pc-tl-renderbar-now absolute top-0 bottom-0"
          style={{ left: xOfTime(cov.bakingAt, pxPerSec) }}
        />
      )}
    </div>
  );
}

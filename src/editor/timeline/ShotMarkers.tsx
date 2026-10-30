/**
 * 时间轴上的镜头切换标记。
 *
 * 硬切画一条竖线加一张缩略图（切换之后的画面）；溶解画成一段区间，把渐变前后
 * 两个镜头的缩略图**叠着画**——画面正在交融这件事，用两张叠图比任何文字都直观。
 *
 * 位置换算要经过 mediaOffset：片段可能只截取了素材中间一段，素材里 T 秒发生的
 * 转场，在时间轴上是 clip.start + (T - mediaOffset) / speed（片段速度，见 kernel/clipTime.mjs）。
 */
import { useStore } from "../../store/project";
import type { ShotTransition, TrackClip } from "../../kernel/project";
import { mediaSpanOf, timelineSpanOf } from "../../kernel/clipTime.mjs";
import { useTimelineContext } from "./TimelineContext";

/** 缩略图太小就看不清，太大又盖住片段本身，行高不够时干脆只留竖线 */
const THUMB_MIN_ROW_H = 40;

/**
 * 在线构建的编译期常量(写法与用意见 `src/online/pageFlag.ts` 的「在线构建剪枝」)。缩略图在编辑器进程的镜头检测目录里,
 * 在线页面只画竖线;两个标记里再判一次,在线构建里连同 `/api/shots/thumb/` 地址一起剪掉(M8 遗留 L24)。
 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

export function ShotMarkers({ clip, rowHeight }: { clip: TrackClip; rowHeight: number }) {
  const { pxPerSec } = useTimelineContext();
  const media = useStore((s) =>
    clip.mediaId ? s.project.media.find((m) => m.id === clip.mediaId) : undefined,
  );

  const transitions = media?.shots?.transitions;
  if (!transitions?.length) return null;

  const offset = clip.mediaOffset ?? 0;
  const visibleFrom = offset;
  const visibleTo = offset + mediaSpanOf(clip);
  // 缩略图在编辑器进程的镜头检测目录里(`/api/shots/thumb/`);在线页面没有编辑器进程,只画竖线,不发请求(C10 契约第 10 节)
  const showThumbs = !ONLINE_BUILD && rowHeight >= THUMB_MIN_ROW_H;

  return (
    <div className="pc-shot-layer" aria-hidden>
      {transitions.map((t, i) => {
        // 只画落在这个片段可见范围内的转场
        if (t.end < visibleFrom || t.start > visibleTo) return null;
        const left = timelineSpanOf(clip, t.start - offset) * pxPerSec;
        const width = Math.max(1, timelineSpanOf(clip, t.end - t.start) * pxPerSec);
        return t.kind === "dissolve"
          ? <DissolveMark key={i} t={t} left={left} width={width} showThumbs={showThumbs} />
          : <CutMark key={i} t={t} left={left} showThumbs={showThumbs} />;
      })}
    </div>
  );
}

/**
 * 缩略图不能用 loading="lazy"。
 *
 * 它们在 overflow:hidden 的标记层里，CSS 又是 height 固定、width:auto ——
 * 没加载出来就没有固有尺寸，宽度算出来是 0；浏览器看到零面积元素就判定它不可见，
 * 于是不加载；不加载就永远没有尺寸。死循环，图一张也出不来（实测如此）。
 * 给上 width/height 属性让浏览器先按 16:9 预留位置，并且立即加载——每张才 2 KB。
 */
function thumbUrl(name: string): string {
  return `/api/shots/thumb/${encodeURIComponent(name)}`;
}

function CutMark({ t, left, showThumbs }: { t: ShotTransition; left: number; showThumbs: boolean }) {
  const thumb = t.thumbs?.[0];
  return (
    <div className="pc-shot-cut" style={{ left }} title={`硬切 ${t.time.toFixed(2)}s`}>
      <div className="pc-shot-line" />
      {!ONLINE_BUILD && showThumbs && thumb && (
        // 和溶解用同一个 .pc-shot-stack 包一层:标记本身宽度是 0(它就是一条线),
        // 绝对定位的 img 拿零宽包含块算 width:auto 会得到 0。包一层有宽度的容器、
        // 让 img 静态定位，它才会按自身宽高比撑开。
        <span className="pc-shot-stack pc-shot-stack--cut">
          <img className="pc-shot-thumb" src={thumbUrl(thumb)} alt="" draggable={false} width={160} height={90} />
        </span>
      )}
    </div>
  );
}

function DissolveMark(
  { t, left, width, showThumbs }: { t: ShotTransition; left: number; width: number; showThumbs: boolean },
) {
  const [a, b] = t.thumbs ?? [];
  return (
    <div
      className="pc-shot-dissolve"
      style={{ left, width }}
      title={`溶解 ${t.start.toFixed(2)}~${t.end.toFixed(2)}s`}
    >
      {/* 渐变的两端各一条细线，中间一层薄底表示「这一段在交融」 */}
      <div className="pc-shot-line pc-shot-line--start" />
      <div className="pc-shot-line pc-shot-line--end" />
      {!ONLINE_BUILD && showThumbs && a && (
        <span className="pc-shot-stack">
          <img className="pc-shot-thumb" src={thumbUrl(a)} alt="" draggable={false} width={160} height={90} />
          {b && (
            // 后一张压在前一张上、半透明，就是「两张叠画」
            <img className="pc-shot-thumb pc-shot-thumb--over" src={thumbUrl(b)} alt="" draggable={false} width={160} height={90} />
          )}
        </span>
      )}
    </div>
  );
}

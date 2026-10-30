import type { ReactNode } from "react";
import { setRailCollapsed } from "../sideRails";
import { useDockSide } from "../dock/dockSide";

/**
 * 左栏五个分区统一的头部:标题行(分区名 +「收起面板」)+ 下面分区自己的主按钮 / 搜索 / 胶囊(children)。
 *
 * 分区可以被拖到右侧 rail(dock/),收起钮跟着所在的一侧走:
 * 在左侧放右上角、收左侧(`data-pc="left-collapse"`);在右侧放左上角、收右侧(`data-pc="right-collapse"`)。
 * 收起钮和「再点一次 rail 上的当前项」走同一条路(sideRails):Editor.tsx 的列宽过渡、卡片的淡出都照旧,
 * 这里不自己做动画。收起后 rail 还在,点当前项就展开回来。
 */
export function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  const side = useDockSide("left");
  const collapse = (
    <button
      type="button"
      className="pc-icon-btn pc-left-collapse"
      data-pc={`${side}-collapse`}
      title="收起面板"
      aria-label="收起面板"
      onClick={() => setRailCollapsed(side, true)}
    >
      {/* 面板轮廓 + 贴着 rail 那一边的侧栏线 + 朝 rail 的箭头:往那一侧收 */}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
        {side === "left" ? (
          <>
            <path d="M9 4.5v15" />
            <path d="M16 9.5 13.5 12l2.5 2.5" />
          </>
        ) : (
          <>
            <path d="M15 4.5v15" />
            <path d="M8 9.5 10.5 12 8 14.5" />
          </>
        )}
      </svg>
    </button>
  );
  return (
    <div className="pc-left-head">
      <div className={`pc-left-titlerow${side === "right" ? " is-right" : ""}`}>
        {side === "right" && collapse}
        <div className="pc-section-title">{title}</div>
        {side === "left" && collapse}
      </div>
      {children}
    </div>
  );
}

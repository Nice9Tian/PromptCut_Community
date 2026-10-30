import "./debug";
import "./left.css";
import { DockHost } from "../dock/DockHost";
import { RailBar } from "../dock/RailBar";

/**
 * 左栏 = 左侧 rail + 左侧宿主卡片(侧边自由布局,见 src/editor/dock/)。
 *
 *   rail   默认是 素材库 / 动画 / 特效 / 编辑 / 字幕,但 rail 上的任何一项(含剧本、Agent 分页)都能拖来拖去,
 *          项的位置和选中项在 dock/railStore.ts(`pc.rail.layout.v1`)。
 *          点另一项 = 切过去(收起着就顺手展开);点当前已选中项 = 收起 / 展开抽屉(sideRails)。
 *   抽屉   只是宿主(DockHost):显示这一侧当前选中项的页面。页面本身统一在 dock/DockPages.tsx 里各渲染一次,
 *          常驻挂载 —— 切来切去、拖到另一侧都不丢滚动位置、搜索词和草稿。
 *          收起时整块 display:none,整列宽度由 Editor.tsx 按 sideRails 算。
 *
 * 分区被选中时仍记一份 localStorage `pc.left.section`(scripts/left-check.mjs 读它)。
 * 时间轴 / 素材库右键「转写字幕」走 captionsBus:激活字幕分区所在的那一侧、展开、聚焦那份素材(DockPages 里接)。
 */
export function LeftPanel() {
  return (
    <div data-pc="left" className="pc-left">
      <RailBar side="left" />
      <DockHost side="left" />
    </div>
  );
}

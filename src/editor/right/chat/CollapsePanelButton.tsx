import { setRailCollapsed } from "../../sideRails";
import { useDockSide } from "../../dock/dockSide";
import type { Side } from "../../dock/railLayout";
import "./chat.css";

/**
 * 「收起面板」的图标:面板外框、贴着 rail 那一边一条侧栏,另一边一对朝 rail 的箭头 —— 面板往那一侧收进 rail。
 * 图标库里没有,就地画一个,规格照 ui/icons:24 画幅、1.5 描边、currentColor。
 */
function IconCollapse({ side, size = 16 }: { side: Side; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      {side === "right" ? (
        <>
          <path d="M16.5 4v16" />
          <path d="M6.5 9l3 3-3 3" />
          <path d="M10.5 9l3 3-3 3" />
        </>
      ) : (
        <>
          <path d="M7.5 4v16" />
          <path d="M17.5 9l-3 3 3 3" />
          <path d="M13.5 9l-3 3 3 3" />
        </>
      )}
    </svg>
  );
}

/**
 * 助手分页顶栏(ChatHeader、没装驱动时的简版顶栏)和剧本页顶栏共用的「收起面板」。
 * 跟着这一页所在的一侧走(dock/):在右侧放顶栏最左边、收右侧;在左侧放顶栏最右边、收左侧。
 * 顶栏在头尾各放一个 placement="start" / "end",对不上当前一侧的那个不渲染 —— 键盘 Tab 顺序和看到的位置一致。
 * 收起后点 rail 上当前那一项展开 —— 和「再点一次选中项」是同一个开关(sideRails)。
 */
export function CollapsePanelButton({ placement }: { placement?: "start" | "end" }) {
  const side = useDockSide("right");
  if (placement && placement !== (side === "right" ? "start" : "end")) return null;
  return (
    <button
      type="button"
      className={`pc-icon-btn pc-collapse-btn is-${side}`}
      data-pc={`${side}-collapse`}
      title="收起面板"
      aria-label="收起面板"
      onClick={() => setRailCollapsed(side, true)}
    >
      <IconCollapse side={side} />
    </button>
  );
}

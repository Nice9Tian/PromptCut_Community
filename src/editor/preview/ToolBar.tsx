/**
 * 预览工具行(配色诊断与修正 v2 整屏,中栏顶部)。
 * 直接铺在 L0 画布上,没有条底:三个 28 方工具钮(选中 L3 底 + 强调色描边),
 * 右侧是画幅 / 帧率的等宽小字、当前缩放比,和「适应窗口」按钮。
 */
import { useStore } from "../../store/project";
import { IconCursor, IconText, IconMove } from "../../ui/icons";
import { useReadOnly } from "../readOnly";
import "./preview.css";

export type ToolType = "select" | "text" | "move";

const TOOLS: { key: ToolType; label: string; Icon: typeof IconCursor }[] = [
  { key: "select", label: "选择", Icon: IconCursor },
  { key: "move", label: "移动", Icon: IconMove },
  { key: "text", label: "文字", Icon: IconText },
];

export function ToolBar({
  tool,
  onToolChange,
  zoom,
  fitted,
  onFit,
}: {
  tool: ToolType;
  onToolChange: (tool: ToolType) => void;
  /** 当前缩放比(1 = 一个画面像素占一个屏幕像素) */
  zoom: number;
  /** 是不是正跟着窗口自动适应 */
  fitted: boolean;
  onFit: () => void;
}) {
  const width = useStore((s) => s.project.width);
  const height = useStore((s) => s.project.height);
  const fps = useStore((s) => s.project.fps);
  // 这个项目只给了只读权限(游客):移动、文字两个工具会改项目,置灰;选择照常
  const ro = useReadOnly();
  return (
    <div className="pc-pv-tools" role="toolbar" aria-label="预览工具">
      {TOOLS.map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          className={`pc-pv-tool${tool === key ? " is-on" : ""}`}
          aria-pressed={tool === key}
          disabled={ro.locked && key !== "select"}
          onClick={() => onToolChange(key)}
          title={ro.locked && key !== "select" ? `${label}:${ro.why}` : label}
        >
          <Icon size={14} />
        </button>
      ))}
      <span className="pc-pv-meta">
        {width} × {height} · {fps} fps · {Math.round(zoom * 100)}%
      </span>
      {/*
        以前这里是个 <span>,写着「适应窗口」却点不动 —— 它只是在陈述「现在正适应着窗口」,
        可是看起来就是个按钮,点了没反应。现在滚轮能缩放、中键能平移了,
        它才有事可做:自己调过视角之后点一下回到适应窗口。
        还在自动适应时按钮是禁用的(点了也没有任何变化,不如直接说明白)。
      */}
      <button
        type="button"
        className={`pc-pv-badge pc-pv-fit${fitted ? " is-on" : ""}`}
        onClick={onFit}
        disabled={fitted}
        title={fitted ? "画面正跟着窗口自动适应。滚轮缩放、中键拖动平移" : "回到适应窗口(滚轮缩放、中键拖动平移)"}
      >
        适应窗口
      </button>
    </div>
  );
}

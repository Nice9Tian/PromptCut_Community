import { IconHistory, IconSettings } from "../../../ui/icons";
import { useDockSide } from "../../dock/dockSide";
import { CollapsePanelButton } from "./CollapsePanelButton";
import "./chat.css";

/** 「显示思考」按钮上的思考气泡。图标库里没有合适的,就地画一个,规格照 ui/icons:24 画幅、1.5 描边、currentColor */
function IconThought({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      <path d="M7.5 15.5a4.5 4.5 0 0 1-.9-8.9 5.5 5.5 0 0 1 10.3.4 4.25 4.25 0 0 1-.4 8.5z" />
      <circle cx="7" cy="19" r="1.3" />
      <circle cx="4.2" cy="21.6" r="0.8" />
    </svg>
  );
}

export interface ChatHeaderProps {
  /** 分页标题(agentTabs 里这一页的 title;Agent 声明范围后会跟着改名) */
  title: string;
  mcpConnected: boolean;
  showThinking: boolean;
  onChangeShowThinking: (next: boolean) => void;
  onOpenHistory: () => void;
  onOpenSetup: () => void;
  /** 「云端」接入方式:没有本机的 AI 设置可开,给了这句话按钮就置灰、悬停显示它(契约 9.5) */
  settingsDisabled?: string;
  /** 连接状态点的说明;不给就按 mcpConnected 的「已连接 / 未连接」 */
  statusLabel?: string;
}

/**
 * 助手分页的顶栏:「收起面板」+ 标题 + 连接状态点,右边只有三个图标钮(显示思考 / 历史 / 设置)。
 * 「收起面板」跟着这一页所在的一侧走(dock/):在右侧放最左边,在左侧放最右边(三个图标钮之后)。
 *
 * 原来挤在这里的一整排控件都搬走了:简洁 / 详细进了 AI 设置的「显示」小节,
 * 驱动方式和模型去了输入区底部工具条,分工模式、一键配特效、诊断、新对话收进工具条上的「✦」菜单,
 * 剧本变成 rail 上的一页。顶栏只留每一轮都可能要点的东西。
 */
export function ChatHeader(props: ChatHeaderProps) {
  const { title, mcpConnected, showThinking, onChangeShowThinking, onOpenHistory, onOpenSetup, settingsDisabled, statusLabel } = props;
  const side = useDockSide("right");
  const conn = statusLabel ?? (mcpConnected ? "已连接" : "未连接");
  return (
    <div className={`ai-panel-header${side === "left" ? " is-left" : ""}`}>
      <CollapsePanelButton placement="start" />
      <div className="ai-panel-title">
        <span className="ai-chat-title" title={title}>{title}</span>
        {/* 连的是编辑台 MCP:断开时 AI 调不了任何编辑工具,只剩聊天 */}
        <span className={`ai-status-dot${mcpConnected ? " is-connected" : ""}`} role="img" aria-label={conn} title={conn} />
      </div>
      <div className="ai-chat-actions">
        <button
          type="button"
          className="pc-icon-btn ai-think-btn"
          data-pc="ai-show-thinking"
          aria-pressed={showThinking}
          title="显示模型的思考过程(有的驱动方式不产出思考,开了也不会有内容)"
          onClick={() => onChangeShowThinking(!showThinking)}
        >
          <IconThought />
          <span>显示思考</span>
        </button>
        <button
          type="button"
          className="pc-icon-btn"
          data-pc="ai-history"
          title="历史对话"
          aria-label="历史对话"
          onClick={onOpenHistory}
        >
          <IconHistory size={16} />
        </button>
        <button
          type="button"
          className="pc-icon-btn"
          data-pc="ai-settings"
          title={settingsDisabled ?? "AI 设置"}
          aria-label="AI 设置"
          disabled={!!settingsDisabled}
          onClick={onOpenSetup}
        >
          <IconSettings size={16} />
        </button>
      </div>
      <CollapsePanelButton placement="end" />
    </div>
  );
}

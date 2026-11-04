import { IconHistory, IconSettings } from "../../../ui/icons";
import { useDockSide } from "../../dock/dockSide";
import { CollapsePanelButton } from "./CollapsePanelButton";
import "./chat.css";
import { tr } from "../../../i18n/index.ts";

/** The thinking bubble on the "Show thinking" button. The icon library has no suitable one, so draw one on the spot, with specs per ui/icons: 24 canvas, 1.5 stroke, currentColor */
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
  /** Tab title (the title of this tab in agentTabs; it is renamed along when the Agent declares a scope) */
  title: string;
  mcpConnected: boolean;
  showThinking: boolean;
  onChangeShowThinking: (next: boolean) => void;
  onOpenHistory: () => void;
  onOpenSetup: () => void;
  /** For the "Cloud" connection type: there are no local AI settings to open, so when this line is given the button is greyed out and shows it on hover (contract 9.5) */
  settingsDisabled?: string;
  /** Description of the connection status dot; if not given, use mcpConnected's "Connected / Not connected" */
  statusLabel?: string;
}

/**
 * Top bar of the assistant tab: "Collapse panel" + title + connection status dot, with only three
 * icon buttons on the right (Show thinking / History / Settings).
 * "Collapse panel" follows the side this tab is on (dock/): on the right it goes leftmost, on the
 * left it goes rightmost (after the three icon buttons).
 *
 * The whole row of controls that used to be crammed in here has moved away: Concise / Detailed went
 * into the "Display" section of the AI settings, the driver and model went to the toolbar at the
 * bottom of the input area, and work-split mode, one-click effects, diagnostics and new chat are
 * tucked into the "✦" menu on the toolbar, and the script became a tab on the rail. The top bar keeps
 * only what may need a click in every round.
 */
export function ChatHeader(props: ChatHeaderProps) {
  const { title, mcpConnected, showThinking, onChangeShowThinking, onOpenHistory, onOpenSetup, settingsDisabled, statusLabel } = props;
  const side = useDockSide("right");
  const conn = statusLabel ?? (mcpConnected ? tr("Connected") : tr("Not connected"));
  return (
    <div className={`ai-panel-header${side === "left" ? " is-left" : ""}`}>
      <CollapsePanelButton placement="start" />
      <div className="ai-panel-title">
        <span className="ai-chat-title" title={title}>{title}</span>
        {/* What it connects to is the editor MCP: when disconnected the AI cannot call any editing tool, leaving only chat */}
        <span className={`ai-status-dot${mcpConnected ? " is-connected" : ""}`} role="img" aria-label={conn} title={conn} />
      </div>
      <div className="ai-chat-actions">
        <button
          type="button"
          className="pc-icon-btn ai-think-btn"
          data-pc="ai-show-thinking"
          aria-pressed={showThinking}
          title={tr("Show the model's reasoning (some drivers produce no reasoning, so turning this on shows nothing)")}
          onClick={() => onChangeShowThinking(!showThinking)}
        >
          <IconThought />
          <span>{tr("Show reasoning")}</span>
        </button>
        <button
          type="button"
          className="pc-icon-btn"
          data-pc="ai-history"
          title={tr("Chat history")}
          aria-label={tr("Chat history")}
          onClick={onOpenHistory}
        >
          <IconHistory size={16} />
        </button>
        <button
          type="button"
          className="pc-icon-btn"
          data-pc="ai-settings"
          title={settingsDisabled ?? tr("AI settings")}
          aria-label={tr("AI settings")}
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

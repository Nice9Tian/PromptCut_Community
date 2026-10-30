/**
 * 手机版 Agent 分页的画法探针用的页面(只给 `scripts/probes/mobile-agent-view-probe.mjs` 用,不进任何构建):
 * 不接云端、不接项目,直接用探针给的假消息画一页对话,好和演示稿并排看、量尺寸。
 * 外面的顶栏和底部导航栏照 `MobileEditor.tsx` 的写法摆,整屏位置才和演示稿对得上。
 */
import { createRoot } from "react-dom/client";
import "./mobile.css";
import "katex/dist/katex.min.css";
import type { ChatMessage } from "../ai/types";
import { AgentChatView } from "./AgentChatView";
import { AgentTabsBar, type TabItem } from "./agentParts";
import { Icon } from "./icons";
import type { QuoteRef } from "./agentView";

export interface HarnessState {
  tabs: TabItem[];
  activeId: string;
  messages: ChatMessage[];
  quotes: QuoteRef[];
  draft: boolean;
  animated: boolean;
  guide: "input" | "send" | null;
  inputText: string;
  streaming: boolean;
}

const root = createRoot(document.getElementById("root")!);
const noop = () => {};

function Page({ s }: { s: HarnessState }) {
  return (
    <div className="pcm" data-pc="mobile-ui">
      <div className="editor" data-pcm="editor" data-page="agent">
        <div className="topbar">
          <button type="button" className="icon-btn" aria-label="返回"><Icon name="back" /></button>
          <h1>夏日海边 Vlog</h1>
          <button type="button" className="btn primary" style={{ height: 30, padding: "0 12px" }}>导出</button>
        </div>
        <div className="pane-agent">
          <div className="agent-page">
            <AgentTabsBar tabs={s.tabs} activeId={s.activeId} onActivate={noop} onClose={noop} onNew={noop} />
            <AgentChatView
              tabId={s.activeId} shown who={s.tabs.find((t) => t.id === s.activeId)?.title ?? "Agent"} messages={s.messages}
              start={{ draft: s.draft, animated: s.animated, guide: s.guide, onPickPreset: noop }}
              level="high" levelDisabled={false} onLevel={noop} visLabel="共有对话" canToggleVisibility={false} onToggleVisibility={noop}
              queued={0} readOnly={false} quotes={s.quotes} onRemoveQuote={noop}
              inputText={s.inputText} onInput={noop} inputDisabled={false} onSend={noop} onStop={noop} stopMode={s.streaming && !s.inputText.trim()} onPickExample={noop}
            />
          </div>
        </div>
        <div className="pager">
          <button type="button"><span className="ico"><Icon name="pgPreview" /></span><span className="lbl">缩略预览</span></button>
          <button type="button"><span className="ico"><Icon name="pgTimeline" /></span><span className="lbl">时间轴</span></button>
          <button type="button" className="on"><span className="ico"><span className="disc"><Icon name="sparkle" /></span></span><span className="lbl">Agent</span></button>
        </div>
      </div>
    </div>
  );
}

(window as unknown as { __agentHarness: { render: (s: HarnessState) => void } }).__agentHarness = {
  render: (s) => root.render(<Page s={s} />),
};

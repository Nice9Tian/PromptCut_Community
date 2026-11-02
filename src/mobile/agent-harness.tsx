/**
 * Page for the render-style probe of the mobile app's Agent tab (used only by `scripts/probes/mobile-agent-view-probe.mjs`, not in any build):
 * not connected to the cloud or a project, it renders one chat page straight from the fake messages the probe supplies, to view side by side with the demo mockup and measure sizes.
 * The outer top bar and bottom nav bar are laid out as written in `MobileEditor.tsx`, so the whole-screen positions match the demo mockup.
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
          <button type="button" className="icon-btn" aria-label="Back"><Icon name="back" /></button>
          <h1>Summer beach vlog</h1>
          <button type="button" className="btn primary" style={{ height: 30, padding: "0 12px" }}>Export</button>
        </div>
        <div className="pane-agent">
          <div className="agent-page">
            <AgentTabsBar tabs={s.tabs} activeId={s.activeId} onActivate={noop} onClose={noop} onNew={noop} />
            <AgentChatView
              tabId={s.activeId} shown who={s.tabs.find((t) => t.id === s.activeId)?.title ?? "Agent"} messages={s.messages}
              start={{ draft: s.draft, animated: s.animated, guide: s.guide, onPickPreset: noop }}
              level="high" levelDisabled={false} onLevel={noop} visLabel="Shared chat" canToggleVisibility={false} onToggleVisibility={noop}
              queued={0} readOnly={false} quotes={s.quotes} onRemoveQuote={noop}
              inputText={s.inputText} onInput={noop} inputDisabled={false} onSend={noop} onStop={noop} stopMode={s.streaming && !s.inputText.trim()} onPickExample={noop}
            />
          </div>
        </div>
        <div className="pager">
          <button type="button"><span className="ico"><Icon name="pgPreview" /></span><span className="lbl">Thumbnail preview</span></button>
          <button type="button"><span className="ico"><Icon name="pgTimeline" /></span><span className="lbl">Timeline</span></button>
          <button type="button" className="on"><span className="ico"><span className="disc"><Icon name="sparkle" /></span></span><span className="lbl">Agent</span></button>
        </div>
      </div>
    </div>
  );
}

(window as unknown as { __agentHarness: { render: (s: HarnessState) => void } }).__agentHarness = {
  render: (s) => root.render(<Page s={s} />),
};

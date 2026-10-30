/**
 * 拓展栏里那块聊天面板的画法探针用的页面(只给 `scripts/probes/vibe-ext-chat-probe.mjs` 用,不进任何构建)。
 *
 * 不接云端、不接项目、不挂真舞台:直接用探针给的假消息画出那条拓展栏 ——
 * 上面两段(画面、修改前 / 修改后)用同样的 `.ps-ext-sec` 外壳加一块定高的占位(真内容是预览画面,
 * 那要整条渲染管线,和这支探针要验的「截断和高度分配」无关),下面挂真的 `ExtChatPanel` 和真的 `Composer`。
 *
 * 这样能验的就是 issue #4 定下的那几条:只有最新一条 Agent 回复留全文、其余收成两行、
 * 折起来的「Agent 操作」标一句还有几条、点一下能展开,以及「甲」——上面两段照常摊开、聊天面板吃掉剩下的高度。
 * 输入框在哪(`ChatView.tsx` 的 `inPanel`)不在这支里验,那是真页面上的事。
 */
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import "../skins/skins.css";
import "../skins/useSkin";
import "./start.css";
import type { ChatMessage } from "../ai/types";
import { Composer } from "./Composer";
import { ExtChatPanel } from "./ExtChatPanel";

export interface ExtChatHarnessState {
  messages: ChatMessage[];
  /** 这条拓展栏多宽(`sideWidth.ts` 的 EXT_WIDTH 允许 250～520) */
  width: number;
  canSend: boolean;
  whyNot: string | null;
}

const root = createRoot(document.getElementById("root")!);
const noop = () => {};

function FakeSection(props: { title: string; bodyHeight: number }) {
  return (
    <section className="ps-ext-sec" data-pc="harness-ext-sec">
      <div className="ps-card-head">
        <button type="button" className="ps-card-toggle" aria-expanded>
          <span className="ps-card-caret" data-open="true" aria-hidden="true">›</span>
          {props.title}
        </button>
      </div>
      <div className="ps-ext-body">
        <div style={{ height: props.bodyHeight, borderRadius: 7, background: "var(--fill-subtle)" }} />
      </div>
    </section>
  );
}

function Page({ s }: { s: ExtChatHarnessState }) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const composer = (
    <Composer
      text={text}
      onText={setText}
      onSend={noop}
      onStop={noop}
      area={area}
      canSend={s.canSend}
      canStop={false}
      stopMode={false}
      placeholder="对这支片子说点什么"
      note="在云端运行，关闭后继续；重新打开可接着看。"
      narrow
    />
  );
  return (
    <div className="ps">
      <div className="ps-body-row">
        <main className="ps-main ps-chat">
          <div className="ps-chat-row">
            <div className="ps-chat-col" data-pc="harness-chat-col" />
            <aside className="ps-ext" data-pc="start-ext" style={{ flexBasis: `${s.width}px` }}>
              <FakeSection title="画面" bodyHeight={150} />
              <FakeSection title="修改前 / 修改后" bodyHeight={40} />
              <ExtChatPanel messages={s.messages} composer={composer} whyNot={s.whyNot} onBack={noop} />
            </aside>
          </div>
        </main>
      </div>
    </div>
  );
}

declare global {
  interface Window {
    __extChatHarness?: { render: (s: ExtChatHarnessState) => void };
  }
}

window.__extChatHarness = {
  render(s) {
    root.render(<Page s={s} />);
  },
};

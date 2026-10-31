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
 * `showScrub` 打开时一并画出详细编辑与小窗两条进度滑杆(`.ps-detail-scrub`、`.ps-ext-scrub`),供 `vibe-scrub-probe.mjs` 验 issue #31。
 */
import { useRef, useState } from "react";
import type { ReactNode } from "react";
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
  /** 打开时在左列与拓展栏「画面」段画出两条真实进度滑杆,供 `vibe-scrub-probe.mjs` 验收 issue #31 */
  showScrub?: boolean;
}

const root = createRoot(document.getElementById("root")!);
const noop = () => {};

function FakeSection(props: { title: string; bodyHeight: number; children?: ReactNode }) {
  return (
    <section className="ps-ext-sec" data-pc="harness-ext-sec">
      <div className="ps-card-head">
        <button type="button" className="ps-card-toggle" aria-expanded>
          <span className="ps-card-caret" data-open="true" aria-hidden="true">›</span>
          {props.title}
        </button>
      </div>
      <div className="ps-ext-body">
        {props.children ?? <div style={{ height: props.bodyHeight, borderRadius: 7, background: "var(--fill-subtle)" }} />}
      </div>
    </section>
  );
}

function Page({ s }: { s: ExtChatHarnessState }) {
  const [text, setText] = useState("");
  const [detailT, setDetailT] = useState(20);
  const [extT, setExtT] = useState(20);
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
            <div className="ps-chat-col" data-pc="harness-chat-col">
              {s.showScrub && (
                <div className="ps-detail" data-pc="start-detail">
                  <header className="ps-detail-head">
                    <span className="ps-detail-title">详细编辑</span>
                    <span className="ps-detail-sub">时间轴可调；右键一张卡可以引用进输入框</span>
                    <span className="ps-rail-spacer" />
                    <button type="button" className="ps-mode-btn" data-pc="start-enter-traditional">进入传统式</button>
                    <button type="button" className="ps-ghost-btn" data-pc="start-detail-close">收起</button>
                  </header>
                  <div className="ps-detail-stage">
                    <div className="ps-stage ps-detail-screen" data-pc="start-detail-stage" style={{ background: "linear-gradient(135deg, #111 40%, #2b2a33 100%)" }} />
                  </div>
                  <div className="ps-detail-transport">
                    <button type="button" className="ps-detail-play" data-pc="start-detail-play" aria-label="播放">▶</button>
                    <button type="button" className="ps-ghost-btn" data-pc="start-detail-rewind">回到开头</button>
                    <input type="range" className="ps-detail-scrub" data-pc="start-detail-scrub" min={0} max={60} step={0.05}
                      value={detailT} aria-label="进度"
                      onPointerDown={() => window.getSelection()?.removeAllRanges()}
                      onChange={(e) => setDetailT(Number(e.target.value))} />
                    <span className="ps-detail-time">{detailT.toFixed(2)} s / 60.00 s</span>
                  </div>
                </div>
              )}
            </div>
            <aside className="ps-ext" data-pc="start-ext" style={{ flexBasis: `${s.width}px` }}>
              <FakeSection title="画面" bodyHeight={150}>
                {s.showScrub ? (
                  <div className="ps-stage ps-ext-frame" data-pc="start-ext-stage" style={{ background: "linear-gradient(135deg, #111 40%, #d8d0c5 60%)" }}>
                    <div className="ps-stage-over">
                      <button type="button" className="ps-ext-play" data-pc="start-ext-play" aria-label="播放">▶</button>
                      <div className="ps-ext-transport">
                        <input type="range" className="ps-ext-scrub" data-pc="start-ext-scrub" min={0} max={60} step={0.05}
                          value={extT} aria-label="进度"
                          onPointerDown={() => window.getSelection()?.removeAllRanges()}
                          onChange={(e) => setExtT(Number(e.target.value))} />
                        <span className="ps-ext-time">00:{String(Math.floor(extT)).padStart(2, "0")} / 01:00</span>
                      </div>
                    </div>
                  </div>
                ) : undefined}
              </FakeSection>
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

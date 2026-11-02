/**
 * Page used by the probe for how the chat panel in the side panel is drawn (only for
 * `scripts/probes/vibe-ext-chat-probe.mjs`, not part of any build).
 *
 * No cloud, no project, no real stage: it draws that side panel directly from fake messages given by the probe ---
 * the two upper sections (Visuals, Before / After) use the same `.ps-ext-sec` shell plus a fixed-height
 * placeholder (the real content is the preview picture, which needs the whole render pipeline and has
 * nothing to do with the "truncation and height allocation" this probe verifies), and the real
 * `ExtChatPanel` and the real `Composer` hang below.
 *
 * What this can verify are the points set in issue #4: only the latest Agent reply keeps its full text, the
 * rest collapse into two lines, the folded "Agent actions" show a line saying how many more there are and
 * can be expanded with a click, and "option A": the two upper sections spread out as usual and the chat
 * panel takes the remaining height.
 * Where the input box goes (`inPanel` in `ChatView.tsx`) is not verified here; that is a matter for the real page.
 * When `showScrub` is on, the two progress sliders of detail editing and the mini window (`.ps-detail-scrub`,
 * `.ps-ext-scrub`) are drawn as well, for `vibe-scrub-probe.mjs` to verify issue #31.
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
  /** How wide this side panel is (`EXT_WIDTH` in `sideWidth.ts` allows 250 to 520) */
  width: number;
  canSend: boolean;
  whyNot: string | null;
  /** When on, draws two real progress sliders in the left column and the side panel "Visuals" section, for `vibe-scrub-probe.mjs` to run the acceptance check on issue #31 */
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
      placeholder="Say something about this video"
      note="Runs in the cloud and keeps going after you close it; reopen to pick up where you left off."
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
                    <span className="ps-detail-title">Detail editing</span>
                    <span className="ps-detail-sub">The timeline is adjustable; right-click a card to quote it into the input box</span>
                    <span className="ps-rail-spacer" />
                    <button type="button" className="ps-mode-btn" data-pc="start-enter-traditional">Enter Classic mode</button>
                    <button type="button" className="ps-ghost-btn" data-pc="start-detail-close">Collapse</button>
                  </header>
                  <div className="ps-detail-stage">
                    <div className="ps-stage ps-detail-screen" data-pc="start-detail-stage" style={{ background: "linear-gradient(135deg, #111 40%, #2b2a33 100%)" }} />
                  </div>
                  <div className="ps-detail-transport">
                    <button type="button" className="ps-detail-play" data-pc="start-detail-play" aria-label="Play">▶</button>
                    <button type="button" className="ps-ghost-btn" data-pc="start-detail-rewind">Back to start</button>
                    <input type="range" className="ps-detail-scrub" data-pc="start-detail-scrub" min={0} max={60} step={0.05}
                      value={detailT} aria-label="progress"
                      onPointerDown={() => window.getSelection()?.removeAllRanges()}
                      onChange={(e) => setDetailT(Number(e.target.value))} />
                    <span className="ps-detail-time">{detailT.toFixed(2)} s / 60.00 s</span>
                  </div>
                </div>
              )}
            </div>
            <aside className="ps-ext" data-pc="start-ext" style={{ flexBasis: `${s.width}px` }}>
              <FakeSection title="Video" bodyHeight={150}>
                {s.showScrub ? (
                  <div className="ps-stage ps-ext-frame" data-pc="start-ext-stage" style={{ background: "linear-gradient(135deg, #111 40%, #d8d0c5 60%)" }}>
                    <div className="ps-stage-over">
                      <button type="button" className="ps-ext-play" data-pc="start-ext-play" aria-label="Play">▶</button>
                      <div className="ps-ext-transport">
                        <input type="range" className="ps-ext-scrub" data-pc="start-ext-scrub" min={0} max={60} step={0.05}
                          value={extT} aria-label="progress"
                          onPointerDown={() => window.getSelection()?.removeAllRanges()}
                          onChange={(e) => setExtT(Number(e.target.value))} />
                        <span className="ps-ext-time">00:{String(Math.floor(extT)).padStart(2, "0")} / 01:00</span>
                      </div>
                    </div>
                  </div>
                ) : undefined}
              </FakeSection>
              <FakeSection title="Before / after" bodyHeight={40} />
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

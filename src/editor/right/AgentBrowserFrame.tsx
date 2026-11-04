import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./AgentBrowserFrame.css";
import { closeAgentBrowser, useAgentBrowserState } from "../../ai/agentBrowserStore";
import { hideAgentWebview, muteAgentWebview, rectOf, showAgentWebview } from "../../ai/shellBrowser";
import { webHandoff } from "../../ai/web";
import { tr } from "../../i18n/index.ts";

/**
 * The "Browser" panel in desktop shell mode: opening the "Browser" tab in the top bar shows it.
 *
 * The agent's browser is a child webview inside the main window, normally hidden outside the client area. This
 * panel covers the whole editing area
 * below the top bar and draws only a header row (why the agent needs you, the mute switch, back to editing) and a
 * blank area;
 * the blank area's position is measured and handed to the shell, and the shell places the webview into it. The
 * child webview always sits above the main page, so nothing
 * clickable can go in this blank area.
 *
 * It is not a popup: it does not cover the top bar and does not lock interaction, the user can click a tab at any
 * time to switch back to editing, and the agent's page is still there, not lost.
 */
export function AgentBrowserFrame() {
  const st = useAgentBrowserState();
  if (!st.open) return null;
  return <Panel key={st.seq} reason={st.reason} />;
}

/** The panel starts at the bottom edge of the top bar. If the top bar cannot be measured, fall back to 36px (the top bar's fixed height) */
function topOffset(): number {
  const bar = document.querySelector(".pc-bar--main");
  return bar ? Math.round(bar.getBoundingClientRect().bottom) : 36;
}

function Panel(props: { reason: string }) {
  const { reason } = props;
  const hole = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(topOffset);
  // The webview in the shell is muted by default (pages the agent opens autoplay video). It is unmuted only when
  // the user clicks the speaker here;
  // the shell re-mutes itself when returning to editing, so nothing to do here.
  const [muted, setMuted] = useState(true);
  const toggleMute = async () => {
    const next = !muted;
    if (await muteAgentWebview(next)) setMuted(next);
  };

  useEffect(() => {
    let alive = true;
    const place = () => {
      if (!alive) return;
      setTop(topOffset());
      if (hole.current) void showAgentWebview(rectOf(hole.current));
    };
    // Whether the agent handed it over or the user entered by clicking the tab, the Node side must lift the 1280×800
    // viewport emulation so the page follows the size of this blank area; otherwise the page's right edge and bottom
    // do not line up, and the scrollbars are misplaced.
    // This hits the server endpoint directly, not through MCP, so it will not light up the tab again.
    void webHandoff({}).catch(() => {});
    // Measure after the layout is stable: in the first frame the panel is not yet laid out
    const raf = requestAnimationFrame(place);
    const ro = new ResizeObserver(place);
    if (hole.current) ro.observe(hole.current);
    window.addEventListener("resize", place);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", place);
      void hideAgentWebview();
    };
  }, []);

  const back = () => {
    closeAgentBrowser();
    // The Node side restores the fixed viewport; failure does not matter, the next web_view will set it again
    void webHandoff({ hide: true }).catch(() => {});
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); back(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div className="abf-panel" style={{ top }} role="region" aria-label={tr("AI browser")}>
      <div className="abf-head">
        <div className="abf-title">
          {reason ? tr("AI is waiting for you: {0}", reason) : tr("AI browser")}
        </div>
        <div className="abf-hint">
          {tr("{0} The page is muted by default.", reason
            ? tr("Complete the login, captcha or confirmation in the page below, then click \"Back to editing\" and tell the AI in the chat.")
            : tr("This is the page the AI uses to browse the web. You can watch it or operate it directly."))}
        </div>
        <div className="abf-btns">
          <button
            className="abf-btn is-ghost"
            onClick={() => void toggleMute()}
            title={muted ? tr("Unmute (it is muted again automatically when you go back to editing)") : tr("Muted")}
            aria-pressed={!muted}
          >
            {muted ? tr("🔇 Muted") : tr("🔊 Sound on")}
          </button>
          <button className="abf-btn" onClick={back}>{tr("Back to editing ⏎")}</button>
        </div>
      </div>
      <div className="abf-hole" ref={hole} aria-hidden="true" />
    </div>,
    document.body,
  );
}

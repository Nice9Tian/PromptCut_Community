import { useEffect } from "react";
import type { JSX } from "react";
import {
  setAgentBrowserAvailable, toggleAgentBrowser, useAgentBrowserState,
} from "../ai/agentBrowserStore";
import { agentWebviewInfo } from "../ai/shellBrowser";
import "./AgentBrowserTab.css";
import { tr } from "../i18n/index.ts";

/**
 * The "Browser" tab in the top bar (appears only in the desktop shell).
 *
 * The agent's browser is a child webview inside the main window. When it needs a human to take over
 * (login, captcha) it **does not pop up a window**:
 * this tab starts blinking, a "needs action" bubble appears next to it, and the user comes over
 * after finishing what they are doing.
 * One click switches to the browser panel, another click switches back to editing.
 *
 * When running npm run dev in a browser there is no shell; one probe finds no agent webview, and
 * the tab is not rendered at all.
 */
export function AgentBrowserTab(): JSX.Element | null {
  const st = useAgentBrowserState();

  useEffect(() => {
    let alive = true;
    void agentWebviewInfo().then((info) => { if (alive) setAgentBrowserAvailable(!!info?.ready); });
    return () => { alive = false; };
  }, []);

  if (!st.available) return null;

  const cls = ["pc-btn", "pc-agent-tab", st.open ? "is-open" : "", st.pending ? "is-pending" : ""].filter(Boolean).join(" ");
  const title = st.pending
    ? tr("The AI is waiting for you to act{0}. Click to switch over", st.reason ? tr(": {0}", st.reason) : "")
    : st.open ? tr("Back to editing") : tr("Switch to the AI's browser");

  // Brings its own group (.pc-bar-group): with no shell it is not rendered at all, so the top bar does not keep the spacing of an empty group
  return (
    <span className="pc-bar-group pc-agent-tab-wrap">
      <button type="button" className={cls} title={title} aria-pressed={st.open} onClick={toggleAgentBrowser}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
        </svg>
        <span className="pc-btn-label">{tr("Browser")}</span>
        {st.pending && <span className="pc-agent-dot" aria-hidden="true" />}
      </button>
      {st.pending && !st.open && (
        <span className="pc-agent-bubble" role="status">
          {tr("Pending transaction{0}", st.reason ? tr(": {0}", st.reason) : "")}
        </span>
      )}
    </span>
  );
}

import { useEffect } from "react";
import type { JSX } from "react";
import {
  setAgentBrowserAvailable, toggleAgentBrowser, useAgentBrowserState,
} from "../ai/agentBrowserStore";
import { agentWebviewInfo } from "../ai/shellBrowser";
import "./AgentBrowserTab.css";

/**
 * 顶栏的「浏览器」页签(只在桌面壳里出现)。
 *
 * agent 的浏览器是主窗口里的一块子 webview。它要人接手(登录、验证码)时**不弹窗**:
 * 这个页签开始闪,旁边冒一个「有待操作」的气泡,用户手上的活做完再点过来。
 * 点一下切到浏览器面板,再点一下切回编辑。
 *
 * 浏览器里跑 npm run dev 时没有壳,探一次拿不到 agent webview,页签整个不渲染。
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
    ? `AI 在等你操作${st.reason ? `：${st.reason}` : ""}。点一下切过去`
    : st.open ? "回到编辑" : "切到 AI 的浏览器";

  // 自带一组(.pc-bar-group):没有壳时整个不渲染,顶栏上不会留一个空组的间距
  return (
    <span className="pc-bar-group pc-agent-tab-wrap">
      <button type="button" className={cls} title={title} aria-pressed={st.open} onClick={toggleAgentBrowser}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
        </svg>
        <span className="pc-btn-label">浏览器</span>
        {st.pending && <span className="pc-agent-dot" aria-hidden="true" />}
      </button>
      {st.pending && !st.open && (
        <span className="pc-agent-bubble" role="status">
          有待操作事务{st.reason ? `：${st.reason}` : ""}
        </span>
      )}
    </span>
  );
}

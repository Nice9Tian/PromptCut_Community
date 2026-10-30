import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./AgentBrowserFrame.css";
import { closeAgentBrowser, useAgentBrowserState } from "../../ai/agentBrowserStore";
import { hideAgentWebview, muteAgentWebview, rectOf, showAgentWebview } from "../../ai/shellBrowser";
import { webHandoff } from "../../ai/web";

/**
 * 桌面壳模式下的「浏览器」面板:顶栏的「浏览器」页签点开就是它。
 *
 * agent 的浏览器是主窗口里的一块子 webview,平时藏在客户区外面。这个面板盖在顶栏
 * 以下的整块编辑区上,只画一行头部(agent 为什么要你来、静音开关、回到编辑)和一块空,
 * 空的位置量出来交给壳,壳把 webview 摆进去。子 webview 永远压在主页面之上,所以这块
 * 空里不能放任何要点的东西。
 *
 * 不是弹窗:它不遮顶栏、不锁交互,用户随时点页签切回编辑,agent 的页面还在,不丢。
 */
export function AgentBrowserFrame() {
  const st = useAgentBrowserState();
  if (!st.open) return null;
  return <Panel key={st.seq} reason={st.reason} />;
}

/** 面板从顶栏底边开始。量不到顶栏就退回 36px(顶栏的固定高度) */
function topOffset(): number {
  const bar = document.querySelector(".pc-bar--main");
  return bar ? Math.round(bar.getBoundingClientRect().bottom) : 36;
}

function Panel(props: { reason: string }) {
  const { reason } = props;
  const hole = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(topOffset);
  // 壳里的 webview 默认静音(agent 打开的页面会自动播视频)。只有用户在这里点喇叭才放开;
  // 回到编辑时壳自己会静回去,这里不用管。
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
    // 不管是 agent 交出来的还是用户自己点页签进来的,都要让 Node 那边解除 1280×800 的
    // 视口仿真,页面才会跟着这块空的尺寸走 —— 不然页面右边和底部对不上,滚动条也是错位的。
    // 这是直接打服务端接口,不经过 MCP,所以不会再点亮一次页签。
    void webHandoff({}).catch(() => {});
    // 布局稳定后再量:第一帧面板还没排好
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
    // Node 那边恢复固定视口;失败也不要紧,下次 web_view 会再设
    void webHandoff({ hide: true }).catch(() => {});
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); back(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div className="abf-panel" style={{ top }} role="region" aria-label="AI 的浏览器">
      <div className="abf-head">
        <div className="abf-title">
          {reason ? `AI 在等你操作：${reason}` : "AI 的浏览器"}
        </div>
        <div className="abf-hint">
          {reason
            ? "在下面的页面里完成登录、验证码或确认，做完点「回到编辑」，再回到对话里告诉 AI 一声。"
            : "这是 AI 上网用的页面。你可以看，也可以直接操作。"}
          页面默认静音。
        </div>
        <div className="abf-btns">
          <button
            className="abf-btn is-ghost"
            onClick={() => void toggleMute()}
            title={muted ? "放开声音（回到编辑时会自动静音）" : "静音"}
            aria-pressed={!muted}
          >
            {muted ? "🔇 静音中" : "🔊 有声"}
          </button>
          <button className="abf-btn" onClick={back}>回到编辑 ⏎</button>
        </div>
      </div>
      <div className="abf-hole" ref={hole} aria-hidden="true" />
    </div>,
    document.body,
  );
}

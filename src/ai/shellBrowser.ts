/**
 * 桌面壳里的 agent 浏览器(主窗口里的子 webview)。
 *
 * 壳(Tauri)启动时给 WebView2 开了调试端口,agent 的 puppeteer 连的就是壳里那块 webview。
 * Node 那边管不了它摆在哪 —— 它是壳的东西 —— 所以显示 / 隐藏由这里 invoke 壳的命令:
 * 把 webview 摆到主窗口里某个矩形(CSS 像素),或者挪回客户区外面。
 *
 * 在浏览器里跑 `npm run dev` 时没有壳,这些函数一律回 false / 空,调用方退回 Chrome 窗口方案。
 */

interface TauriGlobal {
  core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
}

function invoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  const t = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  return t?.core?.invoke ?? null;
}

export interface AgentWebviewInfo {
  port: number;
  label: string;
  initial_url: string;
  ready: boolean;
  visible: boolean;
  /** 默认 true。只有用户在浮层上点喇叭才放开;收回时壳会自动静回去 */
  muted: boolean;
}

/** 静音开关。agent 的页面会自动播视频,所以默认静音,只在用户接手时给放开的机会 */
export async function muteAgentWebview(muted: boolean): Promise<boolean> {
  const call = invoke();
  if (!call) return false;
  try {
    await call("agent_webview_mute", { muted });
    return true;
  } catch (e) {
    console.warn("[shellBrowser] agent_webview_mute 失败", e);
    return false;
  }
}

/** 有没有壳、壳里有没有 agent webview。没有壳直接 null,不抛 */
export async function agentWebviewInfo(): Promise<AgentWebviewInfo | null> {
  const call = invoke();
  if (!call) return null;
  try {
    return (await call("agent_webview_info")) as AgentWebviewInfo;
  } catch {
    return null;
  }
}

export interface Rect { x: number; y: number; w: number; h: number }

/** 把 agent webview 摆到主窗口里的这个矩形(CSS 像素,和 getBoundingClientRect 一致) */
export async function showAgentWebview(rect: Rect): Promise<boolean> {
  const call = invoke();
  if (!call) return false;
  try {
    await call("agent_webview_show", {
      x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h),
    });
    return true;
  } catch (e) {
    console.warn("[shellBrowser] agent_webview_show 失败", e);
    return false;
  }
}

/** 挪回客户区外面 */
export async function hideAgentWebview(): Promise<boolean> {
  const call = invoke();
  if (!call) return false;
  try {
    await call("agent_webview_hide");
    return true;
  } catch (e) {
    console.warn("[shellBrowser] agent_webview_hide 失败", e);
    return false;
  }
}

/** 某个 DOM 元素占的矩形 → 壳要的 rect */
export function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

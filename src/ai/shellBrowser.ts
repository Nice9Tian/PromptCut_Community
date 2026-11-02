/**
 * The agent browser in the desktop shell (a child webview inside the main window).
 *
 * When the shell (Tauri) starts, it opens a debugging port on WebView2, and the agent's puppeteer
 * connects to that webview inside the shell. The Node side cannot control where it is placed (it
 * belongs to the shell), so showing / hiding is done here by invoking the shell's commands: place
 * the webview at some rectangle in the main window (CSS pixels), or move it back outside the client
 * area.
 *
 * When running `npm run dev` in a browser there is no shell, and these functions all return
 * false / empty, so callers fall back to the Chrome window approach.
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
  /**
   * Default true. It is released only when the user clicks the speaker on the popover; when the
   * webview is retracted the shell mutes it again automatically
   */
  muted: boolean;
}

/**
 * Mute switch. The agent's pages autoplay videos, so it is muted by default, and the chance to
 * unmute is given only when the user takes over
 */
export async function muteAgentWebview(muted: boolean): Promise<boolean> {
  const call = invoke();
  if (!call) return false;
  try {
    await call("agent_webview_mute", { muted });
    return true;
  } catch (e) {
    console.warn("[shellBrowser] agent_webview_mute failed", e);
    return false;
  }
}

/**
 * Whether there is a shell, and whether the shell has an agent webview. With no shell it returns
 * null directly, without throwing
 */
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

/**
 * Place the agent webview at this rectangle in the main window (CSS pixels, consistent with
 * getBoundingClientRect)
 */
export async function showAgentWebview(rect: Rect): Promise<boolean> {
  const call = invoke();
  if (!call) return false;
  try {
    await call("agent_webview_show", {
      x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h),
    });
    return true;
  } catch (e) {
    console.warn("[shellBrowser] agent_webview_show failed", e);
    return false;
  }
}

/** Move it back outside the client area */
export async function hideAgentWebview(): Promise<boolean> {
  const call = invoke();
  if (!call) return false;
  try {
    await call("agent_webview_hide");
    return true;
  } catch (e) {
    console.warn("[shellBrowser] agent_webview_hide failed", e);
    return false;
  }
}

/** The rectangle a DOM element occupies → the rect the shell wants */
export function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

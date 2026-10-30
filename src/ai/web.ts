/**
 * 网页操作的前端胶水。
 *
 * 这一层特别薄，因为浏览器整个跑在服务端（server/web/），前端只是把工具调用转成
 * 一次 POST。之所以还要经过前端，是为了和别的工具走同一条路：MCP 桥 → 编辑台页面
 * → 服务端。好处是 skill-gate、编辑台所有权令牌、工具调用的事件流这些都不用再实现
 * 一遍；坏处只是多一跳本机 HTTP，可以忽略。
 *
 * 返回体里的 `__image` 原样往回传——harness/agent.mjs 和 mcp-server.mjs 都认这个形状，
 * 会把 base64 摘出来变成消息里的图片块。这里千万不要动它，一旦被 JSON.stringify 成
 * 普通字段，几十万字符的 base64 会直接把上下文撑爆。
 */

/** 元素在返回图上的包围盒 [x1,y1,x2,y2]，单位是图的像素 */
export type WebBox = [number, number, number, number];

export interface WebClickable {
  /** 调用 web_click 时用的 id。**只对最近一次截图有效** */
  u: string;
  /** 标签名 */
  t: string;
  /** 可见文字 / aria-label */
  n: string;
  b: WebBox;
  /** input / textarea 当前的值 */
  v?: string;
  /** input 的 type */
  it?: string;
}

export interface WebView {
  ok: boolean;
  url?: string;
  title?: string;
  image?: { width: number; height: number };
  clickable?: WebClickable[];
  omitted?: number;
  note?: string;
  hint?: string;
  /** 检测到的「该交给人」的东西：login / captcha / qrcode / consent */
  wall?: string[];
  wallNote?: string;
  error?: string;
  candidates?: (WebClickable & { d: number; stacked?: boolean })[];
  __image?: { base64: string; mime: string };
}

async function post(path: string, body?: unknown): Promise<WebView> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await r.json().catch(() => ({ ok: false, error: `${path} 返回 ${r.status}` }));
  if (!r.ok && data.ok !== false) return { ok: false, error: data.error || `${path} 返回 ${r.status}` };
  return data;
}

export const webOpen = (args: { url: string }) => post("/api/web/open", args);
export const webView = () => post("/api/web/view");
export const webClick = (args: { u?: string; x?: number; y?: number; expect?: string }) => post("/api/web/click", args);
export const webType = (args: { u: string; text: string; append?: boolean; submit?: boolean }) => post("/api/web/type", args);
export const webScroll = (args: { dy?: number; to?: "top" | "bottom" }) => post("/api/web/scroll", args);
export const webRead = (args?: { limit?: number }) => post("/api/web/read", args);
export const webHandoff = (args?: { reason?: string; hide?: boolean }) => post("/api/web/handoff", args);
export const webClose = () => post("/api/web/close");

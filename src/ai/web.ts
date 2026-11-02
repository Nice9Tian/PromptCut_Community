import { tr } from "../i18n/index.ts";
/**
 * Frontend glue for web operations.
 *
 * This layer is especially thin, because the browser runs entirely on the server (server/web/), and
 * the frontend merely turns a tool call into one POST. The reason it still goes through the frontend
 * is to take the same path as the other tools: MCP bridge → editor page → server. The benefit is that
 * skill-gate, the editor ownership token and the tool-call event stream need not be implemented
 * again; the only cost is one extra local HTTP hop, which can be ignored.
 *
 * The `__image` in the response body is passed back unchanged: harness/agent.mjs and mcp-server.mjs
 * both recognize this shape and pull the base64 out into an image block in the message. Do not touch
 * it here: once it is JSON.stringify'd into an ordinary field, several hundred thousand characters of
 * base64 would blow up the context outright.
 */

/** The element's bounding box on the returned image [x1,y1,x2,y2], in the image's pixels */
export type WebBox = [number, number, number, number];

export interface WebClickable {
  /** The id used when calling web_click. **Valid only for the most recent screenshot** */
  u: string;
  /** Tag name */
  t: string;
  /** Visible text / aria-label */
  n: string;
  b: WebBox;
  /** The current value of input / textarea */
  v?: string;
  /** The type of input */
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
  /** Things detected that "should be handed to a person": login / captcha / qrcode / consent */
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
  const data = await r.json().catch(() => ({ ok: false, error: tr("{0} returned {1}", path, r.status) }));
  if (!r.ok && data.ok !== false) return { ok: false, error: data.error || tr("{0} returned {1}", path, r.status) };
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

/**
 * 「把这个引用到 AI 的输入框」的全局入口。
 *
 * 喊的人不止一处:预览里右键一张卡、时间轴上右键一个片段或带里的一张叠加卡；
 * 听的人也不止一处:桌面的本机 AI 栏、云端 AI 栏、手机版的 Agent 分页(它放进标记条而不是输入框)。
 * 两边隔着好几层组件、又不共享界面状态,所以用一个 window 事件搭桥 —— 和 `left/captionsBus.ts` 同一个路子。
 *
 * 事件名和 detail 的字段沿用原来那一套(`clipId` / `label` / `cardId`),老的调用方一个字不用改。
 * 引用块的写法只有 `quoteToken` 一处:以前本机 AI 栏和云端 AI 栏各自拼 `@卡片 …(…)`,
 * 加「叠加卡」这一级时两处都要改,漏一处就是另一个面板里引用写错级别。
 */
import { quoteToken } from "../mobile/agentView";

const EVENT = "pc-quote-clip";

export interface QuoteDetail {
  /** 被引用的东西的 id:片段就是片段 id;叠加卡是「片段id#种类:定义id」 */
  clipId: string;
  /** 给人看的名字 */
  label?: string;
  /** 引的是哪一级:不写 = 整段(`@卡片`);单张叠加卡写「叠加卡」 */
  kind?: string;
  /** 老调用方(预览右键)还带这个,只当兜底名字用 */
  cardId?: string;
}

export interface QuoteRead {
  id: string;
  label: string;
  kind?: string;
  /** 插进输入框的那一串 */
  token: string;
}

export function requestQuote(q: QuoteDetail): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: q }));
}

/** 读一条事件:名字按 label → cardId → 「未命名」兜底,引用块统一由 quoteToken 写 */
export function readQuote(ev: Event): QuoteRead | null {
  const d = ((ev as CustomEvent).detail || {}) as Partial<QuoteDetail>;
  const id = typeof d.clipId === "string" ? d.clipId : "";
  if (!id) return null;
  const label =
    (typeof d.label === "string" && d.label) ||
    (typeof d.cardId === "string" && d.cardId) ||
    "未命名";
  const kind = typeof d.kind === "string" && d.kind ? d.kind : undefined;
  return { id, label, kind, token: quoteToken({ id, label, kind }) };
}

export function onQuoteRequest(fn: (q: QuoteRead) => void): () => void {
  const handler = (ev: Event) => {
    const q = readQuote(ev);
    if (q) fn(q);
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

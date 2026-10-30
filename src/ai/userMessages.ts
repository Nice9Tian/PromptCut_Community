import type { ChatMessage, MessagePart } from "./types.ts";

/**
 * Agent 对用户说的话:气泡里只显示这些(2026-10-20 用户定,原话「气泡里面只展示在做什么(harness可能要改,
 * 比如加入send_message(user,xxx)的用法。)」)。做过的操作和汇报在气泡下面的「Agent 操作」里(ActivityPanel.tsx)。
 *
 * - 一轮里调过 `send_message`(`to: "user"`)的,按先后列出它们的 `text`;
 * - 一次都没调、只回了文字的,那段文字当成「在做什么」显示(相邻的文字并成一句);
 * 两种不混:调过 send_message 的那一轮,文字回复不再进气泡(要看在「显示思考」里看),免得同一句话出现两遍。
 *
 * 纯函数,不碰 React,好让 node 直接跑测试(user-messages.test.mjs)。
 */

/** 去掉各家工具名前缀(`mcp__promptcut__`、`promptcut.`),规则同 chat/iconRuns.ts 的 bareToolName */
const bare = (name: string) => name.replace(/^mcp__.+?__/, "").replace(/^[\w-]+\.(?=\w)/, "");

/** 这次工具调用是不是「对用户说话」(send_message 发给 user) */
export function isUserMessageCall(name: string | undefined, input: unknown): boolean {
  if (!name || bare(name) !== "send_message" || !input || typeof input !== "object") return false;
  const to = (input as { to?: unknown }).to;
  return typeof to === "string" && to.trim().toLowerCase() === "user";
}

/** 对用户说的那句话;不是对用户说话、或话是空的,给 null */
export function userMessageText(name: string | undefined, input: unknown): string | null {
  if (!isUserMessageCall(name, input)) return null;
  const text = (input as { text?: unknown }).text;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

/** 一条消息的有序片段;旧记录没有 parts 时按「文字 → 工具」兜底(同 AgentBubble 的 partsOf) */
function partsOf(m: Pick<ChatMessage, "parts" | "text" | "tools">): MessagePart[] {
  if (m.parts && m.parts.length > 0) return m.parts;
  const legacy: MessagePart[] = [];
  if (m.text) legacy.push({ kind: "text", text: m.text });
  for (const t of m.tools || []) legacy.push({ kind: "tool", ...t });
  return legacy;
}

export interface Saying {
  /** 在这一轮里的位置(片段下标),做 React key */
  key: string;
  text: string;
  /** 来自 send_message 还是来自文字回复 */
  from: "send_message" | "text";
}

const cache = new WeakMap<object, Saying[]>();

/** 这一轮气泡里要显示的话,按发生顺序。消息对象不可变,按对象缓存 */
export function sayingsOf(m: Pick<ChatMessage, "parts" | "text" | "tools">): Saying[] {
  const hit = cache.get(m);
  if (hit) return hit;
  const parts = partsOf(m);
  const said: Saying[] = [];
  parts.forEach((p, i) => {
    if (p.kind !== "tool" || p.ok === false) return;
    const text = userMessageText(p.name, p.input);
    if (text) said.push({ key: `s${i}`, text, from: "send_message" });
  });
  let out = said;
  if (!said.length) {
    out = [];
    let buf = "", start = -1;
    const flush = () => {
      if (buf.trim()) out.push({ key: `t${start}`, text: buf.trim(), from: "text" });
      buf = ""; start = -1;
    };
    parts.forEach((p, i) => {
      if (p.kind === "text") {
        if (start < 0) start = i;
        buf += p.text;
      } else if (p.kind === "tool") flush();
      // 思考、状态行不打断一句话
    });
    flush();
  }
  cache.set(m, out);
  return out;
}

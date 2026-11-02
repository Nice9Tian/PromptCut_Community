import type { ChatMessage, MessagePart } from "./types.ts";

/**
 * What the Agent says to the user: the bubble shows only these (user decision, 2026-10-20; the
 * user's words: "the bubble should only show what is being done (the harness may need to change,
 * e.g. adding a usage like send_message(user,xxx).)"). The operations done and the reports are in
 * "Agent operations" under the bubble (ActivityPanel.tsx).
 *
 * - If `send_message` (`to: "user"`) was called in a round, list their `text` in order;
 * - If it was never called and only text was replied, that text is shown as "what is being done"
 *   (adjacent text is merged into one sentence);
 * The two are not mixed: in a round where send_message was called, the text reply no longer goes
 * into the bubble (to see it, look under "Show thinking"), so the same sentence does not appear twice.
 *
 * A pure function that does not touch React, so that node can run the tests directly
 * (user-messages.test.mjs).
 */

/**
 * Strips each provider's tool name prefix (`mcp__promptcut__`, `promptcut.`), with the same rule as
 * bareToolName in chat/iconRuns.ts
 */
const bare = (name: string) => name.replace(/^mcp__.+?__/, "").replace(/^[\w-]+\.(?=\w)/, "");

/** Whether this tool call is "speaking to the user" (send_message to user) */
export function isUserMessageCall(name: string | undefined, input: unknown): boolean {
  if (!name || bare(name) !== "send_message" || !input || typeof input !== "object") return false;
  const to = (input as { to?: unknown }).to;
  return typeof to === "string" && to.trim().toLowerCase() === "user";
}

/** The sentence said to the user; null if it is not speaking to the user or the text is empty */
export function userMessageText(name: string | undefined, input: unknown): string | null {
  if (!isUserMessageCall(name, input)) return null;
  const text = (input as { text?: unknown }).text;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

/**
 * The ordered parts of a message; for old records without parts, fall back to "text → tools" (same
 * as partsOf in AgentBubble)
 */
function partsOf(m: Pick<ChatMessage, "parts" | "text" | "tools">): MessagePart[] {
  if (m.parts && m.parts.length > 0) return m.parts;
  const legacy: MessagePart[] = [];
  if (m.text) legacy.push({ kind: "text", text: m.text });
  for (const t of m.tools || []) legacy.push({ kind: "tool", ...t });
  return legacy;
}

export interface Saying {
  /** Its position in this round (part index), used as the React key */
  key: string;
  text: string;
  /** Whether it comes from send_message or from a text reply */
  from: "send_message" | "text";
}

const cache = new WeakMap<object, Saying[]>();

/**
 * The lines to show in this round's bubble, in order of occurrence. Message objects are immutable,
 * so the result is cached per object
 */
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
      // Thinking and status lines do not break up a sentence
    });
    flush();
  }
  cache.set(m, out);
  return out;
}

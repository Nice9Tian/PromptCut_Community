import type { ChatMessage, RunEvent } from './types';

type Parts = NonNullable<ChatMessage['parts']>;

/** 往有序片段里追加文字(接在末尾的文字片段后面,不新开一段) */
export function appendTextPart(parts: Parts | undefined, delta: string): Parts {
  const next = parts ? [...parts] : [];
  const last = next[next.length - 1];
  if (last && last.kind === "text") next[next.length - 1] = { kind: "text", text: last.text + delta };
  else next.push({ kind: "text", text: delta });
  return next;
}

/** 同上,但追加的是思考片段。思考和正文各自成段,不会互相吞并 */
export function appendThinkingPart(parts: Parts | undefined, delta: string): Parts {
  const next = parts ? [...parts] : [];
  const last = next[next.length - 1];
  if (last && last.kind === "thinking") next[next.length - 1] = { kind: "thinking", text: last.text + delta };
  else next.push({ kind: "thinking", text: delta });
  return next;
}

/** An event that only extends the reply text or the thinking text. */
export function isDeltaEvent(ev: RunEvent): boolean {
  return (ev.type === "text" || ev.type === "thinking") && !!(ev as { delta?: string }).delta;
}

/**
 * Apply queued delta events to one message, in arrival order.
 *
 * The streaming loop used to apply every delta as its own state update, so
 * the chat panel re-rendered and re-parsed the reply's Markdown once per
 * token. Batching them gives the same message as applying them one by one.
 * `record` is the trace recorder (recordTrace), injected so this stays pure.
 */
export function applyDeltas(message: ChatMessage, events: RunEvent[], record: (m: ChatMessage, ev: RunEvent) => ChatMessage): ChatMessage {
  let next = message;
  for (const ev of events) {
    next = record(next, ev);
    const delta = (ev as { delta?: string }).delta ?? "";
    if (!delta) continue;
    if (ev.type === "text") next = { ...next, text: next.text + delta, parts: appendTextPart(next.parts, delta) };
    else if (ev.type === "thinking") next = { ...next, parts: appendThinkingPart(next.parts, delta) };
  }
  return next;
}

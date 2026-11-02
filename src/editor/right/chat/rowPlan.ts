import type { ChatMessage, InboundAgentMessage } from "../../../ai/types.ts";

/**
 * What each message in the chat list is drawn as (used by MessageList.tsx). A pure function, so node
 * can run the tests directly (row-plan.test.mjs).
 *
 * Each turn's reply draws its own bubble, right after the user message that started it (2026-10-20).
 * Previously, in concise mode, "a reply that didn't submit this turn's summary, the next turn keeps
 * accumulating in its bubble": one reply without a summary (for example one that failed before the
 * first event, the failure reply the page fills in from the queue's final state) would swallow the
 * following turns, so the new turn's thinking, icons and this turn's summary were drawn in the old
 * bubble, above the later user messages
 * (reproduced in production on 2026-10-20, project "Acceptance 018-Claude", chat cc-mvfhwi2p-xi4o).
 * The bubble now holds only what the Agent says, and operations moved below the bubble into "Agent
 * operations", shown per turn; merging is no longer useful, so it was removed.
 */

export interface InboundPlan {
  /** Assistant message id → the messages from other Agents it received before (those undrawn user messages joined together) */
  inboundFor: Map<string, { list: InboundAgentMessage[]; key: string }>;
  /** A user message that holds only other Agents' messages: no user bubble is drawn */
  inboundOnly: Set<string>;
  /** Nothing follows yet for them to attach to a reply: leave a line of small text at the position of the last one, the value is the count */
  orphanNote: Map<string, number>;
}

/**
 * Messages sent by other Agents (when AiPanel delivers automatically it carries an inbound field on the
 * user message, rather than recognizing them by a body prefix) are not things the user said:
 * no user bubble is drawn; they are handed to the Agent reply that follows, shown in "Agent operations"
 * as "Message received". If no reply follows yet to attach to, a line of small text is left in place.
 */
export function inboundPlan(messages: readonly ChatMessage[]): InboundPlan {
  const inboundFor = new Map<string, { list: InboundAgentMessage[]; key: string }>();
  const inboundOnly = new Set<string>();
  const orphanNote = new Map<string, number>();
  let pending: { list: InboundAgentMessage[]; ids: string[] } | null = null;
  const dropPending = () => {
    if (pending) orphanNote.set(pending.ids[pending.ids.length - 1], pending.list.length);
    pending = null;
  };
  for (const m of messages) {
    if (m.role === "user") {
      const got = m.inbound?.length ? m.inbound : null;
      if (!got) {
        dropPending();
        continue;
      }
      inboundOnly.add(m.id);
      pending = pending ? { list: [...pending.list, ...got], ids: [...pending.ids, m.id] } : { list: got, ids: [m.id] };
    } else if (pending) {
      inboundFor.set(m.id, { list: pending.list, key: pending.ids.join(",") });
      pending = null;
    }
  }
  dropPending();
  return { inboundFor, inboundOnly, orphanNote };
}

export interface PlannedRow {
  id: string;
  kind: "user" | "assistant" | "note";
  /** note: some messages from other Agents were received and no reply is available to attach to yet */
  count?: number;
}

/** Lay out each drawn row in message order: one row per user message, one per reply (not merged); a user message holding only other Agents' messages becomes small text or is not drawn */
export function rowPlan(messages: readonly ChatMessage[], plan: InboundPlan = inboundPlan(messages)): PlannedRow[] {
  const rows: PlannedRow[] = [];
  for (const m of messages) {
    if (plan.inboundOnly.has(m.id)) {
      const n = plan.orphanNote.get(m.id);
      if (n) rows.push({ id: m.id, kind: "note", count: n });
      continue;
    }
    rows.push({ id: m.id, kind: m.role === "user" ? "user" : "assistant" });
  }
  return rows;
}

/** Which user message this turn's reply is answering: look backwards for the nearest drawn user message */
export function promptOf(messages: readonly ChatMessage[], assistantId: string, plan?: InboundPlan): ChatMessage | null {
  const i = messages.findIndex((m) => m.id === assistantId);
  for (let j = i - 1; j >= 0; j--) {
    const m = messages[j];
    if (m.role === "user" && !(plan?.inboundOnly.has(m.id) ?? m.inbound?.length)) return m;
  }
  return null;
}

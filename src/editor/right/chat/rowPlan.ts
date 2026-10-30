import type { ChatMessage, InboundAgentMessage } from "../../../ai/types.ts";

/**
 * 对话列表里每条消息画成什么(MessageList.tsx 用)。纯函数,好让 node 直接跑测试(row-plan.test.mjs)。
 *
 * 每一轮的回复各画各的气泡,紧跟在发起它的那条用户消息后面(2026-10-20)。
 * 原先简洁模式下「没交本轮小结的回复,下一轮接着累计在它的气泡里」:一条没交小结的回复(例如第一个事件前就失败、
 * 页面按队列终态补的那条失败回复)会把后面几轮全吞进去,新一轮的思考、图标和本轮小结画在旧气泡里、排在后面几条用户消息上面
 * (2026-10-20 生产复现,项目「验收018-Claude」对话 cc-mvfhwi2p-xi4o)。气泡现在只放 Agent 说的话,操作挪到了气泡下面的
 * 「Agent 操作」里按轮显示,合并已经没有用处,去掉。
 */

export interface InboundPlan {
  /** 助手消息 id → 它之前收到的其他 Agent 的消息(那几条不画出来的用户消息拼起来) */
  inboundFor: Map<string, { list: InboundAgentMessage[]; key: string }>;
  /** 只装着其他 Agent 消息的用户消息:不画用户气泡 */
  inboundOnly: Set<string>;
  /** 后面还没有回复可挂的:在最后那条的位置留一行小字,值是条数 */
  orphanNote: Map<string, number>;
}

/**
 * 其他 Agent 发来的消息(AiPanel 自动投递时在用户消息上带着 inbound 字段,不靠正文前缀认)不是用户说的话:
 * 不画用户气泡,交给紧跟着的那条 Agent 回复,在「Agent 操作」里当「收到消息」展示。后面暂时还没有回复可挂的,在原位留一行小字。
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
  /** note:收到几条其他 Agent 的消息、还没有回复可挂 */
  count?: number;
}

/** 按消息顺序排出画出来的每一行:每条用户消息一行、每条回复一行(不合并),只装其他 Agent 消息的用户消息换成小字或不画 */
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

/** 这一轮的回复是在回哪条用户消息:往前找最近的、画出来的那条用户消息 */
export function promptOf(messages: readonly ChatMessage[], assistantId: string, plan?: InboundPlan): ChatMessage | null {
  const i = messages.findIndex((m) => m.id === assistantId);
  for (let j = i - 1; j >= 0; j--) {
    const m = messages[j];
    if (m.role === "user" && !(plan?.inboundOnly.has(m.id) ?? m.inbound?.length)) return m;
  }
  return null;
}

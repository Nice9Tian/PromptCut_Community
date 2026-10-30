import { addSpawnedTab, findTabByConversation, getTabs, setScopeByConversation, setTabUnread, subscribeTabs } from "./agentTabs.ts";
import { normalizeCreativity } from "../kernel/creativity.mjs";
export { diffScopes } from "../kernel/agentScopes.mjs";

/**
 * 多 Agent 公告板的页面一侧(计划 agent-workflow-plan.md A3)。
 *
 * 公告板本身在编辑器进程里(`server/agent/agent-board.mjs`,按项目一份):范围声明、改动记录、信箱都在那边,
 * `declare_scope` / `list_agents` / `send_message` / `check_messages` 由服务端答,所有 Agent 看到同一份。
 * 这里只做页面该做的:
 *   1. 收 SSE 推来的 `agent.board`(各对话的范围、未读、可自动投递的条数):页签名跟着范围改,页签上标未读;
 *   2. 把页签(对话 ID、页签名、忙不忙)报给服务端(`POST /api/agent/tabs`),公告板的名单与子 Agent 并发名额用;
 *   3. 这一页空闲时取走投给它的消息(`POST /api/agent/inbox`),由 AiPanel 作为一条用户消息发出;
 *   4. 收 SSE 推来的 `agent.spawn`(`spawn_agent` 拉起子 Agent):开一个带角色名的新页签,回 `POST /api/agent/spawned`。
 *
 * 在线构建没有编辑器进程,这些请求一律不发(AiPanel 在在线构建里也不挂)。
 */

const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

export interface AgentMessage {
  from: string | null;
  fromLabel?: string;
  text: string;
  /** 自动投递的层数:A 的消息自动触发 B 跑,B 跑时发给 A 的消息就是下一层。封顶,防止两个 Agent 无限对聊 */
  hops: number;
  at?: number;
}

/** 自动投递最多连锁几层(与服务端 BOARD_DEFAULTS.MAX_AUTO_HOPS 相同) */
export const MAX_AUTO_HOPS = 3;

interface BoardEntry {
  id: string;
  scope: string | null;
  unread: number;
  deliverable: number;
  busy: boolean;
  remote?: boolean;
  member?: string;
  live?: boolean;
}

let board = new Map<string, BoardEntry>();
const listeners = new Set<() => void>();

function emit() {
  for (const fn of [...listeners]) fn();
}

export function subscribeBus(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** SSE `agent.board`:整份替换;页签名跟着范围改,页签上标未读 */
export function applyBoard(agents: unknown): void {
  if (!Array.isArray(agents)) return;
  const next = new Map<string, BoardEntry>();
  for (const a of agents) {
    if (!a || typeof a !== "object" || typeof (a as BoardEntry).id !== "string") continue;
    const e = a as BoardEntry;
    next.set(e.id, { id: e.id, scope: typeof e.scope === "string" ? e.scope : null, unread: Number(e.unread) || 0, deliverable: Number(e.deliverable) || 0, busy: !!e.busy, ...(e.remote ? { remote: true, member: e.member, live: e.live !== false } : {}) });
  }
  board = next;
  for (const e of next.values()) {
    const tab = findTabByConversation(e.id);
    if (!tab) continue;
    if (tab.scope !== e.scope) setScopeByConversation(e.id, e.scope);
    setTabUnread(tab.id, e.unread);
  }
  emit();
}

/** 共享项目里别的成员那边的 Agent(经文档服务转来的,在线的):AI 栏里列出它们的范围 */
export function remoteAgents(): BoardEntry[] {
  return [...board.values()].filter((e) => e.remote && e.live !== false);
}

/** 取走了、但那一刻页面又忙了的消息:放回页面这边,下次空闲时先送它们 */
const stashed = new Map<string, AgentMessage[]>();

export function stash(conversationId: string, msgs: AgentMessage[]): void {
  if (!msgs.length) return;
  stashed.set(conversationId, [...(stashed.get(conversationId) ?? []), ...msgs]);
}

export function hasAutoDeliverable(conversationId: string): boolean {
  return (stashed.get(conversationId)?.length ?? 0) > 0 || (board.get(conversationId)?.deliverable ?? 0) > 0;
}

let taking = false;
/** 取走投给这一页的消息;onlyAuto 只取层数没到顶的。同一时刻只取一次 */
export async function takeInbox(conversationId: string, onlyAuto = true): Promise<AgentMessage[]> {
  const held = stashed.get(conversationId);
  if (held?.length) {
    stashed.delete(conversationId);
    return held;
  }
  if (ONLINE_BUILD || taking) return [];
  taking = true;
  try {
    const res = await fetch("/api/agent/inbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, onlyAuto }),
    });
    const data = await res.json().catch(() => null);
    const list = Array.isArray(data?.messages) ? data.messages : [];
    const e = board.get(conversationId);
    if (e && list.length) board.set(conversationId, { ...e, deliverable: 0 });
    return list.filter((m: any) => m && typeof m.text === "string").map((m: any) => ({ from: typeof m.from === "string" ? m.from : null, ...(typeof m.fromLabel === "string" ? { fromLabel: m.fromLabel } : {}), text: m.text, hops: Number(m.hops) || 1, at: m.at }));
  } catch {
    return [];
  } finally {
    taking = false;
  }
}

/** 把「来自别的 Agent 的消息」排成一条用户消息的正文 */
export function formatInbound(msgs: AgentMessage[]): string {
  return msgs
    .map((m) => `【来自 ${m.fromLabel ?? `Agent ${m.from ?? "未知"}`} 的消息】\n${m.text}`)
    .join("\n\n");
}

/* ---------------- 页签报给服务端 ---------------- */

let tabsTimer: ReturnType<typeof setTimeout> | null = null;
let lastSent = "";
function sendTabs() {
  tabsTimer = null;
  const tabs = getTabs()
    .filter((t) => t.conversationId)
    .map((t) => ({ conversationId: t.conversationId, title: t.title, busy: t.busy }));
  const body = JSON.stringify({ tabs });
  if (body === lastSent) return;
  lastSent = body;
  fetch("/api/agent/tabs", { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => { lastSent = ""; });
}

/** 页签变了就报(合并 100 ms 内的多次变化);回停止函数。SSE 重连后调 `resendTabs` 再报一次 */
export function startTabReports(): () => void {
  if (ONLINE_BUILD) return () => {};
  const schedule = () => { if (!tabsTimer) tabsTimer = setTimeout(sendTabs, 100); };
  schedule();
  const off = subscribeTabs(schedule);
  return () => { off(); if (tabsTimer) clearTimeout(tabsTimer); tabsTimer = null; };
}

export function resendTabs(): void {
  if (ONLINE_BUILD) return;
  lastSent = "";
  if (!tabsTimer) tabsTimer = setTimeout(sendTabs, 50);
}

/* ---------------- spawn_agent:开子 Agent 的页签 ---------------- */

/** SSE `agent.spawn`:开一个带角色名的新页签,回话给服务端 */
export async function handleSpawn(ev: any): Promise<void> {
  const reqId = typeof ev?.reqId === "string" ? ev.reqId : null;
  let ok = false;
  let error: string | undefined;
  try {
    if (typeof ev?.conversationId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(ev.conversationId)) throw new Error("对话 ID 不合法");
    addSpawnedTab({
      conversationId: ev.conversationId,
      role: String(ev.role ?? ""),
      roleName: String(ev.roleName ?? ev.role ?? "子 Agent"),
      parent: String(ev.parent ?? ""),
      provider: typeof ev.provider === "string" && ev.provider ? ev.provider : null,
      creativity: normalizeCreativity(ev.creativity),
    });
    ok = true;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  if (!reqId || ONLINE_BUILD) return;
  await fetch("/api/agent/spawned", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reqId, ok, ...(error ? { error } : {}) }),
  }).catch(() => {});
  if (ok) resendTabs();
}

/** 只给测试用 */
export function _resetBus(): void {
  board = new Map();
}

import { addSpawnedTab, findTabByConversation, getTabs, setScopeByConversation, setTabUnread, subscribeTabs } from "./agentTabs.ts";
import { normalizeCreativity } from "../kernel/creativity.mjs";
import { tr } from "../i18n/index.ts";
export { diffScopes } from "../kernel/agentScopes.mjs";

/**
 * Page side of the multi-Agent bulletin board (plan agent-workflow-plan.md A3).
 *
 * The bulletin board itself lives in the editor process (`server/agent/agent-board.mjs`, one per project): scope declarations, change records, and mailboxes are all there,
 * with `declare_scope` / `list_agents` / `send_message` / `check_messages` answered by the server, so all Agents see the same copy.
 * Here we only handle what the page should do:
 *   1. Receive `agent.board` pushed via SSE (scopes of each chat, unread count, number of auto-deliverable messages): tab names update with scopes, tabs mark unread;
 *   2. Report tabs (chat ID, tab name, busy state) to the server (`POST /api/agent/tabs`), used for the bulletin board list and subagent concurrency quotas;
 *   3. When this page is idle, fetch messages delivered to it (`POST /api/agent/inbox`), sent by AiPanel as a user message;
 *   4. Receive `agent.spawn` pushed via SSE (`spawn_agent` launches a subagent): open a new tab with the role name and reply with `POST /api/agent/spawned`.
 *
 * Online builds do not have an editor process, so none of these requests are sent (AiPanel is also not mounted in online builds).
 */

const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

export interface AgentMessage {
  from: string | null;
  fromLabel?: string;
  text: string;
  /** Number of auto-delivery hops: A's message automatically triggers B to run, and the message sent to A while B runs is the next hop. Capped to prevent two Agents from chatting infinitely */
  hops: number;
  at?: number;
}

/** Maximum auto-delivery chaining hops (same as server BOARD_DEFAULTS.MAX_AUTO_HOPS) */
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

/** SSE `agent.board`: replace entirely; tab names update with scopes, tabs mark unread */
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

/** Agents from other members in shared projects (forwarded via document service, online): lists their scopes in the AI panel */
export function remoteAgents(): BoardEntry[] {
  return [...board.values()].filter((e) => e.remote && e.live !== false);
}

/** Messages that were fetched but the page became busy at that moment: released back to the page side, delivered first next time it becomes idle */
const stashed = new Map<string, AgentMessage[]>();

export function stash(conversationId: string, msgs: AgentMessage[]): void {
  if (!msgs.length) return;
  stashed.set(conversationId, [...(stashed.get(conversationId) ?? []), ...msgs]);
}

export function hasAutoDeliverable(conversationId: string): boolean {
  return (stashed.get(conversationId)?.length ?? 0) > 0 || (board.get(conversationId)?.deliverable ?? 0) > 0;
}

let taking = false;
/** Fetch messages delivered to this page; onlyAuto only fetches those whose hop count has not reached the cap. Only fetched once at any given time */
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

/** Formats "messages from other Agents" into the body of a user message */
export function formatInbound(msgs: AgentMessage[]): string {
  return msgs
    .map((m) => tr("[Message from {0}]\n{1}", m.fromLabel ?? `Agent ${m.from ?? tr("unknown")}`, m.text))
    .join("\n\n");
}

/* ---------------- Report tabs to the server ---------------- */

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

/** Reports when tabs change (debounces multiple changes within 100 ms); returns a stop function. Call `resendTabs` to report again after SSE reconnects */
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

/* ---------------- spawn_agent: open subagent tabs ---------------- */

/** SSE `agent.spawn`: opens a new tab with the role name and replies to the server */
export async function handleSpawn(ev: any): Promise<void> {
  const reqId = typeof ev?.reqId === "string" ? ev.reqId : null;
  let ok = false;
  let error: string | undefined;
  try {
    if (typeof ev?.conversationId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(ev.conversationId)) throw new Error(tr("Invalid chat ID"));
    addSpawnedTab({
      conversationId: ev.conversationId,
      role: String(ev.role ?? ""),
      roleName: String(ev.roleName ?? ev.role ?? tr("Sub-Agent")),
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

/** For testing only */
export function _resetBus(): void {
  board = new Map();
}

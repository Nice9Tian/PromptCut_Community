import { useSyncExternalStore } from "react";
import { MAIN_TAB, dropChatStore, getChatStore } from "./liveChat.ts";
import { normalizeCreativity, type CreativityLevel } from "../kernel/creativity.mjs";

/**
 * Tabs for the AI assistant panel: each tab is an independent Agent chat that can run concurrently.
 *
 * Tab identity has two layers:
 *   - tabId: key used internally by the page (store, localStorage suffix), shaped like "projectID_agentID" (`tabIdOf`);
 *   - conversationId: session archive id for this tab (managed by useChatHistory). **This is the
 *     "Agent chat ID" shown to the model**: recipients in send_message and "who changed it" in scope changes use it,
 *     and the full chat can be retrieved from history by it.
 *
 * The tab manifest is **separated per project** ((user decision, 2026-10-22), `workflow/editing.md` "Agent tabs in the AI panel"):
 * one copy per project, stored in localStorage `pc.agentTabs:<projectID>`, restored after page refresh or reopening a project; displayed in the UI as Agent 1, Agent 2…
 * (numbers take the smallest available slot within this project), and tab tokens in code are "projectID_agentID". Switching to another project replaces the AI panel with that project's own manifest.
 *
 * Every tab can be closed, including the last one. When there are **no tabs at all** (just entered the project, or the user closed all sessions), no real tabs are kept in the manifest;
 * externally, a "start page" is provided: a placeholder tab with `draft: true`, whose id is the id of the first session created after the user clicks send on the start page (`commitDraft`),
 * so when the placeholder tab becomes a real tab, items on the rail and page nodes do not change. Before clicking send, it is not stored and sends no requests.
 * "User manually closed all sessions" (`cleared`) is tracked per project: projects where sessions have never been cleared all show a guide animation on the start page; cleared ones only show presets and the input box.
 */
export interface AgentTab {
  id: string;
  conversationId: string | null;
  /** User-visible name; before declaring a scope it is "Agent N" */
  title: string;
  /** The N in "Agent N": takes the lowest unoccupied number upon creation and does not change when closing other tabs; subagent tabs (with role names) do not have this */
  num?: number;
  /** Modification scope declared by the Agent via declare_scope, such as "Cut 1->Track 2" */
  scope: string | null;
  /** Currently running (streaming response in progress) */
  busy: boolean;
  /** Count of pending messages from other Agents not yet delivered (marked on the tab) */
  unread: number;
  createdAt: number;
  /**
   * Creativity level set individually for this chat (`kernel/creativity.mjs`); null = follow project default level.
   * Stored only in local tabs (plan agent-workflow-plan.md Section 4 Item 3), not included in the project document; sent to the server with each chat request.
   */
  creativity: CreativityLevel | null;
  /**
   * Multi-Agent (plan agent-workflow-plan.md A3): subagents spawned by `spawn_agent` carry a preset role (id and Chinese name), parent chat ID,
   * and inherit the driver of the parent chat upon launch (`provider`, preselected in this tab's driver dropdown). Lead chats and user-opened tabs are all null.
   */
  role?: string | null;
  roleName?: string | null;
  parent?: string | null;
  provider?: string | null;
  /** Start page placeholder: this project has no sessions yet, and send has not been clicked. Not written to storage, not a real Agent */
  draft?: boolean;
}

export interface TabsState {
  projectId: string;
  /** Real tabs; when there are no tabs at all, a `draft` placeholder tab (start page) is placed */
  tabs: AgentTab[];
  activeId: string;
  /** Whether the user has manually closed all sessions in this project; only start pages where sessions were never completely closed (just entered the project) carry the guide animation */
  cleared: boolean;
}

/** Name used when there is no project (embeds that do not read manifests, like unit tests or mobile app); kept in memory only, not written to storage */
const NO_PROJECT = "none";
const START_AGENT = "start";
const KEY_PREFIX = "pc.agentTabs:";
const storageKey = (projectId: string) => `${KEY_PREFIX}${projectId}`;

/** Internal tab id: "projectID_agentID" */
export function tabIdOf(projectId: string, agentId: string): string {
  return `${projectId}_${agentId}`;
}

function newAgentId(): string {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/** Legacy data did not store numbers: recognized from the "Agent N" name; assigned by position if renamed without a role; subagent tabs do not have one */
function tabNumber(t: Partial<AgentTab>, i: number): number | undefined {
  if (typeof t.num === "number" && t.num > 0) return t.num;
  const m = typeof t.title === "string" ? /^Agent (\d+)$/.exec(t.title) : null;
  if (m) return Number(m[1]);
  return t.roleName ? undefined : i + 1;
}

/** Lowest currently unoccupied "Agent N" number */
function smallestFreeNum(tabs: readonly AgentTab[]): number {
  const used = new Set(tabs.map((t) => t.num));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/** A project's manifest (complete in-memory form) */
interface Rec {
  tabs: AgentTab[];
  activeId: string;
  cleared: boolean;
  /**
   * AgentID for the next session: used by the id of the start page placeholder tab, inherited by the first session created after clicking send.
   * When the project has never had real tabs, it is fixed as "start" (not written to storage, remains the same on reopen, avoiding leaving a string of keys on every refresh); after all tabs are closed, it switches to a random id without reusing old ids.
   */
  nextAgentId: string;
  /** Start page placeholder tab (cached, stable reference; creativity level modified on the start page is recorded here and passed along when clicking send) */
  draft: AgentTab | null;
}

function persistable(t: AgentTab) {
  const { id, conversationId, title, num, scope, createdAt, creativity, role, roleName, parent, provider } = t;
  return { id, conversationId, title, num, scope, createdAt, creativity, role, roleName, parent, provider };
}

function readRec(projectId: string): Rec | null {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return null;
    const j = JSON.parse(raw) as { tabs?: Partial<AgentTab>[]; active?: string; cleared?: boolean; nextAgentId?: string };
    const arr = Array.isArray(j.tabs) ? j.tabs : [];
    const tabs: AgentTab[] = arr
      .filter((t) => typeof t.id === "string" && t.id)
      .map((t, i) => ({
        id: t.id!,
        conversationId: typeof t.conversationId === "string" ? t.conversationId : null,
        title: typeof t.title === "string" && t.title ? t.title : `Agent ${i + 1}`,
        num: tabNumber(t, i),
        scope: typeof t.scope === "string" ? t.scope : null,
        busy: false,
        unread: 0,
        createdAt: typeof t.createdAt === "number" ? t.createdAt : Date.now(),
        creativity: normalizeCreativity(t.creativity),
        role: typeof t.role === "string" ? t.role : null,
        roleName: typeof t.roleName === "string" ? t.roleName : null,
        parent: typeof t.parent === "string" ? t.parent : null,
        provider: typeof t.provider === "string" ? t.provider : null,
      }));
    const active = typeof j.active === "string" && tabs.some((t) => t.id === j.active) ? j.active : tabs[0]?.id ?? "";
    return {
      tabs,
      activeId: active,
      cleared: j.cleared === true,
      nextAgentId: typeof j.nextAgentId === "string" && /^[A-Za-z0-9]{1,32}$/.test(j.nextAgentId) ? j.nextAgentId : newAgentId(),
      draft: null,
    };
  } catch {
    return null; // Storage unavailable / corrupted: treat as if this project was never saved
  }
}

function writeRec(projectId: string, rec: Rec) {
  // Do not write if there is no project or the project is still "freshly entered with nothing done" (no real tabs, never closed all sessions):
  // temporary empty projects on editor startup and opened projects where no messages were sent do not leave keys in storage
  if (projectId === NO_PROJECT || (rec.tabs.length === 0 && !rec.cleared)) return;
  try {
    localStorage.setItem(
      storageKey(projectId),
      JSON.stringify({ v: 2, tabs: rec.tabs.map(persistable), active: rec.activeId, cleared: rec.cleared, nextAgentId: rec.nextAgentId }),
    );
  } catch {
    /* Ignore: allow this session to take effect even if saving fails */
  }
}

const recs = new Map<string, Rec>();
let projectId = NO_PROJECT;
let state: TabsState;
const listeners = new Set<() => void>();

/** When switching to a new project next time, if the new project's .proc contains a chat (the old project's lead chat), add a tab for it (see noteProjectChatApplied) */
let pendingMain = false;

function draftOf(rec: Rec): AgentTab {
  if (!rec.draft || rec.draft.id !== tabIdOf(projectId, rec.nextAgentId)) {
    rec.draft = { id: tabIdOf(projectId, rec.nextAgentId), conversationId: null, title: "Agent 1", num: 1, scope: null, busy: false, unread: 0, createdAt: 0, creativity: null, draft: true };
  }
  return rec.draft;
}

function cur(): Rec {
  let rec = recs.get(projectId);
  if (!rec) {
    rec = (projectId !== NO_PROJECT ? readRec(projectId) : null) ?? { tabs: [], activeId: "", cleared: false, nextAgentId: START_AGENT, draft: null };
    recs.set(projectId, rec);
  }
  return rec;
}

function snapshot(): TabsState {
  const rec = cur();
  if (rec.tabs.length === 0) {
    const d = draftOf(rec);
    return { projectId, tabs: [d], activeId: d.id, cleared: rec.cleared };
  }
  const activeId = rec.tabs.some((t) => t.id === rec.activeId) ? rec.activeId : rec.tabs[0].id;
  return { projectId, tabs: rec.tabs, activeId, cleared: rec.cleared };
}

state = snapshot();

/** After modifying rec: write to disk, regenerate external snapshot, notify subscribers */
function commit(save = true) {
  const rec = cur();
  if (save) writeRec(projectId, rec);
  state = snapshot();
  for (const fn of listeners) fn();
}

function patchTab(id: string, patch: Partial<AgentTab>) {
  const rec = cur();
  if (rec.draft && rec.draft.id === id && rec.tabs.length === 0) {
    // Changes made on the start page (creativity level) are recorded on the placeholder tab without writing to disk, passed along when clicking send
    rec.draft = { ...rec.draft, ...patch };
    commit(false);
    return;
  }
  if (!rec.tabs.some((t) => t.id === id)) return;
  rec.tabs = rec.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t));
  commit();
}

/* ---------------- Project ---------------- */

/**
 * Switch to a project's manifest (if none exists, create an empty one as "never saved": start page, with guide animation).
 * Called by `agentTabsProject.ts` watching the project id in the editor store; calling repeatedly for the same project only refreshes the "pending lead chat replenishment" flag.
 *
 * When a project's .proc contains a chat (legacy "lead chat", calls `noteProjectChatApplied` when hydrated by `projectAi.applyProjectAi`)
 * and this project does not have its own manifest yet, add a tab "projectID_main" to catch it, so legacy chats do not become invisible due to split manifests.
 */
export function setAgentProject(id: string | null | undefined): void {
  const next = id && typeof id === "string" ? id : NO_PROJECT;
  const adopt = pendingMain;
  pendingMain = false;
  if (next === projectId && recs.has(next)) return;
  projectId = next;
  const fresh = !recs.has(next) && (next === NO_PROJECT || (() => { try { return localStorage.getItem(storageKey(next)) === null; } catch { return true; } })());
  const rec = cur();
  if (fresh && adopt && rec.tabs.length === 0) {
    const main: AgentTab = { id: tabIdOf(next, MAIN_TAB), conversationId: null, title: "Agent 1", num: 1, scope: null, busy: false, unread: 0, createdAt: Date.now(), creativity: null };
    rec.tabs = [main];
    rec.activeId = main.id;
    // Legacy lead chat archive id is stored in global key pcChatId; adopt it so the segment in the archive can still connect
    try {
      const legacy = localStorage.getItem("pcChatId");
      if (legacy && localStorage.getItem(`pcChatId:${main.id}`) === null) localStorage.setItem(`pcChatId:${main.id}`, legacy);
    } catch { /* Ignore */ }
  }
  commit(next !== NO_PROJECT);
}

export function getAgentProjectId(): string {
  return projectId;
}

/**
 * The project chat (`ai.messages` in .proc) was just hydrated into the lead chat store.
 * Hydrating the chat happens before switching projects; record a note here: if the subsequent `setAgentProject` finds that the new project has no manifest yet, add a tab to catch this chat.
 */
export function noteProjectChatApplied(hasMessages: boolean): void {
  pendingMain = hasMessages;
}

/* ---------------- Read ---------------- */

export function getTabs(): AgentTab[] {
  return state.tabs;
}

/** Real tabs (excluding start page placeholder) */
export function getRealTabs(): AgentTab[] {
  return state.tabs.filter((t) => !t.draft);
}

export function getActiveTabId(): string {
  return state.activeId;
}

/** Whether this project has real tabs; if not, it is on the start page */
export function hasRealTabs(): boolean {
  return cur().tabs.length > 0;
}

/** Has the user manually closed all sessions in this project (determines whether to show the guide animation on the start page) */
export function isCleared(): boolean {
  return state.cleared;
}

export function isDraftTab(id: string): boolean {
  return state.tabs.some((t) => t.id === id && t.draft === true);
}

/* ---------------- Add, close, switch ---------------- */

/**
 * Open a new tab ("+"). When this project has no tabs at all, "+" simply returns to the start page: returns the placeholder tab without creating a real tab (real tabs are created when clicking send on the start page).
 */
export function addTab(): AgentTab {
  const rec = cur();
  if (rec.tabs.length === 0) return draftOf(rec);
  const n = smallestFreeNum(rec.tabs);
  const tab: AgentTab = {
    id: tabIdOf(projectId, newAgentId()),
    conversationId: null,
    title: `Agent ${n}`,
    num: n,
    scope: null,
    busy: false,
    unread: 0,
    createdAt: Date.now(),
    creativity: null,
  };
  rec.tabs = [...rec.tabs, tab];
  rec.activeId = tab.id;
  commit();
  return tab;
}

/**
 * User clicked send on the start page: turns the placeholder tab into the project's first real tab (Agent 1, inheriting the placeholder tab's id and the creativity level set on the start page).
 * If already a real tab (or not a placeholder tab), returns that existing tab.
 */
export function commitDraft(id: string): AgentTab | null {
  const rec = cur();
  const hit = rec.tabs.find((t) => t.id === id);
  if (hit) return hit;
  if (rec.tabs.length > 0 || !rec.draft || rec.draft.id !== id) return null;
  const { draft: _d, ...rest } = rec.draft;
  const tab: AgentTab = { ...rest, createdAt: Date.now() };
  rec.tabs = [tab];
  rec.activeId = tab.id;
  rec.nextAgentId = newAgentId();
  rec.draft = null;
  commit();
  return tab;
}

/**
 * Open a tab for a subagent spawned by `spawn_agent` (A3): chat ID is determined by the server (= its new identity) and written in advance into this tab's session id key,
 * which useChatHistory reads when the page mounts; does not steal focus from the current tab. If a tab already exists for the same chat ID, returns that tab.
 */
export function addSpawnedTab(spec: { conversationId: string; role: string; roleName: string; parent: string; provider: string | null; creativity: CreativityLevel | null }): AgentTab {
  const rec = cur();
  const hit = rec.tabs.find((t) => t.conversationId === spec.conversationId);
  if (hit) return hit;
  const id = tabIdOf(projectId, newAgentId());
  try {
    localStorage.setItem(`pcChatId:${id}`, spec.conversationId);
  } catch {
    /* If saving fails, useChatHistory creates another id; the chat ID on the tab is still correct in the copy below */
  }
  const same = rec.tabs.filter((t) => t.roleName === spec.roleName).length;
  const tab: AgentTab = {
    id,
    conversationId: spec.conversationId,
    title: same ? `${spec.roleName} ${same + 1}` : spec.roleName,
    scope: null,
    busy: false,
    unread: 0,
    createdAt: Date.now(),
    creativity: normalizeCreativity(spec.creativity),
    role: spec.role,
    roleName: spec.roleName,
    parent: spec.parent,
    provider: spec.provider,
  };
  // When this project is still on the start page (no real tabs), the subagent tab becomes the first real tab, activate it
  rec.tabs = [...rec.tabs, tab];
  if (rec.tabs.length === 1) rec.activeId = tab.id;
  rec.nextAgentId = rec.tabs.length === 1 ? newAgentId() : rec.nextAgentId;
  commit();
  return tab;
}

/** Driver determined when this tab was launched (subagents inherit from parent chat); returns null if none */
export function getTabProvider(id: string): string | null {
  return state.tabs.find((x) => x.id === id)?.provider ?? null;
}

/** Whether this tab can still be closed: every real tab can be closed (including the last one); start page placeholder tab has nothing to close */
export function canCloseTab(id: string): boolean {
  return cur().tabs.some((t) => t.id === id);
}

/**
 * Close tab. Every real tab can be closed, including the last one; if the closed tab is current,
 * switch to the tab on its left (if it is leftmost, switch to the one on its right).
 * Once all tabs are closed, this project returns to the start page and records "user manually
 * closed all" (recorded per project); subsequent start pages do not show the intro animation.
 * The chat store for the project's built-in lead chat ("projectId_main") is the copy persisted
 * with the project and is not destroyed; clear it when closing to avoid invisibly keeping a chat
 * that no one watches.
 */
export function closeTab(id: string): void {
  const rec = cur();
  const idx = rec.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const tabs = rec.tabs.filter((t) => t.id !== id);
  const wasActive = rec.activeId === id;
  if (isMainId(id)) getChatStore(MAIN_TAB).replace([]);
  else dropChatStore(id);
  rec.tabs = tabs;
  if (tabs.length === 0) {
    rec.cleared = true;
    rec.activeId = "";
    rec.nextAgentId = newAgentId();
    rec.draft = null;
  } else if (wasActive) {
    rec.activeId = tabs[Math.max(0, idx - 1)].id;
  }
  commit();
}

function isMainId(id: string): boolean {
  return id === MAIN_TAB || id.endsWith(`_${MAIN_TAB}`);
}

export function activateTab(id: string): void {
  const rec = cur();
  if (rec.activeId === id || !rec.tabs.some((t) => t.id === id)) return;
  rec.activeId = id;
  commit();
}

export function setTabConversation(id: string, conversationId: string | null): void {
  const t = cur().tabs.find((x) => x.id === id);
  if (!t || t.conversationId === conversationId) return;
  patchTab(id, { conversationId });
}

export function setTabBusy(id: string, busy: boolean): void {
  const t = cur().tabs.find((x) => x.id === id);
  if (!t || t.busy === busy) return;
  patchTab(id, { busy });
}

/** Set creativity level for this tab individually; null = fall back to following project */
export function setTabCreativity(id: string, creativity: CreativityLevel | null): void {
  const t = state.tabs.find((x) => x.id === id);
  const next = normalizeCreativity(creativity);
  if (!t || t.creativity === next) return;
  patchTab(id, { creativity: next });
}

export function getTabCreativity(id: string): CreativityLevel | null {
  return state.tabs.find((x) => x.id === id)?.creativity ?? null;
}

export function setTabUnread(id: string, unread: number): void {
  const t = cur().tabs.find((x) => x.id === id);
  if (!t || t.unread === unread) return;
  patchTab(id, { unread });
}

/** Agent declared scope: tab name changes accordingly, so users can see at a glance which tab is editing where */
export function setScopeByConversation(conversationId: string, scope: string | null): AgentTab | null {
  const tabs = cur().tabs;
  const t = tabs.find((x) => x.conversationId === conversationId);
  if (!t) return null;
  const idx = tabs.indexOf(t);
  if (t.scope === scope) return t;
  // Subagent tab names start with the role name, followed by the scope if declared
  const base = t.roleName ? (t.title.startsWith(t.roleName) ? t.title.split(" · ")[0] : t.roleName) : null;
  patchTab(t.id, { scope, title: base ? (scope ? `${base} · ${scope}` : base) : scope || `Agent ${t.num ?? idx + 1}` });
  return cur().tabs.find((x) => x.id === t.id) ?? null;
}

export function findTabByConversation(conversationId: string): AgentTab | null {
  return cur().tabs.find((x) => x.conversationId === conversationId) ?? null;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useAgentTabs(): TabsState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

export function subscribeTabs(fn: () => void): () => void {
  return subscribe(fn);
}

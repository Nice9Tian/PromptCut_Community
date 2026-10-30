import { useSyncExternalStore } from "react";
import { MAIN_TAB, dropChatStore, getChatStore } from "./liveChat.ts";
import { normalizeCreativity, type CreativityLevel } from "../kernel/creativity.mjs";

/**
 * AI 助手面板的分页:每一页是一个独立的 Agent 对话,可以同时跑。
 *
 * 页的身份有两层:
 *   - tabId:页面内部用的键(store、localStorage 后缀),形如「项目ID_AgentID」(`tabIdOf`);
 *   - conversationId:这一页的会话归档 id(useChatHistory 管的那个)。**给模型看的
 *     「Agent 对话 ID」就是它** —— send_message 的收件人、范围变动里的「谁改的」都写它,
 *     历史里能按它找回整段对话。
 *
 * 分页清单**按项目分开**(2026-10-22 用户定,`workflow/editing.md`「AI 栏的 Agent 标签」):
 * 每个项目一份,存 localStorage `pc.agentTabs:<项目ID>`,刷新页面、重开项目后恢复;界面上叫 Agent 1、Agent 2……
 * (编号在本项目内取最小空号),代码里分页的标记是「项目ID_AgentID」。切到另一个项目,AI 栏换成那个项目自己的清单。
 *
 * 每页都能关,最后一个也能关。**一页都没有**时(刚进项目、或用户把会话全关了)清单里不放真页,
 * 对外给一个「开始页」:`draft: true` 的占位页,id 就是用户在开始页点发送后建出来的第一个会话的 id(`commitDraft`),
 * 所以占位页变真页时 rail 上的项、页面节点都不换。没点发送之前它不进存储、不发任何请求。
 * 「用户手动关光过会话」(`cleared`)按项目记:没关光过的项目,开始页带引导动画;关光过的只给预设和编辑框。
 */
export interface AgentTab {
  id: string;
  conversationId: string | null;
  /** 用户可见的名字;没声明范围之前是「Agent N」 */
  title: string;
  /** 「Agent N」的 N:创建时取当前最小的空号,关掉别的页不改它;子 Agent 页(有角色名)没有 */
  num?: number;
  /** Agent 用 declare_scope 声明的修改范围,如「剪辑1->序列2」 */
  scope: string | null;
  /** 正在跑(流式回复中) */
  busy: boolean;
  /** 还没送达的其他 Agent 消息数(标在页签上) */
  unread: number;
  createdAt: number;
  /**
   * 这个对话单独设的创造力等级(`kernel/creativity.mjs`);null = 跟项目的默认等级。
   * 只存在本机的页签里(计划 agent-workflow-plan.md 第 4 节第 3 条),不进项目文档;随每条聊天请求带给服务端。
   */
  creativity: CreativityLevel | null;
  /**
   * 多 Agent(计划 agent-workflow-plan.md A3):`spawn_agent` 拉起的子 Agent 带预设角色(id 与中文名)、父对话 ID,
   * 以及拉起时沿用父对话的驱动(`provider`,这一页的驱动下拉框按它预选)。主对话与用户自己开的页都是 null。
   */
  role?: string | null;
  roleName?: string | null;
  parent?: string | null;
  provider?: string | null;
  /** 开始页占位:本项目一个会话都没有,还没点过发送。不进存储,不是真的 Agent */
  draft?: boolean;
}

export interface TabsState {
  projectId: string;
  /** 真页;一页都没有时放一个 `draft` 占位页(开始页) */
  tabs: AgentTab[];
  activeId: string;
  /** 本项目的用户手动关光过会话;没关光过(刚进项目)的开始页才带引导动画 */
  cleared: boolean;
}

/** 没有项目时(单测、手机版这类不看清单的嵌入)用的名字,只放内存,不写存储 */
const NO_PROJECT = "none";
const START_AGENT = "start";
const KEY_PREFIX = "pc.agentTabs:";
const storageKey = (projectId: string) => `${KEY_PREFIX}${projectId}`;

/** 分页的内部 id:「项目ID_AgentID」 */
export function tabIdOf(projectId: string, agentId: string): string {
  return `${projectId}_${agentId}`;
}

function newAgentId(): string {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/** 老数据没存编号:从「Agent N」的名字里认;改过名又没有角色的按位置给;子 Agent 页没有 */
function tabNumber(t: Partial<AgentTab>, i: number): number | undefined {
  if (typeof t.num === "number" && t.num > 0) return t.num;
  const m = typeof t.title === "string" ? /^Agent (\d+)$/.exec(t.title) : null;
  if (m) return Number(m[1]);
  return t.roleName ? undefined : i + 1;
}

/** 当前最小的没被占用的「Agent N」编号 */
function smallestFreeNum(tabs: readonly AgentTab[]): number {
  const used = new Set(tabs.map((t) => t.num));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/** 一个项目的清单(内存里的完整形态) */
interface Rec {
  tabs: AgentTab[];
  activeId: string;
  cleared: boolean;
  /**
   * 下一个会话的 AgentID:开始页占位页的 id 就用它,点发送后建出来的第一个会话沿用。
   * 项目里还没有过真页时固定叫 "start"(不写存储,重开仍是同一个,不会每次刷新留一串键);关光之后换成随机的,不复用旧 id。
   */
  nextAgentId: string;
  /** 开始页占位页(缓存,引用稳定;在开始页上改的创造力等级记在这里,点发送时带过去) */
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
    return null; // 存储不可用 / 存坏了:当这个项目没存过
  }
}

function writeRec(projectId: string, rec: Rec) {
  // 没有项目、或这个项目还是「刚进来什么都没做」(没有真页、没关光过)就不写:编辑器启动时那个临时空项目、
  // 打开了没发过话的项目都不往存储里留键
  if (projectId === NO_PROJECT || (rec.tabs.length === 0 && !rec.cleared)) return;
  try {
    localStorage.setItem(
      storageKey(projectId),
      JSON.stringify({ v: 2, tabs: rec.tabs.map(persistable), active: rec.activeId, cleared: rec.cleared, nextAgentId: rec.nextAgentId }),
    );
  } catch {
    /* 忽略:存不下也让本次会话生效 */
  }
}

const recs = new Map<string, Rec>();
let projectId = NO_PROJECT;
let state: TabsState;
const listeners = new Set<() => void>();

/** 下一次切到新项目时,新项目的 .proc 里带着对话(旧项目的主对话),要给它补一个页(见 noteProjectChatApplied) */
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

/** 改过 rec 之后:写盘、重做对外的快照、通知订阅者 */
function commit(save = true) {
  const rec = cur();
  if (save) writeRec(projectId, rec);
  state = snapshot();
  for (const fn of listeners) fn();
}

function patchTab(id: string, patch: Partial<AgentTab>) {
  const rec = cur();
  if (rec.draft && rec.draft.id === id && rec.tabs.length === 0) {
    // 开始页上改的东西(创造力等级)记在占位页上,不写盘,点发送时带过去
    rec.draft = { ...rec.draft, ...patch };
    commit(false);
    return;
  }
  if (!rec.tabs.some((t) => t.id === id)) return;
  rec.tabs = rec.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t));
  commit();
}

/* ---------------- 项目 ---------------- */

/**
 * 切到某个项目的清单(没有就按「没存过」建一份空的:开始页,带引导动画)。
 * 由 `agentTabsProject.ts` 盯着编辑器 store 的项目 id 调;同一个项目重复调只刷新「待补主对话」的标记。
 *
 * 项目的 .proc 里带着对话(老版本存的「主对话」,`projectAi.applyProjectAi` 灌进来时调 `noteProjectChatApplied`)、
 * 而这个项目还没有自己的清单时,补一个页「项目ID_main」接住它,老对话不会因为清单分开而看不见。
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
    // 老版本的主对话归档 id 存在全局键 pcChatId 里,接过来,归档里的那段还接得上
    try {
      const legacy = localStorage.getItem("pcChatId");
      if (legacy && localStorage.getItem(`pcChatId:${main.id}`) === null) localStorage.setItem(`pcChatId:${main.id}`, legacy);
    } catch { /* 忽略 */ }
  }
  commit(next !== NO_PROJECT);
}

export function getAgentProjectId(): string {
  return projectId;
}

/**
 * 项目的对话(.proc 里的 `ai.messages`)刚灌进主对话 store。
 * 灌对话发生在换项目之前,这里记一笔:紧接着的 `setAgentProject` 若发现新项目还没有清单,就补一个页接住这段对话。
 */
export function noteProjectChatApplied(hasMessages: boolean): void {
  pendingMain = hasMessages;
}

/* ---------------- 读 ---------------- */

export function getTabs(): AgentTab[] {
  return state.tabs;
}

/** 真页(不含开始页占位) */
export function getRealTabs(): AgentTab[] {
  return state.tabs.filter((t) => !t.draft);
}

export function getActiveTabId(): string {
  return state.activeId;
}

/** 本项目有没有真页;没有就是在开始页 */
export function hasRealTabs(): boolean {
  return cur().tabs.length > 0;
}

/** 本项目的用户手动关光过会话吗(开始页要不要放引导动画看它) */
export function isCleared(): boolean {
  return state.cleared;
}

export function isDraftTab(id: string): boolean {
  return state.tabs.some((t) => t.id === id && t.draft === true);
}

/* ---------------- 增、关、切 ---------------- */

/**
 * 新开一页(「+」)。本项目一页都没有时「+」就是回到开始页:返回占位页,不建真页(真页由开始页点发送建)。
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
 * 用户在开始页点了发送:把占位页变成本项目的第一个真页(Agent 1,沿用占位页的 id 和在开始页上设的创造力等级)。
 * 已经是真页(或不是占位页)返回现成的那页。
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
 * `spawn_agent` 拉起的子 Agent 开一页(A3):对话 ID 由服务端定(= 它的新身份),先写进这一页记会话 id 的键,
 * 页面挂上时 useChatHistory 就读到它;不抢当前页的焦点。同一个对话 ID 已经有页就回那一页。
 */
export function addSpawnedTab(spec: { conversationId: string; role: string; roleName: string; parent: string; provider: string | null; creativity: CreativityLevel | null }): AgentTab {
  const rec = cur();
  const hit = rec.tabs.find((t) => t.conversationId === spec.conversationId);
  if (hit) return hit;
  const id = tabIdOf(projectId, newAgentId());
  try {
    localStorage.setItem(`pcChatId:${id}`, spec.conversationId);
  } catch {
    /* 存不了的话 useChatHistory 会另起一个 id,页签上的对话 ID 在下面这份里仍是对的 */
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
  // 本项目还在开始页(没有真页)时,子 Agent 页成了第一个真页,激活它
  rec.tabs = [...rec.tabs, tab];
  if (rec.tabs.length === 1) rec.activeId = tab.id;
  rec.nextAgentId = rec.tabs.length === 1 ? newAgentId() : rec.nextAgentId;
  commit();
  return tab;
}

/** 这一页拉起时定下的驱动(子 Agent 沿用父对话的);没有回 null */
export function getTabProvider(id: string): string | null {
  return state.tabs.find((x) => x.id === id)?.provider ?? null;
}

/** 还能不能关这一页:每个真页都能关(含最后一个);开始页占位页没有可关的 */
export function canCloseTab(id: string): boolean {
  return cur().tabs.some((t) => t.id === id);
}

/**
 * 关页。每个真页都能关,最后一个也能关;关掉的是当前页就切到左边那页(它在最左就切到右边那页)。
 * 关光之后本项目回到开始页,并记下「用户手动关光过」(按项目记),之后的开始页不放引导动画。
 * 项目自带的主对话(「项目ID_main」)的对话 store 是随项目存取的那一份、不销毁,关它时清空,免得隐形地留着一段没人看的对话。
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

/** 这一页单独设创造力等级;null = 回到跟项目 */
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

/** Agent 声明了范围:页签名字跟着改,好让用户一眼看出哪页在改哪儿 */
export function setScopeByConversation(conversationId: string, scope: string | null): AgentTab | null {
  const tabs = cur().tabs;
  const t = tabs.find((x) => x.conversationId === conversationId);
  if (!t) return null;
  const idx = tabs.indexOf(t);
  if (t.scope === scope) return t;
  // 子 Agent 的页签名以角色名打头,声明了范围再接上范围
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

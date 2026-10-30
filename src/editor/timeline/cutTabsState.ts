import { useSyncExternalStore } from "react";

/**
 * 时间轴上方剪辑标签栏的「打开了哪几条」(`workflow/editing.md`「剪辑标签」)。
 *
 * 这是本机界面状态,不进项目文档、不同步给别的成员(`product/project-model.md`「剪辑」;
 * 存法见 `mechanism/project-model.md`):按项目 id 存在浏览器 / 桌面版的本地存储里,
 * 刷新、重开项目后恢复。读写都包 try/catch:隐私窗口、存储被禁时只留在内存里,不影响使用。
 *
 * 规则(纯函数 `reconcileTabs`,单测在 cutTabsState.test.mjs):
 *   - 激活的那条剪辑一定在标签里(Agent 切过去、撤销切回去,都自动补上标签);
 *   - 已经不存在的剪辑(被删、协作同伴删了、撤销了新建)自动从标签里拿掉;
 *   - 一个都不剩时(新项目、旧存储)就是激活的那一条。
 * 标签只靠用户点「×」关,失去焦点、点别处、切面板都不动它。
 */

const KEY = (projectId: string) => `pc.cutTabs.v1:${projectId}`;

/** 存储里读出来的、和项目对齐之后的标签顺序 */
export function reconcileTabs(stored: readonly string[] | null | undefined, cutIds: readonly string[], activeId: string | undefined): string[] {
  const exists = new Set(cutIds);
  const out: string[] = [];
  for (const id of stored ?? []) if (exists.has(id) && !out.includes(id)) out.push(id);
  if (activeId && exists.has(activeId) && !out.includes(activeId)) out.push(activeId);
  if (!out.length && cutIds.length) out.push(activeId && exists.has(activeId) ? activeId : cutIds[0]);
  return out;
}

/** 关掉一个标签之后该切到哪一条(关的是激活的那条时):优先右邻,没有就左邻;关不了(只剩一个)返回 null */
export function closeTab(tabs: readonly string[], id: string, activeId: string | undefined): { tabs: string[]; switchTo: string | null } | null {
  if (tabs.length <= 1 || !tabs.includes(id)) return null;
  const i = tabs.indexOf(id);
  const rest = tabs.filter((x) => x !== id);
  const switchTo = id === activeId ? rest[Math.min(i, rest.length - 1)] : null;
  return { tabs: rest, switchTo };
}

let memory = new Map<string, string[]>();
const listeners = new Set<() => void>();
let version = 0;

function read(projectId: string): string[] | null {
  const hit = memory.get(projectId);
  if (hit) return hit;
  try {
    const raw = globalThis.localStorage?.getItem(KEY(projectId));
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      memory.set(projectId, parsed);
      return parsed;
    }
  } catch { /* 存储不可用:只留在内存里 */ }
  return null;
}

function write(projectId: string, tabs: string[]): void {
  const prev = memory.get(projectId);
  if (prev && prev.length === tabs.length && prev.every((x, i) => x === tabs[i])) return;
  memory.set(projectId, tabs);
  version++;
  try { globalThis.localStorage?.setItem(KEY(projectId), JSON.stringify(tabs)); } catch { /* 同上 */ }
  for (const l of [...listeners]) l();
}

/** 当前项目的标签(已和项目对齐) */
export function openTabs(projectId: string, cutIds: readonly string[], activeId: string | undefined): string[] {
  return reconcileTabs(read(projectId), cutIds, activeId);
}

/** 把对齐后的结果写回(组件渲染后调;和存的不同才写) */
export function saveTabs(projectId: string, tabs: string[]): void {
  write(projectId, tabs);
}

/** 打开一条剪辑的标签(不负责切换,切换是 store 的 switchCut) */
export function openTab(projectId: string, cutIds: readonly string[], activeId: string | undefined, id: string): void {
  const tabs = openTabs(projectId, cutIds, activeId);
  if (!tabs.includes(id)) write(projectId, [...tabs, id]);
}

export function setTabs(projectId: string, tabs: string[]): void {
  write(projectId, tabs);
}

/** 测试用 */
export function resetCutTabsMemory(): void {
  memory = new Map();
  version++;
}

function subscribe(f: () => void) {
  listeners.add(f);
  return () => { listeners.delete(f); };
}

/** 组件里订阅「标签变了」 */
export function useCutTabsVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

import type { Project } from "../../kernel/project";
import { allCards, userCardSources } from "../../kernel/registry";
import { invalidateScopes, localCardImports, peekScopes, usedCardIds } from "../cardScope";

/**
 * 定制卡跟着 .proc 走。
 *
 * Agent 用 create_card 写的卡落在 src/cards/user/ —— 那是**这台机器的全局目录**,不在项目文件里。
 * 以前 .proc 只存 cardId,于是拷走一份 .proc、换台机器、或者本机的卡被别的项目覆盖掉,
 * 片子里的地图卡、片头卡就只剩一个找不到的名字。
 *
 * 现在:存盘时把项目用到的(以及归属表上记在本项目名下的)定制卡源码一起打包进 .proc 的 cards 段;
 * 打开时交给服务端装回 src/cards/user/。装之前走和 create_card 同一道审查(.proc 可能是别人发来的,
 * 里面的源码会在编辑器里执行);和本机版本不同时**以项目里存的为准**,本机那份先备份到
 * .pc-work/card-history/ 再覆盖 —— 打开一个项目看到的应该是它存下来的样子。
 */

/** 打进 .proc 的一个文件。id = src/cards/user/ 下的文件名(不含 .tsx),通常就是卡片 id */
export interface BundledCard {
  id: string;
  source: string;
}

/** 当前项目该带走哪些定制卡:时间轴上用到的 + 归属表记在本项目名下的,再顺着同目录 import 补齐依赖 */
export function collectProjectCards(p: Project): BundledCard[] {
  const { files: userCardFiles, fileOf: userCardFileOf } = userCardSources();
  const queue: string[] = [];
  for (const cardId of usedCardIds(p)) {
    const file = userCardFileOf[cardId];
    if (file) queue.push(file);
  }
  // 建了还没摆上时间轴的卡也算本项目的。归属表没加载过就只带用到的 —— 存盘等不了一次请求
  const scopes = peekScopes();
  if (scopes && p.id) {
    for (const [cardId, e] of Object.entries(scopes)) {
      if (e.scope === "project" && e.projectId === p.id && userCardFileOf[cardId]) queue.push(userCardFileOf[cardId]);
    }
  }
  const out = new Map<string, string>();
  while (queue.length) {
    const file = queue.shift()!;
    if (out.has(file)) continue;
    const source = userCardFiles[file];
    if (typeof source !== "string") continue;
    out.set(file, source);
    for (const dep of localCardImports(source)) if (!out.has(dep)) queue.push(dep);
  }
  return [...out.keys()].sort().map((id) => ({ id, source: out.get(id)! }));
}

/** 从 .proc 文档里取出 cards 段。形状不对的条目丢掉,不抛错 —— 坏一张卡不该让整个项目打不开 */
export function bundledCardsOf(doc: unknown): BundledCard[] {
  const list = (doc as { cards?: unknown } | null)?.cards;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (c): c is BundledCard => !!c && typeof (c as BundledCard).id === "string" && typeof (c as BundledCard).source === "string",
  );
}

export interface CardRestoreResult {
  id: string;
  status: "written" | "updated" | "unchanged" | "rejected";
  error?: string;
  backup?: string;
}

/** 最近一次装卡的结果,给排查用(控制台里 window.__pcCardRestore 看得到) */
let lastRestore: CardRestoreResult[] = [];
export function lastCardRestore(): CardRestoreResult[] {
  return lastRestore;
}

/**
 * 把 .proc 里带的卡装回本机。异步、不阻塞打开项目:装完 vite 热更新,卡自己出现在舞台和卡库里。
 * projectId 用来给本机原来没有的卡盖归属戳。
 */
export async function restoreProjectCards(cards: BundledCard[], projectId: string | null): Promise<CardRestoreResult[]> {
  if (cards.length === 0) return [];
  try {
    const res = await fetch("/api/cards/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cards,
        projectId: projectId ?? undefined,
        // 只报内置卡的 id:同名的用户卡是「更新」,同名的内置卡才是撞车
        existingIds: allCards().filter((c) => c.source !== "user").map((c) => c.id),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    lastRestore = data.results as CardRestoreResult[];
  } catch (e) {
    lastRestore = cards.map((c) => ({ id: c.id, status: "rejected" as const, error: `装卡请求失败:${e instanceof Error ? e.message : String(e)}` }));
  }
  invalidateScopes();
  for (const r of lastRestore) {
    if (r.status === "rejected") console.warn(`[proc] 项目里带的卡「${r.id}」没装上:${r.error}`);
    else if (r.status === "updated") console.info(`[proc] 卡「${r.id}」按项目里存的版本更新了,本机旧版备份在 ${r.backup ?? "(未备份)"}`);
  }
  (window as unknown as { __pcCardRestore?: CardRestoreResult[] }).__pcCardRestore = lastRestore;
  return lastRestore;
}

/** 从 .proc 文本里取卡并装回。解析不了就什么都不做(那种文本 parseProc 早就报过错了) */
export function restoreCardsFromProcText(text: string, projectId: string | null): Promise<CardRestoreResult[]> {
  let doc: unknown = null;
  try {
    doc = JSON.parse(text);
  } catch {
    return Promise.resolve([]);
  }
  return restoreProjectCards(bundledCardsOf(doc), projectId);
}

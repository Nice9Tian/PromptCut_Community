import { EditorApi } from "../../ai/mcpExecutor";
import { getState, actions } from "../../store/project";
import { allCards, getCard } from "../../kernel/registry";
import { applyCardDefinition } from "../../kernel/cardAuthoring.mjs";
import { cardFrameMode } from "../../kernel/frameMode.mjs";
import { findCard } from "../../kernel/cardParams";
import { isCardVisible, readVisibility, usedCardIds } from "../../editor/cardScope";

import { cardScopes, refreshScopes } from "../common";
import { apiUrl } from "../apiUrl";

export const cardsHandlers = {
  /**
   * 两档详略。默认摘要:每张卡只给 id/名字/干什么/什么时候用/参数名,
   * 一次调用就能把二十几张卡扫完并选定用哪张。真要建卡时再带 cardId
   * 取那一张的完整 schema —— 以前无论要哪张都得把所有卡的 controls
   * 和 defaults 全量拉一遍,又贵又淹没重点。
   */
  listCards: (args) => {
    /*
     * 卡片库对 Agent 暴露多少,由 editor/cardScope.ts 那三档决定 ——
     * 内置卡按组开关,用户卡看「是不是本项目建的 / 有没有标共享」。
     * 从前这里是全给,于是给 A 项目建的定制卡会出现在 B 项目里(用户原话:
     * 「ThreeJS 的资产又从上一个项目泄露给他了」)。
     *
     * 点名要某一张卡时(带 cardId)**不过滤**:那是明确的指名道姓,
     * 藏起来只会让它拿到一句「没有这张卡」而不知道为什么。
     */
    const wanted = args?.cardId
      ? [findCard(args.cardId)]
      : allCards().filter((c) => isCardVisible(c, readVisibility(), cardScopes, getState().project.id ?? null, usedCardIds(getState().project)));
    const full = args?.detail === "full" || !!args?.cardId;
    return wanted.map((c) => {
      const base = {
        id: c.id, name: c.name, description: c.description, source: c.source,
        frameMode: cardFrameMode(c),
        ...(c.useWhen ? { useWhen: c.useWhen } : {}),
        ...(c.tags?.length ? { tags: c.tags } : {}),
      };
      if (full) return { ...base, controls: c.controls, defaults: c.defaults };
      return {
        ...base,
        params: c.controls.map((ct) => (ct.required ? `${ct.key}*` : ct.key)),
        hint: "带 * 的是必填。要完整 schema 就用 list_cards({ cardId })。",
      };
    });
  },
  /**
   * 现场建一张新卡片。源码落到 src/cards/user/<id>.tsx,vite HMR 编译后
   * 自动注册,list_cards 立刻能看到 —— 不用重启,也不用改任何注册表文件。
   */
  createCard: async (args) => {
    const res = await fetch(apiUrl("/api/cards/create"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...args,
        id: args.id,
        source: args.source,
        overwrite: args.overwrite === true,
        existingIds: allCards().map((c) => c.id),
        // 盖归属戳:定制卡默认只属于建它的这个项目(见 editor/cardScope.ts)
        projectId: getState().project.id ?? undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `建卡失败(HTTP ${res.status})`);
    refreshScopes();
    return data;
  },
  /**
   * 读回一张卡的源码(用户卡和内置卡都行)。改卡的第一步 —— 不读回来就改,等于凭记忆重写。
   * 带 file 读这张卡用到的某个部件 / vendor 文件。
   */
  getCardSource: async (args) => {
    const q = new URLSearchParams({ id: args.cardId, ...(args.file ? { file: args.file } : {}) });
    const res = await fetch(apiUrl(`/api/cards/source?${q}`));
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `读不到卡片源码(HTTP ${res.status})`);
    return data;
  },
  /** 局部替换式改卡(带 file 改部件文件)。整篇重写交给 createCard,那条路只该走一次(建卡)。 */
  editCard: async (args) => {
    const res = await fetch(apiUrl("/api/cards/edit"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: args.cardId, file: args.file, find: args.find, replace: args.replace, replaceAll: args.replaceAll === true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `改卡失败(HTTP ${res.status})`);
    return data;
  },
  applyCard: (args) => {
    let instance: { clipId: string; nodeId: string } | undefined;
    actions.editCardProject(project => {
      const result = applyCardDefinition(project, args, getCard); instance = { clipId: result.clipId, nodeId: result.nodeId }; return result.project;
    });
    return { ok: true, ...instance };
  },
} satisfies Partial<EditorApi>;

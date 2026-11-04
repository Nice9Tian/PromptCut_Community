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
   * Two detail tiers. Default summary: each card only provides id/name/what it does/when to
   * use/parameter names, scanning all twenty-plus cards and choosing which one to use in a single
   * call. When actually creating a card, pass cardId to fetch that card's full schema: previously,
   * whichever card was needed, controls and defaults for all cards had to be pulled in full, which
   * was expensive and buried the focus.
   */
  listCards: (args) => {
    /*
     * How much of the card library is exposed to the Agent is determined by the three tiers in
     * editor/cardScope.ts: built-in cards are toggled by group, and user cards check "whether created
     * by this project / whether marked as shared". Previously all were provided here, so custom cards
     * built for project A would appear in project B (user's verbatim words: "ThreeJS assets leaked to
     * it from the previous project again").
     *
     * When a specific card is requested by name (with cardId), **do not filter**: that is an explicit
     * reference by name, and hiding it only makes it receive "no such card" without knowing why.
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
        hint: "Fields marked * are required. For the full schema use list_cards({ cardId }).",
      };
    });
  },
  /**
   * Create a new card on the fly. Source code lands in src/cards/user/<id>.tsx; once compiled by vite
   * HMR, it registers automatically and list_cards sees it immediately: no restart needed, and no
   * registry files to edit.
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
        // Stamp ownership: custom cards belong only to the project that created them by default (see
        // editor/cardScope.ts)
        projectId: getState().project.id ?? undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `Failed to create card (HTTP ${res.status})`);
    refreshScopes();
    return data;
  },
  /**
   * Read back the source code of a card (both user cards and built-in cards work). The first step in
   * modifying a card: modifying without reading back is equivalent to rewriting from memory. Pass
   * file to read a specific part / vendor file used by this card.
   */
  getCardSource: async (args) => {
    const q = new URLSearchParams({ id: args.cardId, ...(args.file ? { file: args.file } : {}) });
    const res = await fetch(apiUrl(`/api/cards/source?${q}`));
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `Can't read card source (HTTP ${res.status})`);
    return data;
  },
  /**
   * Modify card by local replacement (pass file to modify part files). Full rewrite is handled by
   * createCard; that path should only be taken once (when creating a card).
   */
  editCard: async (args) => {
    const res = await fetch(apiUrl("/api/cards/edit"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: args.cardId, file: args.file, find: args.find, replace: args.replace, replaceAll: args.replaceAll === true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `Failed to edit card (HTTP ${res.status})`);
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

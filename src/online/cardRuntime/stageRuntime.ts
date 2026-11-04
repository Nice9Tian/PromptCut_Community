/**
 * Stage-side wiring (`docs/plan/online-card-exec-contract.md` Sections 2, 4, 8): loader + table of
 * modules bundled with page + style injection + writing successfully loaded definitions into the
 * stage's own registry + graphics capabilities determination + taking down troubled cards.
 * **Created only in cross-origin stages** (loaded on demand by stage; whether to create or
 * execute is determined by stage's own execution gate, `online/isolation/execGate.ts`).
 *
 *   const rt = createStageCardRuntime({ onStates: (states, graph) => report to editor page, longSide: () => aspect ratio long side });
 *   await rt.setBundles(bundles sent by editor page via RPC);   // return conclusion for each entry
 *   rt.dispose();                                                // when gate closes or stage unmounts
 *
 * Distribution of runtime states: successfully loaded cards are `ready`; failed entries are
 * distributed to cards whose source in the sync table matches that entry (sync table is sent
 * by the editor page via `setSyncedUserCards` into stage's own registry). After successful
 * loading, re-evaluate based on two criteria:
 *   - Media effect cards (with `card()`) where this stage lacks graphics capabilities → `gpu`
 *     (4.3; evaluated once when media effect cards are first loaded, re-evaluated if context lost);
 *   - This card encountered trouble in this document (`render/cards/cardTrouble.ts`: input
 *     unresolvable → `media`, threw runtime error → `runtime-error`).
 * Reclassified cards are written to `setLocalCardExec` in the registry; stage no longer mounts
 * them, pasting prerender output as before.
 */
import { setLocalCardExec, setRuntimeCards, syncedUserCards, type CardRunState } from "../../kernel/registry.ts";
import type { StageGraphCapability } from "../../render/stageRpc.ts";
import { cardTroubles, clearCardTrouble, onCardTrouble } from "../../render/cards/cardTrouble.ts";
import { createCardLoader, runStatesOf, type CardLoaderOptions } from "./loader.ts";
import { stageHostModules } from "./hostModules.ts";
import { CARD_RUNTIME_VERSION } from "./version.ts";
import { graphCapabilityDetail, judgeGraphCapability, probeGraphFacts, type GraphFacts } from "./gpuCapability.ts";
import type { CardBundle, LoadResult } from "./protocol.ts";

export interface StageCardRuntime {
  setBundles(bundles: readonly CardBundle[]): Promise<LoadResult[]>;
  /** Current runtime state of each synced card (card id → state) */
  states(): [string, CardRunState][];
  /** Graphics capabilities of this stage; `unknown` before any media effect card has been loaded */
  graph(): StageGraphCapability;
  /** Lost WebGL context during runtime: graphics capabilities re-evaluated as insufficient, all media effect cards reverted */
  noteContextLost(): void;
  /** Project aspect ratio changed: re-evaluate by new long side (the maximum texture size rule) */
  refreshGraph(): void;
  dispose(): void;
}

export interface StageCardRuntimeOptions {
  /** Runtime state or graphics capabilities changed (full set) */
  onStates?: (states: [string, CardRunState][], graph: StageGraphCapability) => void;
  /** Stages with Trusted Types enabled provide a policy-based compilation function (see `compile` in `loader.ts`) */
  compile?: CardLoaderOptions["compile"];
  /** Long side of the project aspect ratio (pixels); defaults to 1920 when there is no project */
  longSide?: () => number;
  /** Swap out probe for unit tests */
  probe?: () => GraphFacts | null;
  doc?: Document;
}

const STYLE_ATTR = "data-pc-card-style";

export function createStageCardRuntime(opts: StageCardRuntimeOptions = {}): StageCardRuntime {
  const doc = opts.doc ?? document;
  const entryCards = (entry: string) => [...syncedUserCards().values()].filter((c) => c.source === entry).map((c) => c.id);
  let last: [string, CardRunState][] = [];
  let facts: GraphFacts | null | undefined;
  let contextLost = false;
  let graph: StageGraphCapability = "unknown";
  /** Entry → previous generation (clears trouble records for this card on generation switch) */
  const generations = new Map<string, string>();
  let lastResults: ReadonlyMap<string, LoadResult> = new Map();

  const isGraphDef = (d: { card?: unknown }) => typeof d.card === "function";

  function judge(): void {
    const graphIds = loader.cards().filter(isGraphDef);
    if (!graphIds.length && graph === "unknown") return;
    if (facts === undefined) facts = (opts.probe ?? probeGraphFacts)();
    graph = judgeGraphCapability(facts ?? null, { longSide: opts.longSide?.() ?? 1920, contextLost });
  }

  function publish(): void {
    judge();
    const graphIds = new Set(loader.cards().filter(isGraphDef).map((d) => d.id));
    const troubles = cardTroubles();
    const blocked: string[] = [];
    last = [...runStatesOf(lastResults, entryCards)].map(([id, s]): [string, CardRunState] => {
      if (s.state !== "ready") return [id, s];
      const trouble = troubles.get(id);
      if (trouble) { blocked.push(id); return [id, { state: trouble.kind, detail: trouble.detail }]; }
      if (graphIds.has(id) && graph !== "ok") { blocked.push(id); return [id, { state: "gpu", detail: graphCapabilityDetail(graph) }]; }
      return [id, s];
    });
    setLocalCardExec({ graph: graph === "ok", blocked });
    opts.onStates?.(last, graph);
  }

  const loader = createCardLoader({
    runtime: CARD_RUNTIME_VERSION,
    host: stageHostModules,
    compile: opts.compile,
    onStyles(entry, cssFiles) {
      const previous = [...doc.head.querySelectorAll<HTMLStyleElement>(`style[${STYLE_ATTR}]`)].filter(style => style.getAttribute(STYLE_ATTR) === entry);
      const anchor = previous[0] ?? null; // Preserve this card's order relative to other card styles across generation switches
      for (const css of cssFiles) {
        const style = doc.createElement("style");style.setAttribute(STYLE_ATTR, entry);style.textContent = css;doc.head.insertBefore(style, anchor);
      }
      for (const style of previous) style.remove();
    },
    onCards: (defs) => { setRuntimeCards(defs); },
    onResults(results) {
      // Entries that switched generations: trouble records for their cards are invalidated, start fresh with the new generation
      const fresh: string[] = [];
      for (const [entry, r] of results) {
        if (generations.get(entry) !== r.generation) { generations.set(entry, r.generation); if (r.ok) fresh.push(...r.cardIds); }
      }
      for (const entry of [...generations.keys()]) if (!results.has(entry)) generations.delete(entry);
      lastResults = results;
      if (fresh.length) clearCardTrouble(fresh);
      publish();
    },
  });
  const offTrouble = onCardTrouble(publish);
  return {
    setBundles: (bundles) => loader.setBundles(bundles),
    states: () => last,
    graph: () => graph,
    noteContextLost() {
      if (contextLost) return;
      contextLost = true;
      if (graph !== "unknown") publish();
    },
    refreshGraph() {
      if (graph !== "unknown") publish();
    },
    dispose() {
      offTrouble();
      loader.clear();
      setRuntimeCards([]);
      setLocalCardExec({ graph: false, blocked: [] });
      last = [];
    },
  };
}

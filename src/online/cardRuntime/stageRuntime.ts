/**
 * 舞台这一侧的接线(`docs/plan/online-card-exec-contract.md` 第 2、4、8 节):加载器 + 页面自带模块的表 + 样式注入 +
 * 把载入成功的定义写进舞台自己的注册表 + 图形能力判定 + 出事的卡撤下。**只在跨源舞台里建**(由舞台按需载入;
 * 建不建、执行不执行由舞台自己的执行闸门决定,`online/isolation/execGate.ts`)。
 *
 *   const rt = createStageCardRuntime({ onStates: (states, graph) => 报给编辑页面, longSide: () => 画幅长边 });
 *   await rt.setBundles(编辑页面经 RPC 发来的包);   // 回每个入口的结论
 *   rt.dispose();                                    // 闸门关上、舞台卸载时
 *
 * 运行状态的摊法:载入成功的卡是 `ready`;失败的入口摊到「同步表里源码是这个入口」的那些卡上
 * (同步表由编辑页面经 `setSyncedUserCards` 发来,在舞台自己的注册表里)。载入成功之后再按两样改判:
 *   - 素材效果卡(有 `card()`)而这台舞台的图形能力不够 → `gpu`(4.3;第一次载入素材效果卡时判一次,丢过上下文改判);
 *   - 这张卡在这份文档里出过事(`render/cards/cardTrouble.ts`:输入解不了 → `media`,运行中抛错 → `runtime-error`)。
 * 改判的卡写进注册表的 `setLocalCardExec`,舞台不再挂它们,照原做法贴预渲染结果。
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
  /** 此刻每张同步卡的运行状态(卡片 id → 状态) */
  states(): [string, CardRunState][];
  /** 这台舞台的图形能力;还没载入过素材效果卡是 `unknown` */
  graph(): StageGraphCapability;
  /** 运行中丢了 WebGL 上下文:图形能力改判为不够,素材效果卡全部退回 */
  noteContextLost(): void;
  /** 项目画幅变了:按新的长边重判(最大纹理尺寸那一条) */
  refreshGraph(): void;
  dispose(): void;
}

export interface StageCardRuntimeOptions {
  /** 运行状态或图形能力变了(整份) */
  onStates?: (states: [string, CardRunState][], graph: StageGraphCapability) => void;
  /** 开了 Trusted Types 的舞台给一个走策略的编译函数(见 `loader.ts` 的 `compile`) */
  compile?: CardLoaderOptions["compile"];
  /** 项目画幅的长边(像素);没有项目时给 1920 */
  longSide?: () => number;
  /** 单测换掉探测 */
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
  /** 入口 → 上一次的代(换代时清掉这张卡的出事记录) */
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
      const anchor = previous[0] ?? null; // 换代保留这张卡在其它卡样式之间的顺序
      for (const css of cssFiles) {
        const style = doc.createElement("style");style.setAttribute(STYLE_ATTR, entry);style.textContent = css;doc.head.insertBefore(style, anchor);
      }
      for (const style of previous) style.remove();
    },
    onCards: (defs) => { setRuntimeCards(defs); },
    onResults(results) {
      // 换了一代的入口:它那几张卡的出事记录不作数,新一代重新来过
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

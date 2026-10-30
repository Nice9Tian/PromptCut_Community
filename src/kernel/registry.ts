import type { CardDef, Control } from "./types";
import { cardCapabilities } from "./frameMode.mjs";

const map = new Map<string, CardDef<any>>();
/** 注册表每变一次(注册、清空)加一:按「注册表里有哪些卡」记忆化的一方(源码版本表)拿它当键 */
let registryGen = 0;
export function cardsRegistryGen(): number {
  return registryGen;
}

/**
 * 注册卡片。同一次调用里 id 撞车是真的写错了(两张卡抢一个 id),直接抛错;
 * 跨调用的同 id 则按覆盖处理 —— 因为 cards/index.ts 会被 HMR 重新执行
 * (新建/修改 src/cards/user/ 下的卡就会触发),而这个 map 活在另一个模块里不会跟着重置。
 * 以前一律抛错,导致建完卡热更新时直接 "card id 重复" 把整个应用打挂,
 * 要手动刷新才能恢复。
 */
export function registerCards(defs: CardDef<any>[]) {
  registryGen++;
  const seen = new Set<string>();
  for (const d of defs) {
    if (seen.has(d.id)) throw new Error(`card id 重复: ${d.id}`);
    seen.add(d.id);
    const capabilities = cardCapabilities(d);
    // compositing / canvasHeavy 的权威是审阅表(src/cards/capabilities.json),不是卡片源码,
    // 所以注册时统一盖成审阅结论 —— 后面谁拿 getCard(id) 都读到同一个答案。
    map.set(d.id, { ...d, need_prerendering: capabilities.need_prerendering, compositing: capabilities.compositing,
      canvasHeavy: capabilities.canvasHeavy,
      ...(!Object.hasOwn(d, 'need_prerendering') ? { _derivedPrerendering: true } : {}) });
  }
}

/*
 * 卡片代码换了的通知(C6.6 集成 3b)。`cards/index.ts` 是热更新的边界(它自己接住热更新、重装整套卡片),
 * 热更新不再冒到 Editor、Preview、StageView 上 —— 那会让它们的 effect 在 Fast Refresh 里重跑,
 * 把舞台的 RPC 客户端清掉。于是要看新卡的一方(舞台重渲、编辑器的卡片列表、探针重测)订阅这里。
 * 本模块不在热更新链上(卡片改了它不重跑),订阅一直有效。
 */
let cardsGen = 0;
let cardsStampValue = 0;
const cardListeners = new Set<() => void>();

/**
 * `cards/index.ts` 热更新重装完整套卡片之后调。`stamp` 是这批热更新的时间戳(vite 推给各个页面的是同一个),
 * 编辑器页面拿它核对两个舞台是不是也换到了这一版(`editor/stageCards.ts`)。
 */
export function noteCardsUpdated(stamp: number = Date.now()): void {
  cardsGen++;
  cardsStampValue = Math.max(cardsStampValue, stamp);
  for (const l of [...cardListeners]) {
    try { l(); } catch (err) { console.warn("[registry] 卡片更新的订阅方出错", err); }
  }
}

/** 最近一次卡片热更新的时间戳;没换过是 0 */
export function cardsStamp(): number {
  return cardsStampValue;
}

/** 卡片代码换过几次(本页面会话里);首次装载是 0 */
export function cardsVersion(): number {
  return cardsGen;
}

export function onCardsUpdated(cb: () => void): () => void {
  cardListeners.add(cb);
  return () => { cardListeners.delete(cb); };
}

/** 重新装载整套卡片前先清空,免得删掉的卡片文件在热更新后还赖在库里 */
export function resetCards() {
  registryGen++;
  map.clear();
}

/**
 * 撤掉几张卡。只给云端 Agent 服务用:它把某个项目的用户卡定义临时登记进来(静态解析出的,不执行源码),
 * 用完撤掉,不留给下一个项目(`server/agent/ssr-host.mjs` 的 `registerProjectCards`)。页面不调它。
 */
export function unregisterCards(ids: readonly string[]) {
  let changed = false;
  for (const id of ids) changed = map.delete(id) || changed;
  if (changed) registryGen++;
}

export function getCard(id: string): CardDef<any> | undefined {
  return map.get(id) ?? runtimeCards.get(id);
}

export function allCards(): CardDef<any>[] {
  return [...map.values()];
}

/**
 * 定制卡(src/cards/user/)的源码原文:文件名 → 源码,以及卡片 id → 文件名。
 * 存 .proc 时要把项目用到的定制卡一起打包(editor/io/procCards.ts)。
 *
 * 由 cards/index.ts 每次(含 HMR 重跑)灌进来,而不是让 procCards 直接 import cards/user ——
 * 那会多出一条 cards/user → procCards → proc → drafts → headless 的依赖链,链上没有能接住
 * 热更新的模块,于是 Agent 每建 / 改一张卡,编辑器就整页刷新一次。
 */
let userSources: { files: Record<string, string>; fileOf: Record<string, string>; dependencies: Record<string, string> } = { files: {}, fileOf: {}, dependencies: {} };

export function setUserCardSources(files: Record<string, string>, fileOf: Record<string, string>, dependencies: Record<string, string> = {}) {
  userSources = { files, fileOf, dependencies };
}

export function userCardSources(): { files: Record<string, string>; fileOf: Record<string, string>; dependencies: Record<string, string> } {
  return userSources;
}

/*
 * 「已知但本机不能运行」的用户卡(C10 契约第 9 节「识别」,2026-09-29 用户改语义)。
 *
 * 在线包的卡片表是构建时从 `src/cards/user` 生成的,桌面版卡片库里的卡、经内容库同步的卡都不在表里。在线页面经自己的
 * 文档服务连接读本项目内容库的卡片源码(`kind: 'card-source'`),从源码里解析出卡片的 id 与名字,记在这张表里
 * (舞台是另一份文档,由父页经 RPC 发一份过去)。这张表**不进主注册表**:`allCards()` 的使用方(卡片库面板、工具、
 * 源码版本表)看不到它们,`getCard(id)` 对它们回 undefined —— 本机没有它们的代码。
 *
 * 和构建时卡片 id 撞车的条目在查询时忽略(内置赢,同 `cards/index.ts` 的 `taken` 规则;构建时的用户卡本来就算用户卡)。
 * 桌面运行环境不设这张表,恒为空。
 */
export interface SyncedUserCard {
  embeddedAudio?: boolean;
  audioSourceVersion?: string;
  id: string;
  name: string;
  /** 来源键(内容库里那份源码的键,形如 `src/cards/user/x.tsx`);诊断用 */
  source?: string;
  /** 源码里的说明(字面量才有;时间轴副标题的兜底) */
  description?: string;
  /** 源码里认得出的参数默认值(`cardSourceParse`;认不出的键已丢掉) */
  defaults?: Record<string, unknown>;
  /** 源码里认得出的参数控件(逐个解析,认不出的跳过) */
  controls?: Control[];
  /** 有控件没认出来(或整个 `controls` 不是字面量):参数面板据此说明「在线改不了」 */
  controlsIncomplete?: boolean;
  /** 被跳过的控件逐条(认得出的 key / label / type 与原因):参数面板说明是哪一条 */
  skippedControls?: SkippedControl[];
}

/** 同步来的卡里没认出来的一个控件(`cardSourceParse` 的 `skippedControls`) */
export interface SkippedControl {
  key?: string;
  label?: string;
  type?: string;
  reason: string;
}

/**
 * 同步来的用户卡给界面看的只读视图:长得像 `CardDef`(名字、说明、默认值、控件),**没有组件**,本机不能运行它。
 * 参数面板、时间轴副标题先查 `getCard`,查不到再用它(`syncedCardView`)。
 */
export interface SyncedCardView {
  id: string;
  name: string;
  description?: string;
  defaults: Record<string, unknown>;
  controls: Control[];
  controlsIncomplete: boolean;
  /** 被跳过的控件逐条(没有时为空表) */
  skippedControls: SkippedControl[];
  /** 恒为 true:看的人据此知道这是同步来的视图,不是能跑的定义 */
  synced: true;
}

let synced = new Map<string, SyncedUserCard>();
/** 每条同步条目的视图,换表时一并建好:同一张卡没变就回同一个对象(界面按引用判改动) */
let views = new Map<string, SyncedCardView>();
let syncedGen = 0;
const syncedListeners = new Set<() => void>();

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** 条目的签名(判「内容没变」) */
function entrySig(e: SyncedUserCard): string {
  return JSON.stringify([e.name, e.source ?? null, e.description ?? null, e.defaults ?? null, e.controls ?? null, !!e.controlsIncomplete, e.skippedControls ?? null, e.embeddedAudio ?? null, e.audioSourceVersion ?? null]);
}

/**
 * 整份换掉同步来的用户卡。同一 id 多条时取第一条。内容没变回 false、不通知;变了 `syncedUserCardsGen()` 加一并通知订阅方。
 */
export function setSyncedUserCards(entries: Iterable<SyncedUserCard>): boolean {
  const next = new Map<string, SyncedUserCard>();
  for (const e of entries ?? []) {
    if (!e || typeof e.id !== "string" || !e.id || next.has(e.id)) continue;
    next.set(e.id, {
      id: e.id, name: typeof e.name === "string" ? e.name : "",
      ...(e.embeddedAudio === true ? { embeddedAudio: true } : {}),
      ...(typeof e.audioSourceVersion === "string" ? { audioSourceVersion: e.audioSourceVersion } : {}),
      ...(typeof e.source === "string" && e.source ? { source: e.source } : {}),
      ...(typeof e.description === "string" ? { description: e.description } : {}),
      ...(isRecord(e.defaults) ? { defaults: e.defaults } : {}),
      ...(Array.isArray(e.controls) ? { controls: e.controls.filter((c) => isRecord(c) && typeof c.key === "string" && typeof c.type === "string") } : {}),
      ...(e.controlsIncomplete ? { controlsIncomplete: true } : {}),
      ...(Array.isArray(e.skippedControls) && e.skippedControls.length
        ? { skippedControls: e.skippedControls.filter((c) => isRecord(c) && typeof c.reason === "string") } : {}),
    });
  }
  const same = next.size === synced.size && [...next].every(([id, e]) => {
    const cur = synced.get(id);
    return !!cur && entrySig(cur) === entrySig(e);
  });
  if (same) return false;
  const nextViews = new Map<string, SyncedCardView>();
  for (const [id, e] of next) {
    const prev = synced.get(id);
    const prevView = views.get(id);
    if (prev && prevView && entrySig(prev) === entrySig(e)) { nextViews.set(id, prevView); continue; }
    nextViews.set(id, Object.freeze({
      id, name: e.name, ...(e.description !== undefined ? { description: e.description } : {}),
      defaults: e.defaults ?? {}, controls: e.controls ?? [], controlsIncomplete: !!e.controlsIncomplete,
      skippedControls: e.skippedControls ?? [], synced: true as const,
    }));
  }
  synced = next;
  views = nextViews;
  syncedGen++;
  for (const l of [...syncedListeners]) {
    try { l(); } catch (err) { console.warn("[registry] 同步用户卡的订阅方出错", err); }
  }
  return true;
}

/** 此刻的同步用户卡表(含撞车的条目;查询请用 `isUserCardId` / `knownCardName`) */
export function syncedUserCards(): ReadonlyMap<string, SyncedUserCard> {
  return synced;
}

/** 同步表每变一次加一(按「哪些卡是用户卡」记忆化的一方拿它当键) */
export function syncedUserCardsGen(): number {
  return syncedGen;
}

export function onSyncedUserCardsChanged(cb: () => void): () => void {
  syncedListeners.add(cb);
  return () => { syncedListeners.delete(cb); };
}

/** 这条同步条目生效吗:和构建时的卡(注册表里有的)撞车的忽略 */
function syncedEntry(id: string): SyncedUserCard | undefined {
  if (map.has(id)) return undefined;
  return synced.get(id);
}

/**
 * 这个 id 是不是用户卡:构建时的定制卡登记(`userCardSources().fileOf`),或同步来的用户卡(撞车的不算)。
 * 替代各处就地写的 `hasOwnProperty(userCardSources().fileOf, id)`。
 */
export function isUserCardId(id: string | undefined | null): boolean {
  if (typeof id !== "string" || !id) return false;
  if (Object.prototype.hasOwnProperty.call(userSources.fileOf, id)) return true;
  return !!syncedEntry(id);
}

/**
 * 同步来的用户卡的只读视图(见 `SyncedCardView`)。**不进主注册表**:`getCard`、`allCards()` 照旧看不到它们;
 * 和构建时的卡撞车的、没同步来的 id 回 undefined。
 */
export function syncedCardView(id: string | undefined | null): SyncedCardView | undefined {
  if (typeof id !== "string" || !id || !syncedEntry(id)) return undefined;
  return views.get(id);
}

/** 这张卡的显示名:构建时定义的名字 → 同步表里的名字 → null(未知卡片) */
export function knownCardName(id: string | undefined | null): string | null {
  if (typeof id !== "string" || !id) return null;
  const def = map.get(id);
  if (def) return def.name;
  return syncedEntry(id)?.name ?? null;
}

/**
 * 这张卡认不认得:构建时的注册表里有定义,或是用户卡(构建时登记的、在线页面从内容库同步来的)。
 * 两边都没有的是「未知卡片」:舞台不画,时间轴标「未知卡片」。
 */
export function isKnownCardId(id: string | undefined | null): boolean {
  if (typeof id !== "string" || !id) return false;
  return map.has(id) || isUserCardId(id);
}

/**
 * 两边都没有定义的卡片段(未知卡片;桌面与在线一致)。舞台本来就不画它们,所以测量不测(不给身份)、
 * 分派表不把它们当重卡、不进预渲染集合,页面发的清单计划也就不含它们。
 * 只看写了 `cardId` 的片段(只有 `nodeId` 的素材效果卡片段、素材段不算)。
 */
export function unknownCardClipIds(clips: Iterable<{ id: string; cardId?: string }>): Set<string> {
  const out = new Set<string>();
  for (const c of clips) if (c && typeof c.cardId === "string" && c.cardId && !isKnownCardId(c.cardId)) out.add(c.id);
  return out;
}

/* ------------------------------------------------------------------ *
 * 运行时载入的卡(在线浏览器执行同步来的用户卡与素材效果卡,`docs/plan/online-card-exec-contract.md` 第 2、8 节)
 * ------------------------------------------------------------------ */

/**
 * 一张同步来的卡在本页的运行状态(契约第 8 节的十种)。只有 `ready` 是「本页能运行」;其余都退回原做法
 * (按重卡、贴预渲染结果、缺了是沙漏、等渲染节点),参数面板按状态说明原因。
 */
export type CardRunStateName =
  | "ready" | "loading" | "unsupported-syntax" | "missing-module" | "load-error"
  | "gpu" | "media" | "runtime-error" | "not-isolated";

export interface CardRunState {
  state: CardRunStateName;
  /** 给参数面板看的细节:哪种写法、哪个模块、错误的第一行;没有就不写 */
  detail?: string;
  /** 出问题的文件(内容库的键) */
  file?: string;
  /** 这一代源码的短签名(运行时版本加闭包里每个文件的哈希);能运行的卡拿它当成本身份里的源码版本 */
  version?: string;
}

export const CARD_RUN_STATES: readonly CardRunStateName[] = Object.freeze([
  "ready", "loading", "unsupported-syntax", "missing-module", "load-error", "gpu", "media", "runtime-error", "not-isolated",
]);

/**
 * 运行时载入的卡片定义。**只在执行它们的环境里有**(跨源舞台、舞台起的声音线程);编辑页面永远是空的。
 * `getCard` 在构建时的注册表里找不到时才看这里(与构建时的卡撞 id 的不生效);`allCards()` 不含它们。
 */
const runtimeCards = new Map<string, CardDef<any>>();
let runtimeGen = 0;
const runtimeListeners = new Set<() => void>();

const stamp = (d: CardDef<any>): CardDef<any> => {
  const capabilities = cardCapabilities(d);
  return { ...d, need_prerendering: capabilities.need_prerendering, compositing: capabilities.compositing, canvasHeavy: capabilities.canvasHeavy,
    ...(!Object.hasOwn(d, "need_prerendering") ? { _derivedPrerendering: true } : {}) } as CardDef<any>;
};

/**
 * 整份换掉运行时载入的卡(加载器每次换代后调)。和 `registerCards` 一样按审阅表盖能力;审阅表里没有的按缺省。
 * 同一 id 多条取第一条。表有变回 true,`cardsRegistryGen()` 与 `runtimeCardsGen()` 各加一并通知订阅方。
 */
export function setRuntimeCards(defs: Iterable<CardDef<any>>): boolean {
  const next = new Map<string, CardDef<any>>();
  for (const d of defs ?? []) if (d && typeof d.id === "string" && d.id && !next.has(d.id)) next.set(d.id, d);
  const same = next.size === runtimeCards.size && [...next].every(([id, d]) => runtimeSource.get(id) === d);
  if (same) return false;
  runtimeCards.clear();
  runtimeSource.clear();
  for (const [id, d] of next) { runtimeSource.set(id, d); runtimeCards.set(id, stamp(d)); }
  registryGen++;
  runtimeGen++;
  for (const l of [...runtimeListeners]) {
    try { l(); } catch (err) { console.warn("[registry] 运行时卡片的订阅方出错", err); }
  }
  return true;
}
/** 盖能力之前的原定义(判「没变」用:同一个对象就是同一代) */
const runtimeSource = new Map<string, CardDef<any>>();

/** 这张卡是不是运行时载入的、且此刻生效(没被构建时的卡盖住) */
export function isRuntimeCard(id: string | undefined | null): boolean {
  return typeof id === "string" && !!id && !map.has(id) && runtimeCards.has(id);
}

export function runtimeCardsGen(): number {
  return runtimeGen;
}

export function onRuntimeCardsChanged(cb: () => void): () => void {
  runtimeListeners.add(cb);
  return () => { runtimeListeners.delete(cb); };
}

let runStates = new Map<string, CardRunState>();
let runStatesGen = 0;
const runStateListeners = new Set<() => void>();

const validRunState = (v: unknown): v is CardRunState => isRecord(v) && typeof v.state === "string" && (CARD_RUN_STATES as readonly string[]).includes(v.state);

/**
 * 整份换掉同步卡的运行状态(卡片 id → 状态)。舞台把载入结果报给编辑页面,编辑页面再合上它自己知道的
 * (转译失败、本页没有隔离环境),写进这里;参数面板、时间轴徽标、轻重判定都读它。
 * 形状不对的条目丢掉(舞台报来的东西当不可信输入)。内容没变回 false、不通知。
 */
export function setCardRunStates(states: Iterable<readonly [string, CardRunState]> | Record<string, CardRunState>): boolean {
  const next = new Map<string, CardRunState>();
  const entries = states && typeof (states as Iterable<unknown>)[Symbol.iterator] === "function"
    ? [...(states as Iterable<readonly [string, CardRunState]>)] : Object.entries((states ?? {}) as Record<string, CardRunState>);
  for (const [id, v] of entries) {
    if (typeof id !== "string" || !id || !validRunState(v)) continue;
    next.set(id, Object.freeze({
      state: v.state,
      ...(typeof v.detail === "string" && v.detail ? { detail: v.detail.slice(0, 300) } : {}),
      ...(typeof v.file === "string" && v.file ? { file: v.file.slice(0, 200) } : {}),
      ...(typeof v.version === "string" && v.version ? { version: v.version.slice(0, 64) } : {}),
    }));
  }
  const same = next.size === runStates.size && [...next].every(([id, v]) => {
    const cur = runStates.get(id);
    return !!cur && cur.state === v.state && cur.detail === v.detail && cur.file === v.file && cur.version === v.version;
  });
  if (same) return false;
  runStates = next;
  runStatesGen++;
  for (const l of [...runStateListeners]) {
    try { l(); } catch (err) { console.warn("[registry] 卡片运行状态的订阅方出错", err); }
  }
  return true;
}

/** 此刻有没有还在转译或载入的同步卡(`loading`;测量的开工门等它们有了结果,`src/editor/measureGate.ts`) */
export function anyCardLoading(): boolean {
  for (const v of runStates.values()) if (v.state === "loading") return true;
  return false;
}

/** 这张同步卡在本页的运行状态;没有记录回 undefined(调用方按「运行不了」处理) */
export function cardRunState(id: string | undefined | null): CardRunState | undefined {
  return typeof id === "string" && id ? runStates.get(id) : undefined;
}

/**
 * 这张卡在本页能不能运行:构建时就有定义的恒为 true(含构建时就在包里的仓库用户卡);同步来的,
 * 在执行它的环境里(舞台、声音线程)看有没有载入成功,在编辑页面看运行状态是不是 `ready`。
 */
export function cardRunnableHere(id: string | undefined | null): boolean {
  if (typeof id !== "string" || !id) return false;
  if (localExec.blocked.has(id)) return false;
  if (map.has(id) || runtimeCards.has(id)) return true;
  return runStates.get(id)?.state === "ready";
}

/**
 * 执行卡片的那份文档(跨源舞台)自己的两条结论(`docs/plan/online-card-exec-contract.md` 4.3、第 8 节):
 *   - `graph`:这份文档能不能跑素材效果卡(画面那一半允许执行,而且图形能力够);缺省不能;
 *   - `blocked`:运行时载入、但在这份文档里出了事的卡(素材效果卡的输入解不了、运行中抛错):撤下、退回原做法。
 * 只有舞台写它;编辑页面不写(那里看舞台报回来的运行状态)。变了 `cardsRegistryGen()` 与 `cardRunStatesGen()` 各加一并通知。
 */
let localExec: { graph: boolean; blocked: ReadonlySet<string> } = { graph: false, blocked: new Set() };
export function setLocalCardExec(next: { graph: boolean; blocked?: Iterable<string> }): boolean {
  const blocked = new Set<string>();
  for (const id of next.blocked ?? []) if (typeof id === "string" && id) blocked.add(id);
  const graph = next.graph === true;
  if (graph === localExec.graph && blocked.size === localExec.blocked.size && [...blocked].every((id) => localExec.blocked.has(id))) return false;
  localExec = { graph, blocked };
  registryGen++;
  runStatesGen++;
  for (const l of [...runStateListeners]) {
    try { l(); } catch (err) { console.warn("[registry] 卡片运行状态的订阅方出错", err); }
  }
  return true;
}
/** 这份文档能不能跑素材效果卡(只在执行卡片的舞台里为真) */
export function graphCardsRunnableHere(): boolean {
  return localExec.graph;
}

export function cardRunStatesGen(): number {
  return runStatesGen;
}

export function onCardRunStatesChanged(cb: () => void): () => void {
  runStateListeners.add(cb);
  return () => { runStateListeners.delete(cb); };
}

/** 单测用:清掉运行时的卡与运行状态 */
export function resetRuntimeCardsForTest(): void {
  runtimeCards.clear();
  runtimeSource.clear();
  runStates = new Map();
  localExec = { graph: false, blocked: new Set() };
}

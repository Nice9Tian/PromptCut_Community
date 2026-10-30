/**
 * 纯浏览器节点执行用户卡与素材效果卡时,本页「能运行什么」的登记处(块 N,`docs/plan/online-card-exec-contract.md` 第 7 节第 1、3 条)。
 *
 * 三方用它:
 *   - 写:`src/editor/nodeCardInfoLive.ts` 按注册表里每张同步卡的运行状态与代码身份算出来写进来(`setNodeCardInfo`),
 *     节点报到后文档服务回的 `cardEnvFingerprint` 也记在这里(`setNodeCardEnvFingerprint`);
 *   - 读:`browserNode.ts`(`node.hello` 报运行时版本;能力位与 `cardSourceVersions` 给节点侧过滤用)、
 *     `planPublisher.ts`(清单计划的 `input.browser`,切分方据此决定给浏览器出不出用户卡、素材效果卡的那一份)。
 *
 * 只在内存里,不读环境、不碰舞台:纯数据加订阅,Node 单测直接载它。属于 render 这一层(`src/online/`)。
 *
 * # 「换代后一小段时间不报」
 *
 * 同步来的卡换了一版(哪个文件变了),它的代码身份在 `NODE_CARD_SETTLE_MS` 之内不算数(沿用桌面 `CARD_CODE_SETTLE_MS` 的意思:
 * 作者连着存盘时,别在中间态上认领),过了才报。读的时候按此刻的时间过滤;有没定下来的就起一个计时器,到点再通知订阅方。
 */

/** 新出现或换了身份的卡,过这么久才报(与 `server/card-code.mjs` 的 `CARD_CODE_SETTLE_MS` 同值;三级数字) */
export const NODE_CARD_SETTLE_MS = 1500;

export interface NodeCardInfo {
  /** 在线卡片运行时版本(`cardRuntime/version.ts`);本页不能执行用户卡与素材效果卡时为 null */
  cardRuntime: string | null;
  userCards: boolean;
  graphCards: boolean;
  /** 卡片 id → 代码身份(本页已载入成功、且身份已定下来的卡) */
  cardSources: Record<string, string>;
  /** 文档服务按运行时版本算给本节点的环境指纹(`node.welcome.cardEnvFingerprint`);没报到或没有为 null */
  cardEnvFingerprint: string | null;
}

export interface NodeCardInfoInput {
  cardRuntime: string | null;
  userCards: boolean;
  graphCards: boolean;
  cardSources: Readonly<Record<string, string>>;
}

/** 本页能运行的卡 → 登记的内容(纯函数,`nodeCardInfoLive.ts` 与单测用) */
export function computeNodeCardInfo(input: {
  /** 在线卡片运行时版本 */
  runtime: string;
  /** 本页此刻能不能执行同步来的卡(`cardRuntime/gate.ts` 的 `cardExecAvailable()`) */
  available: boolean;
  /** 这台设备的图形能力够不够跑素材效果卡(块 G 判;没判过当不够) */
  graphCapable: boolean;
  /** 同步来的卡(`syncedUserCards()`):id 与入口文件的键 */
  cards: Iterable<{ id: string; source?: string }>;
  /** 卡片 id → 运行状态名(`registry.cardRunState(id)?.state`) */
  stateOf: (id: string) => string | undefined;
  /** 入口文件的键 → 代码身份(`transpile.browser.codeIdentities`) */
  identities: Readonly<Record<string, string>>;
}): NodeCardInfoInput {
  if (!input.available || !input.runtime) return { cardRuntime: null, userCards: false, graphCards: false, cardSources: {} };
  const cardSources: Record<string, string> = {};
  for (const c of input.cards) {
    if (!c || typeof c.id !== "string" || !c.id || !c.source) continue;
    if (input.stateOf(c.id) !== "ready") continue;
    const identity = input.identities[c.source];
    if (typeof identity === "string" && identity) cardSources[c.id] = identity;
  }
  return { cardRuntime: input.runtime, userCards: true, graphCards: input.graphCapable === true, cardSources };
}

type Listener = () => void;
const listeners = new Set<Listener>();
let current: NodeCardInfoInput = { cardRuntime: null, userCards: false, graphCards: false, cardSources: {} };
let cardEnvFingerprint: string | null = null;
/** 卡片 id → 当前身份第一次出现的时刻 */
const since = new Map<string, { identity: string; at: number }>();
let timer: ReturnType<typeof setTimeout> | null = null;
let timerImpl: { set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>; clear: (t: ReturnType<typeof setTimeout>) => void } = {
  set: (fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; },
  clear: (t) => clearTimeout(t),
};

const sameSources = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

function notify() {
  for (const l of [...listeners]) { try { l(); } catch { /* 订阅方坏了 */ } }
}

function armTimer(now: number) {
  if (timer !== null) { timerImpl.clear(timer); timer = null; }
  let wait = Infinity;
  for (const [, s] of since) {
    const left = s.at + NODE_CARD_SETTLE_MS - now;
    if (left > 0 && left < wait) wait = left;
  }
  if (wait === Infinity) return;
  timer = timerImpl.set(() => { timer = null; notify(); }, wait + 5);
}

/** 整份换掉登记的内容(`nodeCardInfoLive.ts` 在注册表、闸门、代码身份任一变了时调);没变不通知 */
export function setNodeCardInfo(next: NodeCardInfoInput, now: number = Date.now()): boolean {
  const same = next.cardRuntime === current.cardRuntime && next.userCards === current.userCards && next.graphCards === current.graphCards
    && sameSources(next.cardSources, current.cardSources);
  if (same) return false;
  current = { cardRuntime: next.cardRuntime, userCards: next.userCards === true, graphCards: next.graphCards === true, cardSources: { ...next.cardSources } };
  for (const id of [...since.keys()]) if (!(id in current.cardSources)) since.delete(id);
  for (const [id, identity] of Object.entries(current.cardSources)) {
    const old = since.get(id);
    if (!old || old.identity !== identity) since.set(id, { identity, at: now });
  }
  armTimer(now);
  notify();
  return true;
}

/** 节点报到后文档服务回的 `cardEnvFingerprint`(没有传 null:下线、会话结束时清掉);没变不通知 */
export function setNodeCardEnvFingerprint(fp: string | null): boolean {
  const next = typeof fp === "string" && fp ? fp : null;
  if (next === cardEnvFingerprint) return false;
  cardEnvFingerprint = next;
  notify();
  return true;
}

/** 此刻登记的内容;身份还没定下来的卡(换代不到 `NODE_CARD_SETTLE_MS`)不在 `cardSources` 里 */
export function getNodeCardInfo(now: number = Date.now()): NodeCardInfo {
  const cardSources: Record<string, string> = {};
  for (const [id, identity] of Object.entries(current.cardSources)) {
    const s = since.get(id);
    if (!s || s.identity !== identity || now - s.at >= NODE_CARD_SETTLE_MS) cardSources[id] = identity;
  }
  return { cardRuntime: current.cardRuntime, userCards: current.userCards, graphCards: current.graphCards, cardSources, cardEnvFingerprint };
}

export function subscribeNodeCardInfo(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** 清空(下线、换项目、单测) */
export function resetNodeCardInfo(): void {
  current = { cardRuntime: null, userCards: false, graphCards: false, cardSources: {} };
  cardEnvFingerprint = null;
  since.clear();
  if (timer !== null) { timerImpl.clear(timer); timer = null; }
}

/** 仅供测试:换掉计时器 */
export function __setNodeCardInfoTimers(impl: typeof timerImpl | null): void {
  timerImpl = impl ?? {
    set: (fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; },
    clear: (t) => clearTimeout(t),
  };
}

/* ------------------------------------------------------------------ 这台设备的图形能力 */

let graphCapable = false;
/**
 * 这台设备的图形能力够不够跑素材效果卡(契约 4.3,块 G 判:WebGL2 可用、不是软件渲染、最大纹理够大、没丢过上下文)。
 * 缺省「不够」:判过之前不报 `graphCards`,素材效果卡的任务不会认领到这台设备。变了通知订阅方。
 */
export function setNodeGraphCapable(ok: boolean): boolean {
  const next = ok === true;
  if (next === graphCapable) return false;
  graphCapable = next;
  notify();
  return true;
}
export function nodeGraphCapable(): boolean {
  return graphCapable;
}

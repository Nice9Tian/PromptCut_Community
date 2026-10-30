/**
 * 本页能不能执行同步来的用户卡与素材效果卡(`docs/plan/online-card-exec-contract.md` 3.1 的前提)。
 *
 * 缺一条就不执行,整体退回原做法:
 *   - `site`:站点的总开关没关(运行配置 `runtime-config.json` 的 `onlineCardExec`,缺省开);
 *   - `isolated`:本页是双舞台且握手成功、舞台源与编辑页面不同源、舞台自检确认内容安全策略生效、素材票据交接成功。
 * 这两项由安全隔离那一块(舞台握手与自检)写进来;在它写之前本页**不执行**(缺省 `isolated: false`)——
 * 没有 nginx 的摆法(本机开发服务器、桌面版自己提供的页面)自检不过,就一直停在这个缺省上。
 * 单舞台、双舞台都一样判:舞台一律跨源隔离(2026-10-14 用户定),隔离会话按此刻挂着的舞台立起来(`online/stageIsolation.ts`)。
 *
 * 转译(`onlineCardSources.ts`)只在这里说「能」的时候才做,所以不能执行的页面不会去载入转译器那一块。
 */
export interface CardExecGate {
  /** 站点运行开关，尚未读取按开启，但隔离尚未就绪仍不执行。 */
  site: boolean | null;
  isolated: boolean;
  reason: string | null;
  /** 兼容调用者的画面状态字段；出口能力不作为执行条件。 */
  visual: boolean;
}

let gate: CardExecGate = { site: null, isolated: false, reason: "还没有隔离环境的结论", visual: true };
const listeners = new Set<() => void>();

export function cardExecGate(): Readonly<CardExecGate> {
  return gate;
}

/** 本页此刻能不能执行同步来的卡 */
export function cardExecAvailable(): boolean {
  return gate.site !== false && gate.isolated;
}

/** 本页此刻能不能执行同步来的卡的**画面**(声音线程只看 `cardExecAvailable`) */
export function cardVisualExecAvailable(): boolean {
  return cardExecAvailable();
}




/** 不能执行时,卡片该报哪一句(参数面板):站点关了与没有隔离环境是两句话,状态都是 `not-isolated` */
export function cardExecBlockedDetail(): string | null {
  if (gate.site === false) return "这个站点没有开启在线运行用户卡与素材效果卡";
  if (!gate.isolated) return null;
  return null;
}

export function setCardExecGate(patch: Partial<CardExecGate>): void {
  const next = { ...gate, ...patch };
  if (next.isolated) next.reason = null;
  if (next.site === gate.site && next.isolated === gate.isolated && next.reason === gate.reason && next.visual === gate.visual) return;
  gate = next;
  for (const l of [...listeners]) { try { l(); } catch { /* 订阅方坏了 */ } }
}

export function subscribeCardExecGate(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** 运行配置(`runtime-config.json` 解析后的对象或文本)里的总开关:只有明写 `false` 才是关 */
export function siteCardExecOf(config: unknown): boolean {
  let c: unknown = config;
  if (typeof c === "string") { try { c = JSON.parse(c); } catch { return true; } }
  return !(c && typeof c === "object" && (c as { onlineCardExec?: unknown }).onlineCardExec === false);
}

/** 单测用 */
export function resetCardExecGateForTest(): void {
  gate = { site: null, isolated: false, reason: "还没有隔离环境的结论", visual: true };
  listeners.clear();
}

/**
 * 在线双舞台两个舞台握手之后的看守(C10 契约第 2 节「握手之后又断」〔裁〕,2026-09-30)。
 *
 * 首次握手在 `STAGE_HANDSHAKE_TIMEOUT_MS` 内握不上才退回同源单舞台(`stageOrigins.ts`)。握上之后某一台卡死、崩溃
 * (跨源 iframe 的渲染进程崩了,父页收不到任何事件,`contentWindow` 也不会关)以前没人管:可见舞台那一台一断,
 * 预览就一直空白或停在旧画面。这里补上:
 *
 * - **心跳**:每 `STAGE_PING_INTERVAL_MS` 问每台已握手的舞台一次(调用方给 `ping`,Preview 用最便宜的 `size()` RPC);
 *   `STAGE_LOST_AFTER_MS` 内一次回包都没有,就算这一台断了。页面隐藏时不判(后台标签里定时器与舞台都被节流);
 *   父页自己的定时器晚到很多(父页主线程卡住)那一拍也不判,只把计时重新起算。
 * - **先重载那一台**:与原来「卡片代码没换上就整页重载那一台」同一种做法(调用方给 `reload`)。
 * - **重载也握不回来就退回单舞台**:重载后 `STAGE_RECONNECT_TIMEOUT_MS`(与首次握手同为 20 秒)内没等到那一台的
 *   `pc-stage-ready`,或 `STAGE_RELOAD_WINDOW_MS` 里已经重载过 `STAGE_MAX_RELOADS` 次(反复断),调用方的 `fallback`
 *   走首次握不上手时的同一条退回路径(`markStageHandshake("failed")`)。退回之后本看守作废,不再重载任何一台。
 *
 * 数字都是三级机制的参数。本模块属于 render 这一层:不引 editor,时钟与定时器可注入(单测用假时钟)。
 */
import { STAGE_HANDSHAKE_TIMEOUT_MS, type StageLetter } from "./stageOrigins.ts";

/** 心跳间隔 */
export const STAGE_PING_INTERVAL_MS = 5000;
/** 这么久一次回包都没有,就算这一台断了(三拍心跳;舞台里一次同步的补跑到不了这么长) */
export const STAGE_LOST_AFTER_MS = 15_000;
/** 重载之后等那一台重新握手的时限:与首次握手相同 */
export const STAGE_RECONNECT_TIMEOUT_MS = STAGE_HANDSHAKE_TIMEOUT_MS;
/** 父页的心跳定时器晚到超过这么多,算父页自己卡住,这一拍不判 */
export const STAGE_TICK_LATE_MS = STAGE_PING_INTERVAL_MS * 2;
/** 反复断:这段时间里重载到第 `STAGE_MAX_RELOADS` 次还要再重载,就直接退回单舞台 */
export const STAGE_MAX_RELOADS = 3;
export const STAGE_RELOAD_WINDOW_MS = 10 * 60_000;

type Timer = unknown;

export interface StageWatchDeps {
  ids: readonly StageLetter[];
  /** 问一次这台舞台还在不在:回 Promise(兑现 = 活着;拒绝或一直不回 = 没回包);回 null = 此刻没有客户端 */
  ping(id: StageLetter): Promise<unknown> | null;
  /** 重载这一台(原来的做法:丢掉它的 RPC 客户端、`frame.src = frame.src`) */
  reload(id: StageLetter, reason: string): void;
  /** 退回同源单舞台(首次握不上手的同一条路) */
  fallback(reason: string): void;
  /** 页面隐藏着(不判) */
  hidden?(): boolean;
  now?(): number;
  setTimer?(fn: () => void, ms: number): Timer;
  clearTimer?(t: Timer): void;
  /** 诊断 */
  log?(msg: string): void;
}

export type StageWatchStatus = "pending" | "alive" | "reloading";

export interface StageWatch {
  /** 这一台握上手了(`pc-stage-ready`):开始 / 恢复看守 */
  ready(id: StageLetter): void;
  /** 外部判定这一台断了(例如调用方另有证据):与心跳超时同一条处理 */
  lost(id: StageLetter, reason: string): void;
  /** 退回过了没有 */
  readonly fellBack: boolean;
  status(id: StageLetter): StageWatchStatus;
  /** 重载过几次(诊断与测试) */
  readonly reloads: number;
  dispose(): void;
}

interface Slot {
  status: StageWatchStatus;
  lastAlive: number;
  inflight: boolean;
  /** 每次 ready / reload 换一代,旧一代的心跳回包不算数 */
  gen: number;
  deadline: Timer | null;
}

export function createStageWatch(deps: StageWatchDeps): StageWatch {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t: Timer) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const hidden = deps.hidden ?? (() => false);
  const log = deps.log ?? (() => {});
  const slots = new Map<StageLetter, Slot>();
  for (const id of deps.ids) slots.set(id, { status: "pending", lastAlive: now(), inflight: false, gen: 0, deadline: null });
  const reloadTimes: number[] = [];
  let reloads = 0;
  let disposed = false;
  let fellBack = false;
  let tickTimer: Timer | null = null;
  let lastTick = now();

  const stopAll = () => {
    disposed = true;
    if (tickTimer !== null) { clearTimer(tickTimer); tickTimer = null; }
    for (const s of slots.values()) if (s.deadline !== null) { clearTimer(s.deadline); s.deadline = null; }
  };

  const fallback = (reason: string) => {
    if (disposed) return;
    fellBack = true;
    stopAll();
    log(`退回单舞台:${reason}`);
    try { deps.fallback(reason); } catch { /* 调用方坏了也不再重试 */ }
  };

  const armDeadline = (id: StageLetter, s: Slot) => {
    const gen = s.gen;
    s.deadline = setTimer(() => {
      s.deadline = null;
      if (disposed || s.status !== "reloading" || s.gen !== gen) return;
      // 页面隐藏期间不判:iframe 的载入与舞台的启动都可能被节流,等回到前台再给一整段时限
      if (hidden()) { armDeadline(id, s); return; }
      fallback(`舞台 ${id} 断开后重载,${Math.round(STAGE_RECONNECT_TIMEOUT_MS / 1000)} 秒内没握回来`);
    }, STAGE_RECONNECT_TIMEOUT_MS);
  };

  const lost = (id: StageLetter, reason: string) => {
    if (disposed) return;
    const s = slots.get(id);
    if (!s || s.status !== "alive") return;
    const t = now();
    while (reloadTimes.length && t - reloadTimes[0] > STAGE_RELOAD_WINDOW_MS) reloadTimes.shift();
    if (reloadTimes.length >= STAGE_MAX_RELOADS) {
      fallback(`舞台 ${id} 反复断开(${Math.round(STAGE_RELOAD_WINDOW_MS / 60_000)} 分钟内已重载 ${reloadTimes.length} 次):${reason}`);
      return;
    }
    reloadTimes.push(t);
    reloads++;
    s.status = "reloading";
    s.gen++;
    s.inflight = false;
    log(`舞台 ${id} 断开,重载它:${reason}`);
    try { deps.reload(id, reason); } catch { /* 重载失败照样等时限,到点退回 */ }
    armDeadline(id, s);
  };

  const tick = () => {
    tickTimer = null;
    if (disposed) return;
    const t = now();
    const late = t - lastTick > STAGE_TICK_LATE_MS;
    lastTick = t;
    if (hidden() || late) {
      // 不判:把计时重新起算,免得回到前台 / 父页缓过来的那一拍把活着的舞台判成断开
      for (const s of slots.values()) if (s.status === "alive") s.lastAlive = t;
    } else {
      for (const [id, s] of slots) {
        if (s.status !== "alive") continue;
        if (t - s.lastAlive > STAGE_LOST_AFTER_MS) { lost(id, `${Math.round((t - s.lastAlive) / 1000)} 秒没有心跳回包`); continue; }
        if (s.inflight) continue;
        let p: Promise<unknown> | null = null;
        try { p = deps.ping(id); } catch { p = null; }
        if (!p) continue;
        s.inflight = true;
        const gen = s.gen;
        p.then(() => {
          if (s.gen !== gen) return;
          s.inflight = false;
          s.lastAlive = now();
        }, () => {
          if (s.gen !== gen) return;
          s.inflight = false;
        });
      }
    }
    if (!disposed) tickTimer = setTimer(tick, STAGE_PING_INTERVAL_MS);
  };
  tickTimer = setTimer(tick, STAGE_PING_INTERVAL_MS);

  return {
    ready(id) {
      if (disposed) return;
      const s = slots.get(id);
      if (!s) return;
      if (s.deadline !== null) { clearTimer(s.deadline); s.deadline = null; }
      if (s.status === "reloading") log(`舞台 ${id} 重载后握回来了`);
      s.status = "alive";
      s.gen++;
      s.inflight = false;
      s.lastAlive = now();
    },
    lost,
    get fellBack() { return fellBack; },
    get reloads() { return reloads; },
    status(id) { return slots.get(id)?.status ?? "pending"; },
    dispose() { stopAll(); },
  };
}

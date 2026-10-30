/**
 * 后台舞台的后台活由编辑器页判空闲、经 RPC 发开始 / 停止(C10 契约第 2 节「后台舞台的摆放与节拍」〔裁:探针 P2〕)。
 *
 * 后台舞台 `opacity: 0` 原位叠放:它自己的 `requestIdleCallback` 多半等到超时才回调(每秒只推进 1～4.7 帧),不能用来定节拍;
 * 页面隐藏时浏览器也不会替你停(无头切标签仍每秒 1.2～2 帧、有头最小化仍 24～27 帧)。所以由父页(不透明,rAF 与 rIC 正常)判:
 *
 *   开 ⇔ 页面可见 ∧ 父页的 rAF 间隔没有持续超过 `RAF_GAP_PAUSE_MS` ∧ 父页自己的 `requestIdleCallback` 在 `IDLE_STALE_MS` 之内回调过
 *
 * 判出来变了就 `back.setBackWork(on)`;后台舞台换了人(K5 互换、iframe 重载)也重发一次。舞台里逐帧 `setTimeout(0)` 推进、
 * 帧与帧之间查这个标志(`StageView.tsx` 的 `backGate`)。
 *
 * 只在在线双舞台的双舞台上开(`Preview.tsx`);桌面运行环境照旧,不发这条 RPC。
 */
import type { StageRpcClient } from "../render/stageRpc";

/** 父页 rAF 间隔持续超过这么久就暂停后台活(C10 契约第 2 节) */
export const RAF_GAP_PAUSE_MS = 500;
/** 父页的 rIC 这么久没回调过,就当父页不空闲 */
export const IDLE_STALE_MS = 1000;
/** 多久判一次(页面隐藏时 rAF 停了,靠这个定时器发现) */
export const BACK_WORK_CHECK_MS = 200;

export interface BackWorkInput {
  visible: boolean;
  now: number;
  lastRafAt: number;
  lastIdleAt: number;
}

/** 纯判定:回开不开、不开的原因 */
export function judgeBackWork({ visible, now, lastRafAt, lastIdleAt }: BackWorkInput): { on: boolean; reason: "hidden" | "raf-gap" | "busy" | null } {
  if (!visible) return { on: false, reason: "hidden" };
  if (now - lastRafAt > RAF_GAP_PAUSE_MS) return { on: false, reason: "raf-gap" };
  if (now - lastIdleAt > IDLE_STALE_MS) return { on: false, reason: "busy" };
  return { on: true, reason: null };
}

export interface BackWorkGateDeps {
  /** 此刻的后台舞台(双舞台的 back);没有回 null */
  back: () => StageRpcClient | null;
  now?: () => number;
  visible?: () => boolean;
}

export interface BackWorkDiag {
  on: boolean;
  reason: string | null;
  /** 判定变过几次 */
  changes: number;
  /** 发过几次 setBackWork */
  sent: number;
  /** 暂停过几次,各原因各几次 */
  pauses: Record<string, number>;
}

let diag: BackWorkDiag = { on: true, reason: null, changes: 0, sent: 0, pauses: {} };

export function backWorkDiag(): BackWorkDiag {
  return { ...diag, pauses: { ...diag.pauses } };
}

/** 开始判;回停止函数(停止时对后台舞台发一次「开」,把它交还给缺省状态) */
export function startBackWorkGate(deps: BackWorkGateDeps): () => void {
  const now = deps.now ?? (() => performance.now());
  const visible = deps.visible ?? (() => typeof document === "undefined" || document.visibilityState !== "hidden");
  let lastRafAt = now();
  let lastIdleAt = now();
  let stopped = false;
  let current = true;
  let sentTo: StageRpcClient | null = null;
  let sentOn: boolean | null = null;
  diag = { on: true, reason: null, changes: 0, sent: 0, pauses: {} };

  let raf = 0;
  const onRaf = () => { lastRafAt = now(); if (!stopped) raf = requestAnimationFrame(onRaf); };
  raf = requestAnimationFrame(onRaf);

  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  const cic = (globalThis as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
  let idleId = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const onIdle = () => {
    lastIdleAt = now();
    if (stopped) return;
    // 每 100 ms 问一次就够:rIC 连着排会一直占着空闲时段
    idleTimer = setTimeout(() => { idleTimer = null; if (!stopped) scheduleIdle(); }, 100);
  };
  const scheduleIdle = () => {
    if (typeof ric === "function") idleId = ric(onIdle, { timeout: 2000 });
    else idleTimer = setTimeout(onIdle, 50);
  };
  scheduleIdle();

  const push = () => {
    const back = deps.back();
    if (!back || back.disposed) { sentTo = null; sentOn = null; return; }
    if (back === sentTo && sentOn === current) return;
    sentTo = back;
    sentOn = current;
    diag.sent++;
    void back.setBackWork(current).catch(() => { sentTo = null; sentOn = null; });
  };

  const check = () => {
    if (stopped) return;
    const j = judgeBackWork({ visible: visible(), now: now(), lastRafAt, lastIdleAt });
    if (j.on !== current) {
      current = j.on;
      diag.changes++;
      if (!j.on && j.reason) diag.pauses[j.reason] = (diag.pauses[j.reason] ?? 0) + 1;
    }
    diag.on = current;
    diag.reason = j.reason;
    push();
  };
  const timer = setInterval(check, BACK_WORK_CHECK_MS);
  const onVisibility = () => {
    // 回到前台:rAF 刚恢复,先当它刚来过一次,免得「隐藏期间没有 rAF」被判成间隔过长、多停一轮
    if (visible()) { lastRafAt = now(); lastIdleAt = now(); }
    check();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
  check();

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    clearInterval(timer);
    if (idleTimer) clearTimeout(idleTimer);
    if (idleId && typeof cic === "function") cic(idleId);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    const back = deps.back();
    if (back && !back.disposed && sentOn === false) void back.setBackWork(true).catch(() => {});
  };
}

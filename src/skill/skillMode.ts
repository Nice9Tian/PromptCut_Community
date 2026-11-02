/**
 * SKILL 模式在前端这一侧:订阅状态、开关、以及通知桌面壳变形。
 *
 * SKILL 是两种工作方式之一(`user-workflow.md`「工作方式」):桌面 APP 里的 Agent 经 MCP 直连这个项目
 * (计划 `docs/plan/agent-workflow-plan.md` A4)。开关只决定桌面 APP 的会话能不能动手(服务端的 SKILL 闸,
 * `server/skill-gate.mjs`),AI 栏的 Agent 两种方式下都能用。
 *
 * 真相源是服务端那个状态文件,不是这里的变量 —— Rust 壳是另一个进程,只有那个文件是两边都能约定的地方。
 * 这里做的事只有三件:每秒问一次、把结果发给订阅者、状态一变就通知壳。
 *
 * 为什么是轮询不是 SSE:壳那边本来就在轮询同一个文件(Rust 里没有网页那套事件流),
 * 前端再单独搞一套推送只会让两边看到的时刻对不上。一秒一次的 JSON 请求便宜得很。
 */
import { onlinePage } from "../online/pageFlag";
import { tr } from "../i18n/index.ts";

export interface SkillState {
  active: boolean;
  since: string | null;
  closedAt: string | null;
  closedBy: string | null;
}

export interface SkillSnapshot {
  state: SkillState;
}

const CLOSED: SkillState = { active: false, since: null, closedAt: null, closedBy: null };

let snapshot: SkillSnapshot = { state: CLOSED };
const listeners = new Set<(s: SkillSnapshot) => void>();
let timer: number | null = null;
/** 上一次通知壳的状态,只在真的翻转时才发事件 */
let lastNotified: boolean | null = null;

function emit() {
  for (const fn of listeners) fn(snapshot);
}

/**
 * 告诉桌面壳「进/出 SKILL 模式了」。
 *
 * 壳收到之后收起主窗、变成右上角的悬浮图标(反之恢复)。走 window.__TAURI__ 的事件,
 * 和「外观 → 皮肤…」那条是同一个路子;不是桌面版就什么都不做,浏览器里照常用。
 */
function notifyShell(active: boolean) {
  if (lastNotified === active) return;
  lastNotified = active;
  const tauri = (window as unknown as {
    __TAURI__?: { event?: { emit?: (e: string, payload?: unknown) => Promise<unknown> } };
  }).__TAURI__;
  void tauri?.event?.emit?.("pc-skill-mode", { active, at: new Date().toISOString() })?.catch?.(() => {});
}

async function poll() {
  // 在线浏览器模式没有 SKILL 模式(要本机编辑器进程):不问
  if (onlinePage()) return;
  try {
    const res = await fetch("/api/skill-mode");
    const data = await res.json();
    if (data?.ok) {
      const s = data.state ?? {};
      snapshot = { state: { ...CLOSED, active: s.active === true, since: s.since ?? null, closedAt: s.closedAt ?? null, closedBy: s.closedBy ?? null } };
      notifyShell(snapshot.state.active);
      emit();
    }
  } catch {
    /* dev server 没起来 / 正在重启,下一秒再问,别把界面弄成报错 */
  }
}

export function subscribeSkill(fn: (s: SkillSnapshot) => void): () => void {
  listeners.add(fn);
  fn(snapshot);
  if (timer === null) {
    void poll();
    timer = window.setInterval(() => void poll(), 1000);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

export function getSkillSnapshot(): SkillSnapshot {
  return snapshot;
}

async function post(path: string, body: unknown, what: string): Promise<void> {
  // 超时、非 2xx、服务端说没成,都抛出去让按钮复位并把原因显示出来(以前不看响应,按钮会一直停在「…中」)
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new Error(tr("{0} request was not sent: {1}", what, e instanceof Error ? e.message : String(e)));
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    throw new Error(tr("{0} request was rejected (HTTP {1}): {2}", what, res.status, data?.error ?? tr("the server gave no reason")));
  }
}

/** 开:用户在顶栏切到 SKILL。之后桌面 APP 的会话可以动手 */
export async function openSkillMode(): Promise<void> {
  await post("/api/skill-mode/open", {}, tr("Open SKILL mode"));
  await poll();
}

/** 关:用户切回传统式。之后桌面 APP 会话的任何工具调用都会被拒(AI 栏的 Agent 不受影响) */
export async function closeSkillMode(by = "user"): Promise<void> {
  await post("/api/skill-mode/close", { by }, tr("Close SKILL mode"));
  await poll();
  if (snapshot.state.active) {
    throw new Error(tr("The close request succeeded, but the server still reports SKILL mode as on. Another instance may be changing the state at the same time, try again"));
  }
}

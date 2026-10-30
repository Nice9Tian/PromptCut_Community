/**
 * 「Agent 浏览器」页签与面板的状态(桌面壳模式)。
 *
 * agent 撞上登录 / 验证码调 web_handoff 时,壳模式下 Node 那边只回一个 shell 标记;
 * 这边**不弹窗打断用户**,只把 pending 点亮:顶栏的「浏览器」页签开始闪、冒一个
 * 「有待操作」的气泡,用户自己决定什么时候点过去。点了才把子 webview 摆进面板。
 *
 * 和 collectLoginStore 一样放在模块级:执行器(mcpExecutor)里没有组件上下文。
 */
import { useSyncExternalStore } from "react";

export interface AgentBrowserState {
  /** 壳里有没有 agent webview(浏览器里跑 npm run dev 时没有,页签整个不显示) */
  available: boolean;
  /** 面板开着(子 webview 摆在编辑区上) */
  open: boolean;
  /** agent 在等人:页签闪烁 + 气泡 */
  pending: boolean;
  /** 显示给用户看的原因,例如「B 站扫码登录」 */
  reason: string;
  /** 面板打开的序号,每开一次加一,组件用它重置内部状态 */
  seq: number;
}

let state: AgentBrowserState = { available: false, open: false, pending: false, reason: "", seq: 0 };
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const set = (patch: Partial<AgentBrowserState>) => { state = { ...state, ...patch }; emit(); };

export function setAgentBrowserAvailable(available: boolean): void {
  if (state.available !== available) set({ available });
}

/** agent 把浏览器交给用户:点亮页签,不打开面板。面板已经开着就只更新原因 */
export function requestAgentBrowser(reason = ""): void {
  set({ reason, pending: !state.open });
}

/** 用户点了页签(或别处要求直接看):打开面板,pending 清掉 */
export function openAgentBrowser(reason?: string): void {
  set({ open: true, pending: false, reason: reason ?? state.reason, seq: state.seq + 1 });
}

export function closeAgentBrowser(): void {
  if (!state.open && !state.pending) return;
  set({ open: false, pending: false });
}

export function toggleAgentBrowser(): void {
  if (state.open) closeAgentBrowser();
  else openAgentBrowser();
}

export function getAgentBrowserState(): AgentBrowserState {
  return state;
}

export function useAgentBrowserState(): AgentBrowserState {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => state,
    () => state,
  );
}

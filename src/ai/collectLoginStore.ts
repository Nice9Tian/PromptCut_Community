/**
 * 「站点登录」弹窗的开关。
 *
 * 弹窗要从两个地方打开:开始页的「素材收集」卡(用户自己点),和 MCP 工具 collect_login
 * (agent 调)。后者跑在 index.tsx 的执行器里,拿不到任何组件的 setState,所以开关放在
 * 模块级,组件用 useSyncExternalStore 订阅。
 */
import { useSyncExternalStore } from "react";

export type LoginMethod = "qr" | "browser";

export interface CollectLoginState {
  open: boolean;
  site: string;
  method: LoginMethod;
  /** 打开的序号,每开一次加一,组件用它重置内部状态 */
  seq: number;
}

let state: CollectLoginState = { open: false, site: "bilibili", method: "qr", seq: 0 };
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function openCollectLogin(site = "bilibili", method: LoginMethod = "qr"): void {
  state = { open: true, site, method, seq: state.seq + 1 };
  emit();
}

export function closeCollectLogin(): void {
  if (!state.open) return;
  state = { ...state, open: false };
  emit();
}

export function getCollectLoginState(): CollectLoginState {
  return state;
}

export function useCollectLoginState(): CollectLoginState {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => state,
    () => state,
  );
}

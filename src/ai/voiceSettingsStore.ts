/**
 * 「配音设置」窗口的开关。
 *
 * 要从两处打开:开始页「拓展功能」里的配音卡、编辑台顶栏的「配音设置」按钮。
 * 两处不在同一棵组件树的同一层,开关放在模块级,组件用 useSyncExternalStore 订阅
 * (和 collectLoginStore 一个路数)。
 */
import { useSyncExternalStore } from "react";

export interface VoiceSettingsState {
  open: boolean;
  /** 打开的序号,每开一次加一,窗口用它重置内部状态(重新读一次设置) */
  seq: number;
}

let state: VoiceSettingsState = { open: false, seq: 0 };
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function openVoiceSettings(): void {
  state = { open: true, seq: state.seq + 1 };
  emit();
}

export function closeVoiceSettings(): void {
  if (!state.open) return;
  state = { ...state, open: false };
  emit();
}

export function useVoiceSettingsState(): VoiceSettingsState {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => state,
    () => state,
  );
}

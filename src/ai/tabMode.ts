/**
 * 桌面版 AI 栏里哪一页选了「云端」(契约 9.5):只记在这个页签上,只放内存。
 * 「云端」从不被自动选中,也不记成全局缺省;刷新页面或重启软件之后每一页回到本机接入方式,
 * 云端对话在历史列表「云端」一组里找回(契约 7.4)。
 *
 * （原在 `src/ai/cloud/tabMode.ts`，上移至公开侧 `src/ai/tabMode.ts`）
 */
import { useSyncExternalStore } from "react";

export interface CloudTabMode {
  selected: boolean;
  /** 从历史列表点进来的云端对话;进云端页之后用一次 */
  conversationId: string | null;
}

const OFF: CloudTabMode = Object.freeze({ selected: false, conversationId: null });
const modes = new Map<string, CloudTabMode>();
const listeners = new Set<() => void>();

const emit = () => { for (const l of [...listeners]) l(); };

export function selectCloudTab(tabId: string, conversationId: string | null = null): void {
  modes.set(tabId, { selected: true, conversationId });
  emit();
}

export function leaveCloudTab(tabId: string): void {
  if (!modes.delete(tabId)) return;
  emit();
}

export function getCloudTab(tabId: string): CloudTabMode {
  return modes.get(tabId) ?? OFF;
}

export function useCloudTab(tabId: string): CloudTabMode {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => getCloudTab(tabId),
    () => OFF,
  );
}

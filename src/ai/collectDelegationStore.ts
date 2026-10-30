/**
 * 本机采集代下在页面这一侧(0.7.18,工具包 C1;服务端是 `server/agent/service/collect-bridge.mjs`)的在途状态与取消口。
 *
 * （原在 `src/ai/cloud/collectBridge.ts` 385-402 行，上移至公开侧 `src/ai/collectDelegationStore.ts`，
 * 供顶栏 `src/editor/TopBar.tsx` 只读订阅在途代下 URL；社区版无云端采集桥挂入时恒为 `null`）
 */
let activeDelegationUrl: string | null = null;
const delegationListeners = new Set<() => void>();
const activeCollectors = new Set<{ cancelActive(): Promise<void> }>();

export function getActiveCollectDelegationUrl(): string | null {
  return activeDelegationUrl;
}

export function setActiveCollectDelegationUrl(next: string | null): void {
  if (next === activeDelegationUrl) return;
  activeDelegationUrl = next;
  for (const l of [...delegationListeners]) l();
}

export function subscribeActiveCollectDelegation(listener: () => void): () => void {
  delegationListeners.add(listener);
  return () => {
    delegationListeners.delete(listener);
  };
}

export function registerActiveCollector(collector: { cancelActive(): Promise<void> }): () => void {
  activeCollectors.add(collector);
  return () => {
    activeCollectors.delete(collector);
  };
}

export async function cancelAllCollectDelegations(): Promise<void> {
  for (const c of [...activeCollectors]) {
    await c.cancelActive();
  }
}

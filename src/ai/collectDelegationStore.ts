/**
 * In-flight status and cancellation handle on the page side for local collection delegated
 * downloads (0.7.18, toolkit C1; server is `server/agent/service/collect-bridge.mjs`).
 *
 * (Originally in `src/ai/cloud/collectBridge.ts` lines 385-402, moved up to public side
 * `src/ai/collectDelegationStore.ts` for top bar `src/editor/TopBar.tsx` to read-only subscribe to
 * in-flight delegated download URLs; always `null` in community edition when no cloud collection
 * bridge is hooked in)
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

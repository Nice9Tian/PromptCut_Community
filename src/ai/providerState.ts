import type { ProviderInfo, RunEvent, SttInfo } from './types';

// One authority per editor document. Tabs share requests and transition barriers.
let providers: ProviderInfo[] = [];
let epoch = 0;
let generation: string | undefined;
let timer: number | undefined;
const listeners = new Set<(list: ProviderInfo[]) => void>();
const publish = (list: ProviderInfo[]) => {
  const nextGeneration = list.find(p => p.id === 'codex')?.auth?.authGeneration;
  if (nextGeneration && generation && nextGeneration !== generation) epoch++;
  providers = list;
  generation = nextGeneration ?? generation;
  for (const listener of listeners) listener(list);
};

export async function refreshProviders(refresh = false): Promise<{ providers: ProviderInfo[]; stt?: SttInfo }> {
  const before = epoch;
  const res = await fetch('/api/ai/providers' + (refresh ? '?refresh=1' : ''), { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('无法获取 AI 服务状态');
  const data = await res.json();
  const list = Array.isArray(data) ? data : data.providers || [];
  if (before === epoch) publish(list);
  return { providers, stt: data.stt };
}

export function reportAuthFailure(ev: Extract<RunEvent, { type: 'error' }>) {
  if (ev.authProvider !== 'codex' || !ev.authReason) return;
  epoch++;
  generation = ev.authGeneration;
  publish(providers.map(p => p.id === 'codex' ? { ...p, auth: {
    ...p.auth, loggedIn: ev.authReason === 'state_unknown' ? null : false,
    status: ev.authReason === 'state_unknown' ? 'unknown' : 'invalid',
    reason: ev.authReason, authGeneration: ev.authGeneration, fixHint: ev.message,
  } } : p));
  void refreshProviders(true).catch(() => {});
}

async function poll() {
  const before = epoch;
  try {
    const res = await fetch('/api/ai/auth-state', { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      const revision = data.codex?.revision ?? data.codex?.generation;
      if (before === epoch && revision && generation === undefined) generation = revision;
      else if (before === epoch && revision && revision !== generation) {
        epoch++;
        generation = revision;
        if (data.codex.state !== 'normal' && data.codex.auth) {
          // Negative evidence is available without waiting for any local CLI probe.
          publish(providers.map(p => p.id === 'codex' ? { ...p, auth: { ...p.auth, ...data.codex.auth } } : p));
        }
        // Refresh after every transition, including successful login and backend restart.
        await refreshProviders(true);
      }
    }
  } catch { /* Keep the last known state when transport is unavailable. */ }
  finally { if (listeners.size) timer = window.setTimeout(poll, 2000); }
}

export function subscribeProviders(listener: (list: ProviderInfo[]) => void) {
  const first = listeners.size === 0;
  listeners.add(listener);
  if (providers.length) listener(providers);
  if (first) void poll();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.clearTimeout(timer);
  };
}

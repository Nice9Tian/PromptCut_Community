/**
 * 时间轴要看的「这个片段的预渲染结果覆盖整段没有」(C10 契约第 9 节的徽标)。数据在在线来源里
 * (`OnlineSnapshotSource.coverage`),时间轴组件经这里读、订阅变化;在线来源由 `Preview` 挂上 / 摘下。
 * 桌面不挂来源:`clipCoverage` 恒为 null(桌面也不出徽标)。
 */
import type { LayerCoverage } from "../render/snapshotSource";

interface CoverageSource {
  coverage(clipId: string): LayerCoverage;
  subscribeCoverage(cb: () => void): () => void;
}

let source: CoverageSource | null = null;
let off: (() => void) | null = null;
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const l of [...listeners]) { try { l(); } catch { /* 订阅方坏了 */ } }
}

export function setCoverageSource(next: CoverageSource | null): void {
  if (next === source) return;
  off?.();
  off = null;
  source = next;
  if (next) off = next.subscribeCoverage(bump);
  bump();
}

export function clipCoverage(clipId: string): LayerCoverage | null {
  return source ? source.coverage(clipId) : null;
}

export function subscribeCoverage(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function coverageVersion(): number {
  return version;
}

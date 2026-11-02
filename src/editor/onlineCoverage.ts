/**
 * What the timeline wants to know: "does this clip's prerender output cover the whole clip" (the badge of
 * C10 contract section 9). The data is in the online source (`OnlineSnapshotSource.coverage`); the
 * timeline component reads it and subscribes to changes through here; the online source is attached and
 * detached by `Preview`.
 * The desktop attaches no source: `clipCoverage` is always null (the desktop shows no badge either).
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
  for (const l of [...listeners]) { try { l(); } catch { /* The subscriber is broken */ } }
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

/**
 * Network speed sub-gate of the asset gate (semantics per `product/platforms.md` "Online browser" ->
 * "Asset gate": network speed is not measured separately, but based on actual asset download speed,
 * adjusted on the fly during use; it only decides whether to fetch small size first). Runs in the
 * online page's stage (the stage reads assets itself), and writes the result to the stage's tier
 * selection policy `smallFirst` (`mediaTier.ts`).
 *
 * Measurement method: inspects browser Resource Timing (`PerformanceObserver`'s `resource`; Chrome
 * also records segmented requests for `<video>`, `initiatorType: "video"`, see report for actual
 * tests), only looking at asset service requests (address contains `/media`), where a segment must
 * be at least `MIN_SAMPLE_BYTES` bytes with a download duration (`responseEnd − responseStart`) of
 * at least `MIN_SAMPLE_MS` to count as a sample (too short indicates a cache hit or headers-only,
 * which cannot be measured accurately); speed = bytes × 8 / download duration, using an exponential
 * moving average (`EWMA_ALPHA`).
 *
 * Thresholds [ruling] (see report "Numbers and rationale" for the basis of the numbers): when the
 * moving average is below `SLOW_BELOW_MBPS`, switch to fetching small size first, then replacing
 * with original size; above `FAST_ABOVE_MBPS`, only fetch original size; the middle range remains
 * unchanged (prevents flapping). When there are no samples yet, small first, then original (same as
 * C6.6 originally).
 *
 * If the browser does not report Resource Timing (older Safari), there will never be samples:
 * follow small first, then original, same as before.
 */

export const SLOW_BELOW_MBPS = 8;
export const FAST_ABOVE_MBPS = 12;
export const EWMA_ALPHA = 0.3;
export const MIN_SAMPLE_BYTES = 256 * 1024;
export const MIN_SAMPLE_MS = 50;

export interface NetSpeedState {
  /** Moving average (megabits per second); null if there are no samples */
  mbps: number | null;
  samples: number;
  /** Fetch small size first (slow, no samples yet) / fetch original size only (fast) */
  smallFirst: boolean;
}

export interface ResourceSample { name: string; initiatorType?: string; encodedBodySize?: number; transferSize?: number; responseStart?: number; responseEnd?: number }

/** Whether a resource timing entry qualifies as a sample and its calculated speed (Mbps); returns null if invalid */
export function sampleMbps(e: ResourceSample): number | null {
  if (!/\/media/.test(String(e.name || ""))) return null;
  const bytes = Number(e.encodedBodySize) || Number(e.transferSize) || 0;
  const ms = Number(e.responseEnd) - Number(e.responseStart);
  if (!(bytes >= MIN_SAMPLE_BYTES) || !(ms >= MIN_SAMPLE_MS)) return null;
  return (bytes * 8) / (ms / 1000) / 1e6;
}

/** Adds a sample: returns the new state (pure function) */
export function addSample(s: NetSpeedState, mbps: number): NetSpeedState {
  const avg = s.mbps === null ? mbps : s.mbps + EWMA_ALPHA * (mbps - s.mbps);
  let smallFirst = s.smallFirst;
  if (avg < SLOW_BELOW_MBPS) smallFirst = true;
  else if (avg > FAST_ABOVE_MBPS) smallFirst = false;
  return { mbps: avg, samples: s.samples + 1, smallFirst };
}

let state: NetSpeedState = { mbps: null, samples: 0, smallFirst: true };
let observer: { disconnect(): void } | null = null;

export function netSpeedState(): NetSpeedState {
  return state;
}

/**
 * Starts observing (called once by stage on online pages); `onChange` is called when switching
 * between small-first and original-only. Returns the stop function.
 */
export function startNetSpeed(onChange: (s: NetSpeedState) => void): () => void {
  const PO = (globalThis as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
  if (typeof PO !== "function" || observer) return () => {};
  try {
    const po = new PO((list) => {
      for (const e of list.getEntries() as unknown as ResourceSample[]) {
        const m = sampleMbps(e);
        if (m === null) continue;
        const prev = state;
        state = addSample(state, m);
        if (prev.smallFirst !== state.smallFirst) { try { onChange(state); } catch { /* Caller is broken */ } }
      }
    });
    po.observe({ type: "resource", buffered: true });
    observer = po;
  } catch {
    observer = null;
  }
  return () => { observer?.disconnect(); observer = null; };
}

/** For tests */
export function resetNetSpeedForTest(next: Partial<NetSpeedState> = {}): void {
  state = { mbps: null, samples: 0, smallFirst: true, ...next };
  observer?.disconnect();
  observer = null;
}

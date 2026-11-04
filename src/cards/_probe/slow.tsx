import type { CardDef, CardProps } from "../../kernel/types";
import { useRef } from "react";
import { isExportMode } from "../../kernel/clock";

/**
 * The test-case card for K6: **every React render burns `burnMs` milliseconds**.
 *
 * The K6 acceptance check wants "artificially raise a card's cost to 50 ms, playback does not drop
 * frames, the `frame` interval becomes about 50 ms, every tick exceeds 40 ms... within one second K6
 * triggers a downgrade". No card in the card library is **steadily** that slow: the ones that are
 * truly expensive (particles, 3D) are expensive in rAF callbacks and on the GPU, and the numbers
 * change as soon as the machine changes, so the "50 ms" in the acceptance check became a number that
 * cannot be measured accurately. So a card whose cost is set directly by a parameter is placed here.
 *
 * Why the time is burned in render rather than in the rAF callback: K6 picks "the most expensive
 * light card" by the `<Profiler>` that the live route of `FrameScene` wraps around each clip
 * (`actualDuration` from `onRender`), which measures the render / commit of that clip's subtree.
 * The rAF callback runs inside `clock.tick`, and there is no reliable ownership relation between
 * the callback and the clip (see the correction suggestion in the report).
 *
 * Timing uses `__pcRealNow` (the stage replaced `performance.now` with a virtual clock, and using it
 * would spin idle forever).
 */
/**
 * `padNodes`: draws this many extra dots in the orange block (each an absolutely positioned
 * `<span>`), only to make this layer's snapshot larger. The frame-swap cost of swapping snapshots per
 * tick online is estimated by snapshot size (`swapCostOfSize` in `src/render/beatSwap.mjs`), and
 * `c10-browser-probe` needs a heavy layer that "really cannot be swapped in time".
 * Default 0: not a single extra node, and the picture and snapshot are byte-identical to before.
 */
function PadDots({ n }: { n: number }) {
  const dots = [];
  for (let i = 0; i < n; i++) {
    dots.push(
      <span key={i} style={{ position: "absolute", left: 488 + (i % 20) * 15, top: 428 + Math.floor(i / 20) * 11, width: 6, height: 6, borderRadius: 3, background: "rgba(255,255,255,0.35)" }} />,
    );
  }
  return <>{dots}</>;
}

function ProbeSlowCard({ params, t }: CardProps<{ burnMs: number; label: string; padNodes?: number }>) {
  const burn = Math.max(0, Number(params.burnMs) || 0);
  if (burn > 0) {
    const now = (window as unknown as { __pcRealNow?: () => number }).__pcRealNow ?? (() => Date.now());
    const until = now() + burn;
    // Busy-wait: what is wanted is exactly "this tick's React render really took this long"
    while (now() < until) { /* Burn time */ }
  }
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div
        data-pc-probe="slow"
        style={{
          position: "absolute", left: 480, top: 420, width: 320, height: 240, borderRadius: 24,
          background: "#f97316", color: "#fff", fontSize: 40, display: "grid", placeItems: "center",
          // Make it change every frame, so React does not memoize this branch away
          transform: `translateX(${((t ?? 0) * 10).toFixed(2)}px)`,
        }}
      >
        {params.label}
      </div>
      {Number(params.padNodes) > 0 ? <PadDots n={Math.min(2000, Math.floor(Number(params.padNodes)))} /> : null}
    </div>
  );
}

export const probeSlowCard: CardDef<{ burnMs: number; label: string; padNodes?: number }> = {
  id: "probe-slow",
  name: "Probe card · tunable cost",
  description: "K6 precedent: each render burns burnMs milliseconds (busy-wait with __pcRealNow), used to artificially raise the per-tick cost of a card",
  source: "native",
  // direct: evaluated directly by t with no animation history. What K6 wants is "a **light** card
  // being downgraded"; on the frame-push route it would first be classified as heavy by K2's
  // frame catch-up upper bound and never reach the light pipeline
  frameMode: "direct",
  defaults: { burnMs: 0, label: "slow" },
  controls: [
    { key: "burnMs", type: "number", label: "Burn per frame (ms)" },
    { key: "label", type: "text", label: "Text" },
  ],
  Component: ProbeSlowCard,
};

/**
 * The frame-push version of the same card (C10 local acceptance check,
 * `scripts/probes/c10-browser-probe.mjs`): a `direct` card produces no snapshots in the prerender
 * pipeline, so render nodes cannot prerender it; the online dual stage needs to verify "a heavy
 * layer attaches to the original-size snapshot prerendered by a node", which requires a card that
 * is stably classified as heavy on any machine and also has its snapshots produced by render nodes.
 * It is drawn the same way as `probe-slow` (it draws only its own block, `independent` in the review
 * table).
 *
 * **It burns time only on the stage, once per new moment** (no burning on the export page / in the
 * prerender room; no burning on re-renders while suppressed or with t frozen): the cost exists for
 * "the live render on the stage cannot keep up"; advancing one frame in the prerender room renders
 * several times, and a frame-push card must also be pushed from the in point to the target frame, so
 * burning there would drag the prerender out to the protocol timeout. The picture has nothing to do
 * with whether it burns.
 */
function ProbeSlowSteppedCard(props: CardProps<{ burnMs: number; label: string; padNodes?: number }>) {
  // Burn only once per new moment: a re-render while suppressed (t frozen) does not count as this card
  // being live-rendered
  const last = useRef<number | null>(null);
  const fresh = last.current !== (props.t ?? 0);
  last.current = props.t ?? 0;
  const burnMs = isExportMode() || !fresh ? 0 : props.params.burnMs;
  return <ProbeSlowCard {...props} params={{ ...props.params, burnMs }} />;
}

export const probeSlowSteppedCard: CardDef<{ burnMs: number; label: string; padNodes?: number }> = {
  ...probeSlowCard,
  id: "probe-slow-stepped",
  name: "Probe card · tunable cost (frame-push)",
  description: "Frame-push version of probe-slow: each render in the stage burns burnMs milliseconds (not burned in the prerender pass); the render node can produce snapshots for it",
  frameMode: "stateful",
  Component: ProbeSlowSteppedCard,
};

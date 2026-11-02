import { useEffect, useRef } from "react";
import type { CardDef, CardProps } from "../../kernel/types";

/**
 * Four fixed cards for the R6 (data plane) end-to-end probe. **Used only by
 * `scripts/probes/ready-index-probe.mjs`**, and not shown in the card panel's recommendations: like
 * `probe.tsx`, they live in `_probe/`.
 *
 * Each of the four cards pins down one criterion of R6:
 *
 *   `r6-stateful` a stateful DOM card, review table `independent` → **shared tier** (`kind: 'html'`);
 *   `r6-canvas`   a canvas card (review table `surface: canvas2d`) → shared tier, but its size limit
 *                 takes the 1 MB tier;
 *   `r6-unknown`  **not in the review table** → `compositing: 'unknown'` → handled as a below-dependent
 *                 card, with only a **local tier** (`kind: 'local'`), not uploaded to the cloud and not
 *                 put into streams (plan 3.1(2));
 *   `r6-huge`     deliberately makes a single-frame snapshot exceed 300 KB: it is written to disk as
 *                 usual, but **does not enter the ready index** (A3c).
 */

/**
 * How many nodes `r6-huge` is padded out to. Each node carries a unique piece of inline style, so
 * the differences cannot be squeezed out by inlining
 */
const HUGE_NODES = 1400;

function StatefulCard({ playToken }: CardProps<Record<string, never>>) {
  return (
    <div className="absolute inset-0 grid place-items-center text-white" key={playToken}>
      <style>{`@keyframes r6Slide { from { transform: translateX(-300px) } to { transform: translateX(300px) } }`}</style>
      <div
        className="rounded-xl bg-emerald-600 px-10 py-6 text-4xl font-bold"
        style={{ animation: "r6Slide 2s linear infinite" }}
      >
        R6 推帧卡
      </div>
    </div>
  );
}

function CanvasCard({ t = 0, playToken }: CardProps<Record<string, never>>) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Draw a ring of dots by t: the picture changes with the frame, and in the snapshot it is a data:image
    for (let i = 0; i < 48; i++) {
      const angle = (i / 48) * Math.PI * 2 + t;
      ctx.fillStyle = `hsl(${(i * 7 + t * 60) % 360} 80% 60%)`;
      ctx.beginPath();
      ctx.arc(160 + Math.cos(angle) * 120, 160 + Math.sin(angle) * 120, 10, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [t]);
  return (
    <div className="absolute inset-0 grid place-items-center" key={playToken}>
      <canvas ref={ref} width={320} height={320} />
    </div>
  );
}

function UnknownCard({ t = 0, playToken }: CardProps<Record<string, never>>) {
  return (
    <div className="absolute inset-0 grid place-items-center text-white" key={playToken}>
      <div className="rounded-xl bg-fuchsia-700 px-10 py-6 text-4xl font-bold" style={{ opacity: 0.4 + 0.6 * (t % 1) }}>
        R6 拿不准的卡
      </div>
    </div>
  );
}

function HugeCard({ t = 0, playToken }: CardProps<Record<string, never>>) {
  const frame = Math.round(t * 1000);
  return (
    <div className="absolute inset-0 overflow-hidden" key={playToken}>
      {Array.from({ length: HUGE_NODES }, (_, i) => (
        <span
          key={i}
          style={{
            position: "absolute",
            left: (i * 37) % 1900,
            top: (i * 53) % 1060,
            width: 9 + (i % 7),
            height: 9 + (i % 5),
            borderRadius: 2 + (i % 4),
            letterSpacing: `${i % 3}px`,
            background: `rgb(${(i * 3 + frame) % 256}, ${(i * 5) % 256}, ${(i * 7) % 256})`,
          }}
        >
          {i % 10}
        </span>
      ))}
    </div>
  );
}

export const r6StatefulCard: CardDef<Record<string, never>> = {
  id: "r6-stateful", name: "R6 frame-push card", description: "R6 probe: stateful DOM card, uses the shared tier",
  source: "native", frameMode: "stateful", defaults: {}, controls: [], Component: StatefulCard,
};

export const r6CanvasCard: CardDef<Record<string, never>> = {
  id: "r6-canvas", name: "R6 canvas card", description: "R6 probe: canvas card, size limit uses the 1 MB tier",
  source: "native", frameMode: "stateful", defaults: {}, controls: [], Component: CanvasCard,
};

export const r6UnknownCard: CardDef<Record<string, never>> = {
  // **Deliberately not in the review table**: this is what a custom card in a real project looks like
  id: "r6-unknown", name: "R6 unreviewed card", description: "R6 probe: not covered by the review table, handled as a lower-level dependency card, local tier only",
  source: "native", frameMode: "stateful", defaults: {}, controls: [], Component: UnknownCard,
};

export const r6HugeCard: CardDef<Record<string, never>> = {
  id: "r6-huge", name: "R6 oversize card", description: "R6 probe: single-frame snapshot exceeds 300 KB, written to disk but not added to the ready index",
  source: "native", frameMode: "stateful", defaults: {}, controls: [], Component: HugeCard,
};

export const r6ProbeCards = [r6StatefulCard, r6CanvasCard, r6UnknownCard, r6HugeCard];

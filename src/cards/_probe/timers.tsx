import { useEffect, useState } from "react";
import type { CardDef, CardProps } from "../../kernel/types";

/**
 * The two acceptance cards for E4b: **`setInterval` and `Date.now()` must follow virtual time on the
 * stage.**
 *
 * They are not meant for users (so they live in `_probe/`, together with `probe.tsx`), and are
 * mounted into a temporary project only by `scripts/probes/stage-content-probe.mjs` to verify two
 * things:
 *
 *   - Typewriter card: advances one step every 100 ms, and when the background stage catches up to
 *     second 3 there are **exactly 30 steps**;
 *   - Countdown card: after `advanceToAsync` advances 10 seconds, the remaining time is **exactly
 *     10 seconds less**.
 *
 * Both rely on the fake timers of `render/stageClock.ts` and the `Date.now` pinned by
 * `kernel/pinEntropy.ts`. If the stage did not take over these two: the typewriter would not advance
 * a single step under virtual time (it takes the wall clock a full 3 seconds to reach 30, while the
 * catch-up run is pushed synchronously and finishes in tens of milliseconds), and the countdown
 * would run wild by the wall clock, with different readings from the two probe runs.
 */

/**
 * 100 milliseconds per step. Consistent with the number written in the E4b acceptance check; if it
 * is changed, the acceptance check will no longer match
 */
const CELL_MS = 100;

function ProbeTypewriter({ playToken }: CardProps<Record<string, never>>) {
  const [cells, setCells] = useState(0);
  useEffect(() => {
    // On remount (when playToken / remountGen changes) count from the start: a catch-up run always
    // advances from the mount frame
    setCells(0);
    const id = setInterval(() => setCells((n) => n + 1), CELL_MS);
    return () => clearInterval(id);
  }, [playToken]);
  return (
    <div
      data-pc-probe="typewriter"
      data-pc-probe-cells={cells}
      style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#fff", font: "600 40px/1.2 ui-monospace, monospace" }}
    >
      {"█".repeat(cells)}
    </div>
  );
}

function ProbeCountdown({ t, playToken }: CardProps<Record<string, never>>) {
  const [deadline, setDeadline] = useState<number | null>(null);
  useEffect(() => {
    // Read the clock once at the moment of mounting, then compute "how much time is left" every frame;
    // what is read is the pinned Date.now (virtual time)
    setDeadline(Date.now() + 60_000);
  }, [playToken]);
  // `t` is only the trigger for "re-render once per frame": the real reading comes from Date.now()
  void t;
  const remaining = deadline === null ? 60_000 : deadline - Date.now();
  return (
    <div
      data-pc-probe="countdown"
      data-pc-probe-remaining={remaining}
      style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#fff", font: "600 40px/1.2 ui-monospace, monospace" }}
    >
      {(remaining / 1000).toFixed(2)}s
    </div>
  );
}

export const probeTimerCards: CardDef<Record<string, never>>[] = [
  {
    id: "probe-typewriter",
    name: "Probe card: typewriter (setInterval)",
    description: "For E4b acceptance check: advance one step every 100 ms",
    source: "native",
    frameMode: "stateful",
    defaults: {},
    controls: [],
    Component: ProbeTypewriter,
  },
  {
    id: "probe-countdown",
    name: "Probe card: countdown (Date.now)",
    description: "For E4b acceptance check: count down by Date.now()",
    source: "native",
    frameMode: "stateful",
    defaults: {},
    controls: [],
    Component: ProbeCountdown,
  },
];

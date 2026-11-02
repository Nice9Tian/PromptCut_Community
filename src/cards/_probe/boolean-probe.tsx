import { useAnimationFrame } from "motion/react";
import { useRef } from "react";
import type { CardDef, CardProps } from "../../kernel/types";

/**
 * The **test-case cards** for the K1 two-pass boolean probe (`vtOk` / `seekOk`).
 *
 * The acceptance check needs three test cases: a card with only CSS / WAAPI animation with
 * `vtOk: true` and `seekOk: true`, a particle card with `vtOk: true`, and a JS-driven card with
 * `vtOk: false`.
 * The card library has particle cards (`particles-snow` and the like), but has no **clean** ones for
 * the other two: the `probe` card mixes CSS animation, a Motion element and a bare rAF counter on one
 * card, so the boolean it yields is the intersection of all three and proves nothing about any
 * single criterion. So one minimal card of each kind is placed here.
 *
 * Neither card goes into the review table (`capabilities.json`), so axis three is `unknown` and is
 * handled as `belowDependent`, and the probe frames will not be stored as prerender assets (the last
 * sentence of K1). They are loaded by name only in the probe's acceptance check; the left rail and
 * the Agent see them as usual, but nobody will put them into a final video.
 */

/**
 * **CSS @keyframes only**: a linear translation of one `transform`, with no JS involved.
 *
 * Expected for this test case: `vtOk: true` (`pinner.syncIn` pins this animation's `currentTime` to
 * frame 8, and the picture is exactly what frame 8 should look like, identical to advancing the
 * global clock by 8 frames), and `seekOk: true` (pinning to frame 8 in one step gives the same
 * result as advancing frame by frame to frame 8: an animation on the document timeline can be
 * positioned directly to begin with).
 */
function ProbeCssCard({ playToken }: CardProps<Record<string, never>>) {
  return (
    <div style={{ position: "absolute", inset: 0 }} key={playToken}>
      <style>{"@keyframes pcProbeCssSlide { from { transform: translateX(0px) } to { transform: translateX(960px) } }"}</style>
      <div
        data-pc-probe="css"
        style={{
          position: "absolute", left: 120, top: 420, width: 240, height: 240, borderRadius: 32,
          background: "#2dd4bf", animation: "pcProbeCssSlide 3s linear infinite",
        }}
      />
    </div>
  );
}

/**
 * **JS-driven**: Motion's frame loop (`useAnimationFrame`) reads the global timestamp every frame and
 * writes `transform` itself.
 *
 * Expected for this test case: `vtOk: false`. The subtree virtual-time pass **does not move the global
 * clock**, so nobody drains the rAF queue taken over by `stageClock`, and this callback never runs:
 * the picture stays on the mount frame, unlike frame 8 produced by the global clock.
 * This is exactly the kind that K3(b) / K5 hand to the background stage for a whole-scene catch-up run
 * (pinned partition axis one, item 3).
 */
function ProbeMotionJsCard({ playToken }: CardProps<Record<string, never>>) {
  const boxRef = useRef<HTMLDivElement>(null);
  const startRef = useRef(-1);
  useAnimationFrame((ms) => {
    if (startRef.current < 0) startRef.current = ms;
    const elapsed = ms - startRef.current;
    // Written into inline styles: inlineDOMStyles reads it as is when generating snapshots, so the two
    // passes can show a difference
    if (boxRef.current) boxRef.current.style.transform = `translateX(${(elapsed / 5).toFixed(3)}px)`;
  });
  return (
    <div style={{ position: "absolute", inset: 0 }} key={playToken}>
      <div
        ref={boxRef}
        data-pc-probe="motion-js"
        style={{
          position: "absolute", left: 120, top: 420, width: 240, height: 240, borderRadius: 32,
          background: "#a78bfa", transform: "translateX(0px)",
        }}
      />
    </div>
  );
}

export const probeCssCard: CardDef<Record<string, never>> = {
  id: "probe-css",
  name: "Probe card · pure CSS",
  description: "Reference case for the K1 boolean probe: CSS @keyframes only, both vtOk and seekOk should be true",
  source: "native",
  // Frame mode: it has animation history and takes the frame-push route as stateful (the boolean
  // probe runs only on stepped cards)
  frameMode: "stateful",
  defaults: {},
  controls: [],
  Component: ProbeCssCard,
};

export const probeMotionJsCard: CardDef<Record<string, never>> = {
  id: "probe-motion-js",
  name: "Probe card · JS-driven",
  description: "Reference case for the K1 boolean probe: Motion's frame loop writes transform itself every frame, vtOk should be false",
  source: "native",
  frameMode: "stateful",
  defaults: {},
  controls: [],
  Component: ProbeMotionJsCard,
};

/**
 * Overreach probe media effect card (fixture): runs probe when `card()` is evaluated (has extra
 * group: "read assets into GPU via cookies"), `audio()` runs Worker group in sound thread. Probe
 * code itself is in `probe-boundary-attempts.ts`. Used via real loading path, same as
 * `probe-boundary-card.tsx`; results in `globalThis.__pcBoundary["graph-card"]`.
 */
import { glsl } from "../../render/cards/graphValues";
import { runAll, workerAttempts } from "./probe-boundary-attempts";

(globalThis as any).__pcBoundaryLoaded = { ...((globalThis as any).__pcBoundaryLoaded ?? {}), "graph-card": true };

let audioStarted = false;

export const probeBoundaryGraph = {
  id: "probe-boundary-graph",
  name: "Overreach probe media effect card",
  description: "Used by the security acceptance probe: the same set of probes in media effect card form, plus reading assets with a cookie",
  tags: ["probe"],
  kind: "animation",
  frameMode: "direct",
  defaults: { ctx: null },
  controls: [],
  card: (_sources: unknown, _t: number, params: any) => {
    const G = globalThis as any;
    const base = params?.ctx;
    if (base?.collector && !G.__pcBoundaryStarted?.["graph-card"] && (base.anyRole || G.__pcStageDiag?.().role === "front")) {
      G.__pcBoundaryStarted = { ...(G.__pcBoundaryStarted ?? {}), "graph-card": true };
      void runAll({ ...base, tag: "graph-card", graph: true }).then((r: unknown) => { G.__pcBoundary = { ...(G.__pcBoundary ?? {}), "graph-card": r }; });
    }
    return glsl(`void main() { outColor = vec4(0.5, 0.0, 0.0, 1.0); }`, [], {});
  },
  audio: (_sources: unknown, range: { start: number; count: number }, params: any) => {
    const base = params?.ctx;
    if (base?.collector && !audioStarted) {
      audioStarted = true;
      void workerAttempts({ ...base, tag: "graph-card-audio" }).then((r: unknown) => { (self as any).postMessage({ __pcBoundary: "graph-card-audio", r }); });
    }
    return new Float32Array(range.count);
  },
};

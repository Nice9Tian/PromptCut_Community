/**
 * 越权探测素材效果卡(夹具):`card()` 求值时把探测跑一遍(多一组「凭 cookie 读素材、进 GPU」),`audio()` 在声音线程里跑 Worker 那一组。
 * 探测代码本体在 `probe-boundary-attempts.ts`。经真实加载路径用,办法同 `probe-boundary-card.tsx`;结果在 `globalThis.__pcBoundary["graph-card"]`。
 */
import { glsl } from "../../render/cards/graphValues";
import { runAll, workerAttempts } from "./probe-boundary-attempts";

(globalThis as any).__pcBoundaryLoaded = { ...((globalThis as any).__pcBoundaryLoaded ?? {}), "graph-card": true };

let audioStarted = false;

export const probeBoundaryGraph = {
  id: "probe-boundary-graph",
  name: "探针越权探测素材效果卡",
  description: "安全验收探针用:素材效果卡形态的同一组探测,外加凭 cookie 读素材",
  tags: ["探针"],
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

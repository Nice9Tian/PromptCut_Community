import { useLayoutEffect, useRef } from "react";
import type { CanvasContract } from "./CanvasCardProgram";
import { glPlanes } from "./planes";

/**
 * gl plane for canvas cards (R9 M1): the fifth sibling plane `[data-pc-gl-plane]` of E7.
 *
 * - Size = clip entity box, context is `bitmaprenderer` (retrieved by `glHost` when receiving
 *   `done`);
 * - **Do not add `data-pc-clip`**: `isSolid` in `solid.ts` skips elements with it as wrapper layers; if
 *   added, this whole class of canvas cards cannot be clicked;
 * - It is part of live render, and does **not** enter the allowlist of the four plane selectors:
 *   when hiding subtrees, it is hidden together with the subtree.
 *
 * Visuals are not drawn here: each commit only registers "what to draw for this tick" into
 * `glPlanes`, sent by the host to the Worker via `glHost.beat()`.
 */
export function GlPlane(props: {
  clipId: string;
  cardId: string;
  contract: CanvasContract;
  w: number;
  h: number;
  t: number;
  frame: number;
  params: Record<string, unknown>;
  gen: number;
  skip: boolean;
  stage: { width: number; height: number; camera3dFov?: number };
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const w = Math.max(1, Math.round(props.w));
  const h = Math.max(1, Math.round(props.h));
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const { contract, params } = props;
    const textures: Array<{ name: string; url: string }> = [];
    for (const spec of contract.textures ?? []) {
      const raw = spec.param ? params[spec.param] : spec.url;
      if (typeof raw !== "string" || !raw.trim()) continue;
      // The base URL of the Worker is its own script URL: resolve to an absolute URL here first
      textures.push({ name: spec.name, url: new URL(raw.trim(), document.baseURI).href });
    }
    glPlanes.set(props.clipId, {
      clipId: props.clipId,
      canvas,
      kind: contract.kind as "gl" | "three" | "2d",
      programId: contract.programId ?? props.cardId,
      w, h,
      t: props.t,
      frame: props.frame,
      params,
      paramsKey: JSON.stringify(params),
      gen: props.gen,
      skip: props.skip,
      textures,
      stage: props.stage,
    });
    return () => {
      if (glPlanes.get(props.clipId)?.canvas === canvas) glPlanes.delete(props.clipId);
    };
  });
  return (
    <canvas
      ref={ref}
      data-pc-gl-plane={props.clipId}
      width={w}
      height={h}
      style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%" }}
    />
  );
}

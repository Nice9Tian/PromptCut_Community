import { createContext, useContext } from "react";
import type { CutSegmentRender } from "../kernel/cutSegments";
import { projectCardGraph } from "../kernel/cardGraph.mjs";
import { withMediaRates } from "../kernel/clipTime.mjs";
import type { Timeline } from "../kernel/types";
import { FrameScene } from "./FrameScene";
import type { StagePlaneProps } from "./Stage";

/**
 * Cut segment visuals (`kernel/cutSegments.ts` file header, `mechanism/rendering.md` "Cut segment").
 *
 * The stage treats cut segments as a card: the wrapper layer positions the box, calculates opacity
 * and fade in/out, and sets layer order according to card rules; inside the wrapper layer is right
 * here: a nested `FrameScene` that renders the referenced cut's entire frame by `offset + local time`.
 * The referenced cut's visuals are first composited in its own aspect ratio (project width and
 * height), then scaled as a whole into the segment box, clipping overflow (wrapper layer
 * `overflow: hidden`).
 *
 * Which asset variant the host (outer `FrameScene`) uses, whether playing or scrubbing, and which
 * hashes the asset service reported are passed in via `SceneHostContext`: the nested scene renders
 * with the same variant: in the stage it is the actually playing media layer, while on the export
 * page it uses placeholders installed only at the screenshot step (`__pcPrepareFrameMedia` locates
 * them by `data-pc-media-*`, and nested ones are also in the same document), so preview, export, and
 * prerender produce the same frame. When there is no host (export page with a flattened timeline),
 * it follows the export page's placeholder variant.
 *
 * The wrapper layer in a nested scene does not attach `data-pc-clip` (attaches
 * `data-pc-nested-clip`): places operating on "stage top-level clips", such as hit testing,
 * pinning animations, measuring entity boxes, and prerender splitting layers by track prefix,
 * see only the cut segment's own layer.
 *
 * Cards in a cut segment are split into light and heavy just like cards on the parent timeline
 * (user decision, 2026-10-21; `kernel/cutFlatten.mjs` flattened view): the stage passes in the six
 * plane props as-is (`planes`), and the nested stage looks up by "`flatPrefix` + clip id" (virtual
 * clip id on the plan side): cards classified as heavy hide live subtrees and paste their own
 * streams, displaying placeholders when there is no stream; light cards live render as usual.
 * The export and prerender pages do not pass planes, leaving the DOM completely unchanged.
 */
export interface SceneHost {
  live: boolean;
  /** Timestamp tracked by the media layer (time in the host scene) */
  mediaT: number;
  playing: boolean;
  scrubbing: boolean;
  localHashes?: readonly string[];
}

export const SceneHostContext = createContext<SceneHost | null>(null);

const graphMemo = new WeakMap<object, Timeline["graph"] | null>();
function subGraph(project: CutSegmentRender["project"]): Timeline["graph"] | undefined {
  if (graphMemo.has(project)) return graphMemo.get(project) ?? undefined;
  let graph: Timeline["graph"] | null = null;
  try {
    // Add the rate to media nodes of speed-change segments (withMediaRates in kernel/clipTime.mjs;
    // unchanged when there are no speed-change segments)
    graph = project.cardNodes?.length ? withMediaRates(project, projectCardGraph(project)) : null;
  } catch {
    // When it cannot be calculated (dangling input, etc.), fall back to "do not draw image cards" like the top level
    graph = null;
  }
  graphMemo.set(project, graph);
  return graph ?? undefined;
}

export function CutSegmentScene({ seg, start, localT, localDirectT = localT, playToken, size, flatPrefix, planes }: {
  seg: CutSegmentRender;
  /** Start point of this segment on the parent cut (seconds) */
  start: number;
  /** Local time within the segment (seconds): the `t` passed from the stage to the card */
  localT: number;
  localDirectT?: number;
  playToken: number;
  /** Segment box (pixels) */
  size: { width: number; height: number };
  /** Plan-side id prefix for clips in this segment (`<segment id>~`, `kernel/cutFlatten.mjs`) */
  flatPrefix?: string;
  /** The stage's six plane props (dispatched by virtual clip id); omitted on export and prerender pages */
  planes?: StagePlaneProps;
}) {
  const host = useContext(SceneHostContext);
  const { project, offset, duration } = seg;
  const tau = offset + localT;
  const tauDirect = offset + localDirectT;
  // Referenced cut shortened afterward: portions exceeding its total duration are transparent and
  // silent (Argon review comment conflict 3)
  if (!(tau >= 0 && tau < duration) && !(tauDirect >= 0 && tauDirect < duration)) return null;
  const W = Math.max(1, project.width), H = Math.max(1, project.height);
  const sx = size.width / W, sy = size.height / H;
  const live = !!host?.live;
  const mediaT = host ? offset + (host.mediaT - start) : tau;
  return (
    <div data-pc-cut-scene={seg.cutId} style={{
      position: "absolute", left: 0, top: 0, width: W, height: H, overflow: "hidden",
      ...(sx !== 1 || sy !== 1 ? { transform: `scale(${sx}, ${sy})`, transformOrigin: "0 0" } : null),
    }}>
      <FrameScene nested project={project} t={tau} directT={tauDirect} playToken={playToken} graph={subGraph(project)}
        mediaMode={live ? "live" : "placeholder"} mediaT={mediaT}
        playing={live && !!host?.playing} scrubbing={live && !!host?.scrubbing} localHashes={host?.localHashes}
        flatPrefix={flatPrefix} {...planes} />
    </div>
  );
}

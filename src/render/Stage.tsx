import { AnimClock } from "../kernel/AnimClock";
import { memo, useEffect, useMemo, useRef, type ReactNode } from "react";
import { frameCss } from "../kernel/layout";
import { perspectivePx } from "../kernel/space3d";
import { motionAt } from "../kernel/motion";
import { cardOpacityAt, hasOpacityControls } from "../kernel/project";
import { forgetUnmounted, mountClockMsAt } from "./mountClock";
import { emphasisFilter } from "../kernel/emphasis";
import { getCard, isRuntimeCard } from "../kernel/registry";
import { PartTree } from "./PartTree";
import { GraphCard } from "./cards/GraphCard";
import { RuntimeCardBoundary } from "./cards/RuntimeCardBoundary";
import { frameBox } from "../kernel/layout";
import type { CardDef, CardProps, Timeline } from "../kernel/types";
import { cardMountedAt } from "./frameWindow.mjs";
import { clipFrameMode } from "../kernel/frameMode.mjs";
import { guardCompositing, shouldGuard } from "./capabilityGuard";
import { ensurePlaneStyle } from "./planeStyle";
import { GlPlane } from "./gl/GlPlane";
/*
 * Placeholder component (end of product/rendering.md "Fallback order"; see
 * `placeholder/contract.ts` for interface).
 */
import { PlaceholderPlane, PLACEHOLDER_CSS, maxAnimated } from "./placeholder";
import { ensurePlaceholderStyle, exportSyncedMountFor, geometryFor, isCatchingUpClip, onlineBrowserMode, PLACEHOLDER_SLOT_ATTR, placeholderFitFor, placeholdersEnabled, setMaxAnimated, unsupportedHere } from "./placeholderHost";
import { resolveCardParams } from "./mediaTier";
import type { PlaceholderReason } from "./placeholder/contract";
import { CutSegmentScene } from "./CutSegmentScene";
import { cutOf, envelopeAt } from "../kernel/cutSegments";
import { FLAT_SEP } from "../kernel/cutFlatten.mjs";
import { resolveClipFrameAt } from "../kernel/frameExpr.mjs";
import { camera2DCssTransform, resolveCamera2DAt } from "../kernel/camera.mjs";
import { isCaptionClip } from "../kernel/captions";

setMaxAnimated(maxAnimated);

// Keep direct-evaluation cards at the requested time while other cards replay.
// Their CSS/DOM stays in the same stacking tree (including paper/glass styles),
// but their component is not run for each stateful history frame.
const DirectCard = memo(function DirectCard({ def, params, ...props }: CardProps<any> & { def: CardDef<any> }) {
  // Media effect cards have no Component, but appear **ahead** of this branch in the branch order
  // below, so reaching here guarantees a component exists.
  // This **must not** be changed to `if (!C) return null`: if the branch order were ever wrong, it
  // would silently produce a blank card.
  const C = def.Component!;
  return <C {...props} params={resolveCardParams({ ...def.defaults, ...params })} />;
});

/**
 * Solid mode: replaces each card with a color block during browsing. Provides a query function for
 * "how this card should be drawn", and Stage is only responsible for positioning: where colors come
 * from and when sampling occurs is handled by render/solidMode.ts.
 *
 * Omitted = real render, DOM is **verbatim identical** to before (export follows this exact path).
 */
export type ProxyRender = (clipId: string) => { color: string; box: { left: number; top: number; width: number; height: number } | null };

/**
 * A stream group in G1: length 1 = single-card stream (or below-dependent stream, depending on
 * `plane`), > 1 = group stream (in painter's order, the last being the topmost card in the group).
 * `key` / `ranges` are needed by `streamPlayer` (stream key and ready segment numbers at that layer
 * in the ready index); `Stage` only looks at `clipIds` and `plane`.
 */
export interface StreamPlaneGroup {
  clipIds: string[];
  /**
   * `"stage"`: a stream produced for only one card but in stage coordinates (below-dependent stream,
   * `docs/plan/prerender-products-contract.md` section 5.4). Canvas is mounted under the stage root
   * rather than in a wrapper layer (the same kind of plane as group streams), with layer order taken
   * from that card's layer.
   */
  plane?: "stage";
  key?: string;
  ranges?: Array<[number, number]>;
  /**
   * The first frame of this stream itself (project frame number); `streamPlayer` uses it to convert
   * frame numbers to segment numbers, while `Stage` ignores it.
   */
  originFrame?: number;
  /**
   * Which card's layer the group stream plane mounts at (the **topmost currently active card** in
   * the group). Computed and populated by `StageView` for the current time: the live path has one
   * single-clip `Stage` per clip, and an individual `Stage` does not know whether other clips are
   * currently present. If omitted, defaults to the topmost card in the group.
   */
  host?: string;
}

/**
 * The six optional props for Stage (E7). **Passing none = behavior is verbatim identical to today**
 * (the export page and legacy follow this path). The mechanism uniformly follows solid mode from
 * `solidMode.ts`: components remain mounted forever, wrapper layers add a class, stylesheets hide
 * subtrees, and what needs to be displayed is a sibling plane inside the wrapper layer: without
 * changing keys or swapping child node types.
 */
export interface StagePlaneProps {
  /**
   * HTML snapshots for C3 / C4, keyed by clipId. Mounting = wrapper layer adds `.pc-snapshot` +
   * a sibling snapshot plane.
   */
  snapshots?: ReadonlyMap<string, string>;
  /**
   * Heavy cards during playback (E7 item 5): hides subtrees, and freezes `t` passed to the component
   * at the moment suppression begins.
   */
  suppressed?: ReadonlySet<string>;
  /**
   * Stream plane groups for G1 (always empty before R8, render positions and props in place first).
   */
  streamPlanes?: readonly StreamPlaneGroup[];
  /**
   * K3: per-clip remount generation. The key and `playToken` passed to the component use "whole-stage
   * playToken + this", **and default to whole-stage playToken when omitted**.
   */
  remountGen?: ReadonlyMap<string, number>;
  /**
   * K5 path 1: clips currently catching up frames using subtree virtual time → their current **global
   * stage milliseconds**.
   */
  settling?: ReadonlyMap<string, number>;
  /** E0 `setTime({ awaiting })`: snapshot for this frame has not arrived yet, keep hidden and wait */
  awaiting?: ReadonlySet<string>;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Cards loaded at runtime (synced user cards and media effect cards executed in an online browser)
 * are wrapped in an error boundary: errors thrown during rendering tear down only this card without
 * crashing the stage. Cards present at build time are returned as-is: React trees for desktop,
 * export, and prerender remain verbatim identical to before.
 */
function guardRuntimeCard(cardId: string | undefined, body: ReactNode): ReactNode {
  return cardId && isRuntimeCard(cardId) ? <RuntimeCardBoundary cardId={cardId}>{body}</RuntimeCardBoundary> : body;
}

/**
 * Stage: picks out active clips at the current time and mounts them. Cards use
 * `clip.id + playToken` as key; entering the interval remounts them to play from the beginning
 * (consistent with behavior during export).
 */
export function Stage({ timeline, t, directT = t, playToken, speed = 1, proxy, snapshots, suppressed, streamPlanes, remountGen, settling, awaiting, mountClock = false, nested = false, flatPrefix, overflowVisible = false }: {
  timeline: Timeline; t: number; directT?: number; playToken: number; speed?: number; proxy?: ProxyRender;
  /**
   * Nested stage inside a cut segment (`CutSegmentScene`): wrapper layers attach
   * `data-pc-nested-clip` instead of `data-pc-clip`, so operations working on top-level stage clips
   * like hit testing, pinned animations, and measuring boxes only see the cut segment layer.
   * Top level is always false, keeping the DOM verbatim unchanged.
   */
  nested?: boolean;
  /**
   * Nested stage inside a cut segment (`CutSegmentScene`): the plan-side id prefix for clips at this
   * layer (`<segment id>~`, chained across multiple layers; `kernel/cutFlatten.mjs`). All six plane
   * props are looked up by "prefix + clip id" (dispatched by parent pages based on virtual clips in
   * the flattened view), and wrapper layers also attach `data-pc-flat-clip` (used by stream planes
   * and placeholder slots to find them). Omitted at the top level, always looked up by clip id,
   * keeping the DOM verbatim unchanged.
   */
  flatPrefix?: string;
  /**
   * Passes the mount clock (`CardProps.mountClockMs`) to cards that "time against mount moment".
   * **Passed as true only on export pages with flattened timelines**: on that path cards mount
   * `CARD_MOUNT_LEAD` in advance, and legacy typing cards time from the mounted frame; export pixel
   * baselines (demo project) were rendered that way. Omitted for preview and Project exports: how
   * much the former leads depends on which tick falls into the lead window, while the latter mounts
   * only at the start point, both following `t`.
   */
  mountClock?: boolean;
  overflowVisible?: boolean;
} & StagePlaneProps) {
  const timeOf = (c: Timeline['clips'][number]) => clipFrameMode(c, getCard(c.cardId)) === 'direct' ? directT : t;
  /**
   * Which id to look up plane props by: at the top level it is the clip id; in nested scenes it is
   * the plan-side virtual clip id (`flatPrefix`).
   */
  const pidOf = (c: { id: string }) => (flatPrefix ? flatPrefix + c.id : c.id);
  const active = timeline.clips.filter((c) => cardMountedAt(c, timeOf(c)));

  /*
   * Stylesheet for the four kinds of planes (E7). Injected only for hosts that actually use these
   * props: export pages and legacy pass none of these props, so this sheet will not appear in their
   * documents.
   */
  const usesPlanes = !!(snapshots || suppressed || streamPlanes || settling || awaiting);
  useEffect(() => {
    if (usesPlanes) ensurePlaneStyle();
  }, [usesPlanes]);
  /*
   * Placeholder plane (end of fallback order): mounted only for human-viewed previews (stage page,
   * `front` role): the `placeholderHost` toggle is enabled only by `StageView`; export pages,
   * prerender, Agent query renders, and background stages render zero nodes and inject no stylesheet.
   */
  const placeholders = usesPlanes && placeholdersEnabled();
  useEffect(() => {
    if (placeholders) ensurePlaceholderStyle(PLACEHOLDER_CSS);
  }, [placeholders]);

  /*
   * For suppressed cards, the `t` passed to the component must be **frozen at the moment suppression
   * begins** (E7 item 5). "The moment suppression begins" uses a ref to store the suppressed set from
   * the previous render and compares during the current render: from absent to present → record
   * current `cardT − clip.start`; from present to absent → delete entry.
   *
   * Freezes only **the branch passed to the component**. Other uses of `cardT` (active criteria,
   * trajectory, opacity, `data-pc-local-frame`) continue using real-time values as usual: otherwise
   * suppressed cards would never leave the stage, the wrapper layer trajectory would stop, and stream
   * `<canvas>` would become misaligned.
   *
   * Stored in a Map rather than a single value: on the live path each clip has a single-clip Stage
   * with only one entry in the Map, but the same code also serves multi-clip Stages
   * for export / legacy.
   */
  /*
   * Mount clock (tracked in `mountClock.ts`): stage time at first render for each card's
   * current mount (`clip id:generation`, matching the wrapper layer key). Recorded only
   * when `mountClock` is enabled; retrieved by key in the render body, and cards not mounted
   * in this render are cleared after commit.
   */
  const mountedAt = useRef(new Map<string, number>());
  const mountKeys = new Set<string>();
  const mountClockMsOf = (key: string, clip: Timeline["clips"][number], now: number): number | undefined => {
    if (!mountClock) return undefined;
    mountKeys.add(key);
    return mountClockMsAt(mountedAt.current, key, clip.start, now);
  };
  useEffect(() => {
    if (mountClock) forgetUnmounted(mountedAt.current, mountKeys);
  });
  const frozenT = useRef(new Map<string, number>());
  const prevSuppressed = useRef<ReadonlySet<string>>(EMPTY_SET);
  const supNow = suppressed ?? EMPTY_SET;
  for (const c of active) {
    const pid = pidOf(c);
    if (supNow.has(pid) && !prevSuppressed.current.has(pid)) frozenT.current.set(pid, Math.max(0, timeOf(c) - c.start));
  }
  for (const id of [...frozenT.current.keys()]) if (!supNow.has(id)) frozenT.current.delete(id);
  prevSuppressed.current = supNow;

  /**
   * Local time passed to the component. Three tiers, in priority order:
   *   1. Catching up frames (`settling`): reads its own virtual time (value is global stage
   *      milliseconds, computed locally on the fly here);
   *   2. Suppressed: frozen at the moment suppression begins;
   *   3. Normal: real-time value.
   * All four branches (composite card / media effect card / DirectCard / regular card) align on this
   * and go through here.
   */
  const localTOf = (clip: Timeline["clips"][number], base: number): number => {
    const ms = settling?.get(pidOf(clip));
    if (ms !== undefined) return Math.max(0, ms / 1000 - clip.start);
    const frozen = frozenT.current.get(pidOf(clip));
    if (frozen !== undefined) return frozen;
    return Math.max(0, base - clip.start);
  };
  /** Why the placeholder is shown (for diagnostics; visibility itself does not check it, switched by `StageView`) */
  const placeholderReasonOf = (id: string): PlaceholderReason =>
    awaiting?.has(id) ? "awaiting" : settling?.has(id) || isCatchingUpClip(id) ? "catching-up" : "no-data";
  // Cards with their own 3D scenes (scene-3d) must use the same camera as layer A, so pass down
  // the aspect ratio and fov together.
  // Pass the entire object through; other cards ignore it even if received.
  const stageInfo = useMemo(() => ({ width: timeline.width, height: timeline.height, camera3dFov: timeline.camera3dFov }), [timeline.width, timeline.height, timeline.camera3dFov]);
  /*
   * For cards where the review table (src/cards/capabilities.json) says independent, but
   * backdrop-filter is measured on screen, report a warning once after mounting and downgrade
   * to belowDependent (render/capabilityGuard.ts).
   * Each card is measured only once in its lifetime, and only on the interactive stage in development:
   * on the export / prerender path, shouldGuard() returns false directly, so not even a single
   * getComputedStyle executes, leaving the pixel-by-pixel baseline unaffected. The DOM does not change
   * by a single character (only a ref was added).
   */
  const stageRef = useRef<HTMLDivElement>(null);
  const guardKey = active.map((c) => c.cardId).join("|");
  const clipAttr = nested ? "data-pc-nested-clip" : "data-pc-clip";
  useEffect(() => {
    if (!shouldGuard()) return;
    const handle = requestAnimationFrame(() => {
      guardCompositing(stageRef.current, active.map((c) => ({ id: c.id, cardId: c.cardId })));
    });
    return () => cancelAnimationFrame(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guardKey]);
  const hasStandaloneCam2D = Boolean(timeline.cameras?.some((c) => c && c.enabled !== false));
  const standaloneCamStyle = hasStandaloneCam2D
    ? camera2DCssTransform(resolveCamera2DAt(timeline.cameras, directT), { width: timeline.width, height: timeline.height })
    : null;
  const renderClip = (clip: Timeline["clips"][number], i: number) => {
          const def = getCard(clip.cardId);
          /*
           * This device cannot run this card (user cards and media effect cards in online browser mode;
           * this machine does not even have definitions for synced user cards): card code does not run,
           * the wrapper layer mounts snapshot planes and stream planes following built-in heavy cards,
           * and the placeholder displays `unsupported` when nothing can be pasted in the fallback order
           * (section 9 of the C10 contract). When the mode is off (desktop, export, prerender, video seen
           * by Agent), it is always false, and every branch below is verbatim identical to before.
           */
          // Cut segment (kernel/cutSegments.ts): not a card in the registry; mounts the nested scene of the
          // referenced cut in the wrapper layer
          const seg = cutOf(clip);
          const localOnly = !seg && ((onlineBrowserMode() && unsupportedHere(clip.cardId, def)) || exportSyncedMountFor(clip.cardId, def));
          /*
           * All three checks are filtered out at the def lookup step, not placed into branches:
           *  - Definition missing (user card file deleted): def for media effect cards can always be
           *    fetched from the registry, but cannot guard against the two cases below;
           *  - Neither card nor Component: audio media effect cards won't crash even if carrying a cardId;
           *  - Media effect card but no graph (projectCardGraph threw): without a graph, inputs cannot be
           *    resolved and nothing can be drawn.
           * Cards this device cannot run skip these three checks: they mount no components, only pasting
           * prerender output.
           */
          if (!seg && !localOnly && (!def || (!def.card && !def.Component) || (def.card && !timeline.graph))) return null;
          const C = def?.Component!;
          // DOM/graphics of audio-visual cards are selected by the visual outlet;
          // audio() does not alter visual dispatch.
          const embeddedOffset = def?.audio ? (clip.sourceOffset ?? 0) : 0;
          const cardT = timeOf(clip);
          const unsupported = localOnly;

          // Clips bound to a trajectory translate their entire layer with the target. Translation is placed
          // on the **outer layer** instead of delegated to the card:
          // The card does not know it is bound, nor should it: swap in another card, and following still takes effect.
          const m = clip.motion ? motionAt(clip.motion, Math.max(0, cardT - clip.start)) : null;
          if (m && clip.motion!.whenHidden === "hide" && !m.visible) return null;

          // The card's box (position/size/anchor/scale/rotation) is placed on the outer layer like trajectory
          // translation: the card does not know where it was placed.
          // When there is no frame, frameCss outputs the old inset:0, keeping legacy projects byte-for-byte unchanged.
          // Opacity / fade in/out is likewise placed on the outer layer, and opacity is written only when
          // set: cards without it keep the DOM unchanged by a single character.
          // Fade in/out for cut segments is calculated from where it is actually exposed (`seg.from`);
          // the preroll portion is not exposed
          const op = seg
            ? envelopeAt({ start: seg.from, end: clip.end, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut, opacity: clip.opacity }, cardT)
            : hasOpacityControls(clip) ? cardOpacityAt(clip, cardT) : 1;
          const prerolling = !!seg && cardT < seg.from;
          // Emphasis (shadow / stroke) follows alpha edges, so it is attached to this card outer layer slot;
          // if unset, not a single character is written
          const filter = emphasisFilter(clip.emphasis);
          /*
           * K3: Remount granularity is clips. Both key and the **`playToken` passed to the component**
           * are switched to `remountGen`, falling back to the whole-stage `playToken` when omitted (export
           * page, legacy behavior unchanged). Both places must be changed together: `layoutId` relies on
           * it to refresh, and 3D / terminal cards rely on it to replay; swapping only the key makes Motion
           * treat the replay as a shared layout transition.
           *
           * **The two generations are added together, not an either-or choice.** Previously written as
           * `remountGen ?? playToken`, missing mounts in two places (measured by `seek-back-exact-probe.mjs`
           * leaving marks on wrapper layer nodes):
           *   - The stage's `playToken` starts from 1, and the first per-clip remount generation is also 1:
           *     on a newly opened visible stage, each card's first per-clip remount (the seek-back
           *     positioning recipe, starting frame catch-up) had an unchanged key, equivalent to not mounting;
           *   - After a card had a per-clip remount, its key only recognized `remountGen`, and increases in
           *     the whole stage's `playToken` no longer touched it: when this stage moved to the background
           *     for whole-scene catch-up runs (`render(jump)`), probe reset, or generating snapshots, this
           *     card no longer remounted with the entire stage.
           * Both generations only increase, and their sum strictly grows with each remount; without a
           * per-clip generation, it is `playToken` (export page, legacy unchanged by a single character).
           */
          const pid = pidOf(clip);
          const gen = playToken + (remountGen?.get(pid) ?? 0);
          const mountClockMs = mountClockMsOf(`${clip.id}:${gen}`, clip, cardT);
          const isSettling = settling?.has(pid) ?? false;
          const cls = [
            proxy ? "pc-proxy" : "",
            !isSettling && supNow.has(pid) ? "pc-suppressed" : "",
            awaiting?.has(pid) ? "pc-awaiting" : "",
            isSettling ? "pc-settling" : "",
          ].filter(Boolean).join(" ");
          // Whether this card should mount a stream plane (G1: single-card stream mounts in wrapper layer;
          // group stream and below-dependent stream mount under [data-pc-group-plane] at stage root)
          const ownStream = streamPlanes?.some((g) => g.clipIds.length === 1 && g.plane !== "stage" && g.clipIds[0] === pid) ?? false;
          /*
           * Whether the stream plane is shown: shown only when this card is suppressed, or is invisibly
           * catching up frames. At other times it may also remain mounted: paused to decode this frame under
           * the playhead first, waiting for the stream to draw the first frame before hiding the live subtree:
           * at that time the live subtree is still shown, so the stream plane must be hidden (`display: none`:
           * takes up no box, not counted in `solid.ts` entity box), otherwise the two visuals stack together.
           * Flipped in the same commit as `.pc-suppressed`, so switching visuals from live subtree to stream
           * does not miss a tick in between.
           */
          const streamShown = isSettling || supNow.has(pid);
          /*
           * Local frame number of the wrapper layer. Usually calculated from `cardT`; **clips undergoing
           * frame catch-up (`settling`) are calculated from their own virtual time** (companion to R9 M4):
           * if the wrapper layer frame number does not follow under subtree virtual time, `data-pc-gl-frame`
           * on the gl plane will never match it, causing every canvas card to be misclassified as `lossy` by
           * `rasterizeCanvas` in K1 two boolean probe passes / K5 path 1.
           * `settling` is only passed on stage; export page and legacy remain unchanged by a single character.
           */
          const settlingMs = settling?.get(pid);
          const localFrameT = settlingMs !== undefined ? Math.max(0, settlingMs / 1000 - clip.start) : Math.max(0, cardT - clip.start);
          const effFrame = clip.frameExpr
            ? resolveClipFrameAt(clip.frame, clip.frameExpr, localFrameT, clip.end - clip.start)
            : clip.frame;
          const localFrame = Math.round(((settlingMs !== undefined ? settlingMs / 1000 : cardT) - clip.start) * timeline.fps);
          /*
           * Canvas card (R9 M1): clips with a `canvas` contract (except `dom2d`) render an extra gl plane
           * in the wrapper layer, drawn by the shared renderer.
           * Whether to draw on this tick (M3): those "in `suppressed`" do not draw (pasting stream or
           * placeholder, not catching up). Size = clip entity box.
           */
          const glContract = !unsupported && def?.canvas && def.canvas.kind !== "dom2d" ? def.canvas : null;
          const glBox = glContract ? frameBox(effFrame, timeline) : null;
          // Group stream members, target cards of below-dependent streams: no stream plane in wrapper layer;
          // `hitTest` / `bounds` fall back to wrapper layer box for them
          // (G1 "Hit testing and entity boxes for group stream planes")
          const groupMember = streamPlanes?.some((g) => (g.clipIds.length > 1 || g.plane === "stage") && g.clipIds.includes(pid)) ?? false;
          return (
            <div
              key={`${clip.id}:${gen}`}
              {...{ [clipAttr]: clip.id }}
              data-pc-flat-clip={flatPrefix ? pid : undefined}
              data-pc-stream-member={groupMember ? "" : undefined}
              data-pc-local-frame={localFrame}
              data-pc-frame-mode={clipFrameMode(clip, def)}
              className={cls || undefined}
              style={{
                ...frameCss(effFrame, timeline, m ? { dx: m.dx, dy: m.dy } : undefined),
                ...(op < 1 ? { opacity: op } : null),
                ...(filter ? { filter } : null),
                /*
                 * Layer order is hard-coded here, not relying on DOM order.
                 *
                 * `active` is already in painter's order (flattenOverlay traverses tracks in reverse, so the last
                 * one = topmost track on the timeline = top layer), but DOM order alone is not enough: if anyone
                 * inside a card writes a z-index, and the outer layer is not a stacking context, that z-index
                 * escapes to the stage level for comparison, jumping over subsequent siblings. Testing showed
                 * that focus-card has `zIndex: 100` inside (focus-card.tsx:40), so putting a 3D card on the
                 * topmost track still leaves focus-card at the center of the video: the Agent arranged layers
                 * assuming "upper tracks cover lower ones", producing the opposite of what was promised.
                 *
                 * So do two things together: explicit z-index ordering, and `isolation: isolate` to create a
                 * stacking context that confines the card's internal z-index inside. This is the design doc
                 * rule: "each A/B object has an occlusion indicator, with 0 in front": the occlusion indicator
                 * is track order, translated here into CSS direction (in CSS, larger numbers are in front, exactly
                 * opposite to "0 in front", so it can only be hard-coded in one place).
                 */
                zIndex: i + 1,
                isolation: "isolate",
                // Cut segment: the full frame of the referenced cut is only exposed within the segment's box;
                // the entire layer of the preroll portion is hidden (and not clickable)
                ...(seg ? { overflow: "hidden" } : null),
                ...(prerolling ? { pointerEvents: "none" as const } : null),
              }}
            >
              {/*
                clip.params is already complete when written (see addCardClip in store); spreading a layer of
                defaults here is merely a fallback: when cards add parameters in the future, previously saved
                clips lack that key, and without this layer undefined would be passed into the component. Under
                normal conditions it fills in nothing: if anything is filled in, the clip was missing parameters.
              */}
              {seg ? (
                <CutSegmentScene seg={seg} start={clip.start} localT={localTOf(clip, t)}
                  localDirectT={settling?.has(pid) || frozenT.current.has(pid) ? localTOf(clip, t) : Math.max(0, directT - clip.start)}
                  playToken={gen} size={frameBox(effFrame, timeline)}
                  /* The cards inside each look up suppression, stream plane, and placeholder by
                   * "segment id~card clip id" (`kernel/cutFlatten.mjs`); export page and prerender page
                   * pass no planes, unchanged by a single character */
                  flatPrefix={pid + FLAT_SEP}
                  planes={usesPlanes ? { snapshots, suppressed, streamPlanes, remountGen, settling, awaiting } : undefined} />
              ) : guardRuntimeCard(clip.cardId, unsupported ? (
                /* Cards this device cannot run: card code does not run, no components mounted
                 * (snapshots / stream planes and placeholder slots are mounted below as usual) */
                null
              ) : clip.cardId === "composite" && clip.parts?.length ? (
                // Composite card: part instance tree renders level by level; canvas size is this card's box
                // (no box = entire stage)
                <PartTree parts={clip.parts} size={frameBox(effFrame, timeline)} t={localTOf(clip, t)} playToken={gen} />
              ) : def!.card ? (
                // Media effect card: passes through Stage, has wrapper layer;
                // hitTest / rects / snapshots / suppression all as usual
                <GraphCard def={def!} clip={clip} graph={timeline.graph} fps={timeline.fps}
                  t={localTOf(clip, cardT)} params={resolveCardParams({ ...def!.defaults, ...clip.params })} stage={stageInfo} />
              ) : clipFrameMode(clip, def) === 'direct' ? (
                <DirectCard def={def!} params={resolveCardParams(clip.params)} playToken={gen} t={localTOf(clip, cardT) + embeddedOffset} sourceOffset={clip.sourceOffset} duration={clip.end - clip.start} stage={stageInfo} />
              ) : (
                <C params={resolveCardParams({ ...def!.defaults, ...clip.params })} playToken={gen} t={localTOf(clip, cardT) + embeddedOffset} sourceOffset={clip.sourceOffset} mountClockMs={mountClockMs} duration={clip.end - clip.start} stage={stageInfo} />
              ))}
              {/*
                gl plane (R9, the fifth sibling plane of E7). It is **part of live render** and is not in the
                allowlist of the four plane selectors: when hiding subtrees, it is hidden along with the subtree.
                **Do not add `data-pc-clip`** (`isSolid` would skip it treating it as a wrapper layer). Bitmaps
                are attached by `glHost` on `done`; here we only register what to draw for this tick.
              */}
              {glContract && glBox ? (
                <GlPlane clipId={pid} cardId={clip.cardId} contract={glContract}
                  w={glBox.width} h={glBox.height} t={localTOf(clip, cardT)} frame={localFrame}
                  params={resolveCardParams({ ...def!.defaults, ...clip.params })} gen={gen}
                  skip={supNow.has(pid)} stage={stageInfo} />
              ) : null}
              {/*
                The proxy block is a **sibling** of the card, not a wrapper around the card: the real card is
                hidden by the .pc-proxy CSS rule (see render/solidMode.ts). Wrapping it in a div causes React to
                remount the card when switching to solid mode, and remounting loses pinAnimations anchor points:
                users would see "every time it pauses, the text flies in again". box is "the area where this card
                actually drew content", coordinates relative to the card's own box; if unmeasurable (or if
                content natively fills the card), inset:0 is used.
              */}
              {proxy ? (() => {
                const px = proxy(clip.id);
                return (
                  <div
                    data-pc-proxy-plane=""
                    style={{
                      position: "absolute",
                      ...(px.box ?? { inset: 0 }),
                      background: px.color,
                      borderRadius: 6,
                    }}
                  />
                );
              })() : null}
              {/*
                Stream plane (E7 item 5, R8). `streamPlayer` draws only onto this **existing** `<canvas>`, 
                without doing external `insertBefore`: otherwise it competes with the proxy plane and snapshot
                plane for sibling positioning. Layer ordering, overflow, zIndex, wrapper layer's box / track /
                opacity / emphasis automatically follow the wrapper layer: single-card stream is drawn in the
                wrapper layer's own coordinate system (same as the snapshot plane), so this canvas is a regular
                child element of the wrapper layer. Position and size are set by `streamPlayer` according to the
                stream's manifest (the stream's rectangular upper bound, which may be slightly larger than the
                box or extend outside it); before the manifest arrives, fill the wrapper layer first (0×0
                backplate, transparent): the suppressed card subtree is hidden, but clicks during this short
                window must still register.
              */}
              {ownStream ? (
                <canvas data-pc-stream-plane="" width={0} height={0}
                  style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", ...(streamShown ? null : { display: "none" }) }} />
              ) : null}
              {/*
                Placeholder plane (product/rendering.md "Fallback order"; peer to snapshot / stream plane,
                inheriting coordinates, rotation, scaling, and z-index from wrapper layer). The slot defaults to
                `hidden`; `StageView` toggles its `hidden` each tick (`setPlaceholderShown` in contract) without
                going through React commit: the `hidden` prop is always true, so React will not overwrite the
                manually toggled value. Placed last: within the same wrapper layer it sits on top of snapshot /
                stream planes (when it is displayed, those two have no visual content anyway).
              */}
              {placeholders ? (() => {
                /*
                 * Size on screen (`placeholderFit.ts`): the hourglass only cancels preview scaling and does not
                 * exceed this layer's box. Preview scaling is sent from the parent page via `setViewScale` (sent on
                 * both desktop and online). Cards this device cannot run also show an hourglass (results produced
                 * by render nodes).
                 */
                const size = frameBox(effFrame, timeline);
                const geometry = geometryFor(pid, size);
                const reason = unsupported ? "awaiting" : placeholderReasonOf(pid);
                return (
                  <div {...{ [PLACEHOLDER_SLOT_ATTR]: "" }} hidden style={{ position: "absolute", inset: 0 }}>
                    <PlaceholderPlane clipId={pid} geometry={geometry} reason={reason}
                      fit={placeholderFitFor(pid, reason, geometry, size, effFrame?.scale ?? 1)} />
                  </div>
                );
              })() : null}
            </div>
          );
        };
  return (
    <div
      ref={stageRef}
      className="pc-stage"
      style={{ position: "relative", width: timeline.width, height: timeline.height, overflow: overflowVisible ? "visible" : "hidden", background: "transparent" }}
    >
      <AnimClock
        speed={speed}
        style={
          timeline.camera3dFov
            ? {
                perspective: `${perspectivePx({ width: timeline.width, height: timeline.height }, timeline.camera3dFov)}px`,
                perspectiveOrigin: "50% 50%",
              }
            : undefined
        }
      >
        {hasStandaloneCam2D ? (
          <>
            <div data-pc-camera2d="" style={{ position: "absolute", inset: 0, overflow: "visible", ...(standaloneCamStyle ?? {}) }}>
              {active.map((clip, i) => (isCaptionClip(clip) ? null : renderClip(clip, i)))}
            </div>
            {active.map((clip, i) => (isCaptionClip(clip) ? renderClip(clip, i) : null))}
          </>
        ) : (
          active.map(renderClip)
        )}
      </AnimClock>
      {/*
        Group stream plane (G1: a single stream covers multiple adjacent heavy cards). It spans clips and
        cannot be mounted into any wrapper layer, so it resides at the stage root, peer to the layer
        containing card wrapper layers; wrapper layer appearances in a group stream are already baked into
        the stream, so it is unaffected by any wrapper layer's `frameCss` / `opacity` / `filter` /
        `motion` / `isolation`. **Rendered only in the `Stage` of the topmost currently active card
        (`host`) in the group**: the live path has one single-clip `Stage` per clip, and rendering in each
        would stack the same group stream multiple times; z-order takes that card's layer.
        `pointer-events: none`: clicks fall through to wrapper layers of suppressed cards in the background
        group (`hitTest` in `solid.ts`).

        **Below-dependent streams** (`plane: "stage"`, only one target card) are also this kind of plane:
        the stream contains the target card's modified layer (premultiplied color plus opacity); wrapper
        layer position, opacity, fade-in/out, track, and emphasis are already drawn inside, so it likewise
        cannot be mounted inside the wrapper layer. It shares the same stacking context and layer order
        with the target card's wrapper layer, so it overlays live layers below (live-rendered cards, other
        streams, videos) like normal stacking, while layers above render on top as usual: behind frosted
        glass is the true live lower layer on stage. The target card's subtree is hidden per suppression
        rules and will not filter the lower layer a second time.
      */}
      {streamPlanes?.filter((g) => g.clipIds.length > 1 || g.plane === "stage").map((g) => {
        const hostId = g.host ?? g.clipIds[g.clipIds.length - 1];
        const at = active.findIndex((c) => pidOf(c) === hostId);
        if (at < 0) return null;
        // Shown only when group members are suppressed / invisibly catching up frames (same as single-card
        // stream's `streamShown`: group stream plane is hidden while paused to decode this frame first)
        const shown = g.clipIds.some((id) => supNow.has(id) || (settling?.has(id) ?? false));
        return <canvas key={g.clipIds.join(",")} data-pc-group-plane="" data-pc-stream-group={g.clipIds.join(",")}
          width={0} height={0}
          style={{ position: "absolute", left: 0, top: 0, width: 0, height: 0, zIndex: at + 1, pointerEvents: "none", ...(shown ? null : { display: "none" }) }} />;
      })}
    </div>
  );
}

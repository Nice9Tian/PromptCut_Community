import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Stage, type ProxyRender, type StagePlaneProps } from "./Stage";
import { flattenOverlay, isImageMedia, nextVideoLayerAfter, opacityAt, videoLayersAt, type MediaAsset, type Project, type TrackClip } from "../kernel/project";
import type { Timeline } from "../kernel/types";
import { frameCss } from "../kernel/layout";
import { emphasisFilter } from "../kernel/emphasis";
import { clipFilterOpsAt, cssFilter } from "../kernel/filters.mjs";
import { pixelMapOfClip } from "../kernel/pixelMap.mjs";
import { clipSpeed, mediaTimeAt } from "../kernel/clipTime.mjs";
import { type PixelMapDef } from "../kernel/pixelMap.mjs";
import { drawPixelMap } from "./pixelMapGl";
import { graphVisualNode } from "./cards/GraphCard";
import { cardMountedAt } from "./frameWindow.mjs";
import { clipFrameMode } from "../kernel/frameMode.mjs";
import { getCard } from "../kernel/registry";
import { VideoTrack } from "./VideoTrack";
import { driveMedia, filterOf, releaseMedia, targetTimeOf } from "./mediaDrive";
import { playbackUrl } from "./mediaTier";
import { confirmedMissingVisual, missingMaterialLabel } from "../audio/missingMaterial";
import { MissingMaterial } from "./MissingMaterial";
import { SceneHostContext } from "./CutSegmentScene";

const NO_HASHES: readonly string[] = [];

/**
 * Asset time for export / prerender frame capture (`data-pc-media-time`; during screenshot step
 * `frameMedia.ts` seeks by it). Speed-changed clips use the unified conversion from
 * `kernel/clipTime.mjs`; when default is 1, keep the original operation order here
 * `(mediaOffset + t) − start`: floating-point addition and subtraction are not associative,
 * and changing to `mediaOffset + (t − start)` might differ in the last bit; export frame
 * capture must be bit-for-bit identical.
 */
function exportMediaTime(clip: TrackClip, t: number): number {
  return Math.max(0, clipSpeed(clip) === 1 ? (clip.mediaOffset ?? 0) + t - clip.start : mediaTimeAt(clip, t));
}

/**
 * Pixel map on the asset layer. Visuals are computed by a WebGL2 fragment shader
 * (render/pixelMapGl.ts): expressions are translated to GLSL in kernel/pixelMap.mjs, video / image
 * frames serve as textures, and a second texture is used when `to` is another asset.
 * This <canvas> only has a bitmaprenderer context: shader paints the full bitmap and transfers it
 * over. The original per-pixel CPU loop (getImageData → mapRgba → putImageData) has been completely
 * removed with no fallback: benchmarks showed 416-483 ms per frame at 1080p, exceeding the per-tick
 * budget for 30 fps by about twenty times.
 */
function PixelMappedMedia({ media, clip, t, project, style, def, live = false, playing = false, scrubbing = false, localHashes = NO_HASHES }: { media: any; clip: any; t: number; project: Project; style: React.CSSProperties; def: PixelMapDef; live?: boolean; playing?: boolean; scrubbing?: boolean; localHashes?: readonly string[] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const source = useRef<HTMLVideoElement | HTMLImageElement>(null);
  const targetSource = useRef<HTMLVideoElement | HTMLImageElement>(null);
  // When stage=after_filters, apply filters to an intermediate canvas first, then upload as texture
  // (filters are applied on the GPU by the compositor without reading back pixels). stage=origin
  // uploads the asset element directly, saving one resampling pass.
  const staged = useRef<HTMLCanvasElement | null>(null);
  const draw = useCallback(() => {
    const c = canvas.current; const s = source.current;
    const ready = (el: HTMLVideoElement | HTMLImageElement) => el instanceof HTMLVideoElement ? el.readyState >= 2 : el.complete && el.naturalWidth > 0;
    if (!c || !s || !ready(s)) return;
    const w = Math.max(1, Math.round(project.width)); const h = Math.max(1, Math.round(project.height));
    let src: CanvasImageSource = s;
    if (def.source.stage === "after_filters" && clip.filter) {
      const ops = project.filters?.length ? clipFilterOpsAt(project, clip, t) : null;
      const css = ops ? cssFilter(ops) : "";
      if (css) {
        const mid = staged.current ?? (staged.current = document.createElement("canvas"));
        if (mid.width !== w || mid.height !== h) { mid.width = w; mid.height = h; }
        const mx = mid.getContext("2d");
        if (mx) { mx.clearRect(0, 0, w, h); mx.filter = css; mx.drawImage(s, 0, 0, w, h); mx.filter = "none"; src = mid; }
      }
    }
    const ts = targetSource.current;
    const target = def.to?.kind === "media" && ts && ready(ts) ? ts : null;
    try {
      drawPixelMap(c, { def, source: src as TexImageSource, target: target as TexImageSource | null, width: w, height: h, t });
      c.removeAttribute("data-pc-pixel-error");
    } catch (err) {
      // If rendering fails, leave this layer empty; avoid dragging down whole scene tree. Attributes kept for acceptance scripts and debugging
      c.setAttribute("data-pc-pixel-error", err instanceof Error ? err.message : String(err));
      console.error("[pixelMap]", err);
    }
  }, [def, clip, project, t]);
  useEffect(() => {
    // Source images/videos load only at capture time. Draw synchronously when
    // all decoders are ready; a wall-clock timer can miss the screenshot.
    document.addEventListener("pc:frame-media-ready", draw);
    return () => document.removeEventListener("pc:frame-media-ready", draw);
  }, [draw]);
  /*
   * live (stage) path: Source assets are `<video>` / `<img>` that are **actually playing**, not
   * placeholders like on the export page that only attach src when taking snapshots. So here we
   * align with the playhead ourselves and repaint on every render; video adds an extra rVFC:
   * when a new frame is decoded, the visual must update accordingly, whereas during pause there is
   * no playback loop driving rerenders.
   */
  useLayoutEffect(() => {
    if (!live) return;
    const v = source.current;
    if (v instanceof HTMLVideoElement) {
      driveMedia(v, { target: targetTimeOf(clip, t), playing, volume: 0, scrubbing, rate: clipSpeed(clip) });
      v.requestVideoFrameCallback(() => draw());
    }
    const tv = targetSource.current;
    if (tv instanceof HTMLVideoElement) {
      driveMedia(tv, { target: Math.max(0, t), playing, volume: 0, scrubbing });
      tv.requestVideoFrameCallback(() => draw());
    }
    draw();
  });
  useLayoutEffect(() => {
    if (!live) return;
    const a = source.current;
    const b = targetSource.current;
    return () => {
      if (a instanceof HTMLVideoElement) releaseMedia(a);
      if (b instanceof HTMLVideoElement) releaseMedia(b);
    };
  }, [live]);
  // Hide the source asset (visuals come from the canvas below). visibility:hidden videos still
  // decode and still invoke rVFC callbacks (tested on Chrome 152, same as VideoTrack's hidden slot),
  // and `texImage2D` can still read frames decoded from them.
  const hidden: React.CSSProperties = { ...style, visibility: "hidden", position: "absolute" };
  const targetMedia = def.to?.kind === "media" ? project.media.find((m) => m.id === (def.to as Extract<PixelMapDef["to"], { kind: "media" }>).mediaId) : null;
  const targetHidden: React.CSSProperties = { ...hidden, pointerEvents: "none" };
  /*
   * The export page (placeholder) intentionally **does not provide src**: while advancing React,
   * never seek / decode assets; only during screenshot step does `__pcPrepareFrameMedia` restore
   * this frame according to `data-pc-media-*`. The live (stage) path is the exact opposite: assets
   * are actually playing, so only now do we attach `src` and set `preload="auto"`.
   */
  // live's src goes through tier switch criteria (playbackUrl in `mediaTier.ts`, T1a review #5);
  // `data-pc-media-src` remains `media.url` (identity, original-size asset)
  //
  // When getting an empty string, return `undefined`; never attach "" to `src`. The file header of
  // `playbackUrl` states that "callers receiving "" should not attach src or send requests", and
  // `<video src="">` is treated by browsers as "downloading the current page again", and React will
  // also warn "An empty string ("") was passed to the src attribute". This is the case when an asset
  // is being stored (`pending`, no URL yet): locally imported pending windows last only milliseconds
  // and go unnoticed; importing from a cloud drive pulls for tens of seconds to several minutes,
  // during which preview is broken. (Found on 2026-10-23 while running cloud drive connector
  // end-to-end; user reported "Preview failed when adding".)
  const srcOf = (m?: MediaAsset | null) => (live && m ? playbackUrl(m, localHashes) || undefined : undefined);
  const load = live ? "auto" : "none";
  return <>
    {isImageMedia(media) ? <img ref={source as any} src={srcOf(media)} onLoad={live ? () => draw() : undefined} data-pc-media-src={media.url} data-pc-media-hidden="true" alt="" style={hidden} /> :
      <video ref={source as any} muted playsInline preload={load} src={srcOf(media)} data-pc-media-src={media.url} data-pc-media-hidden="true"
        data-pc-media-time={exportMediaTime(clip, t)} style={hidden} />}
    {targetMedia ? (isImageMedia(targetMedia) ? <img ref={targetSource as any} src={srcOf(targetMedia)} onLoad={live ? () => draw() : undefined} data-pc-media-src={targetMedia.url} data-pc-media-hidden="true" alt="" style={targetHidden} /> :
      <video ref={targetSource as any} muted playsInline preload={load} src={srcOf(targetMedia)} data-pc-media-src={targetMedia.url} data-pc-media-hidden="true"
        data-pc-media-time={Math.max(0, t)} style={targetHidden} />) : null}
    <canvas ref={canvas} width={Math.max(1, Math.round(project.width))} height={Math.max(1, Math.round(project.height))}
      data-pc-pixel-map={JSON.stringify(def)} data-pc-pixel-time={t} style={style} />
  </>;
}

/**
 * Per-card duration for K6: **clocking a clip's subtree using render order**.
 *
 * Cannot use React's `<Profiler>`: its `actualDuration` reads `performance.now()`, but the stage
 * replaces `performance.now` with a virtual clock (`stageClock`): within a tick it is a constant,
 * so `Profiler` reports 0 for every card (tested). To measure duration, always use `__pcRealNow`
 * (the real wall clock saved before takeover).
 *
 * Approach: **place a sibling component before and after this clip's `Stage` that runs its
 * callback only once and produces no DOM**. React rendering is depth-first and siblings go
 * left-to-right, so the order "earlier callback → entire subtree render → later callback" is
 * deterministic (no interruption under synchronous `flushSync`). The difference between two
 * `__pcRealNow()` calls is this card's render duration for this tick; when the subtree is skipped
 * because props have not changed, it naturally approaches 0: that was its true cost for this tick
 * all along.
 *
 * **Only measures the render phase**, excluding commit to DOM. See correction suggestions in the
 * report.
 */
const realNow = (): number => (typeof window !== "undefined" && window.__pcRealNow ? window.__pcRealNow() : performance.now());
/** Timestamp recorded by previous `CostMark`. Single-threaded sequential rendering; module variable suffices */
let costMarkAt = 0;
function CostMark({ at }: { at: (now: number) => void }) {
  at(realNow());
  return null;
}

/**
 * One browser stacking tree, ordered from the bottom track upwards.
 *
 * # Two asset variants (E7)
 *
 * `mediaMode: 'placeholder'` (default; export page and legacy take this path): Video placeholders
 * **intentionally do not have src**: while advancing React, never seek / decode assets; only during
 * screenshot does `__pcPrepareFrameMedia` restore this frame according to `data-pc-media-*`.
 * **Not a single character of DOM on this path may change** (export has a pixel-by-pixel baseline).
 *
 * `mediaMode: 'live'` (stage page): Asset layer is actually playing: one `VideoTrack` per track
 * (alternating dual `<video>`, see `render/VideoTrack.tsx`), with `cur` / `next` computed here by
 * `mediaT`; card active criterion switches to `cardMountedAt` (including LEAD, matching the
 * criterion inside `Stage`); six optional props of `Stage` (snapshot / suppression / stream plane /
 * remount generation / frame catch-up / wait) are passed through as is.
 */
export function FrameScene({
  project, sourceProject = project, t, directT = t, playToken, graph,
  mediaMode = "placeholder", mediaT = t, scrubbing = false, playing = false, proxy,
  suppressed, streamPlanes, snapshots, remountGen, settling, awaiting, localHashes, onMediaFrame, onCardCost, nested = false, flatPrefix,
}: {
  project: Project; sourceProject?: Project; t: number; directT?: number; playToken: number; graph?: Timeline["graph"];
  /**
   * Nested scene in a cut segment (`CutSegmentScene`): track layer does not attach `data-pc-track`,
   * clip layer attaches `data-pc-nested-clip` (prerender layer splitting by track prefix, hit
   * testing, and pin animation only recognize the stage top level). Top level is always false,
   * not a single character of DOM changes.
   */
  nested?: boolean;
  /** Nested scene in cut segment: clip id prefix on plan side (`Stage`'s `flatPrefix`; `kernel/cutFlatten.mjs`). Not passed at top level */
  flatPrefix?: string;
  /** How to paint asset layer: placeholder for export page / legacy, or what is actually playing on stage (E7 item 1) */
  mediaMode?: "placeholder" | "live";
  /** Time tracked by asset layer (seconds). Normally equals `t`; in K5 pass 2 catch-up runs, parent page sends target tick to `back` separately */
  mediaT?: number;
  scrubbing?: boolean;
  playing?: boolean;
  proxy?: ProxyRender;
  /**
   * A1's `localHashes`: Hashes reported as `complete` by currently connected asset service.
   * **Consumed only by the live path** (src for `VideoTrack` and pixel map assets undergoes tier
   * switch via playbackUrl in `mediaTier.ts`, T1a review #5); placeholder path (export page / legacy)
   * always uses `media.url`, not changing a single pixel even if passed. Empty set = always
   * original-size asset, same as before tier switch was connected.
   */
  localHashes?: readonly string[];
  /** live: Asset layer on the background stage has rendered a frame (`mediaReady` in K5 step (4)) */
  onMediaFrame?: (mediaTime: number) => void;
  /**
   * K6: How many milliseconds this card took this tick. **Present only on the live path**, reported
   * by `<Profiler>` as `actualDuration` (time spent rendering this clip's subtree during this commit).
   *
   * Why use `Profiler` instead of manual timing: A tick is a single `flushSync` where the whole tree
   * commits together, so timing from outside only measures total; whereas K6 needs "the light card
   * with the highest measured cumulative duration in this window". On the live path, each clip is
   * already an independent single-clip `Stage`, and wrapping with `Profiler` produces no DOM.
   *
   * **Limitation**: It measures React render / commit, not time spent in the card's own rAF callbacks
   * (those run in `clock.tick`, with no reliable ownership mapping between callbacks and clips).
   * See correction suggestions in the report.
   */
  onCardCost?: (clipId: string, ms: number) => void;
} & StagePlaneProps) {
  const live = mediaMode === "live";
  const hashes = live ? localHashes ?? NO_HASHES : NO_HASHES;
  const layers = videoLayersAt(project, live ? mediaT : t);
  const frame = Math.round(directT * (project.fps || 30));
  const runtime = (sourceProject as any)._cardRender as { frames?: Record<string, Record<number, string>>; missing?: Record<number, string[]> } | undefined;
  const cached = (id: string) => runtime?.frames?.[id]?.[frame];
  const missing = new Set(runtime?.missing?.[frame] || []);
  const replaced = (id: string) => !!cached(id) || missing.has(id);
  const tracks = [...project.tracks].reverse().filter((tr) => !tr.hidden);
  /*
   * Cards determine activity by their own time criteria: direct-evaluation cards use directT,
   * sequential cards use t.
   * Under windowed frame capture (see_frames / partial export), when t is still before clip start
   * point, sequential cards must not mount early because directT passed start point (otherwise one
   * frame too early).
   * Under live, use cardMountedAt (including 50ms lead); under placeholder (export), use [start, end)
   * interval.
   */
  const clipTime = (clip: TrackClip) =>
    clipFrameMode(clip, getCard(clip.cardId)) === "direct" ? directT : t;
  const active = live
    ? (clip: TrackClip) => cardMountedAt(clip, clipTime(clip))
    : (clip: TrackClip) => {
        const ct = clipTime(clip);
        return ct >= clip.start && ct < clip.end;
      };
  /*
   * Media clips taken over by media effect cards and media clips with pixel maps do not enter
   * `VideoTrack`: the former are painted by the media effect card in `Stage`, and the latter are
   * painted by `PixelMappedMedia`: if not filtered out, the same media clip would be painted twice.
   * **Filtering must be pushed down into `nextVideoLayerAfter`** (it returns only one clip per
   * track; filtering after the fact is equivalent to that track having no `next`).
   */
  // Disabled pixel maps count as unattached (`pixelMapOfClip`); this clip falls back to normal asset layer without PixelMappedMedia
  const takenByOther = (clip: TrackClip) =>
    graphVisualNode(graph, clip.nodeId) || !!pixelMapOfClip(project, clip);
  const nexts = live ? nextVideoLayerAfter(project, mediaT, takenByOther) : [];
  /*
   * E7 item 7: `legacyTimeline` is memoized by `(project, tr, clip)` references. Without memoization,
   * a new `timeline` object is created for each clip on every frame, so `Stage`'s `useMemo` and
   * `GraphCard`'s input resolution all recompute on the new reference: during playback, this cost
   * is paid on every tick. WeakMap uses the clip object as key: store updates are immutable, so
   * untouched clip references stay unchanged.
   */
  const timelineCache = useRef(new WeakMap<object, { project: Project; tr: unknown; graph: unknown; timeline: Timeline }>());
  const legacyTimeline = (tr: Project["tracks"][number], clip: Project["tracks"][number]["clips"][number]): Timeline => {
    const hit = timelineCache.current.get(clip);
    if (hit && hit.project === project && hit.tr === tr && hit.graph === graph) return hit.timeline;
    // Graphs **cannot** be computed from cropped version (only 1 track and 1 clip kept, cross-clip inputs cannot resolve): host computes and brings in as is.
    const timeline = { ...flattenOverlay({ ...project, tracks: [{ ...tr, clips: [clip] }] }), graph } as Timeline;
    timelineCache.current.set(clip, { project, tr, graph, timeline });
    return timeline;
  };
  const stageSize = { width: project.width, height: project.height };
  const clipAttr = nested ? "data-pc-nested-clip" : "data-pc-clip";
  // Nested cut segment scenes are rendered with the same asset variant (CutSegmentScene)
  const host = { live, mediaT, playing, scrubbing, localHashes: hashes };
  return <SceneHostContext.Provider value={host}>{tracks.map((tr, index) => {
    const curOf = (trackId: string) => layers.find((l) => l.trackId === trackId && !takenByOther(l.clip) && !replaced(l.clip.id)) ?? null;
    // Whether visual clips (video / image) exist on this track. If none, do not mount VideoTrack to avoid two extra empty <video>
    const hasVisual = tr.clips.some((c) => {
      if (!c.mediaId || takenByOther(c)) return false;
      const m = project.media.find((x) => x.id === c.mediaId);
      return !!m && m.kind !== "audio";
    });
    return <div key={tr.id} {...(nested ? { "data-pc-nested-track": tr.id } : { "data-pc-track": tr.id })} style={{ position: "absolute", inset: 0, zIndex: index }}>
      {live && hasVisual ? (
        <VideoTrack
          project={project}
          cur={curOf(tr.id)}
          next={nexts.find((n) => n.trackId === tr.id) ?? null}
          t={mediaT}
          playing={playing}
          scrubbing={scrubbing}
          // Stage is always muted: audio stays in the editor main document (MediaLayers's audioOnly)
          muted
          stage={stageSize}
          filters={project.filters}
          onMediaFrame={onMediaFrame}
          localHashes={hashes}
        />
      ) : null}
      {live ? layers.filter((l) => l.trackId === tr.id && !graphVisualNode(graph, l.clip.nodeId) && !replaced(l.clip.id) && !confirmedMissingVisual(l.media)
        && !!pixelMapOfClip(project, l.clip)).map(({ clip, media, opacity }) => {
        const def = pixelMapOfClip(project, clip)!;
        const ops = project.filters?.length ? clipFilterOpsAt(project, clip, mediaT) : null;
        const filter = [ops ? cssFilter(ops) : "", emphasisFilter(clip.emphasis) || ""].filter(Boolean).join(" ");
        const style = { display: "block", width: "100%", height: "100%", objectFit: "cover" as const, opacity, filter: filter || undefined };
        return <div key={clip.id} {...{ [clipAttr]: clip.id }} data-pc-media="" data-pc-local-frame={Math.round((mediaT - clip.start) * project.fps)} style={{ position: "absolute", overflow: "hidden", ...frameCss(clip.frame, project) }}>
          <PixelMappedMedia media={media as MediaAsset} clip={clip} t={mediaT} project={project} style={style} def={def} live playing={playing} scrubbing={scrubbing} localHashes={hashes} />
        </div>;
      }) : null}
      {!live && layers.filter(l => l.trackId === tr.id && !graphVisualNode(graph, l.clip.nodeId) && !replaced(l.clip.id) && !confirmedMissingVisual(l.media)).map(({ clip, media, opacity }) => {
        const ops = project.filters?.length ? clipFilterOpsAt(project, clip, t) : null;
        const filter = [ops ? cssFilter(ops) : "", emphasisFilter(clip.emphasis) || ""].filter(Boolean).join(" ");
        const style = { display: "block", width: "100%", height: "100%", objectFit: "cover" as const, opacity, filter: filter || undefined };
        // data-pc-media: Selector for controls relies on it to exclude the asset layer when generating snapshots (see render/createSnapshot.ts)
        return <div key={clip.id} {...{ [clipAttr]: clip.id }} data-pc-media="" data-pc-local-frame={Math.round((t - clip.start) * project.fps)} style={{ position: "absolute", overflow: "hidden", ...frameCss(clip.frame, project) }}>
          {pixelMapOfClip(project, clip) ? (() => {
            const def = pixelMapOfClip(project, clip)!;
            return <PixelMappedMedia media={media} clip={clip} t={t} project={project} style={style} def={def} />;
          })() : isImageMedia(media) ? <img data-pc-media-src={media.url} alt="" style={{ ...style, visibility: "hidden" }} /> :
            <video muted playsInline preload="none" data-pc-media-src={media.url}
              data-pc-media-time={exportMediaTime(clip, t)}
              style={{ ...style, visibility: "hidden" }} />}
        </div>;
      })}
      {tr.clips.map((clip, clipIndex) => {
        // Cut segment: Active criterion looks at copy handed over by flattenOverlay (start includes preroll, frame-push criteria from referenced cut), not original segment on track
        if (clip.cutId) {
          const seg = legacyTimeline(tr, clip).clips[0];
          if (!seg || !active(seg as TrackClip)) return null;
        } else if (!active(clip)) return null;
        const layerStyle: React.CSSProperties = { position: "absolute", inset: 0, zIndex: clipIndex };
        const media = clip.mediaId ? project.media.find((item) => item.id === clip.mediaId) : undefined;
        if (media && confirmedMissingVisual(media)) {
          if (live && !takenByOther(clip)) return null; // The live VideoTrack owns ordinary visual media layers.
          const sceneTime = live ? mediaT : t;
          return <div key={clip.id} {...{ [clipAttr]: clip.id }} data-pc-media="" data-pc-confirmed-missing="1"
            style={{ ...layerStyle, ...frameCss(clip.frame, project), opacity: opacityAt(clip, sceneTime), filter: filterOf(clip, project.filters, sceneTime), pointerEvents: "none" }}>
            <MissingMaterial name={missingMaterialLabel(media)} />
          </div>;
        }
        if (replaced(clip.id)) {
          const url = cached(clip.id);
          // Cached controls are full-stage PNGs. Their placement and motion have
          // already been baked by the capture, so applying frameCss here would
          // transform them twice. Opacity and fades are baked there as well.
          return url
            ? <div key={clip.id} {...{ [clipAttr]: clip.id }} style={layerStyle}>
              <img data-pc-cached-control={clip.id} src={url} alt="" style={{ display: "block", width: "100%", height: "100%" }} />
            </div>
            : <div key={clip.id} {...{ [clipAttr]: clip.id }} data-pc-incomplete={clip.id} style={{ ...layerStyle, ...frameCss(clip.frame, project), border: "2px dashed #dcb66a", boxSizing: "border-box", display: "grid", placeItems: "center", background: "#1e273050", opacity: opacityAt(clip, directT) }}>
              <span style={{ color: "#fff", fontSize: 28 }}>⌛</span>
            </div>;
        }
        const timeline = legacyTimeline(tr, clip);
        // Media has already been painted below this block. A one-clip Stage
        // keeps each legacy card at its original track position while retaining
        // Stage's direct-child perspective and glass/backdrop context.
        // E7 items 3-5: `proxy` and six plane props are passed through as is to each internal single-clip
        // `Stage`. The `placeholder` path passes none of them (the host never provided them), and not a
        // single character of DOM changes.
        if (!timeline.clips.length) return null;
        const stage = (
          <Stage timeline={timeline} t={t} directT={directT} playToken={playToken} nested={nested} flatPrefix={flatPrefix}
            proxy={proxy} snapshots={snapshots} suppressed={suppressed} streamPlanes={streamPlanes}
            remountGen={remountGen} settling={settling} awaiting={awaiting} />
        );
        /*
         * Per-card duration for K6. **Whether to add these two siblings is determined by `live`, not by
         * whether `onCardCost` is present**: adding or removing a sibling midway causes React to reconcile
         * by position and remount the card, losing anchor points. `placeholder` (export / legacy) never
         * adds them, leaving DOM and render path completely unchanged (`CostMark` itself returns `null`,
         * so the live path DOM has not a single extra node either).
         */
        return (
          <div key={clip.id} {...(nested ? null : { "data-pc-native-layer": clip.id })} style={layerStyle}>
            {live ? <CostMark at={(now) => { costMarkAt = now; }} /> : null}
            {stage}
            {live ? <CostMark at={(now) => onCardCost?.(clip.id, now - costMarkAt)} /> : null}
          </div>
        );
      })}
    </div>;
  })}</SceneHostContext.Provider>;
}

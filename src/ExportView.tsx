import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { FrameScene } from "./render/FrameScene";
import { Stage } from "./render/Stage";
import { installExportClock } from "./kernel/exportClock";
import type { Timeline } from "./kernel/types";
import { flattenOverlay, type Project } from "./kernel/project";
import { flatPlanProject, withFlatNodes } from "./kernel/cutFlatten.mjs";
import { themeStyle } from "./themes";
import { allCards, getCard, setSyncedUserCards, unknownCardClipIds, userCardSources, type SyncedUserCard } from "./kernel/registry";
import { setExportSyncedMount } from "./render/placeholderHost";
import { cardSourceVersion } from "./render/cardSourceVersion.mjs";
import { builtinCardSourceFiles } from "./render/cardSourceFiles.mjs";
import { projectCardGraph } from "./kernel/cardGraph.mjs";
import { withMediaRates } from "./kernel/clipTime.mjs";
import { planFrameWindow } from "./render/frameWindow.mjs";
import { createSnapshot } from "./render/createSnapshot";
import { solidApi } from "./render/solid";
import { settleDom } from "./render/snapshotSettle";
import { installFrameMedia } from "./render/frameMedia";
import { clipFrameMode } from "./kernel/frameMode.mjs";
import { fontFingerprintOf } from "./render/fontFingerprint";
import { frameWorkStatus, waitForFrameWork } from "./kernel/frameReady";
import { demoTimeline } from "./demo";
import { createGlHost, type GlHost } from "./render/gl/glHost";
import { grabCanvasPixels } from "./render/gl/canvasGrab";
import { cardExecGate, markIsolatedStageDocument, noteMediaPolicy } from "./online/isolation/execGate";
import { stageGuardBooted } from "./online/isolation/stageGuard";
import { waitReal } from "./export/realClock";
import { pageCssText, pasteLayer, sceneToSvg } from "./export/frameCompositor";
import { withTicket } from "./export/ticketRenewal";
import type { FrameLayer } from "./export/exportLayers";
import "./cards";
import { tr as trText } from "./i18n/index.ts";

/** Export page init: time limit (real milliseconds) for waiting on the stage self-check and for
 *  the project to be loaded */
const EXPORT_GATE_WAIT_MS = 10_000;
const EXPORT_LOAD_WAIT_MS = 30_000;

// As soon as the export view is entered, quantize the page clock to export frames (see
// exportClock.ts); this must come before any card mounts
if (new URLSearchParams(location.search).has("export")) installExportClock();
// The media loader must also come before any card mounts: while advancing animation, never assign
// a URL to media (originally scripts/frame-media.mjs, now server/bakery/frame-media.mjs)
if (new URLSearchParams(location.search).has("export")) installFrameMedia();

/*
 * ?cardsOnly=1: mount no media (video / image) at all, render only the transparent layer of cards.
 * Default export and see_frames go through the full Chrome FrameScene; this path, the card
 * transparent-layer bypass, is only used with an explicit --media=ffmpeg. cardsOnly is kept for
 * compatibility with the bypass and for callers that need cards only.
 */
const CARDS_ONLY = new URLSearchParams(location.search).get("cardsOnly") === "1";
function stripMedia(p: Project): Project {
  return { ...p, media: [], tracks: p.tracks.map((tr) => ({ ...tr, clips: tr.clips.filter((c) => !c.mediaId) })) };
}

function mediaFrameUrl(el: HTMLVideoElement | HTMLImageElement, scratch: HTMLCanvasElement, quality = 0.95): string | null {
  const isVideo = el.tagName === "VIDEO";
  const w = isVideo ? (el as HTMLVideoElement).videoWidth : (el as HTMLImageElement).naturalWidth;
  const h = isVideo ? (el as HTMLVideoElement).videoHeight : (el as HTMLImageElement).naturalHeight;
  if (!w || !h) return null;
  scratch.width = w;
  scratch.height = h;
  const g = scratch.getContext("2d");
  if (!g) return null;
  g.clearRect(0, 0, w, h);
  try {
    g.drawImage(el, 0, 0, w, h);
    return isVideo ? scratch.toDataURL("image/jpeg", quality) : scratch.toDataURL("image/png");
  } catch {
    return null;
  }
}

/**
 * Export view (?export=1). The per-frame sequence of the export script:
 *   1. page.evaluate(window.__pcSetT(sec))  → writes __pcExportMs, setT triggers a React re-render
 *   2. advance CDP virtual time by 1/fps (React commit, rAF, and Motion building animations all
 *      happen within this one tick)
 *   3. window.__pcSyncAnims() pins the currentTime of all Web Animations to the export time
 *   4. wait for media (image decode, video seek) → take the screenshot
 * After the page mounts, window.__pcReady is set to true, and the script waits for it.
 * The timeline can be specified with ?timeline=<url> (JSON), and defaults to the demo.
 */
export default function ExportView() {
  const [t, setT] = useState(0);
  const [directT, setDirectT] = useState(0);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [playToken, setPlayToken] = useState(1);
  const [frameClipIds, setFrameClipIds] = useState<Set<string> | null>(null);
  const stageRuntimeRef = useRef<{ setBundles: (bundles: readonly unknown[]) => Promise<unknown>; dispose: () => void } | null>(null);
  const scratchCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rasterCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cachedCssRef = useRef<string | null>(null);
  const projectRef = useRef<Project | null>(null);
  const timelineRef = useRef<Timeline | null>(null);
  projectRef.current = project;
  timelineRef.current = timeline;
  const renderProject = useMemo(() => !project || !frameClipIds ? project : ({ ...project,
    tracks: project.tracks.map(tr => ({ ...tr, clips: tr.clips.filter(c => (!c.cardId && !c.nodeId) || frameClipIds.has(c.id)) })),
  }), [project, frameClipIds]);
  const renderTimeline = useMemo(() => !timeline || !frameClipIds ? timeline : ({ ...timeline,
    clips: timeline.clips.filter(c => frameClipIds.has(c.id)),
  }), [timeline, frameClipIds]);
  /*
   * Shared WebGL renderer for canvas cards (R9 M2). **The export page always takes route 1**: there is
   * no parent page in the prerender process, so it holds a context itself (built lazily: only when
   * this frame really has a canvas card to draw; a pure-DOM project opens none, and the DOM does not
   * change by a single character).
   *
   * **Now drawn on the export page's main thread** (the same renderer code, the same `programs.ts`,
   * the same MSAA FBO → blit → crop bitmap), without a Worker: in a frame-controlled export page, the
   * completion event of the request for the Worker's main script is reported on the Worker's own
   * target, and `waitNet` in `server/bakery/chrome.mjs` sees it as still "in flight" in the page's
   * Network domain, waits in vain for 30 seconds on every frame and then errors out (measured).
   * The export page's main thread is not the user's interaction thread, so drawing here stalls no
   * one. After `chrome.mjs` lets `blob:` scripts through (patch: see the R9 report), adding
   * `?glWorker=1` switches to the Worker: identical pixels, since it is the same code.
   */
  const glHost = useRef<GlHost | null>(null);
  useEffect(() => {
    const worker = new URLSearchParams(location.search).get("glWorker") === "1";
    const host = createGlHost({ stageId: "export", compact: false, route: "perDocument", mainThread: !worker });
    glHost.current = host;
    return () => { host.dispose(); if (glHost.current === host) glHost.current = null; };
  }, []);
  /*
   * Emit one beat on **every frame** of the export page / prerender page (M3). Frame advance is driven
   * by the `flushSync` of `__pcSetT`, and `beat` is emitted in **that commit's layout effect**: by
   * then the registration of the gl plane (the layout effect of the child components) is already done.
   * A strict beat: if compilation or textures are not ready, wait; leave no empty frames. `glHost`
   * takes its own ticket from `beginFrameWork('gl')` and returns it on receiving `done`, so
   * `__pcFrameReady` (the `waitForFrameWork` hooked up below) naturally waits for `done` as well, and
   * the Node side waits for it as before.
   * Write no dependencies: any commit (frame change, shard window change, remount) may change which
   * frame should be drawn on the gl plane.
   */
  useLayoutEffect(() => {
    void glHost.current?.beat({ strict: true, t });
  });
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const root = document.getElementById("root");
    if (root) root.style.background = "transparent";
  }, []);

  useEffect(() => {
    const url = new URLSearchParams(location.search).get("timeline");
    (url ? fetch(url).then((r) => r.json()) : Promise.resolve(demoTimeline))
      .then(async (json: unknown) => {
        // Media stays as placeholders and is only loaded at the frame of the screenshot.
        if (json && Array.isArray((json as Project).tracks)) return CARDS_ONLY ? stripMedia(json as Project) : (json as Project);
        return json;
      })
      // Named function expression: the function body is both the assembly flow of the first load and the
      // one to rerun when switching projects. Giving it a name lets it call itself from inside (see
      // __pcLoadProject below), without having to extract this big block.
      .then(function install(json: any, options?: { deferCards?: boolean }) {
      let tl: Timeline;
      let proj: Project | null = null;
      /*
       * The whole install() computes the graph only this once; the __pcCardPlan closure below and the
       * render body both reuse it.
       * **A fallback is required**: projectCardGraph throws on a dangling input (deleting a media clip
       * that carries a filtered media effect card is such a case); if it is not caught at this level,
       * the whole stage tree unmounts and the prerender page never becomes ready.
       */
      let graph: ReturnType<typeof projectCardGraph> | undefined;

      if (json && Array.isArray(json.tracks)) {
        proj = json as Project;
        // Add the rate to media nodes of speed-change segments (withMediaRates in kernel/clipTime.mjs;
        // unchanged when there are no speed-change segments)
        try { graph = withMediaRates(proj, projectCardGraph(proj, getCard)); } catch { graph = undefined; }
        tl = flattenOverlay(proj, graph);
      } else {
        tl = json as Timeline;
      }

      setProject(proj);
      setTimeline(tl);
      setFrameClipIds(options?.deferCards ? new Set() : null);
      setT(0);
      setDirectT(0);
      window.__pcTimeline = tl;
      window.__pcCardPlan = () => {
        if (!proj) return null;
        const user = userCardSources();
        const sourceVersions: Record<string, string> = {};
        for (const card of allCards()) {
          const file = user.fileOf[card.id];
          if (file && user.files[file] !== undefined) {
            // This is the exact TSX text received from cards/index.  A user
            // edit changes the server's content key without making unrelated
            // builtin controls cold.
            sourceVersions[card.id] = `user:${cardSourceVersion(card, { ...builtinCardSourceFiles, ...user.dependencies }, `/src/cards/user/${file}.tsx`)}`;
          } else {
            // Builtins have no user-source file.  Component source plus the
            // declarative runtime contract is a stable in-process dependency
            // fingerprint and catches HMR replacement of their implementation.
            sourceVersions[card.id] = `builtin:${cardSourceVersion(card, builtinCardSourceFiles)}`;
          }
        }
        /*
         * Replace a cut segment with the cards inside it (the flattened view in `kernel/cutFlatten.mjs`):
         * cards inside a cut segment enter the card plan just like cards on the parent timeline
         * (measurement, dispatch, each producing its own single-card stream). The graph used for rendering
         * (`graph` above) is unchanged, and the picture still goes through the nested scene. A project
         * without cut segments is unchanged
         */
        const flat = flatPlanProject(proj);
        let planGraph = graph;
        if (flat !== proj) { try { planGraph = withFlatNodes(flat, withMediaRates(flat, projectCardGraph(flat, getCard))); } catch { planGraph = undefined; } }
        return { graph: planGraph ?? withMediaRates(flat, projectCardGraph(flat, getCard)), sourceVersions,
          /*
           * Card clips whose definition cannot be found in this page's registry (unknown cards; the prerender
           * process has no sync table, which amounts to "no definition"). The stage does not draw them, and
           * `CardFrameCache.plan()` accordingly gives them no control: they are not scheduled for prerender,
           * not put in the prerender set, and the layer table has no layer for them.
           * The graph itself is untouched (the keys of other cards are verbatim unchanged).
           */
          unknownClipIds: [...unknownCardClipIds(flat.tracks.flatMap((track) => track.clips))].sort(),
          environment: { width: proj.width, height: proj.height, fps: proj.fps, theme: proj.themeId,
            // I0: the set of fonts actually used when laying out this frame. The shared snapshot key needs it:
            // a machine missing fonts renders different HTML, so it cannot share a snapshot with a machine
            // that has the fonts.
            fontFingerprint: fontFingerprintOf(document.fonts as unknown as Iterable<{ family: string; status: string }>) } };
      };
      /** Clip of an audio media effect card: has a nodeId, no cardId (per H2 it does not write cardId) */
      const audioNode = (nodeId?: string) => !!nodeId && !!proj?.cardNodes?.some(node => node.id === nodeId && node.kind === 'audio');
      /*
       * Clips of audio media effect cards are excluded entirely: they have no cardId, and taking them in
       * literally gives getCard('') → fallback stateful, so an audio card spanning the whole video gets
       * counted into replayClips and every export chunk replays from frame 0.
       */
      const plannedClips = [...tl.clips, ...(proj?.tracks.filter(track => !track.hidden).flatMap(track => track.clips
        .filter(clip => clip.nodeId && !clip.cardId && !audioNode(clip.nodeId)).map(clip => ({ ...clip, cardId: '' }))) || [])];
      // Parallel export cuts only where no stateful card is mounted on both sides.
      // Only audio media effect cards that **never leave the picture** are unconditionally direct; other
      // media effect card clips are counted by their own declaration. Keeping "direct whenever there is a
      // node" would leave media effect cards that declare stateful out of the replay window in export,
      // while preview gives them a replay clock per clipFrameMode, so the two sides silently diverge in
      // timing with no error.
      window.__pcClipFrameModes = () => plannedClips.map(clip => ({ id: clip.id, start: clip.start, end: clip.end,
        mode: audioNode(clip.nodeId) ? 'direct' : clipFrameMode(clip, getCard(clip.cardId)) }));
      window.__pcPlanFrameWindow = (frames, fps) => planFrameWindow(plannedClips, frames, fps,
        clip => {
          const runtime = (proj as any)?._cardRender;
          const requested = frames.filter(frame => frame / fps >= clip.start && frame / fps < clip.end);
          if (audioNode(clip.nodeId) || requested.length && requested.every(frame => runtime?.frames?.[clip.id]?.[frame] || runtime?.missing?.[frame]?.includes(clip.id))) return 'direct';
          return clipFrameMode(clip, getCard(clip.cardId));
        });
      window.__pcExportMs = 0;
      // Drain / generate snapshots: previously injected by PAGE_PRELUDE in export-frames.mjs (now server/bakery/chrome.mjs), now part of the page bundle (J1).
      window.__bfSettle = settleDom;
      window.__pcCreateSnapshot = () => createSnapshot(document.querySelector("[data-pc-scene]"));
      // D3(c): export surface for entity geometry, used only by puppeteer-side page.evaluate (/api/cards/layout measures contentBox on the snapshot DOM); the page itself never goes through it
      window.__pcSolid = solidApi;
      window.__pcCanvasBox = solidApi.canvasPaintedBox;
      // Direct canvas read (ji-1): when producing the track stream, the prerender process asks the page for canvas pixels without going through screenshots (`server/bakery/capture-canvas.mjs`)
      (window as unknown as { __pcGrabCanvas?: typeof grabCanvasPixels }).__pcGrabCanvas = grabCanvasPixels;


      window.__pcSetT = (sec: number, directSec = sec) => {
        window.__pcExportMs = sec * 1000;
        // flushSync: same reason as __pcRestartCards below. The rendering of this frame (especially cards
        // mounting/unmounting at a clip boundary) must be committed synchronously within this call.
        // Otherwise React puts it in the scheduler, and where it lands in the next tick of virtual time
        // depends on how much real time this frame's screenshot took. Motion only builds the WAAPI
        // animation on the next rAF after the mount commits, so the animation is sometimes counted into
        // this frame and sometimes only seen by __pcSyncAnims on the next frame; the anchor is off by one
        // frame, and the whole entrance is off by one frame of phase. Measured: on the demo timeline, the
        // segment where a blur-fade card cuts in (frames 60~71), exporting twice gives all-different
        // results about half the time, and this is why. After committing synchronously, the mount lands
        // before virtual time advances, Motion builds the animation in the first rAF, and no longer
        // depends on screenshot duration.
        flushSync(() => { setT(sec); setDirectT(directSec); });

      };
      window.__pcFrameReady = waitForFrameWork;
      window.__pcFrameWorkStatus = frameWorkStatus;
      window.__pcSetFrameWindow = (clipIds, startTime, directTime = startTime) => {
        // Dispose the preceding pass before moving its clock. Mount only the
        // selected cards, with the clock already at their first replay frame.
        flushSync(() => setFrameClipIds(new Set()));
        window.__pcExportMs = startTime * 1000;
        window.__pcResetRandom?.(1);
        window.__pcResetAnims?.();
        flushSync(() => {
          setT(startTime);
          setDirectT(directTime);
          setFrameClipIds(clipIds === null ? null : new Set(clipIds));
          setPlayToken(n => n + 1);
        });
      };

      // flushSync: the remount completes synchronously within this call. Otherwise where React's
      // scheduled task lands in the next tick of virtual time differs between two exports, and the
      // card's first frame would be off by one frame.
      window.__pcRestartCards = () => {
        // Rewind the random seed to the start, then remount: random numbers drawn when a card mounts (initial particle positions and the like) are identical on every pass
        window.__pcResetRandom?.(1);
        flushSync(() => setPlayToken((n) => n + 1));
      };

      // Animation anchor: the export millisecond of the frame where each Web Animation first appears.
      // After advancing virtual time each frame, the export script calls __pcSyncAnims, pins currentTime to "now − anchor", then takes the screenshot.
      // The CSS / WAAPI animation clock is not in sync with the virtual clock, and correcting playbackRate with a measured ratio varies randomly with machine load; explicitly pinning the time is independent of load.
      let anchors = new WeakMap<Animation, number>();
      window.__pcResetAnims = () => {
        anchors = new WeakMap<Animation, number>();
      };
      // Must pause: animations such as transform / opacity run on the compositor thread, and if only
      // currentTime is set without pausing, the compositor still samples by its own clock at the
      // screenshot frame, so two exports differ by a fraction of a frame. After pausing, the value is
      // determined by currentTime alone.
      // Those past the end use finish(): Motion waits for finished before committing the final style,
      // while CSS animations return to their natural style, same as after a normal playthrough.
      // The number of animations settled by finish() in this frame. The static check must look at it:
      // an animation jumps from "a little left" to its final state in this frame, so the picture has
      // changed, but after settling, getAnimations() reports it as finished and the DOM was not
      // modified ——
      // the probe only sees "the state after ending", not "ending in this frame". Measured: the
      // type-shift outer transition happens to end on frame 6, and static skipping reused frame 5,
      // differing from not skipping by 28085 pixels.
      let finishedThisFrame = 0;
      window.__pcSyncAnims = () => {
        const now = window.__pcExportMs ?? 0;
        finishedThisFrame = 0;
        for (const a of document.getAnimations()) {
          if (a.playState === "finished" || a.playState === "idle") continue;
          let s0 = anchors.get(a);
          if (s0 === undefined) {
            s0 = now;
            anchors.set(a, s0);
          }
          const target = Math.max(0, now - s0);
          const end = a.effect?.getComputedTiming().endTime;
          if (typeof end === "number" && Number.isFinite(end) && target >= end) {
            a.finish();
            finishedThisFrame++;
            continue;
          }
          if (a.playState !== "paused") a.pause();
          a.currentTime = target;
        }
      };
      /**
       * Whether this frame's picture is still. All four conditions must hold together, since any one
       * alone would miss cases:
       *   anims —— getAnimations() only sees CSS / transitions / WAAPI;
       *   mut   —— covers the JS animations it cannot see (Motion's MotionValue, e.g. the scrolling
       *            numbers in rank-bars), and the frames right after a card remounts before its
       *            animation is built —— anims is 0 then, yet the picture is changing;
       *   raf   —— third-party loops that go through the replaced rAF. Motion never gets here (see
       *            exportClock.ts); it stays because it is free, one more layer of cover is still cover;
       *   video —— a fourth kind of change the first three cannot see: the underlying <video> is playing.
       *            It changes by itself, and the backdrop-filter frosted glass on a card samples its
       *            changes in, so even a glass panel with no animation changes frame by frame.
       * Judging static is for reusing the previous frame's screenshot, and a wrong call renders a bad
       * frame, so err on the conservative side.
       */
      window.__pcStaticProbe = () => ({
        anims: document.getAnimations().filter((a) => a.playState !== "finished" && a.playState !== "idle").length,
        finished: finishedThisFrame,
        raf: window.__pcRafCount ?? 0,
        mut: window.__pcMutationCount ?? 0,
        video: Array.from(document.querySelectorAll("video")).some((v) => {
          const s = getComputedStyle(v);
          return s.visibility !== "hidden" && parseFloat(s.opacity) > 0;
        }),
        // What is drawn on a canvas is not in the DOM and MutationObserver cannot see it; with a visible canvas we dare not judge the frame still
        canvas: Array.from(document.querySelectorAll("canvas")).some((c) => {
          const s = getComputedStyle(c);
          return s.visibility !== "hidden" && parseFloat(s.opacity) > 0 && c.width > 0 && c.height > 0;
        }),
      });
      /**
       * Swap in another project in place, without navigating again. The resident prerender process
       * reuses the same page through this: launching Chrome + goto + the first font layout add up to a
       * fixed few seconds, and paying that again on every render is too expensive.
       * It goes through install itself, the same path as reloading the page, so there are not two
       * sets of behavior.
       */
      /** Online frame-by-frame export: the editor page hands the table of synced user cards to the export page so their wrapper layers get mounted and can be swapped for the prerender's original size (`placeholderHost.exportSyncedMountFor`) */
      (window as unknown as { __pcSetSyncedUserCards?: (entries: SyncedUserCard[]) => void }).__pcSetSyncedUserCards = (entries) => {
        setSyncedUserCards(entries);
        setExportSyncedMount(true);
      };
      window.__pcLoadProject = async (raw: unknown, options?: { deferCards?: boolean }) => {
        window.__pcReady = false;
        const next = raw && Array.isArray((raw as Project).tracks)
          ? (CARDS_ONLY ? stripMedia(raw as Project) : (raw as Project))
          : raw;
        install(next, options);
      };

      window.__pcReady = true;
    });
  }, []);

  useEffect(() => {
    const stageRaf = (): Promise<void> => {
      const begin = (window as unknown as { __pcBrowserBeginFrame?: () => number }).__pcBrowserBeginFrame;
      if (typeof begin === "function") {
        begin();
        return new Promise((resolve) => setTimeout(resolve, 0));
      }
      const raf = (window as unknown as { __pcRealRaf?: (cb: FrameRequestCallback) => number }).__pcRealRaf ?? window.requestAnimationFrame.bind(window);
      return new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        raf(() => finish());
        setTimeout(finish, 250);
      });
    };

    const stageSettle = async () => {
      await window.__bfSettle?.();
    };

    const stageStepTo = async (frame: number, fps: number) => {
      const sec = frame / fps;
      window.__pcHideFrameMedia?.();
      window.__pcSetT!(sec, sec);
      await stageSettle();
      await stageRaf();
      await stageSettle();
      window.__pcSyncAnims?.();
      await stageSettle();
      const probe = window.__pcStaticProbe?.();
      if (probe?.finished) {
        for (let pass = 0; pass < 2; pass++) {
          await stageRaf();
          await stageSettle();
          window.__pcSyncAnims?.();
          await stageSettle();
        }
      }
      await window.__pcFrameReady?.();
      await document.fonts.ready;
      await stageRaf();
      await stageRaf();
      await stageSettle();
      window.__pcSyncAnims?.();
    };

    const stageWarmUp = async (startFrame: number, fps: number) => {
      const sec = startFrame / fps;
      window.__pcSetFrameWindow?.(null, sec, sec);
      for (let i = 0; i < 3; i++) {
        await stageStepTo(startFrame, fps);
        await stageRaf();
      }
      window.__pcRestartCards?.();
      window.__pcResetAnims?.();
      await stageStepTo(startFrame, fps);
      await stageRaf();
      window.__pcResetAnims?.();
    };

    const renderFrameToBitmap = async (
      frame: number,
      fps: number,
      layers?: FrameLayer[],
      freshTicket?: string | null,
      background = "#000",
    ): Promise<{ bitmap: ImageBitmap; stats: Record<string, number> }> => {
      const stats = { stepMs: 0, snapshotMs: 0, mediaMs: 0, rasterMs: 0, mediaFrames: 0, ticketSwaps: 0 };
      let t0 = performance.now();
      await stageStepTo(frame, fps);
      stats.stepMs = performance.now() - t0;

      const has3DCut = !!document.querySelector("canvas[data-pc-3d-cut]");
      if (has3DCut) {
        const offMedia = [...document.querySelectorAll<HTMLVideoElement | HTMLImageElement>("[data-pc-3d-offscreen] video[data-pc-media-src], [data-pc-3d-offscreen] img[data-pc-media-src]")];
        if (offMedia.length) {
          for (const el of offMedia) if (!el.crossOrigin) el.crossOrigin = "anonymous";
          if (freshTicket) {
            for (const el of offMedia) {
              const src = el.getAttribute("data-pc-media-src") ?? "";
              const next = withTicket(src, freshTicket);
              if (next !== src) {
                el.setAttribute("data-pc-media-src", next);
                stats.ticketSwaps++;
              }
            }
          }
          await window.__pcPrepareFrameMedia?.();
        }
        await window.__pcRender3DCut?.();
      }

      t0 = performance.now();
      const snap = window.__pcCreateSnapshot!();
      if (snap.lossy) throw new Error(trText("This frame has a canvas whose pixels can't be read, so it can't be exported"));
      const tpl = document.createElement("template");
      tpl.innerHTML = snap.html;
      stats.snapshotMs = performance.now() - t0;

      if (layers && layers.length > 0) {
        const wraps = new Map<string, HTMLElement>();
        for (const wrap of tpl.content.querySelectorAll<HTMLElement>("[data-pc-clip]")) {
          if (wrap.hasAttribute("data-pc-media")) continue;
          const id = wrap.getAttribute("data-pc-clip")!;
          if (!wraps.has(id)) wraps.set(id, wrap);
        }
        for (const layer of layers) {
          const wrap = wraps.get(layer.clipId);
          if (wrap && pasteLayer(wrap, layer)) {
            // pasted layer
          }
        }
      }

      t0 = performance.now();
      const live = [...document.querySelectorAll<HTMLVideoElement | HTMLImageElement>("[data-pc-scene] video[data-pc-media-src], [data-pc-scene] img[data-pc-media-src]")]
        .filter((el) => !el.closest("[data-pc-3d-offscreen]"));
      const holes = [...tpl.content.querySelectorAll<HTMLElement>("video[data-pc-media-src], img[data-pc-media-src]")];
      if (live.length) {
        for (const el of live) if (!el.crossOrigin) el.crossOrigin = "anonymous";
        if (freshTicket) {
          for (const el of live) {
            const src = el.getAttribute("data-pc-media-src") ?? "";
            const next = withTicket(src, freshTicket);
            if (next !== src) {
              el.setAttribute("data-pc-media-src", next);
              stats.ticketSwaps++;
            }
          }
        }
        await window.__pcPrepareFrameMedia?.();
        scratchCanvasRef.current ??= document.createElement("canvas");
        holes.forEach((hole, i) => {
          const el = live[i];
          if (!el || !tpl.content.contains(hole)) return;
          const shown = el.style.visibility !== "hidden" && hole.getAttribute("data-pc-media-hidden") !== "true";
          const url = shown ? mediaFrameUrl(el, scratchCanvasRef.current!) : null;
          const img = document.createElement("img");
          for (const attr of [...hole.attributes]) {
            if (attr.name !== "src" && !attr.name.startsWith("data-pc-media")) img.setAttribute(attr.name, attr.value);
          }
          img.style.visibility = url ? "visible" : "hidden";
          if (url) {
            img.setAttribute("src", url);
            stats.mediaFrames++;
          }
          hole.replaceWith(img);
        });
        window.__pcHideFrameMedia?.();
      } else if (has3DCut) {
        window.__pcHideFrameMedia?.();
      }
      stats.mediaMs = performance.now() - t0;

      t0 = performance.now();
      cachedCssRef.current ??= pageCssText(document);
      const p = projectRef.current;
      const width = p?.width ?? timelineRef.current?.width ?? 1920;
      const height = p?.height ?? timelineRef.current?.height ?? 1080;
      const svg = sceneToSvg(tpl.content.childNodes, width, height, cachedCssRef.current);
      const img = new Image();
      img.decoding = "sync";
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
      await img.decode();
      rasterCanvasRef.current ??= document.createElement("canvas");
      rasterCanvasRef.current.width = width;
      rasterCanvasRef.current.height = height;
      const ctx = rasterCanvasRef.current.getContext("2d", { alpha: false, willReadFrequently: true })!;
      ctx.fillStyle = background ?? "#000";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      const bitmap = await createImageBitmap(rasterCanvasRef.current);
      stats.rasterMs = performance.now() - t0;

      return { bitmap, stats };
    };

    const onMessage = async (ev: MessageEvent) => {
      const data = ev.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "pc-export-ping") {
        if (window.__pcReady) {
          try {
            (ev.source as any)?.postMessage({ type: "pc-export-ready" }, "*");
          } catch { /* ignore */ }
        }
        return;
      }
      if (typeof data.id !== "number") return;
      const id = data.id;
      const reply = (res: Record<string, unknown>, transfer?: Transferable[]) => {
        try {
          if (transfer && transfer.length) {
            (ev.source as any)?.postMessage({ id, ...res }, "*", transfer);
          } else {
            (ev.source as any)?.postMessage({ id, ...res }, "*");
          }
        } catch { /* ignore */ }
      };
      const replyErr = (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        reply({ error: msg });
      };

      if (data.type === "pc-export-init") {
        try {
          markIsolatedStageDocument();
          noteMediaPolicy({ ticket: null, cardExec: true });
          // Wait for the stage self-check result, at most 10 seconds (real time: the export page's performance.now / Date.now are pinned by the export clock, `export/realClock.ts`).
          // Only documents with stage hardening installed (stage.html from the online build) have a self-check result; the export page in the desktop app and on the dev server has no self-check, the gate stays at checking, so do not wait
          if (stageGuardBooted() && cardExecGate().reason === "checking") {
            await waitReal(() => cardExecGate().reason !== "checking", EXPORT_GATE_WAIT_MS);
          }
          if (data.syncedCards && Array.isArray(data.syncedCards)) {
            setSyncedUserCards(data.syncedCards);
            setExportSyncedMount(true);
          }
          if (data.cardSources && Array.isArray(data.cardSources.entries) && data.cardSources.entries.length > 0) {
            const { bundleCards } = await import("./online/cardRuntime/transpile.browser");
            const read = (key: string) => data.cardSources?.files?.[key] ?? null;
            const bundleResults = await bundleCards({ entries: data.cardSources.entries, read });
            const list = bundleResults.filter((b): b is Extract<typeof b, { ok: true }> => b.ok).map((b) => b.bundle);
            const mod = "stage" + "Runtime";
            const m = (await import(`./online/cardRuntime/${mod}.ts`)) as {
              createStageCardRuntime: (opts?: Record<string, unknown>) => {
                setBundles: (bundles: readonly unknown[]) => Promise<unknown>;
                dispose: () => void;
              };
            };
            stageRuntimeRef.current ??= m.createStageCardRuntime({
              longSide: () => Math.max(data.project?.width ?? 1920, data.project?.height ?? 1080),
            });
            await stageRuntimeRef.current.setBundles(list);
          }
          await window.__pcLoadProject!(data.project);
          if (!(await waitReal(() => !!window.__pcReady && typeof window.__pcSetT === "function", EXPORT_LOAD_WAIT_MS))) {
            throw new Error(trText("Timed out assembling the project on the export stage"));
          }
          reply({ type: "pc-export-init-result", ok: true });
        } catch (e) {
          replyErr(e);
        }
        return;
      }

      if (data.type === "pc-export-warmup") {
        try {
          const { startFrame, fps } = data;
          await stageWarmUp(startFrame, fps);
          reply({ type: "pc-export-warmup-result", ok: true });
        } catch (e) {
          replyErr(e);
        }
        return;
      }

      if (data.type === "pc-export-render-frame") {
        try {
          const { frame, fps, layers, freshTicket, background } = data;
          const { bitmap, stats } = await renderFrameToBitmap(frame, fps, layers, freshTicket, background);
          reply({ type: "pc-export-frame-result", frame, bitmap, stats }, [bitmap]);
        } catch (e) {
          replyErr(e);
        }
        return;
      }

      if (data.type === "pc-export-close") {
        try {
          stageRuntimeRef.current?.dispose();
          stageRuntimeRef.current = null;
        } catch { /* ignore */ }
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      stageRuntimeRef.current?.dispose();
      stageRuntimeRef.current = null;
    };
  }, []);

  if (!timeline) return null;

  return (
    <div
      data-pc-scene=""
      style={{
        position: "relative",
        width: timeline.width,
        height: timeline.height,
        overflow: "hidden",
        background: "transparent",
        /*
         * **The theme variables must be attached here**, aligned with the one in StageView.
         *
         * Without it, every `var(--pc-…, fallback)` in a card takes the fallback in export, while preview
         * uses the theme value. Under the default theme most fallbacks happen to equal the theme values,
         * so this gap went unnoticed for a long time; only the monospace font gave it away: the theme is
         * `ui-monospace, Consolas, monospace` and the fallback is `ui-monospace, monospace`, which on
         * Windows lands on NSimSun —— in preview it is Consolas with the slashed zero, in the final video
         * it is a set of serif glyphs. Switch to another theme (say the Courier New one, or anything that
         * changed the colors) and everything is inconsistent across the board.
         */
        ...themeStyle(timeline.themeId),
      }}
    >
      {renderProject ? <FrameScene project={renderProject} sourceProject={project!} t={t} directT={directT} playToken={playToken} graph={timeline.graph} />
        : <Stage timeline={renderTimeline!} t={t} directT={directT} playToken={playToken} mountClock />}

    </div>
  );
}

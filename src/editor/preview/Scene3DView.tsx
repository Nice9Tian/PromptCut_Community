import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { Stage } from "../../render/Stage";
import { isCaptionClip } from "../../kernel/captions";
import type { Timeline } from "../../kernel/types";
import { useBakePrefetch, beginForegroundBake, endForegroundBake, canonFrameT } from "./useBakePrefetch";
import { clipFingerprint, markBaked, momentId } from "./bakeCoverage";
import { measureImageBox, worthCropping } from "./alphaBox";
import { activeCutKind, cardOpacityAt, flattenBoards3D, isImageMedia, MEDIA_BOARD_CARD, opacityAt, type Board3DClip, type Project, type TrackClip } from "../../kernel/project";
import { CUT_SEGMENT_CARD, cutOf } from "../../kernel/cutSegments";
import { placeClip3D, sortBoardsByDepth, type SortableBoard3D } from "./place3d";
import { cameraFrustum3D, frustum2d } from "./frustum2d";
import { resolveClipFrameAt } from "../../kernel/frameExpr.mjs";
import { activeCutEntry, defaultCutFovDeg, resolveCamera3DAt } from "../../kernel/camera.mjs";
import { clipSpeed } from "../../kernel/clipTime.mjs";
import { clipFilterOpsAt, cssFilter } from "../../kernel/filters.mjs";
import { emphasisFilter } from "../../kernel/emphasis";
import { driveMedia, filterOf, releaseMedia, targetTimeOf } from "../../render/mediaDrive";
import { playbackUrl } from "../../render/mediaTier";
import { tierHashes } from "../media/assetTiers";
import { getCard } from "../../kernel/registry";
import { actions, useStore } from "../../store/project";
import {
  addLights, applyTexture, geometryOf, materialOf, poseMesh, radiusFor, shapeOf,
  type Scene3DParams,
} from "../../cards/native/scene3dObject";
import {
  boardNearDistance,
  cameraFor,
  DEFAULT_FOV_DEG,
  isBoardBehindCamera,
  type BoardSubBox,
  type CameraPose3D,
} from "../../kernel/space3d";
import { motionOf, pickBakeT, sampleTimesFor, texKeyOf, type TimedClip } from "./bakeTime";
import { isScrubbing, subscribeScrub } from "../timeline/useScrub";
import { ONLINE } from "../../online/mode";
import { StreamPlayer, PushedStreamSource, type StreamPlaneRequest } from "../../render/streamPlayer";
import { isStreamOrigin } from "../../render/streamSegments.mjs";
import { currentReadyIndex } from "../snapshotFeed";
import { setPlan3DView } from "../planDispatch";
// The checkerboard background and overlay styles live here (.pc-3d-checker / .pc-3d-note). Import them here ourselves, don't count on the parent component to import them
import "./preview.css";
import { tr } from "../../i18n/index.ts";

/**
 * 3D view: treats every card in the picture at this moment as a **board standing in space**, which
 * you can orbit around like in Blender.
 *
 * # How it differs from the 2D view
 *
 * The 2D view's contract is "what the preview shows = what the export gives": that is **what the
 * final video looks like**.
 * This view answers a different question: **how these things are arranged in space**. So it doesn't
 * aim for pixel-level equality;
 * it aims to make "the front/back order, tilt and spacing between layers visible at a glance". The
 * camera can turn freely; this was never the final video's camera position.
 *
 * # What is pasted on a board is the real prerendered image, not a redraw
 *
 * Each board's texture comes from `/api/vision/bake-batch`, and what draws images on that path is
 * the same renderer that exports the final video.
 * So the content on a board and the content in the final video are **the same pixels**, and cards
 * are not implemented a second time here.
 * Implementing it a second time would mean opening another path that can diverge. The cost of that
 * kind of divergence in this project is written at the top of vite-plugin-vision.ts.
 *
 * # 3D cards here are **truly 3D**
 *
 * Cards like `scene-3d` that are solid objects themselves don't take the "textured flat board"
 * path. It started out that way,
 * and when you orbited it was still a flat picture, while the whole reason this view exists is
 * "to see clearly how things are arranged in space".
 * Now the object is built right here with the same geometry construction the card uses
 * (`cards/native/scene3dObject.ts`), and even the lighting presets are the same copy.
 * Only by sharing one construction on both sides do we avoid "what you see in the inspection isn't
 * the same thing as in the final video".
 *
 * # Proxy swatches are only a transition
 *
 * Until the texture arrives, a semi-transparent swatch is drawn as a placeholder, and **it is
 * swapped out as soon as the render is done**.
 * Prerender is cached by input (see bakeOne): the same card with the same parameters is really
 * rendered only once, and opening this view afterwards costs nothing.
 * So normally what you see is always the real texture; the swatch appears only the first time, or
 * for a few seconds right after a card was edited.
 */

type ThreeMod = typeof import("three");
type OrbitMod = typeof import("three/examples/jsm/controls/OrbitControls.js");

let modsPromise: Promise<[ThreeMod, OrbitMod]> | null = null;
/** three and OrbitControls are only downloaded when the 3D tab is really opened */
const loadMods = (): Promise<[ThreeMod, OrbitMod]> =>
  (modsPromise ??= Promise.all([
    import("three"),
    import("three/examples/jsm/controls/OrbitControls.js"),
  ]));

/** Placeholder color when there is no texture. Semi-transparent, so you can tell at a glance "this one is still rendering" */
const PROXY_COLOR = 0x64748b;
const PROXY_OPACITY = 0.45;

/**
 * URL → already-decoded texture. **Reused across scene rebuilds.**
 *
 * # Why it exists: a swatch flashes at the boundary between two cards
 *
 * The scene's rebuild key `sig` is "which cards are in the picture right now", so **every time the
 * playhead crosses a card boundary** the whole scene is rebuilt, and every board is a new mesh +
 * a new material. And `applyTexture` always goes through
 * `new THREE.TextureLoader().load(url)`: even if this image was just applied and is hot in the HTTP
 * cache, decoding is still asynchronous. So the new board first appears as a PROXY_COLOR swatch,
 * and the texture comes back one or two frames later.
 * What the user sees is "solid mode suddenly flashes between two cards", when in fact nothing was
 * missing; it was just decoded again.
 *
 * Once the decoded result is stored, the texture that hits on a rebuild is **applied in the same
 * frame**, with no swatch in between.
 *
 * # Why there is a cap, and why eviction has to skip the ones in use
 *
 * A 1920×1080 texture takes about 8MB of video memory, and prerender renders hundreds of moments:
 * with no cap, the user dragging the timeline from start to end can blow up video memory. Besides
 * the cap there is another rule: **the textures currently on boards are never evicted**;
 * if eviction disposes a texture still attached to material.map, that board turns black outright,
 * and no error is reported.
 */
const TEX_CACHE_MAX = 12;
const texCache = new Map<string, any>();
/** The URLs really attached to boards right now. Eviction has to avoid them */
const texInUse = new Set<string>();

function cacheTexture(url: string, tex: any) {
  // Map keeps insertion order, so setting again moves the entry to the tail: the least recently used is at the head
  texCache.delete(url);
  texCache.set(url, tex);
  for (const k of [...texCache.keys()]) {
    if (texCache.size <= TEX_CACHE_MAX) break;
    if (texInUse.has(k)) continue;
    texCache.get(k)?.dispose?.();
    texCache.delete(k);
  }
}

interface Props {
  project: Project;
  /** Current moment on the timeline (seconds) */
  t: number;
  /** `"camera"` renders through the cut's active 3D output camera; `"space"` enables OrbitControls inspection with camera frustum gizmo. */
  mode?: "camera" | "space";
  /** Invoked when clicking the active 3D camera gizmo in `"space"` mode. */
  onSelectCamera?: (cameraId: string) => void;
}

export function Scene3DView({ project, t, mode = "space", onSelectCamera }: Props) {
  const outerRef = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const captionOverlayRef = useRef<HTMLDivElement>(null);
  const streamHost = useRef<HTMLDivElement>(null);
  const mediaHost = useRef<HTMLDivElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const onSelectCameraRef = useRef(onSelectCamera);
  onSelectCameraRef.current = onSelectCamera;
  const selected = useStore((s) => s.selection[0]);
  const playing = useStore((s) => s.playing);
  const playingRef = useRef(playing);
  playingRef.current = playing;

  useEffect(() => {
    setPlan3DView(true);
    return () => setPlan3DView(false);
  }, []);
  const [mods, setMods] = useState<[ThreeMod, OrbitMod] | null>(null);
  const [pending, setPending] = useState(0);
  /**
   * Which moment is being rendered. A value = the boards currently show **swatches**, and the image
   * for this moment is not rendered yet.
   * We spell it out because the worst part of the original bug wasn't slowness, it was
   * **silently showing a different moment**:
   * the UI says 0.2 seconds, the board shows the picture at 1.0 seconds, with no hint at all.
   */
  const [bakingAt, setBakingAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /**
   * Whether to show the "2D view frame". Off by default: most of the time the user is here to see how
   * cards are arranged,
   * and an extra set of lines only blocks the view; turn it on when judging "is this card in the
   * picture or not".
   *
   * It goes through a ref because the effect that builds the scene must not have it as a dependency:
   * with it in, clicking the button would rebuild the whole scene.
   * Visibility is toggled by the render loop reading this ref every frame (same approach as the
   * selection outline selRef).
   */
  const [frustumOn, setFrustumOn] = useState(false);
  const [spaceGizmoHidden, setSpaceGizmoHidden] = useState(false);
  const frustumRef = useRef(frustumOn);
  frustumRef.current = frustumOn;
  const spaceGizmoHiddenRef = useRef(spaceGizmoHidden);
  spaceGizmoHiddenRef.current = spaceGizmoHidden;
  const selectedCameraId = useStore((s) => (s as any).selectedCameraId as string | null | undefined);
  const selectedCameraRef = useRef(selectedCameraId ?? null);
  selectedCameraRef.current = selectedCameraId ?? null;
  /*
   * Fingerprint of "what this card looks like", carrying only what **determines pixels**: which card,
   * what parameters, how big the canvas is.
   * It carries no identity information beyond clipId and no moment either: it governs **whether to
   * rebuild the scene**, not which image to apply.
   *
   * Using clipId alone has two faults: across projects clipId repeats (they are all c1 / n1 and the
   * like), so a new project would see the previous project's texture; and after card parameters
   * change while clipId stays the same, the texture doesn't update either, and the picture stays in
   * the old look with no error.
   *
   * Position and 3D transforms are not in it: when the server prerenders it strips the whole frame
   * (see the note on bakeOne), so rotating a card or pushing its depth doesn't change a single pixel
   * of the texture. The consequence of stuffing the whole frame in is:
   * dragging a slider in the "3D" panel counts every step as changed, so the scene is rebuilt on
   * every step.
   */
  // There is only one implementation of the fingerprint (bakeCoverage.clipFingerprint): the progress bar
  // uses the same one to judge "does this stretch of coverage still count". If each side had its own, you would get "the bar says it is still valid, but the picture has already changed", with no error.
  const texKey = clipFingerprint;
  /**
   * Fingerprint of whether to **rebuild the whole scene**. It carries only what really determines
   * **geometry**:
   * which cards, what kind of card each is, how big the boards are. `scene-3d` also carries params:
   * its geometry
   * (shape, radius) is computed from the parameters; the board of a 2D card is just a PlaneGeometry,
   * independent of params.
   *
   * **The params of 2D cards are deliberately not in it.** They only decide what the texture looks
   * like, and swapping a texture goes through the
   * `swap` / `proxy` path, which only changes material.map and needs no rebuild.
   *
   * The consequence of including them was measured: dragging a slider once fires a dozen-plus
   * changes in a row, and the **whole scene is rebuilt a dozen-plus times**:
   * every time a new WebGLRenderer is created and the old one is dropped with forceContextLoss (the
   * browser limit is about 16, and beyond that it silently drops the oldest). What the user sees is
   * the picture freezing, and no feedback after editing for ages.
   */
  const buildKey = (c: { id: string; cardId: string; params?: unknown; frame?: { w?: number; h?: number } | null }) => {
    const box = `${c.frame?.w ?? "-"}x${c.frame?.h ?? "-"}`;
    return c.cardId === "scene-3d"
      ? [c.id, c.cardId, box, JSON.stringify(c.params ?? {})].join("|")
      : [c.id, c.cardId, box].join("|");
  };
  /**
   * **The moment under the playhead**: which prerendered image to show, and that image's cache key.
   *
   * There used to be only one answer here: the clip midpoint. So any animated card shown in 3D was
   * not showing the current moment: mu-number-ticker (rolls for 1.6 seconds) placed at [0,2], with
   * the playhead at 0.23 seconds, is at 81% in 2D and 100% in 3D. Whoever was positioning things was
   * looking at a frame from a different moment, and no error was raised. The rule for picking the
   * moment is in bakeTime.ts.
   */
  /*
   * Use the native-frame-rate image if there is one; only fall back to the low-frame-rate tier
   * when there isn't.
   *
   * Without this choice, the hundreds of per-frame prerendered images **would never be shown**:
   * the display side only ever asks for the 0.25-second slot, so rendering more is wasted work.
   *
   * Falling back to the low frame rate still keeps the original rule: `pickBakeT` only goes
   * backwards (floor), so what you see is always a moment that **has already happened**, at most
   * 0.25 seconds off, and never shows a frame that has not been played yet.
   */
  const clipMotionOf = (c: TimedClip) =>
    c.cardId === CUT_SEGMENT_CARD || cutOf(c)
      ? { settleMs: 0, after: "evolve" as const }
      : motionOf(getCard(c.cardId) as any, c.params);
  /** The **native-frame-rate** slot for the playhead's current moment: the frame that will actually appear in the final video */
  const fineTOf = (c: TimedClip) => {
    const motion = clipMotionOf(c);
    const fps = Math.max(1, projRef.current.fps || 30);
    return canonFrameT(pickBakeT(c, motion, t, { stepSec: 1 / fps }), c.start, fps);
  };
  const bakeTOf = (c: TimedClip) => {
    const fine = fineTOf(c);
    if (moments.current.has(texKeyOf(c, fine))) return fine;
    const motion = clipMotionOf(c);
    const fps = Math.max(1, projRef.current.fps || 30);
    return canonFrameT(pickBakeT(c, motion, t), c.start, fps);
  };
  const momentKey = (c: TimedClip) => texKeyOf(c, bakeTOf(c));
  /*
   * Whether the playhead has **stopped**. Stopped = the user is looking at this frame, so it is
   * worth rendering that exact frame.
   *
   * Why this split exists: the coarse tier (the yellow bar) is a stand-in with one slot per 0.25
   * seconds, and it pays off while dragging: one image covers a whole region, so dragging past does
   * not need a render at every position (four or five seconds per image). But once the playhead
   * stops it is not enough: measured with the playhead stopped on frame 121, 3D wants frame 120,
   * a full frame away from 2D. No top-up while dragging (saves rendering), top up once stopped
   * (accuracy needed), so both ends are covered.
   */
  /*
   * +1 every time a foreground render succeeds. **Only success counts.**
   *
   * It is needed because momentSig cannot detect this: the texture cache is a ref, and after the
   * coarse image lands, momentSig does not change at all (bakeTOf returns the same coarse moment
   * before and after), so the effect does not rerun, and the "stopped, so retry the exact frame via
   * prerender" path below is never reached. Failures do not count to avoid an infinite loop: after a
   * failure, what needs rendering is still the same images, and counting would retry forever.
   */
  const [bakeGen, setBakeGen] = useState(0);
  /**
   * Whether the hand is still pressing on the playhead (see isScrubbing in timeline/useScrub).
   *
   * **While pressed, render nothing.** During a drag the playhead switches moment every time it
   * crosses a 0.25-second slot, so holding and dragging across produces a string of foreground
   * renders, each of which occupies a Chrome for several seconds, and all of them render positions
   * the user just flashed past without stopping to look. When the user finally releases and stops
   * somewhere, the image they want ends up queued behind this pile of doomed work.
   *
   * It uses the "release" event rather than debouncing for N milliseconds: release is explicit, with
   * no guessing how long counts as stopped; and clicking the ruler to jump (press and release at
   * once) does not wait an extra beat because of it.
   */
  const scrubbing = useSyncExternalStore(subscribeScrub, isScrubbing, isScrubbing);
  const scrubbingRef = useRef(scrubbing);
  scrubbingRef.current = scrubbing;
  const [parked, setParked] = useState(false);
  useEffect(() => {
    setParked(false);
    // While the hand is still pressed it does not count as "stopped": then even the coarse image should not be rendered, let alone the exact-frame top-up
    if (scrubbing) return;
    const id = setTimeout(() => setParked(true), 500);
    return () => clearTimeout(id);
  }, [t, scrubbing]);
  /**
   * Textures stored by **moment**: `texKeyOf(clip, that moment)` → URL. Both images rendered live in
   * the foreground and images fetched from prerender go in here, and one key maps to exactly one
   * image, so "which moment is actually on the board" is always well defined.
   *
   * The only image that appears on a board is one in this table whose key is exactly the current
   * `momentKey(clip)`. Nothing else is applied: see the apply note below: applying a real frame from
   * another moment is much worse than applying a placeholder block.
   */
  const moments = useRef(new Map<string, string>());
  /** The scene set, like the scene-3d card, must be disposed explicitly: WebGL resources are not managed by the GC */
  const gl = useRef<{ dispose: () => void; render: () => void; syncSize: () => void } | null>(null);
  useEffect(() => {
    gl.current?.syncSize();
    gl.current?.render();
  }, [mode]);
  /**
   * Lets a texture be swapped in immediately once it is ready: clipId → swap function.
   *
   * The second argument means "this image really is the moment that should be shown now". **Anything
   * without this flag never goes on the board**: the caller must reconcile first by itself, and
   * cannot count on "any image is better than a placeholder block".
   */
  const swap = useRef(new Map<string, (url: string, precise?: boolean) => void>());
  /** Reset the board to a placeholder block: clipId → reset function. When it moves to a moment that was never rendered, go back at once, and do not keep the old image posing as current */
  const proxy = useRef(new Map<string, () => void>());
  /** 3D objects need to be posed by t every frame (the spinning kind). Called in the render loop, so it must read the latest t */
  const posers = useRef<((t: number) => void)[]>([]);
  /**
   * Where the user has rotated to. **Preserved across scene rebuilds**: this is the fix for "dragging the
   * timeline snaps the camera back".
   *
   * The effect that builds the scene depends on `sig`, and `sig` is computed from "which cards exist at
   * **this moment**". `t` is deliberately left out of the dependencies, but `sig` **changes indirectly
   * with time**: drag across any clip boundary and the set of active cards changes, so the whole effect
   * reruns, and `new PerspectiveCamera` + `new OrbitControls` reset the camera to its default position.
   * The view the user just set up is lost as soon as they drag the progress bar.
   *
   * It lives in a ref instead of state: it changes on every drag, and putting it in state would trigger
   * re-renders, while the value is only read once, at the moment the scene is rebuilt.
   */
  const pose = useRef<{ pos: [number, number, number]; target: [number, number, number] } | null>(null);
  const tRef = useRef(t);
  tRef.current = t;
  // A selection change should not rebuild the scene (rebuild = reload all textures), so it goes through a ref too
  const selRef = useRef(selected);
  selRef.current = selected;
  /*
   * Placement is read from the latest project every frame, and is not in the dependencies of the
   * effect that builds the scene.
   * Otherwise, dragging a slider in the "3D" panel would rebuild the whole scene each time (all
   * geometry rebuilt, all textures reloaded), and a drag is continuous: dozens of rebuilds per drag.
   */
  const projRef = useRef(project);
  projRef.current = project;
  /*
   * Which moments of the whole video to prerender. **Sampled at each card's own animation rhythm**
   * (sampleTimesFor), not one midpoint image per clip: the midpoint image is mostly not the moment
   * the user is looking at, and that is exactly the root cause of "3D does not show the current
   * frame".
   *
   * Computed only once (not recomputed while the project is unchanged): this list is used in every
   * scheduling round, and it depends only on the project content, not on the playhead. The playhead
   * only decides **which one to render first**, and that is bakePlan's job.
   */
  const effFrameAt = (c: { start: number; end: number; frame?: Board3DClip["frame"]; frameExpr?: Board3DClip["frameExpr"] }, atT: number) =>
    c.frameExpr
      ? resolveClipFrameAt(c.frame, c.frameExpr, Math.max(0, atT - c.start), c.end - c.start)
      : c.frame;

  const wantedMoments = useMemo(() => {
    const out: { clipId: string; t: number; start: number; end: number; tier: "coarse" | "full"; fine: boolean }[] = [];
    const fps = Math.max(1, project.fps || 30);
    const stageSize = { width: project.width, height: project.height };
    const cutEntry = activeCutEntry(project);
    const defFov = defaultCutFovDeg(project, cutEntry);
    const hasMovingCam = Boolean(cutEntry?.cameras?.length);
    for (const c of flattenBoards3D(project)) {
      // Media clips are live/decoded bitmaps, scene-3d is real geometry, and statically culled boards are skipped
      if (c.cardId === MEDIA_BOARD_CARD || c.cardId === "scene-3d") continue;
      if (!c.frameExpr && !hasMovingCam && isBoardBehindCamera(c.frame, stageSize, defFov)) continue;
      const motion = clipMotionOf(c as TimedClip);
      const seg = cutOf(c);
      const visStart = seg ? seg.from : c.start;
      const visEnd = seg ? Math.min(c.end, c.start + Math.max(0, seg.duration - seg.offset)) : c.end;
      if (!(visEnd > visStart)) continue;
      /*
       * Deduplicate by the **quantized moment**: a point like 0.5 seconds lies on the slots of both
       * tiers, and without deduplication it would be queued twice, and the server computes the same key
       * anyway, so asking twice is wasted.
       */
      const slots = new Map<number, { t: number; tier: "coarse" | "full"; fine: boolean }>();
      // Low-frame-rate tier (one slot per 0.25 seconds): first cover the whole video with it, at a cost of only a fraction of the native frame rate
      for (const raw of sampleTimesFor(c as TimedClip, motion)) {
        if (raw < visStart - 1e-6 || raw >= visEnd) continue;
        const qt = canonFrameT(raw, c.start, fps);
        slots.set(qt, { t: qt, tier: "coarse", fine: false });
      }
      /*
       * Native-frame-rate tier: frame by frame. **It is only rendered after the low-frame-rate tier has
       * been fully laid out** (the order is set by bakePlan). maxPerClip is given by this clip's own
       * frame count, not the default 12: that default was set for the low frame rate, and using it to
       * limit the per-frame tier would thin a two-second card down to 12 images, which is no longer the
       * native frame rate.
       */
      const frames = Math.ceil((c.end - c.start) * fps) + 2;
      for (const raw of sampleTimesFor(c as TimedClip, motion, { stepSec: 1 / fps, maxPerClip: frames })) {
        if (raw < visStart - 1e-6 || raw >= visEnd) continue;
        const qt = canonFrameT(raw, c.start, fps);
        const had = slots.get(qt);
        // Both tiers land on this moment: for queueing it counts as low frame rate (rendered first), but it is also one slot of the per-frame tier
        if (had) had.fine = true;
        else slots.set(qt, { t: qt, tier: "full", fine: true });
      }
      for (const s of slots.values()) out.push({ clipId: c.id, start: visStart, end: visEnd, ...s });
    }
    return out;
  }, [project]);
  /*
   * Render these moments ahead of time when idle (queueing rules in bakePlan.ts).
   * Only enabled while this view is mounted: prerendering one image launches a Chrome and takes
   * four or five seconds, and people who have not opened the 3D tab should not keep paying for it.
   */
  const prefetch = useBakePrefetch({ project, t, moments: wantedMoments, enabled: !playing });

  useEffect(() => {
    let dead = false;
    loadMods().then((m) => { if (!dead) setMods(m); }).catch((e) => setErr(String(e?.message || e)));
    return () => { dead = true; };
  }, []);

  const allBoards = useMemo(() => flattenBoards3D(project), [project]);
  const active = allBoards.filter((c) => t >= c.start && t < c.end);
  const sig = active.map(buildKey).join("|");
  const momentSig = active.filter((c) => c.cardId !== MEDIA_BOARD_CARD).map(momentKey).join("|");
  const stageSizeNow = { width: project.width, height: project.height };
  const activeCutNow = activeCutEntry(project);
  const defFovNow = defaultCutFovDeg(project, activeCutNow);
  const cam3dNow = resolveCamera3DAt(activeCutNow?.cameras, stageSizeNow, t, defFovNow);
  const culledSig = active
    .map((c) => (isBoardBehindCamera(effFrameAt(c, t), stageSizeNow, cam3dNow.fovDeg, { position: cam3dNow.position, forward: cam3dNow.forward, near: cam3dNow.near }) ? "1" : "0"))
    .join("");

  /* ── Build the scene ───────────────────────────────────────────── */
  useEffect(() => {
    const el = host.current;
    if (!mods || !el) return;
    const [THREE, { OrbitControls }] = mods;
    const outerEl = outerRef.current || el;
    const w = Math.max(1, el.clientWidth || outerEl.clientWidth);
    const h = Math.max(1, el.clientHeight || outerEl.clientHeight);
    const stage = { width: project.width, height: project.height };
    const initDefFov = defaultCutFovDeg(project, activeCutEntry(project));

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
    renderer.domElement.style.cssText = "display:block;width:100%;height:100%";
    el.replaceChildren(renderer.domElement);

    const scene = new THREE.Scene();
    /*
     * The camera's **initial** position is the final video's camera position (the space3d one), so what
     * you see on open matches the 2D view; after that OrbitControls lets you rotate away from here.
     * With this starting point, "rotated off" can always be brought back.
     */
    const cam = cameraFor(stage, initDefFov);
    const nearClip = boardNearDistance(stage, initDefFov);
    const camera = new THREE.PerspectiveCamera(cam.fovDeg, w / h, nearClip, Math.max(cam.distance * 40, 20000));
    camera.position.set(...(pose.current?.pos ?? cam.position));

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(...(pose.current?.target ?? [0, 0, 0]));
    controls.enableDamping = true;
    controls.enabled = modeRef.current === "space";
    controls.addEventListener("change", () => {
      if (modeRef.current !== "space") return;
      pose.current = {
        pos: camera.position.toArray() as [number, number, number],
        target: controls.target.toArray() as [number, number, number],
      };
    });
    const onOrbitEnd = () => setBakeGen((g) => g + 1);
    controls.addEventListener("end", onOrbitEnd);
    if (modeRef.current === "space") controls.update();

    const syncViewportSize = () => {
      const outEl = outerRef.current || el;
      const ow = Math.max(1, outEl.clientWidth);
      const oh = Math.max(1, outEl.clientHeight);
      if (modeRef.current === "camera") {
        const aspect = Math.max(1e-6, projRef.current.width / Math.max(1, projRef.current.height));
        let vw = ow;
        let vh = vw / aspect;
        if (vh > oh) {
          vh = oh;
          vw = vh * aspect;
        }
        vw = Math.max(1, Math.round(vw));
        vh = Math.max(1, Math.round(vh));
        el.style.left = `${Math.round((ow - vw) / 2)}px`;
        el.style.top = `${Math.round((oh - vh) / 2)}px`;
        el.style.width = `${vw}px`;
        el.style.height = `${vh}px`;
        el.style.right = "auto";
        el.style.bottom = "auto";
        const capEl = captionOverlayRef.current;
        if (capEl) {
          const pw = Math.max(1, projRef.current.width);
          const ph = Math.max(1, projRef.current.height);
          capEl.style.left = `${Math.round((ow - vw) / 2)}px`;
          capEl.style.top = `${Math.round((oh - vh) / 2)}px`;
          capEl.style.width = `${pw}px`;
          capEl.style.height = `${ph}px`;
          capEl.style.transformOrigin = "0 0";
          capEl.style.transform = `scale(${vw / pw})`;
        }
        camera.aspect = aspect;
        camera.updateProjectionMatrix();
        renderer.setSize(vw, vh, false);
      } else {
        el.style.left = "0";
        el.style.top = "0";
        el.style.right = "0";
        el.style.bottom = "0";
        el.style.width = "auto";
        el.style.height = "auto";
        const nw = Math.max(1, el.clientWidth || ow);
        const nh = Math.max(1, el.clientHeight || oh);
        camera.aspect = nw / nh;
        camera.updateProjectionMatrix();
        renderer.setSize(nw, nh, false);
      }
    };
    syncViewportSize();

    scene.add(new THREE.AmbientLight(0xffffff, 2.2));

    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(stage.width, stage.height)),
      new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.5 }),
    );
    scene.add(edge);

    const disposables: { dispose: () => void }[] = [edge.geometry, edge.material as any];

    const frustumMat = new THREE.LineBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.9 });
    const frustum = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute(
        "position",
        new THREE.Float32BufferAttribute(frustum2d(stage, initDefFov).positions, 3),
      ),
      frustumMat,
    );
    frustum.visible = frustumRef.current;
    scene.add(frustum);
    disposables.push(frustum.geometry, frustumMat as any);

    const camGizmoGeo = new THREE.BoxGeometry(
      Math.max(28, stage.width * 0.03),
      Math.max(20, stage.height * 0.025),
      Math.max(36, stage.width * 0.035),
    );
    const camGizmoMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b, wireframe: false });
    const camGizmo = new THREE.Mesh(camGizmoGeo, camGizmoMat);
    camGizmo.userData.isCameraGizmo = true;
    camGizmo.visible = false;
    scene.add(camGizmo);
    disposables.push(camGizmoGeo, camGizmoMat);
    let lastFrustumSig = "";
    let lastAppliedMode = modeRef.current;

    swap.current = new Map();
    proxy.current = new Map();

    /* Track stream player: decodes from a hidden canvas and fetches each card's track stream */
    const player = new StreamPlayer({
      root: () => streamHost.current,
      ...(ONLINE ? { source: new PushedStreamSource() } : {}),
    });
    disposables.push({ dispose: () => player.stop() });

    const boards: {
      clipId: string;
      mesh: any;
      mat: any;
      pl: ReturnType<typeof placeClip3D>;
      canvas: HTMLCanvasElement | null;
      canvasTex: any;
      cropped: boolean;
      subBox: BoardSubBox | undefined;
      boundSig: string;
      mode: "proxy" | "stream" | "exact";
    }[] = [];
    const mediaBoards: {
      clipId: string;
      mesh: any;
      mat: any;
      pl: ReturnType<typeof placeClip3D>;
      texCanvas: HTMLCanvasElement;
      canvasTex: any;
      lastDrawSig: string;
    }[] = [];
    const scene3dItems: {
      clipId: string;
      mesh: any;
      mat: any;
      hasTex: boolean;
    }[] = [];

    const cropToCanvasBound = (b: typeof boards[number], cv: HTMLCanvasElement) => {
      const W = b.pl.size.width;
      const H = b.pl.size.height;
      const bx = parseFloat(cv.style.left) || 0;
      const by = parseFloat(cv.style.top) || 0;
      const bw = cv.width || W;
      const bh = cv.height || H;
      const sig = `${bx},${by},${bw},${bh}`;
      if (b.boundSig === sig && b.cropped) return;
      b.boundSig = sig;

      const nextGeo = new THREE.PlaneGeometry(bw, bh);
      const old = b.mesh.geometry;
      b.mesh.geometry = nextGeo;
      old.dispose();
      disposables.push(nextGeo);

      const dx = (bx + bw / 2) - W / 2;
      const dy = H / 2 - (by + bh / 2);
      b.mesh.position.set(b.pl.meshOffset[0] + dx, b.pl.meshOffset[1] + dy, b.pl.meshOffset[2]);
      b.cropped = true;
      b.subBox = W > 0 && H > 0 ? { x: bx / W, y: by / H, w: bw / W, h: bh / H } : undefined;
    };

    posers.current = [];
    const pickables: any[] = [];
    const placed: { clipId: string; pivot: any; inner: any; spin: any; tilt: any; mesh: any }[] = [];
    const meshByClipId = new Map<string, any>();
    const marks = new Map<string, any>();
    const camDir = new THREE.Vector3();

    /*
     * Synchronize placement, timeline envelopes (`cardOpacityAt` + nested `cutEnv`), near-plane culling
     * (`isBoardBehindCamera`), and back-to-front depth sorting (`sortBoardsByDepth`).
     */
    const syncSceneState = () => {
      const projNow = projRef.current;
      const tNow = tRef.current;
      const stageNow = { width: projNow.width, height: projNow.height };
      const cutNow = activeCutEntry(projNow);
      const defFov = defaultCutFovDeg(projNow, cutNow);
      const cam3d = resolveCamera3DAt(cutNow?.cameras, stageNow, tNow, defFov);
      const is3DCut = activeCutKind(projNow) === "3d";
      const curMode = modeRef.current;

      if (curMode !== lastAppliedMode) {
        lastAppliedMode = curMode;
        syncViewportSize();
        if (curMode === "space") {
          const defCam = cameraFor(stageNow, defFov);
          camera.fov = defFov;
          camera.near = boardNearDistance(stageNow, defFov);
          camera.far = Math.max(defCam.distance * 40, 20000);
          camera.rotation.set(0, 0, 0);
          const defaultSpacePos: [number, number, number] = is3DCut
            ? [
                -defCam.distance * 0.9,
                defCam.distance * 0.42,
                Math.max(defCam.distance * 1.4, cam3d.position[2] + defCam.distance * 0.6),
              ]
            : defCam.position;
          camera.position.set(...(pose.current?.pos ?? defaultSpacePos));
          controls.target.set(...(pose.current?.target ?? [0, 0, 0]));
          camera.updateProjectionMatrix();
          controls.enabled = true;
          controls.update();
        }
      }

      if (curMode === "camera") {
        controls.enabled = false;
        const aspect = Math.max(1e-6, stageNow.width / Math.max(1, stageNow.height));
        if (camera.fov !== cam3d.fovDeg || camera.near !== cam3d.near || Math.abs(camera.aspect - aspect) > 1e-5) {
          camera.fov = cam3d.fovDeg;
          camera.near = cam3d.near;
          camera.far = Math.max(cam3d.far, 20000);
          camera.aspect = aspect;
          camera.updateProjectionMatrix();
        }
        camera.position.set(...cam3d.position);
        camera.rotation.order = "YXZ";
        camera.rotation.set((cam3d.rx * Math.PI) / 180, (cam3d.ry * Math.PI) / 180, (cam3d.rz * Math.PI) / 180);
      } else {
        controls.enabled = true;
      }

      const flatClips = flattenBoards3D(projNow);
      const liveById = new Map<string, { clip: Board3DClip; effFrame: Board3DClip["frame"]; trackOrder: number }>();
      flatClips.forEach((c, idx) => liveById.set(c.id, { clip: c, effFrame: effFrameAt(c, tNow), trackOrder: idx }));

      const plById = new Map<string, ReturnType<typeof placeClip3D>>();
      for (const q of placed) {
        const entry = liveById.get(q.clipId);
        if (!entry) continue;
        const pl2 = placeClip3D(entry.effFrame, stageNow);
        plById.set(q.clipId, pl2);
        q.pivot.position.set(...pl2.pivot);
        q.inner.rotation.z = pl2.rollZ;
        q.inner.scale.setScalar(pl2.scale);
        q.spin.rotation.y = pl2.spinY;
        q.tilt.rotation.x = pl2.tiltX;
        q.tilt.position.z = pl2.translateZ;
      }
      for (const poseFn of posers.current) poseFn(tNow);

      camera.updateMatrixWorld();
      camera.getWorldDirection(camDir);
      const poseNow: CameraPose3D = {
        position: [camera.position.x, camera.position.y, camera.position.z],
        forward: [camDir.x, camDir.y, camDir.z],
        near: camera.near,
      };
      const fovForCull = curMode === "camera" ? cam3d.fovDeg : defFov;

      const sortInput: SortableBoard3D[] = [];

      for (const b of boards) {
        const entry = liveById.get(b.clipId);
        const pl2 = plById.get(b.clipId);
        if (pl2) {
          if (!b.cropped && (Math.abs(pl2.size.width - b.pl.size.width) > 0.5 || Math.abs(pl2.size.height - b.pl.size.height) > 0.5)) {
            const nextGeo = new THREE.PlaneGeometry(pl2.size.width, pl2.size.height);
            const old = b.mesh.geometry;
            b.mesh.geometry = nextGeo;
            old.dispose();
            disposables.push(nextGeo);
          }
          b.pl = pl2;
          if (b.cropped && b.subBox) {
            const W = pl2.size.width;
            const H = pl2.size.height;
            const dx = (b.subBox.x + b.subBox.w / 2) * W - W / 2;
            const dy = H / 2 - (b.subBox.y + b.subBox.h / 2) * H;
            b.mesh.position.set(pl2.meshOffset[0] + dx, pl2.meshOffset[1] + dy, pl2.meshOffset[2]);
          } else {
            b.mesh.position.set(...pl2.meshOffset);
          }
        }
        const inRange = !!entry && tNow >= entry.clip.start && tNow < entry.clip.end;
        const op = inRange && entry ? cardOpacityAt(entry.clip, tNow) : 0;
        const subBox = b.cropped ? b.subBox : undefined;
        const culled = !entry || isBoardBehindCamera(entry.effFrame, stageNow, fovForCull, poseNow, subBox);
        const visible = !culled && op > 0;
        b.mesh.visible = visible;
        b.mat.transparent = true;
        b.mat.depthWrite = false;
        b.mat.opacity = b.mode === "proxy" ? PROXY_OPACITY * op : op;
        if (visible && entry) {
          sortInput.push({
            id: b.clipId,
            frame: entry.effFrame,
            trackOrder: entry.trackOrder,
            subBox,
          });
        }
      }

      for (const mb of mediaBoards) {
        const entry = liveById.get(mb.clipId);
        const pl2 = plById.get(mb.clipId);
        if (pl2) {
          if (Math.abs(pl2.size.width - mb.pl.size.width) > 0.5 || Math.abs(pl2.size.height - mb.pl.size.height) > 0.5) {
            const nextGeo = new THREE.PlaneGeometry(pl2.size.width, pl2.size.height);
            const old = mb.mesh.geometry;
            mb.mesh.geometry = nextGeo;
            old.dispose();
            disposables.push(nextGeo);
          }
          mb.pl = pl2;
          mb.mesh.position.set(...pl2.meshOffset);
        }
        const inRange = !!entry && tNow >= entry.clip.start && tNow < entry.clip.end;
        const op = inRange && entry ? cardOpacityAt(entry.clip, tNow) : 0;
        const culled = !entry || isBoardBehindCamera(entry.effFrame, stageNow, fovForCull, poseNow);
        const visible = !culled && op > 0;
        mb.mesh.visible = visible;
        mb.mat.transparent = true;
        mb.mat.depthWrite = false;
        mb.mat.opacity = op;
        if (visible && entry) {
          sortInput.push({
            id: mb.clipId,
            frame: entry.effFrame,
            trackOrder: entry.trackOrder,
          });
        }
      }

      for (const s of scene3dItems) {
        const entry = liveById.get(s.clipId);
        const pl2 = plById.get(s.clipId);
        if (pl2) s.mesh.position.set(...pl2.meshOffset);
        const inRange = !!entry && tNow >= entry.clip.start && tNow < entry.clip.end;
        const op = inRange && entry ? cardOpacityAt(entry.clip, tNow) : 0;
        const culled = !entry || isBoardBehindCamera(entry.effFrame, stageNow, fovForCull, poseNow);
        const visible = !culled && op > 0;
        s.mesh.visible = visible;
        const wantTransparent = s.hasTex || op < 1;
        if (s.mat.transparent !== wantTransparent) {
          s.mat.transparent = wantTransparent;
          s.mat.needsUpdate = true;
        }
        s.mat.depthWrite = !wantTransparent;
        s.mat.opacity = op;
        if (visible && entry) {
          sortInput.push({
            id: s.clipId,
            frame: entry.effFrame,
            trackOrder: entry.trackOrder,
          });
        }
      }

      const sorted = sortBoardsByDepth(sortInput, stageNow, fovForCull, poseNow);
      for (const item of sorted) {
        const m = meshByClipId.get(item.id);
        if (m) m.renderOrder = item.renderOrder;
      }

      for (const [id, box] of marks) {
        const targetMesh = meshByClipId.get(id);
        box.visible = curMode === "space" && id === selRef.current && !!targetMesh?.visible;
        if (box.visible) box.update();
      }

      const showCamGizmo = curMode === "space" && (is3DCut ? !spaceGizmoHiddenRef.current : frustumRef.current);
      if (showCamGizmo) {
        const fSig = `${stageNow.width}x${stageNow.height}:${cam3d.position.join(",")}:${cam3d.rx},${cam3d.ry},${cam3d.rz}:${cam3d.fovDeg}`;
        if (fSig !== lastFrustumSig) {
          lastFrustumSig = fSig;
          frustum.geometry.setAttribute(
            "position",
            new THREE.Float32BufferAttribute(cameraFrustum3D(stageNow, cam3d).positions, 3),
          );
          frustum.geometry.computeBoundingSphere();
        }
        const isCamSel = Boolean(cam3d.activeClipId && selectedCameraRef.current === cam3d.activeClipId);
        const gizmoColor = isCamSel ? 0x22d3ee : 0xf59e0b;
        frustumMat.color.setHex(gizmoColor);
        camGizmoMat.color.setHex(gizmoColor);
        camGizmo.position.set(...cam3d.position);
        camGizmo.rotation.order = "YXZ";
        camGizmo.rotation.set((cam3d.rx * Math.PI) / 180, (cam3d.ry * Math.PI) / 180, (cam3d.rz * Math.PI) / 180);
      }
      frustum.visible = showCamGizmo;
      camGizmo.visible = showCamGizmo && is3DCut;
      edge.visible = curMode === "space" && !showCamGizmo;
    };

    let order = 0;

    for (const clip of active) {
      const pl = placeClip3D(effFrameAt(clip, tRef.current), stage);
      const renderOrder = ++order;

      const pivot = new THREE.Group();
      pivot.position.set(...pl.pivot);
      const inner = new THREE.Group();
      inner.rotation.z = pl.rollZ;
      inner.scale.setScalar(pl.scale);
      const spin = new THREE.Group();
      spin.add(inner);
      spin.rotation.y = pl.spinY;
      const tilt = new THREE.Group();
      tilt.add(spin);
      tilt.rotation.x = pl.tiltX;
      tilt.position.z = pl.translateZ;
      pivot.add(tilt);
      scene.add(pivot);
      placed.push({ clipId: clip.id, pivot, inner, spin, tilt, mesh: null });

      if (clip.cardId === MEDIA_BOARD_CARD && clip.media) {
        const texCanvas = document.createElement("canvas");
        texCanvas.width = Math.max(1, Math.round(pl.size.width));
        texCanvas.height = Math.max(1, Math.round(pl.size.height));
        const canvasTex = new THREE.CanvasTexture(texCanvas);
        canvasTex.colorSpace = THREE.SRGBColorSpace;
        canvasTex.minFilter = THREE.LinearFilter;
        canvasTex.magFilter = THREE.LinearFilter;
        canvasTex.generateMipmaps = false;
        const geo = new THREE.PlaneGeometry(pl.size.width, pl.size.height);
        const mat = new THREE.MeshBasicMaterial({
          map: canvasTex,
          color: 0xffffff,
          transparent: true,
          opacity: 1,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(...pl.meshOffset);
        mesh.renderOrder = renderOrder;
        inner.add(mesh);
        mesh.userData.clipId = clip.id;
        meshByClipId.set(clip.id, mesh);
        pickables.push(mesh);
        disposables.push(geo, mat, canvasTex);
        mediaBoards.push({
          clipId: clip.id,
          mesh,
          mat,
          pl,
          texCanvas,
          canvasTex,
          lastDrawSig: "",
        });
        continue;
      }

      const def = getCard(clip.cardId);

      /*
       * A 3D card here is **truly 3D**, with no texture smeared on.
       * It uses the same construction as the card (scene3dObject.ts): the same geometry, material,
       * lighting presets and pose formula. The light hangs on this object's own group, so several 3D
       * cards on screen each carry their own light, and each matches the final video.
       */
      if (clip.cardId === "scene-3d" && def) {
        const params = { ...def.defaults, ...clip.params } as Scene3DParams;
        const geo = geometryOf(THREE, shapeOf(params.shape), radiusFor(params, pl.size.height));
        const mat = materialOf(THREE, params);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(...pl.meshOffset);
        mesh.renderOrder = renderOrder;
        inner.add(mesh);
        mesh.userData.clipId = clip.id;
        meshByClipId.set(clip.id, mesh);
        pickables.push(mesh);
        disposables.push(geo, mat);

        const sItem = { clipId: clip.id, mesh, mat, hasTex: false };
        scene3dItems.push(sItem);

        const camD = cameraFor({ width: pl.size.width, height: pl.size.height }, params.fov > 0 ? params.fov : initDefFov).distance;
        addLights(THREE, inner, params.light, camD);

        if (params.texture) {
          const tex = applyTexture(THREE, mat, params.texture, () => {
            sItem.hasTex = true;
            syncSceneState();
            renderer.render(scene, camera);
          });
          if (tex) disposables.push(tex);
        }

        const start = clip.start;
        posers.current.push((now: number) => poseMesh(mesh, params, Math.max(0, now - start)));
        poseMesh(mesh, params, Math.max(0, t - start));
        continue;
      }

      /* A 2D card: a board with the "real prerendered image" applied */
      const geo = new THREE.PlaneGeometry(pl.size.width, pl.size.height);
      const mat = new THREE.MeshBasicMaterial({
        color: PROXY_COLOR,
        transparent: true,
        opacity: PROXY_OPACITY,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(...pl.meshOffset);
      mesh.renderOrder = renderOrder;
      inner.add(mesh);
      mesh.userData.clipId = clip.id;
      meshByClipId.set(clip.id, mesh);
      pickables.push(mesh);
      disposables.push(geo, mat);

      // Track stream canvas and texture
      const canvas = streamHost.current?.querySelector<HTMLCanvasElement>(
        `[data-pc-clip="${CSS.escape(clip.id)}"] > canvas[data-pc-stream-plane]`,
      );
      let canvasTex: any = null;
      if (canvas) {
        canvasTex = new THREE.CanvasTexture(canvas);
        canvasTex.colorSpace = THREE.SRGBColorSpace;
        canvasTex.minFilter = THREE.LinearFilter;
        canvasTex.magFilter = THREE.LinearFilter;
        canvasTex.generateMipmaps = false;
        disposables.push(canvasTex);
      }

      const boardState: typeof boards[number] = {
        clipId: clip.id,
        mesh,
        mat,
        pl,
        canvas: canvas ?? null,
        canvasTex,
        cropped: false,
        subBox: undefined,
        boundSig: "",
        mode: "proxy",
      };
      boards.push(boardState);

      /** Which texture this board currently holds. When evicting the texture cache, the ones in use must be skipped, and this is the bookkeeping for that */
      let boundUrl: string | null = null;

      /*
       * **Only apply the image for the current moment; anything else goes back to a placeholder block.**
       *
       * It was once written as "if the exact image has not arrived, use the prerendered one as padding,
       * better than a gray block": that was wrong. What gets padded in is a real frame from another
       * moment, which looks exactly like the final video, so nobody can tell it is padding; whereas a
       * placeholder block is **self-evidently** not a finished result (the same reasoning as solid mode,
       * see render/solidMode.ts). An image that looks real but is actually from another moment gets
       * passed along as evidence for this moment: that is exactly the essence of the bug "0.2 seconds on
       * the UI, 1.0 seconds on the board", and committing it again at another moment is pointless.
       */
      /*
       * **Crop the full-screen board down to the content area.**
       *
       * Most cards do not set frame.w/h, so their frame is the whole stage: every board is screen-sized,
       * with an identical outline, and 70~90% of it is fully transparent. A stack of such transparent
       * sheets laid out in space makes "how things are placed" impossible to see, and that is the very
       * reason this view exists.
       *
       * The content box is measured from **the texture itself** (alpha bounding box). Once the layout
       * size of the prerender is fixed, the texture canvas and the card's frame are 1:1, so the measured
       * relative position directly gives "where the four corners are within this card's frame": use it
       * to crop a small piece from this screen plane, then map the corresponding region of the texture
       * onto it, and the position is naturally right.
       *
       * If it cannot be measured, or it genuinely fills the whole area (like a full-screen gradient
       * background), keep the whole board: such a card **should** be one whole board.
       */
      const cropToContent = (tex: any) => {
        const box = measureImageBox(tex.image);
        const W = boardState.pl.size.width, H = boardState.pl.size.height;
        boardState.boundSig = "";
        if (!worthCropping(box) || !box) {
          boardState.subBox = undefined;
          if (boardState.cropped) {
            const nextGeo = new THREE.PlaneGeometry(W, H);
            const old = mesh.geometry;
            mesh.geometry = nextGeo;
            old.dispose();
            disposables.push(nextGeo);
            mesh.position.set(...boardState.pl.meshOffset);
            tex.repeat.set(1, 1);
            tex.offset.set(0, 0);
            tex.needsUpdate = true;
            boardState.cropped = false;
          }
          return;
        }
        const nextGeo = new THREE.PlaneGeometry(W * box.w, H * box.h);
        const old = mesh.geometry;
        mesh.geometry = nextGeo;
        old.dispose();
        disposables.push(nextGeo);
        /*
         * Move the board to the center of the content box. The plane itself is centered on the origin,
         * while the content box is mostly not at the center, and without moving it the texture would look
         * offset as a whole: this step and the UV step must come as a pair, and missing either one causes
         * misalignment.
         */
        const dx = (box.x + box.w / 2) * W - W / 2;
        const dy = H / 2 - (box.y + box.h / 2) * H;   // three's y points up, image coordinates point down
        mesh.position.set(boardState.pl.meshOffset[0] + dx, boardState.pl.meshOffset[1] + dy, boardState.pl.meshOffset[2]);
        // The texture shows only this region. three's UV origin is at the bottom left, so y must be flipped
        tex.repeat.set(box.w, box.h);
        tex.offset.set(box.x, 1 - box.y - box.h);
        tex.needsUpdate = true;
        boardState.cropped = true;
        boardState.subBox = { x: box.x, y: box.y, w: box.w, h: box.h };
      };

      /** Finishing after applying: crop to the content box, restore the white tint, sync opacity/cull/depth, and render */
      const dressUp = (tex: any) => {
        cropToContent(tex);
        mat.color.set(0xffffff);
        mat.depthWrite = false;
        syncSceneState();
        renderer.render(scene, camera);
      };
      const apply = (url: string, precise = false) => {
        if (!precise) return; // The prerender path carries no moment: the image it gives goes only into the cache, not onto the board
        boundUrl = url;
        texInUse.add(url);
        /*
         * **Apply decoded textures directly, without going through TextureLoader again.**
         *
         * This is the root fix for "a placeholder block flashes between two cards": when crossing a card
         * boundary the whole scene is rebuilt, every board gets a new material, and async loading takes
         * one or two frames to come back even on an HTTP cache hit: during those one or two frames the
         * board is a PROXY_COLOR block. A hit here applies it in the same frame, with no gap in between.
         */
        const hit = texCache.get(url);
        if (hit) {
          boardState.mode = "exact";
          mat.map = hit;
          // A prerendered card has a transparent background; without transparent on, the surroundings turn into black blocks (same reason as in applyTexture)
          mat.transparent = true;
          mat.depthWrite = false;
          mat.needsUpdate = true;
          cacheTexture(url, hit); // Move it to the end of the queue: it is the most recently used
          dressUp(hit);
          return;
        }
        applyTexture(THREE, mat, url, (loaded: any) => {
          cacheTexture(url, loaded);
          if (boundUrl !== url) return;
          boardState.mode = "exact";
          dressUp(loaded);
        });
        /*
         * **Not in disposables.** The texture's ownership belongs to the cache above: if it were disposed
         * along with everything else on a scene rebuild, the next rebuild would have to decode it again,
         * and the cache would be pointless; worse, another board may be holding the same one right now
         * (after relative keys, two copies of the same card share one file), and disposing would turn that
         * board black.
         */
      };
      /** Back to a placeholder block: this moment's image has not been rendered yet, or it moved to a different moment; if the stream picture is available, keep the stream picture transition */
      const toProxy = () => {
        if (boundUrl) { texInUse.delete(boundUrl); boundUrl = null; }
        if (player.showingClips().has(clip.id) && canvasTex && canvas) {
          cropToCanvasBound(boardState, canvas);
          canvasTex.repeat.set(1, 1);
          canvasTex.offset.set(0, 0);
          canvasTex.needsUpdate = true;
          mat.map = canvasTex;
          mat.color.set(0xffffff);
          mat.transparent = true;
          mat.depthWrite = false;
          mat.needsUpdate = true;
          boardState.mode = "stream";
          syncSceneState();
          renderer.render(scene, camera);
          return;
        }
        if (boardState.cropped) {
          const nextGeo = new THREE.PlaneGeometry(boardState.pl.size.width, boardState.pl.size.height);
          const old = mesh.geometry;
          mesh.geometry = nextGeo;
          old.dispose();
          disposables.push(nextGeo);
          mesh.position.set(...boardState.pl.meshOffset);
          boardState.cropped = false;
          boardState.subBox = undefined;
          boardState.boundSig = "";
        }
        boardState.mode = "proxy";
        if (!mat.map) {
          syncSceneState();
          renderer.render(scene, camera);
          return;
        }
        mat.map = null;
        mat.color.set(PROXY_COLOR);
        mat.depthWrite = false;
        mat.needsUpdate = true;
        syncSceneState();
        renderer.render(scene, camera);
      };
      swap.current.set(clip.id, apply);
      proxy.current.set(clip.id, toProxy);
      const exact = moments.current.get(momentKey(clip));
      if (exact) apply(exact, true);
    }

    /*
     * Click to select. Take the first mesh hit by the ray and set its clip as selected: once selected,
     * the editing panel on the left is this card, and you can directly turn the three "3D" knobs, so
     * this tab goes from "can look" to "can place".
     *
     * It has to coexist with OrbitControls: rotating the view is also press + drag. So record the
     * position on press, and on release treat it as a click only if it barely moved (< 4px):
     * otherwise rotating the view would change the selection.
     */
    const raycaster = new THREE.Raycaster();
    let downAt: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => { downAt = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      if (!downAt) return;
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      downAt = null;
      if (moved > 4) return;
      const r = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const candidates = [
        ...(camGizmo.visible ? [camGizmo] : []),
        ...pickables.filter((m) => m.visible),
      ];
      const hit = raycaster.intersectObjects(candidates, false)[0];
      if (hit?.object?.userData?.isCameraGizmo) {
        const pNow = projRef.current;
        const cutNow = activeCutEntry(pNow);
        const c3 = resolveCamera3DAt(
          cutNow?.cameras,
          { width: pNow.width, height: pNow.height },
          tRef.current,
          defaultCutFovDeg(pNow, cutNow),
        );
        if (c3.activeClipId) {
          onSelectCameraRef.current?.(c3.activeClipId);
          (actions as any).selectCamera?.(c3.activeClipId);
        }
        return;
      }
      const id = hit?.object?.userData?.clipId;
      if (id) actions.select([id]);
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    /* Outline the selected board: leave its own material alone and add a separate wireframe child object; deselecting just deletes it */
    for (const m of pickables) {
      const box = new THREE.BoxHelper(m, 0x22d3ee);
      box.visible = false;
      scene.add(box);
      marks.set(m.userData.clipId, box);
      disposables.push(box.geometry, box.material as any);
    }
    syncSceneState();
    renderer.render(scene, camera);

    let lastPlanesSig = "";
    const activeIds = new Set(
      active.filter((c) => c.cardId !== "scene-3d" && c.cardId !== MEDIA_BOARD_CARD).map((c) => c.id),
    );

    let raf = 0;
    const tick = () => {
      if (modeRef.current === "space") controls.update();

      // Sync the track stream with the 3D boards
      const ready = currentReadyIndex();
      const fps = Math.max(1, projRef.current.fps || 30);
      const streamPlanes: StreamPlaneRequest[] = [];
      for (const [cId, kinds] of ready) {
        if (!activeIds.has(cId)) continue;
        const layer = kinds.get("stream");
        if (!layer || !isStreamOrigin(layer.originFrame) || !layer.key) continue;
        streamPlanes.push({
          clipIds: [cId],
          key: layer.key,
          ranges: layer.ranges.map((r: any) => [r[0], r[1]]),
          originFrame: layer.originFrame,
        });
      }
      const planesSig = streamPlanes.map((p) => `${p.clipIds[0]}:${p.key}:${p.ranges?.length ?? 0}`).join(";");
      if (planesSig !== lastPlanesSig) {
        lastPlanesSig = planesSig;
        player.setPlanes(streamPlanes, fps);
      }
      player.present(tRef.current);
      const showing = player.showingClips();

      const isPlay = playingRef.current;

      if (mediaBoards.length > 0 && mediaHost.current) {
        const pNow = projRef.current;
        const allLive = flattenBoards3D(pNow);
        for (const mb of mediaBoards) {
          const bClip = allLive.find((x) => x.id === mb.clipId);
          if (!bClip?.media) continue;
          const mediaEl = mediaHost.current.querySelector<HTMLVideoElement | HTMLImageElement>(
            `[data-pc-3d-media="${CSS.escape(mb.clipId)}"]`,
          );
          if (!mediaEl) continue;
          let sw = 0;
          let sh = 0;
          let tTag = "";
          if (mediaEl instanceof HTMLVideoElement) {
            driveMedia(mediaEl, {
              target: targetTimeOf(bClip as unknown as TrackClip, tRef.current),
              playing: isPlay,
              volume: 0,
              scrubbing: scrubbingRef.current,
              rate: clipSpeed(bClip as unknown as TrackClip),
            });
            if (mediaEl.readyState >= 2) {
              sw = mediaEl.videoWidth;
              sh = mediaEl.videoHeight;
              tTag = mediaEl.currentTime.toFixed(4);
            }
          } else if (mediaEl.complete && mediaEl.naturalWidth > 0) {
            sw = mediaEl.naturalWidth;
            sh = mediaEl.naturalHeight;
            tTag = "img";
          }
          if (sw > 0 && sh > 0) {
            const bw = Math.max(1, Math.round(mb.pl.size.width));
            const bh = Math.max(1, Math.round(mb.pl.size.height));
            if (mb.texCanvas.width !== bw || mb.texCanvas.height !== bh) {
              mb.texCanvas.width = bw;
              mb.texCanvas.height = bh;
            }
            const cssFilt = filterOf(bClip as unknown as TrackClip, pNow.filters, tRef.current) ?? "";
            const drawSig = `${bw}x${bh}:${tTag}:${cssFilt}`;
            if (isPlay || drawSig !== mb.lastDrawSig) {
              mb.lastDrawSig = drawSig;
              const ctx = mb.texCanvas.getContext("2d");
              if (ctx) {
                ctx.clearRect(0, 0, bw, bh);
                ctx.save();
                if (cssFilt) ctx.filter = cssFilt;
                const sc = Math.max(bw / sw, bh / sh);
                const dw = sw * sc;
                const dh = sh * sc;
                ctx.drawImage(mediaEl, (bw - dw) / 2, (bh - dh) / 2, dw, dh);
                ctx.restore();
                mb.canvasTex.needsUpdate = true;
              }
            }
          }
        }
      }

      for (const b of boards) {
        if (isPlay) {
          if (showing.has(b.clipId) && b.canvasTex && b.canvas) {
            cropToCanvasBound(b, b.canvas);
            if (b.mode !== "stream") {
              b.canvasTex.repeat.set(1, 1);
              b.canvasTex.offset.set(0, 0);
              b.mat.map = b.canvasTex;
              b.mat.color.set(0xffffff);
              b.mat.transparent = true;
              b.mat.depthWrite = false;
              b.mat.needsUpdate = true;
              b.mode = "stream";
            }
            b.canvasTex.needsUpdate = true;
          } else {
            if (b.mode !== "proxy") {
              if (b.cropped) {
                const nextGeo = new THREE.PlaneGeometry(b.pl.size.width, b.pl.size.height);
                const old = b.mesh.geometry;
                b.mesh.geometry = nextGeo;
                old.dispose();
                disposables.push(nextGeo);
                b.mesh.position.set(...b.pl.meshOffset);
                b.cropped = false;
                b.subBox = undefined;
                b.boundSig = "";
              }
              b.mat.map = null;
              b.mat.color.set(PROXY_COLOR);
              b.mat.transparent = true;
              b.mat.depthWrite = false;
              b.mat.needsUpdate = true;
              b.mode = "proxy";
            }
          }
        } else {
          if (b.mode === "exact") {
            // An exact PNG snapshot already exists, keep it
          } else if (showing.has(b.clipId) && b.canvasTex && b.canvas) {
            cropToCanvasBound(b, b.canvas);
            if (b.mode !== "stream") {
              b.canvasTex.repeat.set(1, 1);
              b.canvasTex.offset.set(0, 0);
              b.mat.map = b.canvasTex;
              b.mat.color.set(0xffffff);
              b.mat.transparent = true;
              b.mat.depthWrite = false;
              b.mat.needsUpdate = true;
              b.mode = "stream";
            }
            b.canvasTex.needsUpdate = true;
          } else if (b.mode !== "proxy") {
            if (b.cropped) {
              const nextGeo = new THREE.PlaneGeometry(b.pl.size.width, b.pl.size.height);
              const old = b.mesh.geometry;
              b.mesh.geometry = nextGeo;
              old.dispose();
              disposables.push(nextGeo);
              b.mesh.position.set(...b.pl.meshOffset);
              b.cropped = false;
              b.subBox = undefined;
              b.boundSig = "";
            }
            b.mat.map = null;
            b.mat.color.set(PROXY_COLOR);
            b.mat.transparent = true;
            b.mat.depthWrite = false;
            b.mat.needsUpdate = true;
            b.mode = "proxy";
          }
        }
      }
      syncSceneState();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const ro = new ResizeObserver(() => {
      syncViewportSize();
    });
    ro.observe(outerEl);

    gl.current = {
      syncSize: syncViewportSize,
      render: () => {
        syncSceneState();
        renderer.render(scene, camera);
      },
      dispose: () => {
        cancelAnimationFrame(raf);
        if (mediaHost.current) {
          for (const v of Array.from(mediaHost.current.querySelectorAll("video"))) {
            releaseMedia(v);
          }
        }
        renderer.domElement.removeEventListener("pointerdown", onDown);
        renderer.domElement.removeEventListener("pointerup", onUp);
        controls.removeEventListener("end", onOrbitEnd);
        ro.disconnect();
        controls.dispose();
        texInUse.clear();
        for (const d of disposables) d.dispose?.();
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
      },
    };
    return () => { gl.current?.dispose(); gl.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mods, sig, project.width, project.height, project.camera3dFov, project.activeCutId]);

  /* ── Apply the texture for whichever moment we switch to; if there is none, fall back to the placeholder block first, then render ── */
  useEffect(() => {
    if (playing || scrubbing) { setPending(0); setBakingAt(null); return; }
    const curStage = { width: project.width, height: project.height };
    const cutNow = activeCutEntry(project);
    const defFov = defaultCutFovDeg(project, cutNow);
    const c3Now = resolveCamera3DAt(cutNow?.cameras, curStage, t, defFov);
    const curFov = mode === "camera" ? c3Now.fovDeg : defFov;
    const curPose: CameraPose3D | undefined =
      mode === "camera"
        ? { position: c3Now.position, forward: c3Now.forward, near: c3Now.near }
        : pose.current
          ? {
              position: pose.current.pos,
              forward: [
                pose.current.target[0] - pose.current.pos[0],
                pose.current.target[1] - pose.current.pos[1],
                pose.current.target[2] - pose.current.pos[2],
              ],
              near: boardNearDistance(curStage, defFov),
            }
          : undefined;
    const flat = active.filter(
      (c) =>
        c.cardId !== "scene-3d" &&
        c.cardId !== MEDIA_BOARD_CARD &&
        !isBoardBehindCamera(effFrameAt(c, t), curStage, curFov, curPose),
    );
    const need: typeof flat = [];
    for (const c of flat) {
      const url = moments.current.get(momentKey(c));
      if (url) swap.current.get(c.id)?.(url, true);
      else { proxy.current.get(c.id)?.(); need.push(c); }
    }
    if (scrubbing) { setPending(0); setBakingAt(null); return; }
    const asks = need.length
      ? need.map((c) => ({ clip: c, at: bakeTOf(c) }))
      : parked
        ? flat.filter((c) => !moments.current.has(texKeyOf(c, fineTOf(c)))).map((c) => ({ clip: c, at: fineTOf(c) }))
        : [];
    if (!asks.length) {
      setPending(0);
      setBakingAt(null);
      return;
    }
    let dead = false;
    setPending(asks.length);
    setBakingAt(asks[0].at);
    const ac = new AbortController();
    beginForegroundBake();
    (async () => {
      try {
        const res = await fetch("/api/ui-render/bake-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project,
            clips: asks.map((a) => ({ clipId: a.clip.id, t: a.at })),
            size: 1024,
            priority: 1,
          }),
          signal: ac.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          if (dead) return;
          throw new Error(data.error || tr("Render failed (HTTP {0})", res.status));
        }
        for (const b of data.baked ?? []) {
          const a = asks.find((x) => x.clip.id === b.clipId);
          if (a) moments.current.set(texKeyOf(a.clip, a.at), b.url);
          if (!dead && a && texKeyOf(a.clip, a.at) === momentKey(a.clip)) swap.current.get(b.clipId)?.(b.url, true);
          markBaked([momentId(b.clipId, a ? a.at : b.t)]);
        }
        if (dead) return;
        if (data.baked?.length) setBakeGen((g) => g + 1);
        if (data.failed?.length) setErr(tr("{0} failed to render: {1}", data.failed.length, data.failed[0].error));
      } catch (e: any) {
        if (!dead && e?.name !== "AbortError") setErr(String(e?.message || e));
      } finally {
        endForegroundBake();
        if (!dead) { setPending(0); setBakingAt(null); }
      }
    })();
    return () => { dead = true; ac.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, momentSig, culledSig, parked, bakeGen, scrubbing, playing, mode]);

  /* ── As soon as a prerendered texture arrives, store it in the per-moment cache so it is ready when that moment comes ── */
  useEffect(() => {
    if (!prefetch.ready.size) return;
    const all = flattenBoards3D(projRef.current);
    for (const [id, url] of prefetch.ready) {
      const at = id.lastIndexOf("@");
      if (at < 0) continue;
      const clipId = id.slice(0, at);
      const mt = Number(id.slice(at + 1));
      const c = all.find((x) => x.id === clipId);
      if (!c || !Number.isFinite(mt)) continue;
      const k = texKeyOf(c as TimedClip, mt);
      if (moments.current.get(k) === url) continue;
      moments.current.set(k, url);
      if (k === momentKey(c as TimedClip)) swap.current.get(clipId)?.(url, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefetch.ready, momentSig]);

  const is3DCutView = activeCutKind(project) === "3d";
  const gizmoShown = is3DCutView ? !spaceGizmoHidden : frustumOn;
  const captionTimeline = useMemo<Timeline | null>(() => {
    if (!is3DCutView || mode !== "camera") return null;
    const caps = [...project.tracks]
      .reverse()
      .filter((tr) => !tr.hidden)
      .flatMap((tr) => tr.clips.filter((c) => isCaptionClip(c)));
    if (!caps.length) return null;
    return {
      width: Math.max(1, project.width),
      height: Math.max(1, project.height),
      fps: project.fps,
      duration: project.duration,
      clips: caps,
      ...(project.themeId ? { themeId: project.themeId } : null),
    };
  }, [is3DCutView, mode, project]);

  useLayoutEffect(() => {
    gl.current?.syncSize();
  }, [captionTimeline, mode]);

  return (
    <div
      ref={outerRef}
      className={mode === "space" ? "pc-3d-checker" : undefined}
      data-pc-3d-mode={mode}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: 200,
        background: mode === "camera" ? "#090b10" : undefined,
      }}
    >
      {/* Hidden track stream canvas container, used by StreamPlayer to decode and provide the material source */}
      <div
        ref={streamHost}
        aria-hidden="true"
        style={{
          position: "absolute",
          width: 0,
          height: 0,
          overflow: "hidden",
          opacity: 0,
          pointerEvents: "none",
        }}
      >
        {active.filter((c) => c.cardId !== "scene-3d" && c.cardId !== MEDIA_BOARD_CARD).map((c) => (
          <div key={c.id} data-pc-clip={c.id}>
            <canvas data-pc-stream-plane="" />
          </div>
        ))}
      </div>
      {/* Hidden live media elements driving 3D media board textures */}
      <div
        ref={mediaHost}
        aria-hidden="true"
        style={{
          position: "fixed",
          left: -100000,
          top: -100000,
          width: 1,
          height: 1,
          overflow: "hidden",
          pointerEvents: "none",
        }}
      >
        {active.filter((c) => c.cardId === MEDIA_BOARD_CARD && c.media).map((c) => {
          const m = c.media!;
          const src = playbackUrl(m, tierHashes());
          return isImageMedia(m) ? (
            <img key={c.id} data-pc-3d-media={c.id} src={src} crossOrigin="anonymous" alt="" />
          ) : (
            <video key={c.id} data-pc-3d-media={c.id} src={src} crossOrigin="anonymous" muted playsInline preload="auto" />
          );
        })}
      </div>
      <div
        ref={host}
        className={mode === "camera" ? "pc-3d-checker" : undefined}
        style={{ position: "absolute", inset: 0 }}
      />
      {captionTimeline && (
        <div
          ref={captionOverlayRef}
          data-pc="scene3d-caption-layer"
          style={{ position: "absolute", left: 0, top: 0, overflow: "hidden", pointerEvents: "none" }}
        >
          <Stage timeline={captionTimeline} t={t} directT={t} playToken={0} nested />
        </div>
      )}

      {mods && mode === "space" && (
        <button
          type="button"
          className={`pc-3d-toggle${gizmoShown ? " is-on" : ""}`}
          style={{ position: "absolute", right: 10, top: 10 }}
          aria-pressed={gizmoShown}
          onClick={() => (is3DCutView ? setSpaceGizmoHidden((v) => !v) : setFrustumOn((v) => !v))}
          title={
            defFovNow !== DEFAULT_FOV_DEG
              ? tr("Draws the pyramid that the 2D page camera opens up to the frame edges (field of view {0}°): use it to tell whether a card is actually in the final video frame", defFovNow)
              : tr("Draws the pyramid that the 2D page camera opens up to the frame edges. This project has no field of view set, so the default {0}° is used (the same camera as the 3D page opening view)", DEFAULT_FOV_DEG)
          }
        >
          {is3DCutView ? tr("Camera frustum") : tr("2D view frame")}
        </button>
      )}
      {(pending > 0 || err) && !playing && (
        <div
          className="pc-3d-note"
          style={{
            position: "absolute", left: 10, bottom: 10, pointerEvents: "none",
            color: err ? "var(--ui-danger, #f87171)" : "var(--ui-text-2, #94a3b8)",
          }}
        >
          {err ?? (bakingAt === null
            ? tr("Rendering textures for {0} cards... color blocks are placeholders and will be replaced automatically once rendered", pending)
            : tr("Rendering the frame at second {0} ({1} in total)... color blocks are placeholders, not the frame of another moment", bakingAt.toFixed(2), pending))}
        </div>
      )}
      {!mods && !err && (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
          <span className="pc-3d-note" style={{ color: "var(--ui-text-2, #94a3b8)" }}>{tr("Loading 3D view…")}</span>
        </div>
      )}
    </div>
  );
}

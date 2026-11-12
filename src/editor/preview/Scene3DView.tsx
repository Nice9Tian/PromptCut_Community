import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { useBakePrefetch, beginForegroundBake, endForegroundBake, canonFrameT } from "./useBakePrefetch";
import { clipFingerprint, markBaked, momentId } from "./bakeCoverage";
import { measureImageBox, worthCropping } from "./alphaBox";
import { cardOpacityAt, flattenOverlay, type Project } from "../../kernel/project";
import { CUT_SEGMENT_CARD, cutOf } from "../../kernel/cutSegments";
import { placeClip3D, sortBoardsByDepth, type SortableBoard3D } from "./place3d";
import { frustum2d } from "./frustum2d";
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
}

export function Scene3DView({ project, t }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const streamHost = useRef<HTMLDivElement>(null);
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
  const frustumRef = useRef(frustumOn);
  frustumRef.current = frustumOn;
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
  const gl = useRef<{ dispose: () => void; render: () => void } | null>(null);
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
  const wantedMoments = useMemo(() => {
    const out: { clipId: string; t: number; start: number; end: number; tier: "coarse" | "full"; fine: boolean }[] = [];
    const fps = Math.max(1, project.fps || 30);
    const stageSize = { width: project.width, height: project.height };
    for (const c of flattenOverlay(project).clips) {
      // Media clips are bitmaps, scene-3d is real geometry, and boards behind the camera are culled
      if ((c as any).mediaId || c.cardId === "scene-3d" || isBoardBehindCamera(c.frame, stageSize, project.camera3dFov)) continue;
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

  const timeline = flattenOverlay(project);
  const active = timeline.clips.filter((c) => t >= c.start && t < c.end);
  // Which cards exist at this moment and what each looks like: rebuild the scene only when this changes. **Deliberately excludes the moment**:
  // if it were included, dragging the timeline within one card would rebuild the whole scene at every
  // slot crossed (all geometry rebuilt, all textures reloaded, and a new WebGL context opened, with a
  // browser limit of about 16). Changing the moment only changes material.map, with no rebuild needed.
  const sig = active.map(buildKey).join("|");
  // Which moments should be shown. When it changes, only refetch images, without rebuilding the scene
  const momentSig = active.map(momentKey).join("|");
  const stageSizeNow = { width: project.width, height: project.height };
  const culledSig = active
    .map((c) => (isBoardBehindCamera(c.frame, stageSizeNow, project.camera3dFov) ? "1" : "0"))
    .join("");

  /* ── Build the scene ───────────────────────────────────────────── */
  useEffect(() => {
    const el = host.current;
    if (!mods || !el) return;
    const [THREE, { OrbitControls }] = mods;
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);
    const stage = { width: project.width, height: project.height };

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
    const cam = cameraFor(stage, project.camera3dFov ?? DEFAULT_FOV_DEG);
    const nearClip = boardNearDistance(stage, project.camera3dFov ?? DEFAULT_FOV_DEG);
    const camera = new THREE.PerspectiveCamera(cam.fovDeg, w / h, nearClip, cam.distance * 40);
    // If it has been rotated, keep using the last camera position; only if not, use the final video's camera position (see the note on the pose ref)
    camera.position.set(...(pose.current?.pos ?? cam.position));

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(...(pose.current?.target ?? [0, 0, 0]));
    controls.enableDamping = true;
    // Record it as soon as the user rotates. OrbitControls' change fires every time it moves the
    // camera, including the damping frames, so after release the final position recorded is always
    // the last one.
    controls.addEventListener("change", () => {
      pose.current = {
        pos: camera.position.toArray() as [number, number, number],
        target: controls.target.toArray() as [number, number, number],
      };
    });
    const onOrbitEnd = () => setBakeGen((g) => g + 1);
    controls.addEventListener("end", onOrbitEnd);
    controls.update();

    scene.add(new THREE.AmbientLight(0xffffff, 2.2));

    /*
     * Outline of the screen plane (z=0). Without it there is no reference at all: after a couple of
     * rotations you can't tell which side is the "front".
     * Drawn as a wireframe rather than a solid face: a solid face would hide cards with negative z.
     */
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(stage.width, stage.height)),
      new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.5 }),
    );
    scene.add(edge);

    const disposables: { dispose: () => void }[] = [edge.geometry, edge.material as any];

    /*
     * The "2D view frustum": a four-sided pyramid with its **apex at the 2D camera and its base at the
     * aspect-ratio frame** (geometry in frustum2d.ts).
     *
     * The `edge` loop above only says "the frame is on this plane", not **where it is viewed from**:
     * and after a couple of rotations, "is this card actually in the picture" can only be judged by
     * the line-of-sight direction.
     *
     * All eight lines of the pyramid are **the same amber**: the four base edges and the four ribs
     * are two parts of the same thing, and splitting them into two colors would make people think
     * they are two different things. Amber is distinguishable from both the selection outline's cyan
     * (0x22d3ee) and the frame outline's blue-gray (0x64748b).
     *
     * **Build it once and leave it there, toggled with visible**, and not in the effect dependencies:
     * if it were, clicking the button would rebuild the whole scene: all geometry rebuilt, all
     * textures reloaded, and a new WebGL context opened (limit about 16).
     */
    const frustum = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute(
        "position",
        new THREE.Float32BufferAttribute(frustum2d(stage, project.camera3dFov).positions, 3),
      ),
      new THREE.LineBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.9 }),
    );
    frustum.visible = frustumRef.current;
    scene.add(frustum);
    disposables.push(frustum.geometry, frustum.material as any);
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
    // For picking: each mesh remembers which clip it belongs to (that is what three's userData is for)
    const pickables: any[] = [];
    // Placement is recomputed every frame, so references to these groups must be kept
    const placed: { clipId: string; pivot: any; inner: any; spin: any; tilt: any; mesh: any }[] = [];
    const meshByClipId = new Map<string, any>();
    const marks = new Map<string, any>();
    const camDir = new THREE.Vector3();

    /*
     * Synchronize placement, timeline envelopes (`cardOpacityAt` + nested `cutEnv`), near-plane culling
     * (`isBoardBehindCamera`), and back-to-front depth sorting (`sortBoardsByDepth`).
     *
     * In 3D cuts (`docs/semantics/product/project-model.md`), occlusion follows camera-space depth
     * rather than track order, while equal-depth planes break ties by track order. All translucent
     * boards keep `depthWrite: false` and receive explicit `renderOrder` from `sortBoardsByDepth`.
     */
    const syncSceneState = () => {
      const projNow = projRef.current;
      const tNow = tRef.current;
      const stageNow = { width: projNow.width, height: projNow.height };
      const flatClips = flattenOverlay(projNow).clips;
      const liveById = new Map<string, { clip: (typeof flatClips)[number]; trackOrder: number }>();
      flatClips.forEach((c, idx) => liveById.set(c.id, { clip: c, trackOrder: idx }));

      const plById = new Map<string, ReturnType<typeof placeClip3D>>();
      for (const q of placed) {
        const entry = liveById.get(q.clipId);
        if (!entry) continue;
        const pl2 = placeClip3D(entry.clip.frame, stageNow);
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

      const sortInput: SortableBoard3D[] = [];

      for (const b of boards) {
        const entry = liveById.get(b.clipId);
        const pl2 = plById.get(b.clipId);
        if (pl2) {
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
        const culled = !entry || isBoardBehindCamera(entry.clip.frame, stageNow, projNow.camera3dFov, poseNow, subBox);
        const visible = !culled && op > 0;
        b.mesh.visible = visible;
        b.mat.transparent = true;
        b.mat.depthWrite = false;
        b.mat.opacity = b.mode === "proxy" ? PROXY_OPACITY * op : op;
        if (visible && entry) {
          sortInput.push({
            id: b.clipId,
            frame: entry.clip.frame,
            trackOrder: entry.trackOrder,
            subBox,
          });
        }
      }

      for (const s of scene3dItems) {
        const entry = liveById.get(s.clipId);
        const pl2 = plById.get(s.clipId);
        if (pl2) s.mesh.position.set(...pl2.meshOffset);
        const inRange = !!entry && tNow >= entry.clip.start && tNow < entry.clip.end;
        const op = inRange && entry ? cardOpacityAt(entry.clip, tNow) : 0;
        const culled = !entry || isBoardBehindCamera(entry.clip.frame, stageNow, projNow.camera3dFov, poseNow);
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
            frame: entry.clip.frame,
            trackOrder: entry.trackOrder,
          });
        }
      }

      const sorted = sortBoardsByDepth(sortInput, stageNow, projNow.camera3dFov, poseNow);
      for (const item of sorted) {
        const m = meshByClipId.get(item.id);
        if (m) m.renderOrder = item.renderOrder;
      }

      for (const [id, box] of marks) {
        const targetMesh = meshByClipId.get(id);
        box.visible = id === selRef.current && !!targetMesh?.visible;
        if (box.visible) box.update();
      }
      frustum.visible = frustumRef.current;
      edge.visible = !frustumRef.current;
    };

    let order = 0;

    for (const clip of active) {
      // All the signs are in place3d.ts, where unit tests pin them down (see its notes)
      const pl = placeClip3D(clip.frame, stage);
      const renderOrder = ++order;

      // The chain of placement groups is shared: both flat boards and real 3D objects hang inside it
      const pivot = new THREE.Group();
      pivot.position.set(...pl.pivot);
      // From inside to outside: roll → scale → spin → tilt → translate, the same order as frameCss
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

        // The light distance scale is copied from the card: it uses the distance of the camera on its own canvas
        const camD = cameraFor({ width: pl.size.width, height: pl.size.height }, params.fov > 0 ? params.fov : (project.camera3dFov ?? DEFAULT_FOV_DEG)).distance;
        addLights(THREE, inner, params.light, camD);

        if (params.texture) {
          const tex = applyTexture(THREE, mat, params.texture, () => {
            sItem.hasTex = true;
            syncSceneState();
            renderer.render(scene, camera);
          });
          if (tex) disposables.push(tex);
        }

        // Spinning objects must follow the timeline: the pose is a pure function of the seconds "relative to this card's start"
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
      const hit = raycaster.intersectObjects(pickables.filter((m) => m.visible), false)[0];
      // Clicking on empty space does not clear the selection: if it did, a casual click on the 3D tab would lose the card being edited on the left
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
    const activeIds = new Set(active.filter((c) => c.cardId !== "scene-3d").map((c) => c.id));

    let raf = 0;
    const tick = () => {
      controls.update();

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
          // Paused: if an exact PNG snapshot already exists, keep exact;
          // if there is no exact snapshot yet but the stream frame is available, keep the stream frame transition;
          // if neither exists, show a semi-transparent placeholder block
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
      /*
       * Re-place everything once per frame from the latest project, evaluate canonical clip + nested cut
       * opacity envelopes, cull boards behind the near plane, and sort translucent boards back-to-front
       * by camera-space depth without rebuilding the scene.
       */
      syncSceneState();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    // This view is for people to rotate and look at, and it does not go into the export, so using the real rAF has no determinism problem
    raf = requestAnimationFrame(tick);

    const ro = new ResizeObserver(() => {
      const nw = Math.max(1, el.clientWidth);
      const nh = Math.max(1, el.clientHeight);
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
      renderer.setSize(nw, nh, false);
    });
    ro.observe(el);

    gl.current = {
      render: () => {
        syncSceneState();
        renderer.render(scene, camera);
      },
      dispose: () => {
        cancelAnimationFrame(raf);
        renderer.domElement.removeEventListener("pointerdown", onDown);
        renderer.domElement.removeEventListener("pointerup", onUp);
        controls.removeEventListener("end", onOrbitEnd);
        ro.disconnect();
        controls.dispose();
        /*
         * All boards in this scene are gone, so clear the "textures in use": if we don't, these URLs
         * will block eviction forever, the cache only grows and never shrinks, and video memory keeps
         * climbing. The textures themselves are not in disposables (ownership belongs to texCache).
         */
        texInUse.clear();
        for (const d of disposables) d.dispose?.();
        renderer.dispose();
        // dispose() does not release the WebGL context. The browser limit is about 16, and beyond that it silently drops the oldest (same pitfall as scene-3d)
        renderer.forceContextLoss();
        renderer.domElement.remove();
      },
    };
    return () => { gl.current?.dispose(); gl.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // t is deliberately not in the dependencies: the pose is updated every frame by the render loop from tRef, and adding it would rebuild the whole scene every frame
  }, [mods, sig, project.width, project.height, project.camera3dFov]);

  /* ── Apply the texture for whichever moment we switch to; if there is none, fall back to the placeholder block first, then render ── */
  useEffect(() => {
    // Do not send foreground render requests during playback; textures come straight from the track stream. Not while dragging either
    if (playing || scrubbing) { setPending(0); setBakingAt(null); return; }
    /*
     * Only ask for textures for **visible 2D cards**. `scene-3d` is real geometry, and boards behind the
     * camera near plane are culled before drawing so they should not tie up foreground renders either.
     */
    const curStage = { width: project.width, height: project.height };
    const curPose: CameraPose3D | undefined = pose.current
      ? {
          position: pose.current.pos,
          forward: [
            pose.current.target[0] - pose.current.pos[0],
            pose.current.target[1] - pose.current.pos[1],
            pose.current.target[2] - pose.current.pos[2],
          ],
          near: boardNearDistance(curStage, project.camera3dFov ?? DEFAULT_FOV_DEG),
        }
      : undefined;
    const flat = active.filter(
      (c) => c.cardId !== "scene-3d" && !isBoardBehindCamera(c.frame, curStage, project.camera3dFov, curPose),
    );
    const need: typeof flat = [];
    for (const c of flat) {
      const url = moments.current.get(momentKey(c));
      // If we have this moment, apply it (this also covers "drag back to the moment just now": cache hit, no re-render at all)
      if (url) swap.current.get(c.id)?.(url, true);
      // If not, fall back to the placeholder block (or keep the stream frame transition), and record that a render is needed
      else { proxy.current.get(c.id)?.(); need.push(c); }
    }
    /*
     * Which ones to render this round, and for which moment each. Two cases:
     *   need is non-empty: the board currently shows a placeholder block, so render by bakeTOf. That
     *                may be the coarse tier (one cell per 0.25 seconds), which pays off
     *                while dragging: one image covers a whole region, so we don't spend four or
     *                five seconds rendering at every position we land on.
     *   need is empty but the playhead has **stopped**: a picture is already there, but it may only
     *                be the stand-in. The user is staring at it, so prerender retries the
     *                playhead's own frame (measured: when stopped on frame 121, 3D had
     *                frame 120, a full frame off from 2D).
     * Don't fill in while dragging (saves renders); fill in once stopped (it has to be exact).
     */
    /*
     * **While the hand is still down, stop here: textures are still swapped (those in the cache are
     * applied immediately), but nothing is rendered.**
     *
     * The loop above has already applied what should be applied and fallen back to placeholder
     * blocks where needed, and that is free. What comes below is the part that costs money: every
     * cell we drag past would send a render, each tying up a Chrome for several seconds, and they
     * would render positions the user only flashed past. After release, scrubbing becomes false and
     * this effect runs again right away; only then does rendering really start. We render wherever
     * the user stops, and not a single render is wasted.
     */
    if (scrubbing) { setPending(0); setBakingAt(null); return; }
    const asks = need.length
      ? need.map((c) => ({ clip: c, at: bakeTOf(c) }))
      : parked
        ? flat.filter((c) => !moments.current.has(texKeyOf(c, fineTOf(c)))).map((c) => ({ clip: c, at: fineTOf(c) }))
        : [];
    if (!asks.length) {
      /*
       * Nothing needs rendering (dragged back to an already prerendered place). **The "rendering" flag
       * must be cleared here.** The previous effect run was killed by cleanup (dead), and the cleanup
       * line in its finally carries a `!dead` check, so it does not run. If we don't clear it here,
       * the picture is already good but the hint keeps showing "Rendering second X".
       */
      setPending(0);
      setBakingAt(null);
      return;
    }
    let dead = false;
    setPending(asks.length);
    setBakingAt(asks[0].at);
    /*
     * **When we switch to another moment, abort the previous request.**
     *
     * The consequence of not aborting was measured: moving the playhead 8 times in a row in an
     * unprerendered region sent 9 foreground render requests, with 4 pending at the same time. The
     * browser gives only about 6 connections per origin; once they are full,
     * **even the GET for an already rendered texture cannot get in**, hence "dragging back to an
     * already prerendered place does not refresh either, and has to wait for the earlier
     * unfinished render to complete first".
     *
     * Aborting wastes nothing: the server does not stop because of it, and concurrent requests with
     * the same key are merged (see bakeInFlight in bakeOne), so the image is still written to disk.
     * The next time it is needed, it hits the cache directly.
     */
    const ac = new AbortController();
    /*
     * Tell prerender to yield. Server rendering is serial; if prerender is occupying it, this one,
     * the one the user is staring at right now, has to wait four or five seconds more behind it.
     * It was meant to speed things up, but instead it causes a stall.
     */
    beginForegroundBake();
    (async () => {
      try {
        /*
         * Foreground rendering goes through the **editor's own resident hot-standby renderer** (two
         * Chromes taking turns, see uiRenderer in vite-plugin-vision), not the prerender pool: the one
         * the user is staring at has the highest priority and should not wait behind the Agent or
         * prerender for even a millisecond.
         */
        const res = await fetch("/api/ui-render/bake-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project,
            // What we want is the moment the **playhead at this instant** snaps to a cell, not the clip midpoint (see bakeTime.ts)
            clips: asks.map((a) => ({ clipId: a.clip.id, t: a.at })),
            size: 1024,
            /*
             * Jump the queue. The user is staring at this board waiting for it to become a real image, and
             * the queue may hold a long run of prerenders nobody is waiting for. Measured: without jumping
             * the queue it takes 19.5 seconds to show a picture; with it, the worst case is waiting for the
             * one currently running (about 5 seconds).
             */
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
          /*
           * **Whatever is rendered always goes into the cache, even if the playhead has already moved
           * away** (dead). This image took four or five seconds to render and its key is "that moment";
           * if we threw it away, dragging back would make us wait all over again.
           * But only apply it to the board while the playhead is still on this moment: if it has moved
           * away and we still apply it, what is applied is the picture of another moment.
           */
          // Store it under **the moment we asked for**, not momentKey: when prerender retries the exact frame, the two keys are not the same
          if (a) moments.current.set(texKeyOf(a.clip, a.at), b.url);
          // Compute momentKey after storing: once the exact frame is in the cache, bakeTOf switches to it, which matches here, and it gets swapped in
          if (!dead && a && texKeyOf(a.clip, a.at) === momentKey(a.clip)) swap.current.get(b.clipId)?.(b.url, true);
          /*
           * **Also tell the progress bar on the timeline.**
           *
           * Foreground live rendering and idle prerender are two separate paths, and the coverage table
           * used to be written only by the prerender one. So after the foreground render finished and the
           * picture had already become a real image, that segment on the timeline was still empty: it had
           * to wait for the next inventory round (a few seconds at most) to be filled in, which looked
           * like "the bar is half a beat slow". Adding this line makes both paths record it.
           */
          markBaked([momentId(b.clipId, a ? a.at : b.t)]);
        }
        if (dead) return;
        // If rendering succeeded, let this effect run another round: what just landed may only be the coarse-tier image, and once stopped we still need to fill in the exact frame
        if (data.baked?.length) setBakeGen((g) => g + 1);
        if (data.failed?.length) setErr(tr("{0} failed to render: {1}", data.failed.length, data.failed[0].error));
      } catch (e: any) {
        // One killed by cleanup does not count as an error: that means the user moved the playhead away, so there is no reason to wait for it any more
        if (!dead && e?.name !== "AbortError") setErr(String(e?.message || e));
      } finally {
        endForegroundBake();
        if (!dead) { setPending(0); setBakingAt(null); }
      }
    })();
    return () => { dead = true; ac.abort(); };
    // momentSig is in the dependencies: dragging the timeline to another moment needs to fetch the image again. But it is **not in the
    // dependencies of the effect that builds the scene**, so it only swaps material.map and the scene is not rebuilt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, momentSig, culledSig, parked, bakeGen, scrubbing, playing]);

  /* ── As soon as a prerendered texture arrives, store it in the per-moment cache so it is ready when that moment comes ── */
  useEffect(() => {
    if (!prefetch.ready.size) return;
    const all = flattenOverlay(projRef.current).clips;
    for (const [id, url] of prefetch.ready) {
      // The prerender key is `<clipId>@<t>` (see momentId in useBakePrefetch). A clipId never contains @
      const at = id.lastIndexOf("@");
      if (at < 0) continue;
      const clipId = id.slice(0, at);
      const mt = Number(id.slice(at + 1));
      const c = all.find((x: any) => x.id === clipId);
      if (!c || !Number.isFinite(mt)) continue;
      const k = texKeyOf(c, mt);
      if (moments.current.get(k) === url) continue;
      moments.current.set(k, url);
      /*
       * **Swap it in only if it is exactly the moment this board should show right now.**
       * Prerender renders many moments across the whole video; if we took any one of them and applied
       * it to the board, what we applied would be the picture of another moment. That is exactly the
       * bug being fixed.
       */
      if (k === momentKey(c)) swap.current.get(clipId)?.(url, true);
    }
    // momentSig is in the dependencies: the prerender output and "which moment to show right now" are
    // two values that can both change, and a change in either one means reconciling again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefetch.ready, momentSig]);

  return (
    /*
     * The background is a checkerboard, not black. The canvas has alpha:true, and areas with nothing
     * drawn used to show the near-black panel color directly, so "a dark card" and "nothing here"
     * looked exactly the same; the checker cells tell these two cases apart.
     * The gray and the cell size are aligned value by value with the see_frames side (see the notes
     * on .pc-3d-checker).
     */
    <div className="pc-3d-checker" style={{ position: "relative", width: "100%", height: "100%", minHeight: 200 }}>
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
        {active.filter((c) => c.cardId !== "scene-3d").map((c) => (
          <div key={c.id} data-pc-clip={c.id}>
            <canvas data-pc-stream-plane="" />
          </div>
        ))}
      </div>
      <div ref={host} style={{ position: "absolute", inset: 0 }} />

      {/*
        "2D view box" toggle. Placed in the top-right corner: the bar in the bottom-left is prerender
        progress; avoid competing for space. Only shown after loading finishes (mods in place, scene
        built): clicking it when the scene does not yet exist does nothing.
      */}
      {mods && (
        <button
          type="button"
          /*
           * **Do not attach `.pc-3d-note` again** (it used to be attached). That class means "a status hint
           * floating over the cells", and looking up the "Rendering..." one by it would match this button
           * too: someone has already stepped on this once while writing a test.
           * Looking alike is no reason to share a class name: the same background and rounded corners can
           * be combined into one rule in CSS.
           */
          className={`pc-3d-toggle${frustumOn ? " is-on" : ""}`}
          style={{ position: "absolute", right: 10, top: 10 }}
          aria-pressed={frustumOn}
          onClick={() => setFrustumOn((v) => !v)}
          title={
            project.camera3dFov
              ? tr("Draws the pyramid that the 2D page camera opens up to the frame edges (field of view {0}°): use it to tell whether a card is actually in the final video frame", project.camera3dFov)
              : tr("Draws the pyramid that the 2D page camera opens up to the frame edges. This project has no field of view set, so the default {0}° is used (the same camera as the 3D page opening view)", DEFAULT_FOV_DEG)
          }
        >
          {tr("2D view frame")}
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

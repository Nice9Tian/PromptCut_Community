/**
 * Single-card prerender: computes cache key (`bakeTarget`), renders a single image (`bakeOne`),
 * renders a batch of moments for the same card (`bakeClip`).
 * Moved verbatim from server/vite-plugin-vision.ts.
 *
 * **This module state is writable only here**: `bakeInFlight` (the in-flight pass for the same
 * key), `stores` (one PNG snapshot store per root).
 *
 * Outputs (PNG) are written into the `px` namespace via asset service APIs; cache key → content
 * hash is recorded in a small index (`server/bake-store.mjs`), no longer directly writing, listing,
 * or deleting the asset catalog (`docs/semantics/product/asset-service.md` "Prerender output").
 * The frame is a bitmap rendered on the spot (`card-bitmap.ts`): bypassing the frame store, only
 * this PNG is written to disk and pushed; the card's HTML is not stored
 * (`docs/semantics/mechanism/asset-service.md` "Single-card frame bypassing the task queue").
 * Dependency direction: bake → render / render-queue, unidirectional.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { isolateClip } from "../vision-project.mjs";
import { stripOuterFrameExpr } from "../../src/kernel/frameExpr.mjs";
import { activeCutEntry } from "../../src/kernel/camera.mjs";
import { cardCodeHash } from "../card-overrides.mjs";
import { assetServiceOrigin } from "../asset-client";
import { BAKE_INDEX_DIR, createBakeStore } from "../bake-store.mjs";
import { outRoot } from "./http";
import { enqueue } from "./render-queue";
import { renderFrames, renderOneFrame } from "./render";
import type { FrameResult, RenderOpts } from "./render";
import type { Runner } from "./worker-pool";

/**
 * The second at which clips are moved to start during prerendering (starting line).
 * See the long comment in bakeTarget for rationale and measured data.
 *
 * Cannot be 0: warm-up steps through four frames at t=0 before remounting the card, so clips
 * overlapping frame 0 go through this extra phase and render differently (measured: step-timeline
 * differs by 15164 pixels). 0.5s = 15 frames, advancing past it takes ~0.24s, which buys us
 * "34/34 cards are byte-for-byte identical when repositioned".
 */
const BAKE_LEAD = 0.5;

/**
 * Single-card bitmap generation method version, included in cache key (see `store` description in
 * bakeTarget). Incremented when the generation method changes and old images should no longer hit.
 */
export const BAKE_STORE_VERSION = 2;

/**
 * In-flight renders: key → promise of that render. When the same key is requested multiple times
 * concurrently, they share a single render. Not needed before the parallel pool (serial execution
 * naturally staggered them), needed only afterwards: see explanation in bakeOne.
 */
const bakeInFlight = new Map<string, { promise: Promise<any>; priority: number }>();

/** One PNG snapshot store per root (index in `<outRoot>/bake-index`, bytes via asset service) */
const stores = new Map<string, ReturnType<typeof createBakeStore>>();
const bakeLog = (event: string, fields: object = {}) => {
  try { console.info("[bake-store]", event, JSON.stringify(fields)); } catch { console.info("[bake-store]", event); }
};

/**
 * PNG snapshot store for this root: one instance each for editor process and prerender process,
 * sharing the same index directory.
 */
export function bakeStoreFor(root: string) {
  const key = path.resolve(root);
  let s = stores.get(key);
  if (!s) {
    s = createBakeStore({ indexDir: path.join(outRoot(root), BAKE_INDEX_DIR), origin: assetServiceOrigin, log: bakeLog });
    stores.set(key, s);
  }
  return s;
}

/**
 * Source code fingerprints for all media effect cards used by this media effect card clip
 * (itself + the entire upstream chain).
 *
 * Including only `cardCodeHash(clip.cardId)` in the isolation cache key is insufficient: the clip
 * points to a media effect card node in `cardNodes`, whose input can connect to another media effect
 * card. Modifying the upstream card's source code without modifying this card leaves the key
 * byte-for-byte identical, so `inspect_card_dom` / `bake_card` hits stale cache: without any error,
 * the visual simply fails to update. Deduplicated and sorted by node id, the computed value for the
 * same image is independent of traversal order.
 */
function graphCardCode(project: any, nodeId?: string): string[] | undefined {
  if (!nodeId) return undefined;
  const nodes = new Map<string, any>((project?.cardNodes || []).map((n: any) => [n.id, n]));
  const seen = new Set<string>(), codes = new Set<string>();
  const walk = (id?: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const node = nodes.get(id);
    if (!node) return;
    if (node.adapter === 'card' && node.cardId) codes.add(node.cardId + ':' + cardCodeHash(node.cardId));
    for (const input of Object.values(node.inputs || {}) as any[]) walk(input?.nodeId);
  };
  walk(nodeId);
  return codes.size ? [...codes].sort() : undefined;
}

/**
 * Computes "which disk file this prerender corresponds to" and the prerequisites needed to render
 * it. **Does not touch the file system.**
 *
 * Extracted separately because, besides prerendering itself, two other places ask the same question:
 * "has this card been rendered, and how large is that file" (bake-status) and "which files are
 * expired and should be deleted" (bake-evict). If any of the three computes the key differently,
 * it leads to "treated as unrendered despite having been prerendered" or "deleted a file in use":
 * neither throws an error, only slowing down mysteriously or flickering. Therefore, the key can
 * only be computed in this single place.
 */
export function bakeTarget(
  project: any,
  clipId: string,
  t: number,
  size: unknown,
  bg: unknown,
  fit: "square" | "box" = "square",
) {
  const iso = isolateClip(project, clipId);
  if (!iso) throw new Error(`No clip with id ${clipId} on the timeline.`);
  if (iso.clip.mediaId) throw new Error("This is a media clip (video / image) and is already a bitmap. Use its URL directly as the texture; no render is needed.");

  /*
   * **Strip frame before rendering.**
   *
   * frame represents "where this card is placed across the aspect ratio and how it rotates",
   * written relative to the project aspect ratio (e.g. 1920×1080). Prerendering switches to a
   * different canvas (a square texture / the card's own box), so coordinates mismatch: a card with
   * x:960 placed onto a 512×512 canvas falls completely outside the canvas, rendering as **a fully
   * transparent empty image without error**. (Measured: a card with frame renders transparentRatio = 1,
   * 1096 bytes; three different transforms render identically because they are all the same empty image.)
   *
   * Once stripped, the card fills the canvas and reflows to the canvas size: cards are inherently
   * responsive, which is precisely what we want for "what this card looks like on its own". Position
   * and 3D transforms are handled by the consumer: scene-3d pastes it onto object surfaces, and the
   * 3D view pastes it onto the board representing this card. Keeping it during prerender would apply it twice.
   */
  /*
   * **Move this clip to a fixed starting line before rendering.**
   *
   * Previously, it was rendered in its original position on the timeline, incurring two costs:
   *
   * 1. **Latency is proportional to how far back it is placed.** The export script advances from
   *    frame 0 (for determinism), but measurements show **advancing an empty frame with "nothing on
   *    screen" is as expensive as advancing an actual frame** (~16ms): for a card placed at second 10,
   *    rendering its first frame took 9014ms, of which 4803ms was spent entirely advancing the 300 empty
   *    frames from 0 to 299.
   * 2. **Repositioning it invalidates all dozen or so rendered moments.** The cache key includes
   *    absolute start/end values, yet the visuals have not changed at all: the user merely dragged the
   *    card to a new position without touching any parameter, yet must wait for a full re-render.
   *
   * Once moved to the starting line, the same card at the same **intra-clip relative moment** always
   * yields the same key and renders in the same pass, eliminating both costs: frame advance distance
   * is only BAKE_LEAD + intra-clip offset, independent of where the clip is placed.
   *
   * ## Why we can safely relocate: verified byte-for-byte across 34 cards
   *
   * For repositioning to work, the prerequisite is that card rendering is independent of absolute
   * position. Reconciled card by card (same intra-clip moment, one placed at 0.5s, one at 12s,
   * comparing PNG sha1): **34/34 are byte-for-byte identical**.
   *
   * The verification process uncovered two issues, both resolved in this version:
   *
   * - **mu-word-rotate actually varied with position**: placed at 0/0.5/1s vs 2/3/4/6/12s rendered
   *   two different images, differing by 22599 pixels with a maximum channel difference of 250
   *   (showing the previous vs next word on the board). The root cause was in the card (the carousel
   *   used `now - lastTick` accumulation and shifted phase to current frame upon hit); changed to
   *   `floor(elapsed / duration)`, see vendor/word-rotate.tsx.
   * - **Frame 0 is special, so the starting line cannot be 0.** Warm-up (warmUp) steps through four
   *   frames at t=0 before remounting the card, so cards with "clips sitting right on frame 0" undergo
   *   this extra phase: measured at 0s vs elsewhere, step-timeline differs by 15164 pixels, and
   *   mu-word-rotate differs by a whole word. Leaving a half-second starting lead bypasses this:
   *   measured at 0.5s and 12s, 34/34 are byte-for-byte identical. The cost is advancing 15 extra
   *   frames per pass (~0.24s).
   */
  /*
   * **Intra-clip positions are always expressed as "frame number", never as "second delta".**
   *
   * Time slots are originally relative to the clip start (`pickBakeT` in `bakeTime.ts` returns
   * `clip.start + slot`), so intuitively `t - clip.start` would subtract out the absolute position.
   * But that is **floating-point subtraction**: for a clip placed at 3s, `3.25 - 3 = 0.25` is bit-exact,
   * whereas placed at 17.3s, `17.55 - 17.3 = 0.2500000000000018`. The key is hashed from this number,
   * so "repositioning invalidates everything" would survive in another form: triggering only when the
   * position is non-integer, making it hardest to debug. (A similar pitfall was noted in bakeTime.ts:
   * with step=1/30, accumulation and floor-then-multiply differ by 2.8e-17, resulting in "the display
   * side cannot retrieve any prerendered image".)
   *
   * Switching to integer frame numbers avoids this entirely: the same frame number always produces
   * the same double, while the rendering side (`Math.round(at * fps)`) only recognizes frame numbers
   * anyway, losing no information whatsoever.
   */
  const fps = project.fps || 30;
  // Keep at least one frame: zero-length clips cannot advance any frame; renders an empty image without error
  const lenFrames = Math.max(1, Math.round(((iso.clip.end ?? 0) - (iso.clip.start ?? 0)) * fps));
  const len = lenFrames / fps;
  // Strip frame, outer pose frameExpr, and outer opacity/fades (same rule as localClip in frame-stream.mjs):
  // 3D boards apply cardOpacityAt and resolveClipFrameAt on the mesh/material, so baking outer pose or fades into the PNG would apply them twice.
  const { frame: _dropFrame, frameExpr: rawFrameExpr, opacity: _dropOpacity, fadeIn: _dropFadeIn, fadeOut: _dropFadeOut, ...bare } = iso.clip;
  const sizeExpr = stripOuterFrameExpr(rawFrameExpr);
  const lead = iso.clip.cutId ? BAKE_LEAD + Math.max(0, Number(iso.clip.cutOffset) || 0) : BAKE_LEAD;
  /*
   * The key is computed from this plainClip, so **repositioning here makes the key truly position-agnostic**.
   * Changing only at without changing start/end on clip is not enough: those two fields still enter the hash.
   */
  const plainClip = { ...bare, ...(sizeExpr ? { frameExpr: sizeExpr } : {}), start: lead, end: lead + len };
  const box = {
    w: Math.max(1, Math.round(iso.clip?.frame?.w ?? project.width)),
    h: Math.max(1, Math.round(iso.clip?.frame?.h ?? project.height)),
  };
  const px = Math.min(2048, Math.max(256, Math.round(Number(size) || 1024)));
  /*
   * Two aspect ratios:
   *   square: Square. Used for pasting onto 3D surfaces (bake_card default): original 16:9 gets distorted.
   *   box:    The card's own bounding box size. Used by 3D view: the board there matches this box,
   *           pasting 1:1 prevents stretching and keeps layout identical to the stage.
   */
  /*
   * **Two dimensions that must not be conflated.**
   *
   *   renderBox: What size to **layout** with, i.e., how large the output is. Must be the card's
   *   actual container size in the final video.
   *
   * Previously these two shared the same value (rendered directly at texture dimensions), causing
   * **the card to reflow under a different width**: cards use absolute px, so shrinking the container
   * from 1920 to 1024 makes text relatively larger, forces line wraps, and fills background blocks.
   * Measured with blur-text: rendered at 1024×576, the content box occupies 100%×70.1% of canvas
   * (wrapped); rendered at the actual 1920×1080, it occupies 66.5%×28.1% (single line): only the
   * latter matches the 2D preview. In other words, what was pasted onto the 3D board was not the 2D
   * frame at all, without any error.
   *
   * The square tier is unaffected: it is **intended** to lay out in a square container (pasted onto 3D
   * surfaces, 16:9 would be distorted), so its renderBox is simply that square.
   */
  const renderBox = fit === "box" ? { width: box.w, height: box.h } : { width: px, height: px };
  // If no time is given, pick the midpoint of this clip: start and end often hit entrance / exit
  // animations, rendering a translucent intermediate state.
  const relFrames = Number.isFinite(t)
    ? Math.min(lenFrames, Math.max(0, Math.round(((t as number) - (iso.clip.start ?? 0)) * fps)))
    : Math.round(lenFrames / 2);
  /**
   * The actual frame to render: starting line + intra-clip frame number. **Used by both key and
   * rendering**, thus independent of absolute position.
   */
  const at = lead + relFrames / fps;
  /**
   * The t returned to the caller: **must be the absolute moment requested**, not the relocated one above.
   *
   * Both 3D view and prerender use `clipId + t` as the texture ledger key (momentId); returning a
   * relocated moment causes a mismatch: `batch.find(x => x.t === b.t)` misses every time, resulting
   * in "treated as unrendered despite having been rendered", continuously re-rendering the same image
   * without error.
   */
  const askedT = Number.isFinite(t) ? (t as number) : (iso.clip.start + iso.clip.end) / 2;
  const rgb = typeof bg === "string" ? /^#?([0-9a-f]{6})$/i.exec(bg.trim()) : null;

  /*
   * code: Hash of this card's code at this moment (definition file + active contents of dependency
   * closure, see card-overrides.mjs). Without it, modifying card source code still hits the old
   * prerendered image, and the 3D view continues pasting the pre-modification appearance.
   */
  /*
   * store: Which generation method version produced this image. 2 = bitmap rendered on the spot
   * (`card-bitmap.ts`, as of 2026-10-13): bypasses frame store, does not store this card's HTML.
   * Legacy keys lacking this field (produced via frame store `see_frames`, some replayed/rasterized
   * from saved HTML) will no longer hit; images from the new and old generation methods are not mixed.
   * Index entries for legacy keys are inventoried and evicted as "legacy versions unused by this project";
   * bytes remain in the asset service and are evicted by capacity limits.
   */
  const key = createHash("sha1")
    .update(JSON.stringify({ clip: plainClip, ...(iso.clip.cutId ? { cuts: project.cuts } : {}), graph: iso.clip.nodeId ? { nodes: project.cardNodes, media: project.media, tracks: project.tracks, style: project.style } : undefined, theme: project.themeId, at, renderBox, fit, bg: rgb ? rgb[1].toLowerCase() : null, code: cardCodeHash(iso.clip.cardId), graphCode: graphCardCode(project, iso.clip.nodeId), store: BAKE_STORE_VERSION }))
    .digest("hex").slice(0, 12);
  /*
   * Legacy filename format (previously located in the asset catalog as `bake-<clipId>-<key>.png`).
   * Bytes are now stored in `px` of the asset service, addressed by content hash
   * (`/api/asset/px/<sha256>`, known only after rendering); this name is retained solely for
   * read-time migration: previously rendered assets in legacy projects are fetched via the legacy
   * read route of the asset service and pushed into `px` without re-rendering (`migrateLegacy` in
   * `bake-store.mjs`).
   */
  const name = `bake-${clipId.replace(/[^\w.-]/g, "_")}-${key}.png`;
  /**
   * Project used for rendering this pass. **Assembled only once here**: previously assembled
   * separately for single renders and batch renders, requiring both places to update duration, update
   * tracks, and lay out by renderBox: missing either one causes "single-render and batch-render are
   * not the same image", without any error.
   *
   * duration must be recalculated according to the relocated position (the original is the full video
   * length, whereas here only one clip remains), with one extra frame of margin: renderFrames clamps
   * frame numbers to duration*fps-1, which would miss one frame right at the end.
   */
  const outerActiveId = activeCutEntry(iso.project)?.id;
  const targetCuts = iso.clip.cutId && Array.isArray(iso.project.cuts)
    ? iso.project.cuts.map((c: any) => (c?.id === outerActiveId ? { ...c, kind: "2d", cameras: undefined } : c))
    : undefined;
  const target = {
    ...iso.project,
    cuts: targetCuts,
    cutKind: undefined,
    _renderView: undefined,
    // **Lay out by actual container size**, not by texture size (see explanation above)
    width: renderBox.width,
    height: renderBox.height,
    duration: lead + len + 1 / fps,
    tracks: iso.project.tracks.map((tr: any) => ({ ...tr, clips: tr.clips.map((c: any) => c.id === clipId ? plainClip : c) })),
  };
  return { iso, plainClip, renderBox, target, at, askedT, rgb, key, name };
}


/**
 * Prerenders a card into an image, **cached by input**. Both single bake_card and 3D view batching
 * go through here.
 *
 * The cache key is the hash of "input": card content + moment + dimensions + background color + theme.
 * Therefore, the same card with the same parameters is actually rendered only once (4.7~6.5 seconds);
 * subsequent hits query the index once and ask the asset service "is this chunk fully received",
 * at virtually zero cost. This is precisely the premise allowing "generally users have everything
 * prerendered and do not need proxies" to hold: proxies only cover those initial few seconds.
 *
 * Output hashes **cannot** be used in the key: that would require rendering first to know the name,
 * meaning it would never hit.
 */
export async function bakeOne(
  root: string,
  origin: string,
  project: any,
  clipId: string,
  t: number,
  size: unknown,
  bg: unknown,
  fit: "square" | "box" = "square",
  /** 1 = user is waiting to view, jump queue; 0 = idle prerender, enqueue at tail */
  priority = 0,
  /**
   * The already rendered frame (already background-flattened with bg, transparent pixels counted).
   * Used by bakeClip: it renders multiple moments of the same card in one pass, then hands each back
   * here to follow the **exact same** cache key, atomic disk write, and return values:
   * having separate implementations for both paths would inevitably cause "single-render and
   * batch-render are not the same image", without any error.
   */
  pre?: FrameResult,
  /**
   * signal: cancels if caller disconnects; runner: execution target (defaults to render pool, UI hot
   * standby renderer passes its own); lane: which queue the FramePipeline route joins (see
   * `RenderOpts.lane` in render.ts), defaults to Agent dedicated instance (bake_card).
   */
  o: { signal?: AbortSignal; runner?: Runner; lane?: RenderOpts["lane"] } = {},
): Promise<any> {
  const { target, at, askedT, rgb, key, name, renderBox } = bakeTarget(project, clipId, t, size, bg, fit);
  const store = bakeStoreFor(root);

  const hint = rgb
    ? "Opaque texture: applied, it looks like a solid object surface printed with this card. Put the url into the texture parameter of scene-3d."
    : "Transparent-background texture: applied, the object is see-through wherever the card draws nothing, so the content looks like it floats in space (good for logos / signs). To get a solid cube surface printed with this card, render again and pass bg (for example bg:\"#0b0f17\").";
  const note = "This is a **PNG snapshot**: the card's animation is frozen at frame t. Changing the card parameters later will not update the texture; render it again.";

  /*
   * Cache hit: identical inputs were rendered previously (present in index, this chunk fully
   * received by asset service), returns URL directly. When asset service is unreachable, throws
   * BakeStoreError here (specifying address and reason), which the caller passes back as-is to
   * Agent / page.
   */
  const hit = await store.lookup(key);
  if (hit) return { clipId, url: hit.url, t: askedT, width: renderBox.width, height: renderBox.height, bytes: hit.bytes, cached: true, hint, note };

  /*
   * **If the same key is currently rendering, wait for it instead of rendering again.**
   *
   * Needed only after switching rendering to a parallel pool: previously it was serial, so a second
   * request for the same key was guaranteed to queue after the first, by which point it was already
   * stored → hitting the cache above. Now they can be in-flight concurrently, finding no cache and
   * both launching Chrome.
   *
   * Measured (before routing through asset service): sending 4 identical requests concurrently →
   * rendered 4 times, needlessly burning 3 Chrome instances (~4s each). Storage itself is idempotent:
   * the asset service is content-addressed, so a second write of the same image is merely a
   * reconciliation; finalized and validated before becoming available externally, preventing readers
   * from getting an incomplete image.
   */
  /*
   * Coalescing with the in-flight pass for the same key has two exceptions:
   *   - **Skip piggybacking if more urgent**: when Agent bake_card (priority 1) collides with a
   *     prerender pass queued at the tail (priority 0), waiting means queuing behind all prerenders
   *     until the tool times out: a priority inversion. Rendering on its own writes the exact same
   *     content hash to the asset service, without conflict.
   *   - **That pass was cancelled** (its requester disconnected, not that the image failed to render):
   *     check again, as another waiter might have picked up rendering; join that pass if available,
   *     otherwise render on its own. Never re-join an already observed pass, avoiding looping on the
   *     same failed promise.
   */
  const seen = new Set<Promise<any>>();
  for (;;) {
    const flying = bakeInFlight.get(key);
    if (!flying || seen.has(flying.promise) || priority > flying.priority) break;
    seen.add(flying.promise);
    try {
      return await flying.promise;
    } catch (e: any) {
      if (!e?.cancelled || o.signal?.aborted) throw e;
    }
  }

  const work = bakeAndWrite();
  bakeInFlight.set(key, { promise: work, priority });
  try {
    return await work;
  } finally {
    if (bakeInFlight.get(key)?.promise === work) bakeInFlight.delete(key);
  }

  async function bakeAndWrite() {
  /*
   * Rendered in legacy projects (previously saved in asset catalog as `bake-<clipId>-<key>.png`):
   * retrieved via the legacy read route of the asset service and pushed into `px`, avoiding re-renders.
   * The batch route (pre already provided) was migrated earlier in bakeClip.
   */
  if (!pre) {
    const moved = await store.migrateLegacy(key, name, { width: renderBox.width, height: renderBox.height, clipId });
    if (moved) return { clipId, url: moved.url, t: askedT, width: renderBox.width, height: renderBox.height, bytes: moved.bytes, cached: true, hint, note };
  }
  /*
   * Background color determines the look when applied, and this choice should only be made once
   * **during prerendering**:
   *   omit bg → transparent background, objects show through unpainted card areas (cutout look,
   *     suitable for logos / signage);
   *   provide bg → flattened to opaque, card is printed on solid object surface.
   * Flattening background and counting transparent pixels are both handled in the render worker
   * (post.bg / post.stats, see server/png-post.mjs); this process only receives bytes and stores them
   * via the asset service.
   */
  const post = { bg: rgb ? rgb[1].toLowerCase() : null, stats: true };
  const r = pre ?? (o.runner
    ? await renderOneFrame(root, origin, target, at, [], priority, { signal: o.signal, runner: o.runner, post })
    : await enqueue(() => renderOneFrame(root, origin, target, at, [], priority, { signal: o.signal, post, bitmapOnly: true, lane: o.lane }), priority, 0, o.signal));

  /*
   * Written into `px` via asset service APIs (chunked, validated against sha256 during finalization,
   * made available externally only after validation, so readers never receive an incomplete image),
   * then recorded into the "input hash → content hash" index. The URL is `/api/asset/px/<contentHash>`.
   */
  const stored = await store.put(key, r.buf, { width: r.width ?? renderBox.width, height: r.height ?? renderBox.height, clipId, name });
  return {
    clipId, url: stored.url, t: askedT, width: r.width ?? renderBox.width, height: r.height ?? renderBox.height, bytes: r.buf.length, cached: false,
    ...(r.transparentRatio !== undefined ? { transparentRatio: r.transparentRatio } : {}),
    hint, note,
  };
  }
}

/**
 * Prerenders **several moments for the same card**. Unrendered ones are combined into a single pass,
 * while already-rendered ones directly hit cache.
 *
 * Why group by card instead of flattening all requests: the export script advances from frame 0
 * (for determinism), so "rendering frame F" has already advanced through all of 0..F: for the same
 * card, **all moments ≤F come along for free**, taking only 78ms for an extra snapshot versus
 * 4400ms for a dedicated pass.
 *
 * **This does not compromise "render near playhead first"**: batch order is still prioritized by
 * caller based on distance to playhead; this simply hitches the remaining moments for the same card
 * along. Worst case, the nearest moment is placed a few images later in the pass, delayed by tens
 * of milliseconds.
 */
export async function bakeClip(
  root: string,
  origin: string,
  project: any,
  clipId: string,
  times: number[],
  size: unknown,
  bg: unknown,
  fit: "square" | "box" = "square",
  priority = 0,
  o: { signal?: AbortSignal; runner?: Runner; lane?: RenderOpts["lane"] } = {},
): Promise<any[]> {
  const uniq = [...new Set(times.map(Number).filter(Number.isFinite))];
  if (uniq.length <= 1) {
    return [await bakeOne(root, origin, project, clipId, uniq[0], size, bg, fit, priority, undefined, o)];
  }

  /*
   * Which moments are not yet stored. Already existing ones do not enter this pass: they return
   * immediately after querying the index in bakeOne; rendered assets in legacy projects (old files
   * in the asset catalog) are migrated into `px` via the asset service here first, and do not enter
   * this pass either.
   */
  const store = bakeStoreFor(root);
  const missing: { t: number; at: number }[] = [];
  for (const t of uniq) {
    const tg = bakeTarget(project, clipId, t, size, bg, fit);
    const have = await store.lookup(tg.key)
      ?? await store.migrateLegacy(tg.key, tg.name, { width: tg.renderBox.width, height: tg.renderBox.height, clipId });
    if (!have) missing.push({ t, at: tg.at });
  }
  if (missing.length < 2) {
    return await Promise.all(uniq.map((t) => bakeOne(root, origin, project, clipId, t, size, bg, fit, priority, undefined, o)));
  }

  /*
   * Layout dimensions are fixed for the same card (depending only on the clip box), so all moments
   * in a pass share the same target project. Moments differ only in "which frame to render",
   * determined by target-frames in renderFrames.
   */
  const { target, rgb } = bakeTarget(project, clipId, missing[0].t, size, bg, fit);
  const fps = target.fps || 30;
  // Background and transparency stats are handled together in the render worker (same post as the
  // single-render path); what is returned to bakeOne is already finished.
  const post = { bg: rgb ? rgb[1].toLowerCase() : null, stats: true };
  const atList = missing.map((m) => m.at);
  const shots = o.runner
    ? await renderFrames(root, origin, target, atList, [], priority, { signal: o.signal, runner: o.runner, post })
    : await enqueue(() => renderFrames(root, origin, target, atList, [], priority, { signal: o.signal, post, bitmapOnly: true, lane: o.lane }), priority, 0, o.signal);

  // Rendered results are handed back to bakeOne by frame number; cache key, storage, and return values
  // all reuse that pipeline.
  const byT = new Map<number, FrameResult>();
  for (const m of missing) {
    const f = Math.max(0, Math.round(m.at * fps));
    const r = shots.get(f);
    if (r) byT.set(m.t, r);
  }
  return await Promise.all(uniq.map((t) => bakeOne(root, origin, project, clipId, t, size, bg, fit, priority, byT.get(t), o)));
}

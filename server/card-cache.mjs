import fs from 'node:fs/promises';
import path from 'node:path';
import { cardNodeIdentities, cardSampling, cardCacheIdentity, cardSnapshotIdentity, cardSnapshotInputKeys } from './card-identity.mjs';
import { cardCostKey } from '../src/render/cardCostKey.mjs';
import { snapshotCode } from './frame-code.mjs';
import { snapshotTier } from './snapshot-store.mjs';
import { MovFrameStore } from './frame-mov.mjs';
import { findFfmpeg } from './bakery/index.mjs';
import { resultKeyOf } from './render-node/fingerprint.mjs';
import { flatPlanProject, isFlatClipId } from '../src/kernel/cutFlatten.mjs';
import { activeCutEntry, activeCutKind } from '../src/kernel/camera.mjs';
import { hasFrameExpr } from '../src/kernel/frameExpr.mjs';

const exists = file => fs.access(file).then(() => true, () => false);

/**
 * Durable cache for cards which have explicitly declared independent
 * compositing.  Each value is a full-stage transparent PNG; placement belongs
 * to the browser compositor, so a cached image is never transformed again.
 *
 * The public shape deliberately contains URLs only.  The browser receives it
 * through project._cardRender and is the sole component allowed to composite
 * it with the live scene.
 */
export class CardFrameCache {
  /** `capture`/`scale` describe the renderer that writes samples. A sample is
   * served only when it was captured by the current capture code for this
   * card key, and an empty sample only after a second render confirmed it.
   *
   * `envFingerprint` (M4, contract E.3): environment fingerprint of the Chrome that writes these
   * samples, string or function returning a string (`FramePipeline` passes a function: fingerprint
   * is determined only after the first prerender room starts up and is probed). Keys produced by
   * `plan()` (PNG cache key `key`, shared snapshot key `snapshotKey`) are all multiplied by it:
   * pixels rendered across different environments have definite differences and cannot be used
   * interchangeably (design 2.1). */
  constructor({ root, project, capture = () => undefined, scale = () => 1, envFingerprint }) {
    this.root = root; this.project = project; this.fps = Number(project.fps) || 30;
    this.capture = capture; this.scale = scale;
    this.envFingerprint = envFingerprint;
    this.stores = new Map(); this.meta = new Map();
  }
  expected(key) { return { capture: this.capture() || undefined, cards: key }; }
  async store(key) {
    if (!this.stores.has(key)) {
      const store = new MovFrameStore({ dir: path.join(this.root, 'controls', key), fps: this.fps });
      this.stores.set(key, store); await store.ready;
    }
    return this.stores.get(key);
  }
  /** Accept both the compact browser plan and graph.outputs.  Unknown and
   * context cards are intentionally excluded: they must be rendered in their
   * complete Chrome context. */
  plan(value) {
    // The fingerprint is resolved once at the start; all keys in this pass use the same value. If
    // there is no fingerprint, throw and produce no keys: a key without a fingerprint is equivalent
    // to writing frames to a location "recognized by any environment", which is precisely the mix-up
    // M4 aims to eliminate. Existing call sites are wrapped in try blocks; throws are handled as
    // "no plan".
    const fp = typeof this.envFingerprint === 'function' ? this.envFingerprint() : this.envFingerprint;
    if (typeof fp !== 'string' || !fp) throw new Error('CardFrameCache.plan(): no environment fingerprint yet, not producing a prerender key');
    const graph = value?.graph || value;
    if (!graph?.nodes || !graph?.outputs) return [];
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    const definitions = new Map((graph.definitions || []).map(definition => [definition.id, definition]));
    const identities = cardNodeIdentities(graph, { style: this.project.style || {}, environment: value?.environment || {}, sourceVersions: value?.sourceVersions || {} });
    // The entry for each node's upstream in the shared snapshot key (upstream identity does not include
    // the clip id); nodes without upstream are {}
    const upstreamKeys = cardSnapshotInputKeys(graph, { style: this.project.style || {}, environment: value?.environment || {}, sourceVersions: value?.sourceVersions || {} });
    /*
     * Unknown cards (card clips whose definitions cannot be found in the prerender room registry,
     * `unknownClipIds` of `__pcCardPlan`): the stage does not render them and shows no controls:
     * not scheduled for prerender, not included in the prerender set (otherwise classified as heavy
     * under the "no definition" default capability stateful / requiring prerender), and have no layer
     * in the layer table. Only these outputs are skipped; the graph and node identities are computed
     * as above, and keys for other cards remain verbatim unchanged (even when an unknown card is input
     * to another card).
     */
    const unknownClips = new Set(Array.isArray(value?.unknownClipIds) ? value.unknownClipIds : []);
    const flatProj = flatPlanProject(this.project);
    const clipById = new Map();
    for (const track of flatProj?.tracks ?? []) {
      for (const clip of track?.clips ?? []) {
        if (clip && typeof clip.id === 'string' && !clipById.has(clip.id)) clipById.set(clip.id, clip);
      }
    }
    const activeCut = activeCutEntry(this.project);
    const is3DCut = this.project?.cutKind === '3d' || activeCutKind(this.project) === '3d';
    const has2DCameras = !is3DCut && Array.isArray(activeCut?.cameras) && activeCut.cameras.length > 0;
    const isSpaceView = this.project?._renderView === 'space';
    const controls = [];
    for (const output of graph.outputs) {
      if (output?.clipId && unknownClips.has(output.clipId)) continue;
      const node = nodes.get(output.nodeId);
      const definition = definitions.get(node?.definitionId);
      const caps = output.capabilities || node?.capabilities || node?.definition?.capabilities || definition || {};
      const compositing = caps.compositing || node?.compositing || 'unknown';
      const clipId = output.clipId || node?.clipId;
      const rawClip = clipId ? clipById.get(clipId) : undefined;
      const cardId = node?.cardId ?? rawClip?.cardId;
      const isCaption = cardId === 'caption-track';
      // Full-stage PNG controls cannot represent 3D boards, space-overview framing, or 2D camera pans on non-caption clips.
      const cacheable = compositing === 'independent' && !isFlatClipId(output.clipId) && !is3DCut && !isSpaceView && !(has2DCameras && !isCaption);
      const start = Number(output.start ?? node?.start ?? 0), end = Number(output.end ?? node?.end ?? start);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const sampling = cardSampling(start, this.fps);
      const phase = Number(sampling.phase.numerator) / Number(sampling.phase.denominator);
      // Samples are t = first/fps + local/fps, strictly before clip.end.
      // `phase` is seconds, hence it must be subtracted before multiplying by
      // fps (the old expression mixed seconds and frames).
      const count = Math.max(1, Math.ceil((end - start - phase) * this.fps - 1e-9));
      const nodeKey = identities.get(output.nodeId);
      if (!nodeKey) continue;
      // Output appearance belongs in the key: clipping frame, opacity/fades
      // and motion change pixels even if the underlying node stays identical.
      const appearance = { frame: output.frame, ...(hasFrameExpr(rawClip?.frameExpr) ? { frameExpr: rawClip.frameExpr } : {}),
        opacity: output.opacity, fadeIn: output.fadeIn, fadeOut: output.fadeOut, motion: output.motion,
        width: this.project.width, height: this.project.height };
      // M4: content keys (content-only, algorithm in `card-identity.mjs` unchanged) and result keys
      // (content key × environment fingerprint) are kept separately. Disk persistence, routing, and ready
      // index use result keys; track stream member keys and fine-grained task splitting use content keys:
      // the same project has identical content keys but different result keys across two environments
      // (contracts E.3-E.5).
      const cacheContentKey = cardCacheIdentity(nodeKey, sampling, end - start, JSON.stringify(appearance));
      const key = resultKeyOf(cacheContentKey, fp);
      // A3a shared snapshot key: completely different from `key` (CardFrameCache's PNG key, which includes
      // position, aspect ratio, and clipId): this strips clip identity and excludes appearance, so two
      // clips using the same card share one snapshot. When the output node has no upstream (regular
      // cards), `inputKeys` is {}, and the key is verbatim identical to before; when it has upstream
      // (when a clip attaches emphasis, filters, or sound effects, the output node is the outer layer and
      // the card is behind its input; for media effect cards, the media is behind its input), it includes
      // upstream identity: otherwise two clips with identical outer layers but different inner contents
      // would share the same key and retrieve each other's snapshots and streams.
      const inputKeys = upstreamKeys.get(output.nodeId) ?? {};
      const contentKey = cardSnapshotIdentity(node ?? {}, {
        definition, style: this.project.style || {}, environment: value?.environment || {},
        sourceVersions: value?.sourceVersions || {}, inputKeys,
        fps: this.fps, sampling, duration: end - start,
        stage: { width: this.project.width, height: this.project.height, camera3dFov: this.project.camera3dFov },
        frame: output.frame, themeId: this.project.themeId,
        fontFingerprint: value?.environment?.fontFingerprint || '', snapshotCode: snapshotCode(),
      });
      const snapshotKey = resultKeyOf(contentKey, fp);
      // Member key of single-card track streams (used by `planStreams`): same content identity, just
      // without the code fingerprint for snapshot generation: stream pixels are captured from
      // screenshots or directly from canvas, independent of how snapshot HTML is generated; including it
      // would invalidate all single-card streams every time snapshot generation code changes
      // (`docs/plan/prerender-products-contract.md` section 9.3). The stream's own code fingerprint is in
      // `codeVersion` of `planStreams`.
      const streamMemberKey = cardSnapshotIdentity(node ?? {}, {
        definition, style: this.project.style || {}, environment: value?.environment || {},
        sourceVersions: value?.sourceVersions || {}, inputKeys,
        fps: this.fps, sampling, duration: end - start,
        stage: { width: this.project.width, height: this.project.height, camera3dFov: this.project.camera3dFov },
        frame: output.frame, themeId: this.project.themeId,
        fontFingerprint: value?.environment?.fontFingerprint || '', snapshotCode: '',
      });
      /*
       * Cost key for K1 / K2 (R5). **Must be computed here**: `cardCostKey` requires the graph **node**
       * and its source version, both available only at this layer (`adoptCardPlan` only receives
       * controls). Criteria verbatim align with `clipCostIndex` on the page side
       * (`src/render/pipelinePlan.mjs`): identical inputs compute the same key on both ends so that
       * `planPipelines` derives the identical table (last item of K2).
       */
      const costKey = cardCostKey(node ?? {}, (value?.sourceVersions || {})[node?.cardId] ?? null,
        this.fps, Math.max(1, Math.round((end - start) * this.fps)));
      // `costKey` is not multiplied by fingerprint: cost records have separate device criteria (`device`
      // field); the key recognizes only the card and source version
      controls.push({ key, snapshotKey, contentKey, streamMemberKey, cacheContentKey, envFingerprint: fp, costKey, frameMode: caps.frameMode, tier: snapshotTier(caps), capabilities: caps,
        clipId, ...(cardId ? { cardId } : {}), ...(rawClip?.flat?.in3dCut === true ? { in3dCut: true } : {}),
        nodeId: output.nodeId, start, end, count, sampling, compositing, cacheable,
        needPrerendering: caps.need_prerendering === true || caps.needPrerendering === true || node?.need_prerendering === true || node?.needPrerendering === true, appearance });
    }
    return controls;
  }
  async renderState(plan, frames, { urlFor = (key, n) => `/api/frames/control/${encodeURIComponent(key)}/${n}` } = {}) {
    const values = {}, missing = {};
    for (const control of plan) {
      if (!control.cacheable) {
        if (control.needPrerendering) for (const globalFrame of frames) {
          if (globalFrame >= control.sampling.firstFrame && globalFrame / this.fps < control.end - 1e-9) (missing[globalFrame] ||= []).push(control.clipId);
        }
        continue;
      }
      const store = await this.store(control.key);
      for (const globalFrame of frames) {
        const local = globalFrame - control.sampling.firstFrame;
        if (local < 0 || local >= control.count || globalFrame / this.fps >= control.end - 1e-9) continue;
        if (await store.lookup(local, this.expected(control.key))) {
          (values[control.clipId] ||= {})[globalFrame] = urlFor(control.key, local);
        } else if (control.needPrerendering) (missing[globalFrame] ||= []).push(control.clipId);
      }
    }
    return { mode: 'interactive', frames: values, missing };
  }
  async put(key, localFrame, png, guard = () => true) {
    if (!guard()) return false;
    const store = await this.store(key);
    if (!guard()) return false;
    await store.put(localFrame, png, { capture: this.capture() || undefined, scale: this.scale(), cards: key });
    return true;
  }
  async hasComplete(control) {
    const store = await this.store(control.key);
    const expected = this.expected(control.key);
    await store.hydrate(Array.from({ length: control.count }, (_, n) => n));
    for (let n = 0; n < control.count; n++) if (!store.valid(n, expected)) return false;
    return true;
  }
  async finish(control) {
    if (!await this.hasComplete(control)) return false;
    const store = await this.store(control.key);
    // streamPngVideo (used by MovFrameStore) is ProRes 4444 with alpha.  Start
    // only after every local sample exists so a sparse interactive request can
    // never publish a truncated control movie.
    await store.start(await findFfmpeg());
    await store.finish();
    return true;
  }
  async close() { await Promise.all([...this.stores.values()].map(store => store.close())); }
}

export const cardControlPngPath = (root, key, frame) => path.join(root, 'controls', key, 'mov', 'frames', String(frame).padStart(6, '0') + '.png');

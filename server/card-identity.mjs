import { digest } from './frame-identity.mjs';
import { CARD_RUNTIME_ABI, selectedCardStyle, validateCardGraph } from '../src/kernel/cardGraph.mjs';
import { resolveFrameSize } from '../src/kernel/frameSize.mjs';

/** Per-node content identity intentionally excludes timeline placement and IDs.
 * All upstream versions and input time transforms are included transitively.
 */
export function cardNodeIdentities(graph, { style = {}, environment = {}, sourceVersions = {} } = {}) {
  const { nodes, levels } = validateCardGraph(graph);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const definitions = new Map((graph.definitions ?? []).map(def => [def.id, def]));
  const keys = new Map();
  for (const level of levels) for (const id of level) {
    // `inputs` are those remaining after validateCardGraph drops edges; dropped names remain in
    // node.missingInputs and enter the digest as well: whether input clips are deleted results in
    // different frames.
    const { id: _id, inputs, definitionId, ...node } = byId.get(id);
    const definition = definitions.get(definitionId);
    if (definitionId && !definition) throw new Error(`Missing card definition ${definitionId}`);
    const inputKeys = Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name,
      { key: keys.get(input.nodeId), offset: input.offset, rate: input.rate }]));
    const usedStyle = definition ? selectedCardStyle(definition, style) : node.adapter === 'chrome' ? style : {};
    keys.set(id, digest({ abi: CARD_RUNTIME_ABI, environment, node, definition, style: usedStyle,
      sourceVersion: node.cardId ? sourceVersions[node.cardId] : undefined, inputs: inputKeys }));
  }
  return keys;
}

const gcd = (a, b) => { a = a < 0n ? -a : a; while (b) { const next = a % b; a = b; b = next; } return a || 1n; };
const reduce = (n, d) => { if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d); return { n: n / g, d: d / g }; };
function decimal(value) {
  if (!Number.isFinite(value)) throw new Error('Non-finite card clock');
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(value));
  const power = Number(match[4] ?? 0) - (match[3]?.length ?? 0);
  let n = BigInt(match[2] + (match[3] ?? '')) * (match[1] ? -1n : 1n), d = 1n;
  if (power >= 0) n *= 10n ** BigInt(power); else d = 10n ** BigInt(-power);
  return reduce(n, d);
}
const ceil = (n, d) => n >= 0n ? (n + d - 1n) / d : n / d;
const pair = value => ({ numerator: String(value.n), denominator: String(value.d) });

/** Retain sub-frame placement exactly as decimal/rational input rather than
 * rounding clip.start to a frame. MOV frame 0 is the first timeline sample
 * inside the clip; phase identifies which local instant that sample represents.
 */
export function cardSampling(start, fps) {
  if (!(fps > 0)) throw new Error('Invalid card frame rate');
  const s = decimal(start), rate = decimal(fps);
  const first = ceil(s.n * rate.n, s.d * rate.d);
  if (first > BigInt(Number.MAX_SAFE_INTEGER) || first < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('Card frame out of range');
  const phase = reduce(first * rate.d * s.d - s.n * rate.n, rate.n * s.d);
  return { firstFrame: Number(first), fps: pair(rate), phase: pair(phase) };
}

export function cardLocalTime(sampling, localFrame) {
  if (!Number.isSafeInteger(localFrame)) throw new Error('Invalid local frame');
  const phase = sampling.phase, fps = sampling.fps;
  const n = BigInt(localFrame) * BigInt(fps.denominator) * BigInt(phase.denominator) + BigInt(phase.numerator) * BigInt(fps.numerator);
  const d = BigInt(fps.numerator) * BigInt(phase.denominator);
  const result = reduce(n, d);
  return { ...pair(result), seconds: Number(result.n) / Number(result.d) };
}

export function cardCacheIdentity(nodeKey, sampling, duration, output = 'visual') {
  // Invalidate raster samples captured with disposable WebGL buffers, which
  // could have stored a transparent canvas as a successfully rendered card.
  return digest({ rasterVersion: 2, nodeKey, fps: sampling.fps, phase: sampling.phase, duration, output });
}

const ratio = value => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') return pair(reduce(BigInt(value.numerator), BigInt(value.denominator)));
  return pair(decimal(Number(value)));
};

/**
 * Shared snapshot key (A3a). Uses the same `digest` and input structure as `cardNodeIdentities`,
 * but input nodes first strip clip identity: in addition to `id` / `inputs` / `definitionId`
 * already stripped at `:13`, **`clipId` is also stripped** (written when `cardGraph.mjs:121-127`
 * synthesizes the `@clip/<id>/source` node). The same card placed in two clips with identical
 * parameters and frame dimensions has identical content, so the snapshot should be shared.
 * `cardNodeIdentities` itself is not modified: its `clipId` is intentional, used for cache
 * validation in `CardFrameCache`.
 *
 * `inputs`: **cannot** use ready-made upstream keys from `cardNodeIdentities`; those keys contain
 * upstream clip clipIds, so the same transition swapped to another clip would no longer be shared.
 * Pass `{}` when the output node has no upstream; when it has upstream (when a clip attaches
 * emphasis, filters, or sound effects, the output node is the outer layer and the card is behind
 * its input; for media effect cards, media is behind its input), pass the entry computed for this
 * node by `cardSnapshotInputKeys`: each upstream strips its clipId and computes upward along inputs
 * layer by layer. Omitting it leads to two clips that are "identical outside, different inside"
 * having the same key and fetching each other's prerender outputs.
 *
 * Clip frame dimensions: resolved with `resolveFrameSize` in `src/kernel/frameSize.mjs`, sharing the
 * same implementation with `resolveFrame` in stage `layout.ts` (chosen over computing on the
 * browser side and passing in: the Node side must also recompute keys independently, while
 * `__pcCardPlan` is only responsible for providing `environment`). If the caller has already
 * computed them, `frameWidth` / `frameHeight` can also be passed directly to override.
 *
 * Excluded from key: x / y / anchor / scale / rotate, opacity, fade in/out, motion, emphasis: after
 * A2(5) these are not in snapshots; the same shared snapshot attached at two positions is rendered
 * in each respective frame.
 * Included in key: parameters, source version, clip duration, sample phase, fps, frame dimensions,
 * aspect ratio, `camera3dFov`, parts, theme id, `fontFingerprint`, `snapshotCode`, `capabilities`
 * (review table contents, already in the node).
 */
export function cardSnapshotIdentity(node, {
  definition, style = {}, environment = {}, sourceVersions = {}, sourceVersion,
  inputKeys = {}, fps, sampling, phase = sampling?.phase, duration,
  stage = {}, frame, frameWidth, frameHeight,
  themeId, fontFingerprint = '', snapshotCode = '',
} = {}) {
  const { id: _id, inputs: _inputs, definitionId: _definitionId, clipId: _clipId, ...stripped } = node ?? {};
  const usedStyle = definition ? selectedCardStyle(definition, style) : stripped.adapter === 'chrome' ? style : {};
  const parent = { width: stage.width, height: stage.height };
  const size = resolveFrameSize(frame, parent);
  return digest({
    abi: CARD_RUNTIME_ABI, environment, node: stripped, definition, style: usedStyle,
    sourceVersion: sourceVersion ?? (stripped.cardId ? sourceVersions[stripped.cardId] : undefined),
    inputs: inputKeys,
    // The snapshot-specific section is placed separately to avoid name collisions with the node's own
    // fields; the input structure of `cardNodeIdentities` is preserved as-is above, so keys from the two
    // functions will never equal each other (this section is always present).
    snapshot: {
      fps: ratio(fps), phase: ratio(phase), duration,
      stage: { width: parent.width, height: parent.height, camera3dFov: stage.camera3dFov },
      frame: { width: frameWidth ?? size.w, height: frameHeight ?? size.h },
      themeId, fontFingerprint, snapshotCode,
    },
  });
}

/**
 * The entry for each node's upstream in the shared snapshot key:
 * `node id → { inputName: { key, offset, rate } }`, passed to `inputKeys` of `cardSnapshotIdentity`
 * (`CardFrameCache.plan` fetches this once per output node; both the content key of a shared snapshot
 * and the member key of a single-card stream use it).
 *
 * The shape is identical to `inputs` in `cardNodeIdentities`, except that the upstream `key` uses
 * a different algorithm: on top of `id` / `inputs` / `definitionId`, the upstream node's identity
 * **further strips `clipId`** (just as `cardSnapshotIdentity` does for output nodes), and its own
 * upstreams are computed layer by layer up the chain in the same way. Therefore:
 *
 *   - For two clips that are identical on the outside but different on the inside (two different
 *     cards with the same emphasis attached, the same card with different parameters, different
 *     card source code versions, the same media effect card connected to different media, different
 *     input time mappings, or a different layer in the middle of the chain), this entry differs, so
 *     the key also differs;
 *   - For two clips that are identical inside and out, this entry is identical: upstream identities
 *     do not contain the clip id, so two clips of the same card still share one copy;
 *   - **For nodes with no upstream, this entry is `{}`**, verbatim identical to the previous
 *     `inputKeys: {}` form; the keys of such clips do not change by a single character.
 *
 * An upstream's identity does not contain the clip's duration, phase, or box: those are in the
 * `snapshot` section of `cardSnapshotIdentity`, taken from the clip where the output node resides;
 * when an upstream is in the same clip (emphasis, filter, sound effects, a media effect card connecting
 * to its own media), this is sufficient. When the upstream is a node of **another clip** (a transition
 * connecting two media clips), that clip's in point relative to this one does not enter the key, and
 * `cardNodeIdentities` is the same (it deliberately omits temporal placement). Source-dependent cards
 * now each produce a single-card stream (`soloStreamKind` in `frame-stream.mjs`); this spot was checked
 * and does not need patching: the moment a media effect card fetches its input is "this card's own
 * time × input rate + input offset + trim start of that media clip" (`renderNode` in
 * `src/render/cards/GraphCard.tsx`); which frame of the timeline that clip is placed at is not an input
 * to the visual frame; all of the above are on nodes and edges and have already entered the key.
 *
 * Inputs pointing to deleted clips: `validateCardGraph` drops the edge and records the name in
 * the node's `missingInputs`, which remains on the node and enters the digest together.
 */
export function cardSnapshotInputKeys(graph, { style = {}, environment = {}, sourceVersions = {} } = {}) {
  const { nodes, levels } = validateCardGraph(graph);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const definitions = new Map((graph.definitions ?? []).map(def => [def.id, def]));
  const upstream = new Map(); // Node id → its identity when acting as upstream to others (without the clip id)
  const inputKeys = new Map();
  for (const level of levels) for (const id of level) {
    const { id: _id, inputs, definitionId, clipId: _clipId, ...node } = byId.get(id);
    const own = Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name,
      { key: upstream.get(input.nodeId), offset: input.offset, rate: input.rate }]));
    inputKeys.set(id, own);
    const definition = definitions.get(definitionId);
    const usedStyle = definition ? selectedCardStyle(definition, style) : node.adapter === 'chrome' ? style : {};
    upstream.set(id, digest({ abi: CARD_RUNTIME_ABI, environment, node, definition, style: usedStyle,
      sourceVersion: node.cardId ? sourceVersions[node.cardId] : undefined, inputs: own }));
  }
  return inputKeys;
}

/**
 * Stream key of track streams (R8; the task brief says the naming of `streamKey` is decided in this
 * task, with A3b aligning later: using `streamKey` here for now).
 *
 * Two stream types with different key criteria:
 *
 *   - **Single-card stream** (`kind: 'card'`): the visual frame is in the **wrapper layer's own
 *     coordinate system** (just like snapshots; after A2(5), x / y / scale / rotation / opacity /
 *     fade / motion / emphasis are not included, added as usual by the wrapper layer), so content
 *     identity uses shared snapshot key `snapshotKey` (shared with the same parameters and same box
 *     width and height); plus **temporal placement** (`sampling`: first frame, phase, fps): streams
 *     are segmented by **global frame numbers** (G4: time is not shifted), so shifting the in point
 *     by one frame offsets the content in the segment by one frame overall, preventing reuse;
 *   - **Group stream** (`kind: 'group'`): the visual frame is in stage coordinates, and `frameCss` /
 *     `opacity` / `filter` / `motion` of the wrapper layer are all already rendered into the
 *     stream (G1), so each card uses the cached key with appearance `control.key`, ordered in
 *     painter's order.
 *
 * Both include aspect ratio, fps, and `codeVersion` (code fingerprint that produced this stream:
 * if any of the screenshot / encoding files change, old streams are entirely invalidated).
 * **Rectangles and encoders do not enter the stream key**: they only determine segment "variants"
 * (different `init`), and pages look up their own `init` per segment; see `server/frame-stream.mjs`.
 *
 * A third type, **below-dependent stream** (`kind: 'below'`, `docs/plan/prerender-products-contract.md`
 * Section 5.2): the target card is rendered together with the layers below it, produced in stage
 * coordinates. There is only one member (the target card); see `belowStreamIdentity` for its key;
 * digests of the two types above remain verbatim unchanged.
 */
export function cardStreamIdentity({ kind = 'card', members = [], fps, stage = {}, codeVersion = '', below = null } = {}) {
  if (kind === 'below') return belowStreamIdentity({ members, fps, stage, codeVersion, below });
  if (kind !== 'card' && kind !== 'group') throw new Error(`Unknown stream kind ${kind}`);
  if (!members.length) throw new Error('A stream needs at least one card');
  return digest({
    stream: 1, kind, fps: ratio(fps), codeVersion,
    stage: { width: stage.width, height: stage.height, camera3dFov: stage.camera3dFov },
    members: members.map(m => ({
      key: m.key,
      firstFrame: m.sampling?.firstFrame,
      phase: m.sampling?.phase ? ratio(m.sampling.phase) : undefined,
      count: m.count,
      frame: m.frame,
    })),
  });
}

/**
 * Version of **what is stored** inside below-dependent streams. Incremented each time the stream
 * payload changes: when the switch is on (`belowStreamsEnabled`), segments produced by the old method
 * will not be pasted by the new reader. Leaves `STREAM_CODE_VERSION` untouched: that one governs
 * all streams.
 *
 *   0  Identity only (this file) and planning (`planStreams` in `frame-stream.mjs`); the stream
 *      contains full screenshots (including lower layers) following the single-card stream approach;
 *   1  Differential layer extraction (Contract Section 5.3, `./bakery/capture-below.mjs`): the stream
 *      contains the layer that "when overlaid on the frame with only lower layers, yields exactly
 *      the frame with the target card", with untouched areas of the target card fully transparent;
 *   2  For below-dependent streams that need playback, also draw frames that are stepped through
 *      without capturing (`BELOW_DISCARD_SHOT` in `frame-stream.mjs`): previously in sparse versions
 *      and segments re-produced after broken leases, motion-style cards mounted midway in lower
 *      layers would lag behind by several frames.
 */
export const BELOW_STREAM_VERSION = 2;

/**
 * Content key of below-dependent streams (`kind: 'below'`). The digest contains (Contract Section 5.2):
 *
 *   - **Target card** (`members` has exactly one item): cache content key with appearance
 *     (`control.cacheContentKey`: position, scale, rotation, opacity, fade, and trajectory are all
 *     included: this stream type is produced in stage coordinates, with appearance rendered into
 *     the stream), plus the first sampling frame, phase, and frame count;
 *   - **Lower layers** (`below.layers`): every visual layer ordered below the target card in
 *     painter's order whose active time overlaps with it, with each layer's cache content key,
 *     first frame, phase, and frame count, **arranged in a list in painter's order** (lower layers
 *     first). Each item may additionally include `extra`: project data that alters this layer's
 *     visual frame but is not covered by the cache content key (currently pixel maps of media clips;
 *     see `belowLayerExtra` in `frame-stream.mjs`);
 *   - Aspect ratio, frame rate, and `codeVersion`, same as other streams; plus `BELOW_STREAM_VERSION`.
 *
 * Therefore, if parameters, position, timing, or stacking order of any lower layer change, or if
 * a lower layer is added or removed, the key changes; changes to layers stacked above never alter
 * it (`mechanism/cards.md` "Axis 3": prerender output of below-dependent cards is invalidated whenever
 * parameters of any lower-layer control at the same moment change).
 *
 * When the key of a lower layer cannot be computed, producing a key from an incomplete list is
 * prohibited: the caller instead passes `below.scene` (the key of the entire project, `entry.key`),
 * so the digest contains only the target card plus this single key: coarser (any change in the
 * project invalidates it), but safe. Throws if neither `layers` nor `scene` is provided, or if any
 * item lacks a key.
 */
function belowStreamIdentity({ members = [], fps, stage = {}, codeVersion = '', below = null } = {}) {
  if (members.length !== 1) throw new Error('A stream that depends on lower layers has only the target card as its member');
  const scene = below?.scene;
  const layers = below?.layers;
  if (scene !== undefined && scene !== null && (typeof scene !== 'string' || !scene)) throw new Error('Stream that depends on lower layers: the key for the whole project is invalid');
  if (!scene && !Array.isArray(layers)) throw new Error('Stream that depends on lower layers: provide the keys of the lower layers, or the key of the whole project');
  const item = m => {
    if (typeof m?.key !== 'string' || !m.key) throw new Error('Stream that depends on lower layers: one layer has no key');
    return {
      key: m.key,
      firstFrame: m.sampling?.firstFrame,
      phase: m.sampling?.phase ? ratio(m.sampling.phase) : undefined,
      count: m.count,
      extra: m.extra,
    };
  };
  return digest({
    stream: 1, kind: 'below', below: BELOW_STREAM_VERSION, fps: ratio(fps), codeVersion,
    stage: { width: stage.width, height: stage.height, camera3dFov: stage.camera3dFov },
    members: members.map(item),
    ...(scene ? { scene } : { layers: layers.map(item) }),
  });
}

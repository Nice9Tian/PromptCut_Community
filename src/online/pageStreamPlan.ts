/**
 * **Plan** for stream generation on this page (task brief `docs/plan/render-refactor-task.md`
 * "Jia-2"): for the same single-card track stream, the result key, stream task shape, and row in the
 * layer table computed on the page side are field-by-field identical to those computed by the splitter
 * (desktop app, render host).
 *
 * Stream planning was originally computed on the server side (`CardFrameCache.plan` in
 * `server/card-cache.mjs` -> `planStreams` in `server/frame-stream.mjs` -> stream tasks emitted for the
 * browser by `server/render-node/split.mjs` -> `layerStreamsOf` in `server/artifact-transfer.mjs`), but
 * the page build does not include server modules. Here, the **pure computation** along this chain is
 * duplicated (precedent: `planPublisher.ts` vs `server/render-queue/messages.mjs`), and
 * `server/test/page-stream-plan.test.mjs` takes the same input to cross-check field-by-field against
 * those server functions. If the server side changes, this must follow; otherwise the cross-check will
 * fail red.
 *
 * # Two implementation-related parts of keys, each occurring only once
 *
 *   - **Member key** `streamMemberKey`: the item in a single-card stream representing "this card's
 *     content". Identical to `streamMemberKey` in server-side `CardFrameCache.plan` (the identity from
 *     `cardSnapshotIdentity`, without the code fingerprint for snapshot generation: stream pixels come
 *     from screenshots and are independent of how snapshot HTML is generated). Do not assemble this
 *     key elsewhere; if the server algorithm changes again, only modify this single function;
 *   - **Stream code version** `streamCodeVersion`: `<STREAM_CODE_VERSION>:<screenshot code fingerprint>`.
 *     The version number `PAGE_STREAM_CODE_VERSION` has the same value as `STREAM_CODE_VERSION` in
 *     `server/frame-stream.mjs` (cross-checked), and the screenshot code fingerprint is embedded into
 *     the page by the online build (`pageStreamCodes`).
 *
 * # Which streams the page computes
 *
 * Only computes single-card streams, and only those that the splitter emits for the browser (first
 * location in `browser-stream-task.md`): shared tier (stateful cards), standalone cards, not canvas
 * cards, bounding box has no 3D, and track is not hidden. Standalone cards flattened from cut segments
 * (the `'flat'` emitted as individual streams by the splitter) whose outer boxes are planar also count
 * ([ruling] R02: online browser also produces streams for heavy cards in cut segments; splitter emits
 * this part for the browser, see `browserStreamInputOf` in `render-node/split.mjs`): they are not
 * merged into group streams, but are only counted toward the budget according to the splitter's
 * algorithm, each producing a single-card stream. When cards in the manifest exceed the decoder budget,
 * they are merged using the splitter's same method (`groupStreams`; the two types of streams emitted by
 * the splitter but not produced on the page: two categories of cards streaming individually and
 * below-dependent streams: are counted toward the budget using the same criterion
 * `render/streamPlanRules.mjs`), while cards merged into group streams are not produced by the page
 * (browsers cannot render group streams). Two additional constraints are stricter than the splitter's
 * ([ruling], see "Stream generation on this page" in `browser-stream-task.md`): only built-in cards
 * bundled with the page are computed (source versions starting with `builtin:`; source versions of
 * synced user cards cannot be reliably computed on the page side, and miscalculations cause keys to
 * remain unchanged after card edits), and only clips whose output node is the card itself are computed
 * (when clips have attached filters or emphasis, the output node is the outer layer, and the key lacks
 * card parameters).
 *
 * Hashing uses the browser's built-in `crypto.subtle` (async); Node unit tests also provide the global
 * object of the same name. This module belongs to the render layer (`src/online/`): it does not import
 * editor, does not touch the registry (card graph and source versions are precomputed and passed in by
 * callers), and does not touch the stage or network.
 */
import { CARD_RUNTIME_ABI, selectedCardStyle } from "../kernel/cardGraph.mjs";
import { resolveFrameSize } from "../kernel/frameSize.mjs";
import { mountFrameOf } from "../render/frameWindow.mjs";
import { streamInputSig, streamSigStale } from "../render/streamInputSig.mjs";
import { isStreamOrigin, streamSegmentFrameCount, streamSegmentSpan, STREAM_SEGMENT_FRAMES } from "../render/streamSegments.mjs";
import { belowTargets, frame3d, mountClipOf, soloStreamKind, streamEligible } from "../render/streamPlanRules.mjs";
import { groupStreams, localStreamPixels, stageStreamPixels, streamCost, STREAM_COUNT_BUDGET, type StreamBudget, type StreamGroupItem } from "../render/streamBudget.mjs";
import { reviewedCard } from "../kernel/frameMode.mjs";
import { flatPlanProject } from "../kernel/cutFlatten.mjs";
import { activeCutKind } from "../kernel/camera.mjs";
import { has3DFrameExpr, hasAnimatedFrameSize } from "../kernel/frameExpr.mjs";
import type { NodeTask, StreamTaskInput } from "./browserNode.ts";

/**
 * Same value as `STREAM_CODE_VERSION` in `server/frame-stream.mjs` (cross-checked). 2: starting from
 * "Ji-1", member keys of single-card streams exclude code fingerprints for snapshot generation;
 * 3: segmentation runs every 15 frames starting from this stream's own first frame
 * (`render/streamSegments.mjs`), and legacy streams are all re-produced;
 * 4: in the sparse version, each segment captures only the first frame, and each segment in the
 * manifest includes a position rectangle `box`.
 */
export const PAGE_STREAM_CODE_VERSION = 4;
/**
 * Upper limit on concurrent on-screen streams: same value as `STREAM_DECODER_BUDGET` in
 * `server/frame-stream.mjs` (`render/streamBudget.mjs`); budget criteria (pixel count) are also there
 */
export const PAGE_STREAM_DECODER_BUDGET = STREAM_COUNT_BUDGET;
/** Same value as `LOCAL_OVERFLOW_PX` in `server/frame-stream.mjs` */
export const PAGE_LOCAL_OVERFLOW_PX = 32;
/**
 * Number of segments per stream task (same value as `QUEUE_DEFAULTS.STREAM_SEGMENTS` in
 * `server/render-queue/constants.mjs`): stream manifests are split by it
 */
export const PAGE_STREAM_SEGMENTS_PER_TASK = 8;
/**
 * Layer table version and snapshot span length (same value as `LAYER_MAP_VERSION` and
 * `QUEUE_DEFAULTS.SNAPSHOT_SPAN` in `server/artifact-transfer.mjs`)
 */
export const PAGE_LAYER_MAP_VERSION = 3;
export const PAGE_SNAPSHOT_SPAN = 60;

/* ------------------------------------------------------------------ Code fingerprint embedded into the page by the online build */

/**
 * Code-related item in the stream key: fingerprint of the screenshot code (`captureCode` in
 * `server/frame-code.mjs`, second half of the stream's `codeVersion`)
 */
export interface StreamCodes { capture: string }

declare const __PC_STREAM_CODES__: { capture?: unknown } | undefined;

/**
 * Code fingerprint calculated by `vite.config.ts` during online build using the same server-side
 * algorithm and embedded into the page as `__PC_STREAM_CODES__`; absent in desktop builds and Node
 * unit tests, returning null (no stream generation on this page: cannot compute keys identical to the
 * splitter).
 */
export function pageStreamCodes(): StreamCodes | null {
  const raw = typeof __PC_STREAM_CODES__ === "object" && __PC_STREAM_CODES__ ? __PC_STREAM_CODES__ : null;
  if (!raw || typeof raw.capture !== "string" || !raw.capture) return null;
  return { capture: raw.capture };
}

/* ------------------------------------------------------------------ Hashing (same as `server/frame-identity.mjs`) */

/** Same formula as `stableJson` in `server/frame-identity.mjs`: sorts keys and removes undefined */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return "{" + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ":" + stableJson(o[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

async function sha256Text(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let out = "";
  for (const b of new Uint8Array(buf)) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Same value as `digest` in `server/frame-identity.mjs` */
export const digest = (value: unknown): Promise<string> => sha256Text(stableJson(value));

/**
 * Result key = content key × environment fingerprint (same value as `resultKeyOf` in
 * `server/render-node/fingerprint.mjs`)
 */
export const resultKeyOf = (contentKey: string, envFingerprint: string): Promise<string> => sha256Text(`${contentKey ?? ""}\n${envFingerprint ?? ""}`);

/* ------------------------------------------------------------------ Sampling (same as `server/card-identity.mjs`) */

interface Ratio { numerator: string; denominator: string }
export interface CardSampling { firstFrame: number; fps: Ratio; phase: Ratio }

const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; while (b) { const next = a % b; a = b; b = next; } return a || 1n; };
const reduce = (n: bigint, d: bigint) => { if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d); return { n: n / g, d: d / g }; };
function decimal(value: number) {
  if (!Number.isFinite(value)) throw new Error("Non-finite card clock");
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(value))!;
  const power = Number(match[4] ?? 0) - (match[3]?.length ?? 0);
  let n = BigInt(match[2] + (match[3] ?? "")) * (match[1] ? -1n : 1n), d = 1n;
  if (power >= 0) n *= 10n ** BigInt(power); else d = 10n ** BigInt(-power);
  return reduce(n, d);
}
const ceilDiv = (n: bigint, d: bigint) => (n >= 0n ? (n + d - 1n) / d : n / d);
const pair = (value: { n: bigint; d: bigint }): Ratio => ({ numerator: String(value.n), denominator: String(value.d) });
const ratio = (value: unknown): Ratio | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "object") { const v = value as Ratio; return pair(reduce(BigInt(v.numerator), BigInt(v.denominator))); }
  return pair(decimal(Number(value)));
};

/**
 * Same value as `cardSampling` in `server/card-identity.mjs`: when the in point falls between frames,
 * the first frame takes the first sample point after the in point, and the phase records the
 * difference
 */
export function cardSampling(start: number, fps: number): CardSampling {
  if (!(fps > 0)) throw new Error("Invalid card frame rate");
  const s = decimal(start), rate = decimal(fps);
  const first = ceilDiv(s.n * rate.n, s.d * rate.d);
  if (first > BigInt(Number.MAX_SAFE_INTEGER) || first < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error("Card frame out of range");
  const phase = reduce(first * rate.d * s.d - s.n * rate.n, rate.n * s.d);
  return { firstFrame: Number(first), fps: pair(rate), phase: pair(phase) };
}

/* ------------------------------------------------------------------ Keys */

export interface StageSize { width: number; height: number; camera3dFov?: unknown }

/**
 * **Member key** of a single-card stream (content identity of this card; stream content key takes it
 * and adds temporal placement, aspect ratio, frame rate, and stream code version).
 *
 * Identical to `streamMemberKey` in server-side `CardFrameCache.plan` (`planStreams` uses it as the
 * member key): the identity from `cardSnapshotIdentity`, where the code fingerprint for snapshot
 * generation is an empty string. Clip identity (node id, inputs, definition id, clip id) is stripped
 * away, while parameters, source version, clip duration, sampling phase, frame rate, box width/height,
 * aspect ratio, theme, and font fingerprints are included; position, scale, rotation, opacity,
 * fade-in/fade-out, motion, and emphasis are excluded (added by the wrapper layer).
 *
 * **This is the only place on the entire page side that constructs the member key.** If the
 * server-side algorithm changes again, modify here, keep `PAGE_STREAM_CODE_VERSION` in sync, and
 * cross-check unit tests will pass again.
 */
export function streamMemberKey(o: {
  node: Record<string, unknown>;
  definition?: Record<string, unknown>;
  style: Record<string, unknown>;
  environment: Record<string, unknown>;
  sourceVersions: Readonly<Record<string, string>>;
  fps: number;
  sampling: CardSampling;
  duration: number;
  stage: { width: unknown; height: unknown; camera3dFov?: unknown };
  frame: { w?: number; h?: number } | undefined;
  themeId: unknown;
}): Promise<string> {
  const { id: _id, inputs: _inputs, definitionId: _definitionId, clipId: _clipId, ...stripped } = o.node ?? {};
  const usedStyle = o.definition ? selectedCardStyle(o.definition as never, o.style) : stripped.adapter === "chrome" ? o.style : {};
  const parent = { width: o.stage.width as number, height: o.stage.height as number };
  const size = resolveFrameSize(o.frame as never, parent);
  const cardId = typeof stripped.cardId === "string" ? stripped.cardId : "";
  return digest({
    abi: CARD_RUNTIME_ABI, environment: o.environment, node: stripped, definition: o.definition, style: usedStyle,
    sourceVersion: cardId ? o.sourceVersions[cardId] : undefined,
    inputs: {},
    snapshot: {
      fps: ratio(o.fps), phase: ratio(o.sampling.phase), duration: o.duration,
      stage: { width: parent.width, height: parent.height, camera3dFov: o.stage.camera3dFov },
      frame: { width: size.w, height: size.h },
      themeId: o.themeId, fontFingerprint: (o.environment?.fontFingerprint as string) || "", snapshotCode: "",
    },
  });
}

/**
 * Stream code version (`codeVersion` in the key): same shape as the string passed to `planStreams`
 * across `frame-pipeline.mjs`
 */
export const streamCodeVersion = (codes: StreamCodes): string => `${PAGE_STREAM_CODE_VERSION}:${codes.capture || ""}`;

/**
 * Content key of a single-card stream (same value as `cardStreamIdentity({ kind: 'card', … })` in
 * `server/card-identity.mjs`)
 */
export function cardStreamContentKey(o: { memberKey: string; sampling: CardSampling; count: number; fps: number; stage: StageSize; codeVersion: string }): Promise<string> {
  return digest({
    stream: 1, kind: "card", fps: ratio(o.fps), codeVersion: o.codeVersion,
    stage: { width: o.stage.width, height: o.stage.height, camera3dFov: o.stage.camera3dFov },
    members: [{ key: o.memberKey, firstFrame: o.sampling?.firstFrame, phase: o.sampling?.phase ? ratio(o.sampling.phase) : undefined, count: o.count, frame: undefined }],
  });
}

/* ------------------------------------------------------------------ Rectangles and placement (same as `server/frame-stream.mjs`) */

export interface Rect { x: number; y: number; w: number; h: number }
const rectOf = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) });
const intersectRect = (a: Rect, b: Rect) => rectOf(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.min(a.x + a.w, b.x + b.w), Math.min(a.y + a.h, b.y + b.h));
const padRect = (r: Rect, pad: number) => rectOf(r.x - pad, r.y - pad, r.x + r.w + pad, r.y + r.h + pad);

/**
 * Round to integers and expand outwards to even width and even height without exceeding `limit`
 * (same formula as server-side `evenRect`)
 */
export function evenRect(r: Rect, limit: Rect): Rect {
  let x0 = Math.floor(r.x), y0 = Math.floor(r.y), x1 = Math.ceil(r.x + r.w), y1 = Math.ceil(r.y + r.h);
  const lx0 = limit.x, ly0 = limit.y, lx1 = limit.x + limit.w, ly1 = limit.y + limit.h;
  x0 = Math.max(x0, lx0); y0 = Math.max(y0, ly0); x1 = Math.min(x1, lx1); y1 = Math.min(y1, ly1);
  if (x1 - x0 < 2) { x1 = Math.min(lx1, x0 + 2); x0 = x1 - 2; }
  if (y1 - y0 < 2) { y1 = Math.min(ly1, y0 + 2); y0 = y1 - 2; }
  if ((x1 - x0) % 2) { if (x1 < lx1) x1++; else x0--; }
  if ((y1 - y0) % 2) { if (y1 < ly1) y1++; else y0--; }
  return rectOf(x0, y0, x1, y1);
}

/**
 * Where this card's bounding box is placed in the isolated project, and upper bound of the stream's
 * rectangle (same formula as server-side `localPlacement`)
 */
export function localPlacement(clip: { frame?: { w?: number; h?: number } }, stage: StageSize): { offset: { x: number; y: number }; bound: Rect } {
  const size = resolveFrameSize(clip.frame as never, stage);
  const w = Math.max(2, Math.ceil(size.w)), h = Math.max(2, Math.ceil(size.h));
  const ox = Math.max(0, Math.floor((stage.width - w) / 2));
  const oy = Math.max(0, Math.floor((stage.height - h) / 2));
  const view = { x: -ox || 0, y: -oy || 0, w: stage.width, h: stage.height };
  const bound = evenRect(intersectRect(view, padRect({ x: 0, y: 0, w, h }, PAGE_LOCAL_OVERFLOW_PX)), view);
  return { offset: { x: ox, y: oy }, bound };
}

/* ------------------------------------------------------------------ Painter's order and group streams (same as `server/frame-stream.mjs`) */

interface AnyClip { id: string; start: number; end: number; cardId?: string; mediaId?: string; frame?: any; [k: string]: any }
type AnyTrack = { id?: string; hidden?: boolean; sourceOnly?: boolean; clips?: AnyClip[] };
interface PaintLayer { clipId: string; order: number; from: number; to: number }

function paintLayers(project: { tracks?: AnyTrack[]; media?: { id: string; kind?: string }[] }, fps: number): PaintLayer[] {
  const tracks = project?.tracks ?? [];
  const media = new Map((project?.media ?? []).map((m) => [m.id, m]));
  const out: PaintLayer[] = [];
  tracks.forEach((track, ti) => {
    if (track.hidden || track.sourceOnly) return;
    (track.clips ?? []).forEach((clip, ci) => {
      const card = !!clip.cardId;
      const m = clip.mediaId ? media.get(clip.mediaId) : null;
      if (!card && !(m && m.kind !== "audio")) return;
      const from = card ? mountFrameOf(clip, fps) : Math.max(0, Math.floor(clip.start * fps));
      const to = Math.max(from, Math.ceil(clip.end * fps - 1e-9) - 1);
      out.push({ clipId: clip.id, order: (tracks.length - 1 - ti) * 1e6 + ci, from, to });
    });
  });
  return out.sort((a, b) => a.order - b.order);
}

/**
 * Group stream merging is in `render/streamBudget.mjs` (`groupStreams`), using the exact same
 * function as the splitter
 */
type Single = StreamGroupItem;

/* ------------------------------------------------------------------ Cards in this version (same as `CardFrameCache.plan`) */

/**
 * Page-side raw inputs for "card plan": same shape as `window.__pcCardPlan()` on export page
 * (`{ graph, sourceVersions, environment }`), precomputed by caller
 */
export interface PageCardPlanValue {
  graph: { nodes: Record<string, any>[]; outputs: Record<string, any>[]; definitions?: Record<string, any>[] };
  sourceVersions: Readonly<Record<string, string>>;
  environment: { width?: unknown; height?: unknown; fps?: unknown; theme?: unknown; fontFingerprint?: string };
  unknownClipIds?: readonly string[];
}

/** Same formula as `snapshotTier` in `server/snapshot-tier.mjs` */
function snapshotTier(_caps: Record<string, any>): "none" | "shared" | "local" {
  return "none";
}

/** Plan for a card in this version (items used by the page in control of `CardFrameCache.plan`) */
export interface PageControl {
  clipId: string;
  cardId: string | null;
  nodeId: string;
  /** Output node (reshaped graph node) */
  node: Record<string, any>;
  definition?: Record<string, any>;
  capabilities: Record<string, any>;
  compositing: string;
  tier: "none" | "shared" | "local";
  frameMode?: "stateful" | "direct";
  needPrerendering?: boolean;
  start: number;
  end: number;
  count: number;
  sampling: CardSampling;
  frame: { w?: number; h?: number } | undefined;
}

/**
 * Each output of card graph → sampling window and capabilities of this card (same formula as
 * `CardFrameCache.plan`; keys computed separately, see `planPageStreams`)
 */
export function pageControls(project: { fps?: number }, value: PageCardPlanValue): PageControl[] {
  const graph = value?.graph;
  if (!graph?.nodes || !graph?.outputs) return [];
  const fps = Number(project.fps) || 30;
  const nodes = new Map(graph.nodes.map((node) => [node.id as string, node]));
  const definitions = new Map((graph.definitions || []).map((d) => [d.id as string, d]));
  const unknown = new Set(Array.isArray(value.unknownClipIds) ? value.unknownClipIds : []);
  const out: PageControl[] = [];
  for (const output of graph.outputs) {
    if (output?.clipId && unknown.has(output.clipId)) continue;
    const node = nodes.get(output.nodeId);
    const definition = definitions.get(node?.definitionId);
    const caps = output.capabilities || node?.capabilities || node?.definition?.capabilities || definition || {};
    const compositing = caps.compositing || node?.compositing || "unknown";
    const start = Number(output.start ?? node?.start ?? 0), end = Number(output.end ?? node?.end ?? start);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const sampling = cardSampling(start, fps);
    const phase = Number(sampling.phase.numerator) / Number(sampling.phase.denominator);
    const count = Math.max(1, Math.ceil((end - start - phase) * fps - 1e-9));
    const clipId = output.clipId || node?.clipId;
    if (!node || typeof clipId !== "string" || !clipId) continue;
    out.push({ clipId, cardId: typeof node.cardId === "string" ? node.cardId : null, nodeId: output.nodeId, node, definition, capabilities: caps, compositing,
      tier: snapshotTier(caps), frameMode: caps.frameMode, needPrerendering: caps.need_prerendering === true || caps.needPrerendering === true, start, end, count, sampling, frame: output.frame });
  }
  return out;
}

/* ------------------------------------------------------------------ Stream plan */

/**
 * Single-card stream computed by the page (fields used by the page from an item in `planStreams`,
 * with identical field names)
 */
export interface PageStreamSpec {
  kind: "card";
  plane: "local";
  clipIds: [string];
  topClipId: string;
  cardId: string | null;
  contentKey: string;
  /** Result key = content key × environment fingerprint of this page */
  streamKey: string;
  envFingerprint: string;
  fps: number;
  stage: StageSize;
  total: number;
  firstFrame: number;
  lastFrame: number;
  /**
   * First frame of this stream itself (project frame number): segments run every 15 frames starting
   * from it (`render/streamSegments.mjs`), so `firstSegment` is always 0
   */
  originFrame: number;
  firstSegment: number;
  lastSegment: number;
  offset: { x: number; y: number };
  bound: Rect;
  compositing: string;
  /**
   * Parameters required by the isolated single-card project (written by the splitter in `input.bake`
   * of the browser task)
   */
  bake: { start: number; end: number; count: number; sampling: CardSampling };
  writing?: "motion" | "remotion";
  frameMode?: "stateful" | "direct";
}

/** Determines whether a card or stream is a motion-style card (as opposed to remotion-style) */
export function isMotionCard(controlOrSpec: { writing?: string; frameMode?: string; cardId?: string | null; capabilities?: { writing?: string; frameMode?: string } } | null | undefined): boolean {
  if (!controlOrSpec) return true;
  const writing = controlOrSpec.writing ?? controlOrSpec.capabilities?.writing;
  if (writing === "remotion") return false;
  if (writing === "motion") return true;

  const cardId = controlOrSpec.cardId;
  if (cardId) {
    const rev = reviewedCard(cardId);
    if (rev?.writing === "remotion") return false;
    if (rev?.writing === "motion") return true;
  }

  const frameMode = controlOrSpec.frameMode ?? controlOrSpec.capabilities?.frameMode;
  if (frameMode === "direct") return false;
  if (frameMode === "stateful") return true;

  return false;
}


/** Why this card produces no stream on the page (for diagnostics); returns null if it can produce */
export function pageStreamBlock(control: PageControl, at: { clip: AnyClip; track: AnyTrack } | undefined, sourceVersions: Readonly<Record<string, string>>, project?: Record<string, any> | null): string | null {
  if (!at) return "no-clip";
  if (at.track.hidden || at.track.sourceOnly) return "hidden-track";
  if (!at.clip.cardId) return "not-card";
  // Stream eligibility (`streamEligible`): standalone card, bounding box has no 3D, has frames
  if (control.compositing !== "independent") return "not-independent";
  if (hasAnimatedFrameSize(at.clip.frameExpr)) return "frame-expr-size";
  if (project?.cutKind === "3d" || activeCutKind(project as any) === "3d" || frame3d(at.clip.frame) || has3DFrameExpr(at.clip.frameExpr)) return "frame-3d";
  if (!Number.isInteger(control.count) || control.count <= 0) return "no-frames";
  // Whether the browser can do it (`browserEligible` in `split.mjs`): stateful/need_prerendering
  // (light cards do not produce streams), not a canvas card
  const caps = control.capabilities ?? {};
  const isStateful = control.tier === "shared" || control.frameMode === "stateful" || caps.frameMode === "stateful" || (control as any).needPrerendering === true || caps.need_prerendering === true || caps.needPrerendering === true;
  if (!isStateful) return "not-shared-tier";
  if (caps.canvasHeavy === true) return "canvas";
  // [ruling] Two rules tighter than the splitter: only count built-in cards included with the page;
  // only count clips whose output node is this card itself
  if (control.node.adapter !== "chrome" || control.node.clipId !== control.clipId) return "wrapped-node";
  if (!control.cardId || !String(sourceVersions[control.cardId] ?? "").startsWith("builtin:")) return "not-builtin";
  return null;
}

export interface PageStreamPlan {
  specs: PageStreamSpec[];
  /**
   * Clips in the manifest that did not produce a stream → reason (reason in `pageStreamBlock`, or
   * `grouped`: exceeded decoder budget and entered group stream)
   */
  skipped: Record<string, string>;
}

/**
 * In this project version, single-card streams for each of the manifest `clips` (clips classified
 * as heavy by the page itself). These are the same batch of streams and same keys as those computed
 * by the splitter for the manifest plan (the copy emitted for the browser by `splitPlan` after
 * `planListStreams`): computed on both sides from the same `value`, `contentKey`, `streamKey`,
 * segment ranges, and rectangles are identical field-by-field.
 * Returns empty when there is no fingerprint, no code fingerprint, or the card graph cannot be
 * computed.
 */
export async function planPageStreams(o: {
  project: Record<string, any>;
  value: PageCardPlanValue;
  clips: Iterable<string>;
  codes: StreamCodes | null;
  envFingerprint: string | null;
  budget?: StreamBudget;
}): Promise<PageStreamPlan> {
  const { codes, envFingerprint } = o;
  // Cut segments replaced with the cards inside them (`kernel/cutFlatten.mjs`), same view as
  // the splitter's `planStreams` (kept as-is when there are no cut segments)
  const project = o.project ? flatPlanProject(o.project) : o.project;
  const empty: PageStreamPlan = { specs: [], skipped: {} };
  if (!project || !codes || typeof envFingerprint !== "string" || !envFingerprint) return empty;
  // The graph on the desktop side is retrieved from the export page via the debug protocol
  // (round-tripped through JSON once): round-tripped once here as well, so values that cannot be
  // transferred such as functions and undefined are absent on both sides
  const value = JSON.parse(JSON.stringify(o.value ?? null)) as PageCardPlanValue | null;
  if (!value?.graph) return empty;
  const listed = new Set(o.clips);
  const fps = Number(project.fps) || 30;
  const stage: StageSize = { width: Number(project.width) || 1920, height: Number(project.height) || 1080, camera3dFov: project.camera3dFov };
  const total = Math.max(1, Math.floor((Number(project.duration) || 0) * fps));
  const where = new Map<string, { clip: AnyClip; track: AnyTrack }>();
  for (const track of (project.tracks ?? []) as AnyTrack[]) for (const clip of track.clips ?? []) where.set(clip.id, { clip, track });
  const layers = paintLayers(project, fps);
  const orderOf = new Map(layers.map((l) => [l.clipId, l.order]));
  const skipped: Record<string, string> = {};
  // Whether to enter the stream follows the splitter's criteria (`streamEligible`); merging also
  // follows it: budget is calculated based on "all cards in the manifest that enter the stream",
  // not just the cards that the page can produce
  const singles: (Single & { control: PageControl; clip: AnyClip })[] = [];
  // The page does not produce the other two streams emitted by the splitter, only counting them into
  // the decoder budget following the splitter's same criteria (`render/streamPlanRules.mjs`):
  // two types of cards that stream solo (`soloStreamKind`, cost computed from its single-card stream
  // rectangle), and below-dependent streams (`belowTargets`, cost computed from the entire frame)
  const fixed: { from: number; to: number; cost: number }[] = [];
  const soloSeen = new Set<string>();
  // Standalone cards on the frame plane inside cut segments (splitter's `'flat'`, [ruling] R02): not
  // merged into group streams, only counted into budget following the splitter; the page also emits
  // a single-card stream for each of them
  const flats: { control: PageControl; clip: AnyClip; to: number }[] = [];
  const controls = pageControls(project, value);
  for (const control of controls) {
    if (!listed.has(control.clipId)) continue;
    const at = where.get(control.clipId);
    if (!at || !streamEligible(control, at.clip, at.track, project)) {
      const block = pageStreamBlock(control, at, value.sourceVersions ?? {}, project) ?? "not-eligible";
      const solo = at && !soloSeen.has(control.clipId) ? soloStreamKind(control, at.clip, at.track, project) : null;
      if (at && solo) {
        const first = control.sampling.firstFrame;
        const last = Math.min(total - 1, first + control.count - 1);
        // Playback origin is the same as the splitter: cards inside cut segments are counted from the
        // earliest frame mounted in the nested scene (`mountClipOf`; for other cards it is the card itself)
        if (last >= first) { soloSeen.add(control.clipId); fixed.push({ from: Math.min(mountFrameOf(mountClipOf(at.clip), fps), first), to: last, cost: streamCost(localStreamPixels(at.clip.frame, stage), fps) }); }
        if (last >= first && solo === "flat" && block === "not-eligible") { flats.push({ control, clip: at.clip, to: last }); continue; }
      }
      skipped[control.clipId] = block;
      continue;
    }
    const firstFrame = control.sampling.firstFrame;
    const lastFrame = Math.min(total - 1, firstFrame + control.count - 1);
    if (lastFrame < firstFrame) { skipped[control.clipId] = "past-end"; continue; }
    const mountFrame = mountFrameOf(at.clip, fps);
    singles.push({ control, clip: at.clip, clipIds: [control.clipId], order: orderOf.get(control.clipId) ?? 0, from: Math.min(mountFrame, firstFrame), to: lastFrame,
      cost: streamCost(localStreamPixels(at.clip.frame, stage), fps) });
  }
  singles.sort((a, b) => a.order - b.order);
  const byClip = new Map(singles.map((s) => [s.clipIds[0], s]));
  const stageCost = streamCost(stageStreamPixels(stage), fps);
  // Below-dependent streams: emitted by default by the splitter (`belowStreamsEnabled`, env var can
  // only be disabled on the prerender process side), and the page computes following the default
  for (const b of belowTargets(controls, { picked: (id) => listed.has(id), where, fps, total, orderOf, taken: soloSeen, project })) fixed.push({ from: b.from, to: b.to, cost: stageCost });
  const grouped = groupStreams(singles, layers, o.budget, fixed, stageCost);
  const codeVersion = streamCodeVersion(codes);
  const environment = (value.environment ?? {}) as Record<string, unknown>;
  const specs: PageStreamSpec[] = [];
  /**
   * Single-card stream of a card (wrapper layer's own coordinate system; appearance is not in
   * the stream), same formula as `cardSpec` in splitter's `planStreams`
   */
  const emit = async (control: PageControl, clip: AnyClip, to: number) => {
    const memberKey = await streamMemberKey({
      node: control.node, definition: control.definition, style: project.style || {}, environment, sourceVersions: value.sourceVersions ?? {},
      fps, sampling: control.sampling, duration: control.end - control.start,
      stage: { width: project.width, height: project.height, camera3dFov: project.camera3dFov },
      frame: control.frame, themeId: project.themeId,
    });
    const contentKey = await cardStreamContentKey({ memberKey, sampling: control.sampling, count: control.count, fps, stage, codeVersion });
    const streamKey = await resultKeyOf(contentKey, envFingerprint);
    const placement = localPlacement(clip, stage);
    const firstVisible = control.sampling.firstFrame;
    const isMotion = isMotionCard(control);
    specs.push({
      kind: "card", plane: "local", clipIds: [control.clipId], topClipId: control.clipId, cardId: control.cardId, contentKey, streamKey, envFingerprint,
      fps, stage, total, firstFrame: firstVisible, lastFrame: to,
      ...streamSegmentSpan(firstVisible, to),
      offset: placement.offset, bound: placement.bound, compositing: control.compositing,
      bake: { start: control.start, end: control.end, count: control.count, sampling: structuredClone(control.sampling) },
      writing: isMotion ? "motion" : "remotion",
      frameMode: (control.capabilities?.frameMode as any) || (isMotion ? "stateful" : "direct"),
    });
  };
  for (const g of grouped) {
    if (g.clipIds.length !== 1) { for (const id of g.clipIds) skipped[id] = "grouped"; continue; }
    const m = byClip.get(g.clipIds[0])!;
    const block = pageStreamBlock(m.control, where.get(m.control.clipId), value.sourceVersions ?? {}, project);
    if (block) { skipped[m.control.clipId] = block; continue; }
    await emit(m.control, m.clip, m.to);
  }
  // Standalone cards on the frame plane inside cut segments (already filtered above by
  // `pageStreamBlock`: failed only because it "does not enter group streams")
  for (const f of flats) await emit(f.control, f.clip, f.to);
  return { specs, skipped };
}

/* ------------------------------------------------------------------ Stream tasks and layer table row */

/**
 * Priority rank of sparse stream tasks (same number as `SPARSE_STREAM_PRIORITY` in
 * `server/render-node/split.mjs`; verified against unit tests)
 */
export const PAGE_SPARSE_STREAM_PRIORITY = 30;
/**
 * Density tag of sparse stream tasks (value of `input.density`, suffix of id; same string as
 * `STREAM_DENSITY_SPARSE` in `server/render-queue/messages.mjs`)
 */
const STREAM_DENSITY_SPARSE = "sparse";

/**
 * `[from, to]` closed interval: first .. last, one segment per span (same formula as `spans`
 * in `split.mjs`). If minSpan is specified and the tail segment is shorter than minSpan, it is
 * merged into the previous segment
 */
export function spansOf(first: number, last: number, span: number, minSpan = 1): [number, number][] {
  const out: [number, number][] = [];
  const step = Math.max(1, Math.floor(Number(span) || 0));
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return out;
  for (let from = first; from <= last; from += step) out.push([from, Math.min(last, from + step - 1)]);
  if (minSpan > 1 && out.length > 1) {
    const lastSpan = out[out.length - 1];
    if (lastSpan[1] - lastSpan[0] + 1 < minSpan) {
      out[out.length - 2][1] = lastSpan[1];
      out.pop();
    }
  }
  return out;
}

/**
 * Stream tasks for this stream, one per `PAGE_STREAM_SEGMENTS_PER_TASK` segments: id, result key,
 * range, and `input` are identical field-by-field to the copy emitted by the splitter for the
 * browser (`split.mjs`; `input.dual` is included only when the splitter emits both copies; here
 * on the page there is no other copy, so it is omitted). This page executes these tasks itself
 * without going through the queue; later if a splitter takes on the work and posts the same task to
 * the queue, the id will be identical, segments already pushed by this page are retained by task id,
 * and after claiming, only missing ones are backfilled.
 *
 * `o.density: 'sparse'`: emits **sparse stream tasks** for this stream (capturing only the first frame
 * of each segment), shaped identically to the sparse stream tasks emitted by the splitter: ranges
 * match full density tasks one by one (identical manifest keys in the content store), id ends with
 * `:sparse`, `input.density: 'sparse'`, `priority` 30 (`SPARSE_STREAM_PRIORITY` in `split.mjs`).
 * Omitted means full density tasks, verbatim identical to before.
 */
export function pageStreamTasks(spec: PageStreamSpec, o: { projectId: string; projectRev: number; codeVersion?: string | null; derivedFrom?: string | null; density?: "sparse" | null }): NodeTask[] {
  const sparse = o.density === STREAM_DENSITY_SPARSE;
  const isMotion = isMotionCard(spec);
  const fps = Number(spec.fps) > 0 ? Number(spec.fps) : 30;
  const motionSpan = Math.ceil(30 * fps / STREAM_SEGMENT_FRAMES);
  const span = sparse
    ? Math.max(1, spec.lastSegment - spec.firstSegment + 1)
    : isMotion
      ? motionSpan
      : PAGE_STREAM_SEGMENTS_PER_TASK;
  const minSpan = (!sparse && isMotion) ? motionSpan : 1;
  const stream: StreamTaskInput = { kind: "card", plane: "local", clipIds: [spec.topClipId], fps: spec.fps, bound: { ...spec.bound }, offset: { ...spec.offset },
    firstFrame: spec.firstFrame, count: spec.bake.count, total: spec.total, originFrame: spec.originFrame, lastFrame: spec.lastFrame };
  return spansOf(spec.firstSegment, spec.lastSegment, span, minSpan).map(([from, to]) => {
    const range = { unit: "segment", from, to };
    // Frame count for this segment task: each segment uses its actual frame count (the tail segment of
    // a stream can have fewer than 15 frames), same number as computed by the splitter
    let frames = 0;
    for (let n = from; n <= to; n++) frames += streamSegmentFrameCount(n, spec.originFrame, spec.lastFrame);
    return {
      id: `stream:${spec.streamKey}:${from}-${to}${sparse ? `:${STREAM_DENSITY_SPARSE}` : ""}`, kind: "stream", resultKey: spec.streamKey, range,
      source: { projectId: o.projectId, projectRev: o.projectRev, derivedFrom: o.derivedFrom ?? null },
      input: { clipId: spec.topClipId, cardId: spec.cardId ?? null, entryKey: null, contentKey: spec.contentKey, canvasHeavy: false,
        ...(sparse ? { density: STREAM_DENSITY_SPARSE } : {}),
        compositing: spec.compositing, bake: structuredClone(spec.bake), stream: structuredClone(stream) },
      weight: { class: "medium", estMs: null, frames },
      requires: { envFingerprint: spec.envFingerprint, ...(o.codeVersion ? { codeVersion: o.codeVersion } : {}), cardSources: {}, transcode: false,
        userCards: false, graphCards: false, belowDependent: false, capabilities: { streams: true } },
      priority: sparse ? PAGE_SPARSE_STREAM_PRIORITY : 10,
    } as NodeTask;
  });
}

/**
 * A row in the layer table `streams` table (same shape as written by `layerStreamsOf` in
 * `server/artifact-transfer.mjs`)
 */
export interface PageStreamRow {
  topClipId: string;
  clipIds: string[];
  kind: "card";
  plane: "local";
  contentKey: string;
  candidates: { envFingerprint: string; resultKey: string }[];
  /**
   * First frame of this stream itself (project frame number). `firstSegment` is omitted from the row
   * (always 0; see `layerStreamsOf` for rationale)
   */
  originFrame: number;
  lastSegment: number;
  segmentsPerTask: number;
  inputSig?: string;
}

/**
 * That row for this stream in the layer table; candidates contain only this page's copy (merged
 * with others' candidates when merging into the existing layer table, see `mergeLayerStreams`)
 */
export function pageStreamRow(project: unknown, spec: PageStreamSpec): PageStreamRow {
  const inputSig = streamInputSig(project, { clipIds: spec.clipIds, kind: spec.kind });
  return { topClipId: spec.topClipId, clipIds: [...spec.clipIds], kind: "card", plane: "local", contentKey: spec.contentKey,
    candidates: [{ envFingerprint: spec.envFingerprint, resultKey: spec.streamKey }],
    originFrame: spec.originFrame, lastSegment: spec.lastSegment, segmentsPerTask: PAGE_STREAM_SEGMENTS_PER_TASK, ...(inputSig ? { inputSig } : {}) };
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Merges this page's rows into the existing layer table in the content store (when there is no
 * splitter, nobody writes the layer table, so this page writes its `streams` portion). Returns the
 * whole table to write back; returns null with no write needed if the existing table already
 * contains these rows (this page's candidates are all present and ranked first).
 *
 *   - Existing table is not a recognized layer table (missing, unknown version, from another
 *     project): writes a new one with empty `layers` (this page does not write snapshot layers);
 *   - Other fields, `layers`, and streams of other cards are kept untouched in content and order
 *     (two pages writing their own cards will not flip them back and forth);
 *   - Rows for the same card and same content key: this page's candidate is moved to the front (this
 *     copy is actually produced; pages joining later take the first candidate), others' candidates
 *     remain behind;
 *   - Rows for the same card with other content keys: those with expired input signatures (streams
 *     from old parameters) are removed; unexpired ones (the same stream produced by another
 *     environment under its own key) are kept and placed after this page's row (when the same card
 *     has two rows, the page only recognizes the first row).
 */
export function mergeLayerStreams(existing: unknown, o: { project: Record<string, any>; rows: readonly PageStreamRow[]; now: number }): Record<string, unknown> | null {
  const { project, rows } = o;
  if (!rows.length) return null;
  const usable = isObj(existing) && existing.kind === "layer-map" && Array.isArray(existing.layers) && existing.v === PAGE_LAYER_MAP_VERSION
    && (existing.projectId == null || existing.projectId === (project.id ?? null));
  const base: Record<string, unknown> = usable ? { ...(existing as Record<string, unknown>) } : {
    v: PAGE_LAYER_MAP_VERSION, kind: "layer-map", projectId: project.id ?? null, entryKey: null,
    fps: Number(project.fps) || 30, width: Number(project.width) || null, height: Number(project.height) || null,
    span: PAGE_SNAPSHOT_SPAN, at: o.now, layers: [],
  };
  const old: Record<string, any>[] = usable && Array.isArray((existing as Record<string, unknown>).streams) ? ((existing as Record<string, unknown>).streams as Record<string, any>[]).filter(isObj) : [];
  const mine = new Map(rows.map((r) => [r.topClipId, r]));
  /**
   * This page's row, with candidates merged with others' candidates from existing rows with the same
   * content key (this page's candidate comes first)
   */
  const mergedRow = (next: PageStreamRow): Record<string, any> => {
    const others = old.filter((row) => row.topClipId === next.topClipId && row.contentKey === next.contentKey)
      .flatMap((row) => (Array.isArray(row.candidates) ? row.candidates : []))
      .filter((c: any, i: number, all: any[]) => isObj(c) && !next.candidates.some((m) => m.resultKey === c.resultKey) && all.findIndex((x: any) => x?.resultKey === c.resultKey) === i);
    return { ...next, candidates: [...next.candidates, ...others] };
  };
  const merged: Record<string, any>[] = [];
  const placed = new Set<string>();
  for (const row of old) {
    const next = typeof row.topClipId === "string" ? mine.get(row.topClipId) : undefined;
    if (!next) { merged.push(row); continue; }
    // Place this page's row at the position of this card's first row
    if (!placed.has(next.topClipId)) { merged.push(mergedRow(next)); placed.add(next.topClipId); }
    if (row.contentKey === next.contentKey) continue;
    if (streamSigStale(row.inputSig, next.inputSig)) continue;
    merged.push(row);
  }
  const fresh = rows.filter((r) => !placed.has(r.topClipId)).map((r) => ({ ...r, candidates: [...r.candidates] }));
  const streams = [...fresh, ...merged];
  if (usable && JSON.stringify(streams) === JSON.stringify(old)) return null;
  return { ...base, at: o.now, streams };
}

/**
 * A candidate of an existing stream for this card in the layer table, along with that row's segment
 * range (its manifest is chunked by this range)
 */
export interface LayerStreamCandidate { envFingerprint: string; resultKey: string; firstSegment: number; lastSegment: number; segmentsPerTask: number }

/**
 * In the existing layer table, which candidates of single-card streams are currently **playable**
 * for this card (used by "check first": produced by any environment counts). The criteria for
 * playable are the same as when playing from an online source (`streamStale` in `snapshotSource.ts`):
 * same content key, or unexpired input signature (counts even if that row has no signature).
 * Content keys computed by other environments may differ from this page's (different code version,
 * different loaded fonts), but if its input signature matches, the page would play it anyway: if
 * present, no need to produce it again.
 * Rows without `originFrame` do not count (written by nodes prior to segmenting rule changes, not
 * played by online source, `parseLayerStreams`); segment numbers start from 0.
 */
export function layerStreamCandidates(existing: unknown, row: { topClipId: string; contentKey: string; inputSig?: string | null }): LayerStreamCandidate[] {
  if (!isObj(existing) || existing.kind !== "layer-map" || !Array.isArray(existing.streams)) return [];
  const out: LayerStreamCandidate[] = [];
  for (const r of existing.streams as Record<string, any>[]) {
    if (!isObj(r) || r.topClipId !== row.topClipId || r.kind !== "card") continue;
    if (r.contentKey !== row.contentKey && streamSigStale(r.inputSig, row.inputSig)) continue;
    const firstSegment = 0, lastSegment = Number(r.lastSegment), segmentsPerTask = Number(r.segmentsPerTask);
    if (!isStreamOrigin(r.originFrame) || !Number.isInteger(lastSegment) || lastSegment < firstSegment || !Number.isInteger(segmentsPerTask) || segmentsPerTask < 1) continue;
    for (const c of Array.isArray(r.candidates) ? r.candidates : []) {
      if (isObj(c) && typeof c.envFingerprint === "string" && c.envFingerprint && typeof c.resultKey === "string" && c.resultKey && !out.some((x) => x.resultKey === c.resultKey)) {
        out.push({ envFingerprint: c.envFingerprint, resultKey: c.resultKey, firstSegment, lastSegment, segmentsPerTask });
      }
    }
  }
  return out;
}

/**
 * In this candidate's manifest, the range of chunks covering segments `[from, to]`; returns null
 * if candidate's segment range does not fully cover it
 */
export function candidateSpans(cand: LayerStreamCandidate, from: number, to: number): [number, number][] | null {
  if (cand.firstSegment > from || cand.lastSegment < to) return null;
  return spansOf(cand.firstSegment, cand.lastSegment, cand.segmentsPerTask).filter(([a, b]) => a <= to && b >= from);
}

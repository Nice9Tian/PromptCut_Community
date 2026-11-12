import type { CardDef, CardPart, CardTiming, ClipFrame, PartInstance } from "./types";
import { getPart } from "./partRegistry.ts";
import { partsTiming, placeParts, validatePartTree, type PartLookup } from "./parts.ts";
import type { Project, TrackClip } from "./project";
import { findClip } from "./project.ts";
import { visualBox, worldOf, type Box, type Size, type WorldPlacement } from "./layout.ts";
import { validateCardParams } from "./cardParams.ts";
import { has3DFrameExpr, normalizeFrameExprMap, type FrameExprMap } from "./frameExpr.mjs";
import { activeCutKind, effectiveCamera3dFov, type CutKind } from "./camera.mjs";

/**
 * Card contract (clip envelope): the only external representation of a card on the timeline.
 *
 * Previously, code pages and Agents saw the "raw" clip: a flat blob of parameters
 * `{ cardId, start, end, params }`, where position (frame), fades (fadeIn / fadeOut / opacity),
 * card part structure, and lifecycle were all missing, leaving questions like "what happens
 * after the animation ends at 3.2s", "can fade-out be added", and "which parameter controls
 * which piece" with nowhere to look.
 *
 * The envelope gathers these into a fixed-shape JSON:
 *   card      : which card this is, its lifecycle declaration (how long to settle, whether to
 *               freeze or loop afterwards, what exits are supported)
 *   time      : start, end, and duration
 *   frame     : stored local frame (null = fills stage) + computed absolute world position
 *               (world, read-only)
 *   blend     : opacity, fade-in and fade-out
 *   motion    : whether motion track is attached (read-only, track itself is not in envelope)
 *   parts     : part tree: each part carries its own parameter values (structured only if card
 *               declares parts; single root otherwise)
 *   params    : full parameters (two views of the same data alongside parts)
 *
 * Read: envelopeOf. Write: applyEnvelope, writing only parts differing from current state in a
 * fixed order (switch card → params → time range → frame → blend); each step dispatches existing
 * store actions, so undo stack, dirty flags, and Agent tool behaviors are completely consistent.
 * Media files and component source code are not in the envelope: Agents only manipulate
 * the envelope, not raw code.
 */

export const ENVELOPE_SCHEMA = "promptcut/clip-envelope@1";

export interface EnvelopePart {
  id: string;
  label: string;
  role?: CardPart["role"];
  enterMs?: number;
  settleMs?: number;
  /** Parameter values of this part itself (keys from CardPart.params; full instance parameters in composite cards) */
  params: Record<string, unknown>;
  children?: EnvelopePart[];
  /**
   * The following only exist on part instances in a **composite card** (parts in regular cards are
   * only specifications, without their own positions): partId references which part in the parts
   * library; frame.local is relative to parent frame and writable; frame.world is screen absolute
   * rectangle and read-only; after is this part's behavior after settling.
   */
  partId?: string;
  frame?: { local: ClipFrame | null; world: Box };
  after?: "hold" | "loop" | "evolve";
  /** Absolute entrance time relative to clip start (ms), read-only; enterMs remains relative to parent and writable */
  enterAtMs?: number;
}

export interface ClipEnvelope {
  $schema: typeof ENVELOPE_SCHEMA;
  id: string;
  card: {
    id: string;
    name: string;
    source: CardDef["source"];
    lifecycle: { settleMs?: number; after: "hold" | "loop" | "evolve"; exit: ("fade" | "reverse")[] };
    /** Composite card: parts is a mutable tree of part instances (add_part / set_part / remove_part / move_part, or write back the entire tree) */
    composite?: boolean;
  };
  time: { start: number; end: number; duration: number };
  frame: {
    /** Saved local box; null = fill the stage */
    local: ClipFrame | null;
    /** Optional per-field time expressions ("t", "d", "p") overriding static local fields */
    expr?: FrameExprMap | null;
    /** Absolute screen position calculated from local, read-only; ignored when writing back */
    world: WorldPlacement;
  };
  blend: { opacity: number; fadeIn: number; fadeOut: number };
  motion: { attached: boolean; mediaId?: string; whenHidden?: "hold" | "hide" };
  parts: EnvelopePart[];
  params: Record<string, unknown>;
  /** Parameters declared by card but missing in clip (old clips fall back to defaults for rendering) */
  missingParams?: string[];
}

/** Cards without lifecycle are treated as "has entrance animation, holds afterwards, fade-out only" */
const DEFAULT_LIFECYCLE: ClipEnvelope["card"]["lifecycle"] = { after: "hold", exit: ["fade"] };

function pick(params: Record<string, unknown>, keys: string[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys ?? []) if (k in params) out[k] = params[k];
  return out;
}

/**
 * Calculate timing from current parameters. If the card provides timing, use it (parameters are
 * first merged with defaults, identical to what is seen during rendering); if not given or
 * calculation fails, fall back to static declarations: timing is auxiliary information and must
 * not drag down the entire envelope.
 */
function timingOf(card: CardDef<any> | undefined, params: Record<string, unknown>): CardTiming {
  if (!card?.timing) return {};
  try {
    return card.timing({ ...card.defaults, ...params }) ?? {};
  } catch {
    return {};
  }
}

const roundMs = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? undefined : Math.round(v));

/** Fill card-declared part tree with current params; cards without parts are a root part owning all params */
function partsOf(card: CardDef<any> | undefined, params: Record<string, unknown>, timing: CardTiming): EnvelopePart[] {
  const fill = (p: CardPart): EnvelopePart => {
    const dyn = timing.parts?.[p.id];
    const enterMs = roundMs(dyn?.enterMs) ?? p.enterMs;
    const settleMs = roundMs(dyn?.settleMs) ?? p.settleMs;
    return {
      id: p.id,
      label: p.label,
      ...(p.role ? { role: p.role } : {}),
      ...(enterMs !== undefined ? { enterMs } : {}),
      ...(settleMs !== undefined ? { settleMs } : {}),
      params: pick(params, p.params),
      ...(p.children?.length ? { children: p.children.map(fill) } : {}),
    };
  };
  if (card?.parts?.length) return card.parts.map(fill);
  return [{ id: "root", label: card?.name ?? "Cards", role: "group", params: { ...params } }];
}

/** Composite card: part instance tree → parts in envelope, with visual position and timing per instance */
function compositePartsOf(tree: PartInstance[], parentBox: Box, clipWorld: WorldPlacement, lookup: PartLookup): { parts: EnvelopePart[]; settleMs: number; after: "hold" | "loop" | "evolve" } {
  /*
   * Pass the rectangle **after** scaling at root level: placeParts internal convention is
   * "parentBox is the world rectangle multiplied by scale + accumulated scale", and children restore
   * the parent box's logical size via width / scale; worldOf's box is the canvas before scaling,
   * and passing it would be off by scale² with an incorrect origin. When unrotated, it is exactly the
   * rectangle after scaling around the anchor point; for rotated composite cards, the bounding box
   * is taken here, which is only an approximation.
   *
   * ⚠ This box must be **unprojected**. visualBox is now projected by camera (required by 3D cards),
   * but the renderer side (PartTree) uses frameBox: if a projected box is passed in, the parent
   * boxes on both sides will no longer be the same, and the part's world would equal neither the
   * pre-fix value nor the true on-screen value. In testing, for a composite card with
   * translateZ:+400, a part filling the parent box went from 1920×1080 to 2628.7×1478.7, off by 37%,
   * whereas on screen it is actually still 1920×1080 before being projected as a whole. Therefore,
   * callers pass visualBox without fov.
   */
  const placed = placeParts(tree, { box: parentBox, scale: clipWorld.scale });
  const timing = partsTiming(tree, lookup);
  const fill = (n: PartInstance): EnvelopePart => {
    const def = lookup(n.partId);
    const tm = timing.parts.get(n.id);
    const pl = placed.get(n.id);
    return {
      id: n.id,
      partId: n.partId,
      label: n.label ?? def?.name ?? n.partId,
      ...(def?.role ? { role: def.role } : {}),
      // When writing back, enterMs needs value relative to parent (PartInstance definition);
      // absolute time is separately provided in read-only enterAtMs
      enterMs: n.enterMs ?? 0,
      ...(tm ? { enterAtMs: Math.round(tm.enterMs), settleMs: Math.round(tm.settleMs), after: tm.after } : {}),
      params: { ...n.params },
      frame: { local: n.frame ?? null, world: pl?.world ?? clipWorld.box },
      ...(n.children?.length ? { children: n.children.map(fill) } : {}),
    };
  };
  return { parts: tree.map(fill), settleMs: Math.round(timing.settleMs), after: timing.after };
}

/** Part instance in envelope (possibly modified) → PartInstance in clip; keep writable fields only */
function instancesFromEnvelope(parts: unknown[], lookup: PartLookup): unknown[] {
  return parts.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const r = raw as Record<string, unknown>;
    // label in envelope is display name (part name if not customized); omitted if equal to part name
    // to avoid "write back as-is" being judged as modified
    const defName = typeof r.partId === "string" ? lookup(r.partId)?.name : undefined;
    const label = typeof r.label === "string" && r.label && r.label !== defName ? r.label : undefined;
    const frameRaw = r.frame;
    const local = frameRaw && typeof frameRaw === "object" && !Array.isArray(frameRaw) && "local" in (frameRaw as object)
      ? (frameRaw as { local: unknown }).local
      : frameRaw;
    return {
      id: r.id,
      partId: r.partId,
      params: r.params ?? {},
      ...(local !== undefined && local !== null ? { frame: local } : {}),
      ...(r.enterMs !== undefined ? { enterMs: r.enterMs } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(Array.isArray(r.children) ? { children: instancesFromEnvelope(r.children, lookup) } : {}),
    };
  });
}

/** Flatten parameters in part tree back into params (used on writeback: user modified values in parts) */
function flattenParts(parts: EnvelopePart[] | undefined, into: Record<string, unknown>): void {
  for (const p of parts ?? []) {
    if (p.params && typeof p.params === "object") Object.assign(into, p.params);
    flattenParts(p.children, into);
  }
}

export function envelopeOf(project: Project, clip: TrackClip, card: CardDef<any> | undefined, stage: Size, partLookup: PartLookup = getPart): ClipEnvelope {
  const params = { ...(clip.params ?? {}) };
  const missing = (card?.controls ?? []).map((c) => c.key).filter((k) => !(k in params));
  const motion = clip.motion;
  const timing = timingOf(card, params);
  const staticLc = card?.lifecycle ?? DEFAULT_LIFECYCLE;
  // 3D: visualBox must be calculated using active cut / project camera projection; otherwise cards placed
  // in space report 2D positions in get_clip
  const world = worldOf(clip.frame, stage, effectiveCamera3dFov(project));
  // Composite card: structure and timing come from part instance tree, not card declaration
  const composite = isComposite(clip);
  // Part positioning uses **unprojected** box (see notes in compositePartsOf): used by renderer side
  const comp = composite ? compositePartsOf(clip.parts ?? [], visualBox(clip.frame, stage), world, partLookup) : null;
  const lifecycle = {
    ...staticLc,
    ...(roundMs(timing.settleMs) !== undefined ? { settleMs: roundMs(timing.settleMs) } : {}),
    ...(timing.after ? { after: timing.after } : {}),
    ...(comp ? { settleMs: comp.settleMs, after: comp.after } : {}),
  };
  return {
    $schema: ENVELOPE_SCHEMA,
    id: clip.id,
    card: {
      id: clip.cardId,
      name: card?.name ?? clip.cardId,
      source: card?.source ?? "native",
      lifecycle,
      ...(composite ? { composite: true } : {}),
    },
    time: { start: clip.start, end: clip.end, duration: round3(clip.end - clip.start) },
    frame: {
      local: clip.frame ?? null,
      ...(clip.frameExpr ? { expr: { ...clip.frameExpr } } : {}),
      world,
    },
    blend: { opacity: clip.opacity ?? 1, fadeIn: clip.fadeIn ?? 0, fadeOut: clip.fadeOut ?? 0 },
    motion: motion ? { attached: true, mediaId: motion.mediaId, whenHidden: motion.whenHidden } : { attached: false },
    parts: comp ? comp.parts : partsOf(card, params, timing),
    params,
    ...(missing.length ? { missingParams: missing } : {}),
  };
}

/** Composite card: cardId is composite, or clip already has a part tree */
export function isComposite(clip: { cardId: string; parts?: PartInstance[] }): boolean {
  return clip.cardId === "composite" || !!clip.parts?.length;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Store actions used to write envelopes. Extracted as an interface for Node unit tests without full store */
export interface EnvelopeWriter {
  setClipCard(clipId: string, cardId: string): void;
  setClipParams(clipId: string, params: Record<string, unknown>, opts?: { merge?: boolean }): void;
  moveClip(clipId: string, patch: { start?: number; end?: number }): void;
  setClipFrame(clipId: string, frame: ClipFrame | undefined): void;
  setClipFrameExpr?(clipId: string, expr: FrameExprMap | undefined): void;
  updateClip(clipId: string, patch: { opacity?: number; fadeIn?: number; fadeOut?: number }): void;
  /** Replace the entire part instance tree of a composite card */
  setClipParts?(clipId: string, parts: PartInstance[]): void;
}

export interface ApplyReport {
  /** Which sections actually changed: card / params / parts / time / frame / blend */
  changed: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Audio volume has only one entry point: set_clip_volume. When Agent cannot find it, it stuffs
 * volume into update_clip params or set_clip blend: previously both places silently dropped it
 * while reporting success (update_clip returned ok, set_clip returned changed: []), and it had to
 * try back and forth for several rounds before daring to say "feature not available". Now reject
 * immediately and point the way.
 */
const AUDIO_VOLUME_KEYS = ["volume", "audioVolume", "gain"];
export function rejectAudioVolumeKeys(obj: unknown, where: string): void {
  if (!isObj(obj)) return;
  const hit = AUDIO_VOLUME_KEYS.filter((k) => obj[k] !== undefined);
  if (hit.length) {
    throw new Error(`${where} has no audio volume (received ${hit.join(" / ")}). To adjust volume use set_clip_volume({ clipId, volume: 0~1 }), 0 is silent, 1 is original sound; opacity is the picture opacity`);
  }
}
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Keys allowed to be written into frame.local; other keys (e.g. someone copying world in) are
 * directly rejected.
 *
 * ⚠ Adding fields to ClipFrame requires syncing here; otherwise once that field enters frame,
 * set_clip is completely blocked: envelopeOf puts clip.frame into frame.local as is, and
 * applyEnvelope validates it **before** diffing: then even if one only wants to modify params,
 * as long as the envelope carries a frame section it will fail, and the error message will in turn
 * tell Agent "this key is invalid"; if it complies and deletes it, that property on the card
 * is gone. There is an identical manifest in kernel/parts.ts; update both places together.
 */
const FRAME_KEYS = new Set(["x", "y", "w", "h", "anchor", "scale", "rotate", "rotateX", "rotateY", "translateZ"]);

/**
 * 3D only takes effect on **card clips**. Default editor preview, export, and see_frames already
 * share Chrome FrameScene; this restriction is kept because the explicitly chosen legacy
 * `--media=ffmpeg` bypass only supports 2D media.
 *
 * Interception is placed here rather than just at the set_position tool entry point: set_clip is
 * another path; getting the envelope via `get_clip`, stuffing rotateY into frame.local, and writing
 * it back can bypass it just the same (verified writable in testing). Any path that can modify
 * frame goes through applyEnvelope or framePatchFromArgs; guarding both places ensures true safety.
 */
export function assertNo3dOnMedia(
  clip: TrackClip,
  frame: ClipFrame | undefined,
  opts?: { cutKind?: CutKind; frameExpr?: FrameExprMap | undefined },
): void {
  if (!(clip as { mediaId?: string }).mediaId) return;
  if (opts?.cutKind === "3d") return;
  const usedStatic = frame
    ? (["rotateX", "rotateY", "translateZ"] as const).filter((k) => frame[k] !== undefined && frame[k] !== 0)
    : [];
  const usedExpr = opts?.frameExpr && has3DFrameExpr(opts.frameExpr)
    ? (["rotateX", "rotateY", "translateZ"] as const).filter((k) => !!opts.frameExpr?.[k])
    : [];
  const used = [...new Set([...usedStatic, ...usedExpr])];
  if (!used.length) return;
  throw new Error(
    `In a 2D cut, ${used.join(" / ")} only works on cards; this clip is a media clip (video / image).` +
    ` Switch this cut to "3d" with set_cut_kind({ kind: "3d" }) so media clips render as 3D boards, or put the media inside a card.` +
    ` Position / size / flat rotation are fully supported for media in 2D cuts.`,
  );
}
function validateFrame(raw: unknown): ClipFrame | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (!isObj(raw)) throw new Error("frame.local must be an object or null (null = fill the stage)");
  for (const k of Object.keys(raw)) if (!FRAME_KEYS.has(k)) throw new Error(`frame.local does not recognize "${k}", only x / y / w / h / anchor / scale / rotate / rotateX / rotateY / translateZ are allowed; world is computed and cannot be written`);
  if (!isNum(raw.x) || !isNum(raw.y)) throw new Error("x and y of frame.local must be numbers (the anchor position on the stage)");
  for (const k of ["w", "h", "scale", "rotate", "rotateX", "rotateY", "translateZ"] as const) {
    if (raw[k] !== undefined && !isNum(raw[k])) throw new Error(`frame.local.${k} must be a number`);
  }
  if (raw.w !== undefined && (raw.w as number) <= 0) throw new Error("frame.local.w must be greater than 0");
  if (raw.h !== undefined && (raw.h as number) <= 0) throw new Error("frame.local.h must be greater than 0");
  if (raw.scale !== undefined && (raw.scale as number) <= 0) throw new Error("frame.local.scale must be greater than 0");
  if (raw.anchor !== undefined) {
    const a = raw.anchor;
    if (!Array.isArray(a) || a.length !== 2 || !isNum(a[0]) || !isNum(a[1])) throw new Error("frame.local.anchor must be [ax, ay], two numbers in 0~1");
  }
  return raw as unknown as ClipFrame;
}

/**
 * Write an envelope (possibly modified) back to a clip.
 *
 * Only compare and write sections **with differences**; unrecognized top-level keys are ignored,
 * and read-only sections (frame.world, motion, card.name…) are ignored. Parameters take `params`
 * as the source of truth; if the caller only modified values in `parts` without touching `params`,
 * use the flattened result from the part tree. All validations are completed before writing; if one
 * check fails, nothing is written: never leave a partial state.
 */
export function applyEnvelope(
  project: Project,
  clipId: string,
  input: unknown,
  card: CardDef<any> | undefined,
  stage: Size,
  writer: EnvelopeWriter,
  findCardById: (id: string) => CardDef<any> | undefined,
  partLookup: PartLookup = getPart,
): ApplyReport {
  if (!isObj(input)) throw new Error("The envelope must be an object { ... }");
  const hit = findClip(project, clipId);
  if (!hit) throw new Error(`clip ${clipId} not found`);
  const current = envelopeOf(project, hit.clip, card, stage, partLookup);
  const composite = isComposite(hit.clip);
  const env = input as Partial<ClipEnvelope> & Record<string, unknown>;
  const changed: string[] = [];

  // ── 1. Validation (finish all before writing) ──
  let nextCardId: string | undefined;
  if (isObj(env.card) && env.card.id !== undefined) {
    if (typeof env.card.id !== "string" || !findCardById(env.card.id)) throw new Error(`No such card: ${String(env.card.id)}`);
    if (env.card.id !== current.card.id) nextCardId = env.card.id;
  }

  let nextParams: Record<string, unknown> | undefined;
  if (env.params !== undefined && !isObj(env.params)) throw new Error("params must be an object");
  const fromParams = isObj(env.params) ? env.params : undefined;
  const fromParts: Record<string, unknown> = {};
  // Composite cards: parts is a writable instance tree, validated and replaced as a whole;
  // normal cards: values in parts are merely another view of params
  let nextTree: PartInstance[] | undefined;
  if (env.parts !== undefined) {
    if (!Array.isArray(env.parts)) throw new Error("parts must be an array");
    if (composite) {
      const tree = validatePartTree(instancesFromEnvelope(env.parts, partLookup), partLookup);
      // Run existing tree through same normalization (key order, defaults), otherwise differing key
      // orders will be judged as modified
      let currentNorm: unknown = hit.clip.parts ?? [];
      try { currentNorm = validatePartTree(hit.clip.parts ?? [], partLookup); } catch { /* If parts are missing from the library, compare as is */ }
      if (JSON.stringify(tree) !== JSON.stringify(currentNorm)) nextTree = tree;
    } else {
      flattenParts(env.parts as EnvelopePart[], fromParts);
    }
  }
  // params untouched, parts modified → defer to parts; if both provided, defer to params
  // (it is the full view)
  const paramsSame = fromParams !== undefined && JSON.stringify(fromParams) === JSON.stringify(current.params);
  const candidate = fromParams !== undefined && !paramsSame ? fromParams : Object.keys(fromParts).length ? { ...current.params, ...fromParts } : undefined;
  if (candidate && JSON.stringify(candidate) !== JSON.stringify(current.params)) {
    const targetCard = nextCardId ?? current.card.id;
    // When switching cards, old params no longer apply and count as empty; when not switching cards,
    // keep existing ones so "modifying only one item" is not judged as missing required fields
    validateCardParams(targetCard, candidate, nextCardId ? undefined : current.params);
    nextParams = candidate;
  } else if (nextCardId) {
    // Card switched without new params: use defaults of new card (validate checks required fields)
    validateCardParams(nextCardId, {}, undefined);
  }

  let nextTime: { start?: number; end?: number } | undefined;
  if (env.time !== undefined) {
    if (!isObj(env.time)) throw new Error("time must be an object { start, end }");
    const s = env.time.start !== undefined ? env.time.start : current.time.start;
    const e = env.time.end !== undefined ? env.time.end : current.time.end;
    if (!isNum(s) || !isNum(e) || e <= s) throw new Error("time.start / time.end must be numbers with end > start (duration is computed, just change end)");
    if (s !== current.time.start || e !== current.time.end) nextTime = { start: s, end: e };
  }

  const cutKind = activeCutKind(project);
  let nextFrame: { set: boolean; frame: ClipFrame | undefined } | undefined;
  let nextFrameExpr: { set: boolean; expr: FrameExprMap | undefined } | undefined;
  if (env.frame !== undefined) {
    if (!isObj(env.frame)) throw new Error("frame must be an object { local, expr?, world }; only local and expr are writable");
    if ("local" in env.frame) {
      const f = validateFrame(env.frame.local);
      assertNo3dOnMedia(hit.clip, f, { cutKind });
      if (JSON.stringify(f ?? null) !== JSON.stringify(current.frame.local)) nextFrame = { set: true, frame: f };
    }
    if ("expr" in env.frame) {
      const ex = normalizeFrameExprMap(env.frame.expr);
      assertNo3dOnMedia(hit.clip, undefined, { cutKind, frameExpr: ex });
      if (JSON.stringify(ex ?? null) !== JSON.stringify(hit.clip.frameExpr ?? null)) {
        nextFrameExpr = { set: true, expr: ex };
      }
    }
  }

  let nextBlend: { opacity?: number; fadeIn?: number; fadeOut?: number } | undefined;
  if (env.blend !== undefined) {
    if (!isObj(env.blend)) throw new Error("blend must be an object { opacity, fadeIn, fadeOut }");
    rejectAudioVolumeKeys(env.blend, "blend of set_clip");
    const patch: { opacity?: number; fadeIn?: number; fadeOut?: number } = {};
    for (const k of ["opacity", "fadeIn", "fadeOut"] as const) {
      const v = env.blend[k];
      if (v === undefined) continue;
      if (!isNum(v)) throw new Error(`blend.${k} must be a number`);
      if (k === "opacity" && (v < 0 || v > 1)) throw new Error(`blend.opacity is 0~1, got ${v}`);
      if (k !== "opacity" && v < 0) throw new Error(`blend.${k} is in seconds and cannot be negative`);
      if (v !== current.blend[k]) patch[k] = v;
    }
    if (Object.keys(patch).length) nextBlend = patch;
  }

  // ── 2. Write (fixed order) ──
  if (nextCardId) {
    writer.setClipCard(clipId, nextCardId);
    changed.push("card");
  }
  if (nextParams) {
    writer.setClipParams(clipId, nextParams, { merge: false });
    changed.push("params");
  }
  if (nextTree) {
    if (!writer.setClipParts) throw new Error("Editing the part tree of a composite card is not supported here");
    writer.setClipParts(clipId, nextTree);
    changed.push("parts");
  }
  if (nextTime) {
    writer.moveClip(clipId, nextTime);
    changed.push("time");
  }
  if (nextFrame) {
    writer.setClipFrame(clipId, nextFrame.frame);
    changed.push("frame");
  }
  if (nextFrameExpr) {
    if (!writer.setClipFrameExpr) throw new Error("Editing frame.expr is not supported by this writer");
    writer.setClipFrameExpr(clipId, nextFrameExpr.expr);
    if (!changed.includes("frame")) changed.push("frame");
  }
  if (nextBlend) {
    writer.updateClip(clipId, nextBlend);
    changed.push("blend");
  }
  return { changed };
}

/** A one-line description for humans in code pages / tools */
export function describeLifecycle(env: ClipEnvelope): string {
  const lc = env.card.lifecycle;
  const settle = lc.settleMs !== undefined ? `entrance settles in about ${(lc.settleMs / 1000).toFixed(1)}s` : "entrance duration varies";
  const after = lc.after === "hold" ? "then holds" : lc.after === "loop" ? "then loops" : "then keeps changing";
  const idle = lc.settleMs !== undefined && lc.after === "hold" ? Math.max(0, env.time.duration - lc.settleMs / 1000) : null;
  const idleNote = idle !== null && idle > 0.5 ? `; this clip is static for ${idle.toFixed(1)}s` : "";
  return `${settle}, ${after}, exit: ${lc.exit.join("/") || "none"}${idleNote}`;
}

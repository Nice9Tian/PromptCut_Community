import { type TrackResult } from "../ai/track";
import { getState, actions } from "../store/project";
import { getCard } from "../kernel/registry";
import { assertNo3dOnMedia, envelopeOf, isComposite } from "../kernel/envelope";
import { activeCutKind, effectiveCamera3dFov } from "../kernel/camera.mjs";
import type { FrameExprMap } from "../kernel/frameExpr.mjs";
import type { PartInstance } from "../kernel/types";
import { CAPTION_CARD_ID } from "../kernel/captions";
import { findClip, suggestPosition, type SubjectBox, type SubjectRangeInfo } from "../kernel/project";
import { createClipGuard, lookHint } from "./tools/toolEcho";
import { createTrackTools } from "./tools/trackTools";
import { createFilterTools } from "../editor/right/filterTools";
import { createAudioFxTools } from "../editor/right/audioFxTools";
import { createPixelMapTools } from "./tools/pixelMapTools";
import { audioPlanOf, soundingAt } from "../kernel/audioPlan.mjs";
import { mediaSpanOf } from "../kernel/clipTime.mjs";
import { worldOf, rectForSafeSide, frameBox, type Size } from "../kernel/layout";
import { backRole, backStage, syncProject } from "../editor/stageBridge";
import { runBackJob } from "../editor/stageJobs";
import type { RectWithBounds } from "../render/solid";
import { invalidateScopes, loadScopes, type ScopeEntry } from "../editor/cardScope";

import type { ClipFrame } from "../kernel/types";
import { type CollectJob } from "../ai/collect";
import { apiUrl } from "./apiUrl";

/** Stage dimensions: parent coordinate system for card-level frames */
export function stageSize(): Size {
  const p = getState().project;
  return { width: p.width, height: p.height };
}

type ContentBox = { left: number; top: number; width: number; height: number } | null;
export const roundBox = (b: { left: number; top: number; width: number; height: number }): ContentBox =>
  ({ left: Math.round(b.left), top: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) });

/**
 * A card's **entity content** box: the union of elements that actually draw something
 * (text, images, boxes with background color), passing through transparent containers.
 * Judging "whether it covers people" must look at this, not the canvas box: default card
 * canvases are 1920 wide, so judging by canvas box is always "will cover".
 *
 * **Batch, single round trip** (D4 page side): query the background stage for all clipIds
 * together (pinned architecture 4: user interaction queries run on their own offscreen
 * stage, not hitting prerenders):
 *   First sync current project over, setTime to playhead, then rectsWithBounds({ pixels: 'all' })
 * to retrieve all entity boxes in one go.
 * Media clips' contentBox is always equal to its frameCss box (not on stage, computed from
 * project data).
 * Cards not on screen at this moment (playhead not in their interval) cannot be measured:
 * contentBox is null with contentNote attached; do not treat as "no content".
 *
 * **Entire section queued into the background stage's single-flight queue** (D4): projects
 * on the background stage have three kinds of occupants (catch-up runs / measurement here /
 * probes); measurement is queued after catch-up runs and before probes. Before starting,
 * the queue sends `setRole('back', { job: 'catchup' })` to suspend probes, and hands it back
 * to the next occupant after measuring: otherwise, the probe's reduced project would swap
 * out the stage between two RPC statements, and the returned measurement would be boxes
 * from a different show. Under legacy single stage, the queue does not send `setRole`,
 * behaving the same as before.
 */
export async function measureContentBoxes(clipIds: string[]): Promise<Map<string, { contentBox: ContentBox; contentNote?: string }>> {
  const st = getState();
  const out = new Map<string, { contentBox: ContentBox; contentNote?: string }>();
  const stage = stageSize();
  const cardIds: string[] = [];
  for (const id of clipIds) {
    const hit = findClip(st.project, id);
    if (!hit) { out.set(id, { contentBox: null, contentNote: `clip ${id} not found` }); continue; }
    if (!hit.clip.cardId) { out.set(id, { contentBox: roundBox(frameBox(hit.clip.frame, stage)) }); continue; }
    cardIds.push(id);
  }
  if (!cardIds.length) return out;
  /*
   * State clearly on the spot if the stage is not ready yet, **do not wait in queue**:
   * the queue will wait indefinitely until a stage is available, and downstream on this
   * path is the Agent's get_layout: rather than leaving a tool call hanging there, it is
   * better to let it receive this message and retry.
   */
  if (!backStage()) {
    for (const id of cardIds) out.set(id, { contentBox: null, contentNote: "The preview window is not ready, so the content box cannot be measured; call get_layout again later" });
    return out;
  }
  const list = await runBackJob("measure", async ({ stage: s }) => {
    let rects: RectWithBounds[] = [];
    try {
      await syncProject(backRole(), st.project);
      // Exit solid mode before measuring: during playback, the screen displays color blocks, so what gets measured is the box of color blocks rather than content boxes (only effective on pages with ?proxy=1)
      await s.setProxy(false);
      await s.setTime(st.t);
      rects = await s.rectsWithBounds({ pixels: "all", clipIds: cardIds });
    } finally {
      try { await s.setProxy(st.playing); } catch { /* Restoration failure should not fail the tool */ }
    }
    return rects;
  }).catch((err: unknown) => {
    for (const id of cardIds) out.set(id, { contentBox: null, contentNote: `The stage did not respond, so the content box cannot be measured: ${err instanceof Error ? err.message : String(err)}` });
    return null;
  });
  if (!list) return out;
  for (const id of cardIds) {
    const r = list.find((x) => x.clipId === id);
    if (!r) {
      const hit = findClip(st.project, id);
      const range = hit ? `${hit.clip.start}~${hit.clip.end}s` : "?";
      out.set(id, { contentBox: null, contentNote: `This card is not on screen right now (playhead ${st.t}s is not within its ${range} range); seek into its time range first, then read` });
      continue;
    }
    out.set(id, { contentBox: roundBox(r.bounds ?? r.rect) });
  }
  return out;
}

/**
 * Layout returned by positioning tools (**pure calculation**, does not hit the stage):
 * local is the saved box (null if unset), and world is the computed screen absolute
 * position (box for canvas, visualBox after scaling and rotation). Mutation tools
 * (set_position / set_rect / align / nudge) only return this; for the entity content box
 * contentBox, call get_layout (contentLayoutOf) separately.
 */
export function frameLayoutOf(clipId: string) {
  const p = getState().project;
  const hit = findClip(p, clipId);
  const frame = (hit?.clip as { frame?: ClipFrame } | undefined)?.frame;
  const frameExpr = hit?.clip?.frameExpr;
  const fov = activeCutKind(p) === "3d" ? effectiveCamera3dFov(p) : p.camera3dFov;
  return {
    clipId,
    local: frame ?? null,
    ...(frameExpr && Object.keys(frameExpr).length ? { frameExpr } : null),
    world: worldOf(frame, stageSize(), fov),
  };
}

/** frameLayoutOf + measured contentBox (measures all clipIds in a single round trip, see measureContentBoxes) */
export async function contentLayoutOf(clipIds: string[]) {
  const measured = await measureContentBoxes(clipIds);
  const out: Record<string, ReturnType<typeof frameLayoutOf> & { contentBox: ContentBox; contentNote?: string }> = {};
  for (const id of clipIds) out[id] = { ...frameLayoutOf(id), ...(measured.get(id) ?? { contentBox: null }) };
  return out;
}

/**
 * Common skeleton for positioning tools: find clip → compute new box from existing box
 * → save → return layout + look.
 * The four tools set_position / set_rect / align / nudge differ only in next: they modify
 * the same box.
 */
/**
 * Common skeleton for composite card part tree tools: find clip → verify it is a
 * composite card → compute new tree using a pure function → save → return wrapper + look.
 * add_part / set_part / remove_part / move_part differ only in next.
 */
export function withParts<R extends { tree: PartInstance[] }>(clipId: string, next: (tree: PartInstance[]) => R, extra?: (r: R) => Record<string, unknown>) {
  const hit = findClip(getState().project, clipId);
  if (!hit) throw new Error(`clip ${clipId} not found`);
  if (!isComposite(hit.clip)) throw new Error(`clip ${clipId} is not a composite card (cardId must be composite); first create one with add_composite, or switch it to composite with update_clip`);
  const r = next(hit.clip.parts ?? []);
  actions.setClipParts(clipId, r.tree);
  const after = findClip(getState().project, clipId)!;
  return { ok: true, clipId, ...(extra ? extra(r) : {}), envelope: envelopeOf(getState().project, after.clip, getCard(after.clip.cardId), stageSize()), look: lookHint(clipId) };
}

export function withFrame(clipId: string, next: (prev: ClipFrame | undefined, stage: Size) => ClipFrame | undefined) {
  const hit = findClip(getState().project, clipId);
  if (!hit) throw new Error(`clip ${clipId} not found`);
  const prev = (hit.clip as { frame?: ClipFrame }).frame;
  actions.setClipFrame(clipId, next(prev, stageSize()));
  return { ok: true, clipId, layout: frameLayoutOf(clipId), look: lookHint(clipId) };
}

/**
 * Media 3D interception on the set_position path. The rule itself is in
 * assertNo3dOnMedia in kernel/envelope.ts, which also guards the set_clip path:
 * both paths share the same check and wording to avoid modifying only one place in the future.
 */
export function reject3dOnMedia(
  clipId: string,
  args: { rotateX?: number | string; rotateY?: number | string; translateZ?: number | string },
  frameExpr?: FrameExprMap | null,
) {
  const p = getState().project;
  const hit = findClip(p, clipId);
  if (!hit) return;
  const numeric3d: Partial<ClipFrame> = {};
  if (typeof args.rotateX === "number") numeric3d.rotateX = args.rotateX;
  if (typeof args.rotateY === "number") numeric3d.rotateY = args.rotateY;
  if (typeof args.translateZ === "number") numeric3d.translateZ = args.translateZ;
  assertNo3dOnMedia(hit.clip, numeric3d as ClipFrame, { cutKind: activeCutKind(p), frameExpr: frameExpr ?? undefined });
}

/** State of background STT tasks (MCP tools return jobId immediately; results rely on polling) */
interface SttJob { done: boolean; ok: boolean; error?: string; logTail?: string[]; segments?: number }
/**
 * Synchronous snapshot of the ownership table. `list_cards` is synchronous and cannot
 * be awaited: so fetch once on module load, then refresh after creating cards or
 * changing tiers. If fetching fails, it defaults to an empty table, and empty tables
 * are always permitted in isCardVisible: better to provide a few extra cards than to
 * make the Agent suddenly see zero cards due to a network jitter.
 */
export let cardScopes: Record<string, ScopeEntry> = {};
export const refreshScopes = () => { invalidateScopes(); loadScopes(true).then((m) => { cardScopes = m; }).catch(() => {}); };
loadScopes().then((m) => { cardScopes = m; }).catch(() => {});
export const sttJobs = new Map<string, SttJob>();

/** Installation job for the media collection extension. Separated from sttJobs, for the same reason as trackInstallJobs. */
export const collectInstallJobs = new Map<string, { done: boolean; ok: boolean; error?: string; logTail: string[] }>();
/**
 * Download job: server-side progress + result registered into the media library on this side.
 * Registration is performed only once (imported flag), so no matter how many times
 * collect_job is polled, media will not be added repeatedly.
 */
export const collectJobs = new Map<string, {
  job?: CollectJob; imported: boolean; mediaIds: string[]; error?: string;
}>();

/** Deletion gate for timeline tools. See the postmortem in the header comment of toolEcho.ts. */
export const clipGuard = createClipGuard();
/** Validation and gate for track tools (list/remove/update/move_track). See header comment in trackTools.ts */
export const trackTools = createTrackTools({ getState, actions });
/** Filter library tools (list/create/update/remove/apply_filter). See header comment in filterTools.ts */
export const filterTools = createFilterTools({ getState, actions });
/** Audio effects library tools (list/create/update/remove/apply_audio_fx). See header comment in audioFxTools.ts */
export const audioFxTools = createAudioFxTools({ getState, actions });
export const pixelMapTools = createPixelMapTools({ getState, actions });

/**
 * "What to measure": shared by measure_audio and measure_audio_js. Returns the items required
 * by the server (asset, clip start and length within the asset, timeline mix manifest),
 * the timeline tier additionally returns the manifest from kernel/audioPlan (used to label
 * who is producing sound on the second-by-second curve); returns empty when there are no
 * audible clips on the timeline.
 */
function audioTargetOf(args: { clipId?: string; mediaId?: string; scope?: string }) {
  const p = getState().project;
  const scope = args.scope || (args.clipId ? "clip" : args.mediaId ? "media" : "timeline");
  const mediaOf = (id: string) => {
    const m = p.media.find((x) => x.id === id);
    if (!m) throw new Error(`Asset ${id} not found`);
    if (m.kind === "image") throw new Error(`"${m.name}" is an image and has no sound`);
    return { id: m.id, name: m.name, kind: m.kind, url: m.url, path: (m as { path?: string }).path };
  };
  if (scope === "clip") {
    const hit = findClip(p, String(args.clipId || ""));
    if (!hit) throw new Error(`The current cut has no clip ${args.clipId || "(no clipId given)"}`);
    if (!hit.clip.mediaId || hit.clip.cardId) throw new Error("Cards have no sound; measure a video / audio clip instead");
    // A speed-changed clip measures the section of asset it uses (timeline duration × clip speed, kernel/clipTime.mjs; defaults to 1 bit-for-bit unchanged)
    return { scope, plan: null, body: { scope, media: mediaOf(hit.clip.mediaId), offset: hit.clip.mediaOffset ?? 0, duration: mediaSpanOf(hit.clip) } as Record<string, unknown> };
  }
  if (scope === "media") {
    return { scope, plan: null, body: { scope, media: mediaOf(String(args.mediaId || "")) } as Record<string, unknown> };
  }
  const plan = audioPlanOf(p);
  if (!plan.length) return { scope, plan, body: null, empty: true };
  return {
    scope,
    plan,
    body: {
      scope: "timeline",
      duration: p.duration,
      entries: plan.map((e) => ({ clipId: e.clipId, media: mediaOf(e.mediaId), start: e.start, dur: e.dur, offset: e.offset, ...(e.speed ? { speed: e.speed } : null), volume: e.volume, fadeIn: e.fadeIn, fadeOut: e.fadeOut })),
    } as Record<string, unknown>,
  };
}

const NO_SOUND_NOTE = "There are no clips that produce sound on the timeline (hidden / muted tracks and muted clips do not count)";

/**
 * Custom measurement (measure_audio_js, Plan A6; only open at creativity level "High",
 * gated in server/agent/creativity-gate.mjs).
 * "What to measure" is identical to measure_audio; the server decodes that audio into PCM
 * and runs the function body written by the Agent inside a dedicated Chrome sandbox,
 * returning only JSON (server/audio-measure-js.mjs, server/audio-sandbox.mjs). Errors in the
 * code itself (syntax, thrown errors, timeouts, result too large) are returned as is to the
 * Agent and not treated as tool failures.
 */
export async function measureAudioJs(args: {
  code: string; clipId?: string; mediaId?: string; scope?: string;
  start?: number; duration?: number; sampleRate?: number; mono?: boolean; timeoutMs?: number;
}) {
  const target = audioTargetOf(args);
  if (!target.body) return { ok: true, scope: target.scope, empty: true, note: NO_SOUND_NOTE };
  const tb = target.body;
  const body = {
    ...tb,
    // duration in the timeline tier is timeline duration; rename it, reserving duration for clips
    ...(target.scope === "timeline" ? { duration: undefined, total: tb.duration } : null),
    start: args.start, length: args.duration, sampleRate: args.sampleRate, mono: args.mono, timeoutMs: args.timeoutMs,
    code: args.code,
    meta: { clipId: args.clipId, mediaId: target.scope === "media" ? args.mediaId : (tb.media as { id?: string } | undefined)?.id },
  };
  const res = await fetch(apiUrl("/api/audio/measure-js"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(85000) });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error(data?.error || `Custom measurement failed (HTTP ${res.status})`);
  const out: Record<string, unknown> = { ...data, scope: target.scope };
  if (target.plan) {
    const withFx = target.plan.filter((e) => e.fx).map((e) => e.clipId);
    if (withFx.length) out.notes = [...(Array.isArray(data.notes) ? data.notes : []), `${withFx.join(", ")} has audio effects attached; the measurement here does not include effects`];
  }
  return out;
}

/**
 * Loudness measurement (measure_audio): asset, timeline clip, or the mix of the entire
 * timeline. ffmpeg runs on the server (server/vite-plugin-audio.ts); here it only calculates
 * "what to measure and from which second to which second". The timeline tier sends the entire
 * manifest from kernel/audioPlan, and the returned second-by-second curve is then labeled
 * with who is producing sound at that second based on the same manifest: only when the Agent
 * gets "second 19 at -8 LUFS, sound produced by background music + voiceover 04" can it
 * attribute causes.
 */
export async function measureAudio(args: { clipId?: string; mediaId?: string; scope?: string; series?: boolean }) {
  const req = measureAudioRequest(args);
  if (!req.body) return req.empty;
  const res = await fetch(apiUrl("/api/audio/measure"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req.body), signal: AbortSignal.timeout(55000) });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.ok === false) throw new Error(data?.error || `Loudness measurement failed (HTTP ${res.status})`);
  return measureAudioFinish(req, data);
}

/**
 * First half of measure_audio: calculates "what to measure and from which second to which
 * second" based on the project currently in store. The desktop app sends `body` to
 * `/api/audio/measure` of the editor process; the Cloud Agent
 * (`server/agent/service/hosted-audio.mjs`) takes the same `body` to measure in the chat's
 * working directory. When there are no audible clips, `body` is null and returns `empty`.
 */
export function measureAudioRequest(args: { clipId?: string; mediaId?: string; scope?: string; series?: boolean }) {
  const target = audioTargetOf(args);
  const scope = target.scope;
  if (!target.body) return { scope, plan: target.plan, body: null, empty: { ok: true, scope, empty: true, note: NO_SOUND_NOTE } };
  const body: Record<string, unknown> = scope === "timeline" ? target.body : { ...target.body, series: !!args.series };
  return { scope, plan: target.plan, body, empty: null };
}

/** Second half of measure_audio: labels measured numbers with "who is producing sound at that second" and caveats */
export function measureAudioFinish(req: { scope: string; plan: ReturnType<typeof audioPlanOf> | null }, data: Record<string, any>) {
  const { scope, plan } = req;
  const notes: string[] = Array.isArray(data.notes) ? [...data.notes] : [];
  const out: Record<string, unknown> = { ...data, scope };
  if (plan) {
    if (Array.isArray(data.series)) out.series = data.series.map((s: { t: number }) => ({ ...s, sounding: soundingAt(plan!, s.t) }));
    const withFx = plan.filter((e) => e.fx).map((e) => e.clipId);
    if (withFx.length) notes.push(`${withFx.join(", ")} has audio effects attached; the measurement here does not include effects (effects are computed in Chrome and only mixed in on export)`);
    out.clips = plan.map((e) => ({ clipId: e.clipId, mediaId: e.mediaId, start: e.start, end: +(e.start + e.dur).toFixed(3), volume: +e.volume.toFixed(3), ...(e.fx ? { fxId: e.fx.def.id } : null) }));
  } else if (scope === "clip") {
    notes.push("This measures the original sound of the part of the media used by this clip; clip volume, fades and audio effects are not included");
  }
  if (notes.length) out.notes = notes;
  return out;
}

/** Running shot detection jobs, indexed by mediaId. Deleted once results land in store. */
export const shotJobs = new Map<string, { jobId: string; percent: number; engine: string; error?: string }>();
/** In-progress tracking jobs, as well as completed tracks. Both exist only in memory and disappear upon page refresh */
// engine can be undefined: which tier is running is decided on the Python side, which Node
// does not know before the job finishes. Previously "bootstapir" was hardcoded here, which
// reported the fallback tier's progress as the neural network tier when extensions were
// not installed.
// Background jobs for extension installation. Separated from sttJobs: jobIds for both are
// generated independently, and mixing them in a single table only makes issues like
// "jobId not found" harder to debug.
export const trackInstallJobs = new Map<string, {
  done: boolean; ok: boolean; error?: string; logTail: string[];
}>();

export const trackJobs = new Map<string, {
  jobId: string; percent: number; engine?: "bootstapir" | "template"; error?: string;
}>();
export const trackResults = new Map<string, TrackResult>();

/** Running subject detection jobs, indexed by mediaId. Deleted once results land in store (MediaAsset.subjects). */
export const subjectJobs = new Map<string, {
  jobId: string; percent: number; engine?: "light" | "full"; error?: string;
}>();
/** Installation job for the subject detection extension. Same reason as trackInstallJobs: jobIds are generated independently, not mixed across tables */
export const subjectInstallJobs = new Map<string, {
  done: boolean; ok: boolean; error?: string; logTail: string[];
}>();

/** The most representative boxes across an interval: emitting everything to the model is too long; three samples for a single shot produce three duplicate persons */
/**
 * Find that captions card. When clipId is not provided: use it if there is only one on
 * the timeline; require specifying which one if there are multiple (same policy as
 * fill_captions: guessing wrong would modify captions on another video segment, so
 * raising an error is better).
 */
export function findCaptionClip(clipId?: string) {
  const project = getState().project;
  if (!clipId) {
    const hits = project.tracks.flatMap((t) => t.clips.filter((c) => c.cardId === CAPTION_CARD_ID));
    if (hits.length === 0) throw new Error("There is no captions card on the timeline. First create a caption-track with add_clip, then feed in the transcript with fill_captions.");
    if (hits.length > 1) throw new Error(`There are ${hits.length} captions cards on the timeline, specify which one with clipId: ${hits.map((c) => c.id).join(", ")}`);
    clipId = hits[0].id;
  }
  const hit = findClip(project, clipId);
  if (!hit) throw new Error(`clip ${clipId} not found`);
  if (hit.clip.cardId !== CAPTION_CARD_ID) throw new Error(`clip ${clipId} is ${hit.clip.cardId || "media clip"}, not a captions card.`);
  return hit;
}

export function topBoxes(boxes: SubjectBox[], limit = 4): SubjectBox[] {
  return [...boxes]
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, limit)
    .map((b) => ({
      label: b.label,
      x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h),
      conf: Math.round(b.conf * 100) / 100,
    }));
}

/** Folds subjectForRange results into a shape for the model: includes suggestions that can be directly filled into params.position */
export function subjectDigest(info: SubjectRangeInfo | null) {
  if (!info) return null;
  const round2 = (v: number) => Math.round(v * 100) / 100;
  // suggestedPosition is "the least bad among the remaining three tiers", not equal to
  // "guaranteed not to occlude". Also report the occupancy rate of the selected side;
  // if it occupies more than half, set to null and give a warning: the most common situation
  // for a front-facing speaker half-body shot (safeSide=top) is that all four sides are
  // occupied; previously this would give a right that is 89.5% person, the model filled it
  // in accordingly, placing the card right over the face, with no field in the return
  // revealing this.
  const sug = suggestPosition(info.safeSide, info.occupancy);
  return {
    safeSide: info.safeSide,
    ...sug,
    // The empty side is provided directly as a rectangle, which when fed to set_rect can
    // place any card there: no longer constrained by the card's built-in position tiers
    // (can now be used even when safeSide is top; previously top had no corresponding tier
    // so it had to be abandoned). When all four sides are occupied (sug set to null), this is
    // also null: at that moment there is no rectangle that does not occlude people, so do
    // not force it.
    suggestedRect: sug.suggestedPosition == null ? null : rectForSafeSide(info.safeSide, stageSize(), 40),
    occupancy: {
      left: round2(info.occupancy.left), right: round2(info.occupancy.right),
      top: round2(info.occupancy.top), bottom: round2(info.occupancy.bottom),
    },
    sampledAt: info.times,
    boxCount: info.boxes.length,
    boxes: topBoxes(info.boxes),
    ...(info.approximate
      ? { approximate: true, note: "There are no sample points in this range; the numbers come from the nearest sample in time and are only approximate" }
      : null),
  };
}


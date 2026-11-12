import { EditorApi } from "../../ai/mcpExecutor";
import { getState, actions } from "../../store/project";
import { getCard } from "../../kernel/registry";
import { applyEnvelope, envelopeOf, rejectAudioVolumeKeys } from "../../kernel/envelope";
import { validateCardParams } from "../../kernel/cardParams";
import { timingLock } from "../../kernel/transitions";
import { describeEmphasis } from "../../kernel/emphasis";
import { CAPTION_CARD_ID } from "../../kernel/captions";
import { FRAME_EXPR_KEYS } from "../../kernel/frameExpr.mjs";
import { findClip } from "../../kernel/project";
import { timelineDigest, lookHint, paramsEcho } from "../tools/toolEcho";

import { stageSize, clipGuard } from "../common";
import { segmentInfo } from "./cutSegments";
import { inClipCut, assertClipNotParked, clipMissingError } from "../clipCut";

type Args<K extends keyof EditorApi> = Parameters<EditorApi[K]>[0];

export const clipsHandlers = {
  addClip: (args) => {
    // Validate first before storing: error immediately if parameters are invalid, rather than
    // creating an empty shell card playing default values
    validateCardParams(args.cardId, args.params);
    // When no track is specified for a caption card, route it to the "Captions" track (create one at
    // the top layer if none exists): captions must sit above the video, and only a separate track
    // clearly shows which line is at what time
    const trackId =
      args.trackId ?? (args.cardId === CAPTION_CARD_ID ? actions.ensureCaptionTrack().id : undefined);
    const clip = actions.addCardClip(args.cardId, args.start, {
      duration: args.duration,
      trackId,
      params: args.params
    });
    if (!clip) throw new Error("Failed to add card");
    clipGuard.noteCreated(clip.id);
    // look: ready-made call to inspect the actual visuals of this card; timeline: ids, start, and end
    // of all current clips, which the model should use as the reference for subsequent clipId
    // citations, rather than relying on memory from several steps ago. See toolEcho.ts for the
    // rationale.
    return { ...clip, look: lookHint(clip.id), timeline: timelineDigest(getState().project) };
  },
  updateClip: /* @__PURE__ */ inClipCut((args: Args<"updateClip">) => {
    rejectAudioVolumeKeys(args, "update_clip");
    if (args.params || args.cardId !== undefined) {
      const hit = findClip(getState().project, args.clipId);
      if (!hit) throw clipMissingError(args.clipId);
      const clip = hit.clip as { cardId?: string; params?: Record<string, unknown> };
      // When changing cards, old parameters no longer apply and are treated as empty; when only
      // modifying parameters, include the clip's existing ones, lest "just changing a color" be treated
      // as omitting required fields.
      const switching = args.cardId !== undefined && args.cardId !== clip.cardId;
      validateCardParams(args.cardId ?? clip.cardId!, args.params, switching ? undefined : clip.params);
    }
    /*
     * Clips with transitions attached: relative timing relationships are part of the transition.
     *   - Translate the entire group (providing only start, or start+end maintaining duration):
     *     proceed, as items in the same group will move together;
     *   - Changing duration, changing tracks, or manually editing fading on the side governed by
     *     the transition: reject, and instruct it to call remove_transition first.
     */
    const lock = timingLock(getState().project, args.clipId);
    if (lock) {
      const cur = findClip(getState().project, args.clipId)!.clip;
      const wantStart = args.start ?? cur.start;
      const wantEnd = args.end ?? cur.end;
      if (Math.abs(wantEnd - wantStart - (cur.end - cur.start)) > 1e-3) {
        throw new Error(`Can't change duration: ${lock.message}`);
      }
      if (args.trackId !== undefined && args.trackId !== findClip(getState().project, args.clipId)!.track.id) {
        throw new Error(`Can't change track: ${lock.message}`);
      }
      for (const side of ["fadeIn", "fadeOut"] as const) {
        if (args[side] !== undefined && lock.transitions.some((tr) =>
          (tr.kind === "crossfade" && ((side === "fadeOut" && tr.aId === args.clipId) || (side === "fadeIn" && tr.bId === args.clipId))) ||
          (tr.kind === side && tr.aId === args.clipId))) {
          throw new Error(`${side} is the transition's duration and can't be changed alone: ${lock.message}`);
        }
      }
    }
    // params is a delta patch (setClipParams merges by default): the echo lists keys that actually
    // changed, and the model can see for itself when old values are carried back
    const paramsBefore = args.params ? (findClip(getState().project, args.clipId)?.clip.params as Record<string, unknown> | undefined) : undefined;
    if (args.params) actions.setClipParams(args.clipId, args.params);
    // Opacity / fade / label: supported by the store long ago, but previously not exposed to the
    // model: the system prompt told it "reduce opacity when covering a person", yet it had no tool
    // to do so.
    const patch: { opacity?: number; fadeIn?: number; fadeOut?: number; label?: string } = {};
    for (const k of ["opacity", "fadeIn", "fadeOut"] as const) {
      const v = args[k];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${k} must be a finite number, got ${JSON.stringify(v)}`);
      if (k === "opacity" && (v < 0 || v > 1)) throw new Error(`opacity must be 0~1, got ${v}`);
      if (k !== "opacity" && v < 0) throw new Error(`${k} is in seconds and can't be negative, got ${v}`);
      patch[k] = v;
    }
    if (args.label !== undefined) patch.label = String(args.label);
    if (Object.keys(patch).length) actions.updateClip(args.clipId, patch);
    if (args.trackId !== undefined && !getState().project.tracks.some((t) => t.id === args.trackId)) {
      throw new Error(`Track ${args.trackId} not found; only the ids of tracks in get_project are valid`);
    }
    if (args.start !== undefined || args.end !== undefined || args.trackId !== undefined) {
      actions.moveClip(args.clipId, { start: args.start, end: args.end, trackId: args.trackId });
    }
    if (args.cardId !== undefined) actions.setClipCard(args.clipId, args.cardId);
    clipGuard.noteMutation();
    return {
      ok: true, clipId: args.clipId, look: lookHint(args.clipId), timeline: timelineDigest(getState().project),
      ...(args.params ? paramsEcho(paramsBefore, findClip(getState().project, args.clipId)?.clip.params) : null),
      ...(lock ? { movedGroup: lock.members, note: "This clip has a transition attached, so the whole group moved together" } : {}),
    };
  }),
  removeClip: (args) => {
    // Gate: deleting a card it just created or deleting a whole batch in one go requires force +
    // reason. The reason is echoed to the user. See toolEcho.ts.
    const a = args as { clipId: string; force?: boolean; reason?: string };
    assertClipNotParked(a.clipId);
    const { reason } = clipGuard.checkRemove(a);
    actions.removeClip(a.clipId);
    clipGuard.noteRemoved(a.clipId);
    return { ok: true, removed: a.clipId, ...(reason ? { reason } : null), timeline: timelineDigest(getState().project) };
  },
  // Card contract: what the Agent sees and modifies is this (kernel/envelope.ts), not the raw clip
  // or component source code
  getClip: /* @__PURE__ */ inClipCut((args: Args<"getClip">) => {
    const hit = findClip(getState().project, args.clipId);
    if (!hit) throw clipMissingError(args.clipId);
    const envelope = envelopeOf(getState().project, hit.clip, getCard(hit.clip.cardId), stageSize());
    // Cut segment: additionally includes which cut is referenced, offset, total duration of the
    // referenced cut, volume, and mute (kernel/cutSegments.ts)
    return hit.clip.cutId ? { ...envelope, cutSegment: segmentInfo(hit.clip.id) } : envelope;
  }),
  setClip: /* @__PURE__ */ inClipCut((args: Args<"setClip">) => {
    const hit = findClip(getState().project, args.clipId);
    if (!hit) throw clipMissingError(args.clipId);
    const report = applyEnvelope(
      getState().project, args.clipId, args.envelope, getCard(hit.clip.cardId), stageSize(),
      {
        setClipCard: (id, cardId) => actions.setClipCard(id, cardId),
        setClipParams: (id, params, opts) => actions.setClipParams(id, params, opts),
        moveClip: (id, patch) => actions.moveClip(id, patch),
        setClipFrame: (id, frame) => actions.setClipFrame(id, frame),
        setClipFrameExpr: (id, expr) => actions.setClipFrameExpr(id, expr ?? null, [...FRAME_EXPR_KEYS]),
        updateClip: (id, patch) => actions.updateClip(id, patch),
        setClipParts: (id, parts) => actions.setClipParts(id, parts),
      },
      getCard,
    );
    if (report.changed.length) clipGuard.noteMutation();
    const after = findClip(getState().project, args.clipId)!;
    return {
      ok: true, clipId: args.clipId, changed: report.changed,
      envelope: envelopeOf(getState().project, after.clip, getCard(after.clip.cardId), stageSize()),
      look: lookHint(args.clipId), timeline: timelineDigest(getState().project),
    };
  }),
  splitClip: (args) => {
    assertClipNotParked(args.clipId);
    const lock = timingLock(getState().project, args.clipId);
    if (lock) throw new Error(`Can't split: ${lock.message}`);
    const c = actions.splitClip(args.clipId, args.t);
    if (!c) throw new Error("Split failed");
    clipGuard.noteCreated(c.id);
    return c;
  },
  duplicateClip: (args) => { assertClipNotParked(args.clipId); const c = actions.duplicateClip(args.clipId); if (!c) throw new Error("Duplicate failed"); clipGuard.noteCreated(c.id); return c; },
  setEmphasis: /* @__PURE__ */ inClipCut((args: Args<"setEmphasis">) => {
    const clipId = String(args.clipId ?? "");
    const kind = String(args.kind ?? "");
    if (!clipId) throw new Error("clipId is required");
    if (kind === "none") {
      const r = actions.setClipEmphasis(clipId, null);
      if (!r.ok) throw new Error(r.error ?? "Can't remove");
      clipGuard.noteMutation();
      return { ok: true, clipId, emphasis: null, note: "Emphasis removed" };
    }
    if (kind !== "shadow" && kind !== "outline") {
      throw new Error(`kind must be shadow / outline / none (remove), got ${JSON.stringify(args.kind)}`);
    }
    const r = actions.setClipEmphasis(clipId, {
      kind, color: args.color, size: args.size, opacity: args.opacity, dx: args.dx, dy: args.dy,
    });
    if (!r.ok) throw new Error(r.error ?? "Can't add");
    clipGuard.noteMutation();
    return {
      ok: true, clipId, emphasis: r.emphasis, describe: describeEmphasis(r.emphasis),
      look: lookHint(clipId),
      note: "Emphasis follows the edge of the opaque part of the picture (by alpha), most visible on cards with a transparent background and cut-out people; a fully opaque picture only shows an edge around the outside of its box.",
    };
  }),
} satisfies Partial<EditorApi>;

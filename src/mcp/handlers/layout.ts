import { EditorApi } from "../../ai/mcpExecutor";
import { getState, actions } from "../../store/project";
import { findClip } from "../../kernel/project";
import { framePatchFromArgs, rectToFrame, alignToFrame, alignIsInvisible, nudgeFrame, clampToStage } from "../../kernel/layout";
import { FRAME_EXPR_KEYS, validateFrameExpr, type FrameExprKey, type FrameExprMap } from "../../kernel/frameExpr.mjs";
import { activeCutKind, effectiveCamera3dFov } from "../../kernel/camera.mjs";

import { stageSize, withFrame, frameLayoutOf, reject3dOnMedia, clipGuard, contentLayoutOf } from "../common";
import { inClipCut, clipMissingError } from "../clipCut";
import { lookHint } from "../tools/toolEcho";

type Args<K extends keyof EditorApi> = Parameters<EditorApi[K]>[0];

function applyFrameExprPatch(
  clipId: string,
  prevExpr: FrameExprMap | undefined,
  exprPatch: Record<string, unknown> | undefined,
  clearAll: boolean | undefined,
  clearedByNumericKeys: FrameExprKey[] = [],
) {
  if (clearAll) {
    actions.setClipFrameExpr(clipId, undefined);
    return;
  }
  if (!exprPatch && clearedByNumericKeys.length === 0) return;
  const next: FrameExprMap = { ...(prevExpr ?? {}) };
  for (const k of clearedByNumericKeys) delete next[k];
  if (exprPatch) {
    if (typeof exprPatch !== "object" || Array.isArray(exprPatch)) {
      throw new Error(`frameExpr must be an object mapping frame fields (${FRAME_EXPR_KEYS.join(", ")}) to expression strings or null`);
    }
    for (const [k, raw] of Object.entries(exprPatch)) {
      if (!(FRAME_EXPR_KEYS as readonly string[]).includes(k)) {
        throw new Error(`frameExpr does not support field "${k}". Allowed fields: ${FRAME_EXPR_KEYS.join(", ")}`);
      }
      const key = k as FrameExprKey;
      if (raw === null || raw === undefined || raw === "") {
        delete next[key];
      } else if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (!trimmed) delete next[key];
        else {
          validateFrameExpr(trimmed, key);
          next[key] = trimmed;
        }
      } else {
        throw new Error(`frameExpr.${key} must be an expression string (using t, d, p) or null, got ${JSON.stringify(raw)}`);
      }
    }
  }
  actions.setClipFrameExpr(clipId, Object.keys(next).length ? next : undefined);
}

export const layoutHandlers = {
  setPosition: /* @__PURE__ */ inClipCut((args: Args<"setPosition">) => {
    const hit = findClip(getState().project, args.clipId);
    if (!hit) throw new Error(`clip ${args.clipId} not found`);
    if (args.clear) {
      actions.setClipFrame(args.clipId, undefined);
      actions.setClipFrameExpr(args.clipId, undefined);
      clipGuard.noteMutation();
      return { ok: true, clipId: args.clipId, layout: frameLayoutOf(args.clipId), look: lookHint(args.clipId) };
    }

    const numericArgs: Record<string, unknown> = {
      clipId: args.clipId,
      ...(args.space !== undefined ? { space: args.space } : {}),
      ...(args.anchor !== undefined ? { anchor: args.anchor } : {}),
    };
    const mergedExprPatch: Record<string, unknown> = { ...(args.frameExpr ?? {}) };
    const clearedByNumericKeys: FrameExprKey[] = [];
    let hasNumericField = args.anchor !== undefined;

    for (const key of FRAME_EXPR_KEYS) {
      const val = (args as Record<string, unknown>)[key];
      if (val === undefined) continue;
      if (typeof val === "string") {
        const trimmed = val.trim();
        if (!trimmed) throw new Error(`${key} expression cannot be empty; pass a number, a non-empty expression string, or frameExpr: { ${key}: null }`);
        validateFrameExpr(trimmed, key);
        mergedExprPatch[key] = trimmed;
      } else {
        numericArgs[key] = val;
        hasNumericField = true;
        if (!(args.frameExpr && Object.hasOwn(args.frameExpr, key))) {
          clearedByNumericKeys.push(key);
        }
      }
    }

    // Validate all expressions up front before mutating anything
    for (const [k, v] of Object.entries(mergedExprPatch)) {
      if (!(FRAME_EXPR_KEYS as readonly string[]).includes(k)) {
        throw new Error(`frameExpr does not support field "${k}". Allowed fields: ${FRAME_EXPR_KEYS.join(", ")}`);
      }
      if (typeof v === "string" && v.trim()) validateFrameExpr(v.trim(), k as FrameExprKey);
    }

    const hasExprMutation = !!args.clearFrameExpr || Object.keys(mergedExprPatch).length > 0;
    const candidateExpr: FrameExprMap = { ...(hit.clip.frameExpr ?? {}) };
    if (args.clearFrameExpr) {
      for (const k of Object.keys(candidateExpr) as FrameExprKey[]) delete candidateExpr[k];
    }
    for (const k of clearedByNumericKeys) delete candidateExpr[k];
    for (const [k, v] of Object.entries(mergedExprPatch)) {
      if (typeof v === "string" && v.trim()) candidateExpr[k as FrameExprKey] = v.trim();
      else if (v === null || v === "") delete candidateExpr[k as FrameExprKey];
    }

    reject3dOnMedia(args.clipId, numericArgs as { rotateX?: number; rotateY?: number; translateZ?: number }, candidateExpr);

    const stage = stageSize();
    const p = getState().project;
    const fov = activeCutKind(p) === "3d" ? effectiveCamera3dFov(p) : p.camera3dFov;
    if (hasNumericField || !hasExprMutation) {
      const patch = framePatchFromArgs(numericArgs as Parameters<typeof framePatchFromArgs>[0], stage);
      const prev = hit.clip.frame;
      const next = { x: 0, y: 0, ...prev, ...patch };
      actions.setClipFrame(args.clipId, args.clamp ? clampToStage(next, stage, fov) : next);
    } else if (!hit.clip.frame && Object.keys(candidateExpr).length > 0) {
      // Ensure clip.frame exists when animating a previously full-screen clip via frameExpr alone
      actions.setClipFrame(args.clipId, { x: 0, y: 0 });
    }

    applyFrameExprPatch(
      args.clipId,
      hit.clip.frameExpr,
      Object.keys(mergedExprPatch).length ? mergedExprPatch : undefined,
      args.clearFrameExpr,
      clearedByNumericKeys,
    );
    clipGuard.noteMutation();
    return { ok: true, clipId: args.clipId, layout: frameLayoutOf(args.clipId), look: lookHint(args.clipId) };
  }),
  setRect: /* @__PURE__ */ inClipCut((args: Args<"setRect">) => {
    const hit = findClip(getState().project, args.clipId);
    if (!hit) throw new Error(`clip ${args.clipId} not found`);
    if (args.frameExpr || args.clearFrameExpr) {
      reject3dOnMedia(args.clipId, {}, args.clearFrameExpr ? undefined : (args.frameExpr as FrameExprMap));
    }
    const r = withFrame(args.clipId, (prev, stage) =>
      rectToFrame({ x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2 }, { mode: args.mode, align: args.align }, prev, stage));
    if (args.frameExpr !== undefined || args.clearFrameExpr) {
      applyFrameExprPatch(args.clipId, hit.clip.frameExpr, args.frameExpr, args.clearFrameExpr);
      r.layout = frameLayoutOf(args.clipId);
    }
    clipGuard.noteMutation();
    return r;
  }),
  align: /* @__PURE__ */ inClipCut((args: Args<"align">) => {
    let invisible = false;
    const r = withFrame(args.clipId, (prev, stage) => {
      const next = alignToFrame(args.h, args.v, args.margin ?? 0, prev, stage);
      invisible = alignIsInvisible(next, stage);
      return next;
    });
    clipGuard.noteMutation();
    return invisible
      ? { ...r, note: "This card's canvas fills the stage and is not scaled down, so alignment would show no effect. First shrink it with set_rect (place it into a rectangle) or nudge({ scaleBy: 0.6 }), then align." }
      : r;
  }),
  nudge: /* @__PURE__ */ inClipCut((args: Args<"nudge">) => {
    const r = withFrame(args.clipId, (prev, stage) => {
      const next = nudgeFrame(args, prev, stage);
      return args.clamp ? clampToStage(next, stage, getState().project.camera3dFov) : next;
    });
    clipGuard.noteMutation();
    return r;
  }),
  getLayout: async (args) => {
    const p = getState().project;
    if (args?.clipId) {
      if (!findClip(p, args.clipId)) throw clipMissingError(args.clipId);
      return (await contentLayoutOf([args.clipId]))[args.clipId];
    }
    // All cards and media clips, in a single round trip (contentBox of a media clip = its frameCss box)
    const ids = p.tracks.flatMap((tr) => tr.clips.map((c) => c.id));
    return { stage: stageSize(), clips: await contentLayoutOf(ids) };
  },
} satisfies Partial<EditorApi>;

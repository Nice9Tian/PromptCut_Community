import { EditorApi } from "../../ai/mcpExecutor";
import { getState } from "../../store/project";
import { findClip } from "../../kernel/project";
import { framePatchFromArgs, rectToFrame, alignToFrame, alignIsInvisible, nudgeFrame, clampToStage } from "../../kernel/layout";

import { stageSize, withFrame, reject3dOnMedia, clipGuard, contentLayoutOf } from "../common";
import { inClipCut, clipMissingError } from "../clipCut";

type Args<K extends keyof EditorApi> = Parameters<EditorApi[K]>[0];

export const layoutHandlers = {
  setPosition: /* @__PURE__ */ inClipCut((args: Args<"setPosition">) => {
    reject3dOnMedia(args.clipId, args);
    const r = withFrame(args.clipId, (prev, stage) => {
      if (args.clear) return undefined;
      // Only modify passed fields and retain the rest; world→local conversion is in framePatchFromArgs
      // (per-card identity). When set for the first time and x/y is not provided, fill with 0 to avoid
      // saving a box without position.
      const next = { x: 0, y: 0, ...prev, ...framePatchFromArgs(args, stage) };
      return args.clamp ? clampToStage(next, stage, getState().project.camera3dFov) : next;
    });
    clipGuard.noteMutation();
    return r;
  }),
  setRect: /* @__PURE__ */ inClipCut((args: Args<"setRect">) => {
    const r = withFrame(args.clipId, (prev, stage) =>
      rectToFrame({ x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2 }, { mode: args.mode, align: args.align }, prev, stage));
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

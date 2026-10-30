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
      // 只改传了的字段,其余保留;world→local 的换算在 framePatchFromArgs 里(卡片级恒等)。
      // 第一次设且没给 x/y 时补 0,免得存下一个没有位置的框。
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
      ? { ...r, note: "这张卡的画布铺满舞台、也没缩小,对齐看不出效果。先 set_rect(放进一个矩形)或 nudge({ scaleBy: 0.6 })缩小,再对齐。" }
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
    // 全部卡片和素材段,一次往返(素材段的 contentBox = 它的 frameCss 框)
    const ids = p.tracks.flatMap((tr) => tr.clips.map((c) => c.id));
    return { stage: stageSize(), clips: await contentLayoutOf(ids) };
  },
} satisfies Partial<EditorApi>;

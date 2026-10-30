import { EditorApi } from "../../ai/mcpExecutor";
import { getState, actions } from "../../store/project";
import { getCard } from "../../kernel/registry";
import { applyEnvelope, envelopeOf, rejectAudioVolumeKeys } from "../../kernel/envelope";
import { validateCardParams } from "../../kernel/cardParams";
import { timingLock } from "../../kernel/transitions";
import { describeEmphasis } from "../../kernel/emphasis";
import { CAPTION_CARD_ID } from "../../kernel/captions";
import { findClip } from "../../kernel/project";
import { timelineDigest, lookHint, paramsEcho } from "../tools/toolEcho";

import { stageSize, clipGuard } from "../common";
import { segmentInfo } from "./cutSegments";
import { inClipCut, assertClipNotParked, clipMissingError } from "../clipCut";

type Args<K extends keyof EditorApi> = Parameters<EditorApi[K]>[0];

export const clipsHandlers = {
  addClip: (args) => {
    // 先校验再落库:参数错了当场报错,而不是建出一张播默认值的空壳卡
    validateCardParams(args.cardId, args.params);
    // 字幕卡没指定序列时统一去「字幕」序列(没有就建一条,建在最上层):
    // 字幕要压在画面之上,而且单独一条轨才看得清哪句话在什么时候
    const trackId =
      args.trackId ?? (args.cardId === CAPTION_CARD_ID ? actions.ensureCaptionTrack().id : undefined);
    const clip = actions.addCardClip(args.cardId, args.start, {
      duration: args.duration,
      trackId,
      params: args.params
    });
    if (!clip) throw new Error("添加卡片失败");
    clipGuard.noteCreated(clip.id);
    // look:去看这张卡真实画面的现成调用;timeline:当前全部 clip 的 id 和起止,
    // 之后模型引用 clipId 以它为准,不再凭几步前的记忆。理由见 toolEcho.ts。
    return { ...clip, look: lookHint(clip.id), timeline: timelineDigest(getState().project) };
  },
  updateClip: /* @__PURE__ */ inClipCut((args: Args<"updateClip">) => {
    rejectAudioVolumeKeys(args, "update_clip");
    if (args.params || args.cardId !== undefined) {
      const hit = findClip(getState().project, args.clipId);
      if (!hit) throw clipMissingError(args.clipId);
      const clip = hit.clip as { cardId?: string; params?: Record<string, unknown> };
      // 换卡时旧参数不再适用,按空的算;只改参数时要带上 clip 已有的,
      // 免得「只改个颜色」被当成漏填了必填项。
      const switching = args.cardId !== undefined && args.cardId !== clip.cardId;
      validateCardParams(args.cardId ?? clip.cardId!, args.params, switching ? undefined : clip.params);
    }
    /*
     * 挂着转场的片段:相对时间关系是转场的一部分。
     *   - 整组平移(只给 start,或 start+end 保持时长)照做,同组的会跟着一起走;
     *   - 改时长、换序列、手改转场管着的那一侧淡化 —— 拒绝,并告诉它先 remove_transition。
     */
    const lock = timingLock(getState().project, args.clipId);
    if (lock) {
      const cur = findClip(getState().project, args.clipId)!.clip;
      const wantStart = args.start ?? cur.start;
      const wantEnd = args.end ?? cur.end;
      if (Math.abs(wantEnd - wantStart - (cur.end - cur.start)) > 1e-3) {
        throw new Error(`改不了时长:${lock.message}`);
      }
      if (args.trackId !== undefined && args.trackId !== findClip(getState().project, args.clipId)!.track.id) {
        throw new Error(`换不了序列:${lock.message}`);
      }
      for (const side of ["fadeIn", "fadeOut"] as const) {
        if (args[side] !== undefined && lock.transitions.some((tr) =>
          (tr.kind === "crossfade" && ((side === "fadeOut" && tr.aId === args.clipId) || (side === "fadeIn" && tr.bId === args.clipId))) ||
          (tr.kind === side && tr.aId === args.clipId))) {
          throw new Error(`${side} 是转场的时长,不能单独改:${lock.message}`);
        }
      }
    }
    // params 是增量补丁(setClipParams 默认合并):回显里列出真正变了的键,带回旧值时模型自己看得见
    const paramsBefore = args.params ? (findClip(getState().project, args.clipId)?.clip.params as Record<string, unknown> | undefined) : undefined;
    if (args.params) actions.setClipParams(args.clipId, args.params);
    // 不透明度 / 淡入淡出 / 标签:store 早就支持,以前只是没暴露给模型 —— 系统提示词让它
    // 「遮到人就降不透明度」,它却没有工具能做。
    const patch: { opacity?: number; fadeIn?: number; fadeOut?: number; label?: string } = {};
    for (const k of ["opacity", "fadeIn", "fadeOut"] as const) {
      const v = args[k];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${k} 必须是有限数字,收到 ${JSON.stringify(v)}`);
      if (k === "opacity" && (v < 0 || v > 1)) throw new Error(`opacity 是 0~1,收到 ${v}`);
      if (k !== "opacity" && v < 0) throw new Error(`${k} 是秒数,不能为负,收到 ${v}`);
      patch[k] = v;
    }
    if (args.label !== undefined) patch.label = String(args.label);
    if (Object.keys(patch).length) actions.updateClip(args.clipId, patch);
    if (args.trackId !== undefined && !getState().project.tracks.some((t) => t.id === args.trackId)) {
      throw new Error(`找不到序列 ${args.trackId};get_project 里 tracks 的 id 才是有效值`);
    }
    if (args.start !== undefined || args.end !== undefined || args.trackId !== undefined) {
      actions.moveClip(args.clipId, { start: args.start, end: args.end, trackId: args.trackId });
    }
    if (args.cardId !== undefined) actions.setClipCard(args.clipId, args.cardId);
    clipGuard.noteMutation();
    return {
      ok: true, clipId: args.clipId, look: lookHint(args.clipId), timeline: timelineDigest(getState().project),
      ...(args.params ? paramsEcho(paramsBefore, findClip(getState().project, args.clipId)?.clip.params) : null),
      ...(lock ? { movedGroup: lock.members, note: "这段挂着转场,整组一起挪了" } : {}),
    };
  }),
  removeClip: (args) => {
    // 门槛:删自己刚建的卡、或一口气连删一串,要 force + reason。理由回显给用户。见 toolEcho.ts。
    const a = args as { clipId: string; force?: boolean; reason?: string };
    assertClipNotParked(a.clipId);
    const { reason } = clipGuard.checkRemove(a);
    actions.removeClip(a.clipId);
    clipGuard.noteRemoved(a.clipId);
    return { ok: true, removed: a.clipId, ...(reason ? { reason } : null), timeline: timelineDigest(getState().project) };
  },
  // 约定封装:Agent 看到和改的都是它(kernel/envelope.ts),不是原始 clip 也不是组件源码
  getClip: /* @__PURE__ */ inClipCut((args: Args<"getClip">) => {
    const hit = findClip(getState().project, args.clipId);
    if (!hit) throw clipMissingError(args.clipId);
    const envelope = envelopeOf(getState().project, hit.clip, getCard(hit.clip.cardId), stageSize());
    // 剪辑段:另带引用哪条剪辑、偏移、被引用剪辑的总时长、音量与静音(kernel/cutSegments.ts)
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
    if (lock) throw new Error(`切不开:${lock.message}`);
    const c = actions.splitClip(args.clipId, args.t);
    if (!c) throw new Error("切分失败");
    clipGuard.noteCreated(c.id);
    return c;
  },
  duplicateClip: (args) => { assertClipNotParked(args.clipId); const c = actions.duplicateClip(args.clipId); if (!c) throw new Error("复制失败"); clipGuard.noteCreated(c.id); return c; },
  setEmphasis: /* @__PURE__ */ inClipCut((args: Args<"setEmphasis">) => {
    const clipId = String(args.clipId ?? "");
    const kind = String(args.kind ?? "");
    if (!clipId) throw new Error("要 clipId");
    if (kind === "none") {
      const r = actions.setClipEmphasis(clipId, null);
      if (!r.ok) throw new Error(r.error ?? "去不掉");
      clipGuard.noteMutation();
      return { ok: true, clipId, emphasis: null, note: "强调去掉了" };
    }
    if (kind !== "shadow" && kind !== "outline") {
      throw new Error(`kind 只能是 shadow(阴影)/ outline(描边)/ none(去掉),收到 ${JSON.stringify(args.kind)}`);
    }
    const r = actions.setClipEmphasis(clipId, {
      kind, color: args.color, size: args.size, opacity: args.opacity, dx: args.dx, dy: args.dy,
    });
    if (!r.ok) throw new Error(r.error ?? "加不上");
    clipGuard.noteMutation();
    return {
      ok: true, clipId, emphasis: r.emphasis, describe: describeEmphasis(r.emphasis),
      look: lookHint(clipId),
      note: "强调沿着画面里不透明部分的边缘走(按 alpha 算),透明底的卡片、抠好的人物最明显;整块不透明的画面只会在方框外圈看到一条边。",
    };
  }),
} satisfies Partial<EditorApi>;

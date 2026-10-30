import { EditorApi } from "../../ai/mcpExecutor";
import { getState, actions } from "../../store/project";
import { getCard } from "../../kernel/registry";
import { envelopeOf } from "../../kernel/envelope";
import { addPart as addPartToTree, movePart as movePartInTree, removePart as removePartFromTree, updatePart as updatePartInTree, validatePartTree } from "../../kernel/parts";
import { allParts, getPart } from "../../kernel/partRegistry";
import { COMPOSITE_CARD_ID } from "../../cards/native/composite";
import type { PartInstance } from "../../kernel/types";
import { timelineDigest, lookHint } from "../tools/toolEcho";

import { stageSize, withParts, clipGuard } from "../common";

export const partsHandlers = {
  // 部件库 + 组合卡:Agent 用部件搭卡,操作的仍然是封装(clip.parts 那棵实例树)
  listParts: (args) => {
    const wanted = args?.partId ? [getPart(args.partId)].filter(Boolean) : allParts();
    if (args?.partId && wanted.length === 0) throw new Error(`没有 id 为 "${args.partId}" 的部件。可用的:${allParts().map((p) => p.id).join(", ")}`);
    const full = args?.detail === "full" || !!args?.partId;
    return wanted.map((p) => {
      const base = {
        id: p!.id, name: p!.name, description: p!.description, role: p!.role,
        ...(p!.useWhen ? { useWhen: p!.useWhen } : {}), ...(p!.tags?.length ? { tags: p!.tags } : {}), ...(p!.from ? { from: p!.from } : {}),
      };
      if (full) return { ...base, controls: p!.controls, defaults: p!.defaults, defaultFrame: p!.defaultFrame ?? null, after: p!.after ?? "hold" };
      return { ...base, params: p!.controls.map((c) => (c.required ? `${c.key}*` : c.key)), hint: "带 * 的是必填。要完整 schema 就用 list_parts({ partId })。" };
    });
  },
  addComposite: (args) => {
    if (typeof args.start !== "number" || !Number.isFinite(args.start)) throw new Error("start 要是秒数");
    if (args.parts !== undefined && !Array.isArray(args.parts)) throw new Error("parts 要是数组,每项 { partId, params?, frame?, enterMs?, children? }");
    // 没给 id 的实例补一个;validatePartTree 要求有 id,所以先补再校验
    const withIds = (list: unknown[]): unknown[] => list.map((raw) => {
      const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
      return { ...r, id: r.id ?? ("p" + Math.random().toString(36).slice(2, 8)), ...(Array.isArray(r.children) ? { children: withIds(r.children) } : {}) };
    });
    const parts = args.parts !== undefined ? validatePartTree(withIds(args.parts as unknown[]), getPart) : [];
    // 没给 frame 的实例用部件的 defaultFrame
    const fillFrames = (list: PartInstance[]): PartInstance[] => list.map((n) => ({
      ...n,
      ...(!n.frame && getPart(n.partId)?.defaultFrame ? { frame: { ...getPart(n.partId)!.defaultFrame! } } : {}),
      ...(n.children ? { children: fillFrames(n.children) } : {}),
    }));
    if (args.trackId !== undefined && !getState().project.tracks.some((t) => t.id === args.trackId)) throw new Error(`找不到序列 ${args.trackId}`);
    const clip = actions.addCardClip(COMPOSITE_CARD_ID, args.start, { trackId: args.trackId, duration: args.duration, parts: fillFrames(parts) });
    if (!clip) throw new Error("没有序列可放,先 add_track");
    clipGuard.noteCreated(clip.id);
    return { ok: true, clipId: clip.id, envelope: envelopeOf(getState().project, clip, getCard(COMPOSITE_CARD_ID), stageSize()), look: lookHint(clip.id), timeline: timelineDigest(getState().project) };
  },
  addPart: (args) => withParts(args.clipId, (tree) => addPartToTree(tree, { partId: args.partId, params: args.params, frame: args.frame as any, enterMs: args.enterMs, label: args.label }, getPart, { parentId: args.parentId ?? null, index: args.index }), (r) => ({ partInstanceId: r.node.id })),
  setPart: (args) => {
    // schema 里 type 只能是单一字符串(Gemini 不认数组 type),所以「清掉框」用 { clear: true } 表示,这里翻成 null
    const frame = args.frame && typeof args.frame === "object" && (args.frame as { clear?: boolean }).clear === true ? null : (args.frame as any);
    return withParts(args.clipId, (tree) => updatePartInTree(tree, args.partInstanceId, { params: args.params, frame, enterMs: args.enterMs, label: args.label }, getPart));
  },
  removePart: (args) => withParts(args.clipId, (tree) => ({ tree: removePartFromTree(tree, args.partInstanceId) })),
  movePart: (args) => withParts(args.clipId, (tree) => ({ tree: movePartInTree(tree, args.partInstanceId, { parentId: args.parentId || null, index: args.index }) })),
} satisfies Partial<EditorApi>;

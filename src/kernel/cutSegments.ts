/**
 * 剪辑段:放在一条剪辑序列里、引用另一条剪辑的片段(`product/project-model.md`「剪辑」「片段」)。
 *
 * # 存法
 *
 * 剪辑段是一个普通的 `TrackClip`,只是既没有 `cardId`(空串)也没有 `mediaId`,而是带着
 * `cutId`(引用哪条剪辑)和 `cutOffset`(从被引用剪辑的哪一秒开始,缺省 0)。框、淡入淡出、
 * 不透明度、独立静音(`audioMuted`)、音量(`audioVolume`)和素材段同名同义。
 * 引用而不是复制:被引用剪辑改了,引用它的各处画面与声音一起变。
 *
 * 0.7.18 及更早的页面读到它:`flattenOverlay` 跳过没有 `cardId` 的段、`videoLayersAt` 跳过没有
 * `mediaId` 的段,所以只是不画、不出声,字段原样保留(Argon 审核意见第 3 节决定 7 核对过)。
 *
 * # 画面怎么出(`mechanism/rendering.md`「剪辑段」)
 *
 * 渲染侧不把剪辑段拆成一堆普通片段,而是把它当成一张「卡」:`flattenOverlay` 把它交成
 * `cardId: CUT_SEGMENT_CARD` 的时间轴片段,带上被引用剪辑的子项目(`cut` 字段)。舞台给它一个
 * 普通的卡片包裹层(框、不透明度、淡入淡出、层序都和卡片一样),包裹层里再挂一个嵌套的场景,
 * 按 `cutOffset + (t − 段起点)` 渲被引用剪辑的整帧。预览、导出、预渲染、Agent 看画面走的都是
 * 同一份 `FrameScene` / `Stage`,所以同一时刻同一帧。
 *
 * # 声音怎么出
 *
 * 声音那边没有「嵌套的场景」可挂,所以按时间把被引用剪辑里出声的片段平移、裁到段的窗口里,
 * 拼成一份只给混音用的项目(`audioProjectOf`)。每层剪辑段的淡入淡出写成包络(`cutEnv`),
 * 由 `opacityAt` 和各个混音器乘上去。
 *
 * 纯函数,不碰 store。node 里能直接测(`cutSegments.test.mjs`)。
 */
import type { Cut, Project, Track, TrackClip } from "./project.ts";
import type { Transition } from "./transitions.ts";

/** 时间轴(`Timeline`)里剪辑段用的卡片 id。注册表里没有这张卡,舞台按 `clip.cut` 认它 */
export const CUT_SEGMENT_CARD = "@cut";

/** 停放的剪辑缺 duration 时的兜底,和 `cuts.ts` 的新剪辑默认时长同一个数 */
const FALLBACK_CUT_DURATION = 30;

/** 嵌套深度的硬上限。正常的项目远到不了(防环之后深度就是剪辑数),这里只防坏数据把渲染拖死 */
export const MAX_CUT_DEPTH = 32;

import type { CutEnvelope } from "./cutAudio.mjs";
import { clipFrameMode } from "./frameMode.mjs";
import { getCard } from "./registry.ts";

/** 这一段是剪辑段吗 */
export function isCutSegment(c: { cutId?: unknown } | null | undefined): boolean {
  return !!c && typeof c.cutId === "string" && c.cutId.length > 0;
}

/**
 * 剪辑段放好以后引用哪条剪辑不能改(2026-10-21 用户定,`workflow/editing.md`「剪辑段的属性」、`product/project-model.md`「片段」)。
 * 属性面板没有换引用的入口;Agent 的 set_cut_segment 带了 cutId / name、store 动作带了 cutId 都回这句。
 */
export const CUT_SEGMENT_REF_FIXED = "剪辑段引用的剪辑不能改，要换就删掉这段，用 add_cut_segment 放一段新的";

/** 当前激活的剪辑 id(没有 cuts 的老项目返回 undefined) */
export function activeCutIdOf(p: Pick<Project, "cuts" | "activeCutId">): string | undefined {
  const cuts = Array.isArray(p.cuts) ? p.cuts : [];
  if (!cuts.length) return undefined;
  return p.activeCutId && cuts.some((c) => c.id === p.activeCutId) ? p.activeCutId : cuts[0].id;
}

export interface CutContent {
  id: string;
  name: string;
  tracks: Track[];
  duration: number;
  transitions: Transition[];
}

/**
 * 一条剪辑的内容。激活那条在 `Project.tracks` 上,停放的在各自条目里(`kernel/cuts.ts` 的存法)。
 * 找不到、或停放条目没带 tracks(坏数据)时返回 null —— 调用方按「悬空引用」处理,不抛。
 */
export function cutContent(p: Project, cutId: string): CutContent | null {
  const cuts = Array.isArray(p.cuts) ? p.cuts : [];
  const entry = cuts.find((c) => c.id === cutId);
  if (!entry) return null;
  if (cutId === activeCutIdOf(p)) {
    return { id: entry.id, name: entry.name, tracks: p.tracks, duration: p.duration, transitions: Array.isArray(p.transitions) ? p.transitions : [] };
  }
  if (!Array.isArray(entry.tracks)) return null;
  return {
    id: entry.id, name: entry.name, tracks: entry.tracks,
    duration: typeof entry.duration === "number" && entry.duration > 0 ? entry.duration : FALLBACK_CUT_DURATION,
    transitions: Array.isArray(entry.transitions) ? entry.transitions : [],
  };
}

/** 一条剪辑的总时长(素材库显示的、拖进来时剪辑段的默认长度)。找不到返回 0 */
export function cutDuration(p: Project, cutId: string): number {
  return cutContent(p, cutId)?.duration ?? 0;
}

/** 一组序列里直接引用到的剪辑 id(去重、按出现顺序) */
export function segmentTargets(tracks: readonly Track[] | undefined): string[] {
  const out: string[] = [];
  for (const tr of tracks ?? []) for (const c of tr.clips ?? []) {
    if (isCutSegment(c) && !out.includes(c.cutId!)) out.push(c.cutId!);
  }
  return out;
}

/** 这组序列里有没有剪辑段(没有就什么都不用展开,调用方原样返回) */
export function hasCutSegments(tracks: readonly Track[] | undefined): boolean {
  for (const tr of tracks ?? []) for (const c of tr.clips ?? []) if (isCutSegment(c)) return true;
  return false;
}

/** 引用图:每条剪辑直接引用了哪些剪辑 */
export function cutEdges(p: Project): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const c of Array.isArray(p.cuts) ? p.cuts : []) {
    const content = cutContent(p, c.id);
    edges.set(c.id, content ? segmentTargets(content.tracks) : []);
  }
  return edges;
}

/** 从 `from` 出发(含它自己引用的、它引用的再引用的……任意深度)能走到的剪辑 id。不含 `from` 本身,除非成环 */
export function reachableCuts(p: Project, from: string, edges: Map<string, string[]> = cutEdges(p)): Set<string> {
  const seen = new Set<string>();
  const stack = [...(edges.get(from) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of edges.get(id) ?? []) if (!seen.has(next)) stack.push(next);
  }
  return seen;
}

/**
 * 把剪辑 `child` 放进剪辑 `host` 会不会循环引用:放进自己,或 `child` 已经(任意深度)引用了 `host`。
 * 会的话返回给人看的原因,不会返回 null。拖放、Agent 工具、文档写入三处共用这一条判断。
 */
export function cutCycleReason(p: Project, hostCutId: string, childCutId: string): string | null {
  const name = (id: string) => (Array.isArray(p.cuts) ? p.cuts.find((c) => c.id === id)?.name : undefined) ?? id;
  if (hostCutId === childCutId) return `不能把剪辑「${name(childCutId)}」放进它自己`;
  const edges = cutEdges(p);
  const reach = reachableCuts(p, childCutId, edges);
  if (reach.has(hostCutId)) {
    const direct = (edges.get(childCutId) ?? []).includes(hostCutId);
    return direct
      ? `剪辑「${name(childCutId)}」已经引用了「${name(hostCutId)}」,再放进来会循环引用`
      : `剪辑「${name(childCutId)}」间接引用了「${name(hostCutId)}」,再放进来会循环引用`;
  }
  return null;
}

/** 项目里现有的循环引用(协作合并可能造出来):每个环报一次,给检查和修复用 */
export function cutCycles(p: Project): string[][] {
  const edges = cutEdges(p);
  const out: string[][] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string) => {
    state.set(id, 1);
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      const s = state.get(next) ?? 0;
      if (s === 0) visit(next);
      else if (s === 1) out.push(stack.slice(stack.indexOf(next)));
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const id of edges.keys()) if ((state.get(id) ?? 0) === 0) visit(id);
  return out;
}

/**
 * 「切到剪辑 `cutId` 时项目的样子」,只读:tracks / 总时长 / 转场换成那条剪辑的内容,其余项目级字段照旧。
 * 给要按「片段所在的那条剪辑」算东西的地方用(导出前在被引用剪辑里生成卡片声音:身份、合成都按这条剪辑的序列算,
 * 和用户切过去再生成是同一个结果)。激活的那条原样返回;找不到返回 null。不落盘、不进 store。
 */
export function cutViewProject(p: Project, cutId: string): Project | null {
  if (!cutId || cutId === activeCutIdOf(p)) return p;
  const content = cutContent(p, cutId);
  if (!content) return null;
  return {
    ...p,
    tracks: content.tracks,
    duration: content.duration,
    transitions: content.transitions,
    activeCutId: cutId,
    cuts: (p.cuts ?? []).map((c) => (c.id === cutId ? { id: c.id, name: c.name } : c)) as Cut[],
  };
}

/** 在剪辑 `cutId`(缺省激活的那条)里找片段;返回那条剪辑的只读视图和片段 */
export function findClipInCut(p: Project, cutId: string | undefined, clipId: string): { view: Project; track: Track; clip: TrackClip } | null {
  const view = cutId ? cutViewProject(p, cutId) : p;
  if (!view) return null;
  for (const track of view.tracks) for (const clip of track.clips) if (clip.id === clipId) return { view, track, clip };
  return null;
}

/** 直接引用了剪辑 `cutId` 的那些剪辑,各自哪几段 */
export function cutReferences(p: Project, cutId: string): { cutId: string; name: string; clipIds: string[] }[] {
  const out: { cutId: string; name: string; clipIds: string[] }[] = [];
  for (const c of Array.isArray(p.cuts) ? p.cuts : []) {
    const content = cutContent(p, c.id);
    if (!content) continue;
    const clipIds = content.tracks.flatMap((tr) => tr.clips.filter((cl) => cl.cutId === cutId).map((cl) => cl.id));
    if (clipIds.length) out.push({ cutId: c.id, name: c.name, clipIds });
  }
  return out;
}

/* ───────────────────── 删除:连同引用它的剪辑段 ───────────────────── */

/** 去掉一组片段,连带清掉引用它们的转场并把另一头的淡化擦干净(和 store 的 removeClip 同一个规矩) */
function dropClips(tracks: Track[], transitions: Transition[], ids: Set<string>): { tracks: Track[]; transitions: Transition[] } {
  if (!ids.size) return { tracks, transitions };
  const doomed = transitions.filter((tr) => ids.has(tr.aId) || (tr.bId !== undefined && ids.has(tr.bId)));
  let next = tracks.map((t) => (t.clips.some((c) => ids.has(c.id)) ? { ...t, clips: t.clips.filter((c) => !ids.has(c.id)) } : t));
  const clear = (clipId: string | undefined, side: "fadeIn" | "fadeOut") => {
    if (!clipId || ids.has(clipId)) return;
    next = next.map((t) => (t.clips.some((c) => c.id === clipId) ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, [side]: 0 } : c)) } : t));
  };
  for (const tr of doomed) {
    if (tr.kind === "crossfade") { clear(tr.aId, "fadeOut"); clear(tr.bId, "fadeIn"); }
    else clear(tr.aId, tr.kind === "fadeIn" ? "fadeIn" : "fadeOut");
  }
  return { tracks: next, transitions: doomed.length ? transitions.filter((tr) => !doomed.includes(tr)) : transitions };
}

/**
 * 把所有剪辑(激活的和停放的)里引用 `cutId` 的剪辑段删掉,连带它们的转场。
 * 删剪辑本身由 `kernel/cuts.ts` 的 `removeCut` 做;它先调这里。
 */
export function stripCutReferences(p: Project, cutId: string): Project {
  const hit = (tracks: Track[] | undefined) => new Set((tracks ?? []).flatMap((t) => t.clips.filter((c) => c.cutId === cutId).map((c) => c.id)));
  let next = p;
  const activeIds = hit(p.tracks);
  if (activeIds.size) {
    const r = dropClips(p.tracks, Array.isArray(p.transitions) ? p.transitions : [], activeIds);
    next = { ...next, tracks: r.tracks, ...(p.transitions || r.transitions.length ? { transitions: r.transitions } : {}) };
  }
  if (Array.isArray(p.cuts) && p.cuts.some((c) => c.tracks && hit(c.tracks).size)) {
    next = {
      ...next,
      cuts: p.cuts.map((c) => {
        const ids = hit(c.tracks);
        if (!ids.size || !c.tracks) return c;
        const r = dropClips(c.tracks, c.transitions ?? [], ids);
        return { ...c, tracks: r.tracks, transitions: r.transitions };
      }),
    };
  }
  return next;
}

/* ───────────────────── 渲染:子项目与时间轴片段 ───────────────────── */

/** 渲染用的子项目额外带一条路径(从根剪辑起经过的剪辑 id),防环用。只在内存里,不落盘 */
export type CutRenderProject = Project & { cutPath?: readonly string[] };

/** 时间轴(`Timeline`)里剪辑段片段带的东西 */
export interface CutSegmentRender {
  cutId: string;
  /**
   * 时间轴片段起点对应被引用剪辑的哪一秒。没有预卷时就是 `cutOffset`;有预卷时是 `cutOffset − 预卷`
   * (时间轴片段的起点也提前了同样多,所以「父时间 t ↔ 被引用剪辑 offset + (t − 片段起点)」不变)。
   */
  offset: number;
  /** 剪辑段在父剪辑上真正露出来的起点(秒)。预卷那一截在它之前:嵌套场景照常推进,画面不露 */
  from: number;
  /** 被引用剪辑此刻的总时长:`offset + 本地时间` 超出它的部分透明无声 */
  duration: number;
  /** 被引用剪辑的子项目(tracks 换成它的内容,其余项目级字段照旧) */
  project: CutRenderProject;
  /** 推帧口径:子项目里没有要按历史推进的卡就是 direct,随机跳转不用从段起点推 */
  frameMode: "direct" | "stateful";
}

/** 只是给子项目「哪些项目级字段一样」做比对的列表;改了就重建子项目 */
const SUB_DEPS = ["width", "height", "fps", "themeId", "camera3dFov", "media", "filters", "pixelMaps", "audioFx", "cardNodes", "style", "glRoute", "id", "name"] as const;

const subMemo = new WeakMap<object, Map<string, { deps: unknown[]; sub: CutRenderProject }>>();

/**
 * 剪辑 `cutId` 的渲染子项目。`path` 是从根到父剪辑的路径;`cutId` 已经在路径上(成环)、
 * 找不到(悬空引用)、或太深,返回 null —— 调用方跳过这一段,不抛、不白屏。
 *
 * 按 `p.cuts` 的对象引用记忆化:同一份项目反复问(FrameScene 每个片段都会拿裁剪版项目调一次
 * `flattenOverlay`)拿到的是同一个子项目对象,舞台的 memo 不白算。
 */
export function cutSubProject(p: CutRenderProject, cutId: string): CutRenderProject | null {
  if (!Array.isArray(p.cuts)) return null;
  const root = activeCutIdOf(p);
  const path = p.cutPath ?? (root ? [root] : []);
  if (path.includes(cutId) || path.length >= MAX_CUT_DEPTH) return null;
  const key = `${path.join(">")}>${cutId}`;
  const deps = SUB_DEPS.map((k) => (p as unknown as Record<string, unknown>)[k]);
  // 激活剪辑的内容在 p.tracks 上:被引用的不会是根(成环),但可能是路径上的父剪辑引用了「此刻的激活剪辑」以外的
  // 任何一条 —— 那些都在 cuts 里。所以键只看 cuts 的引用与项目级字段。
  let byKey = subMemo.get(p.cuts);
  if (!byKey) { byKey = new Map(); subMemo.set(p.cuts, byKey); }
  const hit = byKey.get(key);
  if (hit && hit.deps.every((d, i) => d === deps[i])) return hit.sub;
  const content = cutContent(p, cutId);
  if (!content) return null;
  const { _cardRender: _drop, cutPath: _path, ...rest } = p as CutRenderProject & { _cardRender?: unknown };
  const sub: CutRenderProject = {
    ...rest,
    tracks: content.tracks,
    duration: content.duration,
    transitions: content.transitions,
    activeCutId: cutId,
    // 子项目里「激活」的就是被引用的这条:它的条目不带内容(内容在 tracks 上),和 cuts.ts 的存法一致
    cuts: p.cuts.map((c) => (c.id === cutId ? { id: c.id, name: c.name } : c)) as Cut[],
    cutPath: [...path, cutId],
  };
  byKey.set(key, { deps, sub });
  return sub;
}

/*
 * 卡片的推帧口径直接问注册表。注意:不能反过来让注册表(或 frameMode.mjs、types.ts)import 这个模块 ——
 * 它们在卡片声音身份的源码闭包里(`render/audioCardSourceVersion.test.mjs`),多一个文件就会让用户已生成的卡片声音全部判过期。
 * 单测可以用 `setCutClipFrameMode` 换掉。
 */
type ModeOf = (clip: TrackClip) => "direct" | "stateful";
const registryMode: ModeOf = (clip) => (clipFrameMode(clip, getCard(clip.cardId)) === "direct" ? "direct" : "stateful");
let modeOfClip: ModeOf | null = registryMode;
/** 单测用:换掉查卡的口径;传 null 恢复成查注册表 */
export function setCutClipFrameMode(fn: ModeOf | null): void {
  modeOfClip = fn ?? registryMode;
}

const modeMemo = new WeakMap<object, "direct" | "stateful">();
/** 子项目的推帧口径:有任何一段卡(或嵌套的剪辑段)要按历史推进就是 stateful。查不了卡时保守地算 stateful */
export function cutFrameMode(sub: CutRenderProject): "direct" | "stateful" {
  const hit = modeMemo.get(sub);
  if (hit) return hit;
  let mode: "direct" | "stateful" = "direct";
  outer: for (const tr of sub.tracks) {
    if (tr.hidden) continue;
    for (const c of tr.clips) {
      if (isCutSegment(c)) {
        const inner = cutSubProject(sub, c.cutId!);
        if (inner && cutFrameMode(inner) === "stateful") { mode = "stateful"; break outer; }
        continue;
      }
      if (!c.cardId && !c.nodeId) continue; // 素材段是直接按时刻取的
      if (!modeOfClip || modeOfClip(c) !== "direct") { mode = "stateful"; break outer; }
    }
  }
  modeMemo.set(sub, mode);
  return mode;
}

/** 和 `render/frameWindow.mjs` 的 `CARD_MOUNT_LEAD` 同一个数:卡片提前这么多挂载 */
const MOUNT_LEAD = 0.05;

/**
 * 要正确画出子项目在 τ 时刻的样子,最早得从子项目的哪一秒开始往后推(≤ τ)。
 * 此刻挂着的、要按历史推进的卡,得从它自己的起点推;嵌套的剪辑段按它的时间轴片段起点(含它自己的预卷)算。
 */
export function cutHistoryStart(sub: CutRenderProject, tau: number): number {
  let h = tau;
  for (const tr of sub.tracks) {
    if (tr.hidden) continue;
    for (const c of tr.clips) {
      if (isCutSegment(c)) {
        const inner = cutSubProject(sub, c.cutId!);
        if (!inner || cutFrameMode(inner) === "direct") continue;
        const mount = c.start - cutPreroll(sub, c, inner);
        if (tau >= mount - MOUNT_LEAD && tau < c.end) h = Math.min(h, mount);
        continue;
      }
      if (!c.cardId && !c.nodeId) continue;
      if (!(tau >= c.start - MOUNT_LEAD && tau < c.end)) continue;
      if (modeOfClip && modeOfClip(c) === "direct") continue;
      h = Math.min(h, c.start);
    }
  }
  return h;
}

/**
 * 剪辑段的预卷(秒):`cutOffset > 0` 时,被引用剪辑里在 `cutOffset` 那一刻已经播了一半的、要按历史推进的卡,
 * 得从它们自己的起点推过来才对得上。做法是把时间轴片段的起点往前挪这么多(嵌套场景从更早处开始推,
 * 画面在真正的起点之前不露)。挪不到 0 之前:段贴着时间轴开头时预卷截到段起点为止。
 */
export function cutPreroll(p: CutRenderProject, clip: TrackClip, sub: CutRenderProject | null = cutSubProject(p, clip.cutId!)): number {
  if (!sub || cutFrameMode(sub) === "direct") return 0;
  const offset = Math.max(0, clip.cutOffset ?? 0);
  if (offset <= 0) return 0;
  const need = offset - cutHistoryStart(sub, offset);
  return Math.max(0, Math.min(need, clip.start));
}

/**
 * `flattenOverlay` 交出的时间轴片段:剪辑段那一条多带一个 `cut`。不写进 `types.ts` 的 `Clip`(那份在卡片声音身份的源码闭包里)。
 */
export type TimelineCutClip = import("./types").Clip & { cut?: CutSegmentRender };
/** 时间轴片段是不是剪辑段;是的话给出它的渲染信息 */
export function cutOf(clip: unknown): CutSegmentRender | undefined {
  return (clip as TimelineCutClip | null)?.cut;
}

/** 剪辑段在 `flattenOverlay` 里交出去的那份渲染信息;悬空、成环返回 null */
export function cutSegmentRender(p: CutRenderProject, clip: TrackClip): CutSegmentRender | null {
  if (!isCutSegment(clip)) return null;
  const sub = cutSubProject(p, clip.cutId!);
  if (!sub) return null;
  const pre = cutPreroll(p, clip, sub);
  return { cutId: clip.cutId!, offset: Math.max(0, clip.cutOffset ?? 0) - pre, from: clip.start, duration: sub.duration, project: sub, frameMode: cutFrameMode(sub) };
}

/* ───────────────────── 包络与声音(实现在 cutAudio.mjs:导出混音在服务端直接 import) ───────────────────── */

export { envelopeAt, audioProjectOf } from "./cutAudio.mjs";
export type { CutEnvelope, CutAudioOrigin } from "./cutAudio.mjs";

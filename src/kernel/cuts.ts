/**
 * 多条剪辑(时间轴)的纯逻辑:规范化、切换、新建、改名、删除、列表。
 *
 * 数据模型见 project.ts 的 Cut:内容只存一份 —— 激活那条的 tracks/duration 住在 Project 上,
 * 停放的各自带着。这里的函数都不碰 store,输入 Project 输出新 Project,好在 node 里测。
 */
// 带 .ts 扩展名导入:这个模块要能在 node 里直接跑单测(node --test 走 strip-types,不会给
// "./project" 补扩展名)。tsconfig 开了 allowImportingTsExtensions(noEmit 下允许)。
// id 必须复用 project.ts 的 newId —— 两个各自从 0 起的计数器同一毫秒里会撞出同一个 t-… id。
import { newId, type Cut, type Project, type Track } from "./project.ts";
import { activeCutIdOf, cutCycleReason, cutDuration, cutReferences, stripCutReferences } from "./cutSegments.ts";
import { contentEndOf, effectiveDuration, manualDurationFor } from "./duration.ts";

/**
 * 默认剪辑数:新项目和没有 cuts 字段的老文件只补「剪辑1」这一条,其余由用户或 Agent 新建
 * (2026-10-20 用户定:「剪辑默认有3个,这不符合预期——用户又没创建那么多,只留一个就行了」)。
 * 已经带着 cuts 的项目原样保留,不因此删减。
 */
export const DEFAULT_CUT_COUNT = 1;
const DEFAULT_CUT_DURATION = 30;

function emptyTracks(): Track[] {
  return [
    { id: newId("t"), name: "序列 1", clips: [] },
    { id: newId("t"), name: "序列 2", clips: [] },
  ];
}

/** 下一个默认名:剪辑N,N = 现有「剪辑数字」里最大的 + 1 */
export function nextCutName(cuts: Cut[]): string {
  let max = 0;
  for (const c of cuts) {
    const m = /^剪辑\s*(\d+)$/.exec(c.name.trim());
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `剪辑${max + 1}`;
}

/**
 * 把项目补成合法的多剪辑形状。幂等,加载时调一次:
 *   - 没有 cuts:当前 tracks 就是「剪辑1」(DEFAULT_CUT_COUNT 为 1 时不再补空的);
 *   - activeCutId 不在 cuts 里:取第一条;
 *   - 激活那条的条目不该带 tracks(内容在 Project 上)。真带了且 Project.tracks 是空的,
 *     就把它收进来 —— 这是文件被手改过的情况,宁可保住内容;否则丢掉条目里的;
 *   - 停放的条目缺 tracks / duration 就补空的。
 */
export function normalizeCuts(p: Project): Project {
  let cuts: Cut[] = Array.isArray(p.cuts) ? p.cuts.map((c) => ({ ...c })) : [];
  let tracks = p.tracks;
  let duration = p.duration;

  if (cuts.length === 0) {
    cuts = [{ id: "cut-1", name: "剪辑1" }];
    for (let i = 2; i <= DEFAULT_CUT_COUNT; i++) {
      cuts.push({ id: `cut-${i}`, name: `剪辑${i}`, tracks: emptyTracks(), duration: DEFAULT_CUT_DURATION });
    }
  }
  let activeId = p.activeCutId;
  if (!activeId || !cuts.some((c) => c.id === activeId)) activeId = cuts[0].id;

  cuts = cuts.map((c) => {
    if (c.id === activeId) {
      if (c.tracks && tracks.length === 0) {
        tracks = c.tracks;
        if (typeof c.duration === "number") duration = c.duration;
      }
      const { tracks: _t, duration: _d, transitions: _x, ...rest } = c;
      return rest;
    }
    return {
      ...c,
      tracks: Array.isArray(c.tracks) ? c.tracks : emptyTracks(),
      duration: typeof c.duration === "number" && c.duration > 0 ? c.duration : DEFAULT_CUT_DURATION,
      transitions: Array.isArray(c.transitions) ? c.transitions : [],
    };
  });

  return { ...p, tracks, duration, cuts, activeCutId: activeId };
}

/** 素材库 / 标签栏 / list_cuts 要的摘要。激活那条的数字从 Project.tracks 上取 */
export function listCuts(p: Project): {
  id: string; name: string; active: boolean; trackCount: number; clipCount: number; duration: number;
  /** 直接引用了这条剪辑的那些剪辑(各自哪几段) */
  referencedBy: { cutId: string; name: string; clipIds: string[] }[];
  /** 这条剪辑里的剪辑段直接引用了哪些剪辑 */
  references: string[];
}[] {
  const q = normalizeCuts(p);
  return q.cuts!.map((c) => {
    const active = c.id === q.activeCutId;
    const tracks = active ? q.tracks : c.tracks ?? [];
    const refs: string[] = [];
    for (const t of tracks) for (const cl of t.clips) if (cl.cutId && !refs.includes(cl.cutId)) refs.push(cl.cutId);
    return {
      id: c.id,
      name: c.name,
      active,
      trackCount: tracks.length,
      clipCount: tracks.reduce((n, t) => n + t.clips.length, 0),
      duration: active ? q.duration : c.duration ?? DEFAULT_CUT_DURATION,
      referencedBy: cutReferences(q, c.id),
      references: refs,
    };
  });
}

/** 按 id 或名字找剪辑;找不到就抛,错误信息里列出现有的,给模型看的 */
export function resolveCut(p: Project, ref: { cutId?: string; name?: string }): Cut {
  const q = normalizeCuts(p);
  const cuts = q.cuts!;
  if (ref.cutId) {
    const hit = cuts.find((c) => c.id === ref.cutId);
    if (hit) return hit;
  }
  if (ref.name) {
    const want = ref.name.trim();
    const hit = cuts.find((c) => c.name.trim() === want);
    if (hit) return hit;
  }
  const names = cuts.map((c) => `${c.name}(${c.id})`).join("、");
  throw new Error(`找不到剪辑 ${JSON.stringify(ref.cutId ?? ref.name ?? "")};现有的:${names}`);
}

/**
 * 切换到另一条剪辑。当前内容(tracks / duration / 播放头 t)存回它的条目,目标的内容换进来。
 * 返回新项目和目标上次离开时的播放头。目标就是当前的话原样返回。
 */
export function switchCut(p: Project, cutId: string, t: number): { project: Project; t: number } {
  const q = normalizeCuts(p);
  if (cutId === q.activeCutId) return { project: q, t };
  const target = q.cuts!.find((c) => c.id === cutId);
  if (!target) throw new Error(`找不到剪辑 ${cutId}`);

  const cuts = q.cuts!.map((c) => {
    if (c.id === q.activeCutId) return { ...c, tracks: q.tracks, duration: q.duration, transitions: q.transitions ?? [], t };
    if (c.id === cutId) {
      const { tracks: _t, duration: _d, transitions: _x, t: _pt, ...rest } = c;
      return rest;
    }
    return c;
  });
  return {
    project: { ...q, tracks: target.tracks ?? emptyTracks(), duration: target.duration ?? DEFAULT_CUT_DURATION, transitions: target.transitions ?? [], cuts, activeCutId: cutId },
    t: target.t ?? 0,
  };
}

/** 新建一条停放的剪辑(不切换)。名字缺省按 剪辑N */
export function addCut(p: Project, name?: string): { project: Project; cut: Cut } {
  const q = normalizeCuts(p);
  const cut: Cut = {
    id: newId("cut"),
    name: (name ?? "").trim() || nextCutName(q.cuts!),
    tracks: emptyTracks(),
    duration: DEFAULT_CUT_DURATION,
    transitions: [],
  };
  return { project: { ...q, cuts: [...q.cuts!, cut] }, cut };
}

export function renameCut(p: Project, cutId: string, name: string): Project {
  const q = normalizeCuts(p);
  const trimmed = name.trim();
  if (!trimmed) throw new Error("剪辑名不能为空");
  if (!q.cuts!.some((c) => c.id === cutId)) throw new Error(`找不到剪辑 ${cutId}`);
  return { ...q, cuts: q.cuts!.map((c) => (c.id === cutId ? { ...c, name: trimmed } : c)) };
}

/**
 * 删一条剪辑。最后一条不能删。删的是激活那条时先切到相邻的一条(优先左边),
 * 返回里 switchedTo 告诉调用方切去了哪、播放头该是多少。
 *
 * 被别的剪辑引用着(剪辑段)时,引用它的那些剪辑段连同绑着它们的转场一起删
 * (`product/project-model.md`「剪辑」:先说明被哪些剪辑用着,确认后连同引用它的剪辑段一起删)。
 * 说明与确认是调用方的事(界面弹确认、Agent 工具要 force);这里返回 removedSegments 供调用方汇报。
 */
export function removeCut(p: Project, cutId: string, t: number): { project: Project; switchedTo: string | null; t: number; removedSegments: { cutId: string; name: string; clipIds: string[] }[] } {
  let q = normalizeCuts(p);
  const idx = q.cuts!.findIndex((c) => c.id === cutId);
  if (idx < 0) throw new Error(`找不到剪辑 ${cutId}`);
  if (q.cuts!.length <= 1) throw new Error("这是最后一条剪辑,不能删;要清空的话删掉里面的段就行");
  const removedSegments = cutReferences(q, cutId).filter((r) => r.cutId !== cutId);
  q = stripCutReferences(q, cutId);

  let switchedTo: string | null = null;
  let nextT = t;
  if (cutId === q.activeCutId) {
    const neighbor = q.cuts![idx > 0 ? idx - 1 : idx + 1];
    const s = switchCut(q, neighbor.id, t);
    q = s.project;
    nextT = s.t;
    switchedTo = neighbor.id;
  }
  return { project: { ...q, cuts: q.cuts!.filter((c) => c.id !== cutId) }, switchedTo, t: nextT, removedSegments };
}

/**
 * 把剪辑 `childCutId` 作为剪辑段放进激活剪辑的一条序列。纯函数:返回新项目和新段;放不下(重叠)、
 * 会循环引用、找不到剪辑时抛,错误信息给人看(拖放的提示条、Agent 工具都用它)。
 *
 * 剪辑段的默认长度 = 被引用剪辑(从 offset 起)剩下的长度;给了 duration 也不能超出它。
 */
export function placeCutSegment(
  p: Project,
  childCutId: string,
  start: number,
  opts: { trackId?: string; duration?: number; offset?: number; id?: string } = {},
): { project: Project; clip: import("./project.ts").TrackClip } {
  const q = normalizeCuts(p);
  const host = q.activeCutId!;
  if (!q.cuts!.some((c) => c.id === childCutId)) throw new Error(`找不到剪辑 ${childCutId}`);
  const reason = cutCycleReason(q, host, childCutId);
  if (reason) throw new Error(reason);
  const offset = Math.max(0, opts.offset ?? 0);
  const total = cutDuration(q, childCutId);
  const room = total - offset;
  if (!(room > 0.05)) throw new Error(`剪辑「${q.cuts!.find((c) => c.id === childCutId)!.name}」从第 ${offset} 秒起已经没有内容可放(总时长 ${total} 秒)`);
  const dur = Math.min(opts.duration ?? room, room);
  if (!(dur > 0)) throw new Error("剪辑段的长度要大于 0");
  const s = Math.max(0, start);
  const track = opts.trackId ? q.tracks.find((t) => t.id === opts.trackId) : q.tracks[0];
  if (!track) throw new Error(`找不到序列 ${opts.trackId ?? ""}`);
  if (track.locked) throw new Error(`序列「${track.name}」锁着`);
  const clip = {
    id: opts.id ?? newId("k"), cardId: "", cutId: childCutId, start: s, end: s + dur, params: {},
    ...(offset > 0 ? { cutOffset: offset } : {}),
  };
  if (track.clips.some((c) => c.start < clip.end - 1e-9 && clip.start < c.end - 1e-9)) throw new Error(`序列「${track.name}」在 ${s} ~ ${s + dur} 秒已经有片段`);
  const tracks = q.tracks.map((t) => (t.id === track.id ? { ...t, clips: [...t.clips, clip].sort((a, b) => a.start - b.start) } : t));
  return { project: { ...q, tracks, duration: Math.max(q.duration, clip.end) }, clip };
}

/** 素材是项目级的:删素材要把停放剪辑里引用它的段也清掉,不能只清激活那条 */
export function stripMediaFromCuts(p: Project, mediaId: string): Project {
  if (!p.cuts) return p;
  return {
    ...p,
    cuts: p.cuts.map((c) =>
      c.tracks ? { ...c, tracks: c.tracks.map((t) => ({ ...t, clips: t.clips.filter((cl) => cl.mediaId !== mediaId) })) } : c),
  };
}

/** 摘掉片段上的滤镜字段(整个键拿掉,存盘结果和从没挂过一样) */
export function withoutFilter<T extends { filter?: unknown }>(clip: T): T {
  const { filter: _gone, ...rest } = clip;
  return rest as T;
}

/** 摘掉片段上的音频效果字段(整个键拿掉) */
export function withoutAudioFx<T extends { audioFx?: unknown }>(clip: T): T {
  const { audioFx: _gone, ...rest } = clip;
  return rest as T;
}

/** 音频效果同滤镜:删效果要把停放剪辑里挂着它的段也摘掉 */
export function stripAudioFxFromCuts(p: Project, fxId: string): Project {
  if (!p.cuts) return p;
  return {
    ...p,
    cuts: p.cuts.map((c) =>
      c.tracks
        ? { ...c, tracks: c.tracks.map((t) => ({ ...t, clips: t.clips.map((cl) => (cl.audioFx?.id === fxId ? withoutAudioFx(cl) : cl)) })) }
        : c),
  };
}

/** 滤镜也是项目级的:删滤镜要把停放剪辑里挂着它的段也摘掉,和 stripMediaFromCuts 一个道理 */
export function stripFilterFromCuts(p: Project, filterId: string): Project {
  if (!p.cuts) return p;
  return {
    ...p,
    cuts: p.cuts.map((c) =>
      c.tracks
        ? { ...c, tracks: c.tracks.map((t) => ({ ...t, clips: t.clips.map((cl) => (cl.filter?.id === filterId ? withoutFilter(cl) : cl)) })) }
        : c),
  };
}

/* ---------- 就地改停放剪辑里的片段(不切换激活剪辑) ----------
 *
 * 激活剪辑住在 Project.tracks 上,停放的住在 cuts[].tracks 里,所以 findClip 只找得到激活那条里的片段;
 * 以前 Agent 要改别的剪辑里的卡只能 switch_cut 切过去(activeCutId 是共享的项目字段,所有成员的界面一起翻),
 * 改完再切回来,两次多余的写入(2026-10-21 线上每轮都有)。
 *
 * 做法:把项目换成「那条剪辑当激活」的样子(`cutEditView`),让现成的按激活剪辑写的 store 动作照常工作,
 * 动作每次提交的新项目再折回真实形状(`foldCutEdit`):改到的只有那条剪辑条目里的 tracks / duration / transitions,
 * activeCutId 与激活剪辑的内容原样不动。折回时全是新对象,不原地改 store 里的项目对象。
 */

/** 哪条停放的剪辑里有这个片段(激活那条里的不算);没有返回 null */
export function parkedCutOfClip(p: Project, clipId: string): { cutId: string; cutName: string } | null {
  const active = activeCutIdOf(p);
  for (const c of Array.isArray(p.cuts) ? p.cuts : []) {
    if (c.id === active || !Array.isArray(c.tracks)) continue;
    for (const t of c.tracks) if (t.clips.some((cl) => cl.id === clipId)) return { cutId: c.id, cutName: c.name };
  }
  return null;
}

/**
 * 「把 `cutId` 当激活剪辑」的编辑视图:tracks / duration / transitions 换成它的内容,真正激活的那条退回条目里带着自己的内容。
 * 不是激活的那条、或不是带内容的停放剪辑时返回 null(调用方就地照常做)。
 */
export function cutEditView(real: Project, cutId: string): Project | null {
  const activeId = activeCutIdOf(real);
  if (!activeId || cutId === activeId) return null;
  const target = (real.cuts ?? []).find((c) => c.id === cutId);
  if (!target || !Array.isArray(target.tracks)) return null;
  const cuts = real.cuts!.map((c) => {
    if (c.id === activeId) return { ...c, tracks: real.tracks, duration: real.duration, transitions: real.transitions ?? [] };
    if (c.id === cutId) {
      const { tracks: _t, duration: _d, transitions: _x, ...rest } = c;
      return rest;
    }
    return c;
  });
  return {
    ...real,
    tracks: target.tracks,
    duration: typeof target.duration === "number" && target.duration > 0 ? target.duration : DEFAULT_CUT_DURATION,
    transitions: target.transitions ?? [],
    cuts,
    activeCutId: cutId,
  };
}

/** 停放剪辑的总时长跟着内容走:和 `agent-exec.mjs` 的 `settleDuration`、页面时间轴同一条规则(至少 1 秒) */
function settleCutDuration(before: { tracks: Track[]; duration: number }, afterTracks: Track[], afterDuration: number): number {
  if (afterTracks === before.tracks && afterDuration === before.duration) return afterDuration;
  const end = contentEndOf(afterTracks);
  const manual = afterDuration !== before.duration ? manualDurationFor(afterDuration, end) : manualDurationFor(before.duration, contentEndOf(before.tracks));
  const target = effectiveDuration(end, afterDuration, manual);
  if (Math.abs(target - afterDuration) <= 1e-6) return afterDuration;
  const val = Math.max(1, target);
  return Math.abs(val - afterDuration) < 1e-6 ? afterDuration : val;
}

/**
 * `cutEditView` 里的项目被动作改成 `edited` 之后,折回真实形状:`real` 是进视图之前的真实项目。
 * 项目级的改动(素材、效果库、卡片节点……)照 `edited`;激活剪辑的 tracks / duration / transitions / activeCutId 用 `real` 的;
 * `cutId` 那条的条目收下 `edited` 里的 tracks / duration / transitions(总时长跟着内容走)。
 */
export function foldCutEdit(real: Project, edited: Project, cutId: string): Project {
  const activeId = activeCutIdOf(real)!;
  const realTarget = real.cuts!.find((c) => c.id === cutId)!;
  const realActiveEntry = real.cuts!.find((c) => c.id === activeId)!;
  const beforeDuration = typeof realTarget.duration === "number" && realTarget.duration > 0 ? realTarget.duration : DEFAULT_CUT_DURATION;
  const duration = settleCutDuration({ tracks: realTarget.tracks!, duration: beforeDuration }, edited.tracks, edited.duration);
  // 条目原先没有 transitions 键、改完仍是空的,就不凭空多出一个键
  const nowT = edited.transitions ?? [];
  const transitions = realTarget.transitions !== undefined ? nowT : nowT.length ? nowT : undefined;
  const entry: Cut = {
    ...realTarget,
    tracks: edited.tracks,
    ...(duration === beforeDuration && realTarget.duration === undefined ? {} : { duration }),
    ...(transitions === undefined ? {} : { transitions }),
  };
  const cuts = (edited.cuts ?? real.cuts!).map((c) => (c.id === activeId ? realActiveEntry : c.id === cutId ? entry : c));
  const out: Project = { ...edited, tracks: real.tracks, duration: real.duration, cuts, activeCutId: real.activeCutId };
  if (real.transitions === undefined) delete out.transitions;
  else out.transitions = real.transitions;
  return out;
}

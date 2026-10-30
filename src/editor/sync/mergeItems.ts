/**
 * 「冲突合并」窗口的逐项合并引擎(纯函数,Node 单测可载入,不碰 store、不碰网络)。
 *
 * 语义:`docs/semantics/workflow/editing.md`「撤销、重做」的「两级可勾选列表」,
 * `docs/semantics/product/document-service.md`「冲突」(2026-10-22 用户定)。
 *
 * - **一级(「东西」)**:时间轴上的每个片段(卡片段、素材段、剪辑段)、每条字幕、项目设置,各算一条;
 *   序列、剪辑、转场、素材与各效果库里的条目同样按「东西」各算一条(不然它们的改动无处可列)。
 * - **二级(属性)**:这样东西被改的各个属性。比较的是「基准 → 我这边」两份,所以同一个属性改了几次只出一条;
 *   先改长度、又改透明度是两条。片段的开始与结束合成一条「时间」,换了所在序列另算一条「所在序列」。
 * - **增删也算**:我删了 / 我新增了各是一条整件的项(属性记为 `""`);我改了而云端已删除,各属性照列、都算冲突,
 *   「合并」时连同我的修改恢复回来。
 * - **冲突与「云端现在是什么」不入表**:每次显示、每次点「合并」都拿当时的项目现算(「每次点合并时重新核对」)。
 *
 * 待合并表里的一条记录是一样东西(`MergeThing`),里面带它的各个属性(`MergeProp`)。
 * 表按「项目 × 用户」存在文档服务(`server/docservice/modules/pending-merge.mjs`),本文件只管内容。
 *
 * **给 0.7.20「撤销冲突」留的口子**:每条记录带 `source`(现在只有 `offline`,0.7.20 加 `undo`)。
 * 撤销冲突照同一个形状写:`base` 是那一步落地后的值(期望云端仍是它),`mine` 是撤回后要变成的值;
 * 判冲突、显示、合并、删除选中都不分来源,一个窗口一套代码。
 */
import { deepEqual } from "../../kernel/diffProject";
import { parseCaptions, formatCaptions, isCaptionClip, type CaptionLine } from "../../kernel/captions";
import type { Project, Track } from "../../kernel/project";
import { contentEndOf, effectiveDuration } from "../../kernel/duration";
import { getCard } from "../../kernel/registry";

/* ---------------- 形状 ---------------- */

/** 待合并项从哪来:离线重连(本版),撤销冲突(0.7.20 接入) */
export type MergeSource = "offline" | "undo";

/**
 * `card`:一张卡片(一个卡片源码文件)。卡片源码不在项目 JSON 里,由编辑器进程的卡片源码同步(`server/card-sync.mjs`)经内容库同步;
 * 断网期间改过、云端也被别人改过的卡由它交过来(`cardConflictThing`),合并走它的 `takeMine`,不经 `applyMerge` 写项目。
 */
export type ThingKind = "clip" | "caption" | "settings" | "track" | "cut" | "transition" | "library" | "card";

/** 「有没有、是什么」:null 表示这一份里没有它(JSON 里放不下 undefined) */
export type Box = { v: unknown } | null;

export interface ThingRef {
  kind: ThingKind;
  /** 片段、序列、剪辑、转场、库条目的 id;字幕是行的身份;项目设置是 `settings` */
  id: string;
  /** 库条目所在的集合:media / filters / pixelMaps / audioFx / cardNodes */
  coll?: string;
  /** 字幕:所在的字幕片段 */
  clipId?: string;
  /** 片段:我这边它在哪条序列(新增、恢复、换序列时放进去) */
  trackId?: string;
  /** 片段、序列、转场:我这边它在哪条剪辑里(null 是当前激活的那条) */
  cutId?: string | null;
}

export interface MergeProp {
  /** 属性键;`""` 是整件(新增 / 删除) */
  prop: string;
  base: Box;
  mine: Box;
}

export interface MergeThing {
  /** `<来源>:<东西的键>`;同一样东西同一来源只有一条,后来的批次并进去 */
  key: string;
  source: MergeSource;
  /** 最近一次并进来的批次号 */
  batch: string;
  /** 基准的历史序号 */
  baseRev: number;
  at: number;
  ref: ThingRef;
  change: "modify" | "add" | "delete";
  /** 记表时的称呼(云端、我这边都没有它时也叫得出来) */
  label: string;
  /** 整件:基准与我这边(新增、删除、云端已删时恢复用) */
  base: Box;
  mine: Box;
  props: MergeProp[];
}

/* ---------------- 小工具 ---------------- */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const box = (v: unknown): Box => (v === undefined ? null : { v });
const val = (b: Box): unknown => (b ? b.v : undefined);
const sameBox = (a: Box, b: Box): boolean => (a === null || b === null ? a === b : deepEqual(a.v, b.v));
const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

/** 短哈希(字幕行的身份用;不求抗碰撞,同一片段里够分) */
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/* ---------------- 东西在项目里的位置 ---------------- */

/** 项目顶层里不是「项目设置」的键(集合与运行时字段) */
const NOT_SETTINGS = new Set(["version", "id", "media", "tracks", "cuts", "transitions", "activeCutId", "filters", "pixelMaps", "audioFx", "cardNodes"]);

/**
 * 〔裁:2026-10-22 主会话,三级〕这张表只列用户直接改的东西,不列由别的东西算出来的值。下面这些是算出来的,不进二级:
 * - 项目设置 `duration`:总时长缺省等于内容末尾、跟着片段走(`kernel/duration.ts`;手动截断的值不落盘,只在编辑器状态里),
 *   挪一个片段就会变,用户没直接改过它。合并之后由 `applyMerge` 按内容末尾重算。
 * - 素材 `pending` `tiers` `hash` `ext` `size` `duration` `width` `height` `url` `path`:导入、入库、上传、补元数据时由系统写
 *   (「素材元数据回填」那类不进撤销栈的提交),不是用户编辑出来的。素材整件的新增、删除照列;改名(`name`)照列。
 * - 片段 `cardAudio` `embeddedAudio`:带声音的动效卡生成的声音产物与它的能力标记,由生成流程维护(`kernel/project.ts`)。
 */
export const DERIVED_PROPS = {
  settings: ["duration"],
  media: ["pending", "tiers", "hash", "ext", "size", "duration", "width", "height", "url", "path"],
  clip: ["cardAudio", "embeddedAudio"],
} as const;
/** 各算一条的库集合 */
export const LIBRARY_COLLS = ["media", "filters", "pixelMaps", "audioFx", "cardNodes"] as const;

interface TrackHome { list: Obj[]; cutId: string | null }

/** 项目里所有的序列表:激活剪辑的 `/tracks`,以及每条停放剪辑的 `tracks` */
function trackLists(p: Obj): TrackHome[] {
  const out: TrackHome[] = [];
  if (Array.isArray(p.tracks)) out.push({ list: p.tracks as Obj[], cutId: null });
  for (const c of Array.isArray(p.cuts) ? (p.cuts as Obj[]) : []) {
    if (isObj(c) && typeof c.id === "string" && Array.isArray(c.tracks)) out.push({ list: c.tracks as Obj[], cutId: c.id });
  }
  return out;
}

function transitionLists(p: Obj): { list: Obj[]; cutId: string | null }[] {
  const out: { list: Obj[]; cutId: string | null }[] = [];
  if (Array.isArray(p.transitions)) out.push({ list: p.transitions as Obj[], cutId: null });
  for (const c of Array.isArray(p.cuts) ? (p.cuts as Obj[]) : []) {
    if (isObj(c) && typeof c.id === "string" && Array.isArray(c.transitions)) out.push({ list: c.transitions as Obj[], cutId: c.id });
  }
  return out;
}

function findTrack(p: Obj, trackId: string): { track: Obj; list: Obj[]; cutId: string | null } | null {
  for (const h of trackLists(p)) {
    const track = h.list.find((t) => isObj(t) && t.id === trackId);
    if (track) return { track, list: h.list, cutId: h.cutId };
  }
  return null;
}

function findClip(p: Obj, clipId: string): { clip: Obj; track: Obj; cutId: string | null } | null {
  for (const h of trackLists(p)) {
    for (const t of h.list) {
      if (!isObj(t) || !Array.isArray(t.clips)) continue;
      const clip = (t.clips as Obj[]).find((c) => isObj(c) && c.id === clipId);
      if (clip) return { clip, track: t, cutId: h.cutId };
    }
  }
  return null;
}

/** 在项目里找到的一样东西:值,以及片段的位置 */
interface Found {
  ref: ThingRef;
  value: unknown;
}

/** 一样东西的键(不含来源) */
export function thingKeyOf(ref: ThingRef): string {
  switch (ref.kind) {
    case "clip": return `clip:${ref.id}`;
    case "caption": return `caption:${ref.clipId}:${ref.id}`;
    case "settings": return "settings";
    case "library": return `lib:${ref.coll}:${ref.id}`;
    case "track": return `track:${ref.id}`;
    case "cut": return `cut:${ref.id}`;
    case "transition": return `tr:${ref.id}`;
    case "card": return `card:${ref.id}`;
  }
}

function settingsOf(p: Obj): Obj {
  const out: Obj = {};
  for (const k of Object.keys(p)) if (!NOT_SETTINGS.has(k) && !(DERIVED_PROPS.settings as readonly string[]).includes(k) && p[k] !== undefined) out[k] = p[k];
  return out;
}

/** 项目里的全部「东西」(字幕行另算,见 `captionThings`) */
function collect(p: Obj): Map<string, Found> {
  const out = new Map<string, Found>();
  const add = (ref: ThingRef, value: unknown) => {
    const k = thingKeyOf(ref);
    if (!out.has(k)) out.set(k, { ref, value });
  };
  add({ kind: "settings", id: "settings" }, settingsOf(p));
  for (const h of trackLists(p)) {
    for (const t of h.list) {
      if (!isObj(t) || typeof t.id !== "string") continue;
      add({ kind: "track", id: t.id, cutId: h.cutId }, t);
      for (const c of Array.isArray(t.clips) ? (t.clips as Obj[]) : []) {
        if (isObj(c) && typeof c.id === "string") add({ kind: "clip", id: c.id, trackId: t.id, cutId: h.cutId }, c);
      }
    }
  }
  for (const h of transitionLists(p)) {
    for (const tr of h.list) if (isObj(tr) && typeof tr.id === "string") add({ kind: "transition", id: tr.id, cutId: h.cutId }, tr);
  }
  for (const c of Array.isArray(p.cuts) ? (p.cuts as Obj[]) : []) {
    if (isObj(c) && typeof c.id === "string") add({ kind: "cut", id: c.id }, cutValue(p, c));
  }
  for (const coll of LIBRARY_COLLS) {
    for (const e of Array.isArray(p[coll]) ? (p[coll] as Obj[]) : []) {
      if (isObj(e) && typeof e.id === "string") add({ kind: "library", id: e.id, coll }, e);
    }
  }
  return out;
}

/** 剪辑的整件:激活的那条内容在项目顶层,停放的在自己身上 */
function cutValue(p: Obj, c: Obj): Obj {
  if (p.activeCutId === c.id && c.tracks === undefined) {
    return { id: c.id, name: c.name, tracks: p.tracks, duration: p.duration, transitions: p.transitions ?? [] };
  }
  return c;
}

/* ---------------- 属性 ---------------- */

/** 片段的属性:开始与结束合成「时间」,`params` / `frame` 展开一层,换序列是「所在序列」 */
function clipProps(c: Obj, ref: ThingRef): Map<string, unknown> {
  const out = new Map<string, unknown>();
  out.set("@time", [c.start, c.end]);
  out.set("@track", ref.trackId);
  for (const [k, v] of Object.entries(c)) {
    if (k === "id" || k === "start" || k === "end" || v === undefined) continue;
    if ((DERIVED_PROPS.clip as readonly string[]).includes(k)) continue; // 算出来的(生成产物),不列
    if ((k === "params" || k === "frame") && isObj(v)) {
      for (const [sk, sv] of Object.entries(v)) {
        if (sv === undefined) continue;
        if (k === "params" && sk === "lines" && isCaptionClip(c as { cardId?: string })) continue; // 字幕逐条另算
        out.set(`${k}.${sk}`, sv);
      }
      continue;
    }
    out.set(k, v);
  }
  return out;
}

function plainProps(v: Obj, skip: string[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [k, x] of Object.entries(v)) if (!skip.includes(k) && x !== undefined) out.set(k, x);
  return out;
}

function propsOf(f: Found): Map<string, unknown> {
  const v = isObj(f.value) ? f.value : {};
  switch (f.ref.kind) {
    case "clip": return clipProps(v, f.ref);
    case "settings": return plainProps(v, []);
    case "track": return plainProps(v, ["id", "clips"]);
    case "cut": return plainProps(v, ["id", "tracks", "duration", "transitions", "t"]);
    case "transition": return plainProps(v, ["id"]);
    case "library": return plainProps(v, f.ref.coll === "media" ? ["id", ...DERIVED_PROPS.media] : ["id"]);
    case "caption": {
      const l = f.value as CaptionLine;
      return new Map<string, unknown>([["time", [l.start, l.end]], ["zh", l.zh], ["en", l.en]]);
    }
    case "card": return new Map<string, unknown>([["source", f.value]]);
  }
}

function propDiff(a: Found, b: Found): MergeProp[] {
  const pa = propsOf(a), pb = propsOf(b);
  const keys = [...new Set([...pa.keys(), ...pb.keys()])];
  const out: MergeProp[] = [];
  for (const k of keys) {
    const x = box(pa.get(k)), y = box(pb.get(k));
    if (!sameBox(x, y)) out.push({ prop: k, base: x, mine: y });
  }
  return out;
}

/* ---------------- 字幕行 ---------------- */

const overlap = (a: CaptionLine, b: CaptionLine) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/** 两份字幕行对齐:先认一模一样的,剩下的按时间重叠最多的配对,其余是增删 */
export function alignLines(a: CaptionLine[], b: CaptionLine[]): { pairs: [number, number][]; onlyA: number[]; onlyB: number[] } {
  const usedB = new Set<number>();
  const pairOf = new Map<number, number>();
  a.forEach((la, i) => {
    const j = b.findIndex((lb, jj) => !usedB.has(jj) && deepEqual(la, lb));
    if (j >= 0) { usedB.add(j); pairOf.set(i, j); }
  });
  a.forEach((la, i) => {
    if (pairOf.has(i)) return;
    let best = -1, bestO = 0;
    b.forEach((lb, j) => {
      if (usedB.has(j)) return;
      const o = overlap(la, lb);
      if (o > bestO) { bestO = o; best = j; }
    });
    if (best >= 0) { usedB.add(best); pairOf.set(i, best); }
  });
  const pairs = [...pairOf.entries()].sort((x, y) => x[0] - y[0]);
  return { pairs, onlyA: a.map((_, i) => i).filter((i) => !pairOf.has(i)), onlyB: b.map((_, j) => j).filter((j) => !usedB.has(j)) };
}

const lineId = (l: CaptionLine) => `${l.start.toFixed(2)}-${l.end.toFixed(2)}-${shortHash(`${l.zh}|${l.en}`)}`;

function linesOf(clip: unknown): CaptionLine[] {
  return isObj(clip) && isObj(clip.params) ? parseCaptions(clip.params.lines) : [];
}

/** 字幕片段在基准与我这边都在:逐行对齐出「字幕」这一类东西 */
function captionThings(clipId: string, baseClip: Obj, mineClip: Obj): { base: Found | null; mine: Found | null }[] {
  const a = linesOf(baseClip), b = linesOf(mineClip);
  const { pairs, onlyA, onlyB } = alignLines(a, b);
  const out: { base: Found | null; mine: Found | null }[] = [];
  for (const [i, j] of pairs) {
    if (deepEqual(a[i], b[j])) continue;
    const ref: ThingRef = { kind: "caption", id: lineId(a[i]), clipId };
    out.push({ base: { ref, value: a[i] }, mine: { ref, value: b[j] } });
  }
  for (const i of onlyA) out.push({ base: { ref: { kind: "caption", id: lineId(a[i]), clipId }, value: a[i] }, mine: null });
  for (const j of onlyB) out.push({ base: null, mine: { ref: { kind: "caption", id: `+${lineId(b[j])}`, clipId }, value: b[j] } });
  return out;
}

/** 在一份项目里找某条字幕行:新增的认一模一样的那行,其余先认原样、再认时间重叠最多的那行 */
function locateLine(p: Obj, ref: ThingRef, base: CaptionLine | undefined, mine: CaptionLine | undefined): { lines: CaptionLine[]; index: number; clip: Obj } | null {
  const at = findClip(p, ref.clipId ?? "");
  if (!at) return null;
  const lines = linesOf(at.clip);
  let index = -1;
  if (base) {
    index = lines.findIndex((l) => deepEqual(l, base));
    if (index < 0) {
      let bestO = 0;
      lines.forEach((l, i) => { const o = overlap(l, base); if (o > bestO) { bestO = o; index = i; } });
    }
  } else if (mine) {
    index = lines.findIndex((l) => deepEqual(l, mine));
  }
  return { lines, index, clip: at.clip };
}

/* ---------------- 称呼 ---------------- */

const quoted = (s: string) => `「${s}」`;
const short = (s: string, n = 24) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function clipName(c: Obj | undefined, id: string): string {
  if (!c) return id;
  let name = "";
  if (typeof c.cardId === "string" && c.cardId) name = getCard(c.cardId)?.name ?? c.cardId;
  else if (typeof c.label === "string" && c.label.trim()) name = c.label.trim();
  if (!name) return id;
  return typeof c.start === "number" ? `${name} @${c.start.toFixed(1)}s` : name;
}

const LIB_KIND: Record<string, string> = { media: "素材", filters: "滤镜", pixelMaps: "像素映射", audioFx: "音频效果", cardNodes: "素材效果卡节点" };

/** 一样东西给人看的名字 */
export function thingLabel(ref: ThingRef, value: unknown): string {
  const v = isObj(value) ? value : undefined;
  const named = (kind: string) => `${kind}${quoted(v && typeof v.name === "string" && v.name.trim() ? v.name.trim() : ref.id)}`;
  switch (ref.kind) {
    case "clip": return `片段${quoted(clipName(v, ref.id))}`;
    case "caption": {
      const l = value as CaptionLine | undefined;
      return `字幕${quoted(short(l ? l.zh || l.en || lineId(l) : ref.id, 20))}`;
    }
    case "settings": return "项目设置";
    case "track": return named("序列");
    case "cut": return named("剪辑");
    case "transition": return `转场${quoted(v && typeof v.kind === "string" ? v.kind : ref.id)}`;
    case "library": return named(LIB_KIND[ref.coll ?? ""] ?? "条目");
    case "card": return `卡片源码${quoted(ref.id.replace(/^src\//, ""))}`;
  }
}

const PROP_LABEL: Record<string, string> = {
  "@time": "时间", "@track": "所在序列",
  opacity: "透明度", fadeIn: "淡入", fadeOut: "淡出", label: "名称", mediaOffset: "素材起点", speed: "速度", audioMuted: "静音", audioVolume: "音量",
  filter: "滤镜", pixelMap: "像素映射", audioFx: "音频效果", emphasis: "强调", motion: "运动轨迹", parts: "部件", cardId: "卡片",
  mediaId: "素材", cutId: "引用剪辑", cutOffset: "剪辑起点", soundEffect: "音效", embeddedAudio: "内嵌声音", cardAudio: "卡片声音", nodeId: "节点",
  "frame.x": "位置 X", "frame.y": "位置 Y", "frame.w": "宽", "frame.h": "高", "frame.scale": "缩放", "frame.rotate": "旋转",
  "frame.anchor": "锚点", "frame.rotateX": "X 轴翻转", "frame.rotateY": "Y 轴翻转", "frame.translateZ": "深度",
};
const CAPTION_PROP: Record<string, string> = { time: "时间", zh: "中文", en: "英文" };
const SETTINGS_PROP: Record<string, string> = {
  name: "名称", fps: "帧率", width: "宽度", height: "高度", duration: "时长", themeId: "主题", camera3dFov: "三维视角",
  glRoute: "渲染路线", creativity: "创造力等级", style: "风格",
};
const TRACK_PROP: Record<string, string> = { name: "名称", hidden: "隐藏", muted: "静音", locked: "锁定" };
const TRANSITION_PROP: Record<string, string> = { kind: "类型", dur: "时长", aId: "前一段", bId: "后一段", prevB: "原位置" };

export function propLabel(kind: ThingKind, prop: string): string {
  if (prop === "") return "整件";
  switch (kind) {
    case "clip":
      if (PROP_LABEL[prop]) return PROP_LABEL[prop];
      if (prop.startsWith("params.")) return `参数${quoted(prop.slice(7))}`;
      if (prop.startsWith("frame.")) return `画框${quoted(prop.slice(6))}`;
      return prop;
    case "caption": return CAPTION_PROP[prop] ?? prop;
    case "settings": return SETTINGS_PROP[prop] ?? prop;
    case "track": return TRACK_PROP[prop] ?? prop;
    case "cut": return prop === "name" ? "名称" : prop;
    case "transition": return TRANSITION_PROP[prop] ?? prop;
    case "library": return prop === "name" ? "名称" : prop;
    case "card": return "源码";
  }
}

/** 值给人看的样子 */
export function formatValue(v: unknown, prop = "", names?: (trackId: string) => string | undefined): string {
  if (v === undefined || v === null) return "无";
  if ((prop === "@time" || prop === "time") && Array.isArray(v) && v.length === 2) {
    const [a, b] = v as number[];
    return `${num(a)}–${num(b)} 秒`;
  }
  if (prop === "@track" && typeof v === "string") return `序列${quoted(names?.(v) ?? v)}`;
  if (typeof v === "boolean") return v ? "开" : "关";
  if (typeof v === "number") return num(v);
  if (typeof v === "string") return quoted(short(v));
  let s = "";
  try { s = JSON.stringify(v); } catch { s = String(v); }
  return short(s, 32);
}

function num(n: unknown): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return String(n);
  return String(Math.round(n * 1000) / 1000);
}

/* ---------------- 算差异:基准 → 我这边 ---------------- */

export interface DiffMeta {
  source: MergeSource;
  batch: string;
  baseRev: number;
  at: number;
}

/**
 * 基准与我这边比出待合并的东西。只列「我这边改了」的;云端改没改不在这里定(显示和合并时现算)。
 */
export function diffThings(base: Project, mine: Project, meta: DiffMeta): MergeThing[] {
  const B = collect(base as unknown as Obj), M = collect(mine as unknown as Obj);
  const out: MergeThing[] = [];
  const make = (ref: ThingRef, change: MergeThing["change"], b: Found | null, m: Found | null, props: MergeProp[]): MergeThing => ({
    key: `${meta.source}:${thingKeyOf(ref)}`,
    source: meta.source,
    batch: meta.batch,
    baseRev: meta.baseRev,
    at: meta.at,
    ref,
    change,
    label: thingLabel(ref, (m ?? b)?.value),
    base: b ? box(clone(b.value)) : null,
    mine: m ? box(clone(m.value)) : null,
    props,
  });
  for (const key of new Set([...B.keys(), ...M.keys()])) {
    const b = B.get(key) ?? null, m = M.get(key) ?? null;
    if (b && m) {
      // 片段换了地方:我这边的位置为准(新增、恢复、换序列都放到这儿)
      const ref = m.ref;
      const props = propDiff(b, m);
      if (props.length) out.push(make(ref, "modify", b, m, props.map((p) => ({ ...p, base: clone(p.base), mine: clone(p.mine) }))));
      if (ref.kind === "clip" && isCaptionClip(m.value as { cardId?: string }) && isCaptionClip(b.value as { cardId?: string })) {
        for (const line of captionThings(ref.id, b.value as Obj, m.value as Obj)) {
          const lref = (line.mine ?? line.base)!.ref;
          if (line.base && line.mine) out.push(make(lref, "modify", line.base, line.mine, propDiff(line.base, line.mine)));
          else if (line.base) out.push(make(lref, "delete", line.base, null, [{ prop: "", base: box(clone(line.base.value)), mine: null }]));
          else if (line.mine) out.push(make(lref, "add", null, line.mine, [{ prop: "", base: null, mine: box(clone(line.mine.value)) }]));
        }
      }
    } else if (b) {
      out.push(make(b.ref, "delete", b, null, [{ prop: "", base: box(clone(b.value)), mine: null }]));
    } else if (m) {
      out.push(make(m.ref, "add", null, m, [{ prop: "", base: null, mine: box(clone(m.value)) }]));
    }
  }
  return out;
}

/**
 * 新的一批并进已有的表:同一来源同一样东西只留一条(「同一个属性只列一条」);同一属性以新的为准。
 * 改动种类不同(先前记的是删除,这回是修改)时两条都留,新的键带上批次号。
 */
export function mergeIntoTable(table: MergeThing[], incoming: MergeThing[]): MergeThing[] {
  const out = [...table];
  for (const t of incoming) {
    const i = out.findIndex((x) => x.key === t.key);
    if (i < 0) { out.push(t); continue; }
    const old = out[i];
    if (old.change !== t.change) { out.push({ ...t, key: `${t.key}#${t.batch}` }); continue; }
    if (t.change !== "modify") { out[i] = { ...t, base: old.base }; continue; }
    const props = [...old.props];
    for (const p of t.props) {
      const j = props.findIndex((x) => x.prop === p.prop);
      if (j < 0) props.push(p);
      else props[j] = p;
    }
    out[i] = { ...t, base: old.base, props };
  }
  return out;
}

/* ---------------- 对照当前项目:冲突、云端现在是什么 ---------------- */

/** 在一份项目里找某样东西(片段按 id,不管住在哪条序列、哪条剪辑) */
function locate(p: Obj, t: MergeThing): Found | null {
  const ref = t.ref;
  switch (ref.kind) {
    case "clip": {
      const at = findClip(p, ref.id);
      return at ? { ref: { ...ref, trackId: at.track.id as string, cutId: at.cutId }, value: at.clip } : null;
    }
    case "caption": {
      const at = locateLine(p, ref, val(t.base) as CaptionLine | undefined, val(t.mine) as CaptionLine | undefined);
      return at && at.index >= 0 ? { ref, value: at.lines[at.index] } : null;
    }
    case "settings": return { ref, value: settingsOf(p) };
    case "track": {
      const at = findTrack(p, ref.id);
      return at ? { ref: { ...ref, cutId: at.cutId }, value: at.track } : null;
    }
    case "cut": {
      const c = (Array.isArray(p.cuts) ? (p.cuts as Obj[]) : []).find((x) => isObj(x) && x.id === ref.id);
      return c ? { ref, value: cutValue(p, c) } : null;
    }
    case "transition": {
      for (const h of transitionLists(p)) {
        const tr = h.list.find((x) => isObj(x) && x.id === ref.id);
        if (tr) return { ref: { ...ref, cutId: h.cutId }, value: tr };
      }
      return null;
    }
    case "library": {
      const e = (Array.isArray(p[ref.coll ?? ""]) ? (p[ref.coll ?? ""] as Obj[]) : []).find((x) => isObj(x) && x.id === ref.id);
      return e ? { ref, value: e } : null;
    }
    case "card": return t.base ? { ref, value: val(t.base) } : null;
  }
}

function propValue(f: Found, prop: string): unknown {
  return propsOf(f).get(prop);
}

export type PropState = "clean" | "conflict" | "same" | "cloud-gone";

export interface PropRow {
  /** 二级项的键 `<东西的键>|<属性>` */
  id: string;
  prop: string;
  label: string;
  text: string;
  state: PropState;
  conflict: boolean;
  /** 云端现在的值(「每次点合并时重新核对」拿它比) */
  cloud: Box;
}

export interface ThingRow {
  key: string;
  source: MergeSource;
  label: string;
  change: MergeThing["change"];
  /** 一级的说法:新增 / 删除 / 修改 / 云端已删除 */
  changeText: string;
  conflict: boolean;
  props: PropRow[];
}

export const propRowId = (thingKey: string, prop: string) => `${thingKey}|${prop}`;

/** 二级项现在的状态与云端的值 */
function propState(t: MergeThing, p: MergeProp, cloud: Found | null): { state: PropState; cloud: Box } {
  if (t.change === "add") {
    if (!cloud) return { state: "clean", cloud: null };
    return { state: sameBox(box(cloud.value), t.mine) ? "same" : "conflict", cloud: box(cloud.value) };
  }
  if (t.change === "delete") {
    if (!cloud) return { state: "same", cloud: null };
    return { state: sameBox(box(cloud.value), t.base) ? "clean" : "conflict", cloud: box(cloud.value) };
  }
  if (!cloud) return { state: "cloud-gone", cloud: null };
  const c = box(propValue(cloud, p.prop));
  if (sameBox(c, p.mine)) return { state: "same", cloud: c };
  return { state: sameBox(c, p.base) ? "clean" : "conflict", cloud: c };
}

/** 窗口里显示的两级列表,按当前项目现算冲突与云端的值 */
export function mergeRows(project: Project, table: MergeThing[]): ThingRow[] {
  const p = project as unknown as Obj;
  const trackName = (id: string) => {
    const at = findTrack(p, id);
    return at && typeof at.track.name === "string" ? at.track.name : undefined;
  };
  return table.map((t) => {
    const cloud = locate(p, t);
    const props: PropRow[] = t.props.map((mp) => {
      const { state, cloud: c } = propState(t, mp, cloud);
      const label = propLabel(t.ref.kind, mp.prop);
      let text: string;
      if (t.ref.kind === "card") {
        const d = lineDelta(String(val(c) ?? ""), String(val(mp.mine) ?? ""));
        text = `源码：我这边的版本比云端现在的多 ${d.added} 行、少 ${d.removed} 行（云端现在是别人改过的版本）`;
      } else if (t.change === "add") {
        text = state === "clean" ? "我这边新增的（云端现在没有）" : state === "same" ? "我这边新增的（云端现在已经一样）" : "我这边新增的（云端现在已有另一份）";
      } else if (t.change === "delete") {
        text = state === "clean" ? "我这边删除了（云端现在未改）" : state === "same" ? "我这边删除了（云端现在也没有了）" : "我这边删除了（云端现在已被别人改过）";
      } else {
        const from = formatValue(val(mp.base), mp.prop, trackName), to = formatValue(val(mp.mine), mp.prop, trackName);
        const now = state === "cloud-gone" ? "云端已删除" : `云端现在是 ${formatValue(val(c), mp.prop, trackName)}`;
        text = `${label} ${from} → ${to}（${now}）`;
      }
      return { id: propRowId(t.key, mp.prop), prop: mp.prop, label, text, state, conflict: state === "conflict" || state === "cloud-gone", cloud: c };
    });
    const cloudGone = t.change === "modify" && !cloud;
    return {
      key: t.key,
      source: t.source,
      label: t.label,
      change: t.change,
      changeText: t.change === "add" ? "新增" : t.change === "delete" ? "删除" : cloudGone ? "云端已删除" : "修改",
      conflict: props.some((r) => r.conflict),
      props,
    };
  });
}

/**
 * 冲突横条与按钮的「N 处改动待合并，其中 M 处有冲突」:按一级(被改的那样东西)数,与手机版演示稿一致;
 * `items` 是二级项的总数(「已选 N 项」那一边用二级项数)。
 */
export function mergeCounts(rows: ThingRow[]): { total: number; conflicts: number; items: number } {
  let items = 0;
  for (const r of rows) items += r.props.length;
  return { total: rows.length, conflicts: rows.filter((r) => r.conflict).length, items };
}

/* ---------------- 合并:把选中的二级项照我这边写进项目 ---------------- */

export interface ApplyResult {
  project: Project;
  /** 不在项目 JSON 里、要由别处写的(卡片源码:编辑器进程的卡片源码同步 `takeMine`);写成了再从表里拿掉 */
  external: { key: string; props: string[]; thing: MergeThing }[];
  /** 写进去了的(含为了它连带并进来的序列、剪辑、素材);从表里拿掉 */
  done: { key: string; props: string[] }[];
  /** 没写成的及原因;留在表里 */
  failed: { key: string; prop: string; reason: string }[];
}

class Skip extends Error {}

function sortByStart(clips: Obj[]) {
  clips.sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0));
}

function setProp(kind: ThingKind, obj: Obj, prop: string, b: Box) {
  const v = val(b);
  if (kind === "clip" && prop === "@time") {
    const [s, e] = Array.isArray(v) ? (v as number[]) : [];
    obj.start = s; obj.end = e;
    return;
  }
  if (kind === "clip" && prop === "@track") return; // 位置另办
  if (kind === "clip" && (prop.startsWith("params.") || prop.startsWith("frame."))) {
    const [k, ...rest] = prop.split(".");
    const sk = rest.join(".");
    const inner: Obj = isObj(obj[k]) ? { ...(obj[k] as Obj) } : {};
    if (v === undefined) delete inner[sk];
    else inner[sk] = clone(v);
    obj[k] = inner;
    return;
  }
  if (kind === "caption") {
    const l = obj as unknown as CaptionLine;
    if (prop === "time" && Array.isArray(v)) { l.start = Number(v[0]); l.end = Number(v[1]); }
    else if (prop === "zh" || prop === "en") l[prop] = typeof v === "string" ? v : "";
    return;
  }
  if (v === undefined) delete obj[prop];
  else obj[prop] = clone(v);
}

/** 片段要放进某条序列,同一序列里不能和别的片段重叠 */
function overlapsIn(track: Obj, clip: Obj): boolean {
  const s = Number(clip.start), e = Number(clip.end);
  return (Array.isArray(track.clips) ? (track.clips as Obj[]) : []).some((c) => c.id !== clip.id && Number(c.start) < e && s < Number(c.end));
}

/**
 * 在当前项目(云端现状加本页面还没确认的修改)上照我这边写选中的项。不改入参,回一份新项目。
 * `selection`:东西的键 → 选中的属性。新增要放进去的序列、剪辑、素材不在云端时,表里有它的新增就连带并进来。
 */
export function applyMerge(project: Project, table: MergeThing[], selection: Map<string, Set<string>>, opts: { manualDuration?: number | null } = {}): ApplyResult {
  const p = structuredClone(project) as unknown as Obj;
  const done = new Map<string, Set<string>>();
  const failed: ApplyResult["failed"] = [];
  const external: ApplyResult["external"] = [];
  const mark = (key: string, props: string[]) => {
    let s = done.get(key);
    if (!s) done.set(key, (s = new Set()));
    for (const x of props) s.add(x);
  };
  const byKey = new Map(table.map((t) => [t.key, t]));

  /** 表里待并的某样东西的新增(序列、剪辑、素材的连带) */
  const pendingAdd = (kind: ThingKind, id: string, coll?: string) =>
    table.find((t) => t.change === "add" && t.ref.kind === kind && t.ref.id === id && (coll === undefined || t.ref.coll === coll) && !done.has(t.key));

  const ensureCut = (cutId: string | null | undefined) => {
    if (!cutId) return;
    if ((Array.isArray(p.cuts) ? (p.cuts as Obj[]) : []).some((c) => c.id === cutId)) return;
    const dep = pendingAdd("cut", cutId);
    if (!dep) throw new Skip("所在剪辑云端已不存在");
    writeThing(dep, val(dep.mine) as Obj);
    mark(dep.key, [""]);
  };
  const ensureTrack = (trackId: string | undefined, cutId: string | null | undefined): Obj => {
    const at = trackId ? findTrack(p, trackId) : null;
    if (at) return at.track;
    const dep = trackId ? pendingAdd("track", trackId) : undefined;
    if (!dep) throw new Skip("所在序列云端已不存在");
    ensureCut(dep.ref.cutId ?? cutId);
    writeThing(dep, val(dep.mine) as Obj);
    mark(dep.key, [""]);
    return findTrack(p, trackId!)!.track;
  };
  const ensureMedia = (clip: Obj) => {
    const mediaId = typeof clip.mediaId === "string" ? clip.mediaId : null;
    if (!mediaId) return;
    if ((Array.isArray(p.media) ? (p.media as Obj[]) : []).some((m) => m.id === mediaId)) return;
    const dep = pendingAdd("library", mediaId, "media");
    if (!dep) throw new Skip("用到的素材云端已不存在");
    writeThing(dep, val(dep.mine) as Obj);
    mark(dep.key, [""]);
  };

  /** 把一样东西整件写成 value(undefined = 删掉) */
  function writeThing(t: MergeThing, value: Obj | CaptionLine | undefined, opts: { move?: boolean } = {}) {
    const ref = t.ref;
    switch (ref.kind) {
      case "clip": {
        const at = findClip(p, ref.id);
        if (value === undefined) {
          if (at) at.track.clips = (at.track.clips as Obj[]).filter((c) => c.id !== ref.id);
          return;
        }
        const clip = clone(value) as Obj;
        ensureMedia(clip);
        if (at && !opts.move) {
          const others = { ...at.track, clips: (at.track.clips as Obj[]).filter((c) => c.id !== ref.id) };
          if (overlapsIn(others, clip)) throw new Skip("和同一序列里的片段重叠");
          const list = (at.track.clips as Obj[]).map((c) => (c.id === ref.id ? clip : c));
          sortByStart(list);
          at.track.clips = list;
          return;
        }
        const track = ensureTrack(ref.trackId, ref.cutId);
        if (overlapsIn(track, clip)) throw new Skip("和同一序列里的片段重叠");
        if (at) at.track.clips = (at.track.clips as Obj[]).filter((c) => c.id !== ref.id);
        const list = [...((track.clips as Obj[] | undefined) ?? []), clip];
        sortByStart(list);
        track.clips = list;
        return;
      }
      case "caption": {
        const line = value as CaptionLine | undefined;
        const at = locateLine(p, ref, val(t.base) as CaptionLine | undefined, val(t.mine) as CaptionLine | undefined);
        if (!at) throw new Skip("字幕所在的片段云端已不存在");
        const lines = [...at.lines];
        if (line === undefined) { if (at.index >= 0) lines.splice(at.index, 1); }
        else if (at.index >= 0) lines[at.index] = { ...line };
        else lines.push({ ...line });
        const params = isObj(at.clip.params) ? { ...(at.clip.params as Obj) } : {};
        params.lines = formatCaptions(lines);
        at.clip.params = params;
        return;
      }
      case "settings": {
        const v = (value ?? {}) as Obj;
        for (const k of Object.keys(settingsOf(p))) if (!(k in v)) delete p[k];
        for (const [k, x] of Object.entries(v)) p[k] = clone(x);
        return;
      }
      case "track": {
        const at = findTrack(p, ref.id);
        if (value === undefined) {
          if (at) at.list.splice(at.list.indexOf(at.track), 1);
          return;
        }
        if (at) {
          const next = { ...clone(value as Obj), clips: at.track.clips };
          at.list[at.list.indexOf(at.track)] = next;
          return;
        }
        ensureCut(ref.cutId);
        const home = ref.cutId ? ((p.cuts as Obj[]).find((c) => c.id === ref.cutId) as Obj) : p;
        if (!Array.isArray(home.tracks)) {
          // 剪辑是云端当前激活的那条:内容在项目顶层
          if (ref.cutId && p.activeCutId === ref.cutId) (p.tracks as Obj[]).push({ ...clone(value as Obj), clips: [] });
          else throw new Skip("所在剪辑云端已不存在");
          return;
        }
        (home.tracks as Obj[]).push({ ...clone(value as Obj), clips: [] });
        return;
      }
      case "cut": {
        const cuts = Array.isArray(p.cuts) ? (p.cuts as Obj[]) : (p.cuts = []) as Obj[];
        const i = cuts.findIndex((c) => c.id === ref.id);
        if (value === undefined) {
          if (i < 0) return;
          if (p.activeCutId === ref.id) throw new Skip("这条剪辑在云端正被打开着，删不了");
          cuts.splice(i, 1);
          return;
        }
        if (i >= 0) { cuts[i] = { ...cuts[i], name: (value as Obj).name }; return; }
        // 新增的剪辑以停放的样子放进去,序列与片段各自逐条并
        const v = value as Obj;
        cuts.push({ id: v.id, name: v.name, tracks: [], duration: typeof v.duration === "number" ? v.duration : 0, transitions: [] });
        return;
      }
      case "transition": {
        let home: Obj[] | null = null;
        for (const h of transitionLists(p)) if (h.list.some((x) => x.id === ref.id)) home = h.list;
        if (value === undefined) {
          if (home) home.splice(home.findIndex((x) => x.id === ref.id), 1);
          return;
        }
        if (home) { home[home.findIndex((x) => x.id === ref.id)] = clone(value as Obj); return; }
        if (ref.cutId) {
          const c = (Array.isArray(p.cuts) ? (p.cuts as Obj[]) : []).find((x) => x.id === ref.cutId);
          if (!c) throw new Skip("所在剪辑云端已不存在");
          if (p.activeCutId !== ref.cutId) { c.transitions = [...((c.transitions as Obj[]) ?? []), clone(value as Obj)]; return; }
        }
        p.transitions = [...((p.transitions as Obj[]) ?? []), clone(value as Obj)];
        return;
      }
      case "library": {
        const coll = ref.coll ?? "";
        const list = Array.isArray(p[coll]) ? [...(p[coll] as Obj[])] : [];
        const i = list.findIndex((x) => x.id === ref.id);
        if (value === undefined) { if (i >= 0) list.splice(i, 1); }
        else if (i >= 0) list[i] = clone(value as Obj);
        else list.push(clone(value as Obj));
        p[coll] = list;
        return;
      }
    }
  }

  for (const [key, props] of selection) {
    const t = byKey.get(key);
    if (!t || !props.size) continue;
    if (done.has(key) && t.change !== "modify") continue; // 已经作为连带并进来了
    if (t.ref.kind === "card") { external.push({ key, props: [...props], thing: t }); continue; }
    try {
      if (t.change === "add") {
        writeThing(t, val(t.mine) as Obj);
        mark(key, [""]);
        continue;
      }
      if (t.change === "delete") {
        writeThing(t, undefined);
        mark(key, [""]);
        continue;
      }
      const chosen = t.props.filter((x) => props.has(x.prop));
      if (!chosen.length) continue;
      const cloud = locate(p, t);
      if (!cloud) {
        // 我改了、云端删了:「合并」= 连同我的修改恢复回来;没勾的属性按基准
        const restored = clone(val(t.mine)) as Obj;
        for (const x of t.props) if (!props.has(x.prop)) setProp(t.ref.kind, restored, x.prop, x.base);
        writeThing(t, restored, { move: true });
        mark(key, chosen.map((x) => x.prop));
        continue;
      }
      const next = clone(cloud.value) as Obj;
      for (const x of chosen) setProp(t.ref.kind, next, x.prop, x.mine);
      const move = t.ref.kind === "clip" && chosen.some((x) => x.prop === "@track");
      writeThing(t, next, { move });
      mark(key, chosen.map((x) => x.prop));
    } catch (e) {
      if (!(e instanceof Skip)) throw e;
      for (const x of t.change === "modify" ? t.props.filter((y) => props.has(y.prop)) : t.props) failed.push({ key, prop: x.prop, reason: e.message });
    }
  }
  // 总时长是算出来的(不进表):并了片段之后照规则跟着内容末尾重算(手动截断的值由调用方从编辑器状态给)
  if (done.size && Array.isArray(p.tracks) && typeof p.duration === "number") {
    p.duration = effectiveDuration(contentEndOf(p.tracks as Track[]), p.duration, opts.manualDuration ?? null);
  }
  return { project: p as unknown as Project, done: [...done].map(([key, s]) => ({ key, props: [...s] })), failed, external };
}

/** 两份文本按行比:我这边比对方多几行、少几行(冲突窗口里卡片源码那一句用;太长时按行的多重集合估) */
const NL = "\n";
export function lineDelta(from: string, to: string): { added: number; removed: number } {
  const a = from.split(NL), b = to.split(NL);
  if (a.length * b.length > 4_000_000) {
    const count = new Map<string, number>();
    for (const l of a) count.set(l, (count.get(l) ?? 0) + 1);
    let common = 0;
    for (const l of b) { const n = count.get(l) ?? 0; if (n > 0) { common++; count.set(l, n - 1); } }
    return { added: b.length - common, removed: a.length - common };
  }
  let prev = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Uint32Array(b.length + 1);
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  const lcs = prev[b.length];
  return { added: b.length - lcs, removed: a.length - lcs };
}

/**
 * 一张卡的冲突(卡片源码同步在断网重连时交过来的:本机改过、云端也被别人改过)→ 待合并表里的一条。
 * 一级是这张卡(源码文件),二级是「源码」;`base` 记云端在冲突那一刻的版本(本机已经装上它),`mine` 是我这边的。
 */
export function cardConflictThing(o: { key: string; mine: string; cloud: string; rev: number; at: number; batch: string; source?: MergeSource }): MergeThing {
  const ref: ThingRef = { kind: "card", id: o.key };
  const source = o.source ?? "offline";
  return {
    key: `${source}:${thingKeyOf(ref)}`, source, batch: o.batch, baseRev: o.rev, at: o.at, ref, change: "modify",
    label: thingLabel(ref, null), base: { v: o.cloud }, mine: { v: o.mine },
    props: [{ prop: "source", base: null, mine: { v: o.mine } }],
  };
}

/** 从表里拿掉这些二级项;一样东西的二级项拿光了,这一条也拿掉 */
export function removeFromTable(table: MergeThing[], remove: { key: string; props: string[] }[]): MergeThing[] {
  const drop = new Map(remove.map((r) => [r.key, new Set(r.props)]));
  const out: MergeThing[] = [];
  for (const t of table) {
    const d = drop.get(t.key);
    if (!d) { out.push(t); continue; }
    const props = t.props.filter((x) => !d.has(x.prop));
    if (props.length) out.push({ ...t, props });
  }
  return out;
}

/**
 * 「每次点合并时重新核对」:窗口里显示时记下的云端值,和现在的比;变了的二级项这次不并,刷新给用户再看。
 * `seen`:二级项的键 → 显示时的云端值。
 */
export function staleSelections(project: Project, table: MergeThing[], seen: Map<string, Box>, selection: Map<string, Set<string>>): string[] {
  const rows = mergeRows(project, table.filter((t) => selection.has(t.key)));
  const out: string[] = [];
  for (const r of rows) for (const p of r.props) {
    if (!selection.get(r.key)?.has(p.prop)) continue;
    const before = seen.get(p.id);
    if (before === undefined) continue;
    if (!sameBox(before, p.cloud)) out.push(p.id);
  }
  return out;
}

/* ---------------- 勾选(桌面窗口与手机面板共用) ---------------- */

/** 勾选状态:东西的键 → 勾了的属性 */
export type Selection = Map<string, Set<string>>;

/** 「选中无冲突项」:勾上所有不冲突的二级项(已有的勾选不动) */
export function selectNonConflict(rows: ThingRow[], prev: Selection = new Map()): Selection {
  const next: Selection = new Map([...prev].map(([k, s]) => [k, new Set(s)]));
  for (const r of rows) for (const p of r.props) {
    if (p.conflict) continue;
    let s = next.get(r.key);
    if (!s) next.set(r.key, (s = new Set()));
    s.add(p.prop);
  }
  return next;
}

/** 一级的勾选框:全勾 / 部分 / 没勾 */
export function thingCheck(row: ThingRow, sel: Selection): "all" | "some" | "none" {
  const s = sel.get(row.key);
  const n = s ? row.props.filter((p) => s.has(p.prop)).length : 0;
  return n === 0 ? "none" : n === row.props.length ? "all" : "some";
}

/** 点一级的勾选框:没全勾就全勾,全勾了就全取消 */
export function toggleThing(row: ThingRow, sel: Selection): Selection {
  const next: Selection = new Map(sel);
  if (thingCheck(row, sel) === "all") next.delete(row.key);
  else next.set(row.key, new Set(row.props.map((p) => p.prop)));
  return next;
}

/** 点二级的勾选框 */
export function toggleProp(row: ThingRow, prop: string, sel: Selection): Selection {
  const next: Selection = new Map(sel);
  const s = new Set(next.get(row.key) ?? []);
  if (s.has(prop)) s.delete(prop);
  else s.add(prop);
  if (s.size) next.set(row.key, s);
  else next.delete(row.key);
  return next;
}

/** 勾了几项(二级项计数),只数还在列表里的 */
export function selectedCount(rows: ThingRow[], sel: Selection): number {
  let n = 0;
  for (const r of rows) { const s = sel.get(r.key); if (s) n += r.props.filter((p) => s.has(p.prop)).length; }
  return n;
}

/** 勾选里去掉已不在列表里的项(合并、删除之后) */
export function pruneSelection(rows: ThingRow[], sel: Selection): Selection {
  const next: Selection = new Map();
  for (const r of rows) {
    const s = sel.get(r.key);
    if (!s) continue;
    const kept = new Set(r.props.filter((p) => s.has(p.prop)).map((p) => p.prop));
    if (kept.size) next.set(r.key, kept);
  }
  return next;
}

/** 勾选换成「东西的键 + 属性」的清单(删除选中、从表里拿掉用) */
export function selectionList(sel: Selection): { key: string; props: string[] }[] {
  return [...sel].map(([key, s]) => ({ key, props: [...s] }));
}

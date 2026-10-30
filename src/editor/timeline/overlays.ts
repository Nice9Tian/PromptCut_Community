/**
 * 叠加卡:挂在一个片段上的那些东西(滤镜、像素映射、音频效果、素材效果卡),
 * 在时间轴上收成片段里的一条「叠加带」。
 *
 * # 为什么要收成一个概念
 *
 * 这四样今天各占 clip 上一个字段(`filter` / `pixelMap` / `audioFx` / `nodeId`),
 * 而时间轴上一个字都不显示 —— 一个片段挂没挂东西,只能到左栏检查器里翻。
 * 这里把它们归成一张清单,带和菜单都只认这张清单,不关心它们分别存在哪个字段。
 *
 * # 顺序就是处理顺序
 *
 * 带里从左到右、菜单里从上到下,都是画面真正经过的次序:
 * 像素映射(取素材原始输出的那一档)→ 滤镜 → 像素映射(取滤镜之后那一档)→ 素材效果卡;
 * 声音那一支(音频效果)排在最后。像素映射走哪一档看它定义里的 `source.stage`。
 *
 * # 这里只算,不画
 *
 * 宽度估算和退化档次都是纯函数,单测直接跑(`overlays.test.mjs`);画在 `OverlayBand.tsx`。
 */
import type { Project, TrackClip } from "../../kernel/project";
import { describeFilter } from "../../kernel/filters.mjs";
import { describeAudioFx } from "../../kernel/audioFx.mjs";
import type { RowSize } from "./utils";

export type OverlayKind = "pixelMap" | "filter" | "card" | "audioFx";

export interface OverlayItem {
  kind: OverlayKind;
  /** 库里那条定义的 id;素材效果卡给的是节点 id */
  refId: string;
  name: string;
  /** 一句参数摘要,带里放不下时只在菜单里显示 */
  value: string;
  /**
   * 吃宿主的画面 / 声音(下游型)还是往宿主渲染之前注入状态(上游型)。
   * 今天四样全是下游型;相机那种上游型还没有,字段先留着,界面上靠 ▾ / ▴ 分。
   */
  upstream: boolean;
  /**
   * 这一段上停用了:挂载和逐段参数都留着,只是不生效。带里画成虚线 + 名字划掉。
   *
   * **这张清单照列停用的** —— 它是「这一段挂着什么」,不是「这一段现在生效什么」。
   * 生不生效由各自的解析口判(`filterOfClip` / `pixelMapOfClip` / `audioFxOfClip`)。
   */
  off: boolean;
  /** 能不能在菜单里切停用。素材效果卡是节点图里的一个节点,绕过它要在图上改,这一版不给 */
  canToggle: boolean;
  /**
   * 能不能摘掉。前三样置空一个字段就完了;素材效果卡要把这一个节点从链上取下来、
   * 下游接到它的上游(`kernel/cardAuthoring.mjs` 的 `detachCardNode`),
   * 所以只有带 `source` 那一路输入的才摘得动 —— 转场的 A/B、无输入的卡摘不了。
   */
  canDetach: boolean;
}

export const OVERLAY_KIND_NAME: Record<OverlayKind, string> = {
  pixelMap: "像素映射",
  filter: "滤镜",
  card: "素材效果卡",
  audioFx: "音频效果",
};

/** 下游型 ▾ 吃宿主的输出;上游型 ▴ 往宿主渲染之前注入状态 */
export function overlayGlyph(item: OverlayItem): string {
  return item.upstream ? "▴" : "▾";
}

interface Libs {
  /** 取一张卡的显示名(registry 的 knownCardName;单测给假的) */
  cardName: (cardId: string) => string | undefined;
}

/** 这个片段上挂着的东西,按处理顺序排 */
export function overlaysOfClip(project: Project, clip: TrackClip, libs: Libs): OverlayItem[] {
  const out: OverlayItem[] = [];
  const pm = clip.pixelMap ? (project.pixelMaps ?? []).find((d) => d.id === clip.pixelMap!.id) : undefined;
  const pmItem: OverlayItem | null = pm
    ? { kind: "pixelMap", refId: pm.id, name: pm.name, value: pm.description || pm.where || "",
        upstream: false, off: !!clip.pixelMap?.off, canToggle: true, canDetach: true }
    : null;
  // 取滤镜之后那一档的像素映射排在滤镜后面,取素材原始输出的排在前面
  const pmAfterFilters = pm?.source?.stage === "after_filters";
  if (pmItem && !pmAfterFilters) out.push(pmItem);

  const f = clip.filter ? (project.filters ?? []).find((d) => d.id === clip.filter!.id) : undefined;
  if (f) out.push({ kind: "filter", refId: f.id, name: f.name, value: safeDescribe(() => describeFilter(f)),
    upstream: false, off: !!clip.filter?.off, canToggle: true, canDetach: true });

  if (pmItem && pmAfterFilters) out.push(pmItem);

  if (clip.nodeId) {
    const node = (project.cardNodes ?? []).find((n) => n.id === clip.nodeId);
    const cardId = typeof node?.cardId === "string" ? node.cardId : "";
    // 没有输入、而且就是这一段自己那张卡:那是片段的内容(物化出来的底座),不是叠加上去的
    const isOwnBase = !!node && cardId === clip.cardId && !Object.keys(node.inputs ?? {}).length;
    if (node && !isOwnBase) {
      out.push({
        kind: "card",
        refId: node.id,
        name: (cardId && libs.cardName(cardId)) || cardId || "素材效果卡",
        value: typeof node.kind === "string" ? node.kind : "",
        upstream: false,
        // 节点连着输入输出,绕过它不是把一个字段置空
        off: false,
        canToggle: false,
        // 摘得动的条件:有 `source` 那一路,下游才接得回上游
        canDetach: !!(node.inputs as Record<string, unknown> | undefined)?.source,
      });
    }
  }

  const fx = clip.audioFx ? (project.audioFx ?? []).find((d) => d.id === clip.audioFx!.id) : undefined;
  if (fx) out.push({ kind: "audioFx", refId: fx.id, name: fx.name, value: safeDescribe(() => describeAudioFx(fx)),
    upstream: false, off: !!clip.audioFx?.off, canToggle: true, canDetach: true });

  return out;
}

/** 库里的定义形状不对时宁可不写摘要,也不要让时间轴整条炸掉 */
function safeDescribe(fn: () => string): string {
  try {
    return fn() || "";
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ 尺寸 */

/** 叠加带的高度。小行高那一档不画带(片段净高只有 20px,画了宿主只剩 7px) */
export const BAND_H: Record<RowSize, number> = { small: 0, medium: 13, large: 20 };

/** 窄到这个宽度以下:带里只放 +N、正文也不写时长 */
export const NARROW_PX = 72;

/** 片段正文的左右内边距合计 */
const BODY_PAD = 14;
/** 连一个字加省略号都放不下就不画名字 —— 留一个孤零零的「…」比不画更难看 */
const MIN_NAME = 18;

/** 一张卡片在带里占多宽(按名字长度估;中文一个字约 10px) */
export function chipWidth(name: string): number {
  return 24 + [...name].length * 10;
}

/** `+N` 徽标占多宽 */
export function countWidth(n: number): number {
  return 17 + String(n).length * 6;
}

export interface BandPlan {
  /** 带里摆得下的那几张,按原顺序 */
  shown: OverlayItem[];
  /** 收进 `+N` 的张数 */
  hidden: number;
}

/**
 * 带里摆得下几张。摆不下的收成 `+N`,高度不随数量涨。
 * `keepIndex` 是当前选中的那一张:它要是被挤进 `+N` 里,换到最后一格 —— 从菜单挑完看不见等于没挑。
 */
export function planBand(items: OverlayItem[], availPx: number, keepIndex = -1): BandPlan {
  const gap = 3;
  const total = items.reduce((s, it) => s + chipWidth(it.name) + gap, 0);
  if (total <= availPx) return { shown: items.slice(), hidden: 0 };
  let budget = availPx - countWidth(items.length);
  const shown: OverlayItem[] = [];
  for (const it of items) {
    const need = chipWidth(it.name) + gap;
    if (need > budget) break;
    budget -= need;
    shown.push(it);
  }
  if (keepIndex >= 0 && keepIndex < items.length && shown.length && !shown.includes(items[keepIndex])) {
    shown[shown.length - 1] = items[keepIndex];
  }
  return { shown, hidden: items.length - shown.length };
}

export interface ClipLayoutPlan {
  /** 画不画叠加带(小行高那一档整行都不画) */
  band: boolean;
  /** 带里只放一个 `+N`,不摆卡片 */
  countOnly: boolean;
  /** 小行高那一档:`+N` 排在名字后面靠右 */
  pill: boolean;
  /** 正文写不写时长 */
  duration: boolean;
  /** 正文画不画名字 */
  name: boolean;
  /** 带里留给卡片的宽度 */
  bandAvail: number;
}

/**
 * 一个片段短下去的几档。
 *
 * 中 / 大行高:`名字 · 时长` → `名字` → `名…` → 不画名字(带里还剩 `+N`)。
 * 小行高没有带,`+N` 排在名字后面靠右,再短就只剩那个徽标。
 *
 * 带这一格在**每个**片段上都留着(没挂东西时透明不画):只给挂了东西的片段留,
 * 同一行里的名字就会一高一低。
 */
export function planClipLayout(widthPx: number, rowSize: RowSize, count: number): ClipLayoutPlan {
  const narrow = widthPx < NARROW_PX;
  const band = rowSize !== "small";
  const pill = !band && count > 0;
  const pillW = pill ? countWidth(count) + 5 : 0;
  return {
    band,
    countOnly: narrow,
    pill,
    duration: !narrow,
    name: widthPx - BODY_PAD - pillW >= MIN_NAME,
    // 右边那个「+」只在不窄的时候出现(15px),带的左右内边距合计 6px
    bandAvail: Math.max(0, widthPx - 6 - (narrow ? 0 : 15)),
  };
}

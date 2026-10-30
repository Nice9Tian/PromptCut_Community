import type { TrackKind } from "../skins/palettes";
import { getCard } from "./registry";
import type { MediaAsset } from "./project";

/**
 * 片段该用哪一档轨道色。
 *
 * 配色规范(配色诊断与修正 v2,第 03 条)要求时间线「按素材类型上色」:一眼读出
 * 哪张是文字、哪张是视频、哪张是转场。之前所有卡片段共用一个色,颜色占满了却
 * 没传递任何信息。
 *
 * 素材段直接看 MediaAsset.kind;卡片段没有视觉分类字段,所以按卡片自己的 tags
 * 归档 —— tags 本来就是给 AI 选卡用的内容标签,正好也说明了这张卡在画面上是
 * 什么东西。归不了档的落到 text:卡片绝大多数是文字类,这个兜底比随机着色安全。
 */

/**
 * tags 里出现这些词就归到对应轨道色。先匹配到的先算,所以顺序即优先级。
 * 兜底是 text,所以「让文字动起来」的卡(数字滚动 / 打字机 / 文字轮换 / 金句)
 * 不用写规则就会落到文字色,和设计稿整屏里的取色一致。
 */
const TAG_RULES: Array<[TrackKind, readonly string[]]> = [
  ["transition", ["转场", "过渡", "切换", "擦除", "推移"]],
  // 入场 / 出场这类「效果」本身就是卡的主体,归特效
  ["fx", ["特效", "粒子", "光效", "故障", "扫描", "终端", "3d", "浮现", "模糊"]],
  // 数据可视化:图表类自成一档,不和纯文字卡混
  ["image", ["图表", "折线", "走势", "排名", "条形图", "榜单", "环形", "百分比", "指标"]],
  ["sticker", ["贴纸", "角标", "徽章", "名牌", "实体", "人物", "机构", "章节", "导航"]],
  ["audio", ["音频", "波形", "配乐", "声音"]],
  ["video", ["视频", "画面", "半屏", "出镜"]],
];

/** 卡片 id → 轨道色。tags 归不出来时按 id 兜底(比 tags 更明确的少数几张)。 */
const ID_OVERRIDES: Record<string, TrackKind> = {
  "caption-track": "text",
  "chapter-bar": "sticker",
};

export function mediaTrackKind(media: MediaAsset | undefined): TrackKind {
  return media?.kind ?? "video";
}

export function cardTrackKind(cardId: string): TrackKind {
  const override = ID_OVERRIDES[cardId];
  if (override) return override;

  const card = getCard(cardId);
  if (!card) return "text";
  const tags = (card.tags ?? []).map((t) => t.toLowerCase());
  for (const [kind, words] of TAG_RULES) {
    if (tags.some((tag) => words.some((w) => tag.includes(w)))) return kind;
  }
  return "text";
}

/** 一个片段最终用哪档轨道色:素材看 kind,卡片看 tags */
export function clipTrackKind(
  clip: { cardId?: string; mediaId?: string },
  findMedia: (id: string) => MediaAsset | undefined,
): TrackKind {
  if (clip.mediaId) return mediaTrackKind(findMedia(clip.mediaId));
  if (clip.cardId) return cardTrackKind(clip.cardId);
  return "text";
}

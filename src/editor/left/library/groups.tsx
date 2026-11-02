import type { ReactNode } from "react";
import type { GroupLayout } from "./layout";
import type { MediaAsset } from "../../../kernel/project";
import { tr } from "../../../i18n/index.ts";

/**
 * 素材库 / 动画 / 特效三个分区的「组定义」表。要挪组、改 layout、改名、换分类,只改这里。
 * 每个组的内容由对应的 *Group 钩子按搜索词算出来(GroupData),GroupBrowser 负责总览和详情。
 */

export type GroupCategory = "visual" | "audio";
export const CATEGORIES: readonly GroupCategory[] = ["visual", "audio"];

export interface GroupDef {
  id: string;
  title: string;
  layout: GroupLayout;
  category: GroupCategory;
  /**
   * 组里 0 项(且没在搜索)时怎么办:
   *   import  素材类组,画一个虚线「导入…」占位,点了直接导入
   *   hint    照常显示组框,里面放组自己给的一句提示(GroupData.emptyHint)
   *   hide    整组不显示(卡片类组)
   * 搜索时没有命中的组一律隐藏。
   */
  empty: "import" | "hint" | "hide";
  /** 组详情根节点上的 data-pc,沿用改版前那几个容器的自动化钩子名 */
  hook?: string;
  /** 悬停在组框 / 详情计数上时的说明 */
  hint?: string;
}

/** 素材库:导入进来的素材 */
export const LIBRARY_GROUPS: readonly GroupDef[] = [
  { id: "videos", title: "Video", layout: "big_16_9", category: "visual", empty: "import" },
  { id: "images", title: "Images", layout: "big_16_9", category: "visual", empty: "import" },
  { id: "music", title: "audio", layout: "big_strip", category: "audio", empty: "import" },
  // 项目里的每条剪辑(2026-10-20 用户定:「剪辑应该也出现在素材库中」);单击在时间轴上打开,拖到序列上放剪辑段
  { id: "cuts", title: "Cut", layout: "big_16_9", category: "visual", empty: "hint", hook: "lib-cuts", hint: "Click to open on the timeline, drag onto a track to place a cut segment that references it" },
];

/** 动画:各类卡片和部件,全是视觉类(GroupBrowser 据此不画分类胶囊行) */
export const ANIMATION_GROUPS: readonly GroupDef[] = [
  {
    id: "user-cards",
    title: tr("Custom cards"),
    layout: "middle_cube",
    category: "visual",
    empty: "hide",
    hint: tr("Cards built on the spot by the AI or the user. Right-click = switch tier between \"Project media\" and \"Custom media\""),
  },
  { id: "magicui", title: "Magic UI", layout: "middle_cube", category: "visual", empty: "hide" },
  { id: "native", title: "Built-in cards", layout: "middle_cube", category: "visual", empty: "hide" },
  {
    id: "parts",
    title: tr("Parts library"),
    layout: "middle_cube",
    category: "visual",
    empty: "hide",
    hint: tr("Parts for composite cards: click once to add to the selected composite card, or with none selected, create a new composite card at the playhead"),
  },
  { id: "lottie", title: "Lottie animations", layout: "middle_cube", category: "visual", empty: "hide" },
  {
    id: "particles",
    title: tr("Particle background"),
    layout: "big_16_9",
    category: "visual",
    empty: "hide",
    hint: tr("The overview shows only a few featured items; open this group to see all"),
  },
];

export const EFFECTS_GROUPS: readonly GroupDef[] = [
  { id: "transitions", title: "Transition", layout: "middle_cube", category: "visual", empty: "hint" },
  { id: "filters", title: "Filters", layout: "middle_cube", category: "visual", empty: "hint", hook: "filters" },
  { id: "emphasis", title: "emphasis", layout: "middle_cube", category: "visual", empty: "hint" },
  { id: "themes", title: "Global style", layout: "middle_cube", category: "visual", empty: "hint", hook: "theme-list" },
  { id: "audiofx", title: "Audio effects", layout: "big_strip", category: "audio", empty: "hint", hook: "audiofx" },
  { id: "audio-presets", title: "Audio presets", layout: "big_strip", category: "audio", empty: "hint", hint: "Click one = create from preset" },
];

export const LIBRARY_GROUP_IDS = LIBRARY_GROUPS.map((g) => g.id);
export const ANIMATION_GROUP_IDS = ANIMATION_GROUPS.map((g) => g.id);
export const EFFECTS_GROUP_IDS = EFFECTS_GROUPS.map((g) => g.id);

/** 导入落到哪一类素材,就打开管这一类的组 */
export const KIND_GROUP: Record<MediaAsset["kind"], string> = { video: "videos", image: "images", audio: "music" };

/** 组里的一项:详情里按组的 layout 瀑布流排;aspect = 高 / 宽,未知给 undefined */
export interface GroupItem {
  id: string;
  node: ReactNode;
  aspect?: number;
}

export interface GroupData {
  /** 当前搜索词下的全部项。详情里排的是它,组框上的「N 个项」数的也是它 */
  items: GroupItem[];
  /** 总览组框里的缩略预览:纯展示、不带自动化钩子。按组的 layout 取前几个 */
  thumbs?: GroupItem[];
  /** 详情里放在项目上方 / 下方的附加内容(时长选择、已有转场列表、参考说明……) */
  detailTop?: ReactNode;
  detailBottom?: ReactNode;
  /** 总览组框里 0 项时的一句提示(empty = "hint" 的组) */
  emptyHint?: ReactNode;
  /** 详情里 0 项时的说明(空态或「没有匹配的…」) */
  emptyDetail?: ReactNode;
}

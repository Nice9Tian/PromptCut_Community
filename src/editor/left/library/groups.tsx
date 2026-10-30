import type { ReactNode } from "react";
import type { GroupLayout } from "./layout";
import type { MediaAsset } from "../../../kernel/project";

/**
 * 素材库 / 动画 / 特效三个分区的「组定义」表。要挪组、改 layout、改名、换分类,只改这里。
 * 每个组的内容由对应的 *Group 钩子按搜索词算出来(GroupData),GroupBrowser 负责总览和详情。
 */

export type GroupCategory = "视觉" | "音频";
export const CATEGORIES: readonly GroupCategory[] = ["视觉", "音频"];

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
  { id: "videos", title: "视频", layout: "big_16_9", category: "视觉", empty: "import" },
  { id: "images", title: "图片", layout: "big_16_9", category: "视觉", empty: "import" },
  { id: "music", title: "音频", layout: "big_strip", category: "音频", empty: "import" },
  // 项目里的每条剪辑(2026-10-20 用户定:「剪辑应该也出现在素材库中」);单击在时间轴上打开,拖到序列上放剪辑段
  { id: "cuts", title: "剪辑", layout: "big_16_9", category: "视觉", empty: "hint", hook: "lib-cuts", hint: "单击在时间轴上打开,拖到序列上放一个引用它的剪辑段" },
];

/** 动画:各类卡片和部件,全是视觉类(GroupBrowser 据此不画分类胶囊行) */
export const ANIMATION_GROUPS: readonly GroupDef[] = [
  {
    id: "user-cards",
    title: "定制卡片",
    layout: "middle_cube",
    category: "视觉",
    empty: "hide",
    hint: "AI 或用户现场建的卡。右键 = 在「项目素材」和「自定义素材」之间换档",
  },
  { id: "magicui", title: "Magic UI", layout: "middle_cube", category: "视觉", empty: "hide" },
  { id: "native", title: "自家卡片", layout: "middle_cube", category: "视觉", empty: "hide" },
  {
    id: "parts",
    title: "部件库",
    layout: "middle_cube",
    category: "视觉",
    empty: "hide",
    hint: "组合卡的零件:点一下加进选中的组合卡,没选中就在播放头新建一张组合卡",
  },
  { id: "lottie", title: "Lottie 动效", layout: "middle_cube", category: "视觉", empty: "hide" },
  {
    id: "particles",
    title: "粒子背景",
    layout: "big_16_9",
    category: "视觉",
    empty: "hide",
    hint: "总览里只露精选的几种,打开这个组看全部",
  },
];

export const EFFECTS_GROUPS: readonly GroupDef[] = [
  { id: "transitions", title: "转场", layout: "middle_cube", category: "视觉", empty: "hint" },
  { id: "filters", title: "滤镜", layout: "middle_cube", category: "视觉", empty: "hint", hook: "filters" },
  { id: "emphasis", title: "强调", layout: "middle_cube", category: "视觉", empty: "hint" },
  { id: "themes", title: "全局风格", layout: "middle_cube", category: "视觉", empty: "hint", hook: "theme-list" },
  { id: "audiofx", title: "音频效果", layout: "big_strip", category: "音频", empty: "hint", hook: "audiofx" },
  { id: "audio-presets", title: "音频预设", layout: "big_strip", category: "音频", empty: "hint", hint: "点一条 = 从预设新建" },
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

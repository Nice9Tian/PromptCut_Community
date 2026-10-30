/**
 * 主题库调色板:来自「视频剪辑软件 UI 色卡」设计稿的五套主题,深浅各一份取值。
 * 结构固定:5 级表面(L0 画布 / L1 面板底 / L2 面板 / L3 控件底 / L4 悬浮)、
 * 主次文字、强调色、7 类素材轨道色;浅色一档多一个描边值(深色描边由表面推导)。
 * 相邻层级明度差 4–6%,靠描边而非阴影分层;轨道色深浅两版分别保证片段上白字 / 黑字 4.5:1。
 */
export interface PaletteSide {
  surfaces: [string, string, string, string, string]; // L0..L4
  fg: string;
  fgMuted: string;
  accent: string;
  /** 浅色一档设计稿给的描边(强);深色留空,由表面推导 */
  border?: string;
  /**
   * 「配色诊断与修正 v2」给钢蓝·深单独标了三个值,推导公式凑不准,所以允许显式给:
   * hairline 面板之间的分隔线、borderStrong 控件描边、fgFaint 弱文字下限。
   * 没给的主题照旧由表面推导。
   */
  hairline?: string;
  borderStrong?: string;
  fgFaint?: string;
  tracks: Record<TrackKind, string>;
}

export type TrackKind = "video" | "audio" | "image" | "text" | "fx" | "transition" | "sticker";

export interface Palette {
  id: string;
  name: string;
  en: string;
  blurb: string;
  dark: PaletteSide;
  light: PaletteSide;
}

const T = (video: string, audio: string, image: string, text: string, fx: string, transition: string, sticker: string) =>
  ({ video, audio, image, text, fx, transition, sticker }) as Record<TrackKind, string>;

export const palettes: Palette[] = [
  {
    id: "studio",
    name: "流光",
    en: "Studio",
    // 强调色沿用 PromptCut 一直以来的青蓝品牌色(和靛夜那套同一个值),底色换成更深的生产力工具灰
    blurb: "深邃的现代生产力工具底色,青蓝品牌色强调,分层清晰。",
    dark: {
      surfaces: ["#111016", "#1B1A21", "#23222A", "#2C2B34", "#383742"],
      fg: "#F2F1F6", fgMuted: "#A6A4B2", accent: "#00DBDB",
      hairline: "#2A2932", borderStrong: "#3A3944", fgFaint: "#72707D",
      tracks: T("#4FB3C9", "#5FBB8F", "#A98CF0", "#E0B356", "#E77FB0", "#7F95F5", "#E08A63"),
    },
    light: {
      surfaces: ["#E6E5EB", "#F3F2F7", "#FFFFFF", "#EAE9F0", "#FFFFFF"],
      fg: "#1B1A21", fgMuted: "#5D5B68", accent: "#0E7A85", border: "#D3D1DB",
      tracks: T("#23808F", "#2F7A58", "#6A4BC0", "#9A6F1C", "#B34B7F", "#4A5CC4", "#A9532C"),
    },
  },
  {
    id: "steel",
    name: "钢蓝",
    en: "Steel",
    blurb: "中性偏冷的灰阶 + 钢蓝强调。克制、可长时间注视,颜色全部留给素材。",
    dark: {
      surfaces: ["#0A0C0E", "#14171A", "#1B1F23", "#23282D", "#2E343A"],
      fg: "#E9EDF1", fgMuted: "#9BA5AF", accent: "#7FA8D4",
      // 配色诊断与修正 v2 实测值:分隔线 / 控件描边 / 弱文字下限
      hairline: "#262C32", borderStrong: "#3C444C", fgFaint: "#6A737C",
      tracks: T("#37A39B", "#57A55F", "#9182DD", "#D6A03F", "#CC6AA8", "#6F8CE0", "#D2764F"),
    },
    light: {
      surfaces: ["#DCDEE1", "#ECEEF0", "#FFFFFF", "#E4E6E9", "#FFFFFF"],
      fg: "#1D1F20", fgMuted: "#5C6268", accent: "#5980A6", border: "#CBD0D6",
      tracks: T("#1F7D76", "#3D7F45", "#6656B8", "#A5762A", "#A44583", "#4A63B8", "#A75531"),
    },
  },
  {
    id: "graphite",
    name: "石墨",
    en: "Graphite",
    blurb: "完全无色偏的中性灰,强调色换成琥珀。适合调色场景,界面不带任何色相。",
    dark: {
      surfaces: ["#0B0B0B", "#151515", "#1D1D1D", "#262626", "#333333"],
      fg: "#EDEDED", fgMuted: "#A1A1A1", accent: "#E3A047",
      tracks: T("#6F97B8", "#7FA87A", "#A394C4", "#C9A45E", "#BD8298", "#8B93C9", "#C08B6D"),
    },
    light: {
      surfaces: ["#DEDEDE", "#EFEFEF", "#FFFFFF", "#E6E6E6", "#FFFFFF"],
      fg: "#191919", fgMuted: "#5E5E5E", accent: "#A96A18", border: "#CFCFCF",
      tracks: T("#48708F", "#4F7A4A", "#6E5F96", "#96712F", "#8F5570", "#565F9B", "#8F5A3C"),
    },
  },
  {
    id: "indigo",
    name: "靛夜",
    en: "Indigo",
    blurb: "底色带蓝紫倾向,强调色是青。偏消费端的创作气质,轨道色更饱和、更活跃。",
    dark: {
      surfaces: ["#0C0E16", "#161A26", "#1E2331", "#282E3E", "#343B4D"],
      fg: "#E6E9F2", fgMuted: "#98A0B8", accent: "#00DBDB",
      tracks: T("#4FB3C9", "#5FBB8F", "#A98CF0", "#E0B356", "#E77FB0", "#7F95F5", "#E08A63"),
    },
    light: {
      surfaces: ["#DCDFE8", "#ECEEF4", "#FFFFFF", "#E3E6EF", "#FFFFFF"],
      fg: "#1A1D29", fgMuted: "#565D73", accent: "#0E7A85", border: "#C7CBD9",
      tracks: T("#23808F", "#2F7A58", "#6A4BC0", "#9A6F1C", "#B34B7F", "#4A5CC4", "#A9532C"),
    },
  },
  {
    id: "terminal",
    name: "终端",
    en: "Terminal",
    blurb: "对比度最高的一套:近黑的底、荷绿强调,描边比其他主题重一档。给键盘流与节点式工作流。",
    dark: {
      surfaces: ["#060707", "#101312", "#171B1A", "#202524", "#2B3231"],
      fg: "#E8F0EC", fgMuted: "#93A29C", accent: "#5FD39A",
      tracks: T("#4BB6C4", "#63C17A", "#9B8ED6", "#D4B355", "#D97BA6", "#6F9EE0", "#CF8055"),
    },
    light: {
      surfaces: ["#D9DEDB", "#ECEEED", "#FFFFFF", "#E2E6E4", "#FFFFFF"],
      fg: "#101413", fgMuted: "#4F5956", accent: "#1F7A54", border: "#C4CBC8",
      tracks: T("#1C7A86", "#2C7743", "#5F4FAE", "#8F7020", "#A94A78", "#45619F", "#96522F"),
    },
  },
  {
    id: "clay",
    name: "陶土",
    en: "Clay",
    blurb: "唯一的暖底主题:灰阶带一点褐,强调色是赭。长时间剪辑更松弛,浅色一档接近纸张。",
    dark: {
      surfaces: ["#100E0C", "#1A1715", "#221F1C", "#2B2724", "#37322E"],
      fg: "#F0EBE5", fgMuted: "#A89E94", accent: "#E08A63",
      tracks: T("#63A9A0", "#8FAE5F", "#A58FC9", "#D9A24F", "#C9788E", "#7F95BD", "#CF7F57"),
    },
    light: {
      surfaces: ["#E2DDD6", "#F2EFEB", "#FFFFFF", "#E8E3DC", "#FFFFFF"],
      fg: "#201C18", fgMuted: "#635B52", accent: "#A4522B", border: "#D2CBC2",
      tracks: T("#2E7D74", "#5D7A2C", "#6B539C", "#9A6C1E", "#9C4C60", "#4A628C", "#9A4F2C"),
    },
  },
];

/** 语义色:设计稿只定义了一套,深浅各一份,所有主题共用 */
export const semantic = {
  dark: { danger: "#E2564D", warn: "#E0A13A", success: "#4F9E5C" },
  light: { danger: "#C0433B", warn: "#A5762A", success: "#3D7F45" },
};

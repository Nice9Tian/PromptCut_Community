import { tr } from "../i18n/index.ts";
/**
 * Theme library palettes: five themes from the "Video editing software UI swatch" design draft,
 * with light and dark values for each.
 * Fixed structure: 5 surface tiers (L0 canvas / L1 panel base / L2 panel / L3 control base /
 * L4 floating), primary/secondary text, accent color, 7 media track colors; the light tier has an
 * extra border value (dark borders are derived from surfaces).
 * Adjacent tiers differ by 4-6% in lightness, layered via borders rather than shadows; dark and light
 * track colors guarantee 4.5:1 contrast for white/black text on clips respectively.
 */
export interface PaletteSide {
  surfaces: [string, string, string, string, string]; // L0..L4
  fg: string;
  fgMuted: string;
  accent: string;
  /** Border (strong) from design draft for light tier; left empty for dark, derived from surface */
  border?: string;
  /**
   * "Color diagnosis and correction v2" explicitly specified three values for Steel Blue · Dark,
   * which derivation formulas cannot accurately match, so explicit values are allowed:
   * hairline dividers between panels, borderStrong control borders, fgFaint faint text lower bound.
   * Themes without them are derived from surfaces as before.
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
    name: tr("Flow"),
    en: "Studio",
    // Accent color keeps PromptCut's longtime cyan-blue brand color (same value as Indigo Night),
    // base color replaced with a deeper productivity-tool gray
    blurb: tr("Deep modern productivity-tool base colors with a cyan-blue brand accent and clear layering."),
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
    name: tr("Steel blue"),
    en: "Steel",
    blurb: tr("Neutral, cool-leaning grays with a steel-blue accent. Restrained and easy on the eyes over long sessions, leaving all the color to your media."),
    dark: {
      surfaces: ["#0A0C0E", "#14171A", "#1B1F23", "#23282D", "#2E343A"],
      fg: "#E9EDF1", fgMuted: "#9BA5AF", accent: "#7FA8D4",
      // Measured values from Color diagnosis and correction v2: dividers / control borders /
      // faint text lower bound
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
    name: tr("Graphite"),
    en: "Graphite",
    blurb: tr("Completely neutral gray with no color cast, and amber as the accent. Suited to color grading; the interface carries no hue at all."),
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
    name: tr("Indigo night"),
    en: "Indigo",
    blurb: tr("A base with a blue-violet lean and a cyan accent. A consumer-oriented creative feel, with more saturated, livelier track colors."),
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
    name: tr("Terminal"),
    en: "Terminal",
    blurb: tr("The highest-contrast set: near-black base, mint-green accent, and strokes one step heavier than other themes. Made for keyboard-driven and node-based workflows."),
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
    name: tr("Terracotta"),
    en: "Clay",
    blurb: tr("The only warm-base theme: grays with a touch of brown and an ochre accent. More relaxed for long editing sessions, and the light tier is close to paper."),
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

/**
 * Semantic colors: design draft defines only one set, one each for dark and light,
 * shared by all themes
 */
export const semantic = {
  dark: { danger: "#E2564D", warn: "#E0A13A", success: "#4F9E5C" },
  light: { danger: "#C0433B", warn: "#A5762A", success: "#3D7F45" },
};

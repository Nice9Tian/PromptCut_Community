import { tr } from "../i18n/index.ts";
/**
 * Themes. Each theme is a set of CSS variables attached to the stage root element (.pc-stage)
 * and the editor root element. Cards only read variables and do not hardcode colors:
 *   --pc-accent           Accent color
 *   --pc-fg               Foreground text
 *   --pc-fg-muted         Secondary text
 *   --pc-fg-faint         Fainter text / divider
 *   --pc-glass-bg         Glass background (color with transparency)
 *   --pc-glass-border     Glass border
 *   --pc-glass-blur       backdrop-filter blur amount, e.g. "16px"
 *   --pc-radius           Card border radius
 *   --pc-font             Heading font stack
 *   --pc-font-mono        Monospace font stack
 *   --pc-shadow           Card shadow
 *   --pc-border-width     Glass border width (new)
 *   --pc-on-accent        Text / icon color on top of accent color blocks (new)
 *   --pc-text-shadow      Text stroke / shadow for cards without glass background (new)
 * Note: 5 themes populated
 *
 * "Segoe UI Symbol" in the monospace font stack: Consolas lacks symbols like ✓; when falling back
 * to the system, Chrome and chrome-headless-shell choose different fonts (in testing, ✓ resolved
 * to Noto Sans SC on one side and Segoe UI Symbol on the other), causing different glyph widths
 * and shifting the whole line. Specifying it explicitly avoids leaving such symbols to system
 * selection. See docs/archive/topics/render-rebuild-plan.md Phase 0.
 */
export interface Theme {
  id: string;
  name: string;
  description: string;
  /** Variable name → value, without the "--pc-" prefix */
  vars: Record<string, string>;
}

export const themes: Theme[] = [
  {
    id: "midnight",
    name: tr("Midnight"),
    description: tr("Dark glass base, cool blue primary color"),
    vars: {
      accent: "#4f8cff",
      fg: "#f5f7fa",
      "fg-muted": "rgba(245,247,250,0.72)",
      "fg-faint": "rgba(245,247,250,0.38)",
      "glass-bg": "rgba(12,14,20,0.58)",
      "glass-border": "rgba(255,255,255,0.12)",
      "glass-blur": "16px",
      radius: "20px",
      font: 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
      "font-mono": 'ui-monospace, Consolas, "Segoe UI Symbol", "Microsoft YaHei", monospace',
      shadow: "0 24px 60px rgba(0,0,0,0.45)",
      "border-width": "1px",
      "on-accent": "#0b1220",
      "text-shadow": "0 4px 24px rgba(0,0,0,0.75)",
    },
  },
  {
    id: "ivory",
    name: tr("Ivory"),
    description: tr("Light paper feel, warm gray text, amber primary color"),
    vars: {
      accent: "#d97706",
      fg: "#45403c",
      "fg-muted": "rgba(69,64,60,0.72)",
      "fg-faint": "rgba(69,64,60,0.38)",
      "glass-bg": "rgba(255,252,246,0.86)",
      "glass-border": "rgba(0,0,0,0.06)",
      "glass-blur": "24px",
      radius: "16px",
      font: 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
      "font-mono": 'ui-monospace, Consolas, "Segoe UI Symbol", "Microsoft YaHei", monospace',
      shadow: "0 12px 32px rgba(0,0,0,0.08)",
      "border-width": "1px",
      "on-accent": "#fffbf5",
      "text-shadow": "0 0 3px rgba(255,255,255,0.95), 0 0 6px rgba(255,255,255,0.95), 0 0 14px rgba(255,255,255,0.85), 0 2px 20px rgba(255,255,255,0.7)",
    },
  },
  {
    id: "neon",
    name: tr("Neon"),
    description: tr("Pure black base, fluorescent cyan/magenta primary colors, glowing shadows"),
    vars: {
      accent: "#00ffcc",
      fg: "#ffffff",
      "fg-muted": "rgba(255,255,255,0.7)",
      "fg-faint": "rgba(255,255,255,0.3)",
      "glass-bg": "rgba(0,0,0,0.85)",
      "glass-border": "rgba(0,255,204,0.3)",
      "glass-blur": "8px",
      radius: "8px",
      font: 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
      "font-mono": 'ui-monospace, Consolas, "Segoe UI Symbol", "Microsoft YaHei", monospace',
      shadow: "0 0 40px rgba(0,255,204,0.4)",
      "border-width": "2px",
      "on-accent": "#00201a",
      "text-shadow": "0 0 24px rgba(0,255,204,0.6)",
    },
  },
  {
    id: "sunrise",
    name: tr("Warm sun"),
    description: tr("Cream base, orange primary color, large rounded corners"),
    vars: {
      accent: "#f97316",
      fg: "#431407",
      "fg-muted": "rgba(67,20,7,0.7)",
      "fg-faint": "rgba(67,20,7,0.3)",
      "glass-bg": "rgba(255,247,237,0.9)",
      "glass-border": "rgba(249,115,22,0.2)",
      "glass-blur": "32px",
      radius: "48px",
      font: 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
      "font-mono": 'ui-monospace, Consolas, "Segoe UI Symbol", "Microsoft YaHei", monospace',
      shadow: "0 20px 40px rgba(249,115,22,0.15)",
      "border-width": "1px",
      "on-accent": "#fff7ed",
      "text-shadow": "0 0 3px rgba(255,255,255,0.95), 0 0 6px rgba(255,255,255,0.95), 0 0 14px rgba(255,255,255,0.85), 0 2px 20px rgba(255,255,255,0.7)",
    },
  },
  {
    id: "forest",
    name: tr("Dark green"),
    description: tr("Deep green glass, gold primary color, serif headings"),
    vars: {
      accent: "#eab308",
      fg: "#fefce8",
      "fg-muted": "rgba(254,252,232,0.7)",
      "fg-faint": "rgba(254,252,232,0.3)",
      "glass-bg": "rgba(6,78,59,0.75)",
      "glass-border": "rgba(234,179,8,0.3)",
      "glass-blur": "20px",
      radius: "24px",
      font: 'Georgia, "Times New Roman", "Songti SC", "SimSun", serif',
      "font-mono": '"Courier New", "Segoe UI Symbol", "SimSun", ui-monospace, monospace',
      shadow: "0 24px 60px rgba(0,0,0,0.5)",
      "border-width": "1px",
      "on-accent": "#1a1400",
      "text-shadow": "0 4px 24px rgba(0,0,0,0.75)",
    },
  }
];

export function getTheme(id: string | undefined): Theme {
  return themes.find((t) => t.id === id) ?? themes[0];
}

/**
 * Convert to a style object and attach to the stage root (and the card preview root).
 *
 * Also connects Tailwind's `--font-mono` to the theme's monospace font. The `font-mono` class
 * reads `--font-mono`, which src/skins/skins.css points to the **editor skin** monospace stack on
 * :root (`ui-monospace, SFMono-Regular, monospace`, without Consolas): the UI skin leaked into
 * the final video: numbers in rank-bars / growth-curve fell back to NSimSun (serif) in Chrome and
 * Courier New in headless-shell. Overriding it on the stage root ensures that font-mono in cards
 * uses the exact same font as `var(--pc-font-mono)`.
 */
export function themeStyle(id: string | undefined): Record<string, string> {
  const t = getTheme(id);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.vars)) out[`--pc-${k}`] = v;
  out["--font-mono"] = "var(--pc-font-mono)";
  return out;
}

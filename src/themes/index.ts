/**
 * 主题。每套主题是一组 CSS 变量,挂在舞台根元素(.pc-stage)和编辑器根元素上。
 * 卡片只读变量、不写死颜色:
 *   --pc-accent           主色
 *   --pc-fg               前景文字
 *   --pc-fg-muted         次级文字
 *   --pc-fg-faint         更弱的文字/分隔线
 *   --pc-glass-bg         玻璃底(带透明度的颜色)
 *   --pc-glass-border     玻璃边线
 *   --pc-glass-blur       backdrop-filter 模糊量,如 "16px"
 *   --pc-radius           卡片圆角
 *   --pc-font             标题字体栈
 *   --pc-font-mono        等宽字体栈
 *   --pc-shadow           卡片投影
 *   --pc-border-width     玻璃边框宽度(新增)
 *   --pc-on-accent        主色块上面的文字/图标颜色(新增)
 *   --pc-text-shadow      无玻璃底的卡片的文字描边/投影(新增)
 * 说明:5 套主题已填充
 *
 * 等宽字体栈里的 "Segoe UI Symbol":Consolas 没有 ✓ 这类符号,落进系统回退后,Chrome 和
 * chrome-headless-shell 会选不同的字体(实测 ✓ 一边 Noto Sans SC、一边 Segoe UI Symbol),
 * 字宽不同,整行平移。显式写上它,这类符号就不再交给系统去挑。见 docs/archive/topics/render-rebuild-plan.md 阶段 0。
 */
export interface Theme {
  id: string;
  name: string;
  description: string;
  /** 变量名 → 值,不带 "--pc-" 前缀 */
  vars: Record<string, string>;
}

export const themes: Theme[] = [
  {
    id: "midnight",
    name: "午夜",
    description: "深色玻璃底、冷蓝主色",
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
    name: "象牙",
    description: "浅色纸感、暖灰字、琥珀主色",
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
    name: "霓虹",
    description: "纯黑底、荧光青/品红主色、发光投影",
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
    name: "暖阳",
    description: "奶油底、橙主色、大圆角",
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
    name: "墨绿",
    description: "深绿玻璃、金色主色、衬线标题字",
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
 * 转成 style 对象,挂到舞台根(以及卡片预览的根)上。
 *
 * 顺带把 Tailwind 的 `--font-mono` 接到主题的等宽字体上。`font-mono` 这个类读的是 `--font-mono`,
 * 而 src/skins/skins.css 在 :root 上把它指向了**编辑器界面皮肤**的等宽栈
 * (`ui-monospace, SFMono-Regular, monospace`,没有 Consolas)—— 界面皮肤漏进了成片:
 * rank-bars / growth-curve 的数字在 Chrome 里落到 NSimSun(衬线体),在 headless-shell 里落到 Courier New。
 * 在舞台根上覆盖掉,卡片里的 font-mono 就和 `var(--pc-font-mono)` 是同一套字。
 */
export function themeStyle(id: string | undefined): Record<string, string> {
  const t = getTheme(id);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.vars)) out[`--pc-${k}`] = v;
  out["--font-mono"] = "var(--pc-font-mono)";
  return out;
}

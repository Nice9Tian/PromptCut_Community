import type { SkinMode } from "./skins";
import { agentColorFor } from "./agentColor";

/**
 * 自定义配色:压在预设皮肤之上的一层覆盖。
 *
 * 预设负责给一整套协调的 --ui-*,这里只记用户手动改过的那几项。分成两层而不是
 * 让用户克隆一整套,是因为换预设时这层还留着——用户改过的强调色不会因为换了
 * 底色就丢掉;不想要了点「恢复默认」清空即可。
 */

const STORAGE_KEY = "pc.skin.vars";

/** 能在界面上单独调的槽位。没列进来的(派生色、轨道墨色等)由下面的联动补齐 */
export interface SkinSlot {
  /** --ui-* 里去掉 -- 的名字 */
  key: string;
  label: string;
  group: string;
  hint?: string;
}

export const SKIN_SLOTS: SkinSlot[] = [
  { key: "ui-accent", label: "强调色", group: "主色", hint: "按钮、选中态、播放头;悬停/按下/淡底会跟着一起算" },
  { key: "ui-bg", label: "画布底色", group: "表面" },
  { key: "ui-panel", label: "面板底色", group: "表面" },
  { key: "ui-panel-2", label: "次级面板", group: "表面" },
  { key: "ui-float", label: "浮层底色", group: "表面", hint: "菜单、对话框" },
  { key: "ui-fg", label: "主文字", group: "文字与描边" },
  { key: "ui-fg-muted", label: "次要文字", group: "文字与描边" },
  { key: "ui-border", label: "描边", group: "文字与描边" },
  { key: "ui-border-strong", label: "强描边", group: "文字与描边" },
  { key: "ui-danger", label: "危险", group: "语义色" },
  { key: "ui-warn", label: "警告", group: "语义色" },
  { key: "ui-success", label: "成功", group: "语义色" },
  { key: "ui-track-video", label: "视频轨", group: "轨道" },
  { key: "ui-track-audio", label: "音频轨", group: "轨道" },
  { key: "ui-track-text", label: "文字轨", group: "轨道" },
  { key: "ui-track-image", label: "图片轨", group: "轨道" },
  { key: "ui-track-fx", label: "特效轨", group: "轨道" },
];

export type SkinOverrides = Record<string, string>;

function read(): SkinOverrides {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // 只收我们认识的槽位,别让手改过的 localStorage 往 <html> 上写任意属性
    const known = new Set(SKIN_SLOTS.map((s) => s.key));
    return Object.fromEntries(
      Object.entries(parsed).filter(([k, v]) => known.has(k) && typeof v === "string"),
    ) as SkinOverrides;
  } catch {
    return {};
  }
}

function write(next: SkinOverrides): void {
  try {
    if (Object.keys(next).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 无痕模式记不住就算了,本次会话内仍然生效 */
  }
}

let overrides: SkinOverrides = read();
const listeners = new Set<() => void>();

export function getOverrides(): SkinOverrides {
  return overrides;
}

export function subscribeOverrides(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 改了强调色,派生的那几个也得跟着走,否则悬停态、按下态还是旧颜色,看着像坏了。
 * 比例照抄 skins.ts 里 sideToVars 的算法,只是把基色换成用户选的。
 */
function derive(key: string, value: string, mode: SkinMode): SkinOverrides {
  if (key !== "ui-accent") return {};
  const dark = mode === "dark";
  const mix = (b: string, pa: number) => `color-mix(in oklab, ${value} ${pa}%, ${b})`;
  return {
    "ui-accent-hover": mix("#ffffff", dark ? 82 : 78),
    "ui-accent-press": mix("#000000", dark ? 78 : 74),
    "ui-accent-soft": mix(dark ? "#000000" : "#ffffff", dark ? 24 : 14),
    "ui-info": value,
    "ui-glow": `0 0 10px ${mix("transparent", 45)}`,
    // Agent 头像色跟着新强调色重算(同明度同纯度的黄,强调色本身黄橙时换紫);取色器给的一定是 #rrggbb
    "ui-agent": agentColorFor(value),
  };
}

/** 派生出来的键:清空某个槽位时要一并撤掉 */
export function derivedKeys(key: string): string[] {
  return Object.keys(derive(key, "#000000", "dark"));
}

/** 把一个槽位连同它的派生项算出来,交给 useSkin 去写 */
export function expandOverrides(mode: SkinMode): SkinOverrides {
  const out: SkinOverrides = {};
  for (const [k, v] of Object.entries(overrides)) {
    out[k] = v;
    Object.assign(out, derive(k, v, mode));
  }
  return out;
}

export function setOverride(key: string, value: string | null): void {
  const next = { ...overrides };
  if (value === null) delete next[key];
  else next[key] = value;
  overrides = next;
  write(next);
  listeners.forEach((l) => l());
}

export function clearOverrides(): void {
  overrides = {};
  write(overrides);
  listeners.forEach((l) => l());
}

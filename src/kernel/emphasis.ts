/**
 * 强调:给一个片段加「阴影」或「描边」,**沿着画面里不透明的那部分的边缘**走。
 *
 * 为什么不是 box-shadow / border:那两个描的是元素的方框,而卡片、透明底的 PNG、
 * 抠好的人物,画面里真正有东西的只是方框内的一小块 —— 描出来的框会框住一大片空气。
 * CSS 的 `filter: drop-shadow()` 是按 **alpha 通道**算的:透明的地方不投影,
 * 所以文字、图形、抠像的边缘会被准确地描出来。描边就是同一招绕一圈:
 * 八个方向各投一次零模糊的影,合起来就是一圈等宽的边。
 *
 * 纯字符串计算,不碰 DOM:舞台(render/Stage.tsx)、预览的素材层、导出逐帧截图
 * 用的是同一份 filter,所以预览什么样导出就什么样。
 */
export type EmphasisKind = "shadow" | "outline";

export interface ClipEmphasis {
  kind: EmphasisKind;
  /** CSS 颜色;阴影默认黑、描边默认白 */
  color?: string;
  /** 舞台像素。阴影 = 模糊半径,描边 = 线宽 */
  size?: number;
  /** 0~1,叠在颜色本身的透明度上 */
  opacity?: number;
  /** 阴影的偏移(舞台像素);描边用不到 */
  dx?: number;
  dy?: number;
}

export const EMPHASIS_LABEL: Record<EmphasisKind, string> = { shadow: "阴影", outline: "描边" };

/** 各自的默认值:不给参数时就是这一套 */
export const EMPHASIS_DEFAULTS: Record<EmphasisKind, Required<Omit<ClipEmphasis, "kind">>> = {
  shadow: { color: "#000000", size: 18, opacity: 0.55, dx: 0, dy: 8 },
  outline: { color: "#ffffff", size: 6, opacity: 1, dx: 0, dy: 0 },
};

const MAX_SIZE = 80;
const MAX_OFFSET = 200;

const clamp = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

/** 把用户 / Agent 给的一坨参数补齐、夹到合理范围。kind 不认识就返回 null */
export function normalizeEmphasis(raw: Partial<ClipEmphasis> | null | undefined): Required<ClipEmphasis> | null {
  if (!raw || (raw.kind !== "shadow" && raw.kind !== "outline")) return null;
  const d = EMPHASIS_DEFAULTS[raw.kind];
  return {
    kind: raw.kind,
    color: typeof raw.color === "string" && raw.color.trim() ? raw.color.trim() : d.color,
    size: clamp(raw.size, 0, MAX_SIZE, d.size),
    opacity: clamp(raw.opacity, 0, 1, d.opacity),
    dx: clamp(raw.dx, -MAX_OFFSET, MAX_OFFSET, d.dx),
    dy: clamp(raw.dy, -MAX_OFFSET, MAX_OFFSET, d.dy),
  };
}

/** 颜色 + 不透明度合成一个 CSS 颜色。不解析颜色串本身,交给浏览器算 */
function tint(color: string, opacity: number): string {
  if (opacity >= 1) return color;
  return `color-mix(in srgb, ${color} ${Math.round(opacity * 100)}%, transparent)`;
}

/** 描边绕一圈的方向数:8 个方向 + 一点点模糊,边就是连续的,再多只是白费算力 */
const RING = 8;

/**
 * 算出 CSS filter 串。给 null / 越界参数都返回空串(空串 = 不写 filter,DOM 一个字不变)。
 *
 * @param scale 舞台像素到实际渲染像素的倍率。舞台整体被 transform 缩放时不用传(filter 跟着一起缩);
 *              素材层那种自己按 objectFit 铺满的才需要。
 */
export function emphasisFilter(e: ClipEmphasis | null | undefined, scale = 1): string {
  const n = normalizeEmphasis(e);
  if (!n || n.size <= 0 || n.opacity <= 0) return "";
  const px = (v: number) => `${+(v * scale).toFixed(2)}px`;
  const c = tint(n.color, n.opacity);
  if (n.kind === "shadow") {
    return `drop-shadow(${px(n.dx)} ${px(n.dy)} ${px(n.size)} ${c})`;
  }
  // 描边:八个方向各投一次,线宽就是半径;粗一点的加一丝模糊填住方向之间的缝
  const r = n.size;
  const blur = r > 4 ? r * 0.2 : 0;
  const parts: string[] = [];
  for (let i = 0; i < RING; i++) {
    const a = (i * 2 * Math.PI) / RING;
    parts.push(`drop-shadow(${px(Math.cos(a) * r)} ${px(Math.sin(a) * r)} ${px(blur)} ${c})`);
  }
  return parts.join(" ");
}

/** 一行说明,给界面和 Agent 回显 */
export function describeEmphasis(e: ClipEmphasis | null | undefined): string {
  const n = normalizeEmphasis(e);
  if (!n) return "无";
  if (n.kind === "shadow") return `阴影 ${n.size}px · 偏移 ${n.dx},${n.dy} · ${n.color} ${Math.round(n.opacity * 100)}%`;
  return `描边 ${n.size}px · ${n.color} ${Math.round(n.opacity * 100)}%`;
}

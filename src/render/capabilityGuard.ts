/**
 * 运行期兜底（A0.2 末句）。
 *
 * 审阅表（src/cards/capabilities.json）说一张卡 `independent`，意思是「只画自己」——
 * 它的预渲染结果可以单独存、可以上云共享。要是这张卡实际上带了 `backdrop-filter`，
 * 那份死素材就是错的：它把当时身后的画面糊进去了，换个下层就对不上。
 *
 * 这里在挂载后量一次 computed style，量到就报警并把这张卡记进降级表
 * （frameMode.mjs 的 degradeCard），本次会话内当 `belowDependent` 处理。
 * 只加不减，和审阅表一样喂给身份 digest。
 *
 * 为什么只查 `backdrop-filter`：读像素的 API（getImageData / drawImage 别的图层）
 * 没法从 DOM 上量出来，只能靠源码审阅和 checkCardSource 挡。这里做的是便宜那一半。
 *
 * 开销：只在开发态跑一次（`shouldGuard`），导出 / 生成快照那条路上一个字都不执行。
 */
import { degradeCard, reviewedCard } from "../kernel/frameMode.mjs";

export type StyleReader = (el: Element) => { backdropFilter?: string | null; webkitBackdropFilter?: string | null };

const NONE = new Set(["", "none", "initial", "unset"]);

const domStyle: StyleReader = (el) => {
  const view = el.ownerDocument?.defaultView;
  if (!view?.getComputedStyle) return {};
  const cs = view.getComputedStyle(el) as CSSStyleDeclaration & { webkitBackdropFilter?: string };
  return { backdropFilter: cs.backdropFilter, webkitBackdropFilter: cs.webkitBackdropFilter };
};

/** 子树里有没有真的开着的 backdrop-filter（含 -webkit- 前缀） */
export function usesBackdropFilter(root: Element | null | undefined, readStyle: StyleReader = domStyle): boolean {
  if (!root) return false;
  const nodes: Element[] = [root, ...Array.from(root.querySelectorAll?.("*") ?? [])];
  for (const el of nodes) {
    const style = readStyle(el);
    for (const value of [style.backdropFilter, style.webkitBackdropFilter]) {
      if (typeof value === "string" && !NONE.has(value.trim().toLowerCase())) return true;
    }
  }
  return false;
}

/** 审阅表说 independent 的卡才需要查：别的值本来就按依赖处理，量不量都一样 */
export function needsGuard(cardId: string | undefined): boolean {
  if (!cardId || SCANNED.has(cardId)) return false;
  return reviewedCard(cardId)?.compositing === "independent";
}

export interface GuardedClip { id: string; cardId: string }

/** 每张卡一辈子只量一次:量 computed style 会强制排版,不能每次换片段都重来一遍。 */
const SCANNED = new Set<string>();
export function resetGuardScans() { SCANNED.clear(); }

/**
 * 扫一遍舞台上的卡片外层（`[data-pc-clip]`），把「说独立、实际有毛玻璃」的降级掉。
 * 返回这次新降级的卡 id；已经降过的不重复报警。
 */
export function guardCompositing(
  container: ParentNode | null | undefined,
  clips: readonly GuardedClip[],
  options: { readStyle?: StyleReader; warn?: (message: string) => void } = {},
): string[] {
  if (!container?.querySelector) return [];
  const warn = options.warn ?? ((m: string) => console.warn(m));
  const degraded: string[] = [];
  const checked = new Set<string>();
  for (const clip of clips) {
    if (!clip?.cardId || checked.has(clip.cardId) || !needsGuard(clip.cardId)) continue;
    checked.add(clip.cardId);
    const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(clip.id) : clip.id;
    const el = container.querySelector(`[data-pc-clip="${escaped}"]`);
    if (!el) continue; // 还没挂上,下次换片段时再量
    SCANNED.add(clip.cardId);
    if (!usesBackdropFilter(el, options.readStyle)) continue;
    if (degradeCard(clip.cardId, "backdrop-filter")) {
      warn(`[卡片能力] "${clip.cardId}" 在审阅表里是 independent，但画面上量到 backdrop-filter。` +
        `本次会话按 belowDependent 处理（不进独立缓存）。请修审阅表 src/cards/capabilities.json 或改卡片源码。`);
      degraded.push(clip.cardId);
    }
  }
  return degraded;
}

/** 导出 / 预渲染 / 生成快照那条路不跑：那里每一帧都算钱，而且画面已经定死了 */
export function shouldGuard(): boolean {
  try {
    if (typeof document === "undefined") return false;
    // 导出页和预渲染舞台都带 ?export=1 / ?frames=…；开发态之外也不跑
    const search = document.defaultView?.location?.search ?? "";
    if (/[?&](export|frames|bake)=/.test(search)) return false;
    return import.meta.env?.DEV === true;
  } catch {
    return false;
  }
}

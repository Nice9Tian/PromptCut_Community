/**
 * 舞台四种平面的样式表(E7)。
 *
 * 机制照 `solidMode.ts` 的实体模式:**组件永远挂着,包裹层加一个类、样式表藏掉子树,
 * 要显示的东西是包裹层里的兄弟平面** —— 不改 key、不换子节点类型,React 不会卸载重挂,
 * `pinAnimations` 的锚点不丢(锚点一丢,用户看到的是「每次暂停,字都重新飞进来一次」)。
 *
 * 四个类:
 *
 *   `.pc-snapshot`   贴着 HTML 快照(C3 / C4):子树 `display:none`,放过三种平面;
 *   `.pc-suppressed` 播放中的重卡(E7 第 5 条):同样 `display:none`,放过三种平面 ——
 *                    有流贴流、缺流贴最近快照、都没有就透明;
 *   `.pc-awaiting`   这一帧的快照还没到(E0 的 `setTime({ awaiting })`):`visibility:hidden`,
 *                    500 ms 兜底之后由 `StageView` 摘掉改露活组件 —— **宁可露初始态也不能永久隐身**
 *                    (`visibility:hidden` 会让 `solid.ts` 的 `isSolid` 判它不是实体,`hitTest` 点不中);
 *   `.pc-settling`   正在用子树虚拟时间追帧(K5 第一路):也是 `visibility:hidden`。
 *                    **不能用 `display:none`** —— 子树没有布局盒的话 `layoutId` 那类量布局的全错、
 *                    CSS 动画被取消成 `idle`、`pinAnimations` 直接跳过,`syncIn` 一步都钉不上。
 *
 * 三个 `display:none` 类同时存在时是三条规则**求并集**(不是 CSS 优先级,别想着用 `display:block` 覆盖);
 * 后两个是 `visibility`,和前三条不冲突、同样求并集。`.pc-settling` 与 `.pc-snapshot`、
 * 与 `.pc-suppressed` 都是互斥的,互斥由 `Stage` / `StageView` 保证,不靠 CSS。
 *
 * 导出页不传这几个 prop,这张表一个字都不会注入 —— 逐像素基线不受影响。
 */

import { PLACEHOLDER_ATTR } from "./placeholder/contract.ts";
import { PLACEHOLDER_SLOT_ATTR } from "./placeholderHost.ts";

/**
 * 平面都要放过:代理色块、快照平面、流平面,以及占位平面(槽位和组件根元素;product/rendering.md「兜底顺序」)——
 * 占位符正是在子树被藏起来(抑制 / 等快照 / 追帧)的时候才显示的,被这几条规则一起藏掉就白挂了。
 */
const PLANES = `:not([data-pc-snapshot-plane]):not([data-pc-proxy-plane]):not([data-pc-stream-plane]):not([${PLACEHOLDER_SLOT_ATTR}]):not([${PLACEHOLDER_ATTR}])`;

export const PLANE_CSS = [
  `.pc-snapshot > *${PLANES} { display: none !important; }`,
  `.pc-suppressed > *${PLANES} { display: none !important; }`,
  `.pc-awaiting > *${PLANES} { visibility: hidden !important; }`,
  `.pc-settling > *${PLANES} { visibility: hidden !important; }`,
].join("\n");

let injected = false;

/** 注入一次。只有真的用上这几个 prop 的宿主(舞台页)才会调它 */
export function ensurePlaneStyle(): void {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.dataset.pcPlanes = "1";
  s.textContent = PLANE_CSS;
  document.head.appendChild(s);
}

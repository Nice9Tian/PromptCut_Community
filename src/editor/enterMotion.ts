/**
 * 界面入场动效:给元素挂一个 CSS 类放一次 animation,放完(或被 display:none 打断)就摘掉。
 *
 * 为什么不把 animation 直接写在元素的常驻类上:分区、分页、面板、组总览都是常驻挂载、靠 display 显隐的,
 * 而 CSS 动画在元素(或它的祖先)从 display:none 变回可见时会从头重放 —— 那样每次展开抽屉、切回分页,
 * 里面所有带动画的东西都会一起再演一遍,还会和外层的动画叠在一起。
 * 所以只在「真的刚出现」那一刻由代码挂类,演完就摘,之后怎么显隐都不会重放。
 *
 * 动画本身写在 css 里(通用的几种在 skins/motion.css),并且只写在
 * `@media (prefers-reduced-motion: no-preference)` 里:系统要求减少动效时,类挂上去没有任何效果,
 * 兜底定时器到点把它摘掉。
 */

const pending = new WeakMap<Element, () => void>();

export function playEnter(el: Element | null | undefined, cls: string, maxMs = 700): void {
  if (!el) return;
  // 上一次还没演完又要演:先把上一次的收尾做掉,免得两份监听器互相摘类
  pending.get(el)?.();
  let timer = 0;
  const done = (e?: Event) => {
    // 子元素自己的动画结束也会冒泡上来,不算
    if (e && e.target !== el) return;
    el.classList.remove(cls);
    el.removeEventListener("animationend", done);
    el.removeEventListener("animationcancel", done);
    window.clearTimeout(timer);
    pending.delete(el);
  };
  el.addEventListener("animationend", done);
  el.addEventListener("animationcancel", done);
  timer = window.setTimeout(done, maxMs);
  pending.set(el, done);
  el.classList.add(cls);
}

/** 系统设置了「减少动效」。只给没法写进 css 媒体查询的地方用(比如要不要留一行淡出中的幽灵行) */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

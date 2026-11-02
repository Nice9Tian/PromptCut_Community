/**
 * UI entrance motion graphics: attach a CSS class to an element to play an animation once, and remove it when
 * done (or when interrupted by display:none).
 *
 * Why not write the animation directly on the element's permanent class: sections, tabs, panels and the group
 * overview are all permanently mounted and shown or hidden via display,
 * while a CSS animation replays from the start when the element (or an ancestor) goes from display:none back
 * to visible. Then every time a drawer expands or a tab is switched back,
 * everything inside that has an animation would play again together, and would also stack with the outer
 * animation.
 * So the class is attached by code only at the moment of "really just appeared" and removed after it plays,
 * and it never replays however it is shown or hidden afterwards.
 *
 * The animation itself is written in css (the common ones are in skins/motion.css), and only inside
 * `@media (prefers-reduced-motion: no-preference)`: when the system asks for reduced motion, attaching the
 * class has no effect,
 * and the fallback timer removes it when it fires.
 */

const pending = new WeakMap<Element, () => void>();

export function playEnter(el: Element | null | undefined, cls: string, maxMs = 700): void {
  if (!el) return;
  // The previous run has not finished and another is requested: finish the previous one's cleanup first, so two listeners do not remove each other's class
  pending.get(el)?.();
  let timer = 0;
  const done = (e?: Event) => {
    // Animation end events of child elements bubble up too; they do not count
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

/** The system has "reduce motion" set. Only for places that cannot be written into a css media query (e.g. whether to keep a fading-out ghost row) */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

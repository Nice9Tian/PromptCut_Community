/**
 * Runtime fallback (last sentence of A0.2).
 *
 * The review table (src/cards/capabilities.json) says a card is `independent`, meaning "draws only
 * itself": its prerender output can be stored independently and shared to the cloud. If this card
 * actually has `backdrop-filter`, that dead asset is wrong: it blurred in the visuals behind it
 * at the time, and will not match if the lower layer changes.
 *
 * Here, computed style is measured once after mounting; if detected, a warning is raised and the
 * card is recorded into the downgrade table (`degradeCard` in frameMode.mjs), treated as
 * `belowDependent` within this session. Additions only, no removals, fed to identity digest just
 * like the review table.
 *
 * Why only check `backdrop-filter`: pixel-reading APIs (getImageData / drawImage on other layers)
 * cannot be measured from the DOM and can only be blocked by source reviews and checkCardSource.
 * What is done here is the cheaper half.
 *
 * Overhead: runs only once in development mode (`shouldGuard`), with not a single line executed
 * on the export / generate snapshots path.
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

/** Whether there is an active backdrop-filter in the subtree (including -webkit- prefix) */
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

/** Only cards marked independent in review table need checking: others are treated as dependent anyway, whether measured or not */
export function needsGuard(cardId: string | undefined): boolean {
  if (!cardId || SCANNED.has(cardId)) return false;
  return reviewedCard(cardId)?.compositing === "independent";
}

export interface GuardedClip { id: string; cardId: string }

/** Each card is measured once per lifetime: measuring computed style forces reflow, cannot repeat on every clip change. */
const SCANNED = new Set<string>();
export function resetGuardScans() { SCANNED.clear(); }

/**
 * Scans outer card wrappers on the stage (`[data-pc-clip]`) and downgrades cards that "claim to be
 * independent but actually have frosted glass".
 * Returns IDs of cards newly downgraded this time; cards already downgraded will not alert repeatedly.
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
    if (!el) continue; // Not yet mounted; measure next time clips change
    SCANNED.add(clip.cardId);
    if (!usesBackdropFilter(el, options.readStyle)) continue;
    if (degradeCard(clip.cardId, "backdrop-filter")) {
      warn(`[card capability] "${clip.cardId}" is independent in the review table, but backdrop-filter was measured on screen.` +
        ` This session treats it as belowDependent (not put into the independent cache). Fix the review table src/cards/capabilities.json or change the card source.`);
      degraded.push(clip.cardId);
    }
  }
  return degraded;
}

/** Not run on export / prerender / generate snapshots path: every frame costs money there, and visuals are already fixed */
export function shouldGuard(): boolean {
  try {
    if (typeof document === "undefined") return false;
    // Both export page and prerender stage carry ?export=1 / ?frames=…; also does not run outside development mode
    const search = document.defaultView?.location?.search ?? "";
    if (/[?&](export|frames|bake)=/.test(search)) return false;
    return import.meta.env?.DEV === true;
  } catch {
    return false;
  }
}

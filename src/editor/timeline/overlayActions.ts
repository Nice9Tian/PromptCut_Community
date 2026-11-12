/**
 * Act on an overlay card: disable / enable, remove.
 *
 * The desktop timeline menu and the mobile app "Adjust" form both use this one piece of code: if each
 * side wrote it separately, a detail like "on enable, drop `off` entirely instead of writing `off: false`"
 * would inevitably be missed on one side, and the consequence of missing it is that a project that never
 * had anything disabled shows a spurious change in sync.
 *
 * **Disable** is not offered for media effect cards: bypassing a node has to be done on the graph, which
 * this version does not do (`canToggle` is false in the manifest).
 * **Remove** is offered: it goes through `detachCardNode` in `kernel/cardAuthoring.mjs`, which takes this
 * one node off the chain and connects the downstream to its upstream, rather than setting a field to empty.
 */
import type { Project, TrackClip } from "../../kernel/project";
import { detachCardNode } from "../../kernel/cardAuthoring.mjs";
import type { OverlayItem } from "./overlays";

/** Only these actions are used; unit tests supply fakes */
export interface OverlayStore {
  setClipFilter(clipId: string, filter: { id: string } | null): boolean;
  setClipPixelMap(clipId: string, pixelMap: { id: string } | null): boolean;
  setClipAudioFx(clipId: string, fx: { id: string } | null): boolean;
  /** A media effect card needs its node graph rewired, replaced as a whole (the store's `editCardProject`) */
  editCardProject?(edit: (project: Project) => Project): void;
}

/**
 * Disable / enable this card. The mount and the parameters on this clip are kept, only `off` is flipped.
 *
 * **On enable, drop `off` entirely**, do not write `off: false`: a project that never had anything
 * disabled stays byte-for-byte unchanged, and collaboration sync and conflict merging will not show a
 * spurious change of "off went from absent to false".
 */
export function setOverlayOff(store: OverlayStore, clip: TrackClip, item: OverlayItem, off: boolean): boolean {
  if (!item.canToggle) return false;
  // Enable: delete the key entirely, rather than leaving an `off: undefined` behind: if left, the key is still
  // on the object, and the document service's field-by-field comparison would see it
  const flip = <T extends { off?: boolean }>(cur: T) => {
    if (off) return { ...cur, off: true };
    const { off: _dropped, ...rest } = cur;
    return rest;
  };
  if (item.kind === "filter" && clip.filter) return store.setClipFilter(clip.id, flip(clip.filter));
  if (item.kind === "pixelMap" && clip.pixelMap) return store.setClipPixelMap(clip.id, flip(clip.pixelMap));
  if (item.kind === "audioFx" && clip.audioFx) return store.setClipAudioFx(clip.id, flip(clip.audioFx));
  return false;
}

/**
 * Remove this card. For the first three kinds, the field on the clip is set to empty, the definition in the
 * library is untouched, and other clips that mount it keep working as usual;
 * media effect cards go through `detachCardNode` to rewire the node graph.
 *
 * When it cannot be reconnected (transition A/B, a card with no input), `detachCardNode` throws an error
 * stating the reason, which is passed up as is:
 * the caller shows that sentence to the user, so do not swallow it here.
 */
export function detachOverlay(
  store: OverlayStore,
  clip: TrackClip,
  item: OverlayItem,
  getCard?: (id: string) => unknown,
): boolean {
  if (!item.canDetach) return false;
  if (item.kind === "filter") return store.setClipFilter(clip.id, null);
  if (item.kind === "pixelMap") return store.setClipPixelMap(clip.id, null);
  if (item.kind === "audioFx") return store.setClipAudioFx(clip.id, null);
  if (item.kind === "card" && store.editCardProject) {
    store.editCardProject((project) => detachCardNode(project, clip.id, getCard, item.upstream ? item.refId : undefined).project);
    return true;
  }
  return false;
}

/** How to write the quote block for this one: `@overlay card name(clip id#kind:definition id)` */
export function overlayQuoteId(clip: TrackClip, item: OverlayItem): string {
  return `${clip.id}#${item.kind}:${item.refId}`;
}

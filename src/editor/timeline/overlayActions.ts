/**
 * 对一张叠加卡动手:停用 / 启用、摘掉。
 *
 * 桌面的时间轴菜单和手机版「调整」表单都用这一份 —— 两边各写一遍的话,
 * 「启用时把 `off` 整个去掉而不是写 `off: false`」这种细节必然有一边漏掉,
 * 而漏掉的后果是没动过停用的项目在同步里多出一条假改动。
 *
 * 素材效果卡的**停用**不给:绕过一个节点要在图上改,这一版不做(清单里 `canToggle` 为假)。
 * **摘掉**给:它走 `kernel/cardAuthoring.mjs` 的 `detachCardNode` —— 把这一个节点从链上取下来、
 * 下游接到它的上游,而不是把一个字段置空。
 */
import type { Project, TrackClip } from "../../kernel/project";
import { detachCardNode } from "../../kernel/cardAuthoring.mjs";
import type { OverlayItem } from "./overlays";

/** 只用到这几个 action;单测给假的 */
export interface OverlayStore {
  setClipFilter(clipId: string, filter: { id: string } | null): boolean;
  setClipPixelMap(clipId: string, pixelMap: { id: string } | null): boolean;
  setClipAudioFx(clipId: string, fx: { id: string } | null): boolean;
  /** 素材效果卡要重接节点图,整份换一次(store 的 `editCardProject`) */
  editCardProject?(edit: (project: Project) => Project): void;
}

/**
 * 停用 / 启用这一张。挂载和这一段上的参数都留着,只翻 `off`。
 *
 * **启用时把 `off` 整个去掉**,不写 `off: false`:没动过停用的项目逐字节不变,
 * 协作同步和冲突合并里也不会多出一条「off 从没有变成 false」的假改动。
 */
export function setOverlayOff(store: OverlayStore, clip: TrackClip, item: OverlayItem, off: boolean): boolean {
  if (!item.canToggle) return false;
  // 启用:把键整个删掉,不是留一个 `off: undefined` —— 留着的话那个键还在对象上,
  // 文档服务的逐字段比对会看见它
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
 * 摘掉这一张。前三样把片段上那个字段置空,库里的定义不动、挂着它的别的片段照常生效;
 * 素材效果卡走 `detachCardNode` 重接节点图。
 *
 * 接不回去时(转场的 A/B、无输入的卡)`detachCardNode` 会抛出写明原因的错,原样往上传 ——
 * 调用方拿那句话给用户看,别在这儿吞掉。
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
    store.editCardProject((project) => detachCardNode(project, clip.id, getCard).project);
    return true;
  }
  return false;
}

/** 这一张的引用块怎么写:`@叠加卡 名字(片段id#种类:定义id)` */
export function overlayQuoteId(clip: TrackClip, item: OverlayItem): string {
  return `${clip.id}#${item.kind}:${item.refId}`;
}

import type { Project } from './project';
export function applyCardDefinition(project: Project, args: any, getCard?: (id: string) => any): { project: Project; clipId: string; nodeId: string };
export function cloneCardClipInstance(project: Project, oldClipId: string, newClipId: string, nodeId?: string, timeOffset?: number): { project: Project; nodeId?: string };

/**
 * 把片段上那张素材效果卡摘掉:这一个节点从链上取下来,下游接到它的上游。
 * 没有 `source` 那一路的卡(转场的 A/B、无输入的卡)摘不了,抛出写明原因的错。
 */
export function detachCardNode(
  project: Project,
  clipId: string,
  getCard?: (id: string) => unknown,
): { project: Project; nodeId: string; nextNodeId: string | null; removed: boolean };

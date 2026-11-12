import type { Project } from './project';
export function applyCardDefinition(project: Project, args: any, getCard?: (id: string) => any): { project: Project; clipId: string; nodeId: string };
export function cloneCardClipInstance(project: Project, oldClipId: string, newClipId: string, nodeId?: string, timeOffset?: number): { project: Project; nodeId?: string };

/**
 * Detach the media effect card on the clip: remove this node from the chain and connect downstream
 * to its upstream.
 * Cards without a `source` path (A/B of transitions, cards without inputs) cannot be detached;
 * throws an error stating the reason.
 */
export function detachCardNode(
  project: Project,
  clipId: string,
  getCard?: (id: string) => unknown,
  targetNodeId?: string,
): { project: Project; nodeId: string; nextNodeId: string | null; removed: boolean };

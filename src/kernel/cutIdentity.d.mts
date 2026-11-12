export interface ReachableCutContent {
  id: string;
  tracks: unknown[];
  duration: number | undefined;
  transitions: unknown[];
  kind?: "3d";
  camera3dFov?: number;
  spaceWidth?: number;
  spaceHeight?: number;
  cameras?: unknown[];
}
export function activeCutRenderMeta(project: unknown): Record<string, unknown> | null;
export function reachableCutContents(project: unknown, tracks?: unknown[]): ReachableCutContent[];
export function reachableMediaIds(project: unknown, tracks?: unknown[]): Set<string>;

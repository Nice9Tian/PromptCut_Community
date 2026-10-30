export interface ReachableCutContent { id: string; tracks: unknown[]; duration: number | undefined; transitions: unknown[] }
export function reachableCutContents(project: unknown, tracks?: unknown[]): ReachableCutContent[];
export function reachableMediaIds(project: unknown, tracks?: unknown[]): Set<string>;

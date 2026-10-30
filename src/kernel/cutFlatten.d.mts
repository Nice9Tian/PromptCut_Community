export const FLAT_SEP: string;
export function isFlatClipId(id: unknown): boolean;
export interface FlatChainLink { id: string; cutId: string; start: number; end: number; cutOffset: number }
export interface FlatInfo { lead: number; chain: FlatChainLink[]; mount: number }
export function hasFlatSegments(project: unknown): boolean;
export function flatPlanProject<P>(project: P): P;
export function flatInfoOf(clip: unknown): FlatInfo | undefined;
export function flatClipOf(project: unknown, clipId: string): { track: any; clip: any } | null;
export function withFlatNodes<G>(flatProject: unknown, graph: G): G;
export function isolatedFlatProject(project: unknown, clipId: string, localize?: (clip: any) => any): any;

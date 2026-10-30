/** `agentScopes.mjs` 的类型(页面与服务端共用的范围口径) */
export function cutNameOf(project: unknown): string;
export function diffScopes(before: unknown, after: unknown): string[];
export function splitScopes(text: unknown): string[];
export function scopeOverlaps(a: string, b: string): boolean;
export function overlappingScopes(written: string[] | string, declared: string): string[];

export const CUTS_INDEX_LIMITS: Readonly<{ maxClips: number; perCutMax: number; labelMax: number }>;
export const PARKED_EDIT_NOTE: string;
export interface ParkedCutsIndexOptions {
  maxClips?: number;
  perCutMax?: number;
  labelMax?: number;
  cardName?: (cardId: string) => string | undefined;
}
export interface ParkedCutsIndex {
  activeCutId: string;
  note: string;
  cuts: {
    cutId: string; name: string; duration: number; trackCount: number; clipCount: number;
    clips: Record<string, unknown>[]; omitted?: number; more?: string;
  }[];
}
export function parkedCutsIndex(project: unknown, opts?: ParkedCutsIndexOptions): ParkedCutsIndex | null;
export function otherCutsHint(project: unknown): { cuts: { cutId: string; name: string; clipCount: number }[]; hint: string } | null;
/** see_frames 的 cutId:那条剪辑当激活的项目视图,只在出这一次图时用 */
export function cutLookView<P>(project: P, cutId: string | undefined | null): {
  project: P; cut: { id: string; name: string }; active: boolean; parkedT: number | null;
};

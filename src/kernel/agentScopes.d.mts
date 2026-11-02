/** Types for `agentScopes.mjs` (scope definition shared between page and server) */
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
/** cutId for see_frames: that cut serves as the active project view, used only for this render */
export function cutLookView<P>(project: P, cutId: string | undefined | null): {
  project: P; cut: { id: string; name: string }; active: boolean; parkedT: number | null;
};

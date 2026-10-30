export declare const ATLAS_MAX: number;
export declare const ATLAS_MAX_COMPACT: number;

export interface AtlasItem { id: string; x: number; y: number; w: number; h: number; clamped: boolean }
export interface AtlasPage { w: number; h: number; items: AtlasItem[] }

export declare function packAtlas(cards: ReadonlyArray<{ id: string; w: number; h: number }>, maxSize?: number): { pages: AtlasPage[] };
export declare function layoutKeyOf(cards: ReadonlyArray<{ id: string; w: number; h: number }>): string;

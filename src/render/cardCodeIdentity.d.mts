export declare const CARD_CODE_ROOTS: readonly string[];
export declare const CARD_CODE_CLOSURE_LIMIT: number;
export declare const CARD_CODE_ID_HEX: number;
export interface CardCodeIo {
  read: (rel: string) => string | null;
  isFile: (rel: string) => boolean;
}
export declare function isCardCodePath(rel: unknown): boolean;
export declare function localImportCandidates(rel: string, source: string): string[][];
export declare function localImportsOf(rel: string, io: CardCodeIo): string[];
export declare function importClosureOf(entry: string, io: CardCodeIo, limit?: number): string[];
export declare function cardCodePreimage(files: readonly string[], hashOf: (rel: string) => string | null): string;

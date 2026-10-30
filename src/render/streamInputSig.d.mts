export declare const STREAM_INPUT_SIG_VERSION: number;
export declare function streamInputs(project: unknown, stream: { clipIds: readonly string[]; kind?: string }): Record<string, unknown> | null;
export declare function streamInputSig(project: unknown, stream: { clipIds: readonly string[]; kind?: string }): string | null;
export declare function streamSigStale(rowSig: unknown, pageSig: unknown): boolean;

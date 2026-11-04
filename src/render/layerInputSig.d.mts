/** Input signature of a layer table entry (see header of `layerInputSig.mjs`) */
export const LAYER_INPUT_SIG_VERSION: number;
/** Signature input for this clip (the object before hashing); returns null if clip not in project */
export function clipInputs(project: unknown, clipId: string): Record<string, unknown> | null;
/** Input signature of clip; returns null if clip is not in project or input cannot be serialized */
export function clipInputSig(project: unknown, clipId: string): string | null;
/** Present on both sides, same algorithm version, and different → expired */
export function inputSigStale(layerSig: unknown, pageSig: unknown): boolean;
/** `clipInputSig` cached by project object reference */
export function cachedClipInputSig(project: unknown, clipId: string): string | null;

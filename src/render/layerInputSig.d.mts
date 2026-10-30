/** 层表条目的输入签名(见 `layerInputSig.mjs` 文件头) */
export const LAYER_INPUT_SIG_VERSION: number;
/** 这个片段的签名输入(还没哈希的那份对象);片段不在项目里回 null */
export function clipInputs(project: unknown, clipId: string): Record<string, unknown> | null;
/** 片段的输入签名;片段不在项目里、或输入序列化不了回 null */
export function clipInputSig(project: unknown, clipId: string): string | null;
/** 两边都有、同一算法版本、而且不同 → 过期 */
export function inputSigStale(layerSig: unknown, pageSig: unknown): boolean;
/** 按项目对象引用缓存的 `clipInputSig` */
export function cachedClipInputSig(project: unknown, clipId: string): string | null;

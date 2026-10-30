/**
 * 导出时因素材缺失被跳过的片段怎么告诉用户(`server/vite-plugin-export.ts` 的 `dropSkippedMediaClips`:
 * 没有哈希、地址为空 —— 打开项目后本机取不到文件、已标「(缺失)」的老素材 —— 所在的片段不进这次导出)。
 * 不静默:导出完成的对话框里列出这些素材(写法同打包保存的 `packMissingMessage`)。本模块不引别的模块,Node 单测直接 import。
 */

export interface ExportSkipped {
  id: string;
  name: string;
  /** 这条素材在这次导出里被去掉的片段数 */
  clips?: number;
}

const MISSING_PREFIX = "(缺失) ";

/** 回包里的 `skippedMedia` 整理成数组;不合格的条目丢掉 */
export function parseExportSkipped(raw: unknown): ExportSkipped[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({ id: String(x.id ?? ""), name: String(x.name ?? ""), ...(typeof x.clips === "number" ? { clips: x.clips } : {}) }))
    .filter((x) => x.id || x.name);
}

/** 导出完成时给用户的那句话:哪些素材因缺失被跳过(名字去重、去掉「(缺失) 」标记,太多时只列前面若干条);没有就回空串 */
export function exportSkippedMessage(skipped: readonly ExportSkipped[], limit = 12): string {
  const names = [...new Set(skipped.map((m) => (m.name || m.id).replace(/^\(缺失\) /, "")))];
  if (!names.length) return "";
  const shown = names.slice(0, limit).map((n) => `· ${n}`).join("\n");
  const more = names.length > limit ? `\n……另有 ${names.length - limit} 条` : "";
  return `下面 ${names.length} 条素材本机找不到文件（素材库里标着「${MISSING_PREFIX.trim()}」），导出时跳过了它们所在的片段，其余画面与声音照常：\n${shown}${more}`;
}

/**
 * 往用户挑的落点写文件,写失败不覆盖上次有效保存(`docs/semantics/mechanism/document-service.md`「保存基准与修改状态检查」:
 * 「失败不覆盖上次有效保存」)。
 *
 * 靠的是文件系统访问 API 的规矩:`createWritable()` 的流写进一份临时副本(Chrome 里是同目录的 `<名>.crswap`),
 * `close()` 时才用它替换原文件;没 close 之前原文件一个字节都不动。真浏览器里核对过(探针
 * `scripts/probes/save-state-probe.mjs --phases fail` 的 `browser.swap-file-semantics`):写到一半、不 close 也不 abort,
 * 原文件照样不变 —— 但那份临时副本会**留在用户的目录里**(探针里看得到 `.crswap`),而且出错的说法是浏览器的原话。
 * 所以这里显式收尾:出错就 `abort()` 丢掉临时副本,再抛一句说清「原来的文件没有改动」的话。
 *
 * 这个文件不引用别的模块:`proc.ts` 与 `saveFlow.ts` 都用它。
 */

/** 写盘那一步出错时的说法:原来的文件没动 */
export function writeFailedText(reason: string): string {
  return `写文件时出错：${reason}\n原来的文件没有改动（上一次保存的内容还在），可以继续编辑后再保存。`;
}

/** 写盘那一步出错(原文件没动) */
export class SaveWriteError extends Error {
  constructor(cause: unknown) {
    super(writeFailedText(String((cause as Error)?.message ?? cause)));
    this.name = "SaveWriteError";
  }
}

/**
 * 整份写进 `handle`:写临时副本 → close 替换原文件。任一步出错:abort 丢掉临时副本(原文件不变),抛 `SaveWriteError`。
 * 内容要事先备齐再调它 —— 打开写入流之后不再做任何可能失败的准备工作。
 */
export async function writeToHandle(handle: FileSystemFileHandle, data: string | Blob): Promise<void> {
  let writable: FileSystemWritableFileStream;
  try {
    writable = await handle.createWritable();
  } catch (e) {
    throw new SaveWriteError(e);
  }
  try {
    await writable.write(data);
    await writable.close();
  } catch (e) {
    // 已经出错的流 abort 也可能抛;不管它,原文件反正没被替换
    try { await writable.abort(); } catch { /* 同上 */ }
    throw new SaveWriteError(e);
  }
}

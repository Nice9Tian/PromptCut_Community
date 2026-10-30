/** 纯 Node 原子文件写入；frame-mov 保持原导出。 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** Write through a temp file and rename it into place. The editor server and
 * the prerender worker share these files; Windows refuses to replace a file
 * the other process has open for a moment (EPERM/EBUSY/EACCES), so retry. */
export async function atomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(temp, data);
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(temp, file); return; }
    catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) {
        await fs.rm(temp, { force: true }).catch(() => {});
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

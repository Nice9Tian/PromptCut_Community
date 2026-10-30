/**
 * 在线页面的本地备份(C10 契约第 10 节、第 18 节第 4 条)。
 *
 * 桌面把被覆盖的实体、被丢弃的离线批次写进草稿目录的 `backups/`(经编辑器进程的 `/api/project-backups`)。
 * 在线页面没有本机磁盘,而且语义要求浏览器本地只放能重新拉回的缓存(`product/platforms.md`「在线浏览器模式」),
 * 备份拉不回来,所以:
 *
 * - **不写进任何浏览器存储**(本地存储、会话存储、索引数据库都不碰),只留在本页内存里,关页面即丢;
 * - **不自动下载**:「丢弃」确认后、被覆盖时,由界面当场给「下载备份」按钮,用户点了才下载;
 * - 本页内存里的全部备份在同步面板里列出,可逐个下载(`list()` + `download(i)`)。
 *
 * 下载出来的是一个 JSON 文件,内容就是 `src/store/docsync.ts` 的 `LocalBackup`,外加项目名与导出时刻。
 * 本模块在 Node 单测里也能载入:不在顶层碰 `window` / `document`,下载函数可以注入。
 */
import type { LocalBackup } from "../../store/docsync";

export interface OnlineBackupItem {
  /** 本页里的序号(从 0 起,和 `list()` 的下标一致) */
  index: number;
  backup: LocalBackup;
  /** 存下时的项目名(下载的文件名、面板里显示用) */
  projectName: string;
  /** 下载时的文件名 */
  filename: string;
}

export interface OnlineBackupsOptions {
  /** 把一段文本存成文件给用户。不给就用浏览器的 `<a download>` */
  download?: (filename: string, text: string) => void;
  /** 取当前项目名(存备份时记下) */
  projectName?: () => string;
}

export interface OnlineBackups {
  /** 存一份(只进内存),回它在列表里的序号 */
  save(backup: LocalBackup): number;
  list(): readonly OnlineBackupItem[];
  /** 下载第 i 份;没有这一份回 false */
  download(index: number): boolean;
  /** 列表变了就回调;回退订函数 */
  subscribe(cb: () => void): () => void;
  /** 测试用:清空 */
  clear(): void;
}

/** 文件名里不能有的字符换掉 */
function safeName(s: string): string {
  return (s || "未命名项目").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").slice(0, 60);
}

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function backupFilename(backup: LocalBackup, projectName: string, index: number): string {
  const what = backup.kind === "overwritten" ? "被覆盖" : "离线丢弃";
  return `${safeName(projectName)}-备份-${what}-${stamp(backup.at)}-${index + 1}.json`;
}

/** 浏览器里的缺省下载:Blob + `<a download>` + click,随后释放地址 */
export function browserDownload(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body?.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function createOnlineBackups(opts: OnlineBackupsOptions = {}): OnlineBackups {
  const items: OnlineBackupItem[] = [];
  const listeners = new Set<() => void>();
  const changed = () => { for (const l of listeners) l(); };
  const download = opts.download ?? browserDownload;
  return {
    save(backup) {
      const index = items.length;
      const projectName = opts.projectName?.() ?? "";
      items.push({ index, backup, projectName, filename: backupFilename(backup, projectName, index) });
      changed();
      return index;
    },
    list() {
      return items;
    },
    download(index) {
      const item = items[index];
      if (!item) return false;
      const body = { app: "PromptCut", kind: "local-backup", projectName: item.projectName, savedAt: item.backup.at, backup: item.backup };
      download(item.filename, JSON.stringify(body, null, 2));
      return true;
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    clear() {
      items.length = 0;
      changed();
    },
  };
}

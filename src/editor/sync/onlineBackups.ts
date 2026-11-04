/**
 * Local backups for the online page (C10 contract section 10, section 18 item 4).
 *
 * The desktop app writes overwritten entities and discarded offline batches into `backups/` in the draft
 * directory (via the editor process's `/api/project-backups`).
 * The online page has no local disk, and the semantics require browser-local storage to hold only caches
 * that can be pulled back again (`product/platforms.md`, "Online browser mode"). Backups cannot be pulled
 * back, so:
 *
 * - **Nothing is written to any browser storage** (local storage, session storage and IndexedDB are all
 *   untouched); backups stay only in this page's memory and are lost when the page closes;
 * - **No automatic download**: after "Discard" is confirmed, or when something is overwritten, the UI shows
 *   a "Download backup" button on the spot, and the download happens only when the user clicks it;
 * - All backups in this page's memory are listed in the sync panel and can be downloaded one by one
 *   (`list()` + `download(i)`).
 *
 * The downloaded file is a JSON file whose content is the `LocalBackup` from `src/store/docsync.ts`, plus
 * the project name and the export time.
 * This module can also be loaded in Node unit tests: it does not touch `window` / `document` at top level,
 * and the download function can be injected.
 */
import type { LocalBackup } from "../../store/docsync";
import { tr } from "../../i18n/index.ts";

export interface OnlineBackupItem {
  /** Index within this page (starting from 0, matching the index in `list()`) */
  index: number;
  backup: LocalBackup;
  /** Project name at save time (used for the downloaded file name and for display in the panel) */
  projectName: string;
  /** File name used for the download */
  filename: string;
}

export interface OnlineBackupsOptions {
  /** Save a piece of text as a file for the user. If omitted, the browser's `<a download>` is used */
  download?: (filename: string, text: string) => void;
  /** Get the current project name (recorded when saving a backup) */
  projectName?: () => string;
}

export interface OnlineBackups {
  /** Save one backup (in memory only) and return its index in the list */
  save(backup: LocalBackup): number;
  list(): readonly OnlineBackupItem[];
  /** Download backup number i; return false if there is no such backup */
  download(index: number): boolean;
  /** Call back when the list changes; returns an unsubscribe function */
  subscribe(cb: () => void): () => void;
  /** For tests: clear everything */
  clear(): void;
}

/** Replace characters that are not allowed in file names */
function safeName(s: string): string {
  return (s || tr("Untitled project")).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").slice(0, 60);
}

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function backupFilename(backup: LocalBackup, projectName: string, index: number): string {
  const what = backup.kind === "overwritten" ? tr("overwritten") : tr("discarded offline");
  return tr("{0}-backup-{1}-{2}-{3}.json", safeName(projectName), what, stamp(backup.at), index + 1);
}

/** Default download in the browser: Blob + `<a download>` + click, then release the URL */
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

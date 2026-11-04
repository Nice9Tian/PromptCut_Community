import { tr } from "../../i18n/index.ts";
/**
 * Write a file to the location the user picked; if the write fails, the last valid save is not
 * overwritten (`docs/semantics/mechanism/document-service.md`, "Save baseline and modified-state
 * check": "A failure does not overwrite the last valid save").
 *
 * It relies on the rules of the File System Access API: the stream from `createWritable()` writes
 * into a temporary copy (in Chrome, `<name>.crswap` in the same directory), and only at `close()` is
 * the original file replaced with it; until close, not a single byte of the original file changes.
 * Verified in a real browser (the `browser.swap-file-semantics` check of the probe
 * `scripts/probes/save-state-probe.mjs --phases fail`): when a write stops halfway with neither
 * close nor abort, the original file is still unchanged. But that temporary copy **stays in the
 * user's directory** (the `.crswap` is visible in the probe), and the error wording is the
 * browser's own.
 * So the cleanup here is explicit: on error, `abort()` discards the temporary copy, then throw a
 * message that makes clear "the original file was not modified".
 *
 * This file references no other module: both `proc.ts` and `saveFlow.ts` use it.
 */

/** Wording for an error at the disk-write step: the original file was not touched */
export function writeFailedText(reason: string): string {
  return tr("Error writing file: {0}\nThe original file was not changed (the content from the last save is still there), so you can keep editing and save again.", reason);
}

/** Error at the disk-write step (the original file was not touched) */
export class SaveWriteError extends Error {
  constructor(cause: unknown) {
    super(writeFailedText(String((cause as Error)?.message ?? cause)));
    this.name = "SaveWriteError";
  }
}

/**
 * Write the whole content into `handle`: write the temporary copy → close replaces the original
 * file. If any step fails: abort discards the temporary copy (the original file is unchanged) and
 * `SaveWriteError` is thrown.
 * Have the content fully prepared before calling it: after the write stream is opened, do no more
 * preparation that could fail.
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
    // abort on an already failed stream may also throw; ignore it, the original file was not replaced anyway
    try { await writable.abort(); } catch { /* Same as above */ }
    throw new SaveWriteError(e);
  }
}

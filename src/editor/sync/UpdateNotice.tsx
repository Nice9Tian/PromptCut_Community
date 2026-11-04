/**
 * Public-side pass-through seam of the online page version mismatch notice bar
 * (`src/editor/sync/UpdateNotice.tsx`).
 *
 * The full implementation has moved to `cloud/online/UpdateNotice.tsx`, registered into
 * `src/online/boot.ts` by `cloud/online/manifest.ts`;
 * in the community edition (no `cloud/` directory):
 *   - `mountUpdateNotice` is a no-op;
 *   - `UpdateNoticeView` / `UpdateNoticeSlot` return `null` (render nothing).
 */
import { createElement, useEffect, useState } from "react";
import {
  ensureOnlineExtensionsLoaded,
  getUpdateNotice,
  invokeMountUpdateNotice,
  startUpdateCheck,
  subscribeUpdateNotice,
  type UpdateCheckController,
} from "../../online/boot";

export function getUpdateCheckController(entryModuleUrl?: string | null): UpdateCheckController {
  // The field name is `entry` (entry file name relative to base), not `entryModuleUrl`: see the note in boot.ts
  return startUpdateCheck({ entry: entryModuleUrl ?? null });
}

export function UpdateNoticeView(_props?: { controller?: UpdateCheckController }) {
  const [ext, setExt] = useState(() => getUpdateNotice());

  useEffect(() => {
    void ensureOnlineExtensionsLoaded();
    setExt(getUpdateNotice());
    return subscribeUpdateNotice(() => setExt(getUpdateNotice()));
  }, []);

  if (!ext?.UpdateNoticeView) return null;
  return createElement(ext.UpdateNoticeView as any, _props as any);
}

export const UpdateNoticeSlot = UpdateNoticeView;

export function mountUpdateNotice(entryModuleUrl?: string | null): void {
  void ensureOnlineExtensionsLoaded();
  invokeMountUpdateNotice(entryModuleUrl);
}

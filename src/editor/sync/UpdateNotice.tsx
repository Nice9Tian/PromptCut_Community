/**
 * 在线页面版本失配提示条的公开侧贯穿型接缝（`src/editor/sync/UpdateNotice.tsx`）。
 *
 * 完整实现已迁至 `cloud/online/UpdateNotice.tsx`，由 `cloud/online/manifest.ts` 注册到 `src/online/boot.ts`；
 * 社区版（无 `cloud/` 目录）下：
 *   - `mountUpdateNotice` 为空操作；
 *   - `UpdateNoticeView` / `UpdateNoticeSlot` 返回 `null`（不渲染）。
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
  // 字段名是 `entry`（相对 base 的入口文件名），不是 `entryModuleUrl` —— 见 boot.ts 里那段说明
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

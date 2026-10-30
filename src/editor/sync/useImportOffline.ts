/**
 * 「导入媒体」断网置灰(在线浏览器;桌面版照常导入,连上后再上传)。素材库的导入按钮与手机版素材库面板共用。
 * 判据是纯函数 `onlineStatus.ts` 的 `importOfflineOf`。
 */
import { useSyncExternalStore } from "react";
import { ONLINE } from "../../online/mode";
import { importOfflineOf } from "./onlineStatus";
import { useSync } from "./syncManager";

function subscribeNavigator(cb: () => void): () => void {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); };
}

export function useImportOffline(): boolean {
  const status = useSync((v) => v.status);
  const active = useSync((v) => v.active);
  const navigatorOnline = useSyncExternalStore(subscribeNavigator, () => navigator.onLine, () => true);
  return importOfflineOf({ online: ONLINE, status, active, navigatorOnline });
}

export { IMPORT_OFFLINE_TEXT } from "./onlineStatus";

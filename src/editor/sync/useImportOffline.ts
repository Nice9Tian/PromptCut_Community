/**
 * "Import media" is greyed out when offline (online browser; the desktop app imports as usual and
 * uploads once connected). Shared by the import button of the media library and the mobile app's
 * media library panel.
 * The check is `importOfflineOf` in the pure-function module `onlineStatus.ts`.
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

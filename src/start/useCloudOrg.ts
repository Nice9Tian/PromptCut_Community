/**
 * 云端分组在 React 里的那一层:持有整理信息的 state、写本机缓存、驱动同步引擎(`orgSync.ts`)。
 *
 * - `scope` 是登录账号对应的范围(`cloudOrgScope`);游客、没登录传 null:读不到也存不了,不同步;
 * - `transport` 是 null 时(没登录)只当本机缓存用。**要传稳定的对象**(`useMemo`),换了对象就重建引擎;
 * - 打开、换账号、页面重新可见、网络恢复时跟云端对一次(`refresh`);用户每改一次整理信息调 `setOrg`,
 *   它先换界面、写本机缓存,再通知引擎防抖后传;
 * - `status` 给界面说话用(`pending` 时提示没同步上;`unsupported` 时「存在云端」改口成「只记在这台浏览器里」)。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createOrgSync, loadSyncMeta, saveSyncMeta, type OrgSync, type OrgTransport, type SyncStatus } from "./orgSync";
import { loadOrg, saveOrg, type OrgState } from "./vibeOrg";

export function useCloudOrg(args: { scope: string | null; transport: OrgTransport | null }) {
  const { scope, transport } = args;
  const [org, setOrgState] = useState<OrgState>(() => loadOrg("cloud", scope));
  const orgRef = useRef(org);
  const syncRef = useRef<OrgSync | null>(null);
  const [status, setStatus] = useState<SyncStatus>("idle");

  useEffect(() => {
    const loaded = loadOrg("cloud", scope);
    orgRef.current = loaded;
    setOrgState(loaded);
    setStatus("idle");
    if (!scope || !transport) { syncRef.current = null; return; }
    const sync = createOrgSync({
      transport,
      getOrg: () => orgRef.current,
      // 合并出来的新内容:换界面、写缓存;它不是用户的一次改动,不通知引擎
      applyOrg: (o) => { orgRef.current = o; setOrgState(o); saveOrg(scope, o); },
      loadMeta: () => loadSyncMeta(scope),
      saveMeta: (m) => saveSyncMeta(scope, m),
      onStatus: setStatus,
    });
    syncRef.current = sync;
    void sync.refresh();
    const onVisible = () => { if (document.visibilityState === "visible") void sync.refresh(); };
    const onOnline = () => { void sync.refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      sync.stop();
      syncRef.current = null;
    };
  }, [scope, transport]);

  /** 改整理信息。返回原对象表示什么都没变:不写、不通知 */
  const setOrg = useCallback((next: (o: OrgState) => OrgState) => {
    const prev = orgRef.current;
    const n = next(prev);
    if (n === prev) return;
    orgRef.current = n;
    setOrgState(n);
    saveOrg(scope, n);
    syncRef.current?.changed();
  }, [scope]);

  return { org, setOrg, status };
}

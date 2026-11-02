/**
 * The React layer for cloud groups: holds the state of the organization data, writes the local cache,
 * and drives the sync engine (`orgSync.ts`).
 *
 * - `scope` is the scope that corresponds to the logged-in account (`cloudOrgScope`); guests and users
 *   who are not logged in pass null: nothing can be read or saved, and there is no sync;
 * - when `transport` is null (not logged in) it serves only as a local cache. **Pass a stable object**
 *   (`useMemo`); a different object rebuilds the engine;
 * - on open, on account change, when the page becomes visible again and when the network recovers, it
 *   reconciles with the cloud once (`refresh`); each time the user changes the organization data they
 *   call `setOrg`, which first updates the UI and writes the local cache, then notifies the engine to
 *   send it after a debounce;
 * - `status` is for the UI to speak with (when `pending` it says the change has not been synced; when
 *   `unsupported` "Stored in the cloud" changes its wording to "Recorded only in this browser").
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
      // The merged new content: update the UI and write the cache; it is not a change made by the user, so the engine is not notified
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

  /** Change the organization data. Returning the original object means nothing changed: no write, no notification */
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

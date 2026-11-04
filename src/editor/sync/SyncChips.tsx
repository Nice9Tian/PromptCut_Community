/**
 * Sync widgets on the top bar:
 * - "Conflict merge": always shown while the pending merge items list still has items to handle; click it
 *   to open the conflict merge window (`ConflictMerge.tsx`; user decision, 2026-10-18);
 * - "Sync paused": appears only when the offline batch cannot work out a baseline item by item in the
 *   transform table and falls back to handling the whole copy (c65-design.md section 8); click it to
 *   reopen the offline dialog;
 * - "Offline": the prompt when the document service cannot be reached (edits continue as usual and pile
 *   up on this machine);
 * - Online page (C10 contract section 10): "Offline" is replaced by the five status wordings of table A
 *   (`onlineStatus.ts`), and there is also a "Backups" widget that lists the backups in this page's
 *   memory, downloadable one by one (sync panel);
 * - Shared project: the member button (MembersPanel).
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { setOfflineOpen, useSync } from "./syncManager";
import { MembersButton } from "./MembersPanel";
import { BackupsDialog } from "./BackupsDialog";
import { ONLINE } from "../../online/mode";
import { remoteAssetsDown, subscribeRemoteAssetsHealth } from "../media/assetTiers";
import { OFFLINE_SHOW_DELAY_MS, ONLINE_STATUS_TEXT, onlineStatusOf, type OnlineStatusKind } from "./onlineStatus";
import { RecoveryActions } from "./RecoveryActions";
import "./sync.css";
import { CLOUD_GONE_TEXT } from "./recoveryTexts";
import { ConflictMergeButton } from "./ConflictMerge";
import { tr } from "../../i18n/index.ts";

function subscribeNavigator(cb: () => void): () => void {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); };
}

/** Status wordings on the online page's top bar; offline ones must persist for `OFFLINE_SHOW_DELAY_MS` before showing (so HT-a session resumption and an immediate session rebuild do not flicker) */
function useOnlineStatus(): OnlineStatusKind | null {
  const status = useSync((v) => v.status);
  const recovery = useSync((v) => v.recovery);
  const navigatorOnline = useSyncExternalStore(subscribeNavigator, () => navigator.onLine, () => true);
  const assetDown = useSyncExternalStore(subscribeRemoteAssetsHealth, remoteAssetsDown, () => false);
  const want = onlineStatusOf({ status, navigatorOnline, assetDown, recovery });
  const offlineKind = want === "noNetwork" || want === "docDown" || want === "assetDown";
  const [shown, setShown] = useState<OnlineStatusKind | null>(null);
  useEffect(() => {
    if (!offlineKind) { setShown(want); return; }
    const t = setTimeout(() => setShown(want), OFFLINE_SHOW_DELAY_MS);
    return () => clearTimeout(t);
  }, [want, offlineKind]);
  // Offline kinds: switch only after the delay has passed (if it recovers within the delay, never shown at all); non-offline kinds (recovering / recovered / fine) switch immediately
  return shown;
}

function OnlineStatusChip() {
  const kind = useOnlineStatus();
  if (!kind) return null;
  const text = ONLINE_STATUS_TEXT[kind];
  const tone = kind === "recovering" || kind === "recovered" ? "pc-sync-chip--recover" : "pc-sync-chip--offline";
  return (
    <span className={`pc-sync-chip pc-sync-chip--online ${tone}`} data-pc="sync-online-status" data-kind={kind} title={text} role="status">
      <span className="pc-sync-chip-dot" />
      <span className="pc-sync-chip-text">{text}</span>
    </span>
  );
}

/** "Backups" in the sync panel: appears only when this page's memory has backups; click to list them and download one by one */
function OnlineBackupsChip() {
  const n = useSync((v) => v.onlineBackups);
  const [open, setOpen] = useState(false);
  if (!n) return null;
  return (
    <>
      <button type="button" className="pc-sync-chip pc-sync-chip--backups" data-pc="sync-backups" title={tr("Changes that were overwritten or discarded while offline are kept on this page for now; you can download them before closing the page")} onClick={() => setOpen(true)}>
        {tr("Backups {0}", n)}
      </button>
      <BackupsDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function SyncChips() {
  const reopenState = useSync((v) => v.reopenState);
  const status = useSync((v) => v.status);
  const active = useSync((v) => v.active);
  const blocked = useSync((v) => v.blocked);
  // "Conflict merge" at the top of the navigation bar: shown whenever items are still pending (also when offline or recovering; items can be deleted in the window and merged after reconnecting)
  const merge = <ConflictMergeButton />;
  if (reopenState && reopenState !== "connected") {
    const text: Record<string, string> = {
      recovering: tr("Restoring the original collaboration room…"), "waiting-host": tr("Waiting for the host to come online; will retry automatically."),
      "waiting-storage": tr("The local recovery info cannot be read for now; the original identity will be kept and it will retry automatically."),
      "needs-auth": tr("Please re-authenticate with the original identity; local project content has been kept."), rejected: tr("The original identity was rejected. Please contact the creator."),
      deleted: tr("The original room was deleted or collaboration was canceled."), damaged: tr("Collaboration recovery data is missing or damaged. Please restore from the original backup."),
      unsupported: tr("This project's collaboration recovery version is not supported yet; the room link has been kept."), "choose-identity": tr("This device has several saved identities. Please choose the original identity."),
      "host-conflict": tr("The original room already has a host; not taken over."),
      "missing-unconfirmed": CLOUD_GONE_TEXT.missingUnconfirmed, "proof-rejected": CLOUD_GONE_TEXT.proofRejected,
    };
    return <>{merge}<span className="pc-sync-chip pc-sync-chip--offline" role="status" data-pc="collaboration-recovery" data-kind={reopenState}>{text[reopenState] ?? reopenState}</span><RecoveryActions state={reopenState} /></>;
  }
  if (!active || blocked) return merge;
  return (
    <>
      {merge}
      {status === "paused" ? (
        <button type="button" className="pc-sync-chip pc-sync-chip--paused" data-pc="sync-paused" title={tr("The project changed while you were offline. Click to decide how to handle it")} onClick={() => setOfflineOpen(true)}>
          <span className="pc-sync-chip-dot" />
          {tr("Sync paused")}
        </button>
      ) : ONLINE ? (
        <OnlineStatusChip />
      ) : status === "offline" ? (
        <span className="pc-sync-chip pc-sync-chip--offline" data-pc="sync-offline" title={tr("Cannot reach the document service: edits work as usual and are held on this machine, then submitted in order once it recovers")}>
          <span className="pc-sync-chip-dot" />
          {tr("Offline")}
        </span>
      ) : null}
      {ONLINE ? <OnlineBackupsChip /> : null}
      <MembersButton />
    </>
  );
}

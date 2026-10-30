/**
 * 顶栏上的同步小部件:
 * - 「冲突合并」:待合并表里还有待处理的项时一直显示,点它打开冲突合并窗口(`ConflictMerge.tsx`;2026-10-18 用户定);
 * - 「同步已暂停」:离线批次逐项转表算不出基准、退回整份处理时才会出现(c65-design.md 第 8 节),点它重新打开离线对话框;
 * - 「离线」:连不上文档服务时的提示(修改照常,先攒在本机);
 * - 在线页面(C10 契约第 10 节):「离线」换成表 A 的五条状态措辞(`onlineStatus.ts`),另有「备份」小部件列出
 *   本页内存里的备份、可逐个下载(同步面板);
 * - 共享项目:成员按钮(MembersPanel)。
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

function subscribeNavigator(cb: () => void): () => void {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); };
}

/** 在线页面顶栏的状态措辞;离线类的要持续 `OFFLINE_SHOW_DELAY_MS` 才出(HT-a 会话接续、马上重建会话时不闪) */
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
  // 离线类:等延迟过了才换上(延迟内又好了就根本不出);非离线类(恢复中 / 恢复完成 / 没事)当场换
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

/** 同步面板里的「备份」:本页内存里有备份才出现,点开列出、逐个下载 */
function OnlineBackupsChip() {
  const n = useSync((v) => v.onlineBackups);
  const [open, setOpen] = useState(false);
  if (!n) return null;
  return (
    <>
      <button type="button" className="pc-sync-chip pc-sync-chip--backups" data-pc="sync-backups" title="被覆盖、离线丢弃的修改先留在本页，关闭页面前可以下载" onClick={() => setOpen(true)}>
        备份 {n}
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
  // 导航栏顶端的「冲突合并」:只要还有待处理的项就显示(断网、恢复中也显示,窗口里能删、连上后再合并)
  const merge = <ConflictMergeButton />;
  if (reopenState && reopenState !== "connected") {
    const text: Record<string, string> = {
      recovering: "正在恢复原协作房间…", "waiting-host": "正在等待主机上线，将自动重试。",
      "waiting-storage": "本机恢复信息暂时无法读取，将保留原身份并自动重试。",
      "needs-auth": "请用原身份重新认证；本地项目内容已保留。", rejected: "原身份已被拒绝，请联系创建者。",
      deleted: "原房间已删除或取消协作。", damaged: "协作恢复数据缺失或损坏，请从原备份恢复。",
      unsupported: "本项目的协作恢复版本暂不支持；房间关联已保留。", "choose-identity": "这台设备保存了多个身份，请选择原身份。",
      "host-conflict": "原房间已有主机，未接管。",
      "missing-unconfirmed": CLOUD_GONE_TEXT.missingUnconfirmed, "proof-rejected": CLOUD_GONE_TEXT.proofRejected,
    };
    return <>{merge}<span className="pc-sync-chip pc-sync-chip--offline" role="status" data-pc="collaboration-recovery" data-kind={reopenState}>{text[reopenState] ?? reopenState}</span><RecoveryActions state={reopenState} /></>;
  }
  if (!active || blocked) return merge;
  return (
    <>
      {merge}
      {status === "paused" ? (
        <button type="button" className="pc-sync-chip pc-sync-chip--paused" data-pc="sync-paused" title="断网期间项目有新改动，点开决定怎么处理" onClick={() => setOfflineOpen(true)}>
          <span className="pc-sync-chip-dot" />
          同步已暂停
        </button>
      ) : ONLINE ? (
        <OnlineStatusChip />
      ) : status === "offline" ? (
        <span className="pc-sync-chip pc-sync-chip--offline" data-pc="sync-offline" title="连不上文档服务：修改照常，先攒在本机，恢复后按顺序提交">
          <span className="pc-sync-chip-dot" />
          离线
        </span>
      ) : null}
      {ONLINE ? <OnlineBackupsChip /> : null}
      <MembersButton />
    </>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadStorageProviders,
  loadConnections,
  connectStorage,
  disconnectStorage,
  importFromStorage,
  storageImportSupported,
  type StorageProviderConfig,
  type StorageConnection,
} from "../io/storageImport";
import { getDriveToken, pickDriveFiles, requestDriveAuthCode, forgetDriveToken } from "../io/googlePicker";
import { tr } from "../../i18n/index.ts";

/**
 * 素材页的「从网盘导入」(任务书 `docs/plan/drive-connector-task.md` 第 5 节)。
 *
 * 单独一个组件,`LibrarySection` 里只加一行引用 —— 那个文件同期还有别人在改,这样冲突面最小。
 *
 * # 两条凭据路在界面上怎么体现
 *
 * - **不托管(A3)**:点「Google Drive」→ 授权 → Picker 选文件。那张票一小时就过期,关掉页面就没了。
 * - **托管(A2)**:在「已连接的网盘」里点一次「连接」,长期授权就交给编辑器进程保管。之后导入时
 *   **拉取不再依赖页面手里那张票** —— 几个 G 的大文件拉一小时也不会半路断掉。
 *
 * **Picker 本身总是要一张当场的票**(它要在页面里列出文件),所以托管与否都会走一次 `getDriveToken`;
 * 区别只在「拉字节」那一段用谁的票。
 *
 * 字节不经过页面:页面只递文件 id,拉取与入库都在编辑器进程里做。
 * 在线浏览器构建里不显示:那边没有本机的编辑器进程,拉不了(`storageImportSupported`)。
 */
export function StorageImportButton({
  disabled = false,
  disabledTitle,
  onImported,
  flash,
}: {
  disabled?: boolean;
  disabledTitle?: string;
  /** 导入完成后把用户带到素材落地的那一组 */
  onImported?: (firstKind: "video" | "audio" | "image") => void;
  flash: (msg: string) => void;
}) {
  const [providers, setProviders] = useState<StorageProviderConfig[] | null>(null);
  const [connections, setConnections] = useState<StorageConnection[]>([]);
  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const refreshConnections = useCallback(async () => {
    setConnections(await loadConnections());
  }, []);

  useEffect(() => {
    if (!storageImportSupported) return;
    let alive = true;
    void loadStorageProviders().then((list) => { if (alive) setProviders(list); });
    void loadConnections().then((rows) => { if (alive) setConnections(rows); });
    return () => { alive = false; };
  }, []);

  // 点别处关掉菜单
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) { setOpen(false); setManaging(false); }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const connectedOf = (kind: string) => connections.find((c) => c.provider === kind) ?? null;

  const runImport = useCallback(async (cfg: StorageProviderConfig) => {
    setOpen(false);
    setBusy(true);
    try {
      // Picker 要一张当场的票才能列出文件,托管与否都要
      const { token } = await getDriveToken(cfg);
      const picked = await pickDriveFiles(cfg, token);
      if (!picked || picked.length === 0) return;           // 用户取消,什么都不说

      // 已托管就不把票递下去:拉取方用它自己保管的凭据换票,不受这张票过期的影响
      const managed = !!connectedOf(cfg.kind);
      flash(tr("Importing {1} files from {0}…{2}", cfg.label, picked.length, managed ? tr(" (hosted authorization)") : ""));

      let firstKind: "video" | "audio" | "image" | null = null;
      const failed: string[] = [];
      for (const file of picked) {
        try {
          await importFromStorage(cfg.kind, managed ? null : token, file);
          if (!firstKind) firstKind = guessKind(file.mimeType, file.name);
        } catch (e) {
          failed.push(`${file.name}:${e instanceof Error ? e.message : String(e)}`);
          if (e instanceof Error && (/\b401\b/.test(e.message) || (e as { authFailed?: boolean }).authFailed)) forgetDriveToken();
        }
      }
      if (failed.length) alert(tr("These could not be imported:\n{0}", failed.join("\n")));
      const ok = picked.length - failed.length;
      if (ok > 0) {
        flash(tr("Imported {1} from {0}", cfg.label, ok));
        if (firstKind) onImported?.(firstKind);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!(e as { closed?: boolean } | null)?.closed && !/popup_closed/.test(msg)) alert(tr("Cloud drive import failed: {0}", msg));
    } finally {
      setBusy(false);
    }
  }, [connections, flash, onImported]);

  const runConnect = useCallback(async (cfg: StorageProviderConfig) => {
    setBusy(true);
    try {
      const got = await requestDriveAuthCode(cfg);
      if (!got) return;                                     // 用户关了授权窗口
      await connectStorage(cfg.kind, got.code, got.codeVerifier);
      await refreshConnections();
      flash(tr("Authorization for {0} has been handed to this machine for safekeeping", cfg.label));
    } catch (e) {
      alert(tr("Connection failed: {0}", e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }, [flash, refreshConnections]);

  const runDisconnect = useCallback(async (cfg: StorageProviderConfig) => {
    if (!confirm(tr("Disconnect {0}?\n\nThe stored authorization will be deleted and revoked with {1}. Media already imported is not affected.", cfg.label, cfg.label))) return;
    setBusy(true);
    try {
      const out = await disconnectStorage(cfg.kind);
      await refreshConnections();
      flash(out.revoked
        ? tr("Disconnected {0}", cfg.label)
        : tr("The authorization stored on this machine was deleted, but revoking it on {0} failed ({1}). Please revoke it again on the account page", cfg.label, out.why ?? tr("unknown reason")));
    } catch (e) {
      alert(tr("Disconnect failed: {0}", e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }, [flash, refreshConnections]);

  if (!storageImportSupported) return null;

  const list = providers ?? [];
  const anyConfigured = list.some((p) => p.configured);
  const off = disabled || busy;

  return (
    <div className="pc-storage-import" ref={boxRef}>
      <button
        type="button"
        className="pc-btn-ghost is-block pc-left-primary"
        data-pc-add="storage"
        title={disabled ? disabledTitle : tr("Import media from your cloud drive (after authorization, only the files you pick on the spot are read)")}
        disabled={off}
        onClick={() => { setOpen((v) => !v); setManaging(false); }}
      >
        <IconCloud size={16} />
        <span>{busy ? tr("Importing from cloud drive…") : tr("Import from cloud drive")}</span>
      </button>

      {open && (
        <div className="pc-storage-menu" role="menu">
          {list.length === 0 && <div className="pc-storage-note">{tr("Cannot read cloud drive config")}</div>}

          {!managing && list.map((p) => {
            const conn = connectedOf(p.kind);
            return (
              <button
                key={p.kind}
                type="button"
                role="menuitem"
                className="pc-storage-item"
                disabled={!p.configured}
                title={p.configured ? undefined : p.reason}
                onClick={() => { if (p.kind === "google-drive") void runImport(p); }}
              >
                <span className="pc-storage-name"><ProviderIcon kind={p.kind} />{p.label}</span>
                {!p.configured
                  ? <span className="pc-storage-tag">{p.kind === "dropbox" ? tr("Coming soon") : tr("Not configured")}</span>
                  : conn ? <span className="pc-storage-tag">{tr("Hosted")}</span> : null}
              </button>
            );
          })}

          {!managing && anyConfigured && (
            <>
              <div className="pc-storage-sep" />
              <button type="button" role="menuitem" className="pc-storage-item" onClick={() => setManaging(true)}>
                <span>{tr("Connected cloud drives…")}</span>
                <span className="pc-storage-tag">{connections.length}</span>
              </button>
            </>
          )}

          {managing && (
            <>
              <div className="pc-storage-note">
                {tr("Once you hand long-term authorization to this machine for safekeeping, uploads continue even after you close the page. The authorization only covers the files you pick on the spot.")}
              </div>
              {list.filter((p) => p.configured).map((p) => {
                const conn = connectedOf(p.kind);
                return (
                  <div key={p.kind} className="pc-storage-row">
                    <div className="pc-storage-rowmain">
                      <span className="pc-storage-name"><ProviderIcon kind={p.kind} />{p.label}</span>
                      <span className="pc-storage-tag">
                        {conn ? tr("Connected on {0}", new Date(conn.createdAt).toLocaleDateString()) : p.canManage ? tr("Not connected") : tr("Hosting not supported")}
                      </span>
                    </div>
                    {conn
                      ? <button type="button" className="pc-storage-act" disabled={busy} onClick={() => void runDisconnect(p)}>{tr("Disconnect")}</button>
                      : <button type="button" className="pc-storage-act" disabled={busy || !p.canManage} title={p.canManage ? undefined : p.manageReason} onClick={() => void runConnect(p)}>{tr("Connect")}</button>}
                  </div>
                );
              })}
              <div className="pc-storage-sep" />
              <button type="button" className="pc-storage-item" onClick={() => setManaging(false)}><span>{tr("Back")}</span></button>
            </>
          )}

          {!anyConfigured && (
            <div className="pc-storage-note">
              {tr("Configure in the editor process environment variables:")}{" "} <code>PROMPTCUT_GOOGLE_CLIENT_ID</code> {tr("and two others to enable this")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Picker 给的类型未必有,退回看扩展名。和 io/storageImport 里那份同一套判法 */
function guessKind(mimeType: string | undefined, name: string): "video" | "audio" | "image" {
  const mt = String(mimeType || "").toLowerCase();
  if (mt.startsWith("video/")) return "video";
  if (mt.startsWith("audio/")) return "audio";
  if (mt.startsWith("image/")) return "image";
  const ext = name.toLowerCase().split(".").pop() || "";
  if (["mp4", "mov", "m4v", "webm", "mkv", "avi"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "aac", "flac", "ogg"].includes(ext)) return "audio";
  return "image";
}

/**
 * 各家网盘的徽标。放在菜单和管理面板里,一眼能认出是哪家。
 *
 * 画成内联 SVG,不引外链图片:编辑器要能离线用,而且素材页不该为了一个图标去发网络请求。
 * 颜色写死品牌色,不跟主题变 —— 徽标变了色就不是那个徽标了。
 */
function ProviderIcon({ kind, size = 16 }: { kind: string; size?: number }) {
  if (kind === "google-drive") {
    // Drive 的三角由三块拼成:左下绿、右下蓝、上方黄,中间一条深色折线把三块分开
    return (
      <svg width={size} height={size} viewBox="0 0 87.3 78" aria-hidden="true" style={{ flex: "none" }}>
        <path d="M6.6 66.85l3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8H0c0 1.55.4 3.1 1.2 4.5z" fill="#0066da" />
        <path d="M43.65 25L29.9 1.2c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44A9.06 9.06 0 000 53h27.5z" fill="#00ac47" />
        <path d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5H59.798l5.852 11.5z" fill="#ea4335" />
        <path d="M43.65 25L57.4 1.2C56.05.4 54.5 0 52.9 0H34.4c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d" />
        <path d="M59.8 53H27.5L13.75 76.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc" />
        <path d="M73.4 26.5l-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3L43.65 25l16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00" />
      </svg>
    );
  }
  if (kind === "dropbox") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flex: "none" }}>
        <path d="M6 2 0 6l6 4 6-4zM18 2l-6 4 6 4 6-4zM0 14l6 4 6-4-6-4zM18 10l-6 4 6 4 6-4zM6 19.5l6 4 6-4-6-4z" fill="#0061FF" />
      </svg>
    );
  }
  return <IconCloud size={size} />;
}

function IconCloud({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.2 10.5 3.75 3.75 0 0 0 6.75 19Z" />
      <path d="M12 16v-5" />
      <path d="m9.5 13 2.5-2.5 2.5 2.5" />
    </svg>
  );
}

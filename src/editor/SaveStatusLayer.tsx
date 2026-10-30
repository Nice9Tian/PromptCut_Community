/**
 * 保存时的界面:保存进行中盖一层「正在保存」(前台编辑暂停,见 `saveLock.ts`),保存结束后把结果说清楚。
 *
 * - 保存中:整页盖一层半透明的罩子,中间一张小卡写「正在保存项目」和正在等的本机写入;罩子只是让用户看得见现在不能编辑,
 *   真正拦输入的是 `saveLock.ts` 在 window 捕获阶段挂的拦截。
 * - 结束后:没保存成(等本机写入超时、写盘失败)或保存成了但有话要说(退回浏览器下载、包里缺素材、预渲染快照没存进去)时,
 *   顶部出一张不挡操作的卡片 —— 锁已经解了,编辑照常,卡片点「知道了」或按 Esc 收起。
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { dismissSaveNotice, getSaveLockState, getSaveNotice, subscribeSaveLock, subscribeSaveNotice } from "./saveLock";
import "./ExportDialog.css";

export function SaveStatusLayer() {
  const lock = useSyncExternalStore(subscribeSaveLock, getSaveLockState, getSaveLockState);
  const notice = useSyncExternalStore(subscribeSaveNotice, getSaveNotice, getSaveNotice);
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!notice || lock.saving) return;
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismissSaveNotice();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [notice, lock.saving]);

  if (lock.saving) {
    const what = lock.kind === "procp" ? "打包保存项目" : "保存项目";
    return (
      <div className="pc-export-backdrop" data-pc="save-lock" data-step={lock.step ?? ""} style={{ zIndex: 400, cursor: "progress", background: "rgba(0, 0, 0, 0.35)" }}>
        <div className="pc-export-dialog" role="alertdialog" aria-modal="true" aria-busy="true" aria-label={`正在${what}`} style={{ maxWidth: 380 }}>
          <div className="pc-export-title">正在{what}…</div>
          <div className="pc-export-hint">保存完成前暂时不能编辑。</div>
          {lock.step === "writing" ? (
            <div className="pc-export-ok" data-pc="save-lock-step">正在写入文件…</div>
          ) : lock.waiting.length > 0 ? (
            <div className="pc-export-ok" data-pc="save-lock-waiting" style={{ whiteSpace: "pre-line" }}>
              {`先等本机这些写入完成：\n${lock.waiting.map((w) => `· ${w}`).join("\n")}`}
            </div>
          ) : (
            <div className="pc-export-ok" data-pc="save-lock-step">正在检查本机的修改…</div>
          )}
        </div>
      </div>
    );
  }

  if (!notice) return null;
  return (
    <div
      className="pc-export-dialog"
      role={notice.tone === "error" ? "alert" : "status"}
      data-pc="save-notice"
      data-tone={notice.tone}
      style={{ position: "fixed", top: 56, left: "50%", transform: "translateX(-50%)", zIndex: 400, maxWidth: 460, width: "calc(100% - 32px)" }}
    >
      <div className="pc-export-title">{notice.title}</div>
      <div className={notice.tone === "error" ? "pc-export-err" : "pc-export-ok"} style={{ whiteSpace: "pre-line" }}>{notice.message}</div>
      <div className="pc-export-actions">
        <button ref={okRef} type="button" className="pc-export-btn pc-export-primary" onClick={dismissSaveNotice}>知道了</button>
      </div>
    </div>
  );
}

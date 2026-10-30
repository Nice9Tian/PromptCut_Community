/**
 * 导出进度对话框。
 *
 * 以前点「导出视频」什么都不弹:进度只 console.log,成功弹一个 alert,失败弹另一个
 * alert（还是「Exited with code 3221225794」这种鬼话）。渲染几百帧要几十秒，
 * 中间界面毫无反应，看起来就像按钮坏了。
 *
 * 现在整个过程都在这个窗口里:选位置 → 进度 → 结果，可以随时取消。
 *
 * 在线浏览器里点导出先到 `asking`:在「快速导出」「完整导出」里选一种(`docs/semantics/workflow/project.md`「导出视频」,
 * 用户 2026-10-13 定;桌面版没有这一步,`asking` 只有在线页面会进)。文字在 `src/export/text.ts`。
 */
import { useEffect, useRef, useState } from "react";
import { ONLINE_EXPORT_TEXT } from "../export/text";
import type { ExportMode } from "../export/cardLayers";
import "./ExportDialog.css";

export type ExportPhase = "asking" | "running" | "done" | "error" | "cancelled";

export interface ExportState {
  phase: ExportPhase;
  /** 服务端任务 id;结束后「打开产物目录」还要用，所以存在状态里而不是 ref 里 */
  id?: string;
  /** 当前这一步的已完成帧 / 总帧数 */
  done: number;
  total: number;
  /**
   * sound = 导出开始时先生成声音(done / total 是段数,done 可带小数);render = 浏览器逐帧渲卡片;
   * compose = ffmpeg 把视频素材和卡片合成成片。每一步各走一遍进度条
   */
  stage?: "sound" | "render" | "compose";
  /** 用户选定的落点，没选就是服务端的产物目录 */
  target: string;
  outDir?: string;
  message?: string;
  startedAt?: number;
  /** 在线浏览器:导出前还在等什么(素材原尺寸没传完、渲染节点还没把这台设备运行不了的卡渲好);等到了就清掉 */
  waiting?: string;
  /** 在线浏览器:这一次选的导出方式(进度窗口的标题里带上) */
  mode?: ExportMode;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, "0")} 秒`;
}

export function ExportDialog(props: {
  state: ExportState | null;
  onCancel: () => void;
  onClose: () => void;
  onReveal: () => void;
  /** `asking` 时选了一种导出方式(只有在线页面会用到) */
  onPick?: (mode: ExportMode) => void;
}) {
  const { state, onCancel, onClose, onReveal, onPick } = props;
  // 进度只在渲染阶段有意义，但耗时要一直走，所以计时器挂在对话框上
  const [now, setNow] = useState(Date.now());
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (state?.phase !== "running") return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [state?.phase]);

  // 跑完了把焦点交给唯一那个按钮，键盘用户不用摸索
  useEffect(() => {
    if (state && state.phase !== "running") closeRef.current?.focus();
  }, [state?.phase]);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      // 渲染中按 Esc 是「取消导出」，不是「关掉窗口把任务丢在后台」
      if (state.phase === "running") onCancel();
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, onCancel, onClose]);

  if (!state) return null;

  // 在线浏览器:先选导出方式。两个选项各带一句说明,点了才去选保存位置
  if (state.phase === "asking") {
    const options: { mode: ExportMode; name: string; hint: string }[] = [
      { mode: "fast", name: ONLINE_EXPORT_TEXT.fast, hint: ONLINE_EXPORT_TEXT.fastHint },
      { mode: "full", name: ONLINE_EXPORT_TEXT.full, hint: ONLINE_EXPORT_TEXT.fullHint },
    ];
    return (
      <div className="pc-export-backdrop" onClick={onClose}>
        <div className="pc-export-dialog" role="dialog" aria-modal="true" aria-label={ONLINE_EXPORT_TEXT.modeTitle} data-pc="export-mode-dialog" onClick={(e) => e.stopPropagation()}>
          <div className="pc-export-title">{ONLINE_EXPORT_TEXT.modeTitle}</div>
          <div className="pc-export-modes" role="group" aria-label={ONLINE_EXPORT_TEXT.modeTitle}>
            {options.map((o) => (
              <button key={o.mode} type="button" className="pc-export-mode" data-pc="export-mode" data-mode={o.mode} onClick={() => onPick?.(o.mode)}>
                <span className="pc-export-mode-name">{o.name}</span>
                <span className="pc-export-mode-hint">{o.hint}</span>
              </button>
            ))}
          </div>
          <div className="pc-export-actions">
            <button ref={closeRef} className="pc-export-btn" onClick={onClose}>取消</button>
          </div>
        </div>
      </div>
    );
  }

  const pct = state.total > 0 ? Math.min(100, Math.round((state.done / state.total) * 100)) : 0;
  // 计时器每半秒才走一下:刚进「进行中」那一下 `now` 还是旧的,不让它显示成负数
  const elapsed = state.startedAt ? Math.max(0, now - state.startedAt) : 0;

  return (
    <div className="pc-export-backdrop" onClick={state.phase === "running" ? undefined : onClose}>
      <div
        className="pc-export-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="导出视频"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pc-export-title">
          {state.phase === "running" ? (state.mode === "fast" ? `正在${ONLINE_EXPORT_TEXT.fast}` : state.mode === "full" ? `正在${ONLINE_EXPORT_TEXT.full}` : "正在导出视频") :
           state.phase === "done" ? "导出完成" :
           state.phase === "cancelled" ? "已取消导出" : "导出失败"}
        </div>

        <div className="pc-export-target">
          <span className="pc-export-label">保存到</span>
          <span className="pc-export-path" title={state.target}>{state.target}</span>
        </div>

        {state.phase === "running" && (
          <>
            <div
              className="pc-export-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
            >
              <div className="pc-export-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="pc-export-meta">
              <span>{pct}%</span>
              <span data-pc="export-stage" data-stage={state.stage ?? "render"}>{state.stage === "sound"
                ? `生成声音 ${Math.min(state.total, Math.floor(state.done) + 1)} / ${state.total} 段`
                : `${state.stage === "compose" ? "合成视频" : "渲染卡片"} ${state.done} / ${state.total} 帧`}</span>
              <span>已用 {fmtDuration(elapsed)}</span>
            </div>
            {state.waiting ? (
              <div className="pc-export-waiting" data-pc="export-waiting" style={{ whiteSpace: "pre-line" }}>{state.waiting}</div>
            ) : null}
            <div className="pc-export-hint">
              渲染期间会另开一个隐藏的浏览器逐帧截图，占用较高属正常。
            </div>
          </>
        )}

        {state.phase === "done" && (
          <div className="pc-export-ok">
            视频已保存。只含卡片的透明层（overlay.mov）在产物目录里。
          </div>
        )}

        {/* 完成但有素材因缺失被跳过(TopBar 用 exportSkippedMessage 写进 message):照列出来,不静默 */}
        {state.phase === "done" && state.message && (
          <div className="pc-export-err" data-pc="export-skipped" style={{ whiteSpace: "pre-line" }}>{state.message}</div>
        )}

        {/* 取消是用户自己按的,标题已经说了「已取消导出」,这里再复述一遍没有信息量,
            改成说清楚现场留下了什么 */}
        {state.phase === "cancelled" && (
          <div className="pc-export-ok">
            渲染已停止。中间文件已清掉；重新导出会另建一个产物目录。
          </div>
        )}

        {state.phase === "error" && state.message && (
          <div className="pc-export-err">{state.message}</div>
        )}

        <div className="pc-export-actions">
          {state.phase === "running" ? (
            <button className="pc-export-btn" onClick={onCancel}>取消导出</button>
          ) : (
            <>
              {state.outDir && (
                <button className="pc-export-btn" onClick={onReveal}>打开产物目录</button>
              )}
              <button ref={closeRef} className="pc-export-btn pc-export-primary" onClick={onClose}>
                关闭
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

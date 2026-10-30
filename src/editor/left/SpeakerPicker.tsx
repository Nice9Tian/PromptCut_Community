import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useStore, getState } from "../../store/project";
import { importVideoFiles } from "../io";
import { onlinePage, onlineUnsupported } from "../../online/pageFlag";

export interface SpeakerPickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (url: string) => void;
}

function fmtDuration(sec?: number): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * 口播视频选择器弹窗:
 * 支持从现有素材库选取视频，或直接从本地上传并写入 clip 参数。
 *
 * 交出去的是素材的身份 `m.url`(`/@media/<hash>`,项目数据),不是取字节的地址:在线页面也照旧交它,
 * 不能换成带票据的远程地址写进项目(票据会过期、别的成员用不了)。取字节时由消费方按档换地址。
 * 在线浏览器模式没有页面侧上传(C10 契约第 10 节),「从本地文件导入」置灰。
 */
export function SpeakerPicker({ open, onClose, onSelect }: SpeakerPickerProps) {
  const media = useStore((s) => s.project.media);
  const videoMedia = media.filter((m) => !m.kind || m.kind === "video");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const mediaIds = await importVideoFiles([file]);
      if (mediaIds.length > 0) {
        const id = mediaIds[0];
        const state = getState();
        const m = state.project.media.find((item) => item.id === id);
        if (m && m.url) {
          onSelect(m.url);
          onClose();
        } else {
          alert("导入成功但未能获取素材信息");
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`导入视频失败: ${msg}`);
    } finally {
      e.target.value = "";
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 bg-black/60 z-[1000] grid place-items-center"
      onClick={onClose}
    >
      <div
        data-pc="speaker-picker"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="w-96 max-h-[85vh] rounded-lg border border-neutral-700 bg-neutral-900 p-4 text-sm shadow-2xl flex flex-col gap-3"
      >
        <div className="flex items-center justify-between pb-2 border-b border-neutral-800">
          <div className="font-medium text-neutral-100 text-sm">选择口播视频</div>
          <button
            type="button"
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-300 text-xs px-1"
          >
            ✕
          </button>
        </div>

        {/* 来源一：已导入素材 */}
        <div className="flex flex-col gap-1.5 min-h-0">
          <div className="text-xs text-neutral-400 font-medium">从项目素材库选择</div>
          <div className="max-h-48 overflow-y-auto pc-left-scrollborder border-neutral-800 rounded bg-neutral-950/60 p-1 flex flex-col gap-1">
            {videoMedia.length === 0 ? (
              <div className="p-3 text-center text-xs text-neutral-500">
                还没有素材，用下面的选择文件导入
              </div>
            ) : (
              videoMedia.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    onSelect(m.url);
                    onClose();
                  }}
                  className="w-full text-left px-2 py-1.5 rounded hover:bg-neutral-800 flex items-center justify-between gap-2 text-xs transition-colors"
                >
                  <span className="truncate text-neutral-200">{m.name}</span>
                  <span className="text-neutral-500 tabular-nums shrink-0 text-[11px]">
                    {fmtDuration(m.duration)}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>

        {/* 来源二：本地文件导入 */}
        <div className="flex flex-col gap-1.5 pt-2 border-t border-neutral-800">
          <div className="text-xs text-neutral-400 font-medium">从本地文件导入</div>
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            style={{ display: "none" }}
            onChange={handleFileInputChange}
          />
          <button
            type="button"
            disabled={onlinePage()}
            title={onlinePage() ? onlineUnsupported("导入媒体") : undefined}
            onClick={() => { if (!onlinePage()) fileInputRef.current?.click(); }}
            className="w-full h-8 flex items-center justify-center gap-1.5 rounded border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-200 transition-colors"
          >
            <span>+</span>
            <span>选择本地视频文件…</span>
          </button>
        </div>

        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 rounded border border-neutral-700 text-xs text-neutral-300 hover:bg-neutral-800 transition-colors"
          >
            取消
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

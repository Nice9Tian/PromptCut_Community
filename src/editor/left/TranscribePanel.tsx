import { useState, useEffect, useRef } from "react";
import type { TranscriptSegment } from "../../kernel/project";
import { sttStatus, sttInstall, transcribeMedia, type SttStatus } from "../io/stt";
import { onlinePage, onlineUnsupported } from "../../online/pageFlag";

interface TranscribePanelProps {
  mediaId: string;
  onClose: () => void;
}

const ENGINES = [
  { value: "faster-whisper", label: "faster-whisper(推荐)" },
  { value: "whisper", label: "whisper" },
];
const MODELS = [
  { value: "tiny", label: "tiny(最快)" },
  { value: "base", label: "base" },
  { value: "small", label: "small(默认)" },
  { value: "medium", label: "medium" },
  { value: "large-v3", label: "large-v3(最精准)" },
];
const LANGUAGES = [
  { value: "", label: "自动检测" },
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
];

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function TranscribePanel({ mediaId, onClose }: TranscribePanelProps) {
  const [engine, setEngine] = useState("faster-whisper");
  const [model, setModel] = useState("small");
  const [language, setLanguage] = useState("");

  // 状态
  const [statusData, setStatusData] = useState<SttStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  // 在线浏览器模式没有语音识别(C10 契约第 10 节):不查引擎状态(那是编辑器进程的接口),只给一个置灰的按钮
  const online = onlinePage();
  const [loadingStatus, setLoadingStatus] = useState(!online);

  // 安装
  const [installing, setInstalling] = useState(false);
  const [installLogs, setInstallLogs] = useState<string[]>([]);
  const installLogRef = useRef<HTMLDivElement>(null);

  // 转写
  const [transcribing, setTranscribing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [totalSegments, setTotalSegments] = useState<number | null>(null);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const [transcribeLogs, setTranscribeLogs] = useState<string[]>([]);

  // 取消信号
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!online) loadStatus();
  }, []);

  // 安装日志自动滚动
  useEffect(() => {
    if (installLogRef.current) {
      installLogRef.current.scrollTop = installLogRef.current.scrollHeight;
    }
  }, [installLogs]);

  async function loadStatus() {
    setLoadingStatus(true);
    setStatusError(null);
    try {
      const s = await sttStatus();
      setStatusData(s);
    } catch (e: unknown) {
      setStatusError(String(e));
    } finally {
      setLoadingStatus(false);
    }
  }

  async function handleInstall() {
    setInstalling(true);
    setInstallLogs([]);
    try {
      const { ok } = await sttInstall(engine, (line) => {
        setInstallLogs((prev) => [...prev, line]);
      });
      if (ok) {
        await loadStatus();
      } else {
        setInstallLogs((prev) => [...prev, "[安装失败]"]);
      }
    } catch (e: unknown) {
      setInstallLogs((prev) => [...prev, "[错误] " + String(e)]);
    } finally {
      setInstalling(false);
    }
  }

  async function handleTranscribe() {
    setTranscribing(true);
    setTranscribeError(null);
    setSegments([]);
    setTotalSegments(null);
    setProgress(null);
    setTranscribeLogs([]);
    cancelRef.current = false;

    try {
      const result = await transcribeMedia(
        mediaId,
        { engine, model, language: language || undefined },
        (p) => {
          if ("done" in p && "total" in p) {
            setProgress({ done: p.done, total: p.total });
          } else if ("segment" in p) {
            // 实时段落展示(不影响最终 done 里的完整 segments)
          } else if ("log" in p) {
            setTranscribeLogs((prev) => {
              const next = [...prev, p.log];
              if (next.length > 100) next.shift();
              return next;
            });
          }
        }
      );
      setTotalSegments(result.segments.length);
      setSegments(result.segments.slice(0, 5));
    } catch (e: unknown) {
      if (!cancelRef.current) {
        setTranscribeError(String(e));
      }
    } finally {
      setTranscribing(false);
    }
  }

  function handleCancel() {
    cancelRef.current = true;
    setTranscribing(false);
    // 注意:网络层取消由 fetch 的 AbortController 控制,此处简化
    setTranscribeError("已取消");
  }

  // 判断当前引擎是否已安装
  const engineInstalled =
    statusData?.engines[engine as "faster-whisper" | "whisper"]?.installed ?? false;

  const showInstallBtn = !online && !loadingStatus && !statusError && !engineInstalled;

  return (
    <div
      data-pc="transcribe-panel"
      className="pc-left-box p-2 mt-1 text-xs"
    >
      {/* 头部:参数选择 */}
      <div className="flex flex-wrap gap-1.5 mb-2">
        <select
          className="pc-left-select is-sm"
          value={engine}
          onChange={(e) => setEngine(e.target.value)}
        >
          {ENGINES.map((e) => (
            <option key={e.value} value={e.value}>{e.label}</option>
          ))}
        </select>
        <select
          className="pc-left-select is-sm"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        >
          {MODELS.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
        <select
          className="pc-left-select is-sm"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          {LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>{l.label}</option>
          ))}
        </select>
        <button
          type="button"
          className="ml-auto pc-left-btn is-sm"
          onClick={onClose}
          title="收起转写面板"
        >
          ✕
        </button>
      </div>

      {online && (
        <button type="button" data-pc="start-transcribe-btn" className="pc-left-btn is-primary is-block mb-2" disabled title={onlineUnsupported("语音识别")}>
          开始转写
        </button>
      )}

      {/* 状态区 */}
      {loadingStatus && (
        <div className="pc-left-faint mb-1">检查引擎状态…</div>
      )}
      {statusError && (
        <div className="text-red-400 mb-1 break-all">{statusError}</div>
      )}
      {!loadingStatus && !statusError && statusData && (
        <div className="pc-left-faint mb-1">
          Python {statusData.python ?? "?"} · {engine}{" "}
          {engineInstalled
            ? <span className="text-green-400">已安装</span>
            : <span className="text-yellow-400">未安装</span>
          }
        </div>
      )}

      {/* 下载引擎按钮 */}
      {showInstallBtn && !installing && (
        <button
          type="button"
          data-pc="install-engine-btn"
          className="pc-left-btn is-primary is-block mb-2"
          onClick={handleInstall}
        >
          下载引擎 ({engine})
        </button>
      )}

      {/* 安装日志 */}
      {(installing || installLogs.length > 0) && (
        <div
          ref={installLogRef}
          className="h-24 overflow-y-auto font-mono text-[10px] pc-left-muted bg-black/30 rounded p-1 mb-2 whitespace-pre-wrap break-all"
        >
          {installLogs.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
          {installing && <div className="pc-left-faint animate-pulse">安装中…</div>}
        </div>
      )}

      {/* 开始转写 / 取消 */}
      {!loadingStatus && !statusError && engineInstalled && (
        <div className="mb-2">
          {transcribing ? (
            <>
              {progress && (
                <div className="mb-1">
                  <div className="flex justify-between pc-left-faint mb-0.5">
                    <span>转写中…</span>
                    <span>{progress.done.toFixed(0)}s / {progress.total.toFixed(0)}s</span>
                  </div>
                  <div className="pc-left-progress">
                    <div
                      className="pc-left-progress-fill"
                      style={{ width: progress.total > 0 ? `${Math.min(100, (progress.done / progress.total) * 100)}%` : "0%" }}
                    />
                  </div>
                </div>
              )}
              {!progress && (
                <div className="pc-left-faint mb-1 animate-pulse">转写中…(正在加载模型)</div>
              )}
              <button
                type="button"
                className="pc-left-btn is-block"
                onClick={handleCancel}
              >
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              data-pc="start-transcribe-btn"
              className="pc-left-btn is-primary is-block"
              onClick={handleTranscribe}
            >
              {totalSegments !== null ? "重新转写" : "开始转写"}
            </button>
          )}
        </div>
      )}

      {/* 转写日志(仅在转写中显示,静音提示) */}
      {transcribing && transcribeLogs.length > 0 && (
        <div className="h-12 overflow-y-auto font-mono text-[10px] pc-left-faint bg-black/20 rounded p-1 mb-1 whitespace-pre-wrap break-all">
          {transcribeLogs.slice(-20).map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}

      {/* 错误 */}
      {transcribeError && (
        <div className="text-red-400 mb-1 break-all">{transcribeError}</div>
      )}

      {/* 转写结果预览 */}
      {totalSegments !== null && segments.length > 0 && (
        <div>
          <div className="pc-left-faint mb-0.5">
            共 {totalSegments} 段(前 {segments.length} 段预览)
          </div>
          {segments.map((seg, i) => (
            <div key={i} className="flex gap-1.5 text-[10px] pc-left-muted py-0.5 pc-left-divider">
              <span className="pc-left-faint tabular-nums shrink-0">
                [{fmtTime(seg.start)}]
              </span>
              <span className="truncate">{seg.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

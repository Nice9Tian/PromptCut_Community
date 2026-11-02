import { useState, useEffect, useRef } from "react";
import type { TranscriptSegment } from "../../kernel/project";
import { sttStatus, sttInstall, transcribeMedia, type SttStatus } from "../io/stt";
import { onlinePage } from "../../online/pageFlag";
import { onlineUnsupported } from "../../online/onlineUnsupported";
import { tr } from "../../i18n/index.ts";

interface TranscribePanelProps {
  mediaId: string;
  onClose: () => void;
}

const ENGINES = [
  { value: "faster-whisper", label: tr("faster-whisper (recommended)") },
  { value: "whisper", label: "whisper" },
];
const MODELS = [
  { value: "tiny", label: tr("tiny (fastest)") },
  { value: "base", label: "base" },
  { value: "small", label: tr("small (default)") },
  { value: "medium", label: "medium" },
  { value: "large-v3", label: tr("large-v3 (most accurate)") },
];
const LANGUAGES = [
  { value: "", label: tr("Auto-detect") },
  // i18n-allow: each language is named in itself
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
  // i18n-allow: each language is named in itself
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

  // State
  const [statusData, setStatusData] = useState<SttStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  // Online browser mode has no speech recognition (C10 contract, section 10): do not query the engine status (that is an editor process API), just show a greyed-out button
  const online = onlinePage();
  const [loadingStatus, setLoadingStatus] = useState(!online);

  // Install
  const [installing, setInstalling] = useState(false);
  const [installLogs, setInstallLogs] = useState<string[]>([]);
  const installLogRef = useRef<HTMLDivElement>(null);

  // Transcribe
  const [transcribing, setTranscribing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [totalSegments, setTotalSegments] = useState<number | null>(null);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const [transcribeLogs, setTranscribeLogs] = useState<string[]>([]);

  // Cancel signal
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!online) loadStatus();
  }, []);

  // Auto-scroll the install log
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
        setInstallLogs((prev) => [...prev, tr("[Install failed]")]);
      }
    } catch (e: unknown) {
      setInstallLogs((prev) => [...prev, tr("[Error] ") + String(e)]);
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
            // Live paragraph display (does not affect the full segments in the final done)
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
    // Note: network-layer cancellation is controlled by fetch's AbortController, simplified here
    setTranscribeError(tr("Cancelled"));
  }

  // Determine whether the current engine is installed
  const engineInstalled =
    statusData?.engines[engine as "faster-whisper" | "whisper"]?.installed ?? false;

  const showInstallBtn = !online && !loadingStatus && !statusError && !engineInstalled;

  return (
    <div
      data-pc="transcribe-panel"
      className="pc-left-box p-2 mt-1 text-xs"
    >
      {/* Head: parameter selection */}
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
          title={tr("Collapse transcription panel")}
        >
          ✕
        </button>
      </div>

      {online && (
        <button type="button" data-pc="start-transcribe-btn" className="pc-left-btn is-primary is-block mb-2" disabled title={onlineUnsupported(tr("Speech recognition"))}>
          {tr("Start transcription")}
        </button>
      )}

      {/* Status area */}
      {loadingStatus && (
        <div className="pc-left-faint mb-1">{tr("Checking engine status…")}</div>
      )}
      {statusError && (
        <div className="text-red-400 mb-1 break-all">{statusError}</div>
      )}
      {!loadingStatus && !statusError && statusData && (
        <div className="pc-left-faint mb-1">
          Python {statusData.python ?? "?"} · {engine}{" "}
          {engineInstalled
            ? <span className="text-green-400">{tr("Installed")}</span>
            : <span className="text-yellow-400">{tr("Not installed")}</span>
          }
        </div>
      )}

      {/* Download engine button */}
      {showInstallBtn && !installing && (
        <button
          type="button"
          data-pc="install-engine-btn"
          className="pc-left-btn is-primary is-block mb-2"
          onClick={handleInstall}
        >
          {tr("Download engine ({0})", engine)}
        </button>
      )}

      {/* Install log */}
      {(installing || installLogs.length > 0) && (
        <div
          ref={installLogRef}
          className="h-24 overflow-y-auto font-mono text-[10px] pc-left-muted bg-black/30 rounded p-1 mb-2 whitespace-pre-wrap break-all"
        >
          {installLogs.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
          {installing && <div className="pc-left-faint animate-pulse">{tr("Installing…")}</div>}
        </div>
      )}

      {/* Start transcribing / Cancel */}
      {!loadingStatus && !statusError && engineInstalled && (
        <div className="mb-2">
          {transcribing ? (
            <>
              {progress && (
                <div className="mb-1">
                  <div className="flex justify-between pc-left-faint mb-0.5">
                    <span>{tr("Transcribing…")}</span>
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
                <div className="pc-left-faint mb-1 animate-pulse">{tr("Transcribing… (loading model)")}</div>
              )}
              <button
                type="button"
                className="pc-left-btn is-block"
                onClick={handleCancel}
              >
                {tr("Cancel")}
              </button>
            </>
          ) : (
            <button
              type="button"
              data-pc="start-transcribe-btn"
              className="pc-left-btn is-primary is-block"
              onClick={handleTranscribe}
            >
              {totalSegments !== null ? tr("Transcribe again") : tr("Start transcription")}
            </button>
          )}
        </div>
      )}

      {/* Transcription log (shown only while transcribing, silence hint) */}
      {transcribing && transcribeLogs.length > 0 && (
        <div className="h-12 overflow-y-auto font-mono text-[10px] pc-left-faint bg-black/20 rounded p-1 mb-1 whitespace-pre-wrap break-all">
          {transcribeLogs.slice(-20).map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}

      {/* Error */}
      {transcribeError && (
        <div className="text-red-400 mb-1 break-all">{transcribeError}</div>
      )}

      {/* Transcription result preview */}
      {totalSegments !== null && segments.length > 0 && (
        <div>
          <div className="pc-left-faint mb-0.5">
            {tr("{0} segments in total (previewing the first {1})", totalSegments, segments.length)}
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

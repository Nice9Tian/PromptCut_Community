import { useEffect, useState, useSyncExternalStore } from "react";
import type { TrackClip } from "../../kernel/project";
import { getState } from "../../store/project";
import type { SoundEffectRecipe } from "../../kernel/soundEffects";
import { createTypingSchedule, typingScheduleOptionsFromParams } from "../../kernel/typingEvents";
import { startSoundGeneration, soundGenerationJobs, subscribeSoundGeneration, cancelSoundGeneration } from "../io/soundGeneration";
import { soundJobFinished, type SoundGenerationJob } from "../../audio/soundGeneration";

const labels: Record<string, string> = { frequency: "频率 Hz", waveform: "音色", duration: "声音时长 s", attack: "起音 s", release: "收音 s", gain: "音量", notes: "音列(半音)", interval: "音符间隔 s", tone: "键盘音色", brightness: "明亮度", variation: "变化量" };
const states: Record<SoundGenerationJob["state"], string> = { queued: "等待生成", rendering: "合成中", uploading: "上传素材中", succeeded: "已生成", failed: "生成失败", cancelled: "已取消", stale: "片段已改变,请重新生成" };

/** Kept outside selection so cancellation stays available while users navigate to another clip. */
export function SoundGenerationControls() {
  const jobs = useSyncExternalStore(subscribeSoundGeneration, soundGenerationJobs, soundGenerationJobs);
  const [error, setError] = useState("");
  return <div className="px-3 py-2 text-xs pc-left-divider-b" data-pc="sound-generation">
    <button type="button" className="pc-left-btn" data-pc="sound-notification" onClick={() => {
      try { setError(""); startSoundGeneration({ preset: "notification", start: getState().t }); }
      catch (e) { setError(String((e as Error).message)); }
    }}>添加提示音</button>
    {error && <div role="alert" className="mt-2">{error}</div>}
    {jobs.slice(-5).map(job => <div key={job.id} className="mt-2" data-pc="sound-job" data-state={job.state}>
      <div className="flex items-center gap-2">
        <span role="status">{states[job.state]} {Math.round(job.progress * 100)}%</span>
        {!soundJobFinished(job) && <button type="button" className="pc-left-btn is-sm" data-pc="sound-cancel" onClick={() => cancelSoundGeneration(job.id)}>取消</button>}
      </div>
      {!soundJobFinished(job) && <progress aria-label="音效生成进度" value={job.progress} max={1} className="w-full" />}
      {job.error && <div role={job.state === "failed" ? "alert" : "status"} className="pc-left-muted mt-1">{job.error}</div>}
    </div>)}
  </div>;
}

export function TypingSoundControls({ clip }: { clip: TrackClip }) {
  const [error, setError] = useState("");
  const generate = (preset: "keyboard" | "notification") => {
    try {
      setError("");
      const settled = createTypingSchedule(typingScheduleOptionsFromParams(clip.params)).settleMs / 1000;
      startSoundGeneration({ preset, sourceClipId: clip.id,
        ...(preset === "notification" ? { start: clip.start + Math.max(0, settled - (clip.mediaOffset ?? 0)) } : {}),
      });
    } catch (e) { setError(String((e as Error).message)); }
  };
  return <div className="px-3 py-3 text-xs pc-left-divider-b" data-pc="typing-sound-controls">
    <div className="pc-left-muted mb-2">使用相同打字节奏生成独立音效片段</div>
    <div className="flex gap-2 flex-wrap">
      <button type="button" className="pc-left-btn" data-pc="sound-keyboard" onClick={() => generate("keyboard")}>生成键盘声</button>
      <button type="button" className="pc-left-btn" data-pc="sound-typing-end" onClick={() => generate("notification")}>结尾加提示音</button>
    </div>
    {error && <div role="alert" className="mt-2">{error}</div>}
  </div>;
}

/** Draft edits never change the project or currently usable WAV; only the explicit regenerate button does. */
export function SoundEffectForm({ clip }: { clip: TrackClip }) {
  const original = clip.soundEffect!;
  const [draft, setDraft] = useState<SoundEffectRecipe>(() => structuredClone(original.recipe));
  const [error, setError] = useState("");
  const [refreshSource, setRefreshSource] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    // A previous job can finish while the user is already drafting another version.
    if (!dirty) setDraft(structuredClone(original.recipe));
    setError("");
  }, [clip.id, original.reuseKey]);
  const updateParam = (key: string, value: unknown) => {
    setDirty(true);
    setDraft(current => ({ ...current, params: { ...current.params, [key]: value } }) as SoundEffectRecipe);
  };
  return <div className="py-3 text-xs pc-left-divider-b" data-pc="sound-effect-form">
    <div className="font-semibold mb-2">合成音效 · {draft.preset === "keyboard" ? "键盘声" : "提示音"}</div>
    <div className="pc-left-muted mb-2">修改后点「重新生成」。成功入库后替换,失败或取消保留原声音。</div>
    {Object.entries(draft.params).map(([key, value]) => <label key={key} className="flex items-center gap-2 py-1">
      <span className="w-24 shrink-0 pc-left-muted">{labels[key] ?? key}</span>
      {key === "waveform" || key === "tone" ? <select className="pc-left-select flex-1" data-pc-sound-param={key} value={String(value)} onChange={e => updateParam(key, e.target.value)}>
        {(key === "waveform" ? ["sine", "triangle", "bell"] : ["soft", "mechanical"]).map(v => <option key={v} value={v}>{v}</option>)}
      </select> : Array.isArray(value) ? <input className="pc-left-input min-w-0 flex-1" data-pc-sound-param={key} value={value.join(", ")} onChange={e => updateParam(key, e.target.value.split(",").map(Number))} />
        : <input type="number" step="any" className="pc-left-input min-w-0 flex-1" data-pc-sound-param={key} value={Number(value)} onChange={e => updateParam(key, Number(e.target.value))} />}
    </label>)}
    <label className="flex items-center gap-2 py-1"><span className="w-24 shrink-0 pc-left-muted">固定种子</span>
      <input type="number" min={0} max={4294967295} step={1} data-pc-sound-param="seed" className="pc-left-input min-w-0 flex-1" value={draft.seed} onChange={e => { setDirty(true); setDraft({ ...draft, seed: Number(e.target.value) }); }} />
    </label>
    {original.sourceClipId && draft.preset === "keyboard" && <label className="flex items-center gap-2 py-2">
      <input type="checkbox" checked={refreshSource} onChange={e => setRefreshSource(e.target.checked)} />从当前打字卡更新文字与节奏
    </label>}
    <div className="flex gap-2 mt-2">
      <button type="button" className="pc-left-btn" data-pc="sound-regenerate" onClick={() => {
        try {
          setError("");
          startSoundGeneration({ clipId: clip.id, refreshSource, params: draft.params as unknown as Record<string, unknown>, seed: draft.seed });
          setDirty(false);
        } catch (e) { setError(String((e as Error).message)); }
      }}>重新生成</button>
      <button type="button" className="pc-left-btn" onClick={() => { setDraft(structuredClone(original.recipe)); setDirty(false); setError(""); }}>恢复原配方</button>
    </div>
    {error && <div role="alert" className="mt-2">{error}</div>}
    <details className="mt-2 pc-left-muted"><summary>原始配方与事件</summary><pre className="overflow-auto max-h-48 text-[10px]">{JSON.stringify(original.recipe, null, 2)}</pre></details>
  </div>;
}
